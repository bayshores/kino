import { isEditorUrl } from "./navigation.mjs";

const DEFAULT_RESTART_LIMIT = 3;
const DEFAULT_RESTART_WINDOW_MS = 120_000;

/** A sliding-window restart budget with a monotonic high-water clock. */
export function createRestartPolicy({ now = Date.now, limit = DEFAULT_RESTART_LIMIT, windowMs = DEFAULT_RESTART_WINDOW_MS } = {}) {
  if (typeof now !== "function") throw new TypeError("Restart policy clock must be a function.");
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Restart limit must be a non-negative integer.");
  if (!Number.isFinite(windowMs) || windowMs < 0) throw new RangeError("Restart window must be a non-negative number of milliseconds.");
  const claims = [];
  let highWater = -Infinity;

  function currentTime() {
    let observed;
    try { observed = now(); } catch { observed = NaN; }
    if (!Number.isFinite(observed)) return Number.isFinite(highWater) ? highWater : 0;
    highWater = Math.max(highWater, observed);
    return highWater;
  }

  function prune(timestamp) {
    const cutoff = timestamp - windowMs;
    let firstLive = 0;
    while (firstLive < claims.length && claims[firstLive] <= cutoff) firstLive += 1;
    if (firstLive) claims.splice(0, firstLive);
  }

  function remaining() {
    prune(currentTime());
    return Math.max(0, limit - claims.length);
  }

  // View > Restart local service while the service runs only stops it, and the restart starts
  // when it exits (main.mjs). personAsked() marks that coming restart as one the person asked for:
  // the next claim then goes ahead as if it were claim({ manual: true }).
  let askedByPerson = false;
  function personAsked() {
    askedByPerson = true;
  }

  // A restart the person asked for (View > Restart local service, or the button in the dialog
  // after the service stopped) always goes ahead and counts; the limit stops automatic ones only.
  function claim({ manual = false } = {}) {
    const asked = manual || askedByPerson;
    askedByPerson = false;
    const timestamp = currentTime();
    prune(timestamp);
    if (!asked && claims.length >= limit) return false;
    claims.push(timestamp);
    return true;
  }

  return { claim, personAsked, remaining };
}

/** Keep the last ready port unless startup explicitly reported EADDRINUSE. */
export function restartPort(previousPort, addressInUse = false) {
  if (addressInUse === true) return 0;
  return Number.isInteger(previousPort) && previousPort >= 1 && previousPort <= 65_535 ? previousPort : 0;
}

/**
 * The owner cookie's value from the local service's answer to POST /api/session. A new service
 * process (at start and after each restart) gives a new one. Throws, with the words the start-up
 * error box shows, when the service refused or gave no cookie.
 */
export function ownerSessionCookie(response) {
  if (!response?.ok) throw new Error("The local kino service could not start a session.");
  const cookie = response.headers.get("set-cookie")?.match(/kino_owner=([a-f0-9-]{36})/);
  if (!cookie) throw new Error("The local kino service did not return a session.");
  return cookie[1];
}

function hasUserInfo(value) {
  return typeof value === "string" && /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(value);
}

function localHttpOrigin(value) {
  if (typeof value !== "string" || hasUserInfo(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

/** Relocate only a trusted editor URL between ready loopback service origins. */
export function relocatedEditorUrl(currentUrl, previousOrigin, nextOrigin) {
  const previous = localHttpOrigin(previousOrigin);
  const next = localHttpOrigin(nextOrigin);
  if (!previous || !next || typeof currentUrl !== "string" || hasUserInfo(currentUrl)) return null;
  let current;
  try { current = new URL(currentUrl); } catch { return null; }
  if (current.protocol !== "http:" || current.hostname !== "127.0.0.1" || current.username || current.password ||
      !isEditorUrl(current.href, previous)) return null;
  try { return new URL(`${current.pathname}${current.search}${current.hash}`, next).href; }
  catch { return null; }
}
