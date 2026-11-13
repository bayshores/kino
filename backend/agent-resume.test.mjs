// Continue (agent/resume.mjs) with a stub `claude` that records how it was started. The real
// claude command is never run: KINO_CLAUDE names the stub (or a missing file) and HOME is temporary.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentStateStore } from "./agent/state.mjs";
import { appSession, createResumer, readAppHeader, appHeader } from "./agent/resume.mjs";

const SESSION = "0b7c2a4e-1111-4222-8333-944455556666";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "kino-resume-"));
  const stub = path.join(root, "claude");
  // mode "wait" keeps it running; otherwise it records its arguments and folder and ends.
  await writeFile(stub, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(path.join(root, "called.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nif (fs.existsSync(${JSON.stringify(path.join(root, "wait"))})) setInterval(() => {}, 1000);\n`);
  await chmod(stub, 0o755);
  const agentState = createAgentStateStore(path.join(root, "data"));
  const events = [];
  const make = (claude) => createResumer({ agentState, directory: path.join(root, "data", "agent", "resume"), publish: (event) => events.push(event),
    projectName: async () => "Promo", env: { PATH: root, HOME: path.join(root, "home"), KINO_CLAUDE: claude } });
  return { root, stub, events, make, folder: await realpath(root) };
}

const until = async (check) => { for (let tries = 0; tries < 200 && !(await check()); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };

test("Continue runs claude --resume in the session's folder with only kino's tools allowed, and stops it", async () => {
  const { root, stub, make, folder } = await setup();
  try {
    const session = appSession({ CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: folder }, "/elsewhere");
    assert.deepEqual(readAppHeader(appHeader(session)), { app: "claude-code", session: SESSION, folder });
    assert.equal(appSession({}, folder), null, "no session id, no Continue");
    const resumer = make(stub);
    await resumer.remember("p1", session);
    assert.equal((await resumer.view("p1")).possible, true);
    assert.equal((await resumer.start("p1")).run.state, "starting");
    await until(async () => (await resumer.view("p1")).run.state !== "starting");
    const called = JSON.parse(await readFile(path.join(root, "called.json"), "utf8"));
    assert.deepEqual(called.args, ["-p", 'Continue the kino project "Promo" (p1): call kino status first.', "--resume", SESSION, "--allowedTools", "mcp__kino,mcp__plugin_kino_kino"]);
    assert.equal(called.cwd, folder);
    const ended = (await resumer.view("p1")).run;
    assert.equal(ended.state, "ended");
    assert.equal(ended.called, false, "it ended before it reached kino");

    // A run that calls kino is running; Stop ends its process group.
    await writeFile(path.join(root, "wait"), "");
    await resumer.start("p1");
    await resumer.remember("p1", session);
    assert.equal((await resumer.view("p1")).run.state, "running");
    const stopped = await resumer.stop("p1");
    assert.equal(stopped.run.state, "ended");
    assert.equal(stopped.run.stopped, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Continue is not offered without the command, and fails in plain words if asked", async () => {
  const { root, make, folder } = await setup();
  try {
    const resumer = make(path.join(root, "missing", "claude"));
    await resumer.remember("p1", { app: "claude-code", session: SESSION, folder });
    assert.equal((await resumer.view("p1")).possible, false);
    const run = (await resumer.start("p1")).run;
    assert.equal(run.state, "failed");
    assert.equal(run.error, "The claude command was not found on this computer.");
    // Another agent that kino cannot continue worked here last: Continue is not offered for the old chat.
    await resumer.remember("p2", { app: "claude-code", session: SESSION, folder });
    await resumer.remember("p2", null);
    assert.equal((await make(path.join(root, "claude")).view("p2")).possible, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
