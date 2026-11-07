// Work folders a stopped server leaves in the cut-out and voice caches (leftover-work.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEFTOVER_AGE_MS, removeLeftoverWork } from "./leftover-work.mjs";
import { createVoiceMedia } from "./voice/media.mjs";

async function cache(t, folders) {
  const dir = await mkdtemp(join(tmpdir(), "kino-leftover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, ageMs] of folders) {
    await mkdir(join(dir, name));
    const at = new Date(Date.now() - ageMs);
    await utimes(join(dir, name), at, at);
  }
  return dir;
}

test("only work folders left alone for an hour are removed", async (t) => {
  const dir = await cache(t, [[".work-old", LEFTOVER_AGE_MS + 60_000], [".media-old", LEFTOVER_AGE_MS + 60_000],
    [".work-running", 5_000], ["stem-folder", LEFTOVER_AGE_MS * 3]]);
  assert.deepEqual(await removeLeftoverWork(dir), [".media-old", ".work-old"]);
  assert.deepEqual((await readdir(dir)).sort(), [".work-running", "stem-folder"]);
  assert.deepEqual(await removeLeftoverWork(join(dir, "missing")), [], "a cache not made yet is fine");
});

test("the voice cache is swept when the server starts", async (t) => {
  const dir = await cache(t, [[".work-old", LEFTOVER_AGE_MS * 2], [".media-old", LEFTOVER_AGE_MS * 2], [".media-new", 0]]);
  createVoiceMedia({ mediaRoot: join(dir, "media"), cacheDir: dir, modelDir: join(dir, "models"), addMedia: () => { throw new Error("nothing is made here"); }, download: false });
  let names = await readdir(dir);
  for (const until = Date.now() + 5000; names.length > 1 && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    names = await readdir(dir);
  }
  assert.deepEqual(names, [".media-new"]);
});
