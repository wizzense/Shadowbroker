"""SSRF guard for server-side fetches of operator- or agent-supplied URLs.

Ported from Osiris ssrf-guard.ts. Used by the OSINT lookups and by the feed-layer
ingester. Every hop (the URL and each redirect target) must be http(s) and must
resolve only to public addresses: loopback, private, link-local, CGNAT, multicast,
reserved, unspecified and cloud-metadata targets are refused, for IPv4 and for IPv6
(including IPv6 forms that tunnel to an IPv4 address).

An optional allowlist exempts named hosts or networks from the private-address
block, for operators who serve a feed from their own LAN. Cloud-metadata
addresses are refused even then.

Known limit: the host is resolved for the check and again by the HTTP client, so a
DNS answer that changes between the two (rebinding) is not caught here.
"""
from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import requests
from urllib3.util import parse_url

_IPV4_BLOCKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("192.88.99.0/24"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("240.0.0.0/4"),
]

# IPv6 ranges not covered by ipaddress' is_private/is_reserved on every Python
# this backend supports.
_IPV6_BLOCKS = [
    ipaddress.ip_network("64:ff9b:1::/48"),  # local-use NAT64 (RFC 8215)
]

# NAT64 well-known prefix: the low 32 bits are an IPv4 address (RFC 6052).
_NAT64_WKP = ipaddress.ip_network("64:ff9b::/96")

# Instance-metadata endpoints. Refused even for an allowlisted host or network.
_METADATA_IPS = frozenset(
    ipaddress.ip_address(a)
    for a in (
        "169.254.169.254",  # AWS, GCP, Azure, OpenStack, DigitalOcean
        "169.254.170.2",  # AWS ECS task metadata
        "100.100.100.200",  # Alibaba Cloud
        "192.0.0.192",  # Oracle Cloud
        "fd00:ec2::254",  # AWS IMDS over IPv6
    )
)

_NAME_BLOCKLIST = (
    re.compile(r"^localhost$", re.I),
    re.compile(r"\.localhost$", re.I),
    re.compile(r"^host\.docker\.internal$", re.I),
    re.compile(r"\.local$", re.I),
    re.compile(r"\.internal$", re.I),
    re.compile(r"^metadata\.google\.internal$", re.I),
)

_HOSTNAME_RE = re.compile(
    r"^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$"
)

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


@dataclass(frozen=True)
class Allowlist:
    """Hosts and networks exempt from the private-address block (never from metadata)."""

    hosts: frozenset[str] = frozenset()
    networks: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = ()

    def covers(self, host: str, addr: IPAddress | None = None) -> bool:
        if host.lower().rstrip(".") in self.hosts:
            return True
        return addr is not None and any(addr in net for net in self.networks)


def parse_allowlist(raw: str | None) -> Allowlist | None:
    """Parse "feeds.lan, 10.0.0.5, 192.168.10.0/24" into an Allowlist (None when empty)."""
    hosts: set[str] = set()
    nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for item in (raw or "").split(","):
        entry = item.strip().strip("[]")
        if not entry:
            continue
        try:
            nets.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            hosts.add(entry.lower().rstrip("."))
    if not hosts and not nets:
        return None
    return Allowlist(frozenset(hosts), tuple(nets))


def _as_ip(ip: str | IPAddress) -> IPAddress | None:
    if isinstance(ip, (ipaddress.IPv4Address, ipaddress.IPv6Address)):
        return ip
    try:
        return ipaddress.ip_address(str(ip).split("%", 1)[0])
    except ValueError:
        return None


def _embedded_ipv4(addr: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """The IPv4 address an IPv6 address reaches (mapped, 6to4, Teredo, NAT64), if any."""
    if addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    if addr.sixtofour is not None:
        return addr.sixtofour
    if addr.teredo is not None:
        return addr.teredo[1]
    if addr in _NAT64_WKP:
        return ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)
    return None


def _ipv4_blocked(ip: str | IPAddress) -> bool:
    addr = _as_ip(ip)
    if addr is None:
        return True
    if not isinstance(addr, ipaddress.IPv4Address):
        return False
    return any(addr in net for net in _IPV4_BLOCKS)


def _is_metadata(ip: str | IPAddress) -> bool:
    addr = _as_ip(ip)
    if addr is None:
        return False
    if addr in _METADATA_IPS:
        return True
    return isinstance(addr, ipaddress.IPv6Address) and _embedded_ipv4(addr) in _METADATA_IPS


def _ip_blocked(ip: str | IPAddress) -> bool:
    addr = _as_ip(ip)
    if addr is None:
        return True
    if isinstance(addr, ipaddress.IPv4Address):
        return _ipv4_blocked(addr)
    if any(addr in net for net in _IPV6_BLOCKS):
        return True
    inner = _embedded_ipv4(addr)
    if inner is not None and _ipv4_blocked(inner):
        return True
    return (
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_site_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    )


def _refusal(addr: IPAddress, host: str, allow: Allowlist | None) -> str | None:
    """Why *addr* (reached via *host*) may not be fetched, or None if it may."""
    if _is_metadata(addr):
        return f"cloud metadata address {addr}"
    if _ip_blocked(addr) and not (allow and allow.covers(host, addr)):
        return f"reserved IP {addr}"
    return None


def validate_host(host: str, *, allow: Allowlist | None = None) -> dict[str, Any]:
    trimmed = (host or "").strip()
    if not trimmed:
        return {"ok": False, "reason": "empty host"}
    bracketed = trimmed.strip("[]")
    lower = trimmed.lower()
    allowed_name = bool(allow and allow.covers(trimmed))
    if not allowed_name and any(p.search(lower) for p in _NAME_BLOCKLIST):
        return {"ok": False, "reason": "hostname matches reserved name pattern"}

    literal = _as_ip(bracketed)
    if literal is not None:
        why = _refusal(literal, trimmed, allow)
        if why:
            return {"ok": False, "reason": f"IP in reserved range ({why})"}
        return {"ok": True, "resolved": [str(literal)]}

    if not allowed_name and not _HOSTNAME_RE.match(trimmed):
        return {"ok": False, "reason": "invalid hostname syntax"}

    try:
        infos = socket.getaddrinfo(trimmed, None, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        return {"ok": False, "reason": f"DNS lookup failed: {exc}"}
    if not infos:
        return {"ok": False, "reason": "hostname has no A/AAAA records"}

    resolved: list[str] = []
    for info in infos:
        addr = _as_ip(info[4][0])
        if addr is None:
            return {"ok": False, "reason": f"unparseable address {info[4][0]}"}
        why = _refusal(addr, trimmed, allow)
        if why:
            return {"ok": False, "reason": f"hostname resolves to {why}"}
        resolved.append(str(addr))
    return {"ok": True, "resolved": resolved}


def safe_get(
    url: str,
    *,
    timeout: float = 8.0,
    headers: dict[str, str] | None = None,
    max_redirects: int = 3,
    allow: Allowlist | None = None,
    stream: bool = False,
) -> requests.Response:
    """GET *url*, refusing any hop whose scheme or resolved address is not public.

    The host is read from the URL exactly as the HTTP client will send it (the
    prepared request), so parser differences cannot point the check at one host
    and the connection at another.
    """
    current = url
    with requests.Session() as session:
        for _ in range(max_redirects + 1):
            prepared = session.prepare_request(requests.Request("GET", current, headers=headers or {}))
            target = parse_url(prepared.url)
            if (target.scheme or "").lower() not in ("http", "https"):
                raise ValueError(f"blocked protocol {target.scheme}")
            check = validate_host(target.host or "", allow=allow)
            if not check.get("ok"):
                raise ValueError(f"blocked target — {check.get('reason')}")
            settings = session.merge_environment_settings(prepared.url, {}, stream, None, None)
            res = session.send(prepared, timeout=timeout, allow_redirects=False, **settings)
            if 300 <= res.status_code < 400:
                loc = res.headers.get("location")
                if not loc:
                    return res
                res.close()
                current = urljoin(prepared.url, loc)
                continue
            return res
    raise ValueError("too many redirects")


def validate_domain(domain: str) -> bool:
    return bool(re.match(r"^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", domain or ""))
