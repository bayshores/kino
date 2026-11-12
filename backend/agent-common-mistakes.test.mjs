// The first-try mistakes agents make most, through the agent service on a real server
// (backend/agent/common-mistakes.mjs). A mistake kino can read one way only is fixed and listed in
// the receipt's `fixed`; any other is refused with one short `example` that works, and that
// example runs as written. Refusals stay small.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { evaluateLayer } from "../engine/animation.js";
import { estimateTextTokens } from "./meter.mjs";
import { nextCallOf, startTestServer } from "./media.test.support.mjs";

let server;
before(async () => { server = await startTestServer(); });
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const saved = async (id) => (await server.api(`/api/projects/${id}`)).json();
const layerNamed = (record, name) => record.document.scenes.flatMap((scene) => scene.layers).find((layer) => layer.name === name);

// A project with a rectangle "box" and a text layer "title", each with a fade in (box.in, title.in).
async function project(id) {
  await agent("project", { action: "create", id, name: "Mistakes", width: 1920, height: 1080, duration: 6 });
  const made = await agent("edit", { project: id, ops: [
    { op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 100, y: 100, width: 200, height: 200, fill: "#ff5500" }, animations: [{ preset: "preset-fade", start: 0, duration: 0.5 }] },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "Hello", x: 200, y: 400, width: 800, height: 120, fontSize: 96 }, animations: [{ preset: "preset-fade", start: 0.2, duration: 0.5 }] },
    // A video layer for the clip speed shapes (its file is never read here).
    { op: "add_layer", layerType: "video", name: "clip", properties: { src: "/api/media/clip.mp4", x: 1200, y: 600, width: 640, height: 360 } },
  ] });
  assert.equal(made.isError, undefined, made.text);
}

// [what the agent sent, one op, a line its `fixed` must list]
const FIXED = [
  ["a nested layer of type shape", { op: "add_layer", layer: { type: "shape", name: "box2", properties: { x: 10, y: 10, width: 100, height: 100 } } }, 'layerType "shape" → rectangle'],
  ["layerType rect", { op: "add_layer", type: "rect", name: "box4" }, 'layerType "rect" → rectangle'],
  ["layerType circle", { op: "add_layer", layerType: "circle", name: "dot" }, 'layerType "circle" → ellipse'],
  ["no layerType on text", { op: "add_layer", name: "caption", properties: { text: "Hi" } }, "layerType text (it has text)"],
  ["color on text", { op: "add_layer", layerType: "text", name: "t2", properties: { text: "Hi", color: "#ffffff" } }, "color → fill"],
  ["px units", { op: "add_layer", layerType: "text", name: "t3", properties: { text: "Hi", fontSize: "48px" } }, 'fontSize "48px" → 48'],
  ["opacity in percent", { op: "add_layer", layerType: "rectangle", name: "r6", properties: { opacity: "50%" } }, 'opacity "50%" → 0.5'],
  ["opacity out of 100", { op: "add_layer", layerType: "rectangle", name: "r7", properties: { opacity: 50 } }, "opacity 50 → 0.5"],
  ["fontWeight bold", { op: "add_layer", layerType: "text", name: "t4", properties: { text: "Hi", fontWeight: "bold" } }, 'fontWeight "bold" → 700'],
  ["textAlign middle", { op: "add_layer", layerType: "text", name: "t5", properties: { text: "Hi", textAlign: "middle" } }, 'textAlign "middle" → center'],
  ["position and size objects", { op: "add_layer", layerType: "rectangle", name: "r8", properties: { position: { x: 10, y: 20 }, size: { width: 50, height: 60 } } }, "position → x, y"],
  ["an hsl colour", { op: "add_layer", layerType: "rectangle", name: "r9", properties: { fill: "hsl(200, 80%, 50%)" } }, 'fill "hsl(200, 80%, 50%)" → #19a1e6'],
  ["a CSS gradient", { op: "add_layer", layerType: "rectangle", name: "r10", properties: { fill: "linear-gradient(90deg, #ff0000, #0000ff)" } }, 'fill CSS gradient → {type:"linear", angle:0, 2 stops}'],
  ["font for fontFamily", { op: "add_layer", layerType: "text", name: "t6", properties: { text: "Hi", font: "Inter" } }, "font → fontFamily"],
  ["a clip speed as text", { op: "update_layer", layer: "clip", properties: { mediaSpeed: "0.5x" } }, 'mediaSpeed "0.5x" → 0.5'],
  ["the speed preset with a value", { op: "add_animation", layer: "clip", preset: "speed", start: 1, duration: 0.5, parameters: { speed: 0.5 } }, 'speed with values → animation {kind:"custom", name:"Speed", from, to}'],
  ["degrees",{ op: "add_layer", layerType: "rectangle", name: "r11", properties: { rotation: "45deg" } }, 'rotation "45deg" → 45'],
  ["animations as one object", { op: "add_layer", layerType: "rectangle", name: "r12", animations: { preset: "preset-fade", start: 0, duration: 0.5 } }, "animations {…} → [{…}]"],
  ["text content", { op: "add_layer", layerType: "text", name: "t8", properties: { content: "Hi" } }, "content → text"],
  ["add_text", { op: "add_text", name: "t7", text: "Hi", x: 10, y: 10 }, "op add_text → add_layer (layerType text)"],
  ["animate", { op: "animate", layer: "box", preset: "preset-fade", start: 0, duration: 0.5 }, "op animate → add_animation"],
  ["move with parameters", { op: "add_animation", layer: "box", preset: "move", start: 0, duration: 6, parameters: { x: 1600 } }, 'move with values → animation {kind:"custom", name:"Move", from, to}'],
  ["a preset inside animation", { op: "add_animation", layer: "box", animation: { preset: "move", start: 0, duration: 6, to: { x: 1600 } } }, "animation.preset → preset"],
  ["an animation with no kind", { op: "add_animation", layer: "box", animation: { start: 0, duration: 6, from: { x: 100 }, to: { x: 1600 } } }, "animation.kind custom (it has from/to)"],
  ["keyframes", { op: "add_animation", layer: "box", keyframes: [{ time: 0, x: 0 }, { time: 1, x: 500 }] }, 'keyframes → animation {kind:"custom", start 0, duration 1, from, to}'],
  ["from and to at the top", { op: "add_animation", layer: "box", start: 0, duration: 2, from: { x: 100 }, to: { x: 1600 } }, 'from/to → animation {kind:"custom"}'],
  ["seconds as text", { op: "add_animation", layer: "box", preset: "preset-fade", start: "0.5s", duration: "500ms" }, 'duration "500ms" → 0.5'],
  ["fadeIn", { op: "add_animation", layer: "box", preset: "fadeIn", start: 0, duration: 0.5 }, 'preset "fadeIn" → fade-in'],
  ["fade", { op: "add_animation", layer: "box", preset: "fade", start: 0, duration: 0.5 }, 'preset "fade" → preset-fade'],
  ["typewriter", { op: "add_animation", layer: "title", preset: "typewriter", start: 0, duration: 1 }, 'preset "typewriter" → preset-custom-text'],
  ["write-on on text", { op: "add_animation", layer: "title", preset: "write-on", start: 0, duration: 1 }, 'preset "write-on" → preset-custom-text'],
  ["trim to a value", { op: "add_animation", layer: "box", preset: "trim", start: 1, to: { strokeEnd: 0.5 } }, 'trim with values → animation {kind:"in", name:"Trim paths", from, to}'],
  ["mode exit", { op: "add_animation", layer: "box", preset: "preset-fade", mode: "exit", start: 5, duration: 0.5 }, 'mode "exit" → out'],
  ["end for duration", { op: "add_animation", layer: "box", preset: "preset-fade", start: 1, end: 2 }, "end 2 → duration 1"],
  ["delay for start", { op: "add_animation", layer: "box", preset: "preset-fade", delay: 0.5, duration: 0.5 }, "delay → start 0.5"],
  ["a top-level preset parameter", { op: "add_animation", layer: "title", preset: "preset-slide", start: 0, duration: 0.5, direction: "up" }, "direction → parameters.direction"],
  ["CSS cubic-bezier", { op: "add_animation", layer: "box", preset: "preset-fade", start: 0, duration: 0.5, easing: "cubic-bezier(0.2, 0, 0, 1)" }, 'easing "cubic-bezier(0.2, 0, 0, 1)" → [0.2, 0, 0, 1]'],
  ["target for layer", { op: "add_animation", target: "box", preset: "preset-fade", start: 0, duration: 0.5 }, "target → layer"],
  ["scale with a number", { op: "add_animation", layer: "box", preset: "scale", start: 0, duration: 1, parameters: { scale: 1.5 } }, 'scale with values → animation {kind:"custom", name:"Scale", from, to}'],
  ["update_scene fields at the top", { op: "update_scene", duration: 8, background: "black" }, "duration → properties.duration"],
  ["a scene duration as text", { op: "update_scene", properties: { duration: "8s" } }, 'duration "8s" → 8'],
  ["set_font font", { op: "set_font", layer: "title", font: "Inter", weight: 700 }, "font → family"],
  ["update_layer by name", { op: "update_layer", name: "box", properties: { fill: "#000000" } }, "name → layer"],
  ["reorder_layer index for to", { op: "reorder_layer", layer: "box", index: 0 }, "index → to"],
  ["remove_layer", { op: "remove_layer", layer: "box" }, "op remove_layer → delete_layer"],
  ["delete_layer with a list", { op: "delete_layer", layers: ["box", "title"] }, "delete_layer {layers:[2]} → 2 delete_layer ops"],
  ["stagger over layers", { op: "stagger_animations", layers: ["box", "title"], delay: 0.1 }, "layers → items"],
  ["place one layer", { op: "place", layer: "box", slot: "center" }, "layer → layers [ … ]"],
  ["update_animation fields at the top", { op: "update_animation", animation: "box.in", start: 1, duration: 0.8 }, "start, duration → properties"],
  ["a scene size as text", { op: "add_scene", name: "vertical", size: "1080x1920", duration: 6 }, 'size "1080x1920" → width 1080, height 1920'],
  ["move_layer", { op: "move_layer", layer: "box", x: 500 }, "op move_layer → update_layer"],
  ["set_text", { op: "set_text", layer: "title", text: "Hi there" }, "op set_text → update_layer"],
  ["CSS left and top", { op: "update_layer", layer: "box", properties: { left: 40, top: 60 } }, "left → x"],
  ["a CSS property name", { op: "update_layer", layer: "title", properties: { "font-size": "80px" } }, "font-size → fontSize"],
  ["bloom for glow", { op: "add_animation", layer: "box", effect: "bloom", parameters: { strength: 1 } }, 'effect "bloom" → glow'],
  ["film grain for grain", { op: "add_animation", layer: "box", effect: "film grain", parameters: { amount: 0.3 } }, 'effect "film grain" → grain'],
  ["an effect name with a space", { op: "add_animation", layer: "box", effect: "god rays" }, 'effect "god rays" → light-rays'],
  ["an effect as preset:effect:", { op: "add_animation", layer: "box", preset: "effect:flare" }, 'preset "effect:flare" → effect:lens-flare'],
  ["an effect as a preset", { op: "add_animation", layer: "box", preset: "glow", parameters: { strength: 2 } }, 'preset "glow" → effect glow'],
  ["an effect inside add_layer", { op: "add_layer", layerType: "rectangle", name: "r13", animations: [{ effect: "chromatic aberration" }] }, 'effect "chromatic aberration" → rgb-shift'],
  // kind next to a preset or an effect (it was refused: '"kind" is not a field of add_animation.
  // Did you mean id, at, easing?').
  ["kind in with a preset", { op: "add_animation", layer: "box", preset: "preset-fade", kind: "in", start: 0, duration: 0.5 }, 'kind "in" dropped (a preset is an entrance unless mode is "out")'],
  ["kind out with a preset", { op: "add_animation", layer: "box", preset: "preset-fade", kind: "out", start: 5, duration: 0.5 }, 'kind "out" → mode "out"'],
  ["kind exit inside add_layer", { op: "add_layer", layerType: "rectangle", name: "r14", animations: [{ preset: "preset-slide", kind: "exit", start: 5, duration: 0.5 }] }, 'kind "exit" → mode "out"'],
  ["kind effect with an effect", { op: "add_animation", layer: "box", effect: "glow", kind: "effect" }, 'kind "effect" dropped (an effect takes no kind)'],
  ["kind naming the preset", { op: "add_animation", layer: "box", preset: "preset-fade", kind: "fade" }, 'kind "fade" dropped (a preset takes no kind)'],
  ["kind out beside from and to", { op: "add_animation", layer: "box", kind: "out", start: 5, duration: 0.5, from: { opacity: 1 }, to: { opacity: 0 } }, 'from/to → animation {kind:"out"}'],
  ["a src ending in a full stop", { op: "add_layer", layerType: "image", name: "pic", properties: { src: "/api/media/0123abcd-0000-4000-8000-000000000001.png." } },
    'src "/api/media/0123abcd-0000-4000-8000-000000000001.png." → "/api/media/0123abcd-0000-4000-8000-000000000001.png"'],
];

test("a common mistake kino can read one way only is fixed and listed in fixed", { timeout: 120_000 }, async () => {
  await project("fixed");
  const problems = [];
  for (const [what, op, line] of FIXED) {
    const reply = await agent("edit", { project: "fixed", ops: [op], dry_run: true });
    if (reply.isError) problems.push(`${what}: refused: ${reply.text}`);
    else if (!reply.data.fixed?.includes(line)) problems.push(`${what}: fixed is ${JSON.stringify(reply.data.fixed)}, not ${line}`);
    else if (estimateTextTokens(reply.text) > 200) problems.push(`${what}: ${estimateTextTokens(reply.text)} tokens`);
  }
  assert.deepEqual(problems, []);
});

test("the fixed animations are the ones the agent meant", async () => {
  await project("meant");
  const reply = await agent("edit", { project: "meant", ops: [
    { op: "add_animation", layer: "box", preset: "move", start: 0, duration: 6, parameters: { x: 1600 } },
    { op: "add_animation", layer: "title", animation: { start: 1, duration: 2, from: { opacity: 0 }, to: { opacity: 1 } } },
    { op: "add_animation", layer: "title", animation: { kind: "custom", start: 1, duration: 2, to: { y: 600 } } },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.ok(!reply.data.fixed.some((line) => /animation\.from/.test(line)), "from left out is documented, so it is not a fix");
  const record = await saved("meant");
  const box = layerNamed(record, "box");
  const move = box.animations.at(-1);
  assert.deepEqual([move.kind, move.name, move.start, move.duration, move.from, move.to], ["custom", "Move", 0, 6, { x: 100 }, { x: 1600 }], "a move starts where the layer is");
  const title = layerNamed(record, "title");
  const [fade, rise] = title.animations.slice(-2);
  assert.deepEqual([fade.kind, fade.start, fade.duration, fade.from, fade.to], ["custom", 1, 2, { opacity: 0 }, { opacity: 1 }]);
  assert.deepEqual([rise.from, rise.to], [{ y: 400 }, { y: 600 }], "from left out is the layer's own y");
  // It starts at the layer's own y (400) and ends at 600; the move goes from 100 to 1600.
  assert.equal(evaluateLayer(title, 1).y, 400);
  assert.equal(evaluateLayer(title, 3).y, 600);
  assert.equal(evaluateLayer(box, 0).x, 100);
  assert.equal(evaluateLayer(box, 6).x, 1600);
});

// kind:"out" next to a preset was refused, and inside animation:{preset, kind:"out"} it was
// dropped, so the exit was saved as an entrance (a fade in at the end of the scene).
test("kind out next to a preset makes an exit, at the top, inside animation and inside add_layer", async () => {
  await project("kinds");
  const reply = await agent("edit", { project: "kinds", ops: [
    { op: "add_animation", layer: "box", preset: "preset-fade", kind: "out", start: 5, duration: 0.5 },
    { op: "add_animation", layer: "title", animation: { preset: "preset-fade", kind: "out", start: 5, duration: 0.5 } },
    { op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 900, y: 100, width: 200, height: 200 }, animations: [{ preset: "preset-fade", kind: "out", start: 5, duration: 0.5 }] },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  const record = await saved("kinds");
  for (const name of ["box", "title", "card"]) {
    const layer = layerNamed(record, name);
    const exit = layer.animations.at(-1);
    assert.equal(exit.kind, "out", `${name}: ${JSON.stringify(exit)}`);
    assert.equal(evaluateLayer(layer, 4).opacity, 1, `${name} shows before its exit`);
    assert.equal(evaluateLayer(layer, 5.6).opacity, 0, `${name} is gone after its exit`);
  }
});

// preset-custom-text needs text: true in the catalog, and the check once refused it as unknown
// ("Did you mean preset-custom-text"), with typewriter and type-on, which stand for it.
test("preset-custom-text animates a text layer's letters; on another layer the refusal says it needs text", async () => {
  await project("letters");
  const reply = await agent("edit", { project: "letters", ops: [{ op: "add_animation", layer: "title", preset: "preset-custom-text", start: 0, duration: 1 }] });
  assert.equal(reply.isError, undefined, reply.text);
  const added = layerNamed(await saved("letters"), "title").animations.at(-1);
  assert.equal(added.preset?.id, "custom-text", JSON.stringify(added));
  assert.equal(added.preset?.text, true);
  const box = await agent("edit", { project: "letters", ops: [{ op: "add_animation", layer: "box", preset: "preset-custom-text", start: 0, duration: 1 }] });
  assert.equal(box.isError, true);
  assert.match(box.text, /preset-custom-text animates the letters of a text layer; this layer is a rectangle/);
  // unit, stagger and order are add_animation overrides on text (a word-by-word reveal in one op),
  // and are refused with the reason on another layer.
  const words = await agent("edit", { project: "letters", ops: [{ op: "add_animation", layer: "title", preset: "preset-custom-text", start: 0, duration: 1, unit: "words", stagger: 0.27, order: "reverse", smoothing: "linear" }] });
  assert.equal(words.isError, undefined, words.text);
  const reveal = layerNamed(await saved("letters"), "title").animations.at(-1);
  assert.deepEqual([reveal.unit, reveal.stagger, reveal.order, reveal.smoothing], ["words", 0.27, "reverse", "linear"]);
  const shape = await agent("edit", { project: "letters", ops: [{ op: "add_animation", layer: "box", preset: "preset-fade", start: 0, duration: 1, unit: "words", stagger: 0.2 }] });
  assert.equal(shape.isError, true);
  assert.match(shape.text, /unit, stagger space a text layer's letters, words or lines; box is a rectangle layer/);
});

// Masking a clip in a group: a mask with nothing to mask yet. Moving the clip above it is refused
// (it would mask by accident), and the refusal's next is the same move with mask:true, which works.
test("move_layers under a waiting mask needs mask:true, and the refusal's next sends it", async () => {
  await project("maskmove");
  const made = await agent("edit", { project: "maskmove", ops: [
    { op: "add_layer", layerType: "group", name: "frame", properties: { x: 0, y: 0, width: 1920, height: 1080 } },
    { op: "add_layer", layerType: "rectangle", name: "window", properties: { parentId: "frame", isMask: true, x: 100, y: 100, width: 600, height: 400 } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const move = { op: "move_layers", layers: ["clip"], position: "above", referenceId: "window" };
  const refused = await agent("edit", { project: "maskmove", ops: [move] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /the mask “window” would start masking “clip”\. To mask it on purpose, send the same move with mask: true/);
  const next = nextCallOf(refused);
  assert.deepEqual(next?.input?.fix?.["0"], { ...move, mask: true }, refused.text);
  const done = await agent("edit", { project: "maskmove", ...next.input });
  assert.equal(done.isError, undefined, done.text);
  const layers = (await saved("maskmove")).document.scenes[0].layers;
  assert.deepEqual(layers.filter((layer) => layer.parentId === layers.find((item) => item.name === "frame").id).map((layer) => layer.name), ["window", "clip"]);
});

// [what the agent sent, one op, words the reason must have, ops the example follows]
const REFUSED = [
  ["x in percent", { op: "add_layer", layerType: "rectangle", name: "r5", properties: { x: "50%" } }, "then place it", [{ op: "add_layer", layerType: "rectangle", name: "r5" }]],
  ["a file on this computer as src", { op: "add_layer", layerType: "image", name: "logo", properties: { src: "/Users/someone/logo.png" } }, 'project {action:"import", file:"/Users/someone/logo.png"}'],
  ["keyframes with no times", { op: "add_animation", layer: "box", keyframes: [{ x: 0 }, { x: 200 }, { x: 500 }] }, "keyframes"],
  ["update_layer with no layer", { op: "update_layer", properties: { fill: "#000000" } }, "needs layer"],
  ["an unknown preset", { op: "add_animation", layer: "box", preset: "wobble", start: 0, duration: 1 }, "unknown animation preset"],
  ["move with a value it does not animate", { op: "add_animation", layer: "box", preset: "move", start: 0, duration: 1, to: { width: 400 } }, "move animates x, y"],
  ["a catalog preset with to", { op: "add_animation", layer: "box", preset: "preset-fade", start: 0, duration: 1, to: { opacity: 0.5 } }, "takes parameters, not from/to"],
  ["an unknown add_animation field", { op: "add_animation", layer: "box", preset: "preset-fade", start: 0, duration: 1, speed: 2 }, '"speed" is not a field'],
  ["an add_layer with no type", { op: "add_layer", name: "thing", properties: { x: 10 } }, "layerType"],
  ["motion-blur as an effect", { op: "add_animation", layer: "box", effect: "motion-blur" }, "render option"],
  ["radial-blur as an effect", { op: "add_animation", layer: "box", effect: "radial blur" }, "zoom-blur"],
  ["an unknown effect", { op: "add_animation", layer: "box", effect: "sparkle" }, 'unknown effect "sparkle". Did you mean sparks'],
  // Effect names guessed from plain words lead to the real grading effects (ceiling study a, FRICTION 5).
  ["color-correct as an effect", { op: "add_animation", layer: "box", effect: "color-correct" }, "color-grade"],
  ["brightness as an effect", { op: "add_animation", layer: "box", effect: "brightness" }, "color-grade"],
  ["a bare file name as src", { op: "add_layer", layerType: "image", name: "logo2", properties: { src: "logo.png." } }, 'src "logo.png" is not an imported file'],
  ["a web address as src", { op: "add_layer", layerType: "image", name: "logo3", properties: { src: "https://example.com/logo.png" } }, "is on the web"],
  ["kind custom with a preset", { op: "add_animation", layer: "box", preset: "preset-fade", kind: "custom" }, 'kind "custom" does not go with a preset. A preset takes mode'],
  ["kind in with an effect", { op: "add_animation", layer: "box", effect: "glow", kind: "in" }, 'kind "in" does not go with an effect'],
  ["kind out and mode in", { op: "add_animation", layer: "box", preset: "preset-fade", kind: "out", mode: "in", start: 4 }, 'kind "out" and mode "in" disagree'],
  ["kind out with hide", { op: "add_animation", layer: "box", preset: "hide", kind: "out", start: 2 }, "hide has no in or out"],
  // A media layer with no file used to be saved; only check said something, and blamed itself.
  ["a video with no src", { op: "add_layer", layerType: "video", name: "build-target", properties: { x: 0, y: 0, width: 640, height: 360, mediaSourceDuration: 3.8, volume: 0 } }, 'video layer "build-target" has no src'],
  ["an image with an empty src", { op: "add_layer", layerType: "image", name: "logo4", properties: { src: " " } }, 'image layer "logo4" has no src'],
  ["an audio layer with no properties", { op: "add_layer", layerType: "audio", name: "music" }, 'audio layer "music" has no src'],
];

test("any other mistake is refused with one short example that works", { timeout: 120_000 }, async () => {
  await project("refused");
  const problems = [];
  for (const [what, op, word, first = []] of REFUSED) {
    const reply = await agent("edit", { project: "refused", ops: [op], dry_run: true });
    if (!reply.isError) { problems.push(`${what}: not refused`); continue; }
    if (!reply.data.reason.includes(word)) problems.push(`${what}: reason "${reply.data.reason}" does not say ${word}`);
    if (estimateTextTokens(reply.text) >= 400) problems.push(`${what}: ${estimateTextTokens(reply.text)} tokens`);
    if (!reply.data.example) { problems.push(`${what}: no example`); continue; }
    const tried = await agent("edit", { project: "refused", ops: [...first, reply.data.example], dry_run: true });
    if (tried.isError) problems.push(`${what}: its example ${JSON.stringify(reply.data.example)} is refused: ${tried.text}`);
  }
  assert.deepEqual(problems, []);
  // An unknown layer property: the example is the agent's own op without it (the usual example
  // set the title's color and size, which nobody asked for).
  const unknown = await agent("edit", { project: "refused", ops: [{ op: "update_layer", layer: "box", properties: { x: 250, glowiness: 3 } }], dry_run: true });
  assert.deepEqual(unknown.data.example, { op: "update_layer", layer: "box", properties: { x: 250 } });
  // A guessed effect name keeps the settings the real effect has; a negative "1 = unchanged"
  // setting comes back as its relative text, which is taken (ceiling studies a and c).
  const guessed = await agent("edit", { project: "refused", ops: [{ op: "add_animation", layer: "box", effect: "brightness", parameters: { brightness: 1.3 } }], dry_run: true });
  assert.deepEqual(guessed.data.example, { op: "add_animation", layer: "box", effect: "color-grade", parameters: { brightness: 1.3 } });
  const negative = await agent("edit", { project: "refused", ops: [{ op: "add_animation", layer: "box", effect: "hue-saturation", parameters: { saturation: -0.7 } }], dry_run: true });
  assert.deepEqual(negative.data.example.parameters, { saturation: "-0.7" });
  assert.equal((await agent("edit", { project: "refused", ops: [negative.data.example], dry_run: true })).isError, undefined);
});

test("update_layer cannot clear a media layer's src; other layers and other fields are not affected", async () => {
  await project("clear-src");
  for (const src of ["", null]) {
    const reply = await agent("edit", { project: "clear-src", ops: [{ op: "update_layer", layer: "clip", properties: { src } }], dry_run: true });
    assert.equal(reply.isError, true, `src ${JSON.stringify(src)} is refused`);
    assert.match(reply.data.reason, /cannot clear the src of video layer "clip"/);
    assert.match(reply.data.reason, /delete_layer/);
  }
  const moved = await agent("edit", { project: "clear-src", ops: [{ op: "update_layer", layer: "clip", properties: { x: 10 } }, { op: "update_layer", layer: "box", properties: { x: 20 } }] });
  assert.equal(moved.isError, undefined, moved.text);
  const record = await saved("clear-src");
  assert.equal(layerNamed(record, "clip").src, "/api/media/clip.mp4", "nothing cleared it");
});

// colour (and colour at the top level of update_layer) was refused with "Did you mean blur,
// donut, role?" although color → fill was fixed; now every color name is also read as colour.
test("colour, textColour and a top-level color or font are read as edit reads color and font", async () => {
  await project("colour");
  for (const [op, fixed] of [
    [{ op: "update_layer", layer: "title", properties: { colour: "#ff0000" } }, ["colour → fill"]],
    [{ op: "update_layer", layer: "title", properties: { textColour: "#ff0000" } }, ["textColour → fill"]],
    [{ op: "update_layer", layer: "title", colour: "#ff0000", font: "Montserrat" }, ["colour → properties.colour", "font → properties.font", "colour → fill", "font → fontFamily"]],
  ]) {
    const reply = await agent("edit", { project: "colour", ops: [op], dry_run: true });
    assert.equal(reply.isError, undefined, reply.text);
    assert.deepEqual(reply.data.fixed, fixed);
  }
});

// update_layer {layer:"box", align:"center"} on a rectangle answered fixed ["align →
// properties.align", "align → textAlign"]: a text setting saved on a rectangle, and nothing
// moved. align, font and the other text names now fit text layers only; on another layer they
// are refused, and align points to align_layers.
test("align, font and family on a layer that is not text are refused, and align points to align_layers", async () => {
  await project("aligns");
  for (const op of [
    { op: "update_layer", layer: "box", align: "center" },
    { op: "update_layer", layer: "box", properties: { align: "center" } },
    { op: "update_layer", layer: "box", textAlignment: "center" },
  ]) {
    const reply = await agent("edit", { project: "aligns", ops: [op], dry_run: true });
    assert.equal(reply.isError, true, JSON.stringify(op));
    assert.match(reply.data.reason, /is textAlign, which only text layers use; "box" is a rectangle\. .*align_layers/, reply.text);
    assert.deepEqual(reply.data.example, { op: "align_layers", layers: ["box"], align: "center" });
    const tried = await agent("edit", { project: "aligns", ops: [reply.data.example], dry_run: true });
    assert.equal(tried.isError, undefined, tried.text);
  }
  for (const [op, field] of [
    [{ op: "update_layer", layer: "box", family: "Inter" }, "fontFamily"],
    [{ op: "update_layer", layer: "box", properties: { font: "Inter" } }, "fontFamily"],
    [{ op: "update_layer", layer: "box", weight: 700 }, "fontWeight"],
  ]) {
    const reply = await agent("edit", { project: "aligns", ops: [op], dry_run: true });
    assert.equal(reply.isError, true, JSON.stringify(op));
    assert.match(reply.data.reason, new RegExp(`is ${field}, which only text layers use; "box" is a rectangle\\.`), reply.text);
    assert.equal(reply.data.example, undefined, "no example that sets a font size on a rectangle");
  }
  // On a text layer they are still read as its fields.
  const text = await agent("edit", { project: "aligns", ops: [{ op: "update_layer", layer: "title", align: "center", family: "Inter" }], dry_run: true });
  assert.equal(text.isError, undefined, text.text);
  assert.deepEqual(text.data.fixed, ["align → properties.align", "family → properties.family", "family → fontFamily", "align → textAlign"]);
});

// add_layer card (a rectangle) and then update_layer card {align:"center"} in one edit saved
// textAlign on the rectangle: the type check read layer types from the saved document only, so a
// layer added earlier in the same edit had no type and every text name fitted it.
test("align or family on a layer added earlier in the same edit is refused as it is in a later edit", async () => {
  await project("aligns2");
  const card = { op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 0, y: 0, width: 100, height: 100 } };
  const cases = [
    [{ op: "update_layer", layer: "card", align: "center" }, /^Operation 1 \(update_layer\): "align" is textAlign, which only text layers use; "card" is a rectangle\. .*align_layers/],
    [{ op: "update_layer", layer: "card", properties: { family: "Inter" } }, /^Operation 1 \(update_layer\): "family" is fontFamily, which only text layers use; "card" is a rectangle\.$/],
  ];
  const sameEdit = [];
  for (const [op, reason] of cases) {
    const reply = await agent("edit", { project: "aligns2", ops: [card, op] });
    assert.equal(reply.isError, true, JSON.stringify(op));
    assert.match(reply.data.reason, reason, reply.text);
    sameEdit.push(reply);
  }
  assert.deepEqual(sameEdit[0].data.example, { op: "align_layers", layers: ["card"], align: "center" });
  assert.equal(sameEdit[1].data.example, undefined);
  assert.equal(layerNamed(await saved("aligns2"), "card"), undefined, "a refused edit saves nothing");
  // The same refusal as when the rectangle was added by an earlier edit.
  const added = await agent("edit", { project: "aligns2", ops: [card] });
  assert.equal(added.isError, undefined, added.text);
  for (const [index, [op]] of cases.entries()) {
    const later = await agent("edit", { project: "aligns2", ops: [op] });
    assert.equal(later.data.reason.replace(/^Operation 0/, "Operation 1"), sameEdit[index].data.reason);
    assert.deepEqual(later.data.example, sameEdit[index].data.example);
  }
  // A group made earlier in the edit is no text layer either.
  const group = await agent("edit", { project: "aligns2", ops: [
    { op: "group_layers", layers: ["box", "card"], name: "pair" },
    { op: "update_layer", layer: "pair", properties: { font: "Inter" } },
  ] });
  assert.equal(group.isError, true);
  assert.match(group.data.reason, /"font" is fontFamily, which only text layers use; "pair" is a group\./);
  // A text layer added earlier in the edit still takes them as its fields.
  const text = await agent("edit", { project: "aligns2", ops: [
    { op: "add_layer", layerType: "text", name: "note", properties: { text: "Hi", x: 0, y: 0 } },
    { op: "update_layer", layer: "note", align: "center", family: "Inter" },
  ] });
  assert.equal(text.isError, undefined, text.text);
  const note = layerNamed(await saved("aligns2"), "note");
  assert.deepEqual([note.textAlign, note.fontFamily], ["center", "Inter"]);
});

// edit read size and position inside properties, but inspect said "size: not a layer field. Did
// you mean fill, id, name?", a top-level size on update_layer was refused the same way, and a
// size of one number on a rectangle was "not a layer property".
test("size, position and scale: inspect names the fields edit sets, and update_layer takes them at the top level", async () => {
  await project("pairs");
  const shown = await agent("inspect", { project: "pairs", targets: ["title", "box"], fields: ["size", "position", "position.x", "scale"] });
  assert.equal(shown.text.split("\n").slice(1, -1).join("\n"), [
    "L2 title text in s1",
    "  size: on a text layer one number is fontSize and two are width and height. fontSize 96 · width 800 · height 120",
    "  position: the fields are x and y. x 200 · y 400",
    "  position.x: the field is x. x 200",
    "  scale: the fields are scaleX and scaleY; one number sets both. scaleX 1 · scaleY 1",
    "L1 box rectangle in s1",
    "  size: the fields are width and height. width 200 · height 200",
    "  position: the fields are x and y. x 100 · y 100",
    "  position.x: the field is x. x 100",
    "  scale: the fields are scaleX and scaleY; one number sets both. scaleX 1 · scaleY 1",
  ].join("\n"));

  const text = await agent("edit", { project: "pairs", ops: [{ op: "update_layer", layer: "title", size: 60 }] });
  assert.equal(text.isError, undefined, text.text);
  assert.deepEqual(text.data.fixed, ["size → properties.size", "size → fontSize"]);
  const box = await agent("edit", { project: "pairs", ops: [{ op: "update_layer", layer: "box", position: [50, 60], size: [300, 120], scale: 1.2 }] });
  assert.equal(box.isError, undefined, box.text);
  const record = await saved("pairs");
  assert.equal(layerNamed(record, "title").fontSize, 60);
  const moved = layerNamed(record, "box");
  assert.deepEqual([moved.x, moved.y, moved.width, moved.height, moved.scaleX, moved.scaleY], [50, 60, 300, 120, 1.2, 1.2]);

  const one = await agent("edit", { project: "pairs", ops: [{ op: "update_layer", layer: "box", size: 60 }], dry_run: true });
  assert.equal(one.isError, true);
  assert.match(one.data.reason, /"size" is width and height on a rectangle: give both, such as "size":\[300,120\], or set width and height themselves\. On a text layer, one number is its fontSize\./);
});

// inspect title fields=size.width answered "the field is fontSize. fontSize.width null" on a text
// layer, though update_layer {size:{width, height}} sets its width and height there. scale.x was
// "not a layer field" and edit refused scale {x, y} and [x, y], though inspect named scale as
// scaleX and scaleY. size {w, h} was taken ("size → width, height") and saved nothing.
test("inspect and update_layer read every form of size, position and scale the same way, on text and other layers", async () => {
  await project("pairs2");
  const shown = await agent("inspect", { project: "pairs2", targets: ["title", "box"],
    fields: ["size", "size.width", "size.height", "size.x", "dimensions.height", "position", "position.y", "position.width", "scale", "scale.x", "scale.y"] });
  assert.equal(shown.text.split("\n").slice(1, -1).join("\n"), [
    "L2 title text in s1",
    "  size: on a text layer one number is fontSize and two are width and height. fontSize 96 · width 800 · height 120",
    "  size.width: the field is width. width 800",
    "  size.height: the field is height. height 120",
    "  size.x: size is width and height (size.width, size.height), not x.",
    "  dimensions.height: the field is height. height 120",
    "  position: the fields are x and y. x 200 · y 400",
    "  position.y: the field is y. y 400",
    "  position.width: position is x and y (position.x, position.y), not width.",
    "  scale: the fields are scaleX and scaleY; one number sets both. scaleX 1 · scaleY 1",
    "  scale.x: the field is scaleX. scaleX 1",
    "  scale.y: the field is scaleY. scaleY 1",
    "L1 box rectangle in s1",
    "  size: the fields are width and height. width 200 · height 200",
    "  size.width: the field is width. width 200",
    "  size.height: the field is height. height 200",
    "  size.x: size is width and height (size.width, size.height), not x.",
    "  dimensions.height: the field is height. height 200",
    "  position: the fields are x and y. x 100 · y 100",
    "  position.y: the field is y. y 100",
    "  position.width: position is x and y (position.x, position.y), not width.",
    "  scale: the fields are scaleX and scaleY; one number sets both. scaleX 1 · scaleY 1",
    "  scale.x: the field is scaleX. scaleX 1",
    "  scale.y: the field is scaleY. scaleY 1",
  ].join("\n"));

  // Each form sets the fields inspect names for it.
  for (const [layer, properties, expected] of [
    ["title", { size: { width: 500, height: 90 } }, { width: 500, height: 90, fontSize: 96 }],
    ["title", { size: [520, 100] }, { width: 520, height: 100 }],
    ["title", { size: 60 }, { fontSize: 60, width: 520 }],
    ["title", { size: { height: 110 } }, { width: 520, height: 110 }],
    ["box", { size: { width: 240 } }, { width: 240, height: 200 }],
    ["box", { dimensions: [250, 210] }, { width: 250, height: 210 }],
    ["box", { position: { y: 70 } }, { x: 100, y: 70 }],
    ["title", { position: [210, 410] }, { x: 210, y: 410 }],
    ["title", { scale: { x: 1.5, y: 0.5 } }, { scaleX: 1.5, scaleY: 0.5 }],
    ["box", { scale: [2, 3] }, { scaleX: 2, scaleY: 3 }],
    ["box", { scale: { y: 1.1 } }, { scaleX: 2, scaleY: 1.1 }],
    ["box", { scale: 1.25 }, { scaleX: 1.25, scaleY: 1.25 }],
  ]) {
    const reply = await agent("edit", { project: "pairs2", ops: [{ op: "update_layer", layer, properties }] });
    assert.equal(reply.isError, undefined, `${JSON.stringify(properties)}: ${reply.text}`);
    const now = layerNamed(await saved("pairs2"), layer);
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map((field) => [field, now[field]])), expected, JSON.stringify(properties));
  }

  // A part neither of them knows is refused, instead of taken and saved nowhere.
  for (const [properties, reason] of [
    [{ size: { w: 500, h: 90 } }, /"size" is width and height on a rectangle: .* "w" and "h" are not parts of it \(width and height are\)\./],
    [{ position: { left: 5 } }, /"position" is x and y on a rectangle: .* "left" is not a part of it \(x and y are\)\./],
    [{ scale: { z: 2 } }, /"scale" is scaleX and scaleY on a rectangle: .* "z" is not a part of it \(x and y are\)\./],
  ]) {
    const reply = await agent("edit", { project: "pairs2", ops: [{ op: "update_layer", layer: "box", properties }], dry_run: true });
    assert.equal(reply.isError, true, JSON.stringify(properties));
    assert.match(reply.data.reason, reason);
  }
});

// update_animation {mode:"in"} on a preset exit was refused with "Did you mean id, name, order?"
// and {direction:"left"} with "Did you mean duration, discrete, anchor?", although
// {parameters:{direction}} was already moved into the preset.
test("a preset's mode and settings sent beside the other fields go into its preset", async () => {
  await project("modes");
  const made = await agent("edit", { project: "modes", ops: [{ op: "add_animation", layer: "box", preset: "preset-slide", mode: "out", start: 4, duration: 0.5 }] });
  assert.equal(made.isError, undefined, made.text);
  const slide = () => layerNamed(record, "box").animations.find((animation) => animation.preset?.id === "slide");
  let record;
  const left = await agent("edit", { project: "modes", ops: [{ op: "update_animation", animation: "box.out", properties: { direction: "left" } }] });
  assert.equal(left.isError, undefined, left.text);
  assert.deepEqual(left.data.fixed, ["direction → preset.parameters.direction"]);
  record = await saved("modes");
  assert.deepEqual([slide().kind, slide().preset.mode, slide().preset.parameters], ["out", "out", { direction: "left", distance: 50 }]);
  const back = await agent("edit", { project: "modes", ops: [{ op: "update_animation", animation: "box.out", properties: { mode: "in", distance: 80, easing: "ease-out" } }] });
  assert.equal(back.isError, undefined, back.text);
  assert.deepEqual(back.data.fixed, ["mode → preset.mode", "distance → preset.parameters.distance"]);
  record = await saved("modes");
  assert.deepEqual([slide().kind, slide().preset.mode, slide().preset.parameters, slide().easing], ["in", "in", { direction: "left", distance: 80 }, "ease-out"]);
  // A setting the preset does not have is still refused: a fade has no direction.
  const fade = await agent("edit", { project: "modes", ops: [{ op: "update_animation", animation: "title.in", properties: { direction: "left" } }], dry_run: true });
  assert.equal(fade.isError, true, fade.text);
  assert.match(fade.data.reason, /"direction" is not a field of an in animation/);
});

// update_animation {direction:"up", to:{y:100}} on a slide exit was saved with fixed
// ["direction → preset.parameters.direction"] and the to thrown away: a preset works out its from
// and to itself. A preset change sent with from, to, kind, discrete or motionPath is refused, and
// nothing is saved; the refusal gives the op for each way, and both run.
test("a preset setting sent with from, to or kind is refused with an op for each, and nothing is saved", async () => {
  await project("mixes");
  const made = await agent("edit", { project: "mixes", ops: [{ op: "add_layer", layerType: "rectangle", name: "v", properties: { x: 600, y: 300, width: 300, height: 120 },
    animations: [{ preset: "preset-slide", mode: "out", start: 4, duration: 0.6, parameters: { direction: "down", distance: 40 } }] }] });
  assert.equal(made.isError, undefined, made.text);
  const exit = async () => layerNamed(await saved("mixes"), "v").animations[0];
  const before = await exit();
  for (const [properties, presetOnly, plain, named, values] of [
    [{ direction: "up", to: { y: 100 } }, { preset: { parameters: { direction: "up" } } }, { to: { y: 100 } }, '"direction"', "to"],
    [{ distance: 50, kind: "custom" }, { preset: { parameters: { distance: 50 } } }, { kind: "custom" }, '"distance"', "kind"],
    [{ distance: 60, from: { y: 310 }, easing: "ease-in" }, { easing: "ease-in", preset: { parameters: { distance: 60 } } }, { easing: "ease-in", from: { y: 310 } }, '"distance"', "from"],
    [{ preset: { parameters: { distance: 50 } }, to: { y: 100 } }, { preset: { parameters: { distance: 50 } } }, { to: { y: 100 } }, '"preset"', "to"],
    [{ mode: "in", from: { y: 200 }, to: { y: 300 } }, { preset: { mode: "in" } }, { from: { y: 200 }, to: { y: 300 } }, '"mode"', "from and to"],
  ]) {
    const reply = await agent("edit", { project: "mixes", ops: [{ op: "update_animation", animation: "v.out", properties }] });
    assert.equal(reply.isError, true, JSON.stringify(properties));
    assert.match(reply.data.reason, new RegExp(`^Operation 0 \\(update_animation\\): ${named} changes? the preset, which works out the animation's from and to itself, so the ${values} sent with it would be lost\\.`), reply.text);
    assert.deepEqual(reply.data.example, { op: "update_animation", animation: "v.out", properties: presetOnly }, reply.text);
    const plainOp = { op: "update_animation", animation: "v.out", properties: plain };
    assert.ok(reply.data.reason.includes(`The preset's settings alone: ${JSON.stringify(reply.data.example)}.`), reply.data.reason);
    assert.ok(reply.data.reason.includes(`which makes it a plain animation (a later preset change then needs the preset's id): ${JSON.stringify(plainOp)}`), reply.data.reason);
    assert.deepEqual(await exit(), before, "nothing was saved");
    for (const op of [reply.data.example, plainOp]) {
      const tried = await agent("edit", { project: "mixes", ops: [op], dry_run: true });
      assert.equal(tried.isError, undefined, `${JSON.stringify(op)}: ${tried.text}`);
    }
  }
  // update_animations is refused the same way.
  const many = await agent("edit", { project: "mixes", ops: [{ op: "update_animations", animationIds: ["v.out"], properties: { direction: "up", to: { y: 100 } } }] });
  assert.equal(many.isError, true, many.text);
  assert.match(many.data.reason, /would be lost/);
  assert.deepEqual(many.data.example, { op: "update_animations", animationIds: ["v.out"], properties: { preset: { parameters: { direction: "up" } } } });
  // A key that is not a field is named, and left out of both ops.
  const loose = await agent("edit", { project: "mixes", ops: [{ op: "update_animation", animation: "v.out", properties: { direction: "up", to: { y: 100 }, loop: true } }] });
  assert.ok(loose.data.reason.endsWith(`{"to":{"y":100}}}. "loop" is not a field of an animation, so both leave it out.`), loose.text);
  assert.deepEqual(loose.data.example.properties, { preset: { parameters: { direction: "up" } } });
  // The plain op keeps every value it was sent and is no longer a preset.
  const plain = await agent("edit", { project: "mixes", ops: [{ op: "update_animation", animation: "v.out", properties: { to: { y: 100 } } }] });
  assert.equal(plain.isError, undefined, plain.text);
  const after = await exit();
  assert.deepEqual([after.to, after.preset], [{ y: 100 }, undefined]);
  // On the plain animation a preset change with a to is refused because it is not a preset; the
  // op that makes it one again leaves the to out, and the reason gives the op that keeps it.
  const again = await agent("edit", { project: "mixes", ops: [{ op: "update_animation", animation: "v.out", properties: { preset: { parameters: { distance: 80 } }, to: { y: 5 } } }], dry_run: true });
  assert.equal(again.isError, true, again.text);
  assert.equal(again.data.example.properties.to, undefined, again.text);
  assert.ok(again.data.reason.endsWith(`To keep it plain with your to, leave out preset: ${JSON.stringify({ op: "update_animation", animation: "v.out", properties: { to: { y: 5 } } })}`), again.data.reason);
  const tried = await agent("edit", { project: "mixes", ops: [again.data.example], dry_run: true });
  assert.equal(tried.isError, undefined, tried.text);
  // Preset settings sent alone still go into the preset.
  await agent("edit", { project: "mixes", ops: [{ op: "update_animation", animation: "v.out", properties: { preset: { id: "slide", mode: "out", parameters: { direction: "down", distance: 40 } } } }] });
  const alone = await agent("edit", { project: "mixes", ops: [{ op: "update_animation", animation: "v.out", properties: { direction: "up", easing: "ease-in" } }] });
  assert.equal(alone.isError, undefined, alone.text);
  assert.deepEqual(alone.data.fixed, ["direction → preset.parameters.direction"]);
  assert.deepEqual((await exit()).preset.parameters, { direction: "up", distance: 40 });
});

// The example for kind "out" next to mode "in" was {preset, start:0, duration:0.5, mode:"out"}:
// an agent that copied it put the exit at 0 s instead of 4 s. It now keeps what was sent.
test("a kind that disagrees with mode, or does not go with a preset, is refused with an example that keeps the sent times and settings", async () => {
  await project("kinds");
  const sent = { start: 4, duration: 0.6, easing: "ease-in", parameters: { direction: "left", distance: 50 } };
  for (const op of [
    { op: "add_animation", layer: "box", preset: "slide", kind: "out", mode: "in", ...sent },
    { op: "add_animation", layer: "box", preset: "slide", kind: "custom", ...sent },
  ]) {
    const reply = await agent("edit", { project: "kinds", ops: [op], dry_run: true });
    assert.equal(reply.isError, true, JSON.stringify(op));
    assert.deepEqual(reply.data.example, { op: "add_animation", layer: "box", preset: "preset-slide", ...sent, mode: "out" }, reply.text);
    const tried = await agent("edit", { project: "kinds", ops: [reply.data.example], dry_run: true });
    assert.equal(tried.isError, undefined, tried.text);
  }
});

test("an effect's settings sent as parameters on update_animation go in to, and the others stay", async () => {
  await project("settings");
  const added = await agent("edit", { project: "settings", ops: [{ op: "add_animation", layer: "box", effect: "glow", parameters: { strength: 1, radius: 12 } }] });
  assert.equal(added.isError, undefined, added.text);
  const reply = await agent("edit", { project: "settings", ops: [{ op: "update_animation", layer: "box", animation: "box.effect", parameters: { strength: 3 } }] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.ok(reply.data.fixed.includes("parameters → to (an effect's settings)"), JSON.stringify(reply.data.fixed));
  const glow = layerNamed(await saved("settings"), "box").animations.find((animation) => animation.effect === "glow");
  assert.deepEqual([glow.to.strength, glow.to.radius], [3, 12], "the other settings stay");
  const to = await agent("edit", { project: "settings", ops: [{ op: "update_animation", layer: "box", animation: "box.effect", properties: { to: { radius: 30 } } }] });
  assert.equal(to.isError, undefined, to.text);
  const after = layerNamed(await saved("settings"), "box").animations.find((animation) => animation.effect === "glow");
  assert.deepEqual([after.to.strength, after.to.radius], [3, 30], "to changes only the settings it names");
  // A preset animation keeps its parameters.
  const fade = await agent("edit", { project: "settings", ops: [{ op: "update_animation", layer: "box", animation: "box.in", properties: { parameters: {} } }], dry_run: true });
  assert.ok(!fade.data?.fixed?.some((line) => line.startsWith("parameters → to")), fade.text);
});

test("an effect's settings named beside start and duration are refused with the op that puts them in to", async () => {
  await project("loose-settings");
  const added = await agent("edit", { project: "loose-settings", ops: [{ op: "add_animation", layer: "box", effect: "color-wheels", parameters: { gamma: 0.9, gainBlue: 0.05 } }] });
  assert.equal(added.isError, undefined, added.text);
  const code = added.data.created["box.effect"];
  // What an agent sent: once "gamma is not an effect animation field", with an example
  // about start and duration.
  const reply = await agent("edit", { project: "loose-settings", ops: [{ op: "update_animation", animationId: code, properties: { gamma: 0.6 } }] });
  assert.equal(reply.isError, true);
  assert.match(reply.data.reason, /gamma is a color-wheels setting, not an animation field/);
  assert.match(reply.data.reason, /properties\.to \(the values it ends at\) and properties\.from \(where it starts\)/);
  assert.deepEqual(reply.data.example, { op: "update_animation", animation: code, properties: { to: { gamma: 0.6 } } });
  // Other fields stay in the example; a name that is neither a setting nor a field lists both.
  const mixed = await agent("edit", { project: "loose-settings", ops: [{ op: "update_animation", animation: "box.effect", properties: { gamma: 0.6, saturation: 1.2, duration: 2 } }] });
  assert.equal(mixed.isError, true);
  assert.match(mixed.data.reason, /saturation is neither a color-wheels setting nor an animation field \(its settings: lift, .*gamma, .*; fields: name, start, duration, easing, /);
  assert.deepEqual(mixed.data.example, { op: "update_animation", animation: "box.effect", properties: { duration: 2, to: { gamma: 0.6 } } });
  // update_animations replaces all of to, so its refusal gives update_animation, which keeps
  // the other settings (the engine's message is the same for any other path).
  const many = await agent("edit", { project: "loose-settings", ops: [{ op: "update_animations", animationIds: [code], properties: { gamma: 0.6 } }] });
  assert.match(many.data.reason, /gamma is a color-wheels setting, not an animation field\. .* update_animations replaces all of to, so send one update_animation for each effect/);
  assert.deepEqual(many.data.example, { op: "update_animation", animation: code, properties: { to: { gamma: 0.6 } } });
  // The example works and keeps the other settings.
  const sent = await agent("edit", { project: "loose-settings", ops: [reply.data.example] });
  assert.equal(sent.isError, undefined, sent.text);
  assert.equal(sent.data.fixed, undefined);
  const wheels = layerNamed(await saved("loose-settings"), "box").animations.find((animation) => animation.effect === "color-wheels");
  assert.deepEqual([wheels.to.gamma, wheels.to.gainBlue], [0.6, 0.05]);
});

// From a review of agent edits: {"Easing":"smooth"}, {"dur":2} or {"saturation":0.5} gave the
// example {"op":"update_animation","animation":"A1","properties":{}}, which is accepted and
// changes nothing, and named the closest effect settings for what was a mistyped field; a loose
// key replaced a `to` value that was sent; and "box.effect" on a layer with several effects
// answered only "No animation".
test("a mistyped field on an effect is named as that field, an empty example is never sent, and a sent to wins", async () => {
  await project("loose-fields");
  const added = await agent("edit", { project: "loose-fields", ops: [{ op: "add_animation", layer: "box", effect: "color-wheels", parameters: { gamma: 0.9 } }] });
  assert.equal(added.isError, undefined, added.text);
  const code = added.data.created["box.effect"];
  const refused = async (properties) => {
    const reply = await agent("edit", { project: "loose-fields", ops: [{ op: "update_animation", animation: code, properties }], dry_run: true });
    assert.equal(reply.isError, true, JSON.stringify(properties));
    return reply.data;
  };
  const easing = await refused({ Easing: "smooth" });
  assert.match(easing.reason, /Easing is not an effect animation field\. Did you mean easing\?$/);
  assert.deepEqual(easing.example, { op: "update_animation", animation: code, properties: { easing: "smooth" } });
  const duration = await refused({ dur: 2, Gamma: 0.6 });
  assert.match(duration.reason, /dur is not an effect animation field\. Did you mean duration\? Gamma is not a color-wheels setting or an animation field\. Did you mean the setting gamma\? An effect's settings go in properties\.to/);
  assert.deepEqual(duration.example, { op: "update_animation", animation: code, properties: { duration: 2, to: { gamma: 0.6 } } });
  const nothing = await refused({ saturation: 0.5 });
  assert.match(nothing.reason, /saturation is neither a color-wheels setting nor an animation field/);
  assert.equal(nothing.example, undefined, "no op could do what was sent");
  const both = await refused({ to: { gamma: 0.7 }, gamma: 0.5 });
  assert.deepEqual(both.example, { op: "update_animation", animation: code, properties: { to: { gamma: 0.7 } } });
  // Every example is an edit that changes the effect.
  for (const example of [easing.example, duration.example, both.example]) {
    const sent = await agent("edit", { project: "loose-fields", ops: [example], dry_run: true });
    assert.equal(sent.isError, undefined, sent.text);
  }

  // Two more effects: "box.effect" says which is which, and box.<effect> names one.
  await agent("edit", { project: "loose-fields", ops: [{ op: "add_animation", layer: "box", effect: "curves" }, { op: "add_animation", layer: "box", effect: "hue-saturation" }] });
  const several = await agent("edit", { project: "loose-fields", ops: [{ op: "update_animation", animation: "box.effect", properties: { to: { gamma: 0.6 } } }], dry_run: true });
  assert.equal(several.isError, true);
  assert.match(several.data.reason, new RegExp(`"box\\.effect" could be any of 3 animations: ${code} Color Wheels, A\\d+ Curves, A\\d+ Hue/Saturation\\. Name one by its code, such as "${code}", or an effect by its kind, such as "box\\.color-wheels"\\.`));
  assert.equal(several.data.missing, undefined);
  const byKind = await agent("edit", { project: "loose-fields", ops: [{ op: "update_animation", animation: "box.color-wheels", properties: { to: { gamma: 0.6 } } }] });
  assert.equal(byKind.isError, undefined, byKind.text);
  assert.deepEqual(byKind.data.changed, [code]);
});

test("library op update_animation shows how to change an effect", async () => {
  const reply = await agent("library", { topic: "op", name: "update_animation" });
  assert.match(reply.text, /^Example: \{"op":"update_animation","animation":"title\.in",/m);
  assert.match(reply.text, /^Effect: \{"op":"update_animation","animation":"title\.effect","properties":\{"to":\{"gamma":0\.6\}\}\}$/m);
});

test("an op that needs a scene in a project of several scenes is refused with the scenes and an example", async () => {
  await project("scenes");
  await agent("edit", { project: "scenes", ops: [{ op: "add_scene", name: "vertical", width: 1080, height: 1920, duration: 4 }] });
  const reply = await agent("edit", { project: "scenes", ops: [{ op: "add_layer", layerType: "rectangle", name: "r2" }], dry_run: true });
  assert.equal(reply.isError, true);
  assert.match(reply.data.reason, /add_layer needs scene: this project has 2 scenes \(s1 "Mistakes"|add_layer needs scene: this project has 2 scenes/);
  const tried = await agent("edit", { project: "scenes", ops: [reply.data.example], dry_run: true });
  assert.equal(tried.isError, undefined, tried.text);
});

test("one op sent without a list is a list of one", async () => {
  await project("one");
  const reply = await agent("edit", { project: "one", ops: { op: "update_layer", layer: "box", properties: { fill: "#000000" } } });
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.fixed, ["ops {…} → [{…}]"]);
  assert.equal(layerNamed(await saved("one"), "box").fill, "#000000");
  // operations is ops; an edit with neither is refused with a call to send (it was a crash).
  const named = await agent("edit", { project: "one", operations: [{ op: "update_layer", layer: "box", properties: { fill: "#111111" } }] });
  assert.deepEqual(named.data.fixed, ["operations → ops"]);
  const none = await agent("edit", { project: "one" });
  assert.equal(none.data.error, "bad_input");
  assert.deepEqual(nextCallOf(none), { tool: "library", input: { topic: "op", name: "<the op's name, such as add_layer>" } });
});

test("library op shows a working example, and each property preset's values for add_animation", async () => {
  await project("library");
  const answer = (await agent("library", { topic: "op", name: "add_animation" })).text;
  const examples = [...answer.matchAll(/^Example: (.+)$/gm)].map((match) => JSON.parse(match[1]));
  assert.equal(examples.length, 2);
  assert.match(answer, /move \{"x":1600\}/);
  assert.match(answer, /letter-spacing \(text\) \{"letterSpacing":20\}/);
  assert.match(answer, /speed \(video\) \{"speed":0.25\}/);
  for (const example of examples) {
    const tried = await agent("edit", { project: "library", ops: [{ ...example, layer: "title" }], dry_run: true });
    assert.equal(tried.isError, undefined, tried.text);
  }
  // A lookup, not a refusal: about 1,000 tokens with the rule topics, each preset's values and two examples.
  assert.ok(estimateTextTokens(answer) < 1200, `${estimateTextTokens(answer)} tokens`);
  // Guessed names find the op.
  assert.match((await agent("library", { topic: "op", name: "addLayer" })).text, /^addLayer is add_layer\.\n\nadd_layer \{/);
  // move is the moves library's op and also an animation preset: the answer gives both.
  const move = (await agent("library", { topic: "op", name: "move" })).text;
  assert.match(move, /^move \{name, at,/);
  assert.match(move, /move is also an animation preset, sent with add_animation \{layer, preset:"move"/);
  assert.match((await agent("library", { topic: "op", name: "add_text" })).text, /^add_text is add_layer with layerType "text"\./);
});

test("the other verbs: a plan as one line, check fix:true, and the working form for project new and history undo", async () => {
  await project("verbs");
  const plan = await agent("notes", { project: "verbs", action: "set_plan", steps: "build, check, render" });
  assert.equal(plan.isError, undefined, plan.text);
  assert.equal(plan.data.plan.length, 3);
  const checked = await agent("check", { project: "verbs", fix: true, pixels: false });
  assert.equal(checked.isError, undefined, checked.text);
  const made = await agent("project", { action: "new", id: "x", name: "X" });
  assert.match(made.data.reason, /project \{action:"create", id:"spring-launch"/);
  const undo = await agent("history", { project: "verbs", action: "undo" });
  assert.match(undo.data.reason, /history \{action:"revert", turn:"T3"\} undoes one turn/);
});

// A key inside an animation object that the animation does not have was saved and did nothing:
// add_layer {animations:[{kind:"custom", …, ease:"linear", durration:2}]} answered with no
// warning, and the saved animation played smooth for 1 s with "ease" and "durration" in it.
test("an unknown field inside an animation is refused with the closest fields, and ease is easing", async () => {
  await project("inside");
  const push = { kind: "custom", name: "Push", start: 0, duration: 1, from: { x: 100 }, to: { x: 300 } };
  const typo = await agent("edit", { project: "inside", ops: [
    { op: "add_layer", layerType: "rectangle", name: "a", properties: { x: 100, y: 100, width: 100, height: 100 }, animations: [{ ...push, ease: "linear", durration: 2 }] },
  ] });
  assert.equal(typo.isError, true);
  assert.match(typo.data.reason, /animations\[0\]: "durration" is not a field of a custom animation, so it would do nothing\. Did you mean duration/);
  assert.deepEqual(typo.data.didYouMean[0], "duration");
  assert.deepEqual(typo.data.example.animations, [{ ...push, easing: "linear" }], "the example is the add_layer with that animation as it works");
  const retried = await agent("edit", { project: "inside", retry: typo.data.retry, fix: { 0: typo.data.example } });
  assert.equal(retried.isError, undefined, retried.text);

  const eased = await agent("edit", { project: "inside", ops: [
    { op: "add_layer", layerType: "rectangle", name: "b", properties: { x: 100, y: 300, width: 100, height: 100 }, animations: [{ ...push, ease: "linear" }] },
    { op: "add_animation", layer: "box", start: 2, duration: 1, ease: "linear", from: { y: 100 }, to: { y: 300 } },
  ] });
  assert.equal(eased.isError, undefined, eased.text);
  assert.ok(eased.data.fixed.includes("animation.ease → easing") && eased.data.fixed.includes("ease → easing"), JSON.stringify(eased.data.fixed));
  const record = await saved("inside");
  const [b] = layerNamed(record, "b").animations;
  assert.equal(b.easing, "linear");
  assert.equal(b.ease, undefined, "nothing unknown is saved");
  assert.equal(layerNamed(record, "box").animations.at(-1).easing, "linear");

  const repeat = await agent("edit", { project: "inside", ops: [
    { op: "add_animation", layer: "box", animation: { kind: "custom", name: "Spin", start: 3, duration: 1, repeat: 2, yoyo: true, to: { rotation: 90 } } },
  ] });
  assert.equal(repeat.isError, true);
  assert.match(repeat.data.reason, /"repeat", "yoyo" are not fields of a custom animation, so they would do nothing\. To play it again and again, add behavior: {loop: {mode: "cycle"}}/);
  assert.deepEqual(repeat.data.example, { op: "add_animation", layer: "box", animation: { kind: "custom", name: "Spin", start: 3, duration: 1, from: {}, to: { rotation: 90 } } });

  const update = await agent("edit", { project: "inside", ops: [{ op: "update_animation", animation: "box.in", properties: { durration: 2 } }] });
  assert.equal(update.isError, true);
  assert.match(update.data.reason, /"durration" is not a field of an in animation/);
  assert.deepEqual(update.data.example, { op: "update_animation", animation: "box.in", properties: { duration: 2 } });
  const loop = await agent("edit", { project: "inside", ops: [{ op: "update_animations", animationIds: ["box.in", "title.in"], properties: { loop: true } }] });
  assert.equal(loop.isError, true);
  assert.match(loop.data.reason, /"loop" is not a field of an in animation/);
  assert.equal(loop.data.example, undefined, "nothing that was sent would change anything");
  const settings = await agent("edit", { project: "inside", ops: [{ op: "update_animation", animation: "box.in", properties: { ease: "linear" } }] });
  assert.equal(settings.isError, undefined, settings.text);
  assert.ok(settings.data.fixed.includes("properties.ease → easing"));
  const after = await saved("inside");
  const fade = layerNamed(after, "box").animations[0];
  assert.deepEqual([fade.easing, fade.duration, fade.loop, fade.durration], ["linear", 0.5, undefined, undefined]);
});

// {name:"Push", from, to} with no kind became an animation with the ID "push" and the shown
// name "Animation" (inspect: push 'Animation'); a property preset with values took the preset's
// name ("Move") instead of the one given.
test("the name given with from/to or a property preset with values is the animation's name too", async () => {
  await project("named");
  const result = await agent("edit", { project: "named", ops: [
    { op: "add_layer", layerType: "rectangle", name: "plate", properties: { x: 0, y: 0, width: 1920, height: 1080, fill: "#223344" },
      animations: [{ name: "Push", start: 0, duration: 3, easing: "linear", from: { scale: 1 }, to: { scale: 1.12 } }] },
    { op: "add_animation", layer: "plate", name: "Move2", start: 3, duration: 1, from: { x: 0 }, to: { x: 40 } },
    { op: "add_animation", layer: "plate", name: "Glide", preset: "move", start: 4, duration: 1, to: { x: 80 } },
  ] });
  assert.equal(result.isError, undefined, result.text);
  assert.deepEqual(layerNamed(await saved("named"), "plate").animations.map(({ id, name }) => [id, name]),
    [["push", "Push"], ["move2", "Move2"], ["glide", "Glide"]]);
  const shown = await agent("inspect", { project: "named", targets: ["plate"] });
  assert.match(shown.text, /push 'Push' custom/);
  assert.match(shown.text, /glide 'Glide' custom/);
});

// A layer with two custom animations: edit said `"dot2.custom" could be any of 2 animations: A5
// Out, A6 Back`, but inspect answered `No layer, animation or scene "dot2.custom". Did you mean
// dot2, …?`, and the receipt listed them only as createdCodes "A5-A6", without their names.
test("inspect of a name two animations share says which is which, as edit does; the receipt names both", async () => {
  await project("twins");
  const made = await agent("edit", { project: "twins", ops: [
    { op: "add_layer", layerType: "ellipse", name: "dot2", properties: { x: 100, y: 100, width: 40, height: 40, fill: "#ff0000" }, animations: [
      { kind: "custom", name: "Out", start: 1, duration: 1, from: { x: 100 }, to: { x: 300 } },
      { kind: "custom", name: "Back", start: 4, duration: 1, from: { x: 300 }, to: { x: 100 } },
    ] },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const { "dot2.Out": out, "dot2.Back": back } = made.data.created;
  assert.match(out ?? "", /^A\d+$/, JSON.stringify(made.data));
  assert.match(back ?? "", /^A\d+$/, JSON.stringify(made.data));
  assert.equal(made.data.createdCodes, undefined);
  const both = new RegExp(`"dot2\\.custom" could be any of 2 animations: ${out} Out, ${back} Back\\. Name one by its code, such as "${out}"\\.`);
  const inspected = await agent("inspect", { project: "twins", targets: ["dot2.custom"] });
  assert.equal(inspected.isError, true);
  assert.match(inspected.data.reason, both);
  assert.deepEqual(inspected.data.didYouMean, [out, back]);
  const edited = await agent("edit", { project: "twins", dry_run: true, ops: [{ op: "update_animation", animation: "dot2.custom", properties: { easing: "linear" } }] });
  assert.match(edited.data.reason, both);
  // The receipt's names work in both.
  const shown = await agent("inspect", { project: "twins", targets: ["dot2.Back"] });
  assert.match(shown.text, new RegExp(`^${back} 'Back' custom x 300→100 4s\\+1s`, "m"));
  const changed = await agent("edit", { project: "twins", ops: [{ op: "update_animation", animation: "dot2.Out", properties: { easing: "linear" } }] });
  assert.deepEqual(changed.data.changed, [out]);
});

// {preset:{mode:"out"}, kind:"out", start:4} on an entrance was refused as a value the preset
// works out itself, though the docs say a kind next to a preset is read as its mode (main saved it).
test("a kind of in or out next to a preset change is read as its mode, and refused only when it disagrees with a mode sent", async () => {
  await agent("project", { action: "create", id: "kindmode", name: "Kinds", width: 1920, height: 1080, duration: 6 });
  const entrance = (name, y) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x: 600, y, width: 300, height: 120 },
    animations: [{ preset: "preset-slide", start: 0, duration: 0.6, parameters: { direction: "up", distance: 40 } }] });
  const made = await agent("edit", { project: "kindmode", ops: [entrance("a", 100), entrance("b", 400), entrance("c", 700)] });
  assert.equal(made.isError, undefined, made.text);
  const first = async (name) => layerNamed(await saved("kindmode"), name).animations[0];

  const out = await agent("edit", { project: "kindmode", ops: [{ op: "update_animation", animation: "a.in", properties: { preset: { mode: "out" }, kind: "out", start: 4 } }] });
  assert.equal(out.isError, undefined, out.text);
  assert.ok(out.data.fixed.includes('kind "out" → preset.mode "out"'), out.text);
  const exit = await first("a");
  assert.deepEqual([exit.kind, exit.preset.mode, exit.start], ["out", "out", 4]);

  const longer = await agent("edit", { project: "kindmode", ops: [{ op: "update_animation", animation: "b.in", properties: { preset: { parameters: { distance: 80 } }, kind: "in" } }] });
  assert.equal(longer.isError, undefined, longer.text);
  const slide = await first("b");
  assert.deepEqual([slide.kind, slide.preset.mode, slide.preset.parameters.distance], ["in", "in", 80]);

  // update_animations reads it the same way for each animation.
  const both = await agent("edit", { project: "kindmode", ops: [{ op: "update_animations", animationIds: ["b.in", "c.in"], properties: { preset: { mode: "out" }, kind: "out" } }] });
  assert.equal(both.isError, undefined, both.text);
  assert.deepEqual([(await first("b")).kind, (await first("c")).kind, (await first("c")).preset.mode], ["out", "out", "out"]);

  // A kind that disagrees with the mode sent beside it is refused, naming both; nothing is saved.
  const before = await first("c");
  const clash = await agent("edit", { project: "kindmode", ops: [{ op: "update_animation", animation: "c.out", properties: { preset: { mode: "out" }, kind: "in", start: 3 } }] });
  assert.equal(clash.isError, true, clash.text);
  assert.match(clash.data.reason, /kind "in" and preset\.mode "out" disagree, so nothing was saved/);
  assert.deepEqual(clash.data.example, { op: "update_animation", animation: "c.out", properties: { preset: { mode: "out" }, start: 3 } });
  assert.deepEqual(await first("c"), before);
  const tried = await agent("edit", { project: "kindmode", ops: [clash.data.example], dry_run: true });
  assert.equal(tried.isError, undefined, tried.text);
});

// update_animation dot.custom {preset:{parameters:{distance:80}}} on a custom move said "is not a
// preset any more" and offered {"preset":{"id":"slide",…}}, which replaced the move with a slide.
test("a preset edit on a custom animation says it has no preset and offers its from and to, never a preset", async () => {
  await agent("project", { action: "create", id: "plain", name: "Plain", width: 1920, height: 1080, duration: 6 });
  const made = await agent("edit", { project: "plain", ops: [{ op: "add_layer", layerType: "ellipse", name: "dot", properties: { x: 200, y: 500, width: 40, height: 40 },
    animations: [{ kind: "custom", name: "glide", start: 1, duration: 2, to: { x: 1100 } }] }] });
  assert.equal(made.isError, undefined, made.text);
  const before = layerNamed(await saved("plain"), "dot").animations[0];
  const reply = await agent("edit", { project: "plain", ops: [{ op: "update_animation", animation: "dot.custom", properties: { preset: { parameters: { distance: 80 } } } }] });
  assert.equal(reply.isError, true, reply.text);
  assert.match(reply.data.reason, /"dot\.custom" is a plain animation with no preset \(named "glide"\)/);
  assert.doesNotMatch(reply.data.reason, /not a preset any more|"id"|slide/);
  // Its current from and to (from is where the layer was), for the agent to change.
  assert.deepEqual(reply.data.example, { op: "update_animation", animation: "dot.custom", properties: { from: before.from, to: { x: 1100 } } });
  assert.ok(reply.data.reason.endsWith(`(now from ${JSON.stringify(before.from)}, to {"x":1100}): ${JSON.stringify(reply.data.example)}`), reply.data.reason);
  const tried = await agent("edit", { project: "plain", ops: [reply.data.example], dry_run: true });
  assert.equal(tried.isError, undefined, tried.text);
  assert.deepEqual(layerNamed(await saved("plain"), "dot").animations[0], before);
});

// {direction:"up", preset:{parameters:{direction:"left"}}} kept "left", saved, and fixed[] said
// direction was moved. main refused it.
test("a preset setting or mode sent twice with two values is refused, naming both, and nothing is saved", async () => {
  await project("twice");
  const made = await agent("edit", { project: "twice", ops: [{ op: "add_animation", layer: "box", preset: "preset-slide", mode: "out", start: 4, duration: 0.5, parameters: { direction: "up" } }] });
  assert.equal(made.isError, undefined, made.text);
  const exit = async () => layerNamed(await saved("twice"), "box").animations.find((animation) => animation.kind === "out");
  const before = await exit();
  for (const [properties, named, example] of [
    [{ direction: "up", preset: { parameters: { direction: "left" } } }, 'direction "up" and preset.parameters.direction "left"', { preset: { parameters: { direction: "left" } } }],
    [{ mode: "in", preset: { mode: "out" } }, 'mode "in" and preset.mode "out"', { preset: { mode: "out" } }],
    [{ direction: "right", parameters: { direction: "down" } }, 'direction "right" and parameters.direction "down"', { preset: { parameters: { direction: "down" } } }],
  ]) {
    const reply = await agent("edit", { project: "twice", ops: [{ op: "update_animation", animation: "box.out", properties }] });
    assert.equal(reply.isError, true, JSON.stringify(properties));
    assert.ok(reply.data.reason.startsWith(`Operation 0 (update_animation): ${named} give one setting two values, so nothing was saved.`), reply.data.reason);
    assert.deepEqual(reply.data.example, { op: "update_animation", animation: "box.out", properties: example });
    assert.deepEqual(await exit(), before, "nothing was saved");
    const tried = await agent("edit", { project: "twice", ops: [reply.data.example], dry_run: true });
    assert.equal(tried.isError, undefined, tried.text);
  }
  // The same value twice is one value.
  const same = await agent("edit", { project: "twice", ops: [{ op: "update_animation", animation: "box.out", properties: { direction: "left", preset: { parameters: { direction: "left" } } } }] });
  assert.equal(same.isError, undefined, same.text);
  assert.equal((await exit()).preset.parameters.direction, "left");
});

// update_layer box {size:{width:500}, width:300} saved 300 and said "size → width, height";
// size {w:500, h:90} was refused with no op to send.
test("a size or scale sent beside its own field with another value is refused, naming both, with an op that runs", async () => {
  await project("pairs3");
  const box = async () => layerNamed(await saved("pairs3"), "box");
  const before = await box();
  for (const [layer, properties, named, example] of [
    ["box", { size: { width: 500 }, width: 300 }, '"size" sets width 500, and width 300 was sent too', { width: 300 }],
    ["box", { scale: { x: 3, y: 3 }, scaleX: 1 }, '"scale" sets scaleX 3, and scaleX 1 was sent too', { scaleX: 1, scaleY: 3 }],
    ["title", { size: 70, fontSize: 30 }, '"size" sets fontSize 70, and fontSize 30 was sent too', { fontSize: 30 }],
  ]) {
    const reply = await agent("edit", { project: "pairs3", ops: [{ op: "update_layer", layer, properties }] });
    assert.equal(reply.isError, true, JSON.stringify(properties));
    assert.ok(reply.data.reason.startsWith(`Operation 0 (update_layer): ${named}. One field takes one value, so nothing was saved`), reply.data.reason);
    assert.deepEqual(reply.data.example, { op: "update_layer", layer, properties: example });
    const tried = await agent("edit", { project: "pairs3", ops: [reply.data.example], dry_run: true });
    assert.equal(tried.isError, undefined, tried.text);
  }
  assert.deepEqual(await box(), before, "nothing was saved");
  // The same value twice is accepted.
  const same = await agent("edit", { project: "pairs3", ops: [{ op: "update_layer", layer: "box", properties: { size: { width: 500 }, width: 500, scale: 2, scaleY: 2 } }] });
  assert.equal(same.isError, undefined, same.text);
  assert.deepEqual([(await box()).width, (await box()).scaleX, (await box()).scaleY], [500, 2, 2]);
  // A part neither field has: the example sets the fields from the values sent.
  for (const [properties, example] of [[{ size: { w: 500, h: 90 } }, { width: 500, height: 90 }], [{ scale: { width: 1 } }, { scaleX: 1 }]]) {
    const reply = await agent("edit", { project: "pairs3", ops: [{ op: "update_layer", layer: "box", properties }], dry_run: true });
    assert.equal(reply.isError, true, JSON.stringify(properties));
    assert.deepEqual(reply.data.example, { op: "update_layer", layer: "box", properties: example }, reply.text);
    const tried = await agent("edit", { project: "pairs3", ops: [reply.data.example], dry_run: true });
    assert.equal(tried.isError, undefined, tried.text);
  }
});

test("a setting where 1 is unchanged: the receipt says what the value did, and a relative text is read (ceiling study c)", async () => {
  await project("unchanged");
  const send = (effect, parameters) => agent("edit", { project: "unchanged", ops: [{ op: "add_animation", layer: "box", effect, parameters }] });
  const notes = async (effect, parameters) => {
    const reply = await send(effect, parameters);
    assert.equal(reply.isError, undefined, reply.text);
    return JSON.parse(reply.text).notes.join("\n");
  };
  assert.match(await notes("color-grade", { exposure: 0.5 }), /color-grade exposure 0\.5: half as bright \(1 = unchanged/);
  assert.match(await notes("color-grade", { exposure: "+0.5 stop" }), /exposure "\+0\.5 stop": stops 0\.5, 0\.5 stops brighter/);
  assert.match(await notes("hue-saturation", { saturation: "-0.7" }), /saturation "-0\.7": 0\.3, less color/);
  const effects = layerNamed(await saved("unchanged"), "box").animations.filter((animation) => animation.kind === "effect");
  assert.deepEqual(effects.map((animation) => animation.to.exposure ?? animation.to.stops ?? animation.to.saturation), [0.5, 0.5, 0.3]);
});
