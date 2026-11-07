// The browser for tests/dashboard-browser.test.mjs: Electron opens one window (hidden, except on
// Linux: see below) and passes
// Chrome DevTools Protocol commands from the test to it. The test writes one JSON line per
// command on stdin ({ id, method, params }); answers ({ id, result } or { id, error }) and
// protocol events ({ event, params }) come back as JSON lines on stdout. Two methods are not
// protocol commands: "capture" (a PNG of the window) and "quit".
const path = require("node:path");
const readline = require("node:readline");
const { app, BrowserWindow } = require("electron");

const profile = process.argv.at(-1);
app.setPath("userData", profile);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
// Sound plays into a silent stand-in for the speakers that keeps real time, so the playback test
// hears nothing on this computer and runs the same on a CI machine without a sound card.
app.commandLine.appendSwitch("disable-audio-output");
// KINO_TEST_CPU_RASTER=1 draws on the CPU, as Linux CI does (no graphics card), to see its slow
// frames on a Mac: run it with a busy CPU (a few `yes > /dev/null`) for a 2-core runner.
if (process.env.KINO_TEST_CPU_RASTER) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
// Stop if the test goes away without saying so.
const watchdog = setTimeout(() => app.exit(124), 15 * 60_000);

app.whenReady().then(async () => {
  app.dock?.hide();
  const window = new BrowserWindow({
    width: 1440, height: 900, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  // The playback tests count display frames, so the window must paint at the screen's rate. On
  // the Mac a hidden window does (120 frames a second on a 120 Hz screen). On Linux a window that
  // was never shown gets 60 only while nothing changes: once the page draws something it gets
  // about one frame a second, even with backgroundThrottling off, so requestAnimationFrame,
  // ResizeObserver and painting all crawl. Shown, it keeps 60 (Electron 44 under xvfb-run on
  // Ubuntu 24.04, a page that draws every frame: 1-4 hidden, 60 shown). So on Linux the window
  // is shown without taking the focus; CI runs it on xvfb's virtual screen, which nobody sees.
  if (process.platform === "linux") window.showInactive();
  // Downloads go into the test's own folder, and the test hears when each one finishes.
  window.webContents.session.on("will-download", (_event, item) => {
    const file = path.join(profile, "downloads", path.basename(item.getFilename()));
    item.setSavePath(file);
    item.once("done", (_done, state) => send({ download: { file, state, bytes: item.getReceivedBytes(), mime: item.getMimeType() } }));
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    send({ fatal: `The page's process stopped: ${details.reason}` });
    app.exit(1);
  });
  const protocol = window.webContents.debugger;
  protocol.attach("1.3");
  protocol.on("message", (_event, method, params) => send({ event: method, params }));
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === "quit") {
      clearTimeout(watchdog);
      send({ id, result: {} });
      app.exit(0);
      return;
    }
    // A screenshot from Electron itself, for a wait that timed out. On CI (xvfb) the protocol's
    // Page.captureScreenshot never saved one of the hidden window; this asks the window directly.
    if (method === "capture") {
      try {
        const image = await window.webContents.capturePage(undefined, { stayHidden: true });
        send({ id, result: { empty: image.isEmpty(), data: image.isEmpty() ? "" : image.toPNG().toString("base64") } });
      } catch (error) {
        send({ id, error: error.message });
      }
      return;
    }
    try {
      send({ id, result: await protocol.sendCommand(method, params ?? {}) });
    } catch (error) {
      send({ id, error: error.message });
    }
  });
  lines.on("close", () => app.exit(0));
  // The protocol answers only once the window has a page.
  await window.loadURL("about:blank");
  send({ ready: true });
});
