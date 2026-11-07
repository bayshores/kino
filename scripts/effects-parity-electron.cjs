// This file is both the isolated Electron entry point and its renderer preload.
// The preload branch exposes only a readiness ping; the fixture HTML stays fixed.
if (process.type === "renderer") {
  const { contextBridge, ipcRenderer } = require("electron");
  contextBridge.exposeInMainWorld("effectsParity", Object.freeze({
    ready: () => ipcRenderer.send("effects-parity:ready"),
  }));
} else {
  const fs = require("node:fs");
  const path = require("node:path");
  const { app, BrowserWindow, ipcMain, session } = require("electron");

  const WATCHDOG_MS = 120_000;

  function fixedHtml() {
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>html,body,#root{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}#root>svg{display:block;width:100%;height:100%}</style>
</head><body><main id="root"></main><script>
window.__effectsParitySetSvg = async function(markup) {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (parsed.querySelector("parsererror")) throw new Error("Generated SVG did not parse.");
  const urls = new Set(Array.from(parsed.querySelectorAll("image, feImage"), (element) =>
    element.getAttribute("href") || element.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "")
    .filter((value) => value.startsWith("data:image/")));
  await Promise.all(Array.from(urls, (src) => new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => reject(new Error("Embedded image did not load before capture.")), 8000);
    image.onload = () => { clearTimeout(timeout); resolve(); };
    image.onerror = () => { clearTimeout(timeout); reject(new Error("Embedded image could not be decoded.")); };
    image.src = src;
  })));
  const svg = document.importNode(parsed.documentElement, true);
  const root = document.getElementById("root");
  root.replaceChildren(svg);
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
};
document.addEventListener("DOMContentLoaded", () => window.effectsParity.ready(), { once: true });
</script></body></html>`;
  }

  async function main() {
    const runDirectory = path.resolve(process.argv.at(-1) || "");
    const manifestPath = path.join(runDirectory, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.version !== 1 || !Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) || !Array.isArray(manifest.cases))
      throw new Error("Invalid effects parity manifest.");
    for (const item of manifest.cases) {
      if (!/^[a-z0-9-]+$/i.test(item.id) || typeof item.svg !== "string")
        throw new Error("Invalid effects parity case in manifest.");
    }

    const profile = path.join(runDirectory, "electron-profile");
    const sessionData = path.join(profile, "session");
    const cache = path.join(profile, "cache");
    const crashDumps = path.join(runDirectory, "electron-crashes");
    const logs = path.join(profile, "logs");
    const captures = path.join(runDirectory, "electron-captures");
    for (const directory of [profile, sessionData, cache, crashDumps, logs])
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(captures, { recursive: true, mode: 0o700 });
    app.setPath("userData", profile);
    app.setPath("sessionData", sessionData);
    app.setPath("cache", cache);
    app.setPath("crashDumps", crashDumps);
    app.setAppLogsPath(logs);
    app.commandLine.appendSwitch("force-device-scale-factor", "1");
    app.commandLine.appendSwitch("disable-background-timer-throttling");

    const watchdog = setTimeout(() => app.exit(124), WATCHDOG_MS);
    let window;
    try {
      await app.whenReady();
      app.hide?.();
      app.dock?.hide();
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const allowed = /^(?:data|blob|devtools|chrome):/i.test(details.url);
        callback({ cancel: !allowed });
      });

      window = new BrowserWindow({
        width: manifest.width,
        height: manifest.height,
        useContentSize: true,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        webPreferences: {
          preload: __filename,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
          webSecurity: true,
        },
      });
      window.webContents.setZoomFactor(1);
      window.webContents.setFrameRate(60);

      const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Electron renderer readiness timed out.")), 15_000);
        ipcMain.once("effects-parity:ready", () => { clearTimeout(timeout); resolve(); });
        window.webContents.once("render-process-gone", (_event, details) => {
          clearTimeout(timeout);
          reject(new Error(`Electron renderer exited before readiness (${details.reason}).`));
        });
      });
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixedHtml())}`);
      await ready;

      const records = [];
      for (const item of manifest.cases) {
        const record = { id: item.id, captures: [], error: null };
        try {
          for (const suffix of ["", ".repeat"]) {
            const setup = `window.__effectsParitySetSvg(${JSON.stringify(item.svg)})`;
            await window.webContents.executeJavaScript(setup, true);
            const began = process.hrtime.bigint();
            const image = await window.webContents.capturePage();
            const elapsedMs = Number(process.hrtime.bigint() - began) / 1e6;
            const size = image.getSize();
            if (size.width !== manifest.width || size.height !== manifest.height)
              throw new Error(`Capture size was ${size.width}x${size.height}, expected ${manifest.width}x${manifest.height}.`);
            const filename = path.join(captures, `${item.id}${suffix}.png`);
            fs.writeFileSync(filename, image.toPNG(), { mode: 0o600, flag: "wx" });
            record.captures.push({ filename, elapsedMs });
          }
        } catch (error) {
          record.error = String(error?.message || error).slice(0, 500);
        }
        records.push(record);
      }
      const versions = {
        electron: process.versions.electron || null,
        chromium: process.versions.chrome || null,
        node: process.versions.node || null,
      };
      fs.writeFileSync(path.join(runDirectory, "electron-results.json"), JSON.stringify({ versions, records }), { mode: 0o600, flag: "wx" });
    } finally {
      clearTimeout(watchdog);
      if (window && !window.isDestroyed()) window.destroy();
      app.quit();
    }
  }

  main().catch((error) => {
    process.stderr.write(`[effects-parity-electron] ${String(error?.stack || error).slice(0, 2000)}\n`);
    app.exit(1);
  });
}
