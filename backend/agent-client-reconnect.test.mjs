// QC #19: after the kino app restarted (new port and owner token in its runtime.json), the MCP
// tools answered "kino is not running" while the command line worked, because the MCP client
// read the connection once. connectAgentClient reads the connection file again when a call
// fails or the file changes. Two fake kino servers and a temporary runtime file stand in for
// the app before and after a restart; the real app's file is never touched.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { connectAgentClient } from "./agent/client.mjs";

const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);

// A fake kino: answers every agent verb with its own name, and 403 to any other owner token.
async function fakeKino(name, token) {
  const server = createServer((req, res) => {
    if (req.headers["x-kino-owner"] !== token) { res.writeHead(403); res.end("not the owner"); return; }
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ text: `answered by ${name}` })); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

let folder;
let runtimeFile;
const env = () => ({ KINO_RUNTIME_FILE: runtimeFile });
const writeRuntime = (origin, ownerToken) => writeFile(runtimeFile, JSON.stringify({ version: 1, origin, ownerToken }), { mode: 0o600 });

before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "kino-reconnect-"));
  runtimeFile = path.join(folder, "runtime.json");
});
after(() => rm(folder, { recursive: true, force: true }));

test("after the app restarts on a new port with a new token, the next call reaches the new app without restarting the client", async () => {
  const first = await fakeKino("first", tokenA);
  await writeRuntime(first.origin, tokenA);
  const client = await connectAgentClient(env(), { name: "mcp" });
  assert.equal((await client.call("status")).text, "answered by first");

  // The app quits, and starts again elsewhere with a new token.
  await first.close();
  const second = await fakeKino("second", tokenB);
  await writeRuntime(second.origin, tokenB);
  try {
    assert.equal((await client.call("status")).text, "answered by second");
    assert.equal(client.connection.url, second.origin);
  } finally { await second.close(); }
});

test("a failed call reads the file again even when the change was missed, and says kino is not running only when it is not", async () => {
  const first = await fakeKino("first", tokenA);
  await writeRuntime(first.origin, tokenA);
  const client = await connectAgentClient(env(), { name: "mcp" });
  assert.equal((await client.call("status")).text, "answered by first");
  await first.close();
  // Nothing is running now: the answer says so.
  await assert.rejects(client.call("status"), /kino is not running/);
  const second = await fakeKino("second", tokenB);
  await writeRuntime(second.origin, tokenB);
  try { assert.equal((await client.call("look")).text, "answered by second"); }
  finally { await second.close(); }
});

test("an old token on the same port (403) reconnects with the new token from the file", async () => {
  const server = await fakeKino("app", tokenA);
  await writeRuntime(server.origin, tokenA);
  const client = await connectAgentClient(env(), { name: "mcp" });
  assert.equal((await client.call("status")).text, "answered by app");
  // The same port, a new token: a fake that only takes token B on the old origin's port.
  const port = new URL(server.origin).port;
  await server.close();
  const again = createServer((req, res) => {
    if (req.headers["x-kino-owner"] !== tokenB) { res.writeHead(403); res.end("not the owner"); return; }
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ text: "answered by the restarted app" })); });
  });
  await new Promise((resolve) => again.listen(Number(port), "127.0.0.1", resolve));
  try {
    // The file keeps its size; its new time (or else the 403 itself) makes the client look again.
    await writeRuntime(server.origin, tokenB);
    assert.equal((await client.call("status")).text, "answered by the restarted app");
  } finally { again.closeAllConnections?.(); await new Promise((resolve) => again.close(resolve)); }
});

test("a call that kino took but never answered says the connection closed, not that kino is not running", async () => {
  // A long check once outlived fetch's 300 s wait and was reported as "kino is not running".
  // This fake takes the call, then drops the connection without answering.
  const server = createServer((req, res) => { req.resume(); req.on("end", () => setTimeout(() => req.socket.destroy(), 50)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeRuntime(`http://127.0.0.1:${server.address().port}`, tokenA);
  try {
    const client = await connectAgentClient(env(), { name: "mcp" });
    await assert.rejects(client.call("check", { fix: "auto" }), (error) => /closed before it answered/.test(error.message) && !/not running/.test(error.message));
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});
