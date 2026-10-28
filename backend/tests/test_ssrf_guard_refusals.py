"""SSRF guard: every refusal class, IPv4 and IPv6, after redirects, and the allowlist.

Literal addresses need no DNS. Hostnames are resolved through a patched
socket.getaddrinfo, and HTTP is answered by a patched Session.send, so no test
touches the network.
"""

import socket

import pytest
import requests

from services import ssrf_guard
from services.ssrf_guard import parse_allowlist, safe_get, validate_host


def _resolves_to(monkeypatch, mapping):
    def fake_getaddrinfo(host, *_a, **_kw):
        if host not in mapping:
            raise socket.gaierror(f"no such host {host}")
        return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))
                for ip in mapping[host]]

    monkeypatch.setattr(ssrf_guard.socket, "getaddrinfo", fake_getaddrinfo)


@pytest.mark.parametrize(
    "ip",
    [
        # loopback
        "127.0.0.1", "127.8.9.10", "::1",
        # private
        "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.1", "fc00::1", "fd12:3456::1",
        # link-local
        "169.254.1.1", "fe80::1",
        # CGNAT
        "100.64.0.1", "100.127.255.254",
        # multicast
        "224.0.0.1", "239.255.255.250", "ff02::1",
        # reserved / unspecified / documentation
        "0.0.0.0", "240.0.0.1", "255.255.255.255", "192.0.2.1", "198.51.100.7", "203.0.113.9", "::",
        # IPv6 forms that reach a blocked IPv4 address
        "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "2002:a9fe:a9fe::1",
        # local-use NAT64
        "64:ff9b:1::a00:1",
    ],
)
def test_reserved_literal_addresses_are_refused(ip):
    got = validate_host(ip)
    assert got["ok"] is False, (ip, got)


@pytest.mark.parametrize(
    "ip",
    ["169.254.169.254", "169.254.170.2", "100.100.100.200", "192.0.0.192", "fd00:ec2::254",
     "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe"],
)
def test_cloud_metadata_is_refused_even_when_allowlisted(ip):
    allow = parse_allowlist("0.0.0.0/0, ::/0, metadata.example")
    got = validate_host(ip, allow=allow)
    assert got["ok"] is False and "metadata" in got["reason"], (ip, got)


@pytest.mark.parametrize("ip", ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "[2001:4860:4860::8888]"])
def test_public_literal_addresses_pass(ip):
    assert validate_host(ip)["ok"] is True


@pytest.mark.parametrize("name", ["localhost", "api.localhost", "host.docker.internal", "printer.local",
                                  "db.internal", "metadata.google.internal"])
def test_reserved_names_are_refused_without_dns(name, monkeypatch):
    _resolves_to(monkeypatch, {})
    got = validate_host(name)
    assert got["ok"] is False and "reserved name" in got["reason"]


def test_hostname_resolving_to_any_private_address_is_refused(monkeypatch):
    # One public and one private answer: a round-robin record must not slip through.
    _resolves_to(monkeypatch, {"mixed.example": ["93.184.216.34", "10.0.0.7"],
                               "v6.example": ["2606:2800:220:1::", "fe80::abcd"],
                               "imds.example": ["169.254.169.254"]})
    assert validate_host("mixed.example")["ok"] is False
    assert validate_host("v6.example")["ok"] is False
    imds = validate_host("imds.example")
    assert imds["ok"] is False and "metadata" in imds["reason"]


def test_allowlisted_lan_host_passes_and_others_still_refused(monkeypatch):
    _resolves_to(monkeypatch, {"feeds.lan": ["192.168.10.5"], "other.lan": ["192.168.10.6"]})
    allow = parse_allowlist(" feeds.lan , 10.9.0.0/16 ")
    assert validate_host("feeds.lan", allow=allow)["ok"] is True
    assert validate_host("10.9.1.2", allow=allow)["ok"] is True
    assert validate_host("other.lan", allow=allow)["ok"] is False
    assert validate_host("10.8.1.2", allow=allow)["ok"] is False


def test_empty_allowlist_parses_to_none():
    assert parse_allowlist("") is None
    assert parse_allowlist(" , ") is None


class _FakeResponse:
    def __init__(self, status, location=None):
        self.status_code = status
        self.headers = {"location": location} if location else {}
        self.closed = False

    def close(self):
        self.closed = True


def _serve(monkeypatch, routes):
    """Answer Session.send from a {url: response} table; record the URLs requested."""
    seen = []

    def fake_send(self, prepared, **_kw):
        seen.append(prepared.url)
        return routes[prepared.url]

    monkeypatch.setattr(requests.Session, "send", fake_send)
    return seen


@pytest.mark.parametrize("url", ["ftp://example.com/feed.json", "file:///etc/passwd",
                                 "gopher://example.com/", "dict://127.0.0.1:11211/"])
def test_non_http_schemes_are_refused(url, monkeypatch):
    seen = _serve(monkeypatch, {})
    with pytest.raises(ValueError, match="blocked protocol"):
        safe_get(url)
    assert seen == []


def test_redirect_to_private_address_is_refused_before_connecting(monkeypatch):
    _resolves_to(monkeypatch, {"feeds.example": ["93.184.216.34"]})
    seen = _serve(monkeypatch, {
        "https://feeds.example/f.geojson": _FakeResponse(302, "http://169.254.169.254/latest/meta-data/"),
    })
    with pytest.raises(ValueError, match="blocked target"):
        safe_get("https://feeds.example/f.geojson")
    assert seen == ["https://feeds.example/f.geojson"]


def test_redirect_to_public_address_is_followed(monkeypatch):
    _resolves_to(monkeypatch, {"a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"]})
    final = _FakeResponse(200)
    seen = _serve(monkeypatch, {
        "https://a.example/x": _FakeResponse(301, "https://b.example/y"),
        "https://b.example/y": final,
    })
    assert safe_get("https://a.example/x") is final
    assert seen == ["https://a.example/x", "https://b.example/y"]


def test_redirect_loop_is_bounded(monkeypatch):
    _resolves_to(monkeypatch, {"loop.example": ["93.184.216.34"]})
    _serve(monkeypatch, {"https://loop.example/": _FakeResponse(302, "https://loop.example/")})
    with pytest.raises(ValueError, match="too many redirects"):
        safe_get("https://loop.example/", max_redirects=2)
