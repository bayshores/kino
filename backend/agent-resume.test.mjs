// Continue (agent/resume.mjs) with a stub `claude` that records how it was started. The real
// claude command is never run: KINO_CLAUDE names the stub (or a missing file) and HOME is temporary.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentStateStore } from "./agent/state.mjs";
import { appSession, createResumer, readAppHeader, appHeader } from "./agent/resume.mjs";
import { startTestServer } from "./media.test.support.mjs";

const SESSION = "0b7c2a4e-1111-4222-8333-944455556666";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "kino-resume-"));
  const stub = path.join(root, "claude");
  // mode "wait" keeps it running until "finish" appears, then it says its last words; otherwise
  // it records its arguments and folder and ends.
  await writeFile(stub, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(path.join(root, "called.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), agent: process.env.KINO_AGENT_SESSION }));\nif (fs.existsSync(${JSON.stringify(path.join(root, "wait"))})) setInterval(() => { if (fs.existsSync(${JSON.stringify(path.join(root, "finish"))})) { console.log("All done.\\n\\n**What** should the title say?"); process.exit(0); } }, 20);\n`);
  await chmod(stub, 0o755);
  const agentState = createAgentStateStore(path.join(root, "data"));
  const events = [];
  const make = (claude, chatOpen = () => false) => createResumer({ agentState, directory: path.join(root, "data", "agent", "resume"), publish: (event) => events.push(event),
    projectName: async () => "Promo", env: { PATH: root, HOME: path.join(root, "home"), KINO_CLAUDE: claude }, chatOpen });
  return { root, stub, events, make, folder: await realpath(root) };
}

const until = async (check) => { for (let tries = 0; tries < 200 && !(await check()); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };

test("Continue runs claude --resume in the session's folder with only kino's tools allowed, and stops it", async () => {
  const { root, stub, make, folder } = await setup();
  try {
    const session = appSession({ CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: folder }, "/elsewhere");
    assert.deepEqual(readAppHeader(appHeader(session)), { app: "claude-code", session: SESSION, folder, pid: process.pid });
    assert.equal(appSession({}, folder), null, "no session id, no Continue");
    const resumer = make(stub);
    await resumer.remember("p1", session, "agent-42");
    assert.equal((await resumer.view("p1")).possible, true);
    assert.equal((await resumer.start("p1")).run.state, "starting");
    await until(async () => (await resumer.view("p1")).run.state !== "starting");
    const called = JSON.parse(await readFile(path.join(root, "called.json"), "utf8"));
    assert.deepEqual(called.args, ["-p", 'Continue the kino project "Promo" (p1): call kino status first.', "--resume", SESSION, "--allowedTools", "mcp__kino,mcp__plugin_kino_kino"]);
    assert.equal(called.cwd, folder);
    assert.equal(called.agent, "agent-42", "the continued chat keeps its agent's kino session");
    const ended = (await resumer.view("p1")).run;
    assert.equal(ended.state, "ended");
    assert.equal(ended.called, false, "it ended before it reached kino");

    // A run that calls kino is running; Stop ends its process group.
    await writeFile(path.join(root, "wait"), "");
    await resumer.start("p1");
    await resumer.remember("p1", session, "agent-42");
    assert.equal((await resumer.view("p1")).run.state, "running");
    const stopped = await resumer.stop("p1");
    assert.equal(stopped.run.state, "ended");
    assert.equal(stopped.run.stopped, true);

    // A chat that is still open is continued as a copy with a new id (never written to from two
    // places); what the agent says at the end is kept as the run's reply.
    const open = make(stub, () => true);
    await open.start("p1");
    let copy = [];
    await until(async () => (copy = JSON.parse(await readFile(path.join(root, "called.json"), "utf8")).args).includes("--fork-session"));
    const id = copy[copy.indexOf("--session-id") + 1];
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.deepEqual(copy.slice(2), ["--resume", SESSION, "--fork-session", "--session-id", id, "--allowedTools", "mcp__kino,mcp__plugin_kino_kino"]);
    await open.remember("p1", { ...session, session: id }, "agent-42");
    await writeFile(path.join(root, "finish"), "");
    await until(async () => (await open.view("p1")).run.state === "ended");
    assert.equal((await open.view("p1")).run.reply, "All done.\n\nWhat should the title say?");
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

test("Continue from the dashboard on a real server: the stand-in agent starts, calls kino as the same agent, and its last words come back", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "kino-resume-server-")));
  const stub = path.join(root, "claude");
  const server = await startTestServer({ env: { KINO_CLAUDE: stub } });
  try {
    // The stand-in for `claude -p --resume`: one status call, as the chat's kino MCP server sends it
    // (its kino session from the environment, the chat in x-kino-app), then its last words.
    await writeFile(stub, `#!${process.execPath}
const session = process.argv[process.argv.indexOf("--resume") + 1];
const app = encodeURIComponent(JSON.stringify({ app: "claude-code", session, folder: process.cwd(), pid: process.pid }));
fetch(${JSON.stringify(`${server.baseUrl}/api/agent/status`)}, { method: "POST", headers: { "content-type": "application/json", "x-kino-owner": ${JSON.stringify(server.ownerToken)}, "x-kino-session": process.env.KINO_AGENT_SESSION || "agent-new", "x-kino-app": app }, body: JSON.stringify({ project: "resume", client: "claude-code" }) })
  .then(() => console.log("Done.\\n\\nWhich font do you want?"));
`);
    await chmod(stub, 0o755);
    // The chat that worked on the project first; its kino MCP server (pid) is gone, so the chat is closed.
    const chat = { "x-kino-session": "agent-77", "x-kino-app": appHeader({ app: "claude-code", session: SESSION, folder: root, pid: 2147483646 }) };
    const made = await server.api("/api/agent/project", { method: "POST", headers: chat, body: { action: "create", id: "resume", name: "Resume", width: 640, height: 360, duration: 2, client: "claude-code" } });
    assert.equal(made.status, 200, await made.clone().text());
    // The chat is recorded with a call about a project that exists (the create call made it).
    await server.api("/api/agent/status", { method: "POST", headers: chat, body: { project: "resume", client: "claude-code" } });
    const snapshot = async () => (await server.api("/api/dashboard/snapshot?project=resume")).json();
    await until(async () => (await snapshot()).resume?.possible);
    assert.equal((await server.api("/api/dashboard/resume", { method: "POST", body: { project: "resume" } })).status, 403, "only the dashboard window starts an agent");
    const key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
    const started = await server.api("/api/dashboard/resume", { method: "POST", headers: { "x-kino-review": key }, body: { project: "resume" } });
    assert.equal(started.status, 200, await started.clone().text());
    let shown;
    await until(async () => (shown = await snapshot()).resume?.run?.state === "ended");
    assert.deepEqual([shown.resume.run.called, shown.resume.run.reply], [true, "Done.\n\nWhich font do you want?"]);
    assert.deepEqual(shown.agents.map((agent) => agent.id).length, 1, "the continued chat is the same agent, not a second one");
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
