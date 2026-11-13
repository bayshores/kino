import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, utilityProcess } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopSettings } from "./settings.mjs";
import { isEditorUrl, serviceRequestAllowed } from "./navigation.mjs";
import { installEditCommands } from "./edit-commands.mjs";
import { installOpenSource } from "./open-source.mjs";
import { desktopLinkUrl, parseDesktopLink } from "../engine/shareUrls.js";
import { createRestartPolicy, ownerSessionCookie, restartPort, relocatedEditorUrl } from "./service-restart.mjs";
import { askAfterServiceStopped, askWhenWindowDoesNotAnswer } from "./dialogs.mjs";
import { appMenuTemplate } from "./menu.mjs";
import rasterWorker from "./raster-worker.cjs";

// A packaged executable also hosts isolated export workers. Dispatch before the
// editor's single-instance lock and standard user-data settings are touched.
if (process.argv.includes("--kino-raster-worker")) {
  // Electron completes this ES module before emitting ready. Waiting for the
  // worker here would wait on app.whenReady() while preventing that event.
  void rasterWorker.runRasterWorker().catch(error => {
    process.stderr.write(`kino export worker: ${String(error.message).slice(0, 500)}\n`);
    app.exit(1);
  });
} else {
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
app.setName("kino");
const support = app.getPath("userData");
const runtimeFile = path.join(support, "runtime.json");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let service;
  let origin;
  let desktopSession;
  let stopping = false;
  let quitting = false;
  let serviceStatus = "reconnecting", serviceEnvironment, ownerToken, restartTask;
  let networkOrigin = null;
  const restartPolicy = createRestartPolicy();
  const instanceId = randomUUID();
  const windows = new Set();
  const saveRequests = new Map();
  const reloadRequests = new Map();
  const windowIds = new Map();
  const windowLocations = new Map();
  const closing = new Set();
  const approvedClose = new Set();
  const preload = path.join(root, "desktop/preload.cjs");
  // On a Mac, kino's top line is the title bar: no system title, the traffic lights sit on the
  // left of the top line (the page keeps room for them and makes the line drag the window).
  const macTitleBar = process.platform === "darwin" ? { titleBarStyle: "hidden", trafficLightPosition: { x: 18, y: 19 } } : {};
  // A window's color before its page has drawn: the page color of the kept theme (dashboard.css
  // --bg0), else of the system's, so a light window does not open dark for a moment.
  const PAGE_COLORS = { dark: "#0a0a0a", light: "#f4f2ec" };
  let keptTheme = () => null;
  const pageColor = () => PAGE_COLORS[keptTheme()] ?? (nativeTheme.shouldUseDarkColors ? PAGE_COLORS.dark : PAGE_COLORS.light);
  const pendingLinks = [];
  let linksReady = false, openingLink = Promise.resolve();

  function queueLink(value) {
    if (!parseDesktopLink(value)) return false;
    if (!linksReady) {
      if (pendingLinks.length < 10 && !pendingLinks.includes(value)) pendingLinks.push(value);
      return true;
    }
    openingLink = openingLink.catch(() => {}).then(async () => {
      if (stopping || quitting) return;
      const destination = desktopLinkUrl(value, origin);
      if (!destination) return;
      const target = new URL(destination);
      // A capability window stays separate from an owner's window. A launch URL
      // cannot borrow the app's owner cookie, even if it guesses a local file ID.
      const window = [...windows].find((candidate) => {
        if (candidate.isDestroyed()) return false;
        try {
          const current = new URL(candidate.webContents.getURL());
          return current.origin === origin && current.searchParams.get("project") === target.searchParams.get("project") &&
            current.hash === target.hash;
        } catch { return false; }
      });
      if (!window) { openEditor(destination); return; }
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
      if (window.webContents.getURL() === destination || !await readyToLeave(window, "link") || window.isDestroyed()) return;
      await window.loadURL(destination);
    }).catch(() => dialog.showErrorBox("kino could not open the link", "Reopen the file link after kino has finished starting."));
    return true;
  }
  // macOS can deliver a cold-start URL before ready or any async initialization.
  app.on("open-url", (event, value) => { event.preventDefault(); queueLink(value); });
  for (const value of process.argv) if (value.startsWith("kino:")) queueLink(value);

  function trustedSender(event) {
    return [...windows].some((window) => window.webContents === event.sender) &&
      event.senderFrame === event.sender.mainFrame &&
      event.senderFrame?.url.startsWith(`${origin}/`);
  }
  installEditCommands({ ipcMain, trustedSender, isClosing: () => stopping || quitting });
  installOpenSource({ ipcMain, shell, trustedSender, isClosing: () => stopping || quitting });
  ipcMain.on("kino:window-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    event.returnValue = trustedSender(event) ? {
      windowId: windowIds.get(event.sender.id), status: serviceStatus,
      insetTitleBar: Boolean(macTitleBar.titleBarStyle), fullScreen: Boolean(window?.isFullScreen()),
    } : null;
  });
  // The dashboard's count of things that need you (plan §5.13), on the Dock icon.
  ipcMain.on("kino:set-badge", (event, count) => {
    if (!trustedSender(event)) return;
    const value = Number.isSafeInteger(count) && count > 0 && count < 1000 ? count : 0;
    app.setBadgeCount?.(value);
  });
  ipcMain.on("kino:checkpointed-before-reload", (event, result) => {
    if (!trustedSender(event)) return;
    const request = reloadRequests.get(event.sender.id);
    if (request?.id === result?.requestId) request.finish(result.retained === true);
  });

  function announceService(state) {
    serviceStatus = state;
    for (const window of windows) if (!window.isDestroyed()) window.webContents.send("kino:service-status", state);
  }

  function checkpoint(window) {
    if (window.isDestroyed() || window.webContents.getURL() === "about:blank") return Promise.resolve(true);
    const contents = window.webContents, id = randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => finish(false), 5000);
      const finish = (retained) => { clearTimeout(timeout); reloadRequests.delete(contents.id); resolve(retained); };
      reloadRequests.set(contents.id, { id, finish });
      contents.send("kino:checkpoint-before-reload", id);
    });
  }

  ipcMain.on("kino:saved-before-close", (event, result) => {
    if (!trustedSender(event)) return;
    const request = saveRequests.get(event.sender.id);
    if (request && request.id === result?.requestId) request.finish(result.saved === true);
  });

  function requestSave(window) {
    if (window.isDestroyed() || window.webContents.getURL() === "about:blank") return Promise.resolve(true);
    const contents = window.webContents;
    if (saveRequests.has(contents.id)) return saveRequests.get(contents.id).promise;
    const id = randomUUID();
    let finish;
    const promise = new Promise((resolve) => {
      const timeout = setTimeout(() => finish(false), 15000);
      finish = (saved) => {
        clearTimeout(timeout);
        saveRequests.delete(contents.id);
        resolve(saved);
      };
    });
    saveRequests.set(contents.id, { id, promise, finish });
    contents.send("kino:save-before-close", id);
    return promise;
  }

  // Asks the page before a window closes, quits, reloads or opens a link (`action`). The page
  // answers at once: it keeps no unsaved work, because the local service saves each project. A
  // page that does not answer in 15 s is busy or stuck, and the person chooses: go ahead or wait.
  async function readyToLeave(window, action) {
    if (await requestSave(window)) return true;
    if (window.isDestroyed()) return true;
    window.show();
    return askWhenWindowDoesNotAnswer(dialog, window, action);
  }

  function protectWindow(window) {
    windows.add(window);
    // A crashed or frozen page always goes to the log; with KINO_LOG_CONSOLE=1 the page's console
    // warnings and errors do too (for watching the app while it is in alpha).
    window.webContents.on("render-process-gone", (_event, details) => process.stderr.write(`[kino page] gone: ${details.reason} (exit ${details.exitCode})\n`));
    window.on("unresponsive", () => process.stderr.write("[kino page] not responding\n"));
    window.on("responsive", () => process.stderr.write("[kino page] responding again\n"));
    if (process.env.KINO_LOG_CONSOLE === "1") {
      window.webContents.on("console-message", (event) => {
        if (event.level !== "warning" && event.level !== "error") return;
        const where = event.sourceId ? ` (${String(event.sourceId).split("/").pop()}:${event.lineNumber})` : "";
        process.stderr.write(`[kino page ${event.level}] ${event.message}${where}\n`);
      });
    }
    // Full screen hides the traffic lights, so the page drops the room it keeps for them.
    for (const [name, full] of [["enter-full-screen", true], ["leave-full-screen", false]])
      window.on(name, () => { if (!window.isDestroyed()) window.webContents.send("kino:full-screen", full); });
    windowIds.set(window.webContents.id, randomUUID());
    windowLocations.set(window, { url: origin, frozen: false, reload: false });
    const contentsId = window.webContents.id;
    window.on("closed", () => {
      windows.delete(window);
      closing.delete(window);
      approvedClose.delete(window);
      windowIds.delete(contentsId);
      windowLocations.delete(window);
      reloadRequests.get(contentsId)?.finish(true);
      saveRequests.get(contentsId)?.finish(true);
    });
    window.on("close", (event) => {
      if (stopping || approvedClose.delete(window)) return;
      event.preventDefault();
      if (closing.has(window) || quitting) return;
      closing.add(window);
      readyToLeave(window, "close").then((ready) => {
        if (ready && !window.isDestroyed()) { approvedClose.add(window); window.close(); }
      }).finally(() => closing.delete(window));
    });
    window.webContents.on("will-prevent-unload", () => { stopping = false; });
    const rememberLocation = () => {
      const url = window.webContents.getURL(), location = windowLocations.get(window);
      if (location && url !== "about:blank" && isEditorUrl(url, origin)) location.url = url;
    };
    window.webContents.on("did-navigate-in-page", rememberLocation);
    window.webContents.on("did-finish-load", () => {
      rememberLocation();
      const location = windowLocations.get(window);
      if (location && !location.reload && isEditorUrl(window.webContents.getURL(), origin)) location.frozen = false;
    });
    // A dropped file the page does not take would otherwise load as a file:// page.
    window.webContents.on("will-navigate", (event, url) => {
      if (!isEditorUrl(url, origin)) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!isEditorUrl(url, origin)) return { action: "deny" };
      return { action: "allow", overrideBrowserWindowOptions: {
        width: 1280, height: 840, backgroundColor: pageColor(), ...macTitleBar,
        webPreferences: { session: desktopSession, preload, nodeIntegration: false, contextIsolation: true, sandbox: true },
      } };
    });
    window.webContents.on("did-create-window", protectWindow);
  }

  function openEditor(destination = origin) {
    const window = new BrowserWindow({
      title: "kino", width: 1440, height: 960, minWidth: 760, minHeight: 560,
      show: false, backgroundColor: pageColor(), ...macTitleBar,
      webPreferences: { session: desktopSession, preload, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    protectWindow(window);
    window.once("ready-to-show", () => window.show());
    window.loadURL(destination).catch(() => dialog.showErrorBox("kino could not open", "The local kino page could not be loaded. Reopen kino to try again."));
    return window;
  }

  function launchService(port) {
    const child = utilityProcess.fork(path.join(root, "backend/index.mjs"), [], {
      serviceName: "kino renderer", stdio: "pipe",
      env: { ...serviceEnvironment, MOTION_API_PORT: String(port) },
    });
    service = child;
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    let ready = false, exited = false;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("The local renderer did not start in time."));
      }, 20000);
      child.on("message", (message) => {
        if (message?.type === "kino-startup-error") {
          clearTimeout(timeout);
          reject(Object.assign(new Error("The local renderer could not start."), { code: message.code }));
          return;
        }
        if (ready || message?.type !== "kino-ready" || message.host !== "127.0.0.1" ||
            !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
        clearTimeout(timeout);
        ready = true;
        resolve({ origin: `http://127.0.0.1:${message.port}`, exited: () => exited });
      });
      child.once("exit", (code) => {
        exited = true;
        clearTimeout(timeout);
        if (!ready) reject(new Error(`The local renderer exited (${code}).`));
        // An exit from View > Restart local service was marked with restartPolicy.personAsked().
        else if (service === child && !stopping && serviceStatus === "ready") restartService();
      });
    });
  }

  async function configureService(nextOrigin) {
    desktopSession.webRequest.onHeadersReceived({ urls: [`${nextOrigin}/*`] }, (details, callback) => callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${nextOrigin.replace('http:', 'ws:')}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'`,
      ] },
    }));
    // The new process has a new local cookie session even when its port is unchanged.
    const response = await fetch(`${nextOrigin}/api/session`, { method: "POST", headers: { "X-Kino-Owner": ownerToken }, signal: AbortSignal.timeout(15000) });
    const cookie = ownerSessionCookie(response);
    await desktopSession.cookies.set({ url: nextOrigin, name: "kino_owner", value: cookie, httpOnly: true, sameSite: "strict", path: "/" });
    const temporary = `${runtimeFile}.${instanceId}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, instanceId, origin: nextOrigin, ownerToken, pid: process.pid }), { mode: 0o600 });
    await rename(temporary, runtimeFile);
  }

  // `manual`: the person asked for it, so the first try goes ahead even after the automatic
  // tries used up their limit (service-restart.mjs createRestartPolicy).
  function restartService({ manual = false } = {}) {
    if (stopping || restartTask) return restartTask;
    linksReady = false;
    networkOrigin = null;
    announceService("reconnecting");
    restartTask = (async () => {
      let manualTry = manual;
      while (!stopping && restartPolicy.claim({ manual: manualTry })) {
        manualTry = false;
        const previousOrigin = origin;
        const previousPort = Number(new URL(previousOrigin).port);
        try {
          let ready;
          try { ready = await launchService(restartPort(previousPort)); }
          catch (error) {
            if (error.code !== "EADDRINUSE") throw error;
            ready = await launchService(restartPort(previousPort, true));
          }
          await configureService(ready.origin);
          if (ready.exited()) throw new Error("The local renderer stopped during restart.");
          networkOrigin = ready.origin;
          const reloads = [];
          for (const window of windows) {
            if (window.isDestroyed()) continue;
            const location = windowLocations.get(window);
            const from = new URL(location.url).origin;
            if (from === ready.origin && !location.reload) continue;
            if (!location.frozen) {
              if (!await checkpoint(window)) throw new Error("An open window could not keep its local recovery copy.");
              location.frozen = true;
            }
            const destination = relocatedEditorUrl(location.url, from, ready.origin);
            if (!destination) throw new Error("An open file could not be reconnected.");
            reloads.push({ window, location, destination });
          }
          origin = ready.origin;
          await Promise.all(reloads.map(async ({ window, location, destination }) => {
            if (window.isDestroyed()) return;
            location.reload = true;
            location.url = destination;
            try { await window.loadURL(destination); location.reload = false; location.frozen = false; }
            catch (error) { if (!window.isDestroyed()) throw error; }
          }));
          if (ready.exited()) throw new Error("The local renderer stopped during restart.");
          announceService("ready");
          linksReady = true;
          for (const link of pendingLinks.splice(0)) queueLink(link);
          return;
        } catch {
          networkOrigin = null;
          service?.kill();
          if (!stopping && restartPolicy.remaining()) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (!stopping) {
        announceService("failed");
        // The windows stay open and say the service stopped (frontend/useViewerDocument.js). The
        // projects were saved by the service as they changed; the person picks what happens next.
        void askAfterServiceStopped(dialog).then((choice) => {
          if (stopping) return;
          if (choice === "restart" && serviceStatus === "failed") restartService({ manual: true });
          else if (choice === "quit") app.quit();
        });
      }
    })().finally(() => { restartTask = null; });
    return restartTask;
  }

  async function start() {
    await app.whenReady();
    if (app.isPackaged) app.setAsDefaultProtocolClient("kino");
    // The packaged app gets its Dock icon from assets/kino-icon.icns; `npm run desktop` would
    // otherwise show Electron's default icon.
    else app.dock?.setIcon(nativeImage.createFromPath(path.join(root, "assets/kino-icon.png")));
    await mkdir(support, { recursive: true, mode: 0o700 });
    const dataRoot = process.env.MOTION_DATA_DIR || path.join(support, "data");
    const settings = createDesktopSettings(path.join(support, "settings"));
    keptTheme = () => { try { return settings.getItem("kino-dashboard.theme"); } catch { return null; } };
    ipcMain.on("kino:setting", (event, request) => {
      // No filesystem paths, owner credential, or general-purpose IPC are exposed
      // to the renderer. Child frames and other origins cannot access this store.
      if (!trustedSender(event)) { event.returnValue = { ok: false }; return; }
      try {
        let value;
        if (request?.action === "get") value = settings.getItem(request.key);
        else if (request?.action === "set") {
          settings.setItem(request.key, request.value);
          // The theme changed: every window's own color follows (seen while a page loads or resizes).
          if (request.key === "kino-dashboard.theme") for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(pageColor());
        }
        else if (request?.action === "remove") settings.removeItem(request.key);
        else if (request?.action === "keys") value = settings.keys(request.key);
        else throw new Error("Unsupported operation.");
        event.returnValue = { ok: true, value };
      } catch { event.returnValue = { ok: false }; }
    });
    const executable = (name) => {
      const configured = process.env[`KINO_${name.toUpperCase()}`];
      if (configured) return configured;
      const candidates = [path.join(process.resourcesPath, "bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
      return candidates.find((candidate) => existsSync(candidate)) || name;
    };
    // Apple voice isolation (isolate_voice, backend/voice/isolate.mjs) runs the kino-voice helper
    // bundled beside FFmpeg. The DPDFNet voice model goes in <dataRoot>/models (backend/index.mjs).
    const voiceHelper = [process.env.KINO_VOICE_HELPER, path.join(process.resourcesPath, "bin", "kino-voice")]
      .find((candidate) => candidate && existsSync(candidate));
    // Subject cut-out (cut_out, backend/cutout/cutout.mjs) runs the kino-cutout helper (Apple Vision).
    const cutoutHelper = [process.env.KINO_CUTOUT_HELPER, path.join(process.resourcesPath, "bin", "kino-cutout")]
      .find((candidate) => candidate && existsSync(candidate));
    // Inspire's fingerprint and check's reference_drift (backend/measure) run kino-measure (Apple Vision).
    const measureHelper = [process.env.KINO_MEASURE_HELPER, path.join(process.resourcesPath, "bin", "kino-measure")]
      .find((candidate) => candidate && existsSync(candidate));
    ownerToken = randomBytes(32).toString("hex");
    const mcpArgs = [path.join(root, "desktop/mcp.mjs")];
    serviceEnvironment = { ...process.env, MOTION_HOST: "127.0.0.1", MOTION_DATA_DIR: dataRoot,
      KINO_PUBLIC_URL: "", KINO_OWNER_TOKEN: ownerToken, KINO_DESKTOP: "1",
      KINO_FFMPEG: executable("ffmpeg"), KINO_FFPROBE: executable("ffprobe"), KINO_GIFSKI: executable("gifski"),
      ...(voiceHelper ? { KINO_VOICE_HELPER: voiceHelper } : {}),
      ...(cutoutHelper ? { KINO_CUTOUT_HELPER: cutoutHelper } : {}),
      ...(measureHelper ? { KINO_MEASURE_HELPER: measureHelper } : {}),
      KINO_ELECTRON_EXECUTABLE: app.getPath("exe"), KINO_ELECTRON_PACKAGED: app.isPackaged ? "1" : "0",
      KINO_MCP_COMMAND: process.execPath, KINO_MCP_ARGS: JSON.stringify(mcpArgs),
      KINO_MCP_ENV: JSON.stringify({ ELECTRON_RUN_AS_NODE: "1", KINO_RUNTIME_FILE: runtimeFile }),
    };
    desktopSession = session.fromPartition(`kino-${instanceId}`);
    desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    desktopSession.setPermissionCheckHandler(() => false);
    desktopSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      callback({ cancel: !serviceRequestAllowed(details.url, networkOrigin) });
    });
    const ready = await launchService(0);
    origin = ready.origin;
    await configureService(origin);
    if (ready.exited()) throw new Error("The local renderer stopped during startup.");
    networkOrigin = origin;
    app.setAboutPanelOptions({
      applicationName: "kino", applicationVersion: app.getVersion(),
      credits: "kino application source and original artwork are MIT licensed.\nIncludes FFmpeg with x264 (GPL), libvpx and Opus (BSD), and Gifski (AGPL).\nOpen Help for bundled media licenses and complete corresponding source.",
    });
    const openBundledFolder = async (name) => {
      const directory = app.isPackaged ? path.join(process.resourcesPath, name) : path.join(root, ".local/macos-tools/dist", name);
      try {
        const error = existsSync(directory) ? await shell.openPath(directory) : "Build the bundled media tools with npm run desktop:tools.";
        if (error) dialog.showErrorBox("kino could not open the bundled files", error);
      } catch (error) {
        dialog.showErrorBox("kino could not open the bundled files", error.message);
      }
    };
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({
      packaged: app.isPackaged,
      editCommand: (window, command) => window.webContents.send("kino:edit-command", command),
      reload: async (window) => {
        if (await readyToLeave(window, "reload") && !window.isDestroyed()) window.reload();
      },
      restartService: () => {
        // A running service is stopped first and its exit starts the restart, which still counts
        // as one the person asked for, so it goes ahead after the automatic tries are used up.
        if (serviceStatus === "ready") { restartPolicy.personAsked(); service?.kill(); }
        else restartService({ manual: true });
      },
      openBundledFolder: (name) => void openBundledFolder(name),
    })));
    announceService("ready");
    linksReady = true;
    if (pendingLinks.length) for (const link of pendingLinks.splice(0)) queueLink(link);
    else openEditor();
  }

  app.on("second-instance", (_event, argv) => {
    const link = argv.find((value) => value.startsWith("kino:"));
    if (link && queueLink(link)) return;
    const window = [...windows][0];
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
    else if (origin && serviceStatus === "ready") openEditor();
  });
  app.on("activate", () => { if (!windows.size && origin && serviceStatus === "ready") openEditor(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", (event) => {
    if (stopping) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    (async () => {
      for (const window of windows) if (!await readyToLeave(window, "quit")) return;
      stopping = true;
      app.quit();
    })().finally(() => { quitting = false; });
  });
  app.on("will-quit", () => {
    service?.kill();
    try {
      if (JSON.parse(readFileSync(runtimeFile, "utf8")).instanceId === instanceId) unlinkSync(runtimeFile);
    } catch { /* A failed startup may never create the connection file. */ }
  });
  start().catch((error) => { dialog.showErrorBox("kino could not start", error.message); stopping = true; app.quit(); });
}
}
