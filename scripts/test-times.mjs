// Test files and their recorded run times, and how CI splits the files across machines.
// tests/test-times.json holds the seconds each file took on CI. `splitFiles` deals the files
// out longest first, each to the machine with the least total time so far, so every machine
// finishes at about the same time. Every machine computes the same split from the same inputs.
//
// Refresh the times from a CI run (each test machine uploads its times):
//   gh run download <run id> -p 'test-times-*' -D .local/test-times
//   node scripts/test-times.mjs .local/test-times/*/test-times.json
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TIMES_FILE = path.join(ROOT, "tests", "test-times.json");

// The files `npm test` runs: engine/*.test.js, engine/effects/*.test.js, frontend/*.test.js,
// backend/*.test.mjs and tests/*.test.mjs, in name order.
const FOLDERS = [["engine", ".test.js"], ["engine/effects", ".test.js"], ["frontend", ".test.js"], ["backend", ".test.mjs"], ["tests", ".test.mjs"]];

export function listTestFiles(root = ROOT) {
  return FOLDERS.flatMap(([folder, ending]) =>
    readdirSync(path.join(root, folder), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(ending))
      .map((entry) => `${folder}/${entry.name}`)
      .sort());
}

export function readTimes(file = TIMES_FILE) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

// Newer times replace older ones; files that no longer exist are dropped.
export function writeTimes(times, file = TIMES_FILE, existing = listTestFiles()) {
  const kept = Object.fromEntries(Object.keys(times).filter((name) => existing.includes(name)).sort().map((name) => [name, times[name]]));
  writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`);
  return kept;
}

// "2/8" → { index: 2, count: 8 }.
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text).trim());
  const index = match && Number(match[1]);
  const count = match && Number(match[2]);
  if (!match || count < 1 || index < 1 || index > count) throw new Error(`TEST_SHARD must look like 2/8 (machine 2 of 8), not "${text}".`);
  return { index, count };
}

// Splits the files into `count` groups of about equal total time. A file with no recorded
// time counts as the median recorded time. Returns the groups, each with its files in name order.
export function splitFiles(files, times, count) {
  const known = files.map((file) => times[file]).filter((seconds) => typeof seconds === "number").sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const timeOf = (file) => (typeof times[file] === "number" ? times[file] : median);
  const groups = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  const longestFirst = [...files].sort((a, b) => timeOf(b) - timeOf(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of longestFirst) {
    const lightest = groups.reduce((best, group) => (group.seconds < best.seconds ? group : best));
    lightest.files.push(file);
    lightest.seconds += timeOf(file);
  }
  for (const group of groups) {
    group.files.sort();
    group.seconds = Math.round(group.seconds * 10) / 10;
  }
  return groups;
}

// `node scripts/test-times.mjs <times.json>...` merges the given files into tests/test-times.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    console.error("Usage: node scripts/test-times.mjs <times.json>...");
    process.exit(2);
  }
  const merged = inputs.reduce((times, file) => ({ ...times, ...readTimes(file) }), readTimes());
  const kept = writeTimes(merged);
  console.log(`tests/test-times.json: ${Object.keys(kept).length} files.`);
}
