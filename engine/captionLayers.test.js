// add_captions: caption layers and cues from SRT, WebVTT, transcripts and plain text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createDocument, createLayer, createScene } from "./model.js";
import { applyOperations } from "./operations.js";
import { defaultFonts } from "./fonts.js";
import { parseSrt } from "./subtitles.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { safeRect } from "./quality/rules/layout.js";
import { runDataQuality } from "./quality/index.js";
import { planCaptions } from "./captionLayers.js";

const sintel = readFileSync(new URL("../tests/fixtures/captions/sintel_en.srt", import.meta.url), "utf8");
const FPS = 30;

function project({ width = 1080, height = 1920, duration = 60, layers = [], background = "#101418" } = {}) {
  return createDocument({ scenes: [createScene({ id: "s1", name: "Main", width, height, duration, background, layers })] });
}

function edit(document, ops) {
  const reports = new Map();
  const next = applyOperations(document, ops.map((op) => ({ sceneId: "s1", ...op })), { fonts: defaultFonts, reports });
  return { document: next, reports: [...reports.values()] };
}

// Frames in which each caption text layer is shown, from the quality checker's timeline.
function shownRuns(document) {
  const model = kinoTimeline(document, "s1", { fonts: defaultFonts, fps: FPS });
  const runs = [];
  for (const item of model.items) {
    if (item.role !== "caption") continue;
    const shown = Array.from(item.samples.opacity, (value) => value > 0.01);
    const first = shown.indexOf(true);
    const last = shown.lastIndexOf(true);
    runs.push({ text: item.text, start: model.times[first], end: last + 1 < model.times.length ? model.times[last + 1] : model.duration });
  }
  return runs.sort((a, b) => a.start - b.start);
}

test("a real SRT file (Sintel) becomes caption pages that show and hide within 1 frame of the file", () => {
  const offset = -107;
  const { document, reports: [report] } = edit(project(), [{ type: "add_captions", text: sintel, offset }]);
  const events = parseSrt(sintel).map((event) => ({ ...event, start: event.start + offset, end: event.end + offset }))
    .filter((event) => event.end > 0 && event.start < 60);
  assert.equal(report.format, "srt");
  assert.equal(report.pages, events.length);
  assert.equal(report.first, 0.25);
  const runs = shownRuns(document);
  assert.equal(runs.length, events.length);
  runs.forEach((run, index) => {
    const event = events[index];
    // Same words; lines may break differently to fit the frame's safe width.
    assert.equal(run.text.replace(/\s+/g, " "), event.text.replace(/\s+/g, " "));
    assert.ok(Math.abs(run.start - Math.max(0, event.start)) <= 1 / FPS + 1e-9, `page ${index + 1} starts at ${run.start}, the file says ${event.start}`);
    assert.ok(Math.abs(run.end - Math.min(60, event.end)) <= 1 / FPS + 1e-9, `page ${index + 1} ends at ${run.end}, the file says ${event.end}`);
  });
});

test("caption pages sit in the safe area and pass the quality checks; line cues mark each page", () => {
  const { document } = edit(project({ duration: 20 }), [{ type: "add_captions", text: sintel, offset: -107 }]);
  const scene = document.scenes[0];
  const safe = safeRect(scene);
  const pages = scene.layers.filter((layer) => /^captions-\d+$/.test(layer.name));
  assert.ok(pages.length > 3);
  for (const page of pages) {
    assert.ok(page.x >= safe.x0 && page.x + page.width <= safe.x1, `${page.name} is inside the safe width`);
    assert.ok(page.y >= safe.y0 && page.y + page.height <= safe.y1, `${page.name} is inside the safe height`);
    assert.equal(page.fillEnabled, true);
    const text = scene.layers.find((layer) => layer.parentId === page.id);
    assert.equal(text.role, "caption");
  }
  const lineCues = document.cues.filter((cue) => cue.kind === "line");
  assert.equal(lineCues.length, pages.length);
  assert.deepEqual(lineCues[0], { name: "captions-1", time: 0.25, kind: "line" });
  const model = kinoTimeline(document, "s1", { fonts: defaultFonts });
  const errors = runDataQuality(model, { context: { outputFps: FPS } }).findings.filter((finding) => finding.severity === "error");
  assert.deepEqual(errors.map((finding) => `${finding.rule} ${finding.message}`), []);
});

test("WebVTT word times become word cues; running add_captions again replaces the group and its cues only", () => {
  const vtt = "WEBVTT\n\n00:01.000 --> 00:03.000\n<00:01.000>Make <00:01.400>it <00:01.700>move.\n";
  let { document, reports: [first, second] } = edit(project({ duration: 6 }), [
    { type: "set_cues", cues: [{ name: "drop", time: 2 }] },
    { type: "add_captions", text: vtt, name: "captions" },
    { type: "add_captions", text: "Otra vez.", name: "captions-es", start: 4, end: 6 },
  ]);
  assert.equal(first.format, "vtt");
  assert.equal(first.cues, 4);
  assert.equal(second.name, "captions-es");
  let report;
  assert.deepEqual(document.cues.map((cue) => cue.name), ["captions-1", "captions-w1-make", "captions-w2-it", "captions-w3-move", "drop", "captions-es-1"]);
  ({ document, reports: [report] } = edit(document, [{ type: "add_captions", text: "Again.", start: 0.5, end: 2 }]));
  assert.equal(report.replaced, true);
  assert.deepEqual(document.cues.map((cue) => cue.name), ["captions-1", "drop", "captions-es-1"]);
  assert.equal(document.scenes[0].layers.filter((layer) => layer.name === "captions").length, 1);
  assert.ok(document.scenes[0].layers.some((layer) => layer.name === "captions-es"));
});

test("a transcript pages by its words; fade, top position, colors and no box are kept", () => {
  const words = "Every feature is reachable by agents".split(" ").map((text, index) => ({ text, start: 1 + index * 0.4, end: 1.35 + index * 0.4 }));
  const { document, reports: [report] } = edit(project({ width: 1920, height: 1080, duration: 5 }), [
    { type: "add_captions", words, position: "top", appear: "fade", box: false, fill: "#FFE8D0", fontSize: 40 },
  ]);
  assert.equal(report.format, "words");
  assert.equal(report.pages, 1);
  assert.equal(report.cues, 1 + words.length);
  const page = document.scenes[0].layers.find((layer) => layer.name === "captions-1");
  assert.equal(page.fillEnabled, false);
  assert.ok(page.y < 200);
  assert.deepEqual(page.animations.map((animation) => animation.kind), ["show", "in", "out", "hide"]);
  const text = document.scenes[0].layers.find((layer) => layer.name === "captions-1-text");
  assert.equal(text.fill, "#FFE8D0");
  assert.equal(text.fontSize, 40);
});

test("fading pages keep their reading time and pass the motion checks; a tight page cuts", () => {
  const roomy = "1\n00:00:01,000 --> 00:00:04,000\nPlan, build and ship.\n\n";
  // 60 characters in exactly 3 s: 20 a second, no time to spare for a fade.
  const line = "Every feature stays reachable through the agent and its tool";
  assert.equal(line.length, 60);
  const tight = `2\n00:00:05,000 --> 00:00:08,000\n${line}\n`;
  const { document } = edit(project({ duration: 10 }), [{ type: "add_captions", text: roomy + tight, appear: "fade" }]);
  const layers = document.scenes[0].layers;
  const fades = (name) => layers.find((layer) => layer.name === name).animations.filter((animation) => animation.kind === "in" || animation.kind === "out").map((animation) => [animation.kind, animation.start, animation.duration]);
  assert.deepEqual(fades("captions-1"), [["in", 1, 0.3], ["out", 3.8, 0.2]]);
  assert.deepEqual(fades("captions-2"), []);
  const findings = runDataQuality(kinoTimeline(document, "s1", { fonts: defaultFonts }), { context: { outputFps: FPS } }).findings;
  assert.deepEqual(findings.filter((finding) => finding.severity === "error" || /duration_band|exit_ratio/.test(finding.rule)).map((finding) => `${finding.rule}: ${finding.message}`), []);
});

test("bad input is refused with a reason, and nothing is half-applied", () => {
  const start = project({ duration: 4 });
  const refuse = (op, pattern) => assert.throws(() => edit(start, [op]), pattern);
  refuse({ type: "add_captions" }, /either text .* or words/);
  refuse({ type: "add_captions", text: "a", words: [{ text: "a", start: 0, end: 1 }] }, /either text/);
  refuse({ type: "add_captions", file: "/tmp/x.srt" }, /file is read by the kino command line/);
  refuse({ type: "add_captions", text: sintel }, /no caption falls inside the scene .*set offset/);
  refuse({ type: "add_captions", text: "Hello", position: "left" }, /position must be one of/);
  // "center" is taken as "middle".
  const [centered, middle] = ["center", "middle"].map((position) => edit(start, [{ type: "add_captions", text: "Hello", position }]).document.scenes[0].layers.at(-1).y);
  assert.equal(centered, middle);
  refuse({ type: "add_captions", text: "Hello", box: "black" }, /box must be a hex color/);
  refuse({ type: "add_captions", text: "x ".repeat(300) }, /need .*s at 20 characters a second/);
  assert.equal(start.scenes[0].layers.length, 0);
});

test("captions over an existing layer leave that layer alone", () => {
  const title = createLayer("text", { id: "title", name: "title", text: "Title", x: 200, y: 400, fontSize: 80 });
  const { document } = edit(project({ duration: 4, layers: [title] }), [{ type: "add_captions", text: "Under the title.", start: 0, end: 3 }]);
  assert.equal(document.scenes[0].layers[0].id, "title");
  const page = document.scenes[0].layers.find((layer) => layer.name === "captions-1");
  assert.deepEqual(page.animations.map((animation) => [animation.kind, animation.start]), [["hide", 3]]);
});

test("with layerId, a transcript's times are seconds into that clip's file, placed through its start and speed", () => {
  // The clip starts at 1 s, plays its file from 2 s, at half speed: file second f plays at 1 + (f - 2) × 2.
  const clip = createLayer("video", { id: "clip", name: "clip", src: "/api/media/0b8e3f8e-1111-4222-8333-444455557777.mp4", mediaStart: 1, mediaOffset: 2, mediaDuration: 8, mediaSpeed: 0.5 });
  const words = [{ text: "Slow", start: 2.5, end: 3 }, { text: "motion", start: 3, end: 3.5 }, { text: "works", start: 3.5, end: 4 }];
  const { document, reports: [report] } = edit(project({ width: 1920, height: 1080, duration: 10, layers: [clip] }), [
    { type: "add_captions", words, layerId: "clip" },
  ]);
  assert.equal(report.first, 2);
  assert.equal(report.last, 5);
  assert.deepEqual(document.cues.filter((cue) => cue.kind === "word").map((cue) => cue.time), [2, 3, 4]);
  // A Speed ramp places them through the same time map the picture and sound use.
  const ramp = { ...clip, mediaSpeed: 1, animations: [{ id: "clip.speed", kind: "custom", name: "Speed", start: 1, duration: 2, easing: "linear", from: { speed: 1 }, to: { speed: 0.25 } }] };
  const ramped = edit(project({ width: 1920, height: 1080, duration: 10, layers: [ramp] }), [{ type: "add_captions", words, layerId: "clip" }]).document;
  const [slow, motion, works] = ramped.cues.filter((cue) => cue.kind === "word").map((cue) => cue.time);
  // Speed 1 - 0.375 u from the clip's start: half a second of file plays by u - 0.1875 u² = 0.5.
  assert.equal(slow, 1 + Math.round((1 - Math.sqrt(1 - 0.375)) / 0.375 * 1000) / 1000);
  assert.ok(motion - slow > 0.5 && works - motion > motion - slow, "each word takes longer as the clip slows");
  // Outside the part the clip plays, or on a clip played backwards, it refuses with the reason.
  const refuse = (layers, op, pattern) => assert.throws(() => edit(project({ duration: 10, layers }), [{ type: "add_captions", words, layerId: "clip", ...op }]), pattern);
  refuse([clip], { offset: 1 }, /give offset or layerId, not both/);
  refuse([{ ...clip, mediaReverse: true }], {}, /plays its file backwards/);
  refuse([{ ...clip, mediaOffset: 20 }], {}, /no caption falls inside the part of "clip"'s file it plays \(20s to 24s\)/);
  refuse([createLayer("text", { id: "clip", name: "clip", text: "x" })], {}, /layerId must be a video or audio layer/);
});

test("caption looks: phrases of the look's size, the key word in the accent color, hidden in silences, a hook title", () => {
  const said = "The best ideas start small. You build something people want.".split(" ");
  let at = 0.2;
  const words = said.map((text) => { const word = { text, start: at, end: at + 0.28 }; at += 0.34 + (text.endsWith(".") ? 1 : 0); return word; });
  const { document, reports } = edit(project({ duration: 6 }), [{ type: "add_captions", words, look: "pop" }]);
  const layers = document.scenes[0].layers;
  const phrases = layers.filter((layer) => /^captions-\d+$/.test(layer.name));
  assert.equal(reports[0].look, "pop");
  assert.equal(reports[0].phrases, phrases.length);
  assert.equal(reports[0].hiddenInSilences, 1);
  for (const phrase of phrases) assert.ok(layers.filter((layer) => layer.parentId === phrase.id).length <= 3);
  assert.equal(layers.find((layer) => layer.text === "ideas").fill, "#FFD84D");
  // "small." ends a sentence before a 1 s pause: its phrase is hidden well before the next starts.
  const small = phrases.find((phrase) => layers.some((layer) => layer.parentId === phrase.id && layer.text === "small."));
  assert.ok(small.animations.find((animation) => animation.kind === "hide").start < words[5].start - 0.5);
  const bold = edit(project({ duration: 6 }), [{ type: "add_captions", words, look: "bold" }]);
  assert.equal(bold.reports[0].hook.text, "The best ideas start small");
  assert.ok(!bold.document.scenes[0].layers.some((layer) => layer.text === "ideas"));
});

test("caption looks pass the gates on fast speech (170 words a minute), under 0.65 s behind the voice, on dark and white frames; reduced motion fades", () => {
  const said = "Most teams spend their mornings chasing updates across seven different tools. We built one place where everything already lives, so you can stop searching and start shipping.".split(" ");
  const round3 = (value) => Math.round(value * 1000) / 1000;
  let at = 0.3;
  const words = said.map((text) => { const word = { text, start: round3(at), end: round3(at + 0.22 + text.length * 0.015) }; at = word.end + 0.05 + (text.endsWith(".") ? 0.8 : 0); return word; });
  for (const look of ["clean", "pop", "word", "highlight", "bold", "editorial"]) for (const background of ["#101418", "#FFFFFF"]) {
    const { document, reports } = edit(project({ duration: 12, background }), [{ type: "add_captions", words, look }]);
    const model = kinoTimeline(document, "s1", { fonts: defaultFonts, fps: FPS });
    const findings = runDataQuality(model, { context: { outputFps: FPS } }).findings;
    const errors = findings.filter((finding) => finding.severity === "error");
    assert.deepEqual(errors.map((finding) => `${look} ${background} ${finding.rule} ${finding.message}`), []);
    // Timed to the voice: no warning asks to slow a word's highlight or start a phrase late.
    assert.deepEqual(findings.filter((finding) => ["first_entrance", "duration_band"].includes(finding.rule)).map((finding) => `${look} ${finding.message}`), []);
    if (look === "editorial") continue;
    const { pages } = planCaptions(project({ duration: 12 }), project({ duration: 12 }).scenes[0], { words, look }, { fonts: defaultFonts });
    assert.equal(pages.length, reports[0].phrases);
    for (const page of pages) assert.ok(page.start - page.words[0].start <= 0.65, `${look} "${page.text}" shows ${page.start - page.words[0].start}s after its first word`);
  }
  const reduced = edit(project({ duration: 12 }), [{ type: "add_captions", words, look: "pop", reduced: true }]);
  const moving = reduced.document.scenes[0].layers.flatMap((layer) => layer.animations ?? []).filter((animation) => animation.from && Object.keys(animation.from).some((key) => key !== "opacity"));
  assert.deepEqual(moving, []);
});
