#!/usr/bin/env node
// Opens the kino desktop app (Electron) with Playwright, waits for the dashboard, and saves a
// screenshot of its window. For checking the UI in the real app instead of a web browser.
//
//   node scripts/desktop-shot.mjs --data <data folder> --out shot.png [--size 1440x900]
//        [--goto "/?project=x#share=<token>"]
//        [--wait "<css selector>"] [--keys "F2"] [--click "<css selector>;<css selector>"] [--then "t"] [--until "<css selector>"] [--pause <ms>] [--hold]
//
// It runs on its own temporary profile (--user-data-dir), so it never takes over a kino app that
// is already open or its runtime.json. Without --hold the window is invisible, silent and cannot take focus. --data is the kino data folder to show (MOTION_DATA_DIR);
// without it, a new empty one is made and deleted afterwards. --keys presses keys (comma
// separated, Playwright names) before the shot; --click then clicks each selector (; separated), and --then presses more keys after the clicks; --until waits (90 s at most) for a selector before the shot. --hold keeps the app open until Ctrl-C.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

function options(argv) {
  const out = { size: "1440x900", wait: ".dash", keys: "", click: "", then: "", until: "", pause: "800" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--hold") { out.hold = true; continue; }
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined) throw new Error(`Unknown or empty option: ${name}`);
    out[name.slice(2)] = value;
    index += 1;
  }
  if (!out.out && !out.hold) throw new Error("Give --out <file.png> (or --hold).");
  return out;
}

const settings = options(process.argv.slice(2));
const [width, height] = settings.size.split("x").map(Number);
const profile = await mkdtemp(path.join(tmpdir(), "kino-desktop-profile-"));
const ownData = settings.data ? null : await mkdtemp(path.join(tmpdir(), "kino-desktop-data-"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root, `--user-data-dir=${profile}`],
  env: { ...process.env, MOTION_DATA_DIR: path.resolve(settings.data ?? ownData) },
});
try {
  const window = await app.firstWindow();
  // A test window never takes the person's typing or clicks or shows on their screen (--hold is for looking by eye).
  if (!settings.hold) await app.evaluate(({ BrowserWindow }) => {
    for (const each of BrowserWindow.getAllWindows()) { each.setFocusable(false); each.blur(); each.setOpacity(0); each.setIgnoreMouseEvents(true); each.webContents.setAudioMuted(true); }
  });
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const each of BrowserWindow.getAllWindows()) each.setContentSize(size.width, size.height);
  }, { width, height });
  // --goto <path>: another page of the same local server, such as a share link (/?project=x#share=<token>).
  if (settings.goto) {
    await window.waitForSelector(".dash", { timeout: 30_000 });
    await window.goto(new URL(settings.goto, window.url()).href);
  }
  await window.waitForSelector(settings.wait, { timeout: 30_000 });
  for (const key of settings.keys.split(",").filter(Boolean)) await window.keyboard.press(key.trim());
  for (const selector of settings.click.split(";").filter(Boolean)) { await window.waitForTimeout(300); await window.click(selector.trim()); }
  for (const key of settings.then.split(",").filter(Boolean)) { await window.waitForTimeout(150); await window.keyboard.press(key.trim()); }
  if (settings.until) await window.waitForSelector(settings.until, { timeout: 90_000 }).catch(() => console.error(`not seen in 90 s: ${settings.until}`));
  await window.waitForTimeout(Number(settings.pause) || 800);
  if (settings.out) {
    await window.screenshot({ path: path.resolve(settings.out) });
    console.log(path.resolve(settings.out));
  }
  if (settings.hold) await new Promise((resolve) => process.once("SIGINT", resolve));
} finally {
  await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
  if (ownData) await rm(ownData, { recursive: true, force: true });
}
