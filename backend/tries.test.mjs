// Try rounds (agent/tries.mjs): the agent's question is read and checked, each option's clip is
// rendered from the video with the option's ops, and the person's pick reaches the agent's inbox
// with the ops to apply.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { answerText, readTry } from "./agent/tries.mjs";
import { skipWithoutMediaTools as skip, startTestServer } from "./media.test.support.mjs";

const SCENES = [{ id: "s1", name: "Scene 1", duration: 8.8 }];
const OPTIONS = [{ name: "plain cut", ops: [] }, { name: "half faded", ops: [{ op: "update_layer", layer: "footage", properties: { opacity: 0.5 } }] }];

test("readTry: the moment and its 2 s, 2 to 4 named options, and each refusal in words", () => {
  const read = readTry({ question: "which cut into shot 2?", at: 1.25, options: OPTIONS, later: ["color", "sound"] }, SCENES);
  assert.deepEqual([read.question, read.topic, read.sceneId, read.at, read.from, read.to, read.options.map((option) => option.letter), read.later],
    ["which cut into shot 2?", "which cut into shot 2", "s1", 1.25, 0.25, 2.25, ["A", "B"], ["color", "sound"]]);
  assert.deepEqual([readTry({ question: "q", at: 0.2, options: OPTIONS }, SCENES).from, readTry({ question: "q", at: 8.7, options: OPTIONS }, SCENES).to], [0, 8.8], "kept inside the scene");
  for (const [input, words] of [
    [{ at: 1, options: OPTIONS }, /needs question/],
    [{ question: "q", at: 9, options: OPTIONS }, /at is the moment in seconds, 0 to 8.8/],
    [{ question: "q", at: 1, options: [OPTIONS[0]] }, /2 to 4 options/],
    [{ question: "q", at: 1, options: [OPTIONS[0], { name: "Plain cut", ops: [] }] }, /its own name/],
    [{ question: "q", at: 1, options: [OPTIONS[0], { ops: [] }] }, /options\[1\] needs a name/],
    [{ question: "q", at: 1, scene: "s9", options: OPTIONS }, /scene "s9" is not in this project/],
  ]) assert.throws(() => readTry(input, SCENES), words);
});

test("answerText: a pick names the option and the ops to apply; none and skip say what to do next", () => {
  const round = { id: "T2", question: "which cut into shot 2?", options: readTry({ question: "q", at: 1, options: OPTIONS }, SCENES).options };
  assert.equal(answerText({ ...round, pick: "B", words: "softer" }),
    'try T2 "which cut into shot 2?": the person picked B (half faded) (their note: "softer"). Apply it: edit {"ops":[{"op":"update_layer","layer":"footage","properties":{"opacity":0.5}}]} Then the next round starts from it.');
  assert.match(answerText({ ...round, pick: "A" }), /picked A \(plain cut\)\. It keeps the video as it is\./);
  assert.match(answerText({ ...round, pick: "none" }), /liked none of these\. Try other options/);
  assert.match(answerText({ ...round, pick: "skip" }), /skipped it\. Keep the video as it is/);
});

let server;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
before(async () => { if (!skip) server = await startTestServer(); });
after(async () => { await server?.stop(); });
const agent = async (verb, body) => (await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "test-agent", ...body } })).json();

test("a try round: the agent asks, kino renders each option's 2 s, the person picks on the dashboard and the agent hears it", { skip, timeout: 120_000 }, async () => {
  const uploaded = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "sintel-village-dragon.mp4" },
    body: await readFile(path.join(root, "tests", "fixtures", "footage", "sintel-village-dragon.mp4")) });
  const { src } = await uploaded.json();
  const id = "try-round";
  assert.equal((await agent("project", { action: "create", id, name: id, width: 540, height: 960, duration: 4 })).isError, undefined);
  assert.equal((await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src } }] })).isError, undefined);
  const refused = await agent("notes", { project: id, action: "try", question: "q", at: 1, options: [OPTIONS[0], { name: "bad", ops: [{ op: "update_layer", layer: "nothing here", properties: { opacity: 0.5 } }] }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /option B \(bad\) was refused/);
  const started = await agent("notes", { project: id, action: "try", question: "which look for shot 1?", at: 1, options: OPTIONS, later: ["color"] });
  assert.equal(started.isError, undefined, started.text);
  assert.deepEqual([started.data.id, started.data.status, started.data.options], ["T1", "rendering", ["A", "B"]]);
  // The clips render one after another; the dashboard sees the round wait once both are ready.
  let view;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 300))) {
    view = (await (await server.api(`/api/dashboard/snapshot?project=${id}`)).json()).agent.tries;
    if (view.rounds[0]?.status !== "rendering") break;
  }
  assert.deepEqual([view.rounds[0].status, view.rounds[0].options.map((option) => [option.letter, option.ready]), view.later], ["waiting", [["A", true], ["B", true]], ["color"]]);
  const clip = await server.api(`/api/dashboard/try/${id}/T1-B.mp4`);
  assert.deepEqual([clip.status, clip.headers.get("content-type")], [200, "video/mp4"]);
  const file = path.join(server.dataDirectory, "clip.mp4");
  await import("node:fs/promises").then(({ writeFile }) => clip.arrayBuffer().then((bytes) => writeFile(file, Buffer.from(bytes))));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,nb_frames,codec_type", "-of", "json", file]).toString());
  assert.deepEqual(probe.streams.map((stream) => [stream.codec_type, stream.width, stream.height, Number(stream.nb_frames)]), [["video", 540, 960, 60]], "2 s at 30 fps, silent");
  // Only the person picks; the agent hears the pick with the ops to apply.
  assert.match((await agent("notes", { project: id, action: "try", round: "T1", pick: "B" })).text, /Only the person picks/);
  const keyed = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
  const { key } = await keyed.json();
  const picked = await (await server.api("/api/dashboard/act/notes", { method: "POST", headers: { "x-kino-review": key }, body: { project: id, action: "try", round: "T1", pick: "B", note: "softer" } })).json();
  assert.equal(picked.isError, undefined, picked.text);
  const status = await agent("status", { project: id });
  assert.ok(JSON.stringify(status).includes('try T1 \\"which look for shot 1?\\": the person picked B (half faded) (their note: \\"softer\\"). Apply it: edit'), status.text);
});
