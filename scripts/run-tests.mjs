// `npm test`: runs the test files with Node's test runner, one file at a time per group.
//
//   npm test                          every test file (including the golden frames), in groups side by side
//   KINO_TEST_JOBS=1 npm test         every test file, one group (one file at a time)
//   npm test -- backend/crew.test.mjs only the files named
//   npm test -- --changed             only the tests related to this branch's changes (scripts/related-tests.mjs);
//                                     12 or more of them run in groups side by side too
//   npm test -- --test-name-pattern=x other options go to `node --test`
//   TEST_SHARD=2/8 npm test           only machine 2 of 8's share (CI); see scripts/test-times.mjs
//   KINO_TEST_TIMES=out.json npm test also write each file's time (seconds) to out.json
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { ROOT, listTestFiles, parseShard, readTimes, splitFiles, writeTimes } from "./test-times.mjs";
import { changedFiles, relatedTests } from "./related-tests.mjs";

const extra = process.argv.slice(2).filter((arg) => arg !== "--changed");
const changedOnly = extra.length < process.argv.length - 2;
let named = extra.filter((arg) => !arg.startsWith("-"));
const options = extra.filter((arg) => arg.startsWith("-"));
if (changedOnly) {
  named = relatedTests(changedFiles());
  if (!named.length) {
    console.log("No test file is related to the changed files.");
    process.exit(0);
  }
  console.log(`${named.length} test files related to the change:\n  ${named.join("\n  ")}`);
}
for (const file of named) {
  if (!existsSync(path.resolve(ROOT, file))) {
    console.error(`No test file ${file}. Write options for node --test as --name=value.`);
    process.exit(2);
  }
}
let files = named.length ? named : listTestFiles();
if (!files.length) {
  console.error("No test files found.");
  process.exit(1);
}

if (process.env.TEST_SHARD) {
  let shard;
  try {
    shard = parseShard(process.env.TEST_SHARD);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const { index, count } = shard;
  const groups = splitFiles(files, readTimes(), count);
  files = groups[index - 1].files;
  console.log(`Machine ${index} of ${count}: ${files.length} files, about ${Math.round(groups[index - 1].seconds)} s by tests/test-times.json.`);
}
// A machine with no share of the files has nothing to run.
if (!files.length) process.exit(0);

const timesOut = process.env.KINO_TEST_TIMES ? path.resolve(process.env.KINO_TEST_TIMES) : null;
const scratch = timesOut ? mkdtempSync(path.join(tmpdir(), "kino-test-times-")) : null;
const reporters = timesOut
  ? ["--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=./scripts/test-times-reporter.mjs", `--test-reporter-destination=${path.join(scratch, "times.json")}`]
  : [];
const args = ["--import", "./scripts/test-fonts.mjs", "--test", "--test-concurrency=1", ...reporters, ...options];

// A whole local run splits the files into groups of about equal time (like CI's machines) and runs
// the groups side by side, each still one file at a time. KINO_TEST_JOBS sets the group count.
// A long --changed list runs the same way, with at least 6 files a group.
const jobs = Number(process.env.KINO_TEST_JOBS) || Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)));
const manyChanged = changedOnly && named.length >= 12;
const wholeRun = !named.length || manyChanged;
if (!timesOut && !process.env.TEST_SHARD && wholeRun && jobs > 1) runGroups(manyChanged ? Math.min(jobs, Math.floor(named.length / 6)) : jobs);
else runOne();

/** Runs the groups side by side; prints each group's output in one piece when it ends. */
function runGroups(count) {
  const groups = splitFiles(files, readTimes(), count).filter((group) => group.files.length);
  const started = Date.now();
  console.log(`${files.length} files in ${groups.length} groups side by side (KINO_TEST_JOBS to change).`);
  let worst = 0;
  let left = groups.length;
  groups.forEach((group, index) => {
    const child = spawn(process.execPath, [...args, ...group.files], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("exit", (code, signal) => {
      const failed = code !== 0 || signal;
      if (failed) worst = 1;
      process.stdout.write(Buffer.concat(output));
      console.log(`Group ${index + 1} of ${groups.length}: ${failed ? "FAILED" : "passed"} in ${Math.round((Date.now() - started) / 1000)} s.`);
      left -= 1;
      // Not process.exit: it can cut off output still on its way down a pipe (the last group's lines).
      if (!left) process.exitCode = worst;
    });
  });
}

function runOne() {
  const child = spawn(process.execPath, [...args, ...files], { cwd: ROOT, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (timesOut) {
      try {
        const measured = readTimes(path.join(scratch, "times.json"));
        writeTimes({ ...readTimes(timesOut), ...measured }, timesOut);
        console.log(`Wrote the times of ${Object.keys(measured).length} files to ${path.relative(ROOT, timesOut) || timesOut}.`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}
