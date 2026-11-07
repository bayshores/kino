// One bad and one good example for each rendered polish rule (engine/quality/rules/polish.js):
// text_on_busy, small_on_empty and render_artifact. They render real frames with the export
// renderer, the way the agent service does (backend/agent/quality.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { ruleOf, runQuality } from "../engine/quality/index.js";
import { kinoTimeline } from "../engine/quality/kinoTimeline.js";
import { renderSceneFrames } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";

const fonts = await loadBundledFonts();

// A phone screen full of small detail: rows of thin light bars on a dark screen.
const BUSY = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200" viewBox="0 0 600 1200"><rect width="600" height="1200" rx="60" fill="#111317"/>
${Array.from({ length: 40 }, (_, row) => Array.from({ length: 6 }, (_, column) => `<rect x="${40 + column * 90}" y="${40 + row * 28}" width="60" height="10" fill="#e8e6e1"/>`).join("")).join("")}</svg>`;
// A plain warm photo stand-in: a soft gradient.
const PLAIN = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#c98b5a"/><stop offset="1" stop-color="#6b4a7a"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/></svg>`;

let mediaRoot;
test.before(async () => {
  mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-polish-"));
  await writeFile(path.join(mediaRoot, "busy.png"), new Resvg(BUSY).render().asPng());
  await writeFile(path.join(mediaRoot, "plain.png"), new Resvg(PLAIN).render().asPng());
});
test.after(async () => { await rm(mediaRoot, { recursive: true, force: true }); });

function scene({ layers = [], ...fields } = {}) {
  const built = layers.map(({ type, animations = [], ...props }) =>
    createLayer(type, { ...props, animations: animations.map((animation, index) => ({ id: `${props.id}.${index + 1}`, name: `${animation.kind} ${index + 1}`, ...animation })) }));
  return parseDocument(createDocument({ scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 3, background: "#0b0b0c", ...fields, layers: built })] }));
}

async function check(code, document) {
  const expanded = expandComponents(document, "scene", { fonts });
  const renderFrames = (times, { width, hide = [] }) => {
    const left = new Set(hide);
    return renderSceneFrames({ ...expanded, layers: expanded.layers.map((layer) => (left.has(layer.id) ? { ...layer, visible: false } : layer)) }, times, { fonts, width, mediaRoot });
  };
  const { findings } = await runQuality(kinoTimeline(document, "scene", { fonts }), { codes: [code], pixels: true, context: { renderFrames } });
  return findings;
}
async function fires(code, document) {
  const findings = await check(code, document);
  assert.ok(findings.length > 0, `${code} should fire on the bad example`);
  for (const finding of findings) assert.equal(finding.rule, code);
  assert.equal(findings[0].severity, ruleOf(code).level);
  return findings;
}
async function silent(code, document) {
  assert.deepEqual((await check(code, document)).map((finding) => finding.message), [], `${code} should stay silent on the good example`);
}

const caption = (x) => ({ type: "text", id: "caption", name: "caption", text: "turn right", x, y: 820, fontFamily: "Inter", fontSize: 92, fontWeight: 600, fill: "#ffffff", textResize: "width-height" });
const phone = { type: "image", id: "phone", name: "phone", src: "/api/media/busy.png", x: 1200, y: 60, width: 480, height: 960 };

test("text_on_busy: a caption across a phone screen full of detail", async () => {
  const [finding] = await fires("text_on_busy", scene({ layers: [phone, caption(1100)] }));
  assert.equal(finding.itemId, "caption");
  assert.equal(finding.otherId, "phone");
  // The fix moves it beside the phone, clear of its frame, where the frame is calm.
  assert.equal(finding.fix.kind, "group");
  assert.equal(finding.fix.auto, true);
  const [moved] = finding.fix.changes;
  assert.equal(moved.itemId, "caption");
  assert.ok(moved.dx < 0 || moved.dy !== 0, JSON.stringify(moved));
  // Beside the phone, over the calm frame, it is fine.
  await silent("text_on_busy", scene({ layers: [phone, caption(200)] }));
});

test("small_on_empty: a small picture on a flat frame", async () => {
  const shown = (width, height) => scene({ layers: [{ type: "image", id: "shot", name: "shot", src: "/api/media/plain.png", x: (1920 - width) / 2, y: (1080 - height) / 2, width, height }] });
  const [finding] = await fires("small_on_empty", shown(450, 300));
  assert.equal(finding.itemId, "shot");
  // A warning with a hint of other ways, never an auto fix (no blurred copy behind, no forced grow).
  assert.deepEqual([finding.fix.kind, finding.fix.auto], ["hint", undefined]);
  assert.match(finding.fix.text, /device-in-scene.*waive_check small_on_empty/);
  await silent("small_on_empty", shown(1500, 1000));
});

test("render_artifact: an RGB split that draws flat saturated slabs", async () => {
  const split = (amount) => scene({ duration: 2, layers: [{ type: "text", id: "word", name: "word", text: "tip", x: 160, y: 140, fontFamily: "Inter", fontWeight: 700, fontSize: 640, fill: "#ffffff", textResize: "width-height",
    animations: [{ kind: "effect", effect: "rgb-shift", start: 0.5, duration: 1, easing: "linear", keepStill: "off", from: { amount }, to: { amount, direction: 0 } }] }] });
  const [finding] = await fires("render_artifact", split(0.7));
  assert.equal(finding.itemId, "word");
  // No automatic fix: the op softens the split to 40%, for the agent to choose.
  assert.equal(finding.fix.kind, "animation");
  assert.equal(finding.fix.auto, false);
  assert.equal(finding.fix.properties.to.amount, 0.28);
  await silent("render_artifact", split(0.02));
});

test("the brand's fonts come from set_brand kits and the brief", async () => {
  const { brandFontsOf } = await import("./agent/quality.mjs");
  const document = { brands: [{ name: "zuri", fonts: [{ family: "JetBrains Mono" }, { family: "Inter", weight: 500 }] }] };
  assert.deepEqual(brandFontsOf(document, ["Noto Serif"]), ["JetBrains Mono", "Inter", "Noto Serif"]);
  assert.deepEqual(brandFontsOf({}, []), []);
});
