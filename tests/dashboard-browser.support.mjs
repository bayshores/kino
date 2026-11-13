// What the dashboard's browser tests share: Electron's Chromium driven over the Chrome DevTools
// Protocol (the Browser class), the page expressions that find things, and startDashboard, which
// starts a real kino server with a temporary data folder, Vite serving the app in front of it, and
// the browser. Each test file then sets up its own project by playing the agent through
// POST /api/agent/<verb>. tests/dashboard-browser.test.mjs is the main one; the LIVE milestone's
// files (dashboard-presence-browser, dashboard-live-browser) use the same setup.
//
// Set KINO_DASHBOARD_SHOTS=<folder> to keep a screenshot of each step and of each timed-out wait,
// or KINO_DASHBOARD_TIMEOUT_SHOTS=<folder> for the timed-out waits only (CI does that).
// Set KINO_TEST_CPU_SLOWDOWN=8 to run the page 8 times slower, as on a busy CI machine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { startTestServer } from "../backend/media.test.support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = createRequire(import.meta.url)("electron");
const shots = process.env.KINO_DASHBOARD_SHOTS || "";
const timeoutShots = shots || process.env.KINO_DASHBOARD_TIMEOUT_SHOTS || "";
export const slowdown = Number(process.env.KINO_TEST_CPU_SLOWDOWN) || 1;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---- the browser --------------------------------------------------------------------------------

// What a key press sends: its code, its Windows key code, the text it types, and Shift.
const KEYS = {
  Enter: ["Enter", 13, "\r"], Escape: ["Escape", 27], Tab: ["Tab", 9], Delete: ["Delete", 46], Backspace: ["Backspace", 8],
  ArrowDown: ["ArrowDown", 40], ArrowUp: ["ArrowUp", 38], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36], End: ["End", 35], F1: ["F1", 112], F2: ["F2", 113], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34],
  " ": ["Space", 32, " "], ",": ["Comma", 188, ","], ".": ["Period", 190, "."], "/": ["Slash", 191, "/"], "?": ["Slash", 191, "?", true],
  "[": ["BracketLeft", 219, "["], "]": ["BracketRight", 221, "]"], "{": ["BracketLeft", 219, "{", true], "}": ["BracketRight", 221, "}", true],
  "+": ["Equal", 187, "+", true], _: ["Minus", 189, "_", true], ":": ["Semicolon", 186, ":", true],
};
function keyInfo(key) {
  if (KEYS[key]) { const [code, vk, text, shift = false] = KEYS[key]; return { code, vk, text, shift }; }
  if (/^[a-z]$/.test(key)) return { code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key, shift: false };
  if (/^[A-Z]$/.test(key)) return { code: `Key${key}`, vk: key.charCodeAt(0), text: key, shift: true };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, vk: key.charCodeAt(0), text: key, shift: false };
  throw new Error(`No key table entry for ${key}`);
}

export class Browser {
  constructor(child) {
    this.child = child;
    this.next = 1;
    this.waiting = new Map();
    this.listeners = new Set();
    this.output = "";
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.stderr.on("data", (chunk) => { this.output = `${this.output}${chunk}`.slice(-4000); });
    child.once("exit", (code) => {
      for (const { reject } of this.waiting.values()) reject(new Error(`The browser exited (${code}). ${this.output}`));
      this.waiting.clear();
    });
  }

  static async open(profile) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [path.join(root, "tests/dashboard-browser.electron.cjs"), profile], { env, stdio: ["pipe", "pipe", "pipe"] });
    const browser = new Browser(child);
    await browser.once((message) => message.ready, 60_000, "the browser to start");
    return browser;
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.output = `${this.output}${line}\n`.slice(-4000); return; }
    if (message.id && this.waiting.has(message.id)) {
      const { resolve, reject } = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(method, params = {}, timeout = 60_000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`The browser did not answer ${method} in ${timeout} ms. ${this.output}`)); }, timeout);
      this.waiting.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  once(predicate, timeout = 15_000, what = "a browser message") {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error(`Timed out waiting for ${what}. ${this.output}`)); }, timeout);
      const listener = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      this.listeners.add(listener);
    });
  }

  async evaluate(expression, timeout = 60_000) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (exceptionDetails) throw new Error(`In the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  }

  /** Runs `expression` in the page until it gives something truthy, and returns that. */
  async waitFor(expression, { timeout = 15_000, what } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      if (Date.now() > deadline) {
        this.timeouts = (this.timeouts ?? 0) + 1;
        const shown = await this.shown();
        const picture = timeoutShots ? ` ${await this.capture(`timed-out-${this.timeouts}`, timeoutShots)}` : "";
        throw new Error(`Timed out waiting for ${what ?? expression.slice(0, 240)} (last value: ${String(JSON.stringify(last)).slice(0, 300)}). ${shown}${picture}`);
      }
      await sleep(40);
    }
  }

  async key(key) {
    const { code, vk, text, shift } = keyInfo(key);
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
    await this.send("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  async keys(...list) {
    for (const key of list) await this.key(key);
  }

  /** Selects everything in the focused field, the way Cmd+A or Ctrl+A does. */
  selectAll() {
    return this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["selectAll"] })
      .then(() => this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }));
  }

  type(text) {
    return this.send("Input.insertText", { text });
  }

  /** Where an element is on screen (it is scrolled into view first), once it has stopped moving:
   *  right after a page opens, panes still settle, and a drag measured too early lands off by a few
   *  percent (CI saw a 224-wide note area saved as 212). */
  box(expression, what) {
    return this.waitFor(`(async () => {
      const measure = () => {
        const element = ${expression};
        if (!element) return null;
        element.scrollIntoView({ block: "nearest", inline: "nearest" });
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      };
      const first = measure();
      if (!first) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = measure();
      return second && JSON.stringify(second) === JSON.stringify(first) ? second : null;
    })()`, { what: what ?? expression.slice(0, 200) });
  }

  async clickAt(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  /**
   * Where to click or tap an element: its middle, once nothing is drawn over it there and it has
   * stayed put for 100 ms. A slow page can still be moving things (a stream update adds a row,
   * a turn review switches the scene), and a click measured before the move lands elsewhere.
   */
  target(expression, what) {
    return this.waitFor(`(async () => {
      const measure = () => {
        const element = ${expression};
        if (!element) return null;
        element.scrollIntoView({ block: "nearest", inline: "nearest" });
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        return top && element.contains(top) ? { x, y } : null;
      };
      const first = measure();
      if (!first) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = measure();
      return second && second.x === first.x && second.y === first.y ? second : null;
    })()`, { what: what ?? expression.slice(0, 200) });
  }

  async click(expression, what) {
    const at = await this.target(expression, what);
    await this.clickAt(at.x, at.y);
    return at;
  }

  async drag(from, to, steps = 6) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  }

  async tap(expression, what) {
    const at = await this.target(expression, what);
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  async shot(name) {
    if (!shots) return;
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await mkdir(shots, { recursive: true });
    await writeFile(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  }

  /**
   * What the page shows, for a wait that timed out: the top line (its message usually says what
   * went wrong) and the session pane's render rows. It gives up after 5 s: a stuck page must not
   * hold up the error.
   */
  async shown() {
    try {
      const { top, renders } = await this.evaluate(`(() => {
        const text = (element) => element.innerText.replace(/\\s+/g, " ").trim();
        const top = document.querySelector(".topline");
        return { top: top ? text(top) : "(none)", renders: [...document.querySelectorAll(".p-session div.row")].map(text) };
      })()`, 5000);
      return `The page's top line: ${top}.${renders.length ? ` Render rows: ${renders.join(" | ")}.` : ""}`;
    } catch (error) {
      return `The page did not say what it shows: ${error.message.slice(0, 200)}`;
    }
  }

  /** Saves a picture of the window as <folder>/<name>.png and says how that went, within 5 s. */
  async capture(name, folder) {
    try {
      const { empty, data } = await this.send("capture", {}, 5000);
      if (empty) return "No screenshot: the window had nothing drawn.";
      const file = path.join(folder, `${name}.png`);
      await mkdir(folder, { recursive: true });
      await writeFile(file, Buffer.from(data, "base64"));
      return `Screenshot: ${file}`;
    } catch (error) {
      return `No screenshot: ${error.message.slice(0, 200)}`;
    }
  }

  async quit() {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.send("quit").catch(() => {});
    // unref: once the browser has exited, this timer must not keep the test process alive 5 s more.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

// ---- finding things in the page (each is an expression evaluated in the page) ------------------

export const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
export const textOf = (selector) => `(${q(selector)}?.innerText ?? "")`;
/** The first visible button, link or tab under `scope` whose text contains `text`. */
export const button = (text, scope = "body") =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button, ${scope} a, ${scope} [role=tab]`)})].find((element) => element.textContent.replace(/\\s+/g, " ").trim().includes(${JSON.stringify(text)}) && element.getClientRects().length)`;
export const layerButton = (name) => `[...document.querySelectorAll(".p-timeline .row-button")].find((element) => element.innerText.trim() === ${JSON.stringify(name)})`;
/**
 * The timeline shows the shot strip until "Show every lane and layer" is pressed (the layer rows,
 * the agent's lane and the zoom buttons come with it). Opens them, or does nothing if already open.
 */
export async function showLanes(browser) {
  const toggle = q('.p-timeline button[aria-label="Show every lane and layer"]');
  if (await browser.evaluate(`!!${toggle}`)) await browser.click(toggle);
  await browser.waitFor(`!!${q(".p-timeline .row-button")}`, { what: "the layer rows" });
}
export const pageHas = (text, selector = "body") => `${textOf(selector)}.includes(${JSON.stringify(text)})`;

/** Calls `check` until it gives something truthy. */
export async function until(check, what = "the server", timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

// ---- the server, Vite and the browser ----------------------------------------------------------

/**
 * Starts a test server (no owner key), Vite in front of it on a free port, and the browser, with
 * the window checked and set up the way every dashboard test expects (1440×900, focus emulation
 * on). The project is the caller's: play the agent with
 * `server.api("/api/agent/<verb>", { method: "POST", body })`, and add
 * `headers: { "x-kino-session": "test-nova-1" }` to act as another connected agent.
 * Returns { server, browser, appUrl, folder, open(url?), reviewKey(), stop() }: `folder` is a
 * temporary folder of the test's own (deleted by stop), open() loads the dashboard fresh and waits
 * for its first real stage frame, and reviewKey() asks for a new review key the way a dashboard
 * page asks (send it as x-kino-review to change things as the dashboard).
 */
export async function startDashboard({ prefix = "kino-dashboard-browser-", env } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), prefix));
  let server;
  let vite;
  let browser;
  const stop = async () => {
    await browser?.quit();
    await vite?.close();
    await server?.stop();
    await rm(folder, { recursive: true, force: true });
  };
  try {
    // `env` adds to the server's environment (the crew test's stub claude and temporary HOME).
    server = await startTestServer({ ownerToken: "", ...(env ? { env } : {}) });

    // Vite serves the app and passes /api to the test server, as `npm run dev` does.
    process.env.MOTION_API_PORT = new URL(server.baseUrl).port;
    process.env.KINO_DEV_PORT = String(await freePort());
    const { createServer } = await import("vite");
    vite = await createServer({ root, logLevel: "error", cacheDir: path.join(folder, "vite"), server: { hmr: false } });
    await vite.listen();
    const appUrl = `http://127.0.0.1:${process.env.KINO_DEV_PORT}/`;

    browser = await Browser.open(path.join(folder, "electron"));
    // The playback tests count display frames. A window that paints about once a second (a hidden
    // window on Linux, see tests/dashboard-browser.electron.cjs) fails them with timeouts that do
    // not say why, so the rate is checked here first: for one second the blank page draws a new
    // number in every display frame (with nothing to draw, even that window gets 60 a second).
    const displayRate = await browser.evaluate(`new Promise((done) => requestAnimationFrame((start) => {
      let count = 0;
      const tick = (now) => {
        count += 1;
        document.body.textContent = count;
        if (now - start < 1000) requestAnimationFrame(tick);
        else { document.body.textContent = ""; done(Math.round((count * 1000) / (now - start))); }
      };
      requestAnimationFrame(tick);
    }))`);
    assert.ok(displayRate >= 20, `the test window paints ${displayRate} display frames a second; the playback tests need the screen's rate`);
    await browser.send("Page.enable");
    await browser.send("Accessibility.enable");
    await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    if (slowdown > 1) await browser.send("Emulation.setCPUThrottlingRate", { rate: slowdown });

    /** Loads the dashboard fresh and waits for its first real stage frame. */
    const open = async (url = appUrl) => {
      await browser.send("Page.navigate", { url });
      await browser.waitFor(`(() => { const image = document.querySelector(".stage img"); return !!(image && image.complete && image.naturalWidth); })() || !!document.querySelector(".phone-stack .stage img")`,
        { timeout: 30_000, what: "the dashboard's first stage frame" });
    };
    const reviewKey = async () => {
      const response = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
      return (await response.json()).key;
    };
    return { server, browser, appUrl, folder, open, reviewKey, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
