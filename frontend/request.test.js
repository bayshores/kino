import assert from "node:assert/strict";
import test from "node:test";
import { requestJson } from "./request.js";

function fakeClock() {
  let now = 0, nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { id, at: now + delay, callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.values()].filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.callback();
      }
      now = target;
    },
    pendingCount: () => timers.size,
  };
}

function trackedSignal({ aborted = false, reason } = {}) {
  const listeners = new Set();
  return {
    aborted,
    reason,
    addEventListener(type, listener) { if (type === "abort") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "abort") listeners.delete(listener); },
    abort(nextReason = new DOMException("The operation was aborted.", "AbortError")) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = nextReason;
      for (const listener of [...listeners]) listener({ type: "abort" });
    },
    listenerCount: () => listeners.size,
  };
}

function response(data, status = 200, { json = async () => data } = {}) {
  return { ok: status >= 200 && status < 300, status, json };
}

function deps(clock, fetch) {
  return { fetch, setTimer: clock.setTimer.bind(clock), clearTimer: clock.clearTimer.bind(clock) };
}

async function errorFrom(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail("Expected the request to reject.");
}

test("successful JSON forwards fetch options and cleans up its deadline and abort listener", async () => {
  const clock = fakeClock(), caller = trackedSignal();
  let fetchOptions;
  const fetch = async (url, options) => {
    assert.equal(url, "/api/example");
    fetchOptions = options;
    assert.equal(caller.listenerCount(), 1, "caller abort forwarding is active during the request");
    return response({ saved: true });
  };

  const data = await requestJson("/api/example", {
    method: "POST", body: JSON.stringify({ value: 1 }), headers: { "Content-Type": "application/json" },
    signal: caller, timeoutMs: 200,
  }, deps(clock, fetch));

  assert.deepEqual(data, { saved: true });
  assert.equal(fetchOptions.method, "POST");
  assert.equal(fetchOptions.body, JSON.stringify({ value: 1 }));
  assert.notStrictEqual(fetchOptions.signal, caller, "fetch receives the composed AbortController signal");
  assert.equal(Object.hasOwn(fetchOptions, "timeoutMs"), false);
  assert.equal(caller.listenerCount(), 0);
  assert.equal(clock.pendingCount(), 0);
});

test("timeout covers a pending fetch and produces a typed timeout error", async () => {
  const clock = fakeClock();
  let requestSignal;
  const fetch = (_url, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  };
  const pending = requestJson("/slow", { timeoutMs: 40 }, deps(clock, fetch));

  clock.advance(39);
  assert.equal(requestSignal.aborted, false);
  clock.advance(1);
  const error = await errorFrom(pending);

  assert.equal(error.name, "TimeoutError");
  assert.equal(error.kind, "timeout");
  assert.match(error.message, /timed out/i);
  assert.equal(requestSignal.aborted, true);
  assert.equal(clock.pendingCount(), 0);
});

test("the same timeout covers JSON body reading after headers arrive", async () => {
  const clock = fakeClock();
  let jsonStarted = false, requestSignal;
  const fetch = (_url, options) => {
    requestSignal = options.signal;
    return Promise.resolve(response(undefined, 200, { json: () => {
      jsonStarted = true;
      return new Promise(() => {});
    } }));
  };
  const pending = requestJson("/slow-body", { timeoutMs: 25 }, deps(clock, fetch));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(jsonStarted, true);

  clock.advance(25);
  const error = await errorFrom(pending);
  assert.equal(error.name, "TimeoutError");
  assert.equal(error.kind, "timeout");
  assert.equal(requestSignal.aborted, true);
  assert.equal(clock.pendingCount(), 0);
});

test("an already-aborted caller signal rejects before fetch or timer setup", async () => {
  const clock = fakeClock();
  const reason = new DOMException("Cancelled before send.", "AbortError");
  const caller = trackedSignal({ aborted: true, reason });
  let fetchCount = 0;
  const error = await errorFrom(requestJson("/cancelled", { signal: caller }, deps(clock, async () => {
    fetchCount += 1;
    return response({});
  })));

  assert.equal(error.name, "AbortError");
  assert.equal(error.kind, "aborted");
  assert.equal(error.message, reason.message);
  assert.equal(fetchCount, 0);
  assert.equal(caller.listenerCount(), 0);
  assert.equal(clock.pendingCount(), 0);
});

test("caller abort during fetch forwards cancellation and preserves AbortError classification", async () => {
  const clock = fakeClock(), caller = trackedSignal();
  let requestSignal;
  const fetch = (_url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };
  const pending = requestJson("/cancel-during-fetch", { signal: caller, timeoutMs: 500 }, deps(clock, fetch));
  assert.equal(caller.listenerCount(), 1);
  const reason = new DOMException("Cancelled by caller.", "AbortError");
  caller.abort(reason);
  const error = await errorFrom(pending);

  assert.equal(error.name, "AbortError");
  assert.equal(error.kind, "aborted");
  assert.equal(error.message, reason.message);
  assert.equal(requestSignal.aborted, true);
  assert.equal(caller.listenerCount(), 0);
  assert.equal(clock.pendingCount(), 0);
});

test("HTTP errors preserve status, current state, and server messages for common failures", async () => {
  const current = { revision: 12 };
  for (const status of [400, 403, 409, 413, 502, 503, 504]) {
    const clock = fakeClock(), caller = trackedSignal();
    const error = await errorFrom(requestJson("/failure", { signal: caller }, deps(clock, async () =>
      response({ error: `Failure ${status}`, current }, status))));
    assert.equal(error.name, "HttpError");
    assert.equal(error.kind, "http");
    assert.equal(error.status, status);
    assert.deepEqual(error.current, current);
    assert.equal(error.message, `Failure ${status}`);
    assert.equal(caller.listenerCount(), 0);
    assert.equal(clock.pendingCount(), 0);
  }
});

test("malformed non-OK bodies keep the HTTP status and fallback message", async () => {
  const clock = fakeClock();
  const parseError = new SyntaxError("bad JSON");
  const error = await errorFrom(requestJson("/bad-error-body", {}, deps(clock, async () =>
    response(undefined, 503, { json: async () => { throw parseError; } }))));

  assert.equal(error.kind, "http");
  assert.equal(error.status, 503);
  assert.equal(error.current, undefined);
  assert.match(error.message, /503/);
  assert.strictEqual(error.cause, parseError);
  assert.equal(clock.pendingCount(), 0);
});

test("a malformed successful response is a network error with status and original cause", async () => {
  const clock = fakeClock(), parseError = new SyntaxError("bad JSON");
  const error = await errorFrom(requestJson("/saved-but-unreadable", {}, deps(clock, async () =>
    response(undefined, 200, { json: async () => { throw parseError; } }))));

  assert.equal(error.name, "NetworkError");
  assert.equal(error.kind, "network");
  assert.equal(error.status, 200);
  assert.match(error.message, /may have succeeded/i);
  assert.strictEqual(error.cause, parseError);
  assert.equal(clock.pendingCount(), 0);
});

test("fetch rejection is a network error and a POST is never retried", async () => {
  const clock = fakeClock(), caller = trackedSignal();
  const failure = new TypeError("offline");
  let fetchCount = 0;
  const error = await errorFrom(requestJson("/write", { method: "POST", body: "{}", signal: caller }, deps(clock, async () => {
    fetchCount += 1;
    throw failure;
  })));

  assert.equal(error.name, "NetworkError");
  assert.equal(error.kind, "network");
  assert.strictEqual(error.cause, failure);
  assert.equal(fetchCount, 1);
  assert.equal(caller.listenerCount(), 0);
  assert.equal(clock.pendingCount(), 0);
});

test("timeoutMs zero disables the deadline timer", async () => {
  const clock = fakeClock();
  const data = await requestJson("/long-operation", { timeoutMs: 0 }, deps(clock, async () => response({ done: true })));
  assert.deepEqual(data, { done: true });
  assert.equal(clock.pendingCount(), 0);
});
