// set_cue {name, layer, media}: the agent pins a cue to a clip's file; the receipt note gives the
// scene time, "cue:x" follows the clip, and a speed-ramped clip is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { applyOperations } from "../engine/operations.js";
import { createBlockRunner, translateBlock } from "./agent/blocks.mjs";
import { createResolver } from "./agent/refs.mjs";
import { cueListText } from "./agent/cue-list.mjs";

const runner = createBlockRunner({ fontsFor: async () => [], listMedia: async () => [], fontCatalog: [], operationContext: {} });
function project(clip = {}) {
  const layer = createLayer("video", { id: "clip", name: "clip", src: "/api/media/clip.mp4", mediaStart: 2, mediaOffset: 3, mediaSourceDuration: 20, ...clip });
  const title = createLayer("text", { id: "title", name: "title", text: "Goal" });
  return parseDocument(createDocument({ scenes: [createScene({ id: "s1", duration: 10, layers: [layer, title] })] }));
}
async function run(document, raw) {
  const work = {};
  const operation = translateBlock(raw, createResolver(document), document);
  return { document: await runner.apply(document, operation, work), notes: work.notes };
}

test("set_cue with layer and media pins the cue; the note gives the scene time; a trim moves it", async () => {
  const { document, notes } = await run(project(), { op: "set_cue", name: "goal", layer: "clip", media: 7 });
  assert.deepEqual(document.cues, [{ name: "goal", time: 6, kind: "marker", layer: "clip", media: 7 }]);
  assert.match(notes.join("\n"), /cue goal at 6 s \(7 s into clip's file\)/);
  const trimmed = parseDocument(applyOperations(document, [{ type: "update_layer", sceneId: "s1", layerId: "clip", properties: { mediaOffset: 4 } }]));
  assert.equal(trimmed.cues[0].time, 5);
  // A time given as "cue:goal" reads the moved cue.
  const after = await run(trimmed, { op: "set_cue", name: "after-goal", at: "cue:goal+0.5" });
  assert.equal(after.document.cues.find((cue) => cue.name === "after-goal").time, 5.5);
});

test("set_cue says when the clip does not show that moment, and refuses bad pins", async () => {
  const { notes } = await run(project(), { op: "set_cue", name: "early", layer: "clip", media: 0 });
  assert.match(notes.join("\n"), /cue early at 0 s .*does not show it, it would be at -1 s/);
  const ramp = { animations: [{ id: "ramp", name: "Speed", kind: "custom", start: 2, duration: 1, easing: "linear", from: { speed: 1 }, to: { speed: 0.25 } }] };
  await assert.rejects(run(project(ramp), { op: "set_cue", name: "goal", layer: "clip", media: 7 }), /Speed animation/);
  await assert.rejects(run(project(), { op: "set_cue", name: "goal", layer: "title", media: 7 }), /needs a video or audio layer/);
  assert.throws(() => translateBlock({ op: "set_cue", name: "goal", layer: "clip", media: 7, at: 2 }, createResolver(project()), project()), /not both/);
  assert.throws(() => translateBlock({ op: "set_cue", name: "goal", media: 7 }, createResolver(project()), project()), /media needs layer/);
});

test("the note and inspect cues name the clip, not its ID, and say when no piece shows the moment", async () => {
  const id = "7e058f58-188e-4137-b5ce-18e1aee05df4";
  const document = project({ id, name: "goal clip" });
  const { document: pinned, notes } = await run(document, { op: "set_cue", name: "goal", layer: "goal clip", media: 7 });
  assert.match(notes.join("\n"), /7 s into goal clip's file\)/);
  assert.equal(pinned.cues[0].layer, id);
  assert.equal(cueListText(pinned, ["cues"]).text, "marker 1: goal 6 (goal clip file 7s)");
  const { document: early } = await run(document, { op: "set_cue", name: "early", layer: "goal clip", media: 0 });
  assert.equal(cueListText(early, ["cues"]).text, "marker 1: early 0 (goal clip file 0s, not shown)");
});
