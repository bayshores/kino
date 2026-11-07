import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { releasedMediaRecord } from "./project-media-retention.mjs";
import { createMediaRecordReader, writeMediaRecord } from "./media-records.mjs";

test("deleting a media owner transfers retention to copies and other surviving files, including Trash", () => {
  const entry = { id: "a.png", projectId: "original", usedInProjects: ["copy", "original", "removed"], name: "Photo" };
  const projects = [{ id: "copy", mediaIds: [] }, { id: "trashed", mediaIds: ["a.png"] }];
  const result = releasedMediaRecord(entry, "original", projects, new Set(["a.png"]));
  assert.equal(result.deleteFile, false);
  assert.equal(result.record.projectId, undefined);
  assert.deepEqual(result.record.usedInProjects, ["copy", "trashed"]);
  assert.equal(entry.projectId, "original", "the planner does not mutate loaded metadata");
  assert.equal(releasedMediaRecord(result.record, "copy", [{ id: "trashed", mediaIds: ["a.png"] }], new Set()).deleteFile, false);
  assert.equal(releasedMediaRecord(result.record, "copy", [], new Set()).deleteFile, true);
});

test("only media associated with the removed file can be collected, and current references win over old metadata", () => {
  assert.equal(releasedMediaRecord({ id: "library.png" }, "deleted", [], new Set()), null);
  const result = releasedMediaRecord({ id: "a.png", projectId: "deleted" }, "deleted", [{ id: "survivor", mediaIds: ["a.png"] }], new Set());
  assert.deepEqual(result.record.usedInProjects, ["survivor"]);
  assert.equal(result.deleteFile, false);
  assert.equal(releasedMediaRecord({ id: "a.png" }, "deleted", [], new Set(["a.png"])).deleteFile, true);
});

test("a media record is written whole, and an unreadable one is skipped (named once) instead of failing the listing", async (t) => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-media-records-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  await writeMediaRecord(mediaRoot, "a.png", { id: "a.png", mime: "image/png" });
  await writeFile(path.join(mediaRoot, "b.png.json"), ""); // cut short by a crash
  assert.deepEqual((await readdir(mediaRoot)).sort(), ["a.png.json", "b.png.json"]);
  const warnings = [];
  const read = createMediaRecordReader(mediaRoot, { warn: (line) => warnings.push(line) });
  assert.deepEqual(await read(), [{ id: "a.png", mime: "image/png" }]);
  assert.deepEqual(await read(), [{ id: "a.png", mime: "image/png" }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /b\.png\.json/);
});
