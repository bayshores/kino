// The moves come out clean by default (a trailer's quality-control list):
// push-through-type keeps its word on one line, keeps the color split small, fades the glossy
// word before the next shot fills the letter and drops its mask only once the letter covers the
// frame; caption-words keeps whole phrases, balances two lines and keeps clear of a phone or a
// status line; status-line moves away from captions or refuses; tile-ring fills the frame;
// zoom-through with a target lands with the target filling the frame; and no move leaves a blur
// or a color split switched on after it ends.
import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { LOOK_NAMES, styleFor } from "./blocks/looks.js";
import { placeMove, readMoveInput, runMove } from "./blocks/move.js";
import { MOVES, MOVE_NAMES } from "./blocks/moves/index.js";
import { captionGroups } from "./blocks/moves/type.js";
import { inkPoint } from "./blocks/moves/kit.js";
import { layoutText, textUnits } from "./textLayout.js";
import { evaluateLayer } from "./animation.js";
import { compactRecording } from "./recording.js";
import { projectFaces } from "../backend/agent/blocks.mjs";

const FRAME = { width: 1920, height: 1080 };
const PICTURES = {
  "screen-a": { id: "screen-a.png", src: "/api/media/screen-a.png", width: 720, height: 1564, name: "screen-a" },
  "screen-b": { id: "screen-b.png", src: "/api/media/screen-b.png", width: 720, height: 1564, name: "screen-b" },
  "screen-c": { id: "screen-c.png", src: "/api/media/screen-c.png", width: 720, height: 1564, name: "screen-c" },
  logo: { id: "logo.png", src: "/api/media/logo.png", width: 512, height: 512, name: "logo" },
};
const media = (ref) => PICTURES[ref] ?? (() => { throw new Error(`No picture ${ref}.`); })();
// The clip is a screen recording too (screen-recording's example): one click.
const CLIP_RECORDING = compactRecording({ frame: { width: 1600, height: 900 }, scale: 1, duration: 8, cursors: { c1: { shape: "arrow" } } }, [
  { t: 0, type: "move", x: 300, y: 300, cursor: "c1" },
  { t: 1, type: "down", x: 900, y: 500, button: "left", clicks: 1, source: "agent" }, { t: 1.08, type: "up", x: 900, y: 500, button: "left", source: "agent" },
]);

function scene(layers = [], duration = 6) {
  return createScene({ id: "s", name: "Scene", ...FRAME, duration, layers: [
    // The footage moves' example freezes or fills a word with this clip.
    createLayer("video", { id: "clip", name: "clip", src: "/api/media/clip.mp4", x: 0, y: 0, ...FRAME, mediaSourceDuration: 8, mediaFreeze: "none", recording: CLIP_RECORDING }),
    createLayer("image", { id: "shot-b", name: "shot-b", src: "/api/media/wall.png", x: 0, y: 0, ...FRAME }),
    createLayer("image", { id: "shot-a", name: "shot-a", src: "/api/media/street.png", x: 0, y: 0, ...FRAME }),
    // draw-on's example draws this line.
    createLayer("path", { id: "underline", name: "underline", x: 576, y: 648, width: 768, height: 40, path: "M0 20 C200 0 400 40 600 20", fillEnabled: false, stroke: "#ffffff", strokeWidth: 8 }),
    ...layers,
  ] });
}
// type-on's example types this prompt into its box; stream, rewrite and decode work on its text.
const PROMPT = [
  createLayer("rectangle", { id: "prompt-field", name: "prompt-field", x: 200, y: 480, width: 900, height: 110, radius: 26, fill: "#1A1D22" }),
  createLayer("text", { id: "prompt", name: "prompt", x: 240, y: 508, width: 600, height: 56, text: "Find issues with loading", fontSize: 44, textResize: "width-height", textAlign: "left", fill: "#EDEEF0", role: "ui" }),
];
// carry's example carries this card into the phone's screen.
const CARD = createLayer("rectangle", { id: "app-card", name: "app-card", x: 150, y: 110, width: 576, height: 346, radius: 32, fill: "#2A2D33" });
function run(name, fields, { on = scene(), at = 0.3, dur = null, reduced = false } = {}) {
  const definition = MOVES[name];
  return runMove(definition, { id: name, input: readMoveInput(definition, fields), scene: on, style: styleFor({ look: "crisp", frame: FRAME }), fonts: defaultFonts, start: at, dur, media, logo: { media: PICTURES.logo }, reduced });
}
const animation = (layer, name) => layer.animations.find((entry) => entry.id.endsWith(`.${name}`));
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test("push-through-type: one line at the open spacing, a small split, the word gone before the letter fills, the mask dropped once the letter covers the frame", () => {
  const made = run("push-through-type", { text: "oak.", next: "shot-a", entrance: "sharpen" }, { at: 0.2, dur: 2.6 });
  const word = made.added.find((entry) => entry.layer.move.part === "word").layer;
  const window = made.added.find((entry) => entry.layer.move.part === "window").layer;
  const open = animation(word, "in").from.letterSpacing;
  assert.equal(layoutText({ ...word, letterSpacing: open }, defaultFonts).lines.length, 1, "the period never wraps, even with the letters spaced open");
  assert.ok(word.width >= FRAME.width * 0.45, `big type (${word.width} px wide)`);
  // The split is a share of the word's box; on screen it stays near 10 px at the word's scale then.
  const split = animation(word, "split");
  const creep = animation(word, "creep").to.scaleX;
  assert.ok(split.to.amount * 0.1 * Math.min(word.width, word.height) * creep <= 14, "the color split stays small on screen");
  assert.ok(!word.animations.some((entry) => entry.effect === "zoom-blur"), "no zoom blur smears the word's edges");
  const showAt = made.animations.find((entry) => entry.animation.id === "push-through-type.next-in").animation.start;
  assert.ok(animation(word, "unsplit").start + animation(word, "unsplit").duration <= showAt + 1e-6, "the split is closed before the next shot shows");
  assert.ok(animation(word, "hide").start < animation(window, "hide").start, "the glossy word is gone before the letter fills the frame");
  // At the cut the letter (the window) is scaled past the point where its ink covers the frame.
  const push = animation(window, "push");
  const units = textUnits(layoutText(window, defaultFonts), "letters").filter((unit) => unit.text.trim());
  const best = Math.min(...units.map((unit) => inkPoint(unit.glyphs[0], FRAME)?.need ?? Infinity));
  assert.ok(push.to.scaleX >= best * 1.2, `the letter covers the frame at the cut (scale ${push.to.scaleX}, needs ${best})`);
  assert.ok(animation(word, "sheen"), "the word has motion while it is read (a sheen)");
  assert.ok(creep >= 1.25, "and drifts closer");
});

test("projectFaces: moves write in the font the project's own text uses", () => {
  const text = (id, fontWeight, extra = {}) => createLayer("text", { id, text: id, fontFamily: "JetBrains Mono", fontSource: "catalog:jetbrains-mono", fontWeight, ...extra });
  const document = { scenes: [{ layers: [text("url", 700), text("note", 500), text("credit", 500), createLayer("text", { id: "cap", text: "x", fontFamily: "Inter", move: { name: "caption-words", instance: "said", part: "w1" } })] }] };
  assert.deepEqual(projectFaces(document), {
    display: { fontFamily: "JetBrains Mono", fontSource: "catalog:jetbrains-mono", fontWeight: 700, fontStyle: "normal" },
    body: { fontFamily: "JetBrains Mono", fontSource: "catalog:jetbrains-mono", fontWeight: 500, fontStyle: "normal" },
  });
  assert.equal(projectFaces({ scenes: [{ layers: [] }] }), null);
});

test("caption-words keeps whole phrases: never across a sentence's end, and the last group keeps its own words", () => {
  const sure = captionGroups([{ text: "sure.", at: 10.12 }, { text: "where would", at: 10.82 }, { text: "you like", at: 11.22 }, { text: "to go?", at: 11.58 }], 12.62);
  assert.equal(sure[0].text, "sure.", "a sentence's end closes its caption (held a little to be read)");
  assert.ok(sure[0].end - sure[0].at >= 0.66);
  assert.ok(sure.every((group) => !/\. \S/.test(group.text)), sure.map((group) => group.text).join(" | "));
  const stop = captionGroups([{ text: "stop.", at: 59.64 }, { text: "target is", at: 61.44 }, { text: "on your right.", at: 61.75 }], 62.54);
  assert.equal(stop[0].text, "stop.");
  assert.ok(stop.every((group) => group.end - group.at >= 0.66), "every group can be read");
  // A word said within 0.3 s of the last one stays in the same caption.
  const breath = captionGroups([{ text: "turn", at: 0 }, { text: "right", at: 0.9 }, { text: "now", at: 1.05 }, { text: "please", at: 2.2 }], 3.4);
  assert.ok(breath.some((group) => / ?right now ?/.test(group.text)), breath.map((group) => group.text).join(" | "));
});

test("caption-words: two lines are balanced, and captions keep clear of a phone and of a status line", () => {
  const words = [{ text: "this is lowkey the best", at: 0.3 }, { text: "project we ever saw", at: 1.6, end: 3 }];
  const made = run("caption-words", { words });
  for (const { layer } of made.added.filter((entry) => entry.layer.type === "text")) {
    const lines = layoutText(layer, defaultFonts).lines;
    if (lines.length === 2) assert.ok(lines[1].width >= lines[0].width * 0.45, `"${layer.text}" has no lone word on its second line`);
  }
  const phone = createLayer("image", { id: "phone", name: "phone", src: "/api/media/phone.png", x: 1190, y: 60, width: 458, height: 960 });
  const beside = run("caption-words", { words }, { on: scene([phone]) });
  for (const { layer } of beside.added.filter((entry) => entry.layer.type === "text")) assert.ok(!overlaps(layer, phone), `${layer.id} keeps clear of the phone`);
  assert.ok(beside.notes.some((note) => /left of phone/.test(note)), beside.notes.join("; "));
  // avoid names the layers to keep clear of; an empty frame keeps the centered default.
  const centered = run("caption-words", { words, avoid: ["shot-a"] });
  assert.ok(centered.notes.some((note) => /could not keep clear/.test(note)), "a full-frame layer cannot be avoided, and the receipt says so");
  // Captions made after a status line keep clear of it.
  const on = scene();
  placeMove(on, { id: "status-line", name: "status-line", settings: {} }, run("status-line", { label: "oak", lines: [{ text: "is listening…", at: 0.3 }] }, { on }));
  const after = run("caption-words", { words: [{ text: "show me the closest", at: 0.6 }, { text: "target?", at: 1.6, end: 3 }] }, { on });
  const status = on.layers.filter((layer) => layer.move?.name === "status-line");
  for (const { layer } of after.added.filter((entry) => entry.layer.type === "text")) for (const part of status) assert.ok(!overlaps(layer, part), `${layer.id} keeps clear of ${part.id}`);
});

test("status-line moves away from a caption on screen at the same time, and refuses when text is everywhere", () => {
  const caption = (id, y) => createLayer("text", { id, text: "show me the closest target?", x: 300, y, width: 1300, height: 200, fontSize: 80 });
  const one = run("status-line", { label: "oak", lines: [{ text: "is listening…", at: 0.4 }] }, { on: scene([caption("said", 440)]) });
  const tile = one.added.find((entry) => entry.layer.move.part === "tile").layer;
  assert.ok(one.notes.some((note) => /status line moved/.test(note)), one.notes.join("; "));
  assert.ok(!overlaps(tile, caption("said", 440)));
  // A bottom-left badge keeps its corner beside a short centered caption at the bottom.
  const low = createLayer("text", { id: "low", text: "find it", x: 760, y: 900, width: 400, height: 100, fontSize: 80 });
  const badge = run("status-line", { label: "oak", place: "bottom-left", lines: [{ text: "is listening…", at: 0.4 }] }, { on: scene([low]) });
  const corner = badge.added.find((entry) => entry.layer.move.part === "tile").layer;
  assert.ok(corner.y > 1080 / 2 && !badge.notes.some((note) => /moved/.test(note)), badge.notes.join("; "));
  const everywhere = scene([caption("a", 0), caption("b", 300), caption("c", 600), caption("d", 880)]);
  assert.throws(() => run("status-line", { label: "oak", lines: [{ text: "is listening…", at: 0.4 }] }, { on: everywhere }), /status-line would cover text on screen at the same time: b \(0\.4 s\)/);
});

test("tile-ring fills most of the frame, and its field ending covers the whole frame", () => {
  const made = run("tile-ring", { layer: "shot-a", pictures: ["screen-a", "screen-b"], spin: -60 }, { at: 0.3, dur: 2.4 });
  const tiles = made.added.filter((entry) => /^tile\d+$/.test(entry.layer.move.part)).map((entry) => entry.layer);
  const wide = tiles.filter((tile) => tile.width > tile.height);
  assert.ok(wide.every((tile) => tile.width >= FRAME.width * 0.15), "tiles are at least 15% of the frame wide");
  assert.ok(made.added.some((entry) => entry.layer.move.part === "backdrop"), "a soft copy of the shot fills the frame behind the ring");
  // The ring's reach: tiles from near the left edge to near the right edge.
  const turned = tiles.map((tile) => evaluateLayer(tile, 1.5));
  assert.ok(Math.min(...turned.map((state) => state.x)) < FRAME.width * 0.2 && Math.max(...turned.map((state) => state.x + state.width)) > FRAME.width * 0.8);
  // Once broken into the field, the tiles cover (almost) every point of the frame, the middle too.
  const end = made.end - 0.01;
  const boxes = tiles.map((tile) => {
    const state = evaluateLayer(tile, end);
    const width = state.width * state.scaleX;
    const height = state.height * state.scaleY;
    return { x: state.x + (state.width - width) / 2, y: state.y + (state.height - height) / 2, width, height };
  });
  let covered = 0;
  let points = 0;
  for (let x = 20; x < FRAME.width; x += 40) for (let y = 20; y < FRAME.height; y += 40) {
    points += 1;
    if (boxes.some((box) => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height)) covered += 1;
  }
  assert.ok(covered / points >= 0.95, `the field covers ${Math.round((100 * covered) / points)}% of the frame`);
  assert.ok(boxes.every((box) => box.height <= FRAME.height * 0.75), "no tile (a tall phone screen too) is blown up past most of the frame");
  assert.ok(boxes.some((box) => box.x <= FRAME.width / 2 && box.x + box.width >= FRAME.width / 2 && box.y <= FRAME.height / 2 && box.y + box.height >= FRAME.height / 2), "the middle is covered");
});

test("zoom-through with a target lands with the target filling the frame, blur only while it is fast", () => {
  const group = createLayer("group", { id: "phone", name: "phone", x: 1186, y: 60, width: 468, height: 960 });
  const body = createLayer("rectangle", { id: "phone-body", name: "phone-body", parentId: "phone", x: 5, y: 0, width: 458, height: 960 });
  const screen = createLayer("rectangle", { id: "phone-screen", name: "phone-screen", parentId: "phone", x: 20, y: 15, width: 428, height: 930 });
  const on = scene([group, body, screen]);
  const made = run("zoom-through", { from: "phone", target: { layer: "phone-screen", rect: [0, 50, 100, 26] } }, { on, at: 1, dur: 0.6 });
  const push = made.animations.find((entry) => entry.animation.id === "zoom-through.from-push").animation;
  // The target's box on screen at the end: from's corner + (point - middle) × scale about the middle.
  const local = { x: 20, y: 15 + 930 * 0.5, width: 428, height: 930 * 0.26 };
  const scale = push.to.scaleX;
  const left = push.to.x + 468 / 2 + (local.x - 468 / 2) * scale;
  const top = push.to.y + 960 / 2 + (local.y - 960 / 2) * scale;
  const box = { x: left, y: top, width: local.width * scale, height: local.height * scale };
  assert.ok(box.x <= 0.5 && box.y <= 0.5 && box.x + box.width >= FRAME.width - 0.5 && box.y + box.height >= FRAME.height - 0.5, `the target covers the frame (${JSON.stringify(box)})`);
  assert.ok(Math.abs(box.x + box.width / 2 - FRAME.width / 2) < 1 && Math.abs(box.y + box.height / 2 - FRAME.height / 2) < 1, "centered");
  assert.ok(Math.abs(box.width - FRAME.width) < 1 || Math.abs(box.height - FRAME.height) < 1, "exactly: one side meets the frame's edges");
  const blur = made.animations.filter((entry) => entry.animation.effect === "zoom-blur").map((entry) => entry.animation);
  assert.deepEqual(push.easing, [0.7, 0, 0.84, 0], "the push eases in, fastest as it lands");
  assert.ok(blur[0].start > 1 + 0.1 && blur.at(-1).to.amount === 0 && blur.at(-1).start + blur.at(-1).duration <= 1.6 + 1e-9, "the blur comes late and is 0 on the landing frame");
  assert.throws(() => run("zoom-through", { from: "shot-a", target: { layer: "phone-screen" } }, { on, at: 1 }), /not shot-a or a part of it/);
  assert.throws(() => readMoveInput(MOVES["zoom-through"], { from: "shot-a" }), /needs to or target or reverse/);
});

test("zoom-through reverse pulls back expo-out to the whole shot in 0.4 s; blur:false stays sharp; flash:white covers the cut", () => {
  const shot = createLayer("image", { id: "shot", name: "shot", src: "/api/media/shot.png", x: 0, y: 0, width: FRAME.width, height: FRAME.height });
  const title = createLayer("text", { id: "title", name: "title", text: "introducing", x: 660, y: 900, width: 600, height: 80 });
  const on = scene([shot, title]);
  const pull = (input) => run("zoom-through", { from: "shot", reverse: true, ...input }, { on, at: 1, dur: null });
  const made = pull({ target: { layer: "shot", rect: [25, 25, 50, 50] }, title: "title" });
  const move = made.animations.find((entry) => entry.animation.id === "zoom-through.from-pull").animation;
  assert.deepEqual([move.start, move.duration, move.easing, move.from.scaleX, move.to.scaleX, move.to.x], [1, 0.4, [0.16, 1, 0.3, 1], 2, 1, 0], "from the middle quarter filling the frame back to the whole shot, expo-out, 0.4 s");
  const blur = made.animations.filter((entry) => entry.animation.effect === "zoom-blur").map((entry) => entry.animation);
  assert.ok(blur.at(-1).to.amount === 0 && blur.at(-1).start + blur.at(-1).duration < 1.4, "the blur is gone before the settle");
  const lands = made.animations.find((entry) => entry.animation.id === "zoom-through.title-in").animation;
  assert.ok(lands.start > 1 && lands.to.opacity === 1 && made.end >= lands.start + lands.duration, "the title lands as it settles");
  const sharp = pull({ point: [50, 50], blur: false, flash: "white" });
  assert.equal(sharp.animations.filter((entry) => entry.animation.effect).length, 0, "blur:false adds no blur");
  const flash = sharp.added.find((entry) => entry.layer.id === "zoom-through-flash").layer;
  assert.ok(flash.opacity === 0 && flash.animations.some((animation) => animation.to?.opacity === 1 && animation.start + animation.duration === 1), "the flash is full at the start of the pull");
  const plain = run("zoom-through", { from: "shot", to: "title", blur: false }, { on, at: 1 });
  assert.equal(plain.animations.filter((entry) => entry.animation.effect).length, 0, "a sharp push through");
  assert.throws(() => run("zoom-through", { from: "shot", to: "title", title: "title" }, { on, at: 1 }), /goes with reverse/);
  assert.throws(() => readMoveInput(MOVES["zoom-through"], { from: "shot", reverse: false }), /reverse is one of true/);
  // A pull at the top of a scene: the flash starts at 0, and the move's end covers its fade.
  const first = run("zoom-through", { from: "shot", reverse: true, flash: "white" }, { on, at: 0, dur: 0.2 });
  assert.ok(first.added.find((entry) => entry.layer.id === "zoom-through-flash").layer.animations.every((entry) => entry.start >= 0) && first.end >= 0.26, "at:0 flash starts at 0 and ends inside the move");
  assert.throws(() => run("zoom-through", { from: "shot", target: { layer: "shot", rect: [25, 25, 50, 50] }, flash: "white" }, { on, at: 5.6, dur: 0.4 }), /after the scene ends/);
  // Reduced motion: a small drift without to, a cross-fade with it.
  const calm = run("zoom-through", { from: "shot", reverse: true, target: { layer: "shot", rect: [25, 25, 50, 50] } }, { on, at: 1, reduced: true });
  assert.ok(calm.animations.find((entry) => entry.animation.id === "zoom-through.from-pull").animation.from.scaleX <= 1.05, "reduced: no big zoom");
  const fade = run("zoom-through", { from: "shot-a", to: "shot-b", reverse: true }, { on, at: 1, reduced: true });
  assert.ok(!fade.animations.some((entry) => entry.animation.id.endsWith("-pull")) && fade.animations.some((entry) => entry.animation.id === "zoom-through.to-in"), "reduced with to: a cross-fade");
});

test("zoom-through: a layer alone in its camera group means the group; a later clip starts when it appears; the push moves from the start", () => {
  const camera = createLayer("group", { id: "ask-camera", name: "ask camera", x: 0, y: 0, ...FRAME });
  const ask = createLayer("image", { id: "ask", name: "ask", parentId: "ask-camera", src: "/api/media/ask.png", x: 0, y: 0, ...FRAME });
  const app = createLayer("video", { id: "app", name: "app", src: "/api/media/app.mp4", x: 0, y: 0, ...FRAME, mediaStart: 4.7, mediaDuration: 2, mediaSourceDuration: 8 });
  const made = run("zoom-through", { from: "ask", to: "app" }, { on: scene([camera, ask, app], 8), at: 4.2, dur: 0.5 });
  const push = made.animations.find((entry) => entry.animation.id === "zoom-through.from-push");
  assert.equal(push.layerId, "ask-camera");
  const appear = made.animations.find((entry) => entry.animation.id === "zoom-through.to-in").animation.start;
  // It still ends at 6.7 s, but starts when it appears (no black between the shots).
  assert.deepEqual(made.sets, [{ layerId: "app", properties: { mediaStart: appear, mediaDuration: Math.round((6.7 - appear) * 1000) / 1000 } }]);
  // A clip that runs to its file's end moves its in-point back too: same frames at the same times, same end.
  const tail = createLayer("video", { id: "tail", name: "tail", src: "/api/media/app.mp4", x: 0, y: 0, ...FRAME, mediaStart: 4.7, mediaOffset: 1, mediaDuration: 2, mediaSourceDuration: 3 });
  const [{ properties: moved }] = run("zoom-through", { from: "ask", to: "tail" }, { on: scene([camera, ask, tail], 8), at: 4.2, dur: 0.5 }).sets;
  assert.ok(Math.abs(moved.mediaStart - moved.mediaOffset - 3.7) < 1e-9 && Math.abs(moved.mediaStart + moved.mediaDuration - 6.7) < 1e-9, JSON.stringify(moved));
  // At 40% of the push the shot is visibly closer (over 1.25x), not near 1x until the last frames.
  const layer = { ...camera, animations: [push.animation] };
  assert.ok(evaluateLayer(layer, 4.2 + push.animation.duration * 0.4).scaleX > 1.25);
});

test("every move writes in a face that is loaded: a bundled family at a weight it ships", () => {
  const SHIPPED = { Inter: [400, 500, 600, 700], Montserrat: [400, 500, 600, 700], "Noto Serif": [400, 700] };
  const phone = createLayer("image", { id: "phone", name: "phone", src: "/api/media/phone.png", x: 813, y: 205, width: 294, height: 670 });
  for (const look of LOOK_NAMES) {
    const style = styleFor({ look, frame: FRAME });
    for (const name of MOVE_NAMES.filter((key) => !MOVES[key].needsCue)) {
      const { at = 0.3, dur = null, ...fields } = MOVES[name].example;
      const definition = MOVES[name];
      const made = runMove(definition, { id: name, input: readMoveInput(definition, fields), scene: scene(fields.layer === "prompt" ? [phone, ...PROMPT] : [phone, CARD]), style, fonts: defaultFonts, start: at, dur, media, logo: { media: PICTURES.logo } });
      for (const { layer } of made.added.filter((entry) => entry.layer.type === "text"))
        assert.ok(SHIPPED[layer.fontFamily]?.includes(layer.fontWeight), `${look} ${name}: ${layer.id} is ${layer.fontFamily} ${layer.fontWeight}`);
    }
  }
});

test("no move leaves a blur or a color split on after it ends", () => {
  const RESTING = { "zoom-blur": "amount", "rgb-shift": "amount", "directional-blur": "length" };
  const phone = createLayer("image", { id: "phone", name: "phone", src: "/api/media/phone.png", x: 813, y: 205, width: 294, height: 670 });
  for (const name of MOVE_NAMES.filter((key) => !MOVES[key].needsCue)) {
    const { at = 0.3, dur = null, ...fields } = MOVES[name].example;
    const made = run(name, fields, { on: scene([phone, CARD, ...PROMPT]), at, dur });
    const byLayer = new Map();
    for (const { layerId, animation: entry } of made.animations) byLayer.set(layerId, [...(byLayer.get(layerId) ?? []), entry]);
    for (const { layer } of made.added) byLayer.set(layer.id, layer.animations);
    // A part the move takes off screen (it, or the group it is in, ends on a hide) shows nothing after.
    const endsHidden = (id) => (byLayer.get(id) ?? []).toSorted((a, b) => a.start - b.start).at(-1)?.kind === "hide";
    const gone = new Set(made.added.filter(({ layer }) => endsHidden(layer.id) || endsHidden(layer.parentId)).map(({ layer }) => layer.id));
    for (const [layerId, animations] of byLayer) {
      if (gone.has(layerId)) continue;
      for (const [effect, key] of Object.entries(RESTING)) {
        const last = animations.filter((entry) => entry.effect === effect).sort((a, b) => (a.start + a.duration) - (b.start + b.duration)).at(-1);
        if (last) assert.equal(last.to[key], 0, `${name}: ${layerId}'s ${effect} ends at 0`);
      }
    }
  }
});

test("count-up keeps the stat's format and counts in tabular figures, so the number never changes width", () => {
  const made = run("count-up", { value: "$1.2M", label: "raised" });
  const number = made.added.find((entry) => entry.layer.move.part === "number").layer;
  const count = animation(number, "count");
  assert.deepEqual([count.from, count.to, count.step, count.easing], [0, 1.2, 0.1, [0.25, 1, 0.5, 1]]);
  const width = (text, tabularNumbers = true) => layoutText({ ...number, text, tabularNumbers }, defaultFonts).lines[0].width;
  assert.equal(width("$0.4M"), width("$1.2M"), "every digit is one width");
  assert.notEqual(width("$0.4M", false), width("$1.2M", false), "(proportional digits are not)");
});

test("headline-write: only the headline writes on; an old kicker-headline op still runs, with its kicker left out and a note", () => {
  const made = run("headline-write", { headline: "Set it up in seconds" });
  assert.deepEqual(made.added.map((entry) => entry.layer.move.part), ["headline"]);
  const headline = made.added[0].layer;
  // Words arrive 4 a second at 40% and darken to full in 0.2 s.
  const arrive = animation(headline, "arrive");
  assert.deepEqual([arrive.unit, arrive.stagger, arrive.to.opacity, animation(headline, "ink").duration], ["words", 0.25, 0.4, 0.2]);
  const old = run("kicker-headline", { kicker: "setup", headline: "Set it up in seconds" });
  assert.deepEqual(old.added.map((entry) => entry.layer.move.part), ["headline"], "no label above the headline");
  assert.ok(old.notes.some((note) => /kicker left out/.test(note)), old.notes.join("; "));
});

test("window-punch-in: 60% to 92% of the width, most of it in the first 0.2 s, then a slow push; glow off unless asked, beats make steps", () => {
  const made = run("window-punch-in", { layer: "shot-b" }, { at: 0 });
  const shot = scene().layers.find((layer) => layer.id === "shot-b");
  const placed = { ...shot, animations: made.animations.filter((entry) => entry.layerId === "shot-b").map((entry) => entry.animation) };
  const share = (time) => evaluateLayer(placed, time).scaleX;
  assert.ok(Math.abs(share(0) - 0.6) < 0.01 && Math.abs(share(0.8) - 0.92) < 0.01, `${share(0)} to ${share(0.8)}`);
  assert.ok((share(0.2) - 0.6) / (0.92 - 0.6) >= 0.75, `${Math.round((100 * (share(0.2) - 0.6)) / 0.32)}% of the growth by 0.2 s`);
  assert.ok(share(made.end) > 0.92 * 1.03, "it keeps pushing in after it settles");
  assert.equal(made.added.length, 0, "no glow layer by default");
  const stepped = run("window-punch-in", { layer: "shot-b", beats: [1, 1.8], glow: 1 }, { at: 0.2 });
  assert.deepEqual(stepped.animations.filter((entry) => /step\d$/.test(entry.animation.id)).map((entry) => entry.animation.start), [0.2, 1, 1.8]);
  assert.equal(stepped.added[0].layer.move.part, "glow");
});

test("lift-focus: a part of a picture is copied into a rounded card that grows to the middle; the rest dims and softens, then all goes back", () => {
  const made = run("lift-focus", { detail: { layer: "shot-b", rect: [42, 52, 16, 26] } });
  const parts = Object.fromEntries(made.added.map(({ layer }) => [layer.move.part, layer]));
  assert.ok(parts.card.clipContent && parts.card.radius > 0 && parts.copy.parentId === parts.card.id);
  const card = evaluateLayer(parts.card, 0.9);
  assert.ok(Math.abs(card.width * card.scaleX - FRAME.width * 0.3) < 2, "a third of the frame's width");
  assert.ok(Math.abs(card.x + card.width / 2 - FRAME.width / 2) < 1, "in the middle");
  assert.equal(evaluateLayer(parts.dim, 1.5).opacity, 0.75, "the rest at a quarter brightness");
  const blur = made.animations.find((entry) => entry.animation.id === "lift-focus.back2-soften").animation;
  assert.equal(blur.to.blur, 11);
  assert.equal(evaluateLayer(parts.card, made.end).x, parts.card.x, "back in its place at the end");
  // A detail that is big already lifts a little, never shrinks.
  const phone = createLayer("image", { id: "phone", name: "phone", src: "/api/media/phone.png", x: 760, y: 60, width: 400, height: 960 });
  const big = run("lift-focus", { detail: { layer: "phone" } }, { on: scene([phone]) });
  const lift = big.animations.find((entry) => entry.animation.id === "lift-focus.detail-lift").animation;
  assert.ok(lift.to.scaleX >= 1, `scale ${lift.to.scaleX}`);
  // Only a picture that fills the frame as drawn mirrors past its edges while soft: a screen
  // shrunk to 0.8x (as ui-plane leaves it) would show mirrored copies of itself around it.
  const edged = (result) => result.animations.filter((entry) => entry.animation.effect === "edge-fill").map((entry) => entry.layerId);
  assert.ok(edged(made).includes("shot-a"), "the frame-filling shot behind mirrors its edges");
  const shrunk = createLayer("image", { id: "screen", name: "screen", src: "/api/media/wall.png", x: 0, y: 0, ...FRAME, scaleX: 0.8, scaleY: 0.8 });
  const small = run("lift-focus", { detail: { layer: "phone" } }, { on: createScene({ id: "s", name: "Scene", ...FRAME, duration: 6, layers: [shrunk, phone] }) });
  assert.deepEqual(edged(small), [], "a shrunk screen keeps empty edges");
});

test("card-into-device lands exactly on its slot in the phone's screen, with no streaks unless asked", () => {
  const group = createLayer("group", { id: "phone", name: "phone", x: 1186, y: 60, width: 468, height: 960 });
  const screen = createLayer("rectangle", { id: "phone-screen", name: "phone-screen", parentId: "phone", x: 20, y: 15, width: 428, height: 930 });
  const made = run("card-into-device", { into: { layer: "phone-screen", rect: [5, 20, 90, 30] }, picture: "screen-a" }, { on: scene([group, screen]) });
  const card = made.added.find(({ layer }) => layer.move.part === "card").layer;
  const landed = evaluateLayer(card, made.end);
  const slot = { x: 1186 + 20 + 428 * 0.05, y: 60 + 15 + 930 * 0.2, width: 428 * 0.9, height: 930 * 0.3 };
  for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(landed[key] - slot[key]) < 0.6, `${key} ${landed[key]} vs ${slot[key]}`);
  assert.ok(landed.scaleX === 1 && landed.rotation === 0 && landed.strokeWidth === 0, "flat, at its size, the light frame gone");
  assert.ok(evaluateLayer(card, 0.5).scaleX > 2, "it starts big");
  assert.ok(!made.added.some(({ layer }) => layer.move.part === "streaks") && !made.tags.includes("speed-lines"));
  assert.ok(made.animations.some((entry) => entry.animation.id === "card-into-device.device-in"), "the phone appears around it");
});

test("zoom-blur over shots built as plain cuts: the new shot is whole on the cut frame, so it never dips toward the background", () => {
  const a = createLayer("image", { id: "a", name: "a", src: "/api/media/street.png", x: 0, y: 0, ...FRAME, animations: [{ id: "a.hide", name: "Hide", kind: "hide", start: 1.2 }] });
  const b = createLayer("image", { id: "b", name: "b", src: "/api/media/wall.png", x: 0, y: 0, ...FRAME, animations: [{ id: "b.show", name: "Show", kind: "show", start: 1.2 }] });
  const made = run("zoom-blur", { from: "a", to: "b" }, { on: scene([a, b]), at: 1, dur: 0.4 });
  const appear = made.animations.find((entry) => entry.animation.id === "zoom-blur.to-in").animation;
  const arrived = { ...b, animations: [...b.animations, appear] };
  assert.equal(evaluateLayer(arrived, 1.2).opacity, 1, "b is fully drawn at 1.2 s, where a's own hide cuts it");
});
