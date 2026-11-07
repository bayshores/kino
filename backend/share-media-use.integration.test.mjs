// A sharing link may use the media of its own file. This test covers media that was uploaded
// to another file and then used in the shared file by its owner (for example, an image layer
// pasted from file A into file B). An editor on B's link must be able to remove that layer and
// add it back again (cut and paste, or delete and undo) without the server refusing the save.
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerSecret = "kino-test-owner-secret";
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=",
  "base64",
);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function expectStatus(response, status, reason) {
  if (response.status !== status) assert.equal(response.status, status, `${reason}: ${await response.text()}`);
}

function makeDocument(id) {
  return createDocument({
    id,
    name: id,
    scenes: [createScene({ id: `scene-${id}`, name: "Scene 1", width: 32, height: 18, duration: 0.1, layers: [] })],
  });
}

test("an edit link can remove and re-add an image its owner brought in from another file", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-share-media-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.KINO_PUBLIC_URL;
  Object.assign(env, { MOTION_DATA_DIR: dataDirectory, MOTION_HOST: "127.0.0.1", MOTION_API_PORT: String(port), KINO_OWNER_TOKEN: ownerSecret });
  const child = spawn(process.execPath, ["backend/index.mjs"], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4_000).unref())]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(dataDirectory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The server exited during startup. ${output}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`The server did not start. ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  function api(endpoint, { share, body, headers = {}, ...options } = {}) {
    const all = new Headers(headers);
    if (share) all.set("X-Kino-Share", share);
    else all.set("X-Kino-Owner", ownerSecret);
    if (body !== undefined && !Buffer.isBuffer(body)) {
      all.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }
    return fetch(`${baseUrl}${endpoint}`, { ...options, headers: all, body });
  }
  async function save(projectId, document, share) {
    const current = await api(`/api/projects/${projectId}`, { share }).then((response) => response.json());
    return api(`/api/projects/${projectId}`, { share, method: "PUT", body: { document, revision: current.revision } });
  }
  async function upload(projectId, name) {
    const response = await api(`/api/media?project=${projectId}`, { method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": name }, body: pngBytes });
    await expectStatus(response, 201, `the owner uploads ${name}`);
    return response.json();
  }

  for (const id of ["file-a", "file-b", "file-c"])
    await expectStatus(await api("/api/projects", { method: "POST", body: { document: makeDocument(id) } }), 201, `the owner creates ${id}`);
  const image = await upload("file-a", "sunset.png");
  const unused = await upload("file-a", "private.png");

  // The owner pastes A's image into B.
  const withImage = makeDocument("file-b");
  withImage.scenes[0].layers.push(createLayer("image", { id: "photo", name: "Sunset", src: image.src, width: 4, height: 4 }));
  await expectStatus(await save("file-b", withImage), 200, "the owner saves B with A's image");

  // A record written before this rule existed lists only the file it was uploaded to.
  const recordPath = path.join(dataDirectory, "media", `${image.id}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.deepEqual(record.usedInProjects, ["file-b"], "the owner's save records that B uses the image");
  delete record.usedInProjects;
  await writeFile(recordPath, JSON.stringify(record));

  const editLink = await api("/api/projects/file-b/shares", { method: "POST", body: { role: "edit" } }).then((response) => response.json());
  const otherLink = await api("/api/projects/file-c/shares", { method: "POST", body: { role: "edit" } }).then((response) => response.json());

  // Cut: the editor saves B without the image layer.
  await expectStatus(await save("file-b", makeDocument("file-b"), editLink.token), 200, "the editor saves the cut");
  // Paste checks the image first, then saves it back (Undo saves the same document).
  await expectStatus(await api(image.src, { share: editLink.token, method: "HEAD" }), 200, "B's link may still read the image after the cut");
  await expectStatus(await save("file-b", withImage, editLink.token), 200, "the editor saves the pasted image again");
  const listed = await api("/api/media", { share: editLink.token }).then((response) => response.json());
  assert.deepEqual(listed.media.map((item) => item.id), [image.id], "B's link lists the image B used, and not A's other uploads");

  // Other files and other uploads stay private.
  await expectStatus(await api(unused.src, { share: editLink.token, method: "HEAD" }), 403, "B's link can't read A's other uploads");
  await expectStatus(await api(image.src, { share: otherLink.token, method: "HEAD" }), 403, "C's link can't read the image");
  const intoC = makeDocument("file-c");
  intoC.scenes[0].layers.push(createLayer("image", { id: "photo", name: "Sunset", src: image.src, width: 4, height: 4 }));
  await expectStatus(await save("file-c", intoC, otherLink.token), 403, "C's link can't add the image");
});
