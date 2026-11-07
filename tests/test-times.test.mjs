// How CI splits the test files across machines (scripts/test-times.mjs), and the reporter that
// records each file's time (scripts/test-times-reporter.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, listTestFiles, parseShard, readTimes, splitFiles, writeTimes } from "../scripts/test-times.mjs";
import { relatedTests } from "../scripts/related-tests.mjs";

// Node marks the processes it runs tests in; a run started from inside one must not inherit that.
function withoutTestContext() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test("every test file lands on exactly one machine, and the machines get about equal time", () => {
  const files = listTestFiles();
  const times = readTimes();
  for (const count of [1, 4, 8]) {
    const groups = splitFiles(files, times, count);
    assert.equal(groups.length, count);
    assert.deepEqual(groups.flatMap((group) => group.files).sort(), [...files].sort());
    const longest = Math.max(...files.map((file) => times[file] ?? 0));
    const total = groups.reduce((sum, group) => sum + group.seconds, 0);
    // Longest-first dealing is never more than one file over an even share.
    for (const group of groups) assert.ok(group.seconds <= total / count + longest + 0.1, `${group.seconds} s on one of ${count}`);
  }
});

test("the split is the same on every machine and puts the slowest files apart", () => {
  const files = ["a.test.mjs", "b.test.mjs", "c.test.mjs", "d.test.mjs", "e.test.mjs", "f.test.mjs"];
  const times = { "a.test.mjs": 100, "b.test.mjs": 90, "c.test.mjs": 10, "d.test.mjs": 5, "f.test.mjs": 1 };
  const groups = splitFiles(files, times, 2);
  assert.deepEqual(splitFiles([...files].reverse(), times, 2), groups);
  assert.deepEqual(groups.map((group) => group.files), [["a.test.mjs", "e.test.mjs"], ["b.test.mjs", "c.test.mjs", "d.test.mjs", "f.test.mjs"]]);
  // e has no time, so it counts as the median recorded time (10 s).
  assert.deepEqual(groups.map((group) => group.seconds), [110, 106]);
  assert.deepEqual(splitFiles(["x.test.mjs"], {}, 3).map((group) => group.files), [["x.test.mjs"], [], []]);
});

test("TEST_SHARD must name one machine of a count", () => {
  assert.deepEqual(parseShard("2/8"), { index: 2, count: 8 });
  for (const bad of ["0/4", "5/4", "1/0", "2", "a/b", ""]) assert.throws(() => parseShard(bad), /TEST_SHARD must look like 2\/8/);
});

test("the recorded times list only test files that exist", () => {
  const files = listTestFiles();
  const times = readTimes();
  assert.ok(Object.keys(times).length > 0, "tests/test-times.json is empty");
  for (const [file, seconds] of Object.entries(times)) {
    assert.ok(files.includes(file), `${file} is not a test file`);
    assert.ok(Number.isFinite(seconds) && seconds >= 0, `${file}: ${seconds}`);
  }
});

test("the runner records each file's time and merges it into the times file", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-test-times-"));
  try {
    // Two tiny test files in a copy of the folder layout the runner expects.
    for (const sub of ["engine/effects", "frontend", "backend", "tests"]) await mkdir(path.join(folder, sub), { recursive: true });
    await writeFile(path.join(folder, "backend", "one.test.mjs"), 'import test from "node:test";\ntest("one", () => {});\n');
    await writeFile(path.join(folder, "tests", "two.test.mjs"), 'import test from "node:test";\ntest("two", () => new Promise((done) => setTimeout(done, 300)));\n');
    assert.deepEqual(listTestFiles(folder), ["backend/one.test.mjs", "tests/two.test.mjs"]);
    const out = path.join(folder, "times.json");
    await writeFile(out, JSON.stringify({ "backend/gone.test.mjs": 9 }));
    const run = spawnSync(process.execPath, [
      "--test", "--test-concurrency=1",
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      `--test-reporter=${path.join(ROOT, "scripts", "test-times-reporter.mjs")}`, `--test-reporter-destination=${path.join(folder, "raw.json")}`,
      "backend/one.test.mjs", "tests/two.test.mjs",
    ], { cwd: folder, encoding: "utf8", env: withoutTestContext() });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const raw = JSON.parse(await readFile(path.join(folder, "raw.json"), "utf8"));
    assert.deepEqual(Object.keys(raw).sort(), ["backend/one.test.mjs", "tests/two.test.mjs"]);
    assert.ok(raw["tests/two.test.mjs"] >= 0.3, JSON.stringify(raw));
    // Merging drops the file that no longer exists.
    const kept = writeTimes({ ...readTimes(out), ...raw }, out, listTestFiles(folder));
    assert.deepEqual(Object.keys(kept), ["backend/one.test.mjs", "tests/two.test.mjs"]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("--changed picks the tests that are changed, named after or directly import a changed file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kino-related-"));
  try {
    await mkdir(path.join(root, "backend"), { recursive: true });
    const files = {
      "backend/crew.test.mjs": "import x from './other.mjs';",
      "backend/crew-save.test.mjs": "",
      "backend/uses.test.mjs": 'import { a } from "../engine/model.js";',
      "backend/far.test.mjs": 'import { b } from "./export.mjs";',
      "backend/edited.test.mjs": "",
    };
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
    const tests = Object.keys(files);
    assert.deepEqual(relatedTests(["backend/crew.mjs", "engine/model.js", "backend/edited.test.mjs"], { root, tests }),
      ["backend/crew.test.mjs", "backend/crew-save.test.mjs", "backend/uses.test.mjs", "backend/edited.test.mjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
