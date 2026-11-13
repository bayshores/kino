// Every op's example (backend/agent/op-examples.mjs) runs as written through the agent service on
// a real server. These examples are what a refused op sends back as `example`, what library
// {topic:"op"} shows, and what skills/kino/references/fields.md prints, so an agent can copy
// any of them. Each runs as a dry run after its setup ops, on the same small project.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { AGENT_OPERATION_TYPES } from "./agent/translate.mjs";
import { EXAMPLE_PROJECT, OP_EXAMPLES, exampleFor, signatureFor } from "./agent/op-examples.mjs";
import { ffmpeg, hasMediaTools, run, startTestServer } from "./media.test.support.mjs";

let server;
let folder;
before(async () => {
  server = await startTestServer();
  folder = await mkdtemp(path.join(tmpdir(), "kino-op-examples-"));
});
after(async () => {
  await server?.stop();
  await rm(folder, { recursive: true, force: true });
});

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

// Made-up media (FFmpeg test sources) imported like any file; answers each /api/media src.
async function importMedia() {
  const files = {
    image: ["logo.png", "image/png", ["-f", "lavfi", "-i", "color=c=orange:size=64x64", "-frames:v", "1"]],
    music: ["music.m4a", "audio/mp4", ["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=6", "-c:a", "aac", "-b:a", "128k"]],
    voice: ["voice.m4a", "audio/mp4", ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=44100:duration=2", "-c:a", "aac", "-b:a", "128k"]],
    video: ["interview.mp4", "video/mp4", ["-f", "lavfi", "-i", "testsrc2=size=96x64:rate=15:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]],
  };
  const sources = {};
  for (const [kind, [name, type, args]] of Object.entries(files)) {
    const file = path.join(folder, name);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
    const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": type, "x-file-name": name }, body: await readFile(file) });
    assert.equal(upload.status, 201, await upload.clone().text());
    const media = await upload.json();
    sources[kind] = media.src ?? media.media?.src;
  }
  return sources;
}

// The placeholders /api/media/<music>.m4a and <image>.png, replaced with imported files.
function withMedia(ops, sources) {
  let text = JSON.stringify(ops);
  for (const [kind, src] of Object.entries(sources)) {
    text = text.replace(new RegExp(`/api/media/<${kind}>\\.[a-z0-9]+`, "g"), src);
    text = text.replace(new RegExp(`<${kind}>\\.[a-z0-9]+`, "g"), src.replace(/^\/api\/media\//, ""));
  }
  return JSON.parse(text);
}

test("every edit op has one example and a short field line", () => {
  assert.deepEqual(Object.keys(OP_EXAMPLES).sort(), [...AGENT_OPERATION_TYPES].sort());
  for (const type of AGENT_OPERATION_TYPES) {
    assert.equal(exampleFor(type).op, type, `${type}'s example is a ${type} op`);
    assert.match(signatureFor(type), new RegExp(`^${type} \\{`), `${type} has a field line`);
    assert.ok(JSON.stringify(exampleFor(type)).length < 400, `${type}'s example is short`);
  }
  assert.equal(exampleFor("update_layer", "logo").layer, "logo", "the layer the agent named takes the example's place");
});

// A new example project; answers the edit's receipt.
async function exampleProject(project) {
  await agent("project", { action: "create", id: project, name: "Examples", width: EXAMPLE_PROJECT.width, height: EXAMPLE_PROJECT.height, duration: EXAMPLE_PROJECT.duration, background: "#0b1020" });
  const made = await agent("edit", { project, ops: EXAMPLE_PROJECT.ops });
  assert.equal(made.isError, undefined, made.text);
  return made;
}

test("every op example runs as written on the example project", { timeout: 300_000 }, async () => {
  const project = "op-examples";
  const made = await exampleProject(project);
  assert.deepEqual(Object.keys(made.data.created).sort(), ["card", "card.in", "title", "title.in", "title.out"]);
  // apply_easing, apply_text_effect and use_piece use an easing, a text effect and a piece saved in the workspace.
  const manage = async (resource, options) => {
    const reply = await agent("project", { action: "manage", id: project, options: { resource, action: "save", ...options } });
    assert.equal(reply.isError, undefined, reply.text);
  };
  await manage("easings", { name: "Snappy", easing: [0.2, 0, 0, 1] });
  await manage("effects", { name: "Pop words", sourceAnimation: made.data.created["title.in"] });
  await manage("pieces", { name: "Lower third", layers: ["card"] });

  const sources = hasMediaTools ? await importMedia() : {};
  const failures = [];
  // The other examples library shows ("Effect: {…}") run the same way.
  const extra = Object.entries(OP_EXAMPLES).flatMap(([type, entry]) => (entry.more ?? []).map((more, index) => [`${type}-${more.label.toLowerCase()}-${index}`, more]));
  assert.ok(extra.length >= 1, "update_animation has an effect example");
  for (const [type, entry] of [...Object.entries(OP_EXAMPLES), ...extra]) {
    // isolate_voice is the SKILL example that agent-voice.test.mjs runs on a video, and cut_out
    // needs Apple Vision: agent-cutout.test.mjs runs its example on a clip with a subject;
    // cut_speech and place_broll need whisper-cli: agent-speech.test.mjs runs them with a stand-in whisper-cli.
    // fit_music needs a song with a beat and a drop: agent-volume.test.mjs runs it on one.
    // track, pin and stabilize need the helper: agent-cutout.test.mjs runs them with its stand-in.
    if (type === "track" || type === "pin" || type === "stabilize" || type === "isolate_voice" || type === "cut_out" || type === "cut_speech" || type === "place_broll" || type === "fit_music") continue;
    if (entry.media && !hasMediaTools) continue;
    // A setup that names something only once saved (an animation group) is saved first, in a
    // project of its own.
    let target = project;
    if (entry.saveSetup) {
      target = `op-examples-${type.replaceAll("_", "-")}`;
      await exampleProject(target);
      const setup = await agent("edit", { project: target, ops: entry.setup });
      assert.equal(setup.isError, undefined, setup.text);
    }
    const ops = withMedia([...(entry.saveSetup ? [] : entry.setup ?? []), entry.op], sources);
    const reply = await agent("edit", { project: target, ops, dry_run: true });
    if (reply.isError) failures.push(`${type}: ${reply.text}`);
    else if (reply.data.fixed) failures.push(`${type}: kino had to fix it: ${reply.data.fixed.join("; ")}`);
  }
  assert.deepEqual(failures, []);
});
