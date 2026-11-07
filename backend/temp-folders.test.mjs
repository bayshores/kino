// kino's temporary folders: each job removes its own, also when it fails or is cancelled, and the
// startup sweep removes the ones a stopped kino left (temp-folders.mjs). Every test here uses its
// own fake temp folder, never the computer's real one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene, renderSceneFrames } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { startTestServer } from "./media.test.support.mjs";
import {
  DEAD_OWNER_AGE_MS, NO_OWNER_AGE_MS, makeTempFolder, ownerPid, removeTempFolder, sweepSummary, sweepTempFolders,
} from "./temp-folders.mjs";

const HOUR = 60 * 60 * 1000;
const DEAD = 999_001;
const ALIVE = 999_002;
const isAlive = (pid) => pid === ALIVE;

async function fakeTemp(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "temp-sweep-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Makes `name` in `root` with one 1000-byte file in it, last changed `ageMs` ago.
async function folder(root, name, ageMs, { file = false } = {}) {
  const path = join(root, name);
  if (file) await writeFile(path, "x");
  else {
    await mkdir(join(path, "inner"), { recursive: true });
    await writeFile(join(path, "inner", "frame.png"), Buffer.alloc(1000));
  }
  const at = new Date(Date.now() - ageMs);
  await utimes(path, at, at);
}

// Uses `root` as the computer's temp folder while `run` runs (os.tmpdir() reads TMPDIR).
async function withTemp(root, run) {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try { return await run(); } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
}

function scene() {
  return createScene({ id: "scene", name: "Scene", width: 64, height: 36, duration: 1, background: "#ffffff",
    layers: [createLayer("rectangle", { id: "box", name: "Box", x: 4, y: 4, width: 20, height: 20, fill: "#ff0000" })] });
}

test("a new temporary folder names the process that made it", async (t) => {
  const root = await fakeTemp(t);
  const made = await makeTempFolder("kino-export-", { root });
  assert.match(made, new RegExp(`/kino-export-p${process.pid}-[A-Za-z0-9]{6}$`));
  assert.equal(ownerPid(made), process.pid);
  assert.equal(ownerPid("kino-export-AbC123"), null, "an older kino's folder has no owner");
  await removeTempFolder(made);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(makeTempFolder("kino-unknown-", { root }), /TEMP_FOLDER_PREFIXES/);
});

test("the sweep removes only kino's old folders whose maker has stopped", async (t) => {
  const root = await fakeTemp(t);
  const old = DEAD_OWNER_AGE_MS + HOUR;
  await folder(root, `kino-export-p${DEAD}-AAAAAA`, old);
  await folder(root, `kino-frames-p${DEAD}-BBBBBB`, old);
  await folder(root, `kino-batch-download-p${DEAD}-CCCCCC`, old);
  await folder(root, `kino-mix-p${DEAD}-DDDDDD`, HOUR); // its maker stopped only an hour ago
  await folder(root, `kino-export-p${ALIVE}-EEEEEE`, NO_OWNER_AGE_MS * 3); // still running
  await folder(root, "kino-export-FFFFFF", NO_OWNER_AGE_MS + HOUR); // no owner, a day old
  await folder(root, "kino-dashboard-browser-GGGGGG", NO_OWNER_AGE_MS + HOUR);
  await folder(root, "kino-frames-HHHHHH", DEAD_OWNER_AGE_MS + HOUR); // no owner, not a day old
  await folder(root, "kino-cutout-helper-0123456789abcdef", NO_OWNER_AGE_MS * 3); // a helper kept on purpose
  await folder(root, "other-app-IIIIII", NO_OWNER_AGE_MS * 3);
  await folder(root, `kino-export-p${DEAD}-JJJJJJ`, old, { file: true }); // a file, not a folder
  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), join(root, `kino-export-p${DEAD}-KKKKKK`));

  const result = await sweepTempFolders({ root, isAlive });
  assert.deepEqual(result.removed, [`kino-batch-download-p${DEAD}-CCCCCC`, "kino-dashboard-browser-GGGGGG",
    "kino-export-FFFFFF", `kino-export-p${DEAD}-AAAAAA`, `kino-frames-p${DEAD}-BBBBBB`]);
  assert.ok(result.bytes >= 5 * 1000, `${result.bytes} bytes counted`);
  assert.deepEqual((await readdir(root)).sort(), ["elsewhere", "kino-cutout-helper-0123456789abcdef",
    `kino-export-p${DEAD}-JJJJJJ`, `kino-export-p${DEAD}-KKKKKK`, `kino-export-p${ALIVE}-EEEEEE`,
    "kino-frames-HHHHHH", `kino-mix-p${DEAD}-DDDDDD`, "other-app-IIIIII"]);
  assert.match(sweepSummary(result), /^kino removed 5 leftover temporary folders \(0\.0 MB\)\.$/);
  assert.equal(sweepSummary(await sweepTempFolders({ root, isAlive })), null, "nothing left to remove");
  assert.deepEqual(await sweepTempFolders({ root: join(root, "missing") }), { removed: [], bytes: 0 });
});

test("the sweep keeps a folder of this running process however old", async (t) => {
  const root = await fakeTemp(t);
  await folder(root, `kino-export-p${process.pid}-AAAAAA`, NO_OWNER_AGE_MS * 2);
  assert.deepEqual((await sweepTempFolders({ root })).removed, []);
});

test("a failed export removes its temporary folder", async (t) => {
  const root = await fakeTemp(t);
  const frames = join(root, "frames");
  await mkdir(frames);
  const fonts = await loadBundledFonts();
  let during = [];
  await withTemp(root, () => assert.rejects(exportScene(scene(), { format: "png-sequence", fps: 4 }, {
    fonts, sequenceDirectory: frames,
    onProgress: (event) => {
      if (event.stage !== "render") return;
      during = readdirSync(root).filter((name) => name.startsWith("kino-"));
      throw new Error("the disk is full");
    },
  }), /the disk is full/));
  assert.equal(during.length, 1, "the export made its folder in the fake temp folder");
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("kino-")), []);
});

test("a cancelled export and a cancelled frame check remove their temporary folders", async (t) => {
  const root = await fakeTemp(t);
  const frames = join(root, "frames");
  await mkdir(frames);
  const fonts = await loadBundledFonts();
  const controller = new AbortController();
  await withTemp(root, () => assert.rejects(exportScene(scene(), { format: "png-sequence", fps: 4 }, {
    fonts, sequenceDirectory: frames, signal: controller.signal,
    onProgress: (event) => { if (event.stage === "render") controller.abort(); },
  }), { name: "AbortError" }));
  const stopped = new AbortController();
  stopped.abort();
  await withTemp(root, () => assert.rejects(renderSceneFrames(scene(), [0, 0.5], { fonts, signal: stopped.signal })));
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("kino-")), []);
});

test("the server sweeps the temp folder when it starts and says what it removed", async (t) => {
  const root = await fakeTemp(t);
  // macOS and Linux pids stay below 999001, so this maker has stopped.
  await folder(root, `kino-export-p${DEAD}-AAAAAA`, DEAD_OWNER_AGE_MS + HOUR);
  await folder(root, "kino-frames-BBBBBB", HOUR);
  const server = await startTestServer({ env: { TMPDIR: root } });
  t.after(() => server.stop());
  let names = await readdir(root);
  for (const until = Date.now() + 10_000; names.includes(`kino-export-p${DEAD}-AAAAAA`) && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    names = await readdir(root);
  }
  assert.deepEqual(names, ["kino-frames-BBBBBB"]);
  for (const until = Date.now() + 5000; !server.output().includes("leftover") && Date.now() < until;)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(server.output(), /kino removed 1 leftover temporary folder \(0\.0 MB\)\./);
});
