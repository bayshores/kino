// The dashboard's live connection: server-sent events from GET /api/dashboard/stream.
// After a drop it reconnects with the last event number it saw (`since`) and the server's boot
// id, and the server replays exactly what was missed. When that is not possible (the server
// restarted, or too much was missed) the server says "resync" and the dashboard re-reads the
// snapshot. Either way the dashboard says what happened (plan §5.11).

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

/**
 * Opens the stream. `position()` returns { seq, boot } of the data on screen.
 * Handlers: onEvent(event), onResync(), onStatus({ state, replayed? }).
 * Returns a function that closes it.
 */
export function openStream({ position, onEvent, onResync, onStatus }) {
  let source = null;
  let closed = false;
  let attempt = 0;
  let timer = null;

  function connect() {
    if (closed) return;
    const { seq, boot } = position();
    const query = boot ? `?since=${seq}&boot=${encodeURIComponent(boot)}` : "";
    source = new EventSource(`/api/dashboard/stream${query}`);
    source.onmessage = (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      attempt = 0;
      if (event.type === "hello") { onStatus({ state: "live" }); if (event.boot !== position().boot) onResync(); return; }
      if (event.type === "resync") { onStatus({ state: "live", resynced: true }); onResync(); return; }
      if (event.type === "replayed") { onStatus({ state: "live", replayed: event.count }); return; }
      onEvent(event);
    };
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      onStatus({ state: "reconnecting" });
      timer = setTimeout(connect, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
      attempt += 1;
    };
  }

  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}

/**
 * The status line for the Mac app's own report on its local service (window.kinoDesktop
 * .onServiceStatus: "ready", "reconnecting" or "failed"), or null to leave the line to the stream.
 * Only "failed" needs its own words: the app stopped trying to restart the service, so the
 * stream's "reconnecting…" would never end, and the person has to restart it from the View menu.
 */
export function desktopServiceLine(status) {
  return status === "failed" ? { state: "failed", text: "local service stopped · View › Restart local service" } : null;
}
