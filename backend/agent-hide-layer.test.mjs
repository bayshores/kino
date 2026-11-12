// Hiding a layer. In one edit `update_layer {opacity:0}` on an overlay with a fade-in that
// ends at opacity 1 left it on screen (the animation's value is drawn over the layer's), the
// receipt said nothing, and library did not show `visible:false`. Now the receipt warns with
// the op to send instead, library op update_layer shows a Hide example, and "enabled" and
// "hidden" suggest visible. Runs on a real server with a temporary data folder.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readImage, startTestServer } from "./media.test.support.mjs";

let server;
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project: "hide", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

const edit = (ops) => agent("edit", { ops });

// How bright the white overlay is in a frame at 2 s: the most of any pixel's darkest channel
// (0-255), which the red bar leaves at 0.
async function brightest() {
  const frame = await agent("look", { mode: "frame", t: 2, width: 160 });
  const picture = await readImage(Buffer.from(frame.images[0].data, "base64"));
  let most = 0;
  for (let y = 0; y < picture.height; y += 4) for (let x = 0; x < picture.width; x += 4) most = Math.max(most, Math.min(...picture.pixel(x, y).slice(0, 3)));
  return most;
}

before(async () => {
  server = await startTestServer();
  await agent("project", { action: "create", id: "hide", name: "Hide", width: 640, height: 360, duration: 4, background: "#000000" });
  // A white overlay at opacity 0.6 whose preset fade-in (0 to 0.5 s) ends at that opacity, and
  // a red bar that slides from x 0 to x 300 in the first second.
  const made = await edit([
    { op: "add_layer", layerType: "rectangle", name: "miasma", properties: { x: 0, y: 0, width: 640, height: 360, fill: "#ffffff", opacity: 0.6 }, animations: [{ preset: "preset-fade", start: 0, duration: 0.5 }] },
    { op: "add_layer", layerType: "rectangle", name: "bar", properties: { x: 0, y: 0, width: 100, height: 50, fill: "#ff0000" } },
    { op: "add_animation", layer: "bar", animation: { kind: "custom", name: "Slide", start: 0, duration: 1, from: { x: 0 }, to: { x: 300 } } },
  ]);
  assert.equal(made.isError, undefined, made.text);
});

test("opacity 0 under a fade-in warns that the fade's value is drawn and gives visible:false", async () => {
  const reply = await edit([{ op: "update_layer", layer: "miasma", properties: { opacity: 0 } }]);
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.warnings, ["miasma opacity 0 does not show: from 0.5 s miasma.in (Fade In) holds opacity 0.6, and an animation's value is drawn over the layer's. "
    + "To hide the layer: {\"op\":\"update_layer\",\"layer\":\"miasma\",\"properties\":{\"visible\":false}} "
    + "Or delete the animation that draws over it: {\"op\":\"delete_animation\",\"animation\":\"miasma.in\"}"]);
  // The receipt's next is that one call.
  assert.equal(JSON.parse(reply.text).next, `edit {"ops":[{"op":"update_layer","layer":"miasma","properties":{"visible":false}}]}`);
  assert.ok(await brightest() > 120, "the overlay still shows");

  // The op the warning gives hides it, with no warning.
  const hidden = await edit([{ op: "update_layer", layer: "miasma", properties: { visible: false } }]);
  assert.equal(hidden.isError, undefined, hidden.text);
  assert.equal(hidden.data.warnings, undefined);
  assert.ok(await brightest() < 10, "nothing shows");
  const shown = await edit([{ op: "update_layer", layer: "miasma", properties: { visible: true, opacity: 0.6 } }]);
  assert.equal(shown.data.warnings, undefined, "opacity 0.6 is what the fade holds");
});

test("another value an animation holds gives the update_animation that changes it, which works", async () => {
  const reply = await edit([{ op: "update_layers", layers: ["bar", "miasma"], properties: { x: 100, opacity: 0.5 } }]);
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.warnings, [
    // A place moves both ends of the slide by the layer's move, so it still goes 300 px to the right.
    "bar x 100 does not show: from 1 s bar.custom (Slide) holds x 300. An animation's x is a place in the scene, so it stays where it was when the layer moves (+100). To move the animation with the layer (by +100): {\"op\":\"update_animation\",\"animation\":\"bar.custom\",\"properties\":{\"from\":{\"x\":100},\"to\":{\"x\":400}}}",
    // A preset keeps its preset: sent again, it works its values out from the layer's opacity.
    "miasma opacity 0.5 does not show: from 0.5 s miasma.in (Fade In) holds opacity 0.6, and an animation's value is drawn over the layer's. A preset sent again works its values out from the layer's, and stays a preset. To change the value it holds: {\"op\":\"update_animation\",\"animation\":\"miasma.in\",\"properties\":{\"preset\":{\"id\":\"fade\"}}}",
  ]);
  const ops = reply.data.warnings.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
  const fixed = await edit(ops);
  assert.equal(fixed.isError, undefined, fixed.text);
  const again = await edit([{ op: "update_layers", layers: ["bar", "miasma"], properties: { x: 120, opacity: 0.5 } }]);
  assert.equal(again.data.warnings.length, 1, "only x 120 moves the layer again");
  assert.match(again.data.warnings[0], /"properties":\{"from":\{"x":120\},"to":\{"x":420\}\}\}$/);
  // A value no animation sets, or a hidden layer, is not warned about.
  const plain = await edit([{ op: "update_layer", layer: "bar", properties: { fill: "#00ff00", y: 20 } }]);
  assert.equal(plain.data.warnings, undefined);
});

// A review of agent edits: a Slide In from below (y 460 -> 400) on a title moved to y 600 was
// suggested as `to: {y: 600}` alone, which slides down from 460 instead of up; and a layer with a
// fade-out was not warned about, though it jumps back to opacity 1 when the fade-out starts.
// A preset slide now moves with its layer in the same edit (engine/presetMove.js), still going up.
test("a moved slide keeps its direction, and an exit that starts from another value is named", async () => {
  const made = await edit([
    { op: "add_layer", layerType: "text", name: "title", properties: { x: 320, y: 120, text: "Hello", fontSize: 40 }, animations: [{ preset: "preset-slide", start: 0, duration: 0.6 }] },
    { op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 0, y: 300, width: 100, height: 40, fill: "#00ff00" },
      animations: [{ preset: "preset-fade", start: 0, duration: 0.5 }, { preset: "fade-out", start: 3, duration: 0.5 }] },
    { op: "add_layer", layerType: "rectangle", name: "tag", properties: { x: 500, y: 300, width: 60, height: 40, fill: "#0000ff" },
      animations: [{ preset: "fade-out", start: 3, duration: 0.5 }] },
  ]);
  assert.equal(made.isError, undefined, made.text);
  const before = await agent("inspect", { targets: ["title"] });
  const [, fromY, toY] = before.text.match(/ y (-?[\d.]+)→(-?[\d.]+) 0s/) ?? assert.fail(before.text);
  assert.ok(Number(fromY) > Number(toY), `the preset slides up: ${before.text}`);

  const reply = await edit([
    { op: "update_layer", layer: "title", properties: { y: 200 } },
    { op: "update_layer", layer: "card", properties: { opacity: 0.3 } },
    { op: "update_layer", layer: "tag", properties: { opacity: 0.4 } },
  ]);
  assert.equal(reply.isError, undefined, reply.text);
  const [card, tag] = reply.data.warnings;
  const shift = 200 - Number(toY);
  assert.equal(reply.data.warnings.length, 2, JSON.stringify(reply.data.warnings));
  assert.equal(reply.data.movedWithLayer?.length, 1, JSON.stringify(reply.data));
  assert.match(reply.data.movedWithLayer[0], / \(Slide In ↑\) with title$/);
  const slid = await agent("inspect", { targets: ["title"] });
  assert.match(slid.text, new RegExp(` y ${Number(fromY) + shift}→200 0s`), slid.text);
  assert.equal(card, "card opacity 0.3 does not show: from 0.5 s card.in (Fade In) holds opacity 1, card.out (Fade Out) starts from opacity 1 at 3 s, and an animation's value is drawn over the layer's. "
    + "A preset sent again works its values out from the layer's, and stays a preset. "
    + "To change the values the animations use: [{\"op\":\"update_animation\",\"animation\":\"card.in\",\"properties\":{\"preset\":{\"id\":\"fade\"}}},{\"op\":\"update_animation\",\"animation\":\"card.out\",\"properties\":{\"preset\":{\"id\":\"fade\"}}}]");
  assert.equal(tag, "tag opacity 0.4 shows only until 3 s: it jumps from opacity 0.4 to 1 when tag.out (Fade Out) starts at 3 s, and an animation's value is drawn over the layer's. "
    + "A preset sent again works its values out from the layer's, and stays a preset. "
    + "To change the value it starts from: {\"op\":\"update_animation\",\"animation\":\"tag.out\",\"properties\":{\"preset\":{\"id\":\"fade\"}}}");

  // Sending the suggested ops, the same values no longer warn.
  const ops = reply.data.warnings.flatMap((line) => [JSON.parse(line.slice(line.search(/[[{]"op"|\[\{/)))].flat());
  const fixed = await edit(ops);
  assert.equal(fixed.isError, undefined, fixed.text);
  const again = await edit([
    { op: "update_layer", layer: "title", properties: { y: 200 } },
    { op: "update_layer", layer: "card", properties: { opacity: 0.3 } },
    { op: "update_layer", layer: "tag", properties: { opacity: 0.4 } },
  ]);
  assert.equal(again.data.warnings, undefined, JSON.stringify(again.data.warnings));
});

test("library op update_layer shows the Hide example, and enabled or hidden suggest visible", async () => {
  const library = await agent("library", { topic: "op", name: "update_layer" });
  assert.match(library.text, /^Hide: \{"op":"update_layer","layer":"title","properties":\{"visible":false\}\}$/m);
  assert.match(library.text, /layer-flags \(Hiding \(visible:false\), locking and renaming layers\)/);
  const rules = await agent("library", { topic: "rules", name: "layer-flags" });
  assert.match(rules.text, /opacity 0 does not hide a layer whose fade-in or other animation sets opacity/);
  for (const word of ["enabled", "hidden"]) {
    const refused = await agent("edit", { ops: [{ op: "update_layer", layer: "miasma", properties: { [word]: false } }], dry_run: true });
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.data.didYouMean, ["visible"], refused.text);
    assert.match(refused.data.reason, /Did you mean visible\? To hide a layer \(its animations cannot show it\): \{"visible":false\}; true shows it again\./);
  }
});

// Moving a layer moves every animation of that place by the layer's own move (new value minus
// the old one), both ends, as place, align and check's safe_zone fix do: an entrance and an exit
// joined to the layer stay joined, each keeps its direction, and sending the ops and then the
// same update_layer again warns about nothing. (backend/agent-moved-place.test.mjs looks at the
// frames of chains of moves.)
test("a moved place shifts every animation by the layer's move, and following the advice settles", async () => {
  const made = await edit([
    { op: "add_layer", layerType: "rectangle", name: "chip", properties: { x: 400, y: 200, width: 60, height: 40, fill: "#ffff00" } },
    { op: "add_animation", layer: "chip", animation: { kind: "in", name: "Rise", start: 0, duration: 0.6, from: { y: 260 }, to: { y: 200 } } },
    { op: "add_animation", layer: "chip", animation: { kind: "out", name: "Drop", start: 3, duration: 0.5, from: { y: 200 }, to: { y: 300 } } },
  ]);
  assert.equal(made.isError, undefined, made.text);
  const reply = await edit([{ op: "update_layer", layer: "chip", properties: { y: 100 } }]);
  assert.deepEqual(reply.data.warnings, ["chip y 100 does not show: from 0.6 s chip.in (Rise) holds y 200. An animation's y is a place in the scene, so it stays where it was when the layer moves (-100). "
    + "To move its animations with the layer (each by -100): [{\"op\":\"update_animation\",\"animation\":\"chip.in\",\"properties\":{\"from\":{\"y\":160},\"to\":{\"y\":100}}},{\"op\":\"update_animation\",\"animation\":\"chip.out\",\"properties\":{\"from\":{\"y\":100},\"to\":{\"y\":200}}}]"]);
  const line = reply.data.warnings[0];
  const fixed = await edit(JSON.parse(line.slice(line.indexOf("[{"))));
  assert.equal(fixed.isError, undefined, fixed.text);
  const shown = await agent("inspect", { targets: ["chip"] });
  assert.match(shown.text, / y 160→100 0s/, "the entrance ends at 100");
  assert.match(shown.text, / y 100→200 3s/, "the exit starts where the layer is");
  const again = await edit([{ op: "update_layer", layer: "chip", properties: { y: 100 } }]);
  assert.equal(again.data.warnings, undefined, JSON.stringify(again.data.warnings));

  // Moving the layer again moves both by the same amount, keeping each one's direction.
  const moved = await edit([{ op: "update_layer", layer: "chip", properties: { y: 150 } }]);
  assert.match(moved.data.warnings[0], /\[\{"op":"update_animation","animation":"chip.in","properties":\{"from":\{"y":210\},"to":\{"y":150\}\}\},\{"op":"update_animation","animation":"chip.out","properties":\{"from":\{"y":150\},"to":\{"y":250\}\}\}\]$/);
});
