// Files kino reads from the web (songs, sound effects, licensed footage): only over https, only
// from the hosts a source names, and every redirect is checked before it is followed, so an
// answer can never send kino to another host. Requests carry kino's own name, no personal details.

export const KINO_USER_AGENT = "kino (https://github.com/bayshores/kino)";

/** The URL when it is https on one of `hosts` (or a subdomain of one), else null. */
export function hostAllowed(url, hosts) {
  let file;
  try { file = new URL(url); } catch { return null; }
  if (file.protocol !== "https:") return null;
  return hosts.some((host) => file.hostname === host || file.hostname.endsWith(`.${host}`)) ? file : null;
}

/**
 * fetch(url) that follows at most `hops` redirects by hand, checking each address with
 * hostAllowed before asking it. refuse(hostname) makes the error thrown for a host not allowed.
 * Answers {response, url}: the last answer and the address it came from.
 */
export async function fetchChecked(url, { fetch = globalThis.fetch, hosts, refuse, method = "GET", signal, hops = 5 }) {
  let address = hostAllowed(url, hosts);
  for (let hop = 0; ; hop += 1) {
    if (!address) throw refuse(safeHost(url));
    const response = await fetch(address.href, { method, headers: { "user-agent": KINO_USER_AGENT }, redirect: "manual", signal });
    const location = response.status >= 300 && response.status < 400 ? response.headers?.get?.("location") : null;
    if (!location) return { response, url: address.href };
    if (hop >= hops) throw refuse(`${address.hostname} (too many redirects)`);
    url = new URL(location, address).href;
    address = hostAllowed(url, hosts);
  }
}

function safeHost(url) {
  try { return new URL(url).hostname || String(url); } catch { return String(url).slice(0, 80); }
}
