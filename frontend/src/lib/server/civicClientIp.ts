/**
 * Which visitor a civic-proxy request is for, so the upstream's anonymous
 * quota is charged per visitor instead of to this server as one bucket.
 */

/** Cloudflare Ray ID: 16 hex chars, optionally "-" + a 3-letter colo code. */
const CF_RAY_RE = /^[0-9a-f]{16}(-[A-Z]{3})?$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:.]{2,45}$/i;

/**
 * The visitor's address, ONLY when the request demonstrably came through
 * Cloudflare: `CF-Connecting-IP` is set by Cloudflare's edge and arrives with a
 * well-formed `CF-Ray`. Without both it is null. `X-Forwarded-For` (and any
 * other client-settable header) is never trusted or forwarded.
 */
export function cloudflareClientIp(headers: Headers): string | null {
  const ray = (headers.get('cf-ray') || '').trim();
  const ip = (headers.get('cf-connecting-ip') || '').trim();
  if (!ray || !ip || !CF_RAY_RE.test(ray)) return null;
  if (IPV4_RE.test(ip)) return ip;
  if (ip.includes(':') && IPV6_RE.test(ip)) return ip.toLowerCase();
  return null;
}
