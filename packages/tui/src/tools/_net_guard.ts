/**
 * SSRF guard for the raw web-fetch path (`_ddg.ts`): validate a model-supplied URL before
 * any connection is opened. Non-http(s) schemes are always rejected; unless
 * MINIMA_TUI_FETCH_LOCAL=1, so are loopback, RFC-1918 private, link-local (including the
 * 169.254.169.254 cloud-metadata IP), IPv6 unique-local and unspecified targets — checked
 * for literal IPs and for EVERY address a hostname resolves to. Callers re-run the guard
 * on each redirect hop so a public host cannot bounce the fetch into a private range.
 */

import { lookup } from "node:dns/promises";

/** Policy rejection: the URL must not be fetched. The message is safe to surface as-is. */
export class NetGuardError extends Error {}

/** Injectable resolver for hermetic tests; the default resolves all A/AAAA records. */
export type HostResolver = (hostname: string) => Promise<string[]>;

function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets.every((o) => o <= 255) ? octets : null;
}

/** Expand an IPv6 literal (optionally zoned, `::`-compressed, or with an embedded IPv4
 * tail) into its 8 hextets, or null when `raw` is not an IPv6 address. */
function parseIpv6(raw: string): number[] | null {
  let s = raw;
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): string[] => (part ? part.split(":") : []);
  const parseGroups = (gs: string[], v4Allowed: boolean): number[] | null => {
    const out: number[] = [];
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i]!;
      if (g.includes(".")) {
        if (!(v4Allowed && i === gs.length - 1)) return null;
        const v4 = parseIpv4(g);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        out.push(Number.parseInt(g, 16));
      }
    }
    return out;
  };
  const head = parseGroups(groups(halves[0]!), halves.length === 1);
  const tail = halves.length === 2 ? parseGroups(groups(halves[1]!), true) : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...(Array(fill).fill(0) as number[]), ...tail];
  }
  return head.length === 8 ? head : null;
}

function blockedV4(o: number[]): string | null {
  const [a, b] = o as [number, number];
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 169 && b === 254) return "link-local";
  return null;
}

function blockedV6(h: number[]): string | null {
  const zeroTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeroTo(8)) return "unspecified";
  if (zeroTo(7) && h[7] === 1) return "loopback";
  if (zeroTo(5) && (h[5] === 0xffff || h[5] === 0)) {
    return blockedV4([h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff]);
  }
  if ((h[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((h[0]! & 0xfe00) === 0xfc00) return "private";
  return null;
}

/** Why `addr` is blocked (`loopback` | `private` | `link-local` | `unspecified`), or null
 * for public addresses and strings that are not IP literals. */
export function blockedIpReason(addr: string): string | null {
  const v4 = parseIpv4(addr);
  if (v4) return blockedV4(v4);
  const v6 = parseIpv6(addr);
  if (v6) return blockedV6(v6);
  return null;
}

/** Resolve a hostname to every address it maps to. `localhost` names are loopback by
 * definition (RFC 6761) and reserved documentation/test TLDs never resolve — both are
 * answered locally so no query leaves the machine. Resolution failure returns [] and the
 * guard passes: the fetch itself will fail identically, keeping error semantics intact. */
const defaultResolver: HostResolver = async (hostname) => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return ["127.0.0.1", "::1"];
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (tld === "example" || tld === "test" || tld === "invalid") return [];
  try {
    return (await lookup(host, { all: true })).map((entry) => entry.address);
  } catch {
    return [];
  }
};

/** Throw NetGuardError unless `rawUrl` is an http(s) URL whose target addresses are all
 * public. `allowLocal` (default: MINIMA_TUI_FETCH_LOCAL=1) lifts only the address policy,
 * never the scheme policy. */
export async function assertPublicUrl(
  rawUrl: string,
  allowLocal: boolean = process.env.MINIMA_TUI_FETCH_LOCAL === "1",
  resolve: HostResolver = defaultResolver,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetGuardError(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetGuardError(
      `blocked scheme "${url.protocol.slice(0, -1)}" — only http(s) URLs may be fetched`,
    );
  }
  if (allowLocal) return;
  const rawHost = url.hostname;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const isLiteral = parseIpv4(host) !== null || parseIpv6(host) !== null;
  const addresses = isLiteral ? [host] : await resolve(host);
  for (const addr of addresses) {
    const reason = blockedIpReason(addr);
    if (reason) {
      const target = addr === host ? host : `${host} (${addr})`;
      throw new NetGuardError(
        `blocked ${reason} target ${target} — private/local addresses are denied by default; set MINIMA_TUI_FETCH_LOCAL=1 to allow local fetches`,
      );
    }
  }
}
