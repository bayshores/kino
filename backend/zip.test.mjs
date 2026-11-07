import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { archiveFiles } from "./zip.mjs";

const hasUnzip = spawnSync("unzip", ["-v"], { encoding: "utf8" }).status === 0;
const hasPythonZipfile =
  spawnSync("python3", ["-c", "import zipfile"], { encoding: "utf8" }).status === 0;

function unzip(args) {
  const result = spawnSync("unzip", args, { encoding: null });
  if (result.error) throw result.error;
  return result;
}

test("archives ordered file types with UTF-8 names and valid CRCs", { skip: !hasPythonZipfile }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-zip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "assets.zip");
  await mkdir(join(source, "video"), { recursive: true });
  await mkdir(join(source, "frames"), { recursive: true });
  await mkdir(join(source, "notes"), { recursive: true });
  const contents = [
    { name: "video/scene.mp4", path: join(source, "video", "scene.mp4"), bytes: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]) },
    { name: "frames/étoile-000001.png", path: join(source, "frames", "frame.png"), bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]) },
    { name: "notes/README.txt", path: join(source, "notes", "README.txt"), bytes: Buffer.from("real archived text\n", "utf8") },
  ];
  for (const entry of contents) await writeFile(entry.path, entry.bytes);

  const result = await archiveFiles(contents, output);
  assert.equal(result.entryCount, contents.length);
  assert.equal((await stat(output)).size, result.size);
  if (hasUnzip) {
    const checked = unzip(["-t", output]);
    assert.equal(checked.status, 0, checked.stderr.toString());
  }
  const inspection = spawnSync(
    "python3",
    [
      "-c",
      "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive:\n assert archive.testzip() is None\n print(json.dumps([{\"name\":item.filename,\"data\":archive.read(item).hex()} for item in archive.infolist()], ensure_ascii=False))",
      output,
    ],
    { encoding: "utf8" },
  );
  assert.equal(inspection.status, 0, inspection.stderr);
  assert.deepEqual(
    JSON.parse(inspection.stdout),
    contents.map(({ name, bytes }) => ({ name, data: bytes.toString("hex") })),
  );
});

test("rejects unsafe ZIP paths and normalized file collisions before output creation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-zip-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.bin");
  await writeFile(source, "source");
  const invalidSets = [
    [{ name: "../escape.txt", path: source }],
    [{ name: "nested/../../escape.txt", path: source }],
    [{ name: "/absolute.txt", path: source }],
    [{ name: "C:/absolute.txt", path: source }],
    [{ name: "nested\\escape.txt", path: source }],
    [{ name: "nested//escape.txt", path: source }],
    [{ name: "same.txt", path: source }, { name: "same.txt", path: source }],
    [{ name: "Frame.png", path: source }, { name: "frame.PNG", path: source }],
    [{ name: "é.txt", path: source }, { name: "e\u0301.txt", path: source }],
    [{ name: "folder", path: source }, { name: "folder/item.txt", path: source }],
    [{ name: "folder/item.txt", path: source }, { name: "folder", path: source }],
  ];
  for (const [index, entries] of invalidSets.entries()) {
    const output = join(root, `invalid-${index}.zip`);
    await assert.rejects(archiveFiles(entries, output));
    await assert.rejects(access(output), { code: "ENOENT" });
  }
});

test("cancelling archive creation removes the partial ZIP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-zip-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first.bin");
  const second = join(root, "second.bin");
  const output = join(root, "cancelled.zip");
  await writeFile(first, Buffer.alloc(128 * 1024, 7));
  await writeFile(second, Buffer.alloc(16 * 1024 * 1024, 9));

  const controller = new AbortController();
  let observedPartialOutput = false;
  const operation = archiveFiles(
    [
      { name: "first.bin", path: first },
      { name: "second.bin", path: second },
    ],
    output,
    { signal: controller.signal },
  );
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

test("preserves a pre-existing output file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-zip-existing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.txt");
  const output = join(root, "existing.zip");
  await writeFile(source, "source");
  await writeFile(output, "keep me");
  await assert.rejects(archiveFiles([{ name: "source.txt", path: source }], output));
  assert.equal(await readFile(output, "utf8"), "keep me");
});
