// update_layer x or y on a layer whose animations move it. An animation's x and y are places in
// the scene, so they stay where they were when the layer moves; the edit's receipt warns and
// gives the update_animation ops that move them with the layer. In a review of agent edits those ops
// moved each animation by its own amount (the new value minus that animation's own end), so
// following them broke what they were meant to keep: a custom move that starts at 1 s jumped
// 260 px, an entrance into a drift into an exit came apart by 100 px, and an out-and-back went
// off screen. The receipt also said "does not show" for a value that shows until the custom move
// starts, and an edit that set opacity 0.3 then 0.8 was warned about 0.3.
//
// Each test follows the receipt's advice and then looks at rendered frames just before and just
// after each animation starts: the box must not jump. Runs on a real server with a temporary
// data folder.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readImage, startTestServer } from "./media.test.support.mjs";

let server;
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project: "moved", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function edit(ops) {
  const reply = await agent("edit", { ops });
  assert.equal(reply.isError, undefined, reply.text);
  return reply;
}

// The ops a warning gives: the JSON after its last ": ".
const advice = (line) => [JSON.parse(line.slice(line.search(/(\[\{|\{)"op"/)))].flat();

// Only `name` is shown in each frame: every other layer is hidden while it is measured.
async function only(name, names) {
  await edit([{ op: "set_layer_flags", layers: names, visible: false }, { op: "set_layer_flags", layers: [name], visible: true }]);
}

// The box of the bright pixels in the frame at `t`, in scene pixels (the frame is 640 px wide,
// half the scene), and how bright its brightest pixel is (0-255).
async function boxAt(t) {
  const frame = await agent("look", { mode: "frame", t, width: 640 });
  assert.equal(frame.isError, undefined, frame.text);
  const picture = await readImage(Buffer.from(frame.images[0].data, "base64"));
  const scale = 1280 / picture.width;
  let [left, top, right, bottom, light] = [Infinity, Infinity, -Infinity, -Infinity, 0];
  for (let y = 0; y < picture.height; y += 1) for (let x = 0; x < picture.width; x += 1) {
    const value = Math.min(...picture.pixel(x, y).slice(0, 3));
    light = Math.max(light, value);
    if (value < 40) continue;
    [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)];
  }
  return { x: left * scale, y: top * scale, right: right * scale, bottom: bottom * scale, width: (right - left) * scale, height: (bottom - top) * scale, light };
}

// The box's place just before and just after each time in `starts` differs by less than `most` px.
async function noJump(key, starts, most = 12) {
  for (const start of starts) {
    const [early, late] = [await boxAt(start - 0.02), await boxAt(start + 0.02)];
    assert.ok(Number.isFinite(early[key]) && Number.isFinite(late[key]), `the box shows around ${start} s`);
    assert.ok(Math.abs(late[key] - early[key]) < most, `no jump at ${start} s: ${key} ${early[key]} just before, ${late[key]} just after`);
  }
}

const NAMES = ["tagline", "tag", "title", "dot", "bar", "spot", "rise", "follow", "aligned", "grouped", "other", "chain", "logo", "tilt", "plate", "trio", "leave"];

before(async () => {
  server = await startTestServer();
  await agent("project", { action: "create", id: "moved", name: "Moved", width: 1280, height: 720, duration: 6, background: "#000000" });
  await edit([
    // A custom move that starts at 1 s (from left out: it starts where the layer is, x 460).
    { op: "add_layer", layerType: "rectangle", name: "tagline", properties: { x: 460, y: 100, width: 120, height: 60, fill: "#ffffff" } },
    { op: "add_animation", layer: "tagline", animation: { kind: "custom", name: "Move", start: 1, duration: 1.5, to: { x: 200 } } },
    // An entrance into a drift into an exit, joined end to start.
    { op: "add_layer", layerType: "rectangle", name: "tag", properties: { x: 100, y: 300, width: 120, height: 60, fill: "#ffffff" } },
    { op: "add_animation", layer: "tag", animation: { kind: "in", name: "Rise", start: 0, duration: 0.5, from: { y: 360 }, to: { y: 300 } } },
    { op: "add_animation", layer: "tag", animation: { kind: "custom", name: "Drift", start: 1, duration: 1, from: { y: 300 }, to: { y: 400 } } },
    { op: "add_animation", layer: "tag", animation: { kind: "out", name: "Drop", start: 4, duration: 0.5, from: { y: 400 }, to: { y: 500 } } },
    // A preset slide followed by a drift that starts where the slide ends.
    { op: "add_layer", layerType: "rectangle", name: "title", properties: { x: 600, y: 300, width: 200, height: 80, fill: "#ffffff" },
      animations: [{ preset: "preset-slide", start: 0, duration: 0.6 }] },
    { op: "add_animation", layer: "title", animation: { kind: "custom", name: "Drift", start: 0.6, duration: 3, from: { y: 300 }, to: { y: 270 } } },
    // Out and back: a custom move to x 600 and another back to x 100.
    { op: "add_layer", layerType: "rectangle", name: "dot", properties: { x: 100, y: 500, width: 80, height: 80, fill: "#ffffff" } },
    { op: "add_animation", layer: "dot", animation: { kind: "custom", name: "Out", start: 1, duration: 1, from: { x: 100 }, to: { x: 600 } } },
    { op: "add_animation", layer: "dot", animation: { kind: "custom", name: "Back", start: 4, duration: 1, from: { x: 600 }, to: { x: 100 } } },
    // A fade-out from opacity 1.
    { op: "add_layer", layerType: "rectangle", name: "bar", properties: { x: 400, y: 400, width: 200, height: 100, fill: "#ffffff" },
      animations: [{ preset: "fade-out", start: 4, duration: 0.5 }] },
    // A move that starts somewhere else than the layer (it jumps from x 100 to 600 at 1 s).
    { op: "add_layer", layerType: "rectangle", name: "spot", properties: { x: 100, y: 500, width: 80, height: 80, fill: "#ffffff" } },
    { op: "add_animation", layer: "spot", animation: { kind: "custom", name: "Move", start: 1, duration: 1, from: { x: 600 }, to: { x: 900 } } },
    // An entrance that rests at y 500, not at the layer's y 200.
    { op: "add_layer", layerType: "rectangle", name: "rise", properties: { x: 300, y: 200, width: 400, height: 100, fill: "#ffffff" } },
    { op: "add_animation", layer: "rise", animation: { kind: "in", name: "Rise", start: 0, duration: 0.5, from: { y: 600 }, to: { y: 500 } } },
    // A move that starts from where the layer is (fromCurrent) and ends at x 900.
    { op: "add_layer", layerType: "rectangle", name: "follow", properties: { x: 100, y: 300, width: 80, height: 80, fill: "#ffffff" } },
    { op: "add_animation", layer: "follow", animation: { kind: "custom", name: "Go", start: 1, duration: 1, fromCurrent: true, to: { x: 900 } } },
    // A move from the layer's place, for an align in the same edit as an update_layer.
    { op: "add_layer", layerType: "rectangle", name: "aligned", properties: { x: 400, y: 300, width: 100, height: 100, fill: "#ffffff" } },
    { op: "add_animation", layer: "aligned", animation: { kind: "custom", name: "Go", start: 1, duration: 1, from: { x: 400 }, to: { x: 700 } } },
    // The same, for a group made in the same edit (its other layer is black: it does not show).
    { op: "add_layer", layerType: "rectangle", name: "grouped", properties: { x: 400, y: 500, width: 100, height: 100, fill: "#ffffff" } },
    { op: "add_animation", layer: "grouped", animation: { kind: "custom", name: "Go", start: 1, duration: 1, from: { x: 400 }, to: { x: 700 } } },
    { op: "add_layer", layerType: "rectangle", name: "other", properties: { x: 1150, y: 500, width: 100, height: 100, fill: "#000000" } },
    // An entrance, a drift and an exit that a later edit leaves behind twice.
    { op: "add_layer", layerType: "rectangle", name: "chain", properties: { x: 600, y: 200, width: 120, height: 60, fill: "#ffffff" } },
    { op: "add_animation", layer: "chain", animation: { kind: "in", name: "Rise", start: 0, duration: 0.5, from: { y: 260 }, to: { y: 200 } } },
    { op: "add_animation", layer: "chain", animation: { kind: "custom", name: "Drift", start: 1, duration: 1, from: { y: 200 }, to: { y: 300 } } },
    { op: "add_animation", layer: "chain", animation: { kind: "out", name: "Drop", start: 4, duration: 0.5, from: { y: 300 }, to: { y: 400 } } },
    // Values that are not places: a dim that starts at 2 s, a tilt and a grow that start at 1 s,
    // and a fade-in into a dim into a fade-out.
    { op: "add_layer", layerType: "rectangle", name: "logo", properties: { x: 100, y: 100, width: 100, height: 100, fill: "#ffffff" } },
    { op: "add_animation", layer: "logo", animation: { kind: "custom", name: "Dim", start: 2, duration: 1, from: { opacity: 1 }, to: { opacity: 0.4 } } },
    { op: "add_layer", layerType: "rectangle", name: "tilt", properties: { x: 300, y: 300, width: 200, height: 40, fill: "#ffffff" } },
    { op: "add_animation", layer: "tilt", animation: { kind: "custom", name: "Tilt", start: 1, duration: 1, from: { rotation: 0 }, to: { rotation: 30 } } },
    { op: "add_layer", layerType: "rectangle", name: "plate", properties: { x: 700, y: 300, width: 100, height: 100, fill: "#ffffff" } },
    { op: "add_animation", layer: "plate", animation: { kind: "custom", name: "Grow", start: 1, duration: 1, from: { scaleX: 1, scaleY: 1 }, to: { scaleX: 1.5, scaleY: 1.5 } } },
    { op: "add_layer", layerType: "rectangle", name: "trio", properties: { x: 900, y: 100, width: 100, height: 100, fill: "#ffffff" } },
    { op: "add_animation", layer: "trio", animation: { kind: "in", name: "Fade", start: 0, duration: 0.5, from: { opacity: 0 }, to: { opacity: 1 } } },
    { op: "add_animation", layer: "trio", animation: { kind: "custom", name: "Dim", start: 2, duration: 1, from: { opacity: 1 }, to: { opacity: 0.4 } } },
    { op: "add_animation", layer: "trio", animation: { kind: "out", name: "Gone", start: 4, duration: 0.5, from: { opacity: 0.4 }, to: { opacity: 0 } } },
    // A slide in, a drift that ends 40 px above, and a preset slide out from the layer's place:
    // the exit already jumps 40 px back down when it starts at 5 s.
    { op: "add_layer", layerType: "rectangle", name: "leave", properties: { x: 900, y: 300, width: 100, height: 100, fill: "#ffffff" } },
    { op: "add_animation", layer: "leave", preset: "preset-slide", start: 0.1, duration: 0.5, parameters: { direction: "up", distance: 40 } },
    { op: "add_animation", layer: "leave", animation: { kind: "custom", name: "Drift", start: 2, duration: 2, from: { y: 300 }, to: { y: 260 } } },
    { op: "add_animation", layer: "leave", preset: "preset-slide", mode: "out", start: 5, duration: 0.5, parameters: { direction: "down", distance: 40 } },
  ]);
});

test("a custom move that starts at 1 s: the layer's place shows until then, and the advice keeps the move joined", async () => {
  await only("tagline", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "tagline", properties: { x: 560 } }]);
  const [line] = reply.data.warnings;
  assert.doesNotMatch(line, /does not show/, "x 560 shows before the move starts");
  assert.match(line, /^tagline x 560 shows only until 1 s: it jumps from x 560 to 460 when tagline\.custom \(Move\) starts at 1 s, from 2\.5 s tagline\.custom \(Move\) holds x 200\./);
  // One amount, the layer's move (+100), on both ends.
  assert.deepEqual(advice(line), [{ op: "update_animation", animation: "tagline.custom", properties: { from: { x: 560 }, to: { x: 300 } } }]);
  await edit(advice(line));
  await noJump("x", [1]);
  assert.ok(Math.abs((await boxAt(0.5)).x - 560) < 4, "the layer's own place shows before the move");
  assert.ok(Math.abs((await boxAt(3)).x - 300) < 4, "the move still goes 260 px left");
  // Sending the same update_layer again moves nothing and warns about nothing.
  const again = await edit([{ op: "update_layer", layer: "tagline", properties: { x: 560 } }]);
  assert.equal(again.data.warnings, undefined, JSON.stringify(again.data.warnings));
});

test("an entrance, a drift and an exit move as one: no 100 px jump where they meet", async () => {
  await only("tag", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "tag", properties: { y: 500 } }]);
  const [line] = reply.data.warnings;
  assert.deepEqual(advice(line), [
    { op: "update_animation", animation: "tag.in", properties: { from: { y: 560 }, to: { y: 500 } } },
    { op: "update_animation", animation: "tag.custom", properties: { from: { y: 500 }, to: { y: 600 } } },
    { op: "update_animation", animation: "tag.out", properties: { from: { y: 600 }, to: { y: 700 } } },
  ]);
  await edit(advice(line));
  await noJump("y", [1, 4]);
  assert.ok(Math.abs((await boxAt(0.9)).y - 500) < 4, "the entrance ends at the new place");
  const again = await edit([{ op: "update_layer", layer: "tag", properties: { y: 500 } }]);
  assert.equal(again.data.warnings, undefined, JSON.stringify(again.data.warnings));
});

test("a preset slide followed by a drift keeps its speed where they meet, and check finds no speed jump", async () => {
  await only("title", NAMES);
  const before = await agent("check", { pixels: false });
  const jumps = (check) => check.data.findings.filter((finding) => finding.rule === "speed_jump" && finding.ref === "title");
  const reply = await edit([{ op: "update_layer", layer: "title", properties: { y: 400 } }]);
  // The preset slide moved with the layer in the same edit; the drift the agent wrote did not.
  assert.equal(reply.data.movedWithLayer?.length, 1, JSON.stringify(reply.data));
  assert.match(reply.data.movedWithLayer[0], / \(Slide In ↑\) with title$/);
  const ops = advice(reply.data.warnings[0]);
  // The drift moves by the layer's move (+100), as the slide's end did.
  assert.deepEqual(ops, [{ op: "update_animation", animation: "title.custom", properties: { from: { y: 400 }, to: { y: 370 } } }]);
  await edit(ops);
  await noJump("y", [0.6]);
  assert.equal(jumps(await agent("check", { pixels: false })).length, jumps(before).length, "following the advice adds no speed_jump");
});

test("an out-and-back stays on screen and joined after the advice", async () => {
  await only("dot", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "dot", properties: { x: 150 } }]);
  const [line] = reply.data.warnings;
  assert.match(line, /^dot x 150 shows only until 1 s: it jumps from x 150 to 100 when \S+ \(Out\) starts at 1 s, from 5 s \S+ \(Back\) holds x 100\./);
  const ops = advice(line);
  assert.deepEqual(ops.map((op) => op.properties), [{ from: { x: 150 }, to: { x: 650 } }, { from: { x: 650 }, to: { x: 150 } }]);
  await edit(ops);
  await noJump("x", [1, 4]);
  for (const t of [3, 5.5]) {
    const box = await boxAt(t);
    assert.ok(box.right < 1280 && Math.abs(box.x - (t === 3 ? 650 : 150)) < 4, `the dot is at its place at ${t} s: ${JSON.stringify(box)}`);
  }
});

test("an edit that sets opacity twice is judged on the last value", async () => {
  await only("bar", NAMES);
  const reply = await edit([
    { op: "update_layer", layer: "bar", properties: { opacity: 0.3 } },
    { op: "update_layer", layer: "bar", properties: { opacity: 0.8 } },
  ]);
  assert.deepEqual(reply.data.warnings, ["bar opacity 0.8 shows only until 4 s: it jumps from opacity 0.8 to 1 when bar.out (Fade Out) starts at 4 s, and an animation's value is drawn over the layer's. "
    + "A preset sent again works its values out from the layer's, and stays a preset. "
    + "To change the value it starts from: {\"op\":\"update_animation\",\"animation\":\"bar.out\",\"properties\":{\"preset\":{\"id\":\"fade\"}}}"]);
  await edit(advice(reply.data.warnings[0]));
  const [early, late] = [await boxAt(3.99), await boxAt(4.01)];
  assert.ok(Math.abs(early.light - 0.8 * 255) < 8, `opacity 0.8 before the fade-out: ${early.light}`);
  assert.ok(Math.abs(late.light - early.light) < 8, `no jump when the fade-out starts: ${early.light} then ${late.light}`);
});

test("check's own fix (the layer and its animations moved together) gives no warning", async () => {
  // The update_layer and the shifted update_animation in one edit: nothing was left behind.
  await only("tag", NAMES);
  const reply = await edit([
    { op: "update_layer", layer: "tag", properties: { y: 450 } },
    { op: "update_animation", animation: "tag.in", properties: { from: { y: 510 }, to: { y: 450 } } },
    { op: "update_animation", animation: "tag.custom", properties: { from: { y: 450 }, to: { y: 550 } } },
    { op: "update_animation", animation: "tag.out", properties: { from: { y: 550 }, to: { y: 650 } } },
  ]);
  assert.equal(reply.data.warnings, undefined, JSON.stringify(reply.data.warnings));
});

// The review after the first fixes: an update_layer that moves a layer to where its animation
// already starts (or rests) closes a jump, and the advice used to move the animation away again
// by the layer's move, making a new jump (x 600 -> 1098 at 1 s).
test("a layer moved to where its animation starts gets no advice, and nothing jumps", async () => {
  await only("spot", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "spot", properties: { x: 600 } }]);
  assert.equal(reply.data.warnings, undefined, JSON.stringify(reply.data.warnings));
  await noJump("x", [1]);
  assert.ok(Math.abs((await boxAt(3)).x - 900) < 4, "the move still ends at x 900");
});

// A layer first seen as it lands, moved to where the landing ends and it rests until the next
// move, warned "x 300 shows only at ...: land still draws x at the old place".
test("a layer moved to where it rests between two moves gets no advice; a place no move ends on still does", async () => {
  NAMES.push("lander");
  await edit([{ op: "add_layer", layerType: "rectangle", name: "lander", properties: { x: 100, y: 600, width: 80, height: 40, fill: "#ffffff" }, animations: [
    { kind: "show", name: "Show", start: 1 }, { kind: "custom", name: "Land", start: 1, duration: 0.5, from: { x: 600 }, to: { x: 300 } },
    { kind: "custom", name: "Aside", start: 3, duration: 0.5, from: { x: 300 }, to: { x: 900 } }] }]);
  const rest = await edit([{ op: "update_layer", layer: "lander", properties: { x: 300 } }]);
  assert.equal(rest.data.warnings, undefined, JSON.stringify(rest.data.warnings));
  const off = await edit([{ op: "update_layer", layer: "lander", properties: { x: 340 } }]);
  assert.match(off.data.warnings?.[0] ?? "", /^lander x 340 does not show/);
});

test("a layer moved to where its entrance rests gets no advice: the entrance is not moved away", async () => {
  await only("rise", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "rise", properties: { y: 500 } }]);
  assert.equal(reply.data.warnings, undefined, JSON.stringify(reply.data.warnings));
  assert.ok(Math.abs((await boxAt(1)).y - 500) < 4, "it rests at y 500");
});

test("a move that starts from where the layer is (fromCurrent) is left alone", async () => {
  await only("follow", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "follow", properties: { x: 300 } }]);
  assert.equal(reply.data.warnings, undefined, JSON.stringify(reply.data.warnings));
  await noJump("x", [1]);
  assert.ok(Math.abs((await boxAt(3)).x - 900) < 4, "it still ends at x 900");
});

// An edit that aligns (or groups) a layer and then sets its x: the align moved the animation
// with the layer, so it is judged on where the animation is after the align, not before the edit.
test("align then update_layer x in one edit: the advice joins the move to the layer's new place", async () => {
  await only("aligned", NAMES);
  const reply = await edit([{ op: "align_layers", layers: ["aligned"], align: "center" }, { op: "update_layer", layer: "aligned", properties: { x: 200 } }]);
  const [line] = reply.data.warnings ?? assert.fail("no warning");
  assert.match(line, /^aligned x 200 shows only until 1 s: it jumps from x 200 to 590 when aligned\.custom \(Go\) starts at 1 s/);
  assert.deepEqual(advice(line), [{ op: "update_animation", animation: "aligned.custom", properties: { from: { x: 200 }, to: { x: 500 } } }]);
  await edit(advice(line));
  await noJump("x", [1]);
  assert.ok(Math.abs((await boxAt(3)).x - 500) < 4, "the move still goes 300 px right");
});

test("group then update_layer x in one edit: the advice is in the group's own places", async () => {
  await only("grouped", NAMES);
  const reply = await edit([{ op: "group_layers", layers: ["grouped", "other"], name: "g" }, { op: "update_layer", layer: "grouped", properties: { x: 200 } }]);
  const [line] = reply.data.warnings ?? assert.fail("no warning");
  assert.match(line, /^grouped x 200 shows only until 1 s: it jumps from x 200 to /);
  await edit(advice(line));
  await noJump("x", [1]);
  const [early, late] = [await boxAt(0.5), await boxAt(3)];
  assert.ok(Math.abs(late.x - early.x - 300) < 4, `the move still goes 300 px right: ${early.x} then ${late.x}`);
});

// A layer whose animations were left behind once (the advice was not sent), then moved again:
// the advice moves them by what joins them to the new place (+300), not by the layer's last move
// (+100), which left the layer resting at y 500 while inspect said y 700.
test("moved twice without the advice: the advice joins the chain to the newest place", async () => {
  await only("chain", NAMES);
  await edit([{ op: "update_layer", layer: "chain", properties: { y: 400 } }]);
  const reply = await edit([{ op: "update_layer", layer: "chain", properties: { y: 500 } }]);
  const [line] = reply.data.warnings;
  assert.match(line, /^chain y 500 does not show: from 0\.5 s chain\.in \(Rise\) holds y 200/);
  assert.deepEqual(advice(line).map((op) => op.properties), [
    { from: { y: 560 }, to: { y: 500 } }, { from: { y: 500 }, to: { y: 600 } }, { from: { y: 600 }, to: { y: 700 } }]);
  await edit(advice(line));
  assert.ok(Math.abs((await boxAt(0.9)).y - 500) < 4, "it rests at y 500, the layer's own y");
  await noJump("y", [1, 4]);
  // update_animation that moves the entrance off the layer's place again is warned about too.
  const moved = await edit([{ op: "update_animation", animation: "chain.in", properties: { from: { y: 360 }, to: { y: 300 } } }]);
  const [again] = moved.data.warnings ?? assert.fail("no warning after update_animation");
  assert.match(again, /^chain y 500 does not show: from 0\.5 s chain\.in \(Rise\) holds y 300.* put the layer where it rests: \{"op":"update_layer","layer":"chain","properties":\{"y":300\}\}/);
});

// Opacity, rotation and scale are not places. The advice used to change only the value the last
// animation holds (its `to`), so a dim that starts at 2 s still started from opacity 1: the logo
// jumped from 0.7 to 1 at 2 s and then dimmed to 0.7 instead of 0.4. Now each end that used the
// layer's old value changes to the new one, and the line says the new value shows until 2 s.
const near = (actual, expected, most, what) => assert.ok(Math.abs(actual - expected) <= most, `${what}: ${actual}, not about ${expected}`);

test("a dim that starts later starts from the layer's new opacity: no jump at 2 s, and it still dims to 0.4", async () => {
  await only("logo", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "logo", properties: { opacity: 0.7 } }]);
  assert.deepEqual(reply.data.warnings, ["logo opacity 0.7 shows only until 2 s: it jumps from opacity 0.7 to 1 when logo.custom (Dim) starts at 2 s, and an animation's value is drawn over the layer's. "
    + "To change the value it starts from: {\"op\":\"update_animation\",\"animation\":\"logo.custom\",\"properties\":{\"from\":{\"opacity\":0.7}}}"]);
  await edit(advice(reply.data.warnings[0]));
  near((await boxAt(1)).light, 0.7 * 255, 6, "opacity 0.7 shows before the dim");
  await noJump("light", [2]);
  near((await boxAt(4)).light, 0.4 * 255, 6, "the dim still ends at 0.4");
  const again = await edit([{ op: "update_layer", layer: "logo", properties: { opacity: 0.7 } }]);
  assert.equal(again.data.warnings, undefined, JSON.stringify(again.data.warnings));
});

test("a tilt that starts later starts from the layer's new rotation (its box does not jump at 1 s)", async () => {
  await only("tilt", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "tilt", properties: { rotation: 15 } }]);
  const [line] = reply.data.warnings;
  assert.match(line, /^tilt rotation 15 shows only until 1 s: it jumps from rotation 15 to 0 when tilt\.custom \(Tilt\) starts at 1 s/);
  assert.deepEqual(advice(line), [{ op: "update_animation", animation: "tilt.custom", properties: { from: { rotation: 15 } } }]);
  await edit(advice(line));
  // A 200 x 40 bar turned 15 degrees is about 200 sin 15 + 40 cos 15 = 90 px tall.
  near((await boxAt(0.5)).height, 90, 6, "the bar is turned 15 degrees before the tilt");
  await noJump("height", [1]);
});

test("scale set as one value is one line with one op for scaleX and scaleY, and the grow starts from it", async () => {
  await only("plate", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "plate", properties: { scaleX: 0.6, scaleY: 0.6 } }]);
  assert.equal(reply.data.warnings.length, 1, JSON.stringify(reply.data.warnings));
  const [line] = reply.data.warnings;
  assert.match(line, /^plate scaleX and scaleY 0\.6 shows only until 1 s: it jumps from scaleX 0\.6 to 1 when plate\.custom \(Grow\) starts at 1 s/);
  assert.deepEqual(advice(line), [{ op: "update_animation", animation: "plate.custom", properties: { from: { scaleX: 0.6, scaleY: 0.6 } } }]);
  await edit(advice(line));
  near((await boxAt(0.5)).width, 60, 4, "the plate is 60 px wide before the grow");
  await noJump("width", [1]);
  near((await boxAt(3)).width, 150, 4, "the grow still ends at 1.5");
});

test("a fade-in into a dim into a fade-out: the fade-in rests on the new opacity and the dim starts there", async () => {
  await only("trio", NAMES);
  const reply = await edit([{ op: "update_layer", layer: "trio", properties: { opacity: 0.7 } }]);
  const [line] = reply.data.warnings;
  assert.match(line, /^trio opacity 0\.7 does not show: from 0\.5 s trio\.in \(Fade\) holds opacity 1/);
  assert.deepEqual(advice(line), [
    { op: "update_animation", animation: "trio.in", properties: { to: { opacity: 0.7 } } },
    { op: "update_animation", animation: "trio.custom", properties: { from: { opacity: 0.7 } } }]);
  await edit(advice(line));
  near((await boxAt(1)).light, 0.7 * 255, 6, "the fade-in rests on 0.7");
  await noJump("light", [2, 4]);
  near((await boxAt(3.5)).light, 0.4 * 255, 6, "the dim still ends at 0.4");
});

// After group_animations (or convert_to_actions) the animations sit inside a group, where
// "layer.in" does not find them: the advice named them so, and sending it was refused. Now a
// nested animation is named by its code.
test("animations inside a group are named by their code, and the advice can be sent", async () => {
  const made = await edit([
    { op: "add_layer", layerType: "rectangle", name: "nest", properties: { x: 1000, y: 400, width: 60, height: 40, fill: "#ffffff" } },
    { op: "add_animation", layer: "nest", animation: { kind: "in", name: "Rise", start: 0, duration: 0.6, from: { y: 460 }, to: { y: 400 } } },
    { op: "add_animation", layer: "nest", animation: { kind: "out", name: "Drop", start: 3, duration: 0.5, from: { y: 400 }, to: { y: 500 } } },
    { op: "add_layer", layerType: "rectangle", name: "acted", properties: { x: 1100, y: 400, width: 60, height: 40, fill: "#ffffff" },
      animations: [{ preset: "preset-slide", start: 0.5, duration: 0.6 }] },
  ]);
  const [rise, drop] = [made.data.created["nest.in"], made.data.created["nest.out"]];
  NAMES.push("nest", "acted");
  await edit([{ op: "group_animations", animationIds: ["nest.in", "nest.out"], name: "intro" }, { op: "convert_to_actions", animationIds: ["acted.in"] }]);
  await only("nest", NAMES);
  await edit([{ op: "set_layer_flags", layers: ["acted"], visible: true }]);
  const reply = await edit([{ op: "update_layer", layer: "nest", properties: { y: 300 } }, { op: "update_layer", layer: "acted", properties: { y: 300 } }]);
  const [nest, acted] = reply.data.warnings;
  assert.deepEqual(advice(nest).map((op) => op.animation), [rise, drop]);
  assert.doesNotMatch(acted, /"animation":"acted\.in"/, acted);
  const sent = await edit([...advice(nest), ...advice(acted)]);
  assert.equal(sent.isError, undefined, sent.text);
  assert.ok(Math.abs((await boxAt(1)).y - 300) < 4, "the entrance rests on y 300");
  await only("nest", NAMES);
  await noJump("y", [3]);
  await only("acted", NAMES);
  assert.ok(Math.abs((await boxAt(2)).y - 300) < 4, "the converted slide rests on y 300");
});

// The receipt gave at most 5 lines and did not say more existed: moving 7 slid-in layers in one
// edit gave ops for 5. The rest now share one more line with every op they need.
test("seven slid-in layers moved in one edit get ops for all seven", async () => {
  const names = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
  NAMES.push(...names);
  await edit(names.map((name, index) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x: 60 + index * 160, y: 600, width: 60, height: 40, fill: "#ffffff" },
    animations: [{ kind: "in", name: "Rise", start: 0, duration: 0.5, from: { y: 660 }, to: { y: 600 } }] })));
  const reply = await edit([{ op: "update_layers", layers: names, properties: { y: 500 } }]);
  const lines = reply.data.warnings;
  assert.equal(lines.length, 6, JSON.stringify(lines));
  assert.match(lines[5], /^2 more values are drawn over by animations the same way \(m6 y 500, m7 y 500\)\. To fix them as above: \[/);
  const ops = lines.flatMap(advice);
  assert.deepEqual(ops.map((op) => op.animation).sort(), names.map((name) => `${name}.in`));
  await edit(ops);
  const again = await edit([{ op: "update_layers", layers: names, properties: { y: 500 } }]);
  assert.equal(again.data.warnings, undefined, JSON.stringify(again.data.warnings));
  await only("m7", NAMES);
  assert.ok(Math.abs((await boxAt(1)).y - 500) < 4, "the seventh rests on y 500");
});

// Before, the advice moved the entrance and the drift by +200 but left the exit at y 300, because
// it did not meet the drift before the edit either: the 40 px jump at 5 s grew to 160 px.
test("an exit that starts at the layer's old place moves with the layer, even after a drift that ends elsewhere", async () => {
  await only("leave", NAMES);
  const [early, late] = [await boxAt(4.98), await boxAt(5.02)];
  const jump = late.y - early.y;
  assert.ok(Math.abs(jump - 40) < 8, `the exit jumps 40 px before the move: ${jump}`);
  const reply = await edit([{ op: "update_layer", layer: "leave", properties: { y: 500 } }]);
  // The preset slides moved with the layer; the advice moves the drift by the same +200.
  assert.equal(reply.data.movedWithLayer?.length, 2, JSON.stringify(reply.data));
  const [line] = reply.data.warnings;
  const ops = advice(line);
  assert.deepEqual(ops, [{ op: "update_animation", animation: "leave.custom", properties: { from: { y: 500 }, to: { y: 460 } } }]);
  await edit(ops);
  await noJump("y", [0.1, 2]);
  const [before, after] = [await boxAt(4.98), await boxAt(5.02)];
  assert.ok(Math.abs(before.y - 460) < 4, `the drift ends 40 px above the new place: ${before.y}`);
  assert.ok(Math.abs(after.y - before.y - jump) < 8, `the jump at 5 s is still ${jump} px, not ${after.y - before.y}`);
  const exit = await agent("inspect", { targets: ["leave.out"] });
  assert.match(exit.text, /y 500→/, exit.text);
});

// A drift that does not quite meet the entrance before it (2 px off) or starts somewhere else on
// purpose (a 100 px cut): the advice moved the entrance with the layer but left the drift where
// it was, because it was not joined (amount 0). Following the advice turned the 2 px step into
// 198 px, and the 100 px cut into 300 px. Now the drift moves with the chain and keeps its step.
test("a chain that is almost joined, or has a deliberate cut, keeps the same step after the advice", async () => {
  const chain = (name, x, driftFrom) => [
    { op: "add_layer", layerType: "rectangle", name, properties: { x, y: 200, width: 120, height: 60, fill: "#ffffff" } },
    { op: "add_animation", layer: name, animation: { kind: "in", name: "Rise", start: 0, duration: 0.5, from: { y: 260 }, to: { y: 200 } } },
    { op: "add_animation", layer: name, animation: { kind: "custom", name: "Drift", start: 1, duration: 1, from: { y: driftFrom }, to: { y: 300 } } },
    { op: "add_animation", layer: name, animation: { kind: "out", name: "Drop", start: 4, duration: 0.5, from: { y: 300 }, to: { y: 400 } } },
  ];
  NAMES.push("near", "cut");
  await edit([...chain("near", 300, 202), ...chain("cut", 800, 100)]);
  for (const [name, driftFrom] of [["near", 202], ["cut", 100]]) {
    await only(name, NAMES);
    const step = async () => (await boxAt(1.02)).y - (await boxAt(0.98)).y;
    const before = await step();
    const reply = await edit([{ op: "update_layer", layer: name, properties: { y: 300 } }]);
    const [line] = reply.data.warnings;
    // Every animation of the chain moves by the layer's move (+100), the drift too.
    assert.deepEqual(advice(line).map((op) => [op.animation, op.properties]), [
      [`${name}.in`, { from: { y: 360 }, to: { y: 300 } }],
      [`${name}.custom`, { from: { y: driftFrom + 100 }, to: { y: 400 } }],
      [`${name}.out`, { from: { y: 400 }, to: { y: 500 } }],
    ]);
    await edit(advice(line));
    const after = await step();
    assert.ok(Math.abs(after - before) < 6, `${name}: the step where the drift starts is still ${before} px, not ${after}`);
    await noJump("y", [4]);
    assert.ok(Math.abs((await boxAt(0.9)).y - 300) < 4, `${name}: the entrance rests on the new place`);
    // The step was there before: sending the move again asks for nothing.
    const again = await edit([{ op: "update_layer", layer: name, properties: { y: 300 } }]);
    assert.equal(again.data.warnings, undefined, JSON.stringify(again.data.warnings));
  }
});

// An update_animation that changed only the easing (or the duration) of a drift that rests away
// from the layer's x warned "bar x 100 does not show" and offered to move the drift 100 px left,
// although the edit moved nothing. Now the line comes only when the edit set a place, or made
// the layer's own place stop showing.
test("update_animation of easing or duration alone gives no place warning; one that sets a place still does", async () => {
  NAMES.push("ease", "lift", "late");
  await edit([
    { op: "add_layer", layerType: "rectangle", name: "ease", properties: { x: 100, y: 600, width: 60, height: 40, fill: "#ffffff" } },
    { op: "add_animation", layer: "ease", animation: { kind: "custom", name: "Drift", start: 0, duration: 3, from: { x: 200 }, to: { x: 300 } } },
    { op: "add_layer", layerType: "rectangle", name: "lift", properties: { x: 300, y: 500, width: 60, height: 40, fill: "#ffffff" } },
    { op: "add_animation", layer: "lift", animation: { kind: "in", name: "Up", start: 0, duration: 0.5, from: { y: 580 }, to: { y: 520 } } },
    { op: "add_layer", layerType: "rectangle", name: "late", properties: { x: 100, y: 650, width: 60, height: 40, fill: "#ffffff" } },
    { op: "add_animation", layer: "late", animation: { kind: "custom", name: "Go", start: 0.5, duration: 1, from: { x: 300 }, to: { x: 600 } } },
  ]);
  for (const ops of [
    [{ op: "update_animation", animation: "ease.custom", properties: { easing: "ease-out" } }],
    [{ op: "update_animation", animation: "lift.in", properties: { duration: 0.8 } }],
  ]) {
    const reply = await edit(ops);
    assert.equal(reply.data.warnings, undefined, `${JSON.stringify(ops)}: ${JSON.stringify(reply.data.warnings)}`);
  }
  // Setting the entrance's places still warns, with both options.
  const placed = await edit([{ op: "update_animation", animation: "lift.in", properties: { from: { y: 600 }, to: { y: 540 } } }]);
  assert.match(placed.data.warnings?.[0] ?? "", /^lift y 500 does not show: .* put the layer where it rests: \{"op":"update_layer","layer":"lift","properties":\{"y":540\}\}/);
  // A new start of 0 s hides the layer's own x 100, which showed until 0.5 s before the edit.
  const started = await edit([{ op: "update_animation", animation: "late.custom", properties: { start: 0 } }]);
  assert.match(started.data.warnings?.[0] ?? "", /^late x 100 does not show: /);
});

// The receipt's ops for a moved layer set a preset slide's from and to, which made it a plain
// animation (inspect lost "preset slide"), so a later {preset:{parameters:{distance:80}}} was
// refused with "Unknown preset id undefined". Now a preset whose own settings give the moved
// places is sent again as its preset, and a preset edit of a plain animation says why it fails.
test("a preset slide the advice moves stays a preset, and a preset edit of a plain animation says why it fails", async () => {
  NAMES.push("slid");
  await edit([{ op: "add_layer", layerType: "rectangle", name: "slid", properties: { x: 1000, y: 500, width: 100, height: 60, fill: "#ffffff" }, animations: [
    { preset: "preset-slide", start: 0, duration: 0.5, parameters: { direction: "up", distance: 40 } },
    { preset: "preset-slide", mode: "out", start: 4, duration: 0.5, parameters: { direction: "down", distance: 40 } },
  ] }]);
  await only("slid", NAMES);
  // Both presets move with the layer in the same edit: nothing to warn about or send again.
  const reply = await edit([{ op: "update_layer", layer: "slid", properties: { y: 400 } }]);
  assert.equal(reply.data.warnings, undefined, JSON.stringify(reply.data.warnings));
  assert.equal(reply.data.movedWithLayer?.length, 2, JSON.stringify(reply.data));
  const kept = await agent("inspect", { targets: ["slid"] });
  assert.match(kept.text, /in preset slide \(direction "up", distance 40\) y 424→400 /, kept.text);
  assert.match(kept.text, /out preset slide \(direction "down", distance 40\) y 400→376 /, kept.text);
  assert.ok(Math.abs((await boxAt(0.9)).y - 400) < 4, "the entrance rests on the new place");
  await noJump("y", [4]);
  // A later preset edit works.
  const wider = await edit([{ op: "update_animation", animation: "slid.in", properties: { preset: { parameters: { distance: 80 } } } }]);
  assert.deepEqual(wider.data.changed.length, 1);

  // Setting from and to makes it a plain animation; a preset edit then says so, with the op that
  // makes it a slide again, which works.
  await edit([{ op: "update_animation", animation: "slid.in", properties: { from: { y: 460 }, to: { y: 400 } } }]);
  const refused = await agent("edit", { ops: [{ op: "update_animation", animation: "slid.in", properties: { preset: { parameters: { distance: 80 } } } }] });
  assert.equal(refused.isError, true);
  assert.doesNotMatch(refused.data.reason, /undefined/);
  assert.match(refused.data.reason, /"slid\.in" is not a preset any more: setting its from or to made it a plain animation \(it kept the name "Slide In ↑"\)/);
  assert.deepEqual(refused.data.example, { op: "update_animation", animation: "slid.in", properties: { preset: { id: "slide", mode: "in", parameters: { direction: "up", distance: 80 } } } });
  await edit([refused.data.example]);
  const again = await agent("inspect", { targets: ["slid.in"] });
  assert.match(again.text, /in preset slide \(direction "up", distance 80\) y 448→400 /, again.text);
});

// A drift with no animation before it that starts 2 px off the layer's place (or cuts away from
// it on purpose) was left behind when the layer moved, with no warning: moving the layer 100 px
// made the 2 px step a 98 px jump. Now it moves with the layer and keeps its step.
test("a lone drift that starts off the layer's place, or cuts away on purpose, keeps its step after the advice", async () => {
  const lone = (name, x, driftFrom) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x, y: 200, width: 120, height: 60, fill: "#ffffff" },
    animations: [{ kind: "custom", name: "Drift", start: 1, duration: 1, from: { y: driftFrom }, to: { y: 300 } }] });
  NAMES.push("lone", "lonecut");
  await edit([lone("lone", 300, 202), lone("lonecut", 800, 100)]);
  for (const [name, driftFrom] of [["lone", 202], ["lonecut", 100]]) {
    await only(name, NAMES);
    const step = async () => (await boxAt(1.02)).y - (await boxAt(0.98)).y;
    const before = await step();
    const reply = await edit([{ op: "update_layer", layer: name, properties: { y: 300 } }]);
    const [line] = reply.data.warnings ?? [];
    assert.match(line ?? "", new RegExp(`^${name} y 300 shows only at 0-1 s, 2-6 s: it jumps from y 300 to ${driftFrom} when ${name}\\.custom \\(Drift\\) starts at 1 s`), JSON.stringify(reply.data.warnings));
    assert.deepEqual(advice(line), [{ op: "update_animation", animation: `${name}.custom`, properties: { from: { y: driftFrom + 100 }, to: { y: 400 } } }]);
    await edit(advice(line));
    const after = await step();
    assert.ok(Math.abs(after - before) < 6, `${name}: the step where the drift starts is still ${before} px, not ${after}`);
    const again = await edit([{ op: "update_layer", layer: name, properties: { y: 300 } }]);
    assert.equal(again.data.warnings, undefined, JSON.stringify(again.data.warnings));
  }
});

// An update_animation that set only an entrance's from, or only a grow's scale, on a layer whose
// entrance already rested 20 px off its place warned "y 500 does not show" and offered to
// rewrite the from just sent (or to move the other animation), although where the layer rests
// did not change. Setting where it rests still warns.
test("an entrance's new from, or a grow's new scale, gives no place warning when where the layer rests did not change", async () => {
  NAMES.push("upfrom", "upgrow");
  await edit([
    { op: "add_layer", layerType: "rectangle", name: "upfrom", properties: { x: 1100, y: 560, width: 60, height: 40, fill: "#ffffff" },
      animations: [{ kind: "in", name: "Up", start: 0, duration: 0.5, from: { y: 620 }, to: { y: 580 } }] },
    { op: "add_layer", layerType: "rectangle", name: "upgrow", properties: { x: 1180, y: 560, width: 60, height: 40, fill: "#ffffff" },
      animations: [{ kind: "in", name: "Rise", start: 0, duration: 0.5, from: { y: 620 }, to: { y: 580 } }, { preset: "preset-grow", start: 0.5, duration: 0.5 }] },
  ]);
  for (const ops of [
    [{ op: "update_animation", animation: "upfrom.in", properties: { from: { y: 660 } } }],
    [{ op: "update_animation", animation: "upgrow.Grow In", properties: { preset: { parameters: { scale: 80 } } } }],
  ]) {
    const reply = await edit(ops);
    assert.equal(reply.data.warnings, undefined, `${JSON.stringify(ops)}: ${JSON.stringify(reply.data.warnings)}`);
  }
  const moved = await edit([{ op: "update_animation", animation: "upfrom.in", properties: { to: { y: 600 } } }]);
  assert.match(moved.data.warnings?.[0] ?? "", /^upfrom y 560 does not show: .* put the layer where it rests: \{"op":"update_layer","layer":"upfrom","properties":\{"y":600\}\}/);
});
