import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { archivePngSequence } from "./png-sequence.mjs";

const hasUnzip = spawnSync("unzip", ["-v"], { encoding: "utf8" }).status === 0;

function unzip(args) {
  const result = spawnSync("unzip", args, { encoding: null });
  if (result.error) throw result.error;
  return result;
}

test("writes an ordered, independently readable classic ZIP of PNG frames", { skip: !hasUnzip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-png-sequence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = join(root, "frames");
  const output = join(root, "sequence.zip");
  await mkdir(frames);
  const contents = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255]),
  ];
  for (const [index, bytes] of contents.entries()) {
    await writeFile(join(frames, `frame-${String(index).padStart(6, "0")}.png`), bytes);
  }

  const result = await archivePngSequence(frames, contents.length, output);
  assert.equal(result.frameCount, contents.length);
  assert.equal((await stat(output)).size, result.size);
  const checked = unzip(["-t", output]);
  assert.equal(checked.status, 0, checked.stderr.toString());

  const names = unzip(["-Z1", output]);
  assert.equal(names.status, 0, names.stderr.toString());
  assert.deepEqual(names.stdout.toString("utf8").trim().split("\n"), [
    "frame-000000.png",
    "frame-000001.png",
    "frame-000002.png",
  ]);
  for (const [index, expected] of contents.entries()) {
    const frame = unzip(["-p", output, `frame-${String(index).padStart(6, "0")}.png`]);
    assert.equal(frame.status, 0, frame.stderr.toString());
    assert.deepEqual(frame.stdout, expected);
  }
});

test("cancelling a sequence removes the partially written archive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-png-sequence-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = join(root, "frames");
  const output = join(root, "sequence.zip");
  await mkdir(frames);
  await writeFile(join(frames, "frame-000000.png"), Buffer.alloc(128 * 1024, 7));
  await writeFile(join(frames, "frame-000001.png"), Buffer.alloc(16 * 1024 * 1024, 9));

  const controller = new AbortController();
  let observedPartialOutput = false;
  const operation = archivePngSequence(frames, 2, output, { signal: controller.signal });
  const cancelAfterWrite = (async () => {
    while (!controller.signal.aborted) {
      const current = await stat(output).catch(() => null);
      if (current?.size > 0) {
        observedPartialOutput = true;
        controller.abort(new Error("test cancellation"));
        return;
      }
      await delay(1);
    }
  })();

  await assert.rejects(operation, { name: "AbortError" });
  await cancelAfterWrite;
  assert.equal(observedPartialOutput, true);
  await assert.rejects(access(output), { code: "ENOENT" });
});

test("rejects unsupported classic ZIP entry counts before creating output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-png-sequence-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "sequence.zip");
  await assert.rejects(
    archivePngSequence(root, 65_536, output),
    /between 1 and 65535/,
  );
  await assert.rejects(access(output), { code: "ENOENT" });
});
