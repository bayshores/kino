import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runExportProcess } from "./export-process.mjs";

test("export subprocess returns output and preserves encoder failure diagnostics", async () => {
  assert.equal(await runExportProcess(process.execPath, ["-e", "process.stdout.write('ready')"]), "ready");
  await assert.rejects(runExportProcess(process.execPath, ["-e", "process.stderr.write('encoder problem');process.exit(2)"]), /exit code 2: encoder problem/);
});

test("canceling an encoder that ignores SIGTERM still reaps it before rejecting", { timeout: 6000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-export-cancel-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "started"), controller = new AbortController();
  const script = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},100);";
  const completion = assert.rejects(runExportProcess(process.execPath, ["-e", script, marker], controller.signal), { name: "AbortError" });
  let pid;
  const deadline = Date.now() + 3000;
  while (!pid && Date.now() < deadline) {
    try { pid = Number(await readFile(marker, "utf8")); } catch { await delay(10); }
  }
  assert.ok(pid, "encoder reached its explicit ready barrier");
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  controller.abort();
  await completion;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "process is gone when cancellation completes");
});
