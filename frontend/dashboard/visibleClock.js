// A clock tick every `ms` while the window is shown. A hidden window (minimized, another space,
// behind another app's full screen) does not tick, so the whole dashboard does not draw again
// each second for nobody; it ticks once at once when it is shown again.
export function tickWhileShown(onTick, ms, doc = globalThis.document) {
  let timer = null;
  const shown = () => !doc || doc.visibilityState !== "hidden";
  const start = () => { if (timer === null) timer = setInterval(onTick, ms); };
  const stop = () => { clearInterval(timer); timer = null; };
  const change = () => {
    if (shown()) { onTick(); start(); } else stop();
  };
  if (shown()) start();
  doc?.addEventListener?.("visibilitychange", change);
  return () => { stop(); doc?.removeEventListener?.("visibilitychange", change); };
}
