// Milestone A1: agents read the operation guide on demand, in short answers, and exports
// size videos so the encoder accepts them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getOutputSize } from "./export.mjs";
import { describeOperation, guideTopics, OPERATION_TYPES } from "./operation-guide.mjs";
import { estimateTextTokens } from "./meter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the operation guide lists exactly the operations the engine runs", async () => {
  const source = await readFile(path.join(here, "../engine/operations.js"), "utf8");
  const engine = new Set([...source.matchAll(/operation\.type === "([a-z_]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...OPERATION_TYPES].sort(), [...engine].sort());
  const index = describeOperation();
  for (const type of OPERATION_TYPES) assert.match(index, new RegExp(`- ${type} `), `${type} has a signature line`);
});

test("the operation guide describes operations, not controls of the removed manual editor", () => {
  // The editor was removed on 2026-10-18; agents reach every feature through operations, and
  // `look` and the exports show the result.
  const removedControls = [/\b[Ee]ditor\b/, /Design tab/, /Animate tab/, /Timeline's/, /Command-/, /right-click/, /layer list/];
  for (const topic of guideTopics())
    for (const control of removedControls) assert.doesNotMatch(topic.text, control, `${topic.id} names ${control}`);
  assert.match(describeOperation({ topic: "stagger" }), /`look` and every export use the new start times/);
});

test("describe_operation answers by type, topic and search, and suggests close names", () => {
  const stagger = describeOperation({ type: "stagger_animations" });
  assert.match(stagger, /^stagger_animations \{/);
  assert.match(stagger, /## stagger/);
  assert.match(describeOperation({ topic: "easing" }), /Slow down/);
  assert.match(describeOperation({ topic: "enabled" }), /update_animation or update_animations with \{enabled: false\} turns it off/);
  assert.match(describeOperation({ topic: "path-fill-rule" }), /Path layers have fillRule "nonzero" .* or "evenodd".*update_layer/);
  assert.match(describeOperation({ search: "shadowChannels" }), /Topics mentioning "shadowChannels": .*shadow-channels/);
  assert.match(describeOperation({ search: "no-such-words" }), /No topic mentions/);
  assert.throws(() => describeOperation({ type: "add_layr" }), /Did you mean add_layer/);
  assert.throws(() => describeOperation({ topic: "easings" }), /Did you mean easing/);
  // A by-type answer is about 2.5k tokens at most; any answer stays under the 8k-token limit.
  for (const type of OPERATION_TYPES)
    assert.ok(describeOperation({ type }).length <= 9_000, `${type} answer is short`);
  for (const search of ["animation", "layer", "text"])
    assert.ok(estimateTextTokens(describeOperation({ search })) <= 8_000, `search "${search}" stays under 8k tokens`);
});

test("odd video export sizes are rounded down to even instead of failing the encoder", () => {
  const scene = { width: 1001, height: 601 };
  assert.deepEqual(getOutputSize(scene, { format: "mp4", width: 1001 }), { width: 1000, height: 600 });
  assert.deepEqual(getOutputSize(scene, { format: "webm", width: 1001 }), { width: 1000, height: 600 });
  assert.deepEqual(getOutputSize(scene, { format: "gif", width: 1001 }), { width: 1001, height: 601 });
  assert.deepEqual(getOutputSize(scene, { format: "png", width: 1001 }), { width: 1001, height: 601 });
  assert.deepEqual(getOutputSize({ width: 1920, height: 1080 }, { format: "mp4", width: 640, fps: 15 }), { width: 640, height: 360 });
});
