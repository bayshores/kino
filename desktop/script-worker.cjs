// A separate Electron process that runs script layers' drawing modules (backend/script-frames.mjs
// starts it with --kino-script-worker). A module may come from a stranger's shared video, so it runs
// in a sandboxed frame with an opaque origin inside a hidden window: no Node, no preload
// it can reach, its own in-memory session, every network request cancelled, every permission
// denied, no navigation and no new windows. This process times each setup and draw and throws the
// window away when one takes too long.
//
// Requests arrive on stdin as JSON lines and each gets one JSON line on stdout:
//   {id, type:"mount", script, width, height, pixelRatio, name, images:{key: base64}, time}
//      -> {id, ok:true, context} | {id, ok:false, message, phase, time, line?, column?}
//   {id, type:"draw", frame} -> {id, ok:true, context, empty, png: base64} | {id, ok:false, ...}
//   {id, type:"requests"} -> {id, ok:true, allowed:[url], cancelled:[url]} (what the session saw)
const { app, BrowserWindow, protocol, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { exitOnUncaught, exitWithParent } = require("./raster-worker.cjs");

const SCHEME = "kino-script";
const HOST_URL = `${SCHEME}://app/host.html`;
const FRAME_URL = `${SCHEME}://app/frame.html`;
const MAX_INPUT = 96 * 1024 * 1024;
// How long the PNG of a drawn frame may take to come back after the draw itself returned.
const READ_LIMIT_MS = 20_000;
const MAX_SEEN = 200;

// The page has no script of its own: its preload (script-page.cjs) passes the messages on.
const HOST_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-src kino-script:; base-uri 'none'; form-action 'none'";
const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{border:0;width:1px;height:1px}</style></head>
<body><iframe id="script-frame" sandbox="allow-scripts" src="${FRAME_URL}"></iframe></body></html>`;

function argumentValue(name) {
  const argument = process.argv.find(value => value.startsWith(`--${name}=`));
  return argument ? argument.slice(argument.indexOf("=") + 1) : null;
}

function writeLine(value) {
  return new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve()));
}

async function runScriptWorker() {
  exitOnUncaught();
  exitWithParent();
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
  const given = argumentValue("kino-script-directory");
  if (!given) throw new Error("A private script worker directory is required.");
  const directory = path.resolve(given);
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The script worker directory must be a real directory.");
  const profile = path.join(directory, "profile");
  for (const child of [profile, path.join(profile, "session"), path.join(profile, "cache"), path.join(profile, "logs"), path.join(directory, "crashes")])
    fs.mkdirSync(child, { recursive: true, mode: 0o700 });
  app.setName("kino script");
  app.setPath("userData", profile);
  app.setPath("sessionData", path.join(profile, "session"));
  app.setPath("cache", path.join(profile, "cache"));
  app.setPath("crashDumps", path.join(directory, "crashes"));
  app.setAppLogsPath(path.join(profile, "logs"));
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  const { SCRIPT_LIMITS, scriptFrameHtml, tooLongMessage, SCRIPT_FRAME_CSP } = await import(pathToFileURL(path.join(__dirname, "..", "engine", "scriptRuntime.js")).href);
  // Each mount replaces the window; the worker keeps running between them.
  app.on("window-all-closed", () => {});
  await app.whenReady();

  // Not "persist:": the session lives in memory only.
  const isolated = session.fromPartition("kino-script");
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.setDevicePermissionHandler?.(() => false);
  isolated.on("will-download", event => event.preventDefault());
  const pages = {
    [HOST_URL]: { html: HOST_HTML, csp: HOST_CSP },
    // The frame is sandboxed by its own headers too, should it ever load on its own.
    [FRAME_URL]: { html: scriptFrameHtml(), csp: `${SCRIPT_FRAME_CSP}; sandbox allow-scripts` },
  };
  isolated.protocol.handle(SCHEME, request => {
    const page = request.method === "GET" ? pages[request.url] : null;
    if (!page) return new Response("Not found", { status: 404 });
    return new Response(page.html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": page.csp, "cache-control": "no-store" } });
  });
  // Every request but the two pages and in-memory URLs is cancelled, whatever its scheme.
  const seen = { allowed: [], cancelled: [] };
  const note = (list, url) => { if (list.length < MAX_SEEN) list.push(String(url).slice(0, 200)); };
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url === HOST_URL || details.url === FRAME_URL || details.url.startsWith("blob:") || details.url.startsWith("data:");
    note(allowed ? seen.allowed : seen.cancelled, details.url);
    callback({ cancel: !allowed });
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    contents.on("will-frame-navigate", event => { if (event.url !== FRAME_URL) event.preventDefault(); });
    contents.on("will-attach-webview", event => event.preventDefault());
  });

  let page = null;
  // The request the page works on: { id, phase, time, resolve, timer }.
  let current = null;
  // Why the last page was thrown away between requests, for the next draw's answer.
  let broken = null;

  function closePage() {
    const old = page;
    page = null;
    if (!old) return;
    if (!old.window.isDestroyed()) {
      try { old.window.webContents.forcefullyCrashRenderer(); } catch { /* already gone */ }
      old.window.destroy();
    }
  }

  // Answers the request in hand and forgets it.
  function finish(reply) {
    if (!current) return;
    const request = current;
    current = null;
    clearTimeout(request.timer);
    request.resolve(reply);
  }

  // A script past its limit: its page (and every process it runs in) is thrown away.
  function tooLong(request) {
    if (current !== request) return;
    closePage();
    finish({ ok: false, message: tooLongMessage(request.time), phase: request.phase, time: request.time, reset: true });
  }

  // A hidden window that is never shown (and no Dock icon, above). Not an offscreen-rendering
  // window: there, the sandboxed frame's convertToBlob waited about 1 s for one frame in three
  // (measured 2026-11-12, Electron 44 on a Mac); the canvas is an OffscreenCanvas either way.
  async function openPage() {
    const window = new BrowserWindow({
      width: 1, height: 1, show: false, frame: false, focusable: false, hiddenInMissionControl: true,
      skipTaskbar: true, paintWhenInitiallyHidden: false,
      webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false, sandbox: true, offscreen: false, backgroundThrottling: false, webSecurity: true,
        webviewTag: false, spellcheck: false, navigateOnDragDrop: false, safeDialogs: true,
        preload: path.join(__dirname, "script-page.cjs") },
    });
    const opened = { window, ready: null };
    opened.ready = new Promise((resolve, reject) => {
      const onReady = event => { if (event.sender === window.webContents) { window.webContents.ipc.off("kino-script:ready", onReady); resolve(); } };
      window.webContents.ipc.on("kino-script:ready", onReady);
      setTimeout(() => reject(new Error("The script page did not start within 10 seconds.")), 10_000).unref?.();
    });
    window.webContents.ipc.on("kino-script:loaded", (_event, id) => {
      if (page === opened && current?.id === id && current.phase === "load") current.phase = "setup";
    });
    window.webContents.ipc.on("kino-script:drew", (_event, id) => {
      if (page !== opened || current?.id !== id || current.phase !== "draw") return;
      // The draw returned: the PNG may take longer than the draw's own limit.
      clearTimeout(current.timer);
      current.timer = setTimeout(() => tooLong(current), READ_LIMIT_MS);
    });
    window.webContents.ipc.on("kino-script:done", (_event, reply) => {      if (page !== opened || current?.id !== reply?.id) return;
      finish(reply);
    });
    // A script that sends its own frame to another address is refused (by this, or before it by
    // the page's frame-src policy, which leaves an error page in the frame). Either way its page is
    // thrown away and the request in hand answers why.
    const leave = url => {
      if (page !== opened) return;
      const message = `The script tried to open another page (${String(url).slice(0, 120)}).`;
      closePage();
      broken = message;
      if (current) finish({ ok: false, message, phase: current.phase, time: current.time, reset: true });
    };
    window.webContents.on("will-frame-navigate", event => {
      if (event.url === (event.isMainFrame ? HOST_URL : FRAME_URL) && !opened.loaded) return;
      event.preventDefault();
      leave(event.url);
    });
    window.webContents.on("did-start-navigation", event => {
      if (opened.loaded && !event.isSameDocument) leave(event.url);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      if (page !== opened) return;
      closePage();
      if (current) finish({ ok: false, message: `The script's page stopped (${details?.reason ?? "unknown"}).`, phase: current.phase, time: current.time, reset: true });
    });
    page = opened;
    await window.loadURL(HOST_URL);
    await opened.ready;
    // From here on the page and its frame stay where they are.
    opened.loaded = true;
    return opened;
  }

  // Sends one message to the frame and waits for its answer, at most `limit` milliseconds.
  function ask(message, phase, time, limit) {
    return new Promise((resolve) => {
      current = { id: message.id, phase, time, resolve, timer: null };
      const request = current;
      request.timer = setTimeout(() => tooLong(request), limit);
      page.window.webContents.send("kino-script:request", { kino: "script", ...message });
    });
  }

  async function handle(request) {
    const { id, type } = request;
    if (type === "requests") return { id, ok: true, allowed: seen.allowed.splice(0), cancelled: seen.cancelled.splice(0) };
    if (type === "mount") {
      // A new mount starts on a fresh page: nothing a script left behind carries over.
      closePage();
      broken = null;
      try {
        await openPage();
      } catch (error) {
        closePage();
        return { id, ok: false, message: String(error?.message || error).slice(0, 300), phase: "load", time: 0, reset: true };
      }
      const images = {};
      for (const [key, value] of Object.entries(request.images ?? {})) images[key] = value ? new Uint8Array(Buffer.from(value, "base64")) : null;
      const reply = await ask({ id, type: "mount", script: request.script, width: request.width, height: request.height,
        pixelRatio: request.pixelRatio, name: request.name ?? "", images }, "load", Number(request.time) || 0, SCRIPT_LIMITS.setupMs);
      return { ...reply, id };
    }
    if (type === "draw") {
      const time = Number(request.frame?.time) || 0;
      if (!page) return { id, ok: false, message: broken ?? "No script is mounted.", phase: "draw", time, reset: true };
      const reply = await ask({ id, type: "draw", frame: request.frame, output: "png" }, "draw", time, SCRIPT_LIMITS.drawMs);
      const answer = { ...reply, id };
      if (reply.png) answer.png = Buffer.from(reply.png).toString("base64");
      return answer;
    }
    return { id, ok: false, message: "Unknown request.", phase: "load", time: 0 };
  }

  await writeLine({ type: "ready", electron: process.versions.electron });

  let buffered = "", busy = Promise.resolve(), ended = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffered += chunk;
    if (buffered.length > MAX_INPUT) {
      process.stderr.write("kino script worker: a request was too large.\n");
      app.exit(1);
      return;
    }
    let end;
    while ((end = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      busy = busy.then(async () => {
        let request;
        try { request = JSON.parse(line); } catch { request = null; }
        if (!request || !Number.isSafeInteger(request.id)) {
          process.stderr.write("kino script worker: an invalid request.\n");
          app.exit(1);
          return;
        }
        await writeLine(await handle(request));
      });
    }
  });
  const inputClosed = () => {
    if (ended) return;
    ended = true;
    closePage();
    app.exit(0);
  };
  process.stdin.on("end", inputClosed);
  process.stdin.on("close", inputClosed);
  process.stdin.on("error", () => app.exit(1));
}

module.exports = { runScriptWorker };
// The development entry starts itself; the packaged app's main calls runScriptWorker
// (desktop/main.mjs), as it does for the raster worker.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) runScriptWorker().catch(error => {
  process.stderr.write(`kino script worker: ${String(error?.message || error).slice(0, 500)}\n`);
  app.exit(1);
});
