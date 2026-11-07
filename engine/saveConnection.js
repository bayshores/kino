const PENDING_STATES = new Set(["dirty", "saving", "editing", "pending"]);
const READ_ONLY_STATES = new Set(["read-only", "readonly", "readOnly"]);
const RETRYABLE_KINDS = new Set(["network", "timeout"]);
const NONRETRYABLE_KINDS = new Set(["access", "permission", "forbidden", "revoked", "unauthorized", "validation", "invalid", "user-abort", "abort", "nonretryable"]);
const NONRETRYABLE_STATUSES = new Set([400, 403, 409, 413]);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

function normalizedKind(value) {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (value && typeof value === "object") {
    const kind = value.kind ?? value.errorKind;
    return typeof kind === "string" ? kind.trim().toLowerCase() : "";
  }
  return "";
}

function normalizedStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function errorStatus(value) {
  if (typeof value === "number" || typeof value === "string") return normalizedStatus(value);
  if (value && typeof value === "object") return normalizedStatus(value.status ?? value.statusCode);
  return null;
}

function makeIndicator(state, label, description) {
  return { state, label, description };
}

export function connectionIndicator({ saveState, socketState, errorKind = null, online = true } = {}) {
  const kind = normalizedKind(errorKind);
  const status = errorStatus(errorKind);
  if (saveState === "conflict" || kind === "conflict" || kind === "revision-conflict" || status === 409)
    return makeIndicator("conflict", "Conflict", "This file changed elsewhere. Choose which version to keep before continuing.");

  const retryable = RETRYABLE_KINDS.has(kind) || (status !== null && RETRYABLE_STATUSES.has(status));
  if ((kind && NONRETRYABLE_KINDS.has(kind)) || (status !== null && NONRETRYABLE_STATUSES.has(status)) ||
      (errorKind !== null && errorKind !== undefined && !retryable) || (saveState === "error" && !retryable))
    return makeIndicator("error", "Error", "Your changes could not be saved. Resolve the problem before retrying.");

  if (online === false || retryable)
    return makeIndicator("offline", "Offline", READ_ONLY_STATES.has(saveState)
      ? "The service is unavailable. This file stays visible and will refresh when the connection returns."
      : "Any pending changes stay on this device and will retry when the connection returns.");

  if (PENDING_STATES.has(saveState) || saveState === "loading")
    return makeIndicator("syncing", "Syncing", saveState === "loading"
      ? "Loading the latest saved version."
      : "Saving your changes to this file.");

  if (socketState === "connected")
    return makeIndicator("synced", "Synced", READ_ONLY_STATES.has(saveState)
      ? "This read-only file is up to date."
      : "All changes are saved and up to date.");
  return makeIndicator("reconnecting", "Reconnecting", READ_ONLY_STATES.has(saveState)
    ? "This read-only file is waiting for the collaboration server to reconnect."
    : "Trying to reconnect to the collaboration server.");
}

/** Whether a failed request is safe to retry automatically. */
export function isRetryable(error) {
  if (!error || typeof error !== "object") return false;
  const kind = normalizedKind(error);
  if (error.name === "AbortError" || error.name === "CanceledError" || error.userAborted === true ||
      ["ABORT_ERR", "ERR_CANCELED"].includes(error.code) || NONRETRYABLE_KINDS.has(kind)) return false;
  const status = normalizedStatus(error.status ?? error.statusCode);
  if (status !== null && NONRETRYABLE_STATUSES.has(status)) return false;
  if (status !== null && RETRYABLE_STATUSES.has(status)) return true;
  return RETRYABLE_KINDS.has(kind);
}

/** Exponential backoff starting at one second, with bounded ±20% jitter and a 30 second cap. */
export function retryDelay(attempt, random = Math.random) {
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.min(1024, Math.floor(attempt)) : 0;
  let sample = 0.5;
  try {
    const value = random();
    if (Number.isFinite(value)) sample = Math.max(0, Math.min(1, value));
  } catch { /* Use the midpoint when the injected source is unavailable. */ }
  const exponential = 1000 * (2 ** index);
  return Math.max(0, Math.min(30_000, Math.round(exponential * (0.8 + sample * 0.4))));
}

function sameValue(left, right, activeLeft = new WeakSet(), activeRight = new WeakSet()) {
  const leftObject = left !== null && typeof left === "object";
  const rightObject = right !== null && typeof right === "object";
  if (!leftObject || !rightObject) return Object.is(left, right);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  // Reject cycles, but compare repeated non-cyclic references by value. JSON
  // round-tripping duplicates shared references, so alias topology is irrelevant.
  if (activeLeft.has(left) || activeRight.has(right)) return false;

  activeLeft.add(left);
  activeRight.add(right);
  try {
    if (Array.isArray(left)) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        // JSON serializes array holes and undefined entries as null.
        const leftValue = Object.hasOwn(left, index) ? left[index] : null;
        const rightValue = Object.hasOwn(right, index) ? right[index] : null;
        if (!sameValue(leftValue === undefined ? null : leftValue, rightValue === undefined ? null : rightValue, activeLeft, activeRight))
          return false;
      }
      return true;
    }
    // JSON omits undefined-valued object properties.
    const leftKeys = Object.keys(left).filter(key => left[key] !== undefined).sort();
    const rightKeys = Object.keys(right).filter(key => right[key] !== undefined).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
      key === rightKeys[index] && sameValue(left[key], right[key], activeLeft, activeRight));
  } finally {
    activeLeft.delete(left);
    activeRight.delete(right);
  }
}

/** Compare validated document JSON independent of object property order, preserving array order. */
export function sameDocument(left, right) {
  try { return sameValue(left, right); }
  catch { return false; }
}
