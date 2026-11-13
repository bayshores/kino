// The page the live preview runs a script layer's module in (frontend/scriptHost.js loads it in
// an <iframe sandbox="allow-scripts">). It is served from its own address, not as srcdoc, so it
// gets its own strict policy instead of the dashboard's: no network, only the runtime and the
// module may run, and the page may start one blob: Worker (the module runs there, so a stuck one
// can be stopped). The `sandbox` directive keeps it sandboxed even when opened on its own.
import { SCRIPT_PREVIEW_FRAME_CSP, scriptFrameHtml } from "../engine/scriptRuntime.js";

/** The response headers of the frame page. */
export function scriptFrameHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `${SCRIPT_PREVIEW_FRAME_CSP}; sandbox allow-scripts`,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

/** Answers a GET or HEAD for the frame page. */
export function sendScriptFrame(req, res) {
  const body = Buffer.from(scriptFrameHtml({ worker: true }));
  res.writeHead(200, { ...scriptFrameHeaders(), "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}
