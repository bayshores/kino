// template_end (engine/quality/rules/consistency.js): a centered name with a small line under it
// over a still frame or darkened footage, held at the end, is the template end card; the same
// words over a playing clip, or as a title mid-video, are not.
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
  // The music credit is no tagline: one smaller line.
  assert.match(finding.measured, /^"kino" centered with 1 smaller line \("you direct\. your agent edits\."\) .* for the last 2\.[67]\ds$/);
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
  // With no picture it is still a card, and the rule says so; with a number it is 14.77 s, under the
  // 15 s at which open warnings hold a final render.
  const bare = await build({ picture: undefined });
  assert.equal(bare.findings[0]?.rule, "template_end");
  assert.ok(bare.made.duration < 15);
});

const rect = (id, props = {}) => ({ type: "rectangle", id, name: id, x: 0, y: 0, width: 1920, height: 1080, fill: "#000000", ...props });
const word = (id, value, size, y, at = 7) => text(id, value, { fontSize: size, x: 960 - (value.length * size) / 4, y, animations: [show(at)] });
const flat = (layers) => scene([clip("shot", { animations: [hide(7)] }), ...layers]);

test("template_end: a credit alone is no tagline; a data ending is no name; a tagline at headline size still is", async () => {
  const name = word("wordmark", "kino", 180, 380);
  const credit = text("credit", "Music: Hot Pursuit, CC BY 4.0", { fontSize: 28, x: 700, y: 1000, animations: [show(7)] });
  assert.deepEqual(await run(flat([name, credit])), [], "a name on black keeps its required credit");
  assert.equal((await run(flat([name, credit, word("tagline", "you direct. your agent edits.", 48, 620)])))[0]?.rule, "template_end");
  // A big number and its label is a data ending, not a name card.
  assert.deepEqual(await run(flat([word("stat", "40%", 220, 360), word("label", "fewer meetings a month", 48, 640)])), []);
  // A 72 px tagline (0.36 of a 200 px name) is set at headline size and still sits under it; at 150 px (0.75) it is a second title.
  const [big] = await run(flat([word("wordmark", "kino", 200, 360), word("tagline", "you direct. your agent edits.", 72, 640)]));
  assert.match(big?.measured ?? "", /1 smaller line/);
  assert.deepEqual(await run(flat([word("wordmark", "kino", 200, 300), word("tagline", "edits.", 150, 600)])), []);
});

test("template_end: footage darkened 35% or more behind the card is a backdrop, by opacity or fill alpha; a light tint is not", async () => {
  // fp-3 to fp-5 all ended on this: a centered name and line over moving footage under a dark tint.
  const words = [word("wordmark", "kino", 180, 380), word("tagline", "you direct. your agent edits.", 48, 620)];
  assert.equal((await run(scene([clip("shot"), rect("scrim", { fill: "#00000099", animations: [show(7)] }), ...words])))[0]?.rule, "template_end");
  assert.equal((await run(scene([clip("shot"), rect("scrim", { opacity: 0.6, animations: [show(7)] }), ...words])))[0]?.rule, "template_end");
  assert.equal((await run(scene([clip("shot"), rect("scrim", { fill: "#000000E6", animations: [show(7)] }), ...words])))[0]?.rule, "template_end");
  // A 20% grade over the shot leaves it a shot; a tint over part of the frame is a scrim for the words.
  assert.deepEqual(await run(scene([clip("shot"), rect("scrim", { fill: "#00000033", animations: [show(7)] }), ...words])), []);
  assert.deepEqual(await run(scene([clip("shot"), rect("scrim", { y: 540, height: 540, fill: "#00000099", animations: [show(7)] }), ...words])), []);
});

// Formats built with real media facts: a 2x screen recording, a 1440 px screenshot and a 3000 px one.
const FACTS = { edges: 0.12, flat: 0.6, busy: [10, 20, 40, 40] };
const MEDIA = {
  "calendar.mp4": { id: "calendar.mp4", src: "/api/media/calendar.mp4", width: 2880, height: 1800, name: "calendar.mp4", kind: "video", duration: 8, ...FACTS },
  "invite.mp4": { id: "invite.mp4", src: "/api/media/invite.mp4", width: 2880, height: 1800, name: "invite.mp4", kind: "video", duration: 8, ...FACTS },
  "product.png": { id: "product.png", src: "/api/media/product.png", width: 1440, height: 900, name: "product.png", edges: 0.1, flat: 0.7, busy: [20, 20, 40, 40] },
  "calendar.png": { id: "calendar.png", src: "/api/media/calendar.png", width: 1440, height: 900, name: "calendar.png", edges: 0.1, flat: 0.7, busy: [20, 20, 40, 40] },
  "invite.png": { id: "invite.png", src: "/api/media/invite.png", width: 1440, height: 900, name: "invite.png", edges: 0.1, flat: 0.7, busy: [20, 20, 40, 40] },
  "big.png": { id: "big.png", src: "/api/media/big.png", width: 3000, height: 1875, name: "big.png", edges: 0.1, flat: 0.7, busy: [20, 20, 40, 40] },
  "logo.png": { id: "logo.png", src: "/api/media/logo.png", width: 512, height: 512, name: "Logo" },
};
async function formatFindings(format, slots, aspect, codes) {
  const env = { fonts: defaultFonts, media: (ref) => MEDIA[ref], logo: { media: MEDIA["logo.png"] }, sceneId: "scene" };
  const { made } = await buildVideoFormat(expandVideoFormat(format, { ...VIDEO_FORMATS[format].example, logo: "logo.png", ...slots }, { aspect }), (compose) => composeScene(compose, env));
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "scene", name: "Scene", width: made.frame.width, height: made.frame.height, duration: made.duration, background: made.background, layers: made.layers })] }));
  const mediaSizes = Object.fromEntries(Object.values(MEDIA).map(({ src, width, height, edges, flat: flats, busy }) => [src, { width, height, ...(edges ? { edges, flat: flats, busy } : {}) }]));
  const { findings } = await runQuality(kinoTimeline(document, "scene", { fonts: defaultFonts }), { codes, pixels: false, context: { mediaSizes } });
  return { made, findings: findings.map((finding) => `${finding.rule} ${finding.itemId}`) };
}

test("app-demo with screen recordings shows each one large enough to read, its end included", async () => {
  for (const aspect of ["16:9", "9:16"]) {
    const { made, findings } = await formatFindings("app-demo", { recordings: ["calendar.mp4", "invite.mp4"] }, aspect, ["screen_unreadable", "soft_upscale", "template_end"]);
    assert.deepEqual(findings, [], aspect);
    // Each step is a window onto the recording's busy part, the clip inside drawn about 2 px a point.
    const window = made.layers.find((layer) => layer.id.endsWith("device-slide"));
    const inside = made.layers.find((layer) => layer.parentId === window.id);
    assert.equal(window.type, "group");
    assert.ok(window.clipContent && inside.type === "video" && inside.width >= 2880, `${aspect} ${inside?.width}`);
  }
  // Screenshots keep the plain picture.
  const { made } = await formatFindings("app-demo", {}, "16:9", []);
  assert.equal(made.layers.find((layer) => layer.id.endsWith("device-slide")).type, "image");
});

test("the end shot is never drawn soft: a small screenshot becomes a blurred backdrop, a large one stays sharp", async () => {
  for (const [format, aspect, key] of [["social-promo", "9:16", "product"], ["feature-announcement", "9:16", "shot"], ["product-launch", "16:9", "product"]]) {
    const small = await formatFindings(format, { [key]: "product.png" }, aspect, ["soft_upscale", "screen_unreadable", "template_end"]);
    assert.deepEqual(small.findings, [], format);
    assert.ok(small.made.layers.find((layer) => layer.id.endsWith("cta-end-shot")).blur >= 16, format);
  }
  const big = await formatFindings("product-launch", { product: "big.png" }, "16:9", ["soft_upscale"]);
  assert.deepEqual(big.findings, []);
  assert.ok(!big.made.layers.find((layer) => layer.id.endsWith("cta-end-shot")).blur);
});
