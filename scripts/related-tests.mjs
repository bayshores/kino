// The test files related to a change, for `npm test -- --changed`.
//
// A test file is related to a changed file when it is the changed file, imports it directly, or
// is named after it (backend/crew.mjs -> backend/crew*.test.mjs). Changed means: differs from
// where this branch left main, committed or not, plus new files Git does not ignore yet.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, listTestFiles } from "./test-times.mjs";

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** Repository paths that differ from main (committed on this branch or not) plus untracked files. */
export function changedFiles(root = ROOT) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const base = git("merge-base", "HEAD", "main")[0];
  return [...new Set([...git("diff", "--name-only", base), ...git("ls-files", "--others", "--exclude-standard")])];
}

/** The test files (from `tests`, default every one npm test runs) related to the changed paths. */
export function relatedTests(changed, { root = ROOT, tests = listTestFiles(root) } = {}) {
  const wanted = new Set(changed);
  const stems = changed.map((file) => file.replace(/\.(m?js|jsx|cjs)$/, ""));
  return tests.filter((test) => {
    if (wanted.has(test)) return true;
    if (stems.some((stem) => test.startsWith(`${stem}.`) || test.startsWith(`${stem}-`))) return true;
    const full = path.join(root, test);
    if (!existsSync(full)) return false;
    for (const [, spec] of readFileSync(full, "utf8").matchAll(IMPORT)) {
      if (wanted.has(path.posix.normalize(path.posix.join(path.posix.dirname(test), spec)))) return true;
    }
    return false;
  });
}
