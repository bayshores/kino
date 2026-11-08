// template_end (engine/quality/rules/consistency.js): a centered name with a small line under it
// over a still frame, held at the end, is the template end card; the same words over a playing
// clip, or as a title mid-video, are not.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { runQuality } from "./quality/index.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { composeScene } from "./blocks/compose.js";
import { buildVideoFormat, expandVideoFormat, VIDEO_FORMATS } from "./blocks/videoFormats.js";

const text = (id, value, props = {}) => ({ type: "text", id, name: id, text: value, fontFamily: "Inter", fontSize: 72, fill: "#f2f2f2", textResize: "width-height", textAlign: "center", ...props });
const clip = (id, props = {}) => ({ type: "video", id, name: id, src: `/api/media/${id}.mp4`, mediaSourceDuration: 30, x: 0, y: 0, width: 1920, height: 1080, ...props });
const show = (start) => ({ kind: "show", start });
const hide = (start) => ({ kind: "hide", start });

function scene(layers, duration = 10) {
  const built = layers.map(({ type, animations = [], ...fields }) => createLayer(type, { ...fields, animations: animations.map((entry, index) => ({ id: `${fields.id}.${index + 1}`, name: `${entry.kind} ${index + 1}`, ...entry })) }));
  return parseDocument(createDocument({ scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration, background: "#111111", layers: built })] }));
}
const run = async (document) => (await runQuality(kinoTimeline(document, "scene", { fonts: defaultFonts }), { codes: ["template_end"], pixels: false, context: {} })).findings;

// The fp-2 ending: the name centered, a tagline and a credit under it, over the flat frame.
const card = (at, until) => [
  text("wordmark", "kino", { fontSize: 180, x: 760, y: 380, animations: [show(at), ...(until ? [hide(until)] : [])] }),
  text("tagline", "you direct. your agent edits.", { fontSize: 48, x: 640, y: 620, animations: [show(at + 0.3), ...(until ? [hide(until)] : [])] }),
  text("credit", "Music: Hot Pursuit, CC BY 4.0", { fontSize: 36, x: 660, y: 960, animations: [show(at + 0.3), ...(until ? [hide(until)] : [])] }),
];

test("template_end: a centered name and tagline over a flat frame for the last 3 s warns", async () => {
  const [finding] = await run(scene([clip("shot", { animations: [hide(7)] }), ...card(7)]));
  assert.equal(finding?.rule, "template_end");
  assert.match(finding.measured, /^"kino" centered with 2 smaller lines .* for the last 2\.[67]\ds$/);
  assert.match(finding.fix.text, /own material.*never a card/);
});

test("template_end: the same name over a clip still playing, a short card or a mid-video title is silent", async () => {
  assert.deepEqual(await run(scene([clip("shot"), ...card(7)])), [], "over moving footage");
  assert.deepEqual(await run(scene([clip("shot", { animations: [hide(8.8)] }), ...card(8.8)])), [], "1.2 s is a beat, not a held card");
  assert.deepEqual(await run(scene([clip("shot", { animations: [hide(3)] }), ...card(3, 6), clip("after", { animations: [show(6)] })])), [], "a title mid-video");
  assert.deepEqual(await run(scene([clip("shot", { animations: [hide(7)] }), card(7)[0]])), [], "a name alone has no tagline card");
});

test("template_end: a format ends over its picture (cta-end media pushes in), so a default build does not end on a card", async () => {
  const pictures = { "team.jpg": { id: "team.jpg", src: "/api/media/team.jpg", width: 1920, height: 1280, name: "Team" }, "logo.png": { id: "logo.png", src: "/api/media/logo.png", width: 512, height: 512, name: "Logo" } };
  const env = { fonts: defaultFonts, media: (ref) => pictures[ref], logo: { media: pictures["logo.png"] }, sceneId: "scene" };
  const build = async (slots) => {
    const { made } = await buildVideoFormat(expandVideoFormat("testimonial", { ...VIDEO_FORMATS.testimonial.example, logo: "logo.png", ...slots }), (compose) => composeScene(compose, env));
    const document = parseDocument(createDocument({ scenes: [createScene({ id: "scene", name: "Scene", width: made.frame.width, height: made.frame.height, duration: made.duration, background: made.background, layers: made.layers })] }));
    return { made, findings: await run(document) };
  };
  const { made, findings } = await build({});
  assert.deepEqual(findings, []);
  assert.ok(made.layers.find((layer) => layer.id.endsWith("cta-end-shot"))?.animations.some((animation) => animation.name === "Screen push"), "the shot pushes in");
  // With no picture it is still a card, and the rule says so.
  assert.equal((await build({ picture: undefined })).findings[0]?.rule, "template_end");
});
