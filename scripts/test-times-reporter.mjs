// A Node test reporter that writes how long each test file took, in seconds, as JSON:
// {"backend/http.test.mjs": 12.3, ...}. scripts/run-tests.mjs adds it when KINO_TEST_TIMES is set.
// Node reports each file as a top-level test whose name is the path it was given.
import path from "node:path";

export default async function* testTimes(source) {
  const times = {};
  for await (const event of source) {
    const { name, file, nesting, details } = event.data ?? {};
    if (event.type !== "test:complete" || nesting !== 0 || !file || !details) continue;
    if (path.resolve(name) !== file) continue;
    times[path.relative(process.cwd(), file).split(path.sep).join("/")] = Math.round(details.duration_ms / 100) / 10;
  }
  yield `${JSON.stringify(times)}\n`;
}
