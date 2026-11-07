function annotatedError(error, { name, kind, message } = {}) {
  const original = error instanceof Error ? error : new Error(message ?? String(error ?? "Request failed."));
  try {
    if (name) original.name = name;
    if (kind) original.kind = kind;
    if ((!name || original.name === name) && (!kind || original.kind === kind)) return original;
  } catch { /* Frozen errors are wrapped below. */ }
  const wrapped = new Error(message ?? original.message, { cause: original });
  if (name) wrapped.name = name;
  if (kind) wrapped.kind = kind;
  return wrapped;
}

function abortedError(signal) {
  const reason = signal?.reason;
  return annotatedError(reason instanceof Error ? reason : new Error(
    typeof reason === "string" && reason ? reason : "The request was aborted.",
    reason === undefined ? undefined : { cause: reason },
  ), { name: "AbortError", kind: "aborted" });
}

function timeoutError() {
  return annotatedError(new Error("The request timed out. Please try again."), {
    name: "TimeoutError", kind: "timeout",
  });
}

function networkError(cause, status) {
  const error = new Error(status === undefined
    ? "The request could not reach the service. Check your connection and try again."
    : "The service response could not be read. The request may have succeeded; check its status before retrying.",
  { cause });
  error.name = "NetworkError";
  error.kind = "network";
  if (status !== undefined) error.status = status;
  return error;
}

function httpError(response, data, cause) {
  const status = response.status;
  const message = typeof data?.error === "string" && data.error.trim()
    ? data.error
    : `The request failed with status ${status}.`;
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "HttpError";
  error.kind = "http";
  error.status = status;
  error.current = data && typeof data === "object" ? data.current : undefined;
  return error;
}

/** Fetch one JSON response with a single deadline covering headers and body parsing. */
export async function requestJson(url, { timeoutMs = 15_000, signal: callerSignal, ...fetchOptions } = {}, {
  fetch: fetchImpl = globalThis.fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  if (callerSignal?.aborted) throw abortedError(callerSignal);

  const controller = new AbortController();
  let timeoutId = null, callerListener = null, cancelKind = null, cancelError = null, rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  cancellation.catch(() => {});
  const cancel = (kind, error) => {
    if (cancelKind) return;
    cancelKind = kind;
    cancelError = error;
    controller.abort(error);
    rejectCancellation(error);
  };
  const wait = (value) => Promise.race([Promise.resolve(value), cancellation]);

  try {
    if (callerSignal) {
      callerListener = () => cancel("aborted", abortedError(callerSignal));
      callerSignal.addEventListener("abort", callerListener, { once: true });
      if (callerSignal.aborted) callerListener();
    }
    const duration = Number(timeoutMs);
    if (!cancelKind && Number.isFinite(duration) && duration > 0) {
      timeoutId = setTimer(() => cancel("timeout", timeoutError()), duration);
    }
    if (cancelKind) throw cancelError;

    const response = await wait(fetchImpl(url, { ...fetchOptions, signal: controller.signal }));
    if (cancelKind) throw cancelError;

    let data, bodyError, bodyFailed = false;
    try { data = await wait(response.json()); }
    catch (error) {
      if (cancelKind) throw cancelError;
      bodyFailed = true;
      bodyError = error;
    }
    if (cancelKind) throw cancelError;
    if (!response.ok) throw httpError(response, data, bodyError);
    if (bodyFailed) throw networkError(bodyError, response.status);
    return data;
  } catch (error) {
    if (cancelKind) throw cancelError;
    if (error?.name === "AbortError" && callerSignal?.aborted) throw abortedError(callerSignal);
    if (error?.kind === "http" || error?.kind === "network") throw error;
    throw networkError(error);
  } finally {
    if (timeoutId !== null) clearTimer(timeoutId);
    if (callerListener) callerSignal.removeEventListener("abort", callerListener);
  }
}
