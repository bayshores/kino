import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("desktop server reports its port and restricts its automatic session to its own origin", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-desktop-test-"));
  const token = randomBytes(32).toString("hex");
  const child = fork(fileURLToPath(new URL("./index.mjs", import.meta.url)), [], {
    execArgv: [],
    env: { PATH: process.env.PATH, MOTION_HOST: "127.0.0.1", MOTION_API_PORT: "0", MOTION_DATA_DIR: directory, KINO_OWNER_TOKEN: token, KINO_DESKTOP: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Desktop renderer did not report readiness.")), 10000);
    child.once("message", (message) => { clearTimeout(timeout); resolve(message); });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Renderer exited (${code}).`)); });
  });
  assert.equal(ready.type, "kino-ready");
  assert.equal(ready.host, "127.0.0.1");
  assert.ok(ready.port > 0);
  const origin = `http://127.0.0.1:${ready.port}`;
  const session = await fetch(`${origin}/api/session`, { method: "POST", headers: { "X-Kino-Owner": token } });
  assert.equal(session.status, 200);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  assert.match(session.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(`${origin}/api/projects`, { headers: { Origin: origin, Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${origin}/api/projects`, { headers: { Origin: origin } })).status, 403);
  const otherPort = ready.port === 4173 ? 4174 : 4173;
  const rejected = await fetch(`${origin}/api/projects`, { method: "POST", headers: { Origin: `http://127.0.0.1:${otherPort}`, Cookie: cookie, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(rejected.status, 403);
  const projects = await (await fetch(`${origin}/api/projects`, { headers: { "X-Kino-Owner": token } })).json();
  assert.deepEqual(projects.projects, [], "cross-origin write did not create a document");
});
