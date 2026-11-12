// add_captions: caption text becomes caption layers in a scene, and named cues in document.cues.
//
// In:  an SRT or WebVTT file's text, plain text with a time span, or a timed transcript
//      (words [{text, start, end}] in seconds). Nothing is sent anywhere: word times come from
//      the file or transcript the agent passes in.
// Out: one group named `name` (default "captions") holding one group per page (what is on screen
//      at one time): `captions-1`, `captions-2`, … Each page group draws the box behind the text
//      and is shown from the page's start to its end with Show and Hide operations. Inside it is
//      one text layer `captions-1-text` with role "caption" and the page's lines.
//      Cues: kind "line" `captions-1` at each page's start, and kind "word" `captions-w1-hello`
//      at each word's start when the source has word times.
//
// Paging and timing follow common timed-text subtitle limits (captionPaging.js): 42 characters a line,
// two lines, 20 characters a second, 5/6 s to 7 s per page, 2 frames between pages. A line also
// has to fit the frame's safe area at the chosen font size (measured with the real font).
//
// Times: file and transcript times are seconds on the scene's clock, plus `offset`. Pages that
// end before 0 or start after the scene's end are dropped; pages that cross either edge are cut
// to it. With `layerId` they are seconds into that video or audio layer's file instead, placed
// where the scene plays them (its Play start, offset and speed; clipTimes below), and cut to
// the part of the scene where the clip plays. Cue times are on the same clock (document.cues has one clock; a caption cue's time is
// the time in the scene that holds the captions).
//
// Running add_captions again with the same name replaces that group and its cues.
import { createLayer, uid } from "./model.js";
import { layoutText } from "./textLayout.js";
import { presetAnimation } from "./animation.js";
import { createVisibilityOperation } from "./visibilityOps.js";
import { safeRect } from "./quality/rules/layout.js";
import { charactersOf } from "./quality/analysis.js";
import { SUBTITLE_LIMITS, pageEvents, pageProblems, pageScript, pageWords } from "./captionPaging.js";
import { parseSubtitles, subtitleFormat } from "./subtitles.js";
import { cueSlug, withCues } from "./cues.js";
import { MAX_CUES } from "./qualityFields.js";
import { mediaPlaybackRange, mediaSceneTime, mediaSoundTime } from "./playback.js";
import { fileSecondsPlayed, isReversed } from "./mediaTime.js";
import { captionWordsFromSpeech, checkSpeechLayer, checkTranscript, speechWords } from "./speech.js";
import { CAPTION_LOOKS, isLightFill, lookDefaults, phraseCaptions, wordsOfPage } from "./captionLooks.js";
import { round } from "./numbers.js";

export const CAPTION_POSITIONS = ["bottom", "middle", "top"];
export const CAPTION_APPEARS = ["cut", "fade"];
export const CAPTION_TIMINGS = ["source", "fit"];
export const DEFAULT_CAPTION_BOX = "#000000B8"; // black at 72%
// A fade in of 0.3 s and a fade out two thirds as long: the shortest the motion checks accept.
const FADE_IN_SECONDS = 0.3;
const FADE_OUT_SHARE = 2 / 3;
const COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** True for a cue that add_captions wrote for the caption group with this cue slug. */
export function isCaptionCue(cue, slug) {
  if (cue.kind !== "line" && cue.kind !== "word") return false;
  const rest = cue.name.startsWith(`${slug}-`) ? cue.name.slice(slug.length + 1) : null;
  return rest !== null && (cue.kind === "line" ? /^\d+$/.test(rest) : /^w\d+(?:-[a-z0-9-]+)?$/.test(rest));
}

function fail(message) {
  throw new Error(`add_captions: ${message}`);
}

function optionalNumber(value, key, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    fail(`${key} must be a number from ${min} to ${max}.`);
  return value;
}

function optionalChoice(value, key, choices) {
  if (value === undefined) return undefined;
  if (!choices.includes(value)) fail(`${key} must be one of ${choices.join(", ")}.`);
  return value;
}

/** The caption style for a scene: the operation's choices over defaults scaled to the frame. */
export function captionStyle(scene, operation = {}) {
  const scale = Math.min(scene.width, scene.height) / 1080;
  const fontSize = optionalNumber(operation.fontSize, "fontSize", { min: 8, max: 400 }) ?? Math.max(12, Math.round(48 * scale));
  const box = operation.box === undefined ? DEFAULT_CAPTION_BOX : operation.box;
  if (box !== false && (typeof box !== "string" || !COLOR.test(box))) fail("box must be a hex color such as #000000B8, or false for no box.");
  const fill = operation.fill ?? "#FFFFFF";
  if (typeof fill !== "string" || !COLOR.test(fill)) fail("fill must be a hex color such as #FFFFFF.");
  const fontFamily = operation.fontFamily ?? "Inter";
  if (typeof fontFamily !== "string" || !fontFamily.trim() || fontFamily.length > 100) fail("fontFamily must be a font name.");
  return {
    fontSize,
    fontFamily,
    fontWeight: optionalNumber(operation.fontWeight, "fontWeight", { min: 100, max: 900 }) ?? 600,
    fill,
    box,
    // "center" is the usual word for "middle".
    position: optionalChoice(operation.position === "center" ? "middle" : operation.position, "position", CAPTION_POSITIONS) ?? "bottom",
    appear: optionalChoice(operation.appear, "appear", CAPTION_APPEARS) ?? "cut",
    shadow: operation.look !== undefined && CAPTION_LOOKS[operation.look]?.shadow === true && isLightFill(fill),
    padX: Math.round(fontSize * 0.5),
    padY: Math.round(fontSize * 0.3),
  };
}

// A text layer with the caption style, sized to its lines (no wrapping: lines are explicit).
function captionText(text, style, fonts) {
  const layer = createLayer("text", {
    text,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fill: style.fill,
    lineHeight: 1.2,
    textAlign: "center",
    textResize: "width-height",
    role: "caption",
    ...(style.shadow ? { shadow: { color: "#000000A6", x: 0, y: Math.round(style.fontSize * 0.05), blur: Math.round(style.fontSize * 0.3) } } : {}),
  });
  const { width, height } = layoutText(layer, fonts);
  return { ...layer, width, height };
}

/** fits(line): the line, at the caption style, is no wider than the safe area allows. */
export function captionFits(scene, style, fonts) {
  const safe = safeRect(scene);
  const widest = safe.x1 - safe.x0 - 2 * style.padX;
  const known = new Map();
  return (line) => {
    if (!known.has(line)) known.set(line, captionText(line, style, fonts).width <= widest);
    return known.get(line);
  };
}

// The pages in source time, from whichever input the operation has.
function sourcePages(scene, operation, { fits, fps, span }) {
  if (operation.file !== undefined && operation.text === undefined)
    fail("file is read by the kino command line and the MCP tools; over HTTP, send the file's text as text.");
  const hasText = operation.text !== undefined;
  const hasWords = operation.words !== undefined;
  if (hasText === hasWords) fail("give either text (an SRT or WebVTT file's text, or plain text) or words [{text, start, end}].");
  const timing = optionalChoice(operation.timing, "timing", CAPTION_TIMINGS) ?? "source";
  if (hasWords) {
    if (!Array.isArray(operation.words) || !operation.words.length || operation.words.length > 20000) fail("words must be a list of 1 to 20000 {text, start, end}.");
    return { ...pageWords(operation.words, { fps, fits, span }), events: operation.words.length, format: "words" };
  }
  if (typeof operation.text !== "string") fail("text must be a string.");
  const format = optionalChoice(operation.format, "format", ["srt", "vtt", "text"]) ?? subtitleFormat(operation.text);
  if (format === "text") {
    const start = optionalNumber(operation.start, "start", { min: 0, max: scene.duration }) ?? 0;
    const end = optionalNumber(operation.end, "end", { min: 0, max: scene.duration }) ?? scene.duration;
    return { ...pageScript(operation.text, { start, end, fps, fits }), events: 1, format };
  }
  const events = parseSubtitles(operation.text, format);
  return { ...pageEvents(events, { fps, timing, fits }), events: events.length, format };
}

/**
 * add_captions {layerId}: the caption times are seconds into that video or audio layer's file
 * (a transcript of the clip), so each one goes where the scene plays that moment: after its
 * Play start, from its mediaOffset, at its speed (playback.js mediaSceneTime). A clip at 0.5×
 * shows each caption twice as long. Returns {layer, place(fileTime) → scene time, bounds (the
 * scene times the clip plays), from, to (the file seconds it plays)}.
 */
function clipTimes(scene, operation) {
  if (operation.offset !== undefined) fail("give offset or layerId, not both: with layerId the times are seconds into that layer's file.");
  if (operation.text !== undefined && (operation.format ?? subtitleFormat(operation.text)) === "text")
    fail("layerId places the times of a caption file or a transcript (words); plain text uses start and end on the scene's clock.");
  const layer = scene.layers.find((item) => item.id === operation.layerId);
  if (!layer) fail(`layer ${operation.layerId} was not found in this scene.`);
  if ((layer.type !== "video" && layer.type !== "audio") || !layer.src) fail(`"${layer.name}" is a ${layer.type} layer; layerId must be a video or audio layer that plays a file.`);
  if (isReversed(layer)) fail(`"${layer.name}" plays its file backwards (mediaReverse), so its captions would run backwards; give times on the scene's clock instead.`);
  const range = mediaPlaybackRange(layer, scene.duration);
  if (!range) fail(`"${layer.name}" does not play inside this scene.`);
  // The file seconds it plays (mediaSoundTime stops 2 ms before the end, so the last frame exists).
  const from = mediaSoundTime(layer, range.start);
  const to = Math.max(0, layer.mediaOffset ?? 0) + fileSecondsPlayed(layer, range.end - (layer.mediaStart ?? 0));
  // A time before (or after) the part the clip plays lands before (or after) its Play range,
  // so the page is cut or dropped there.
  const place = (time) => (time < from ? range.start - (from - time) : time > to ? range.end + (time - to) : round(mediaSceneTime(layer, time) ?? range.start));
  return { layer, place, bounds: { start: range.start, end: range.end }, from: round(from), to: round(to) };
}

/**
 * add_captions {speech, fix?}: the words of a voice layer's transcript (speech.js), as the scene
 * plays them after any cut_speech, become the operation's `words`. The agent service puts the
 * transcript in as `transcript`. Returns {operation, speech (for the report) or null}.
 */
function fromSpeech(scene, operation) {
  if (operation.speechId === undefined) {
    if (operation.fix !== undefined) fail("fix goes with speech: it corrects the words of a voice layer's transcript.");
    return { operation, speech: null };
  }
  for (const key of ["text", "words", "layerId"])
    if (operation[key] !== undefined) fail(`speech takes its words from the voice's transcript; leave out ${key}.`);
  const pieces = checkSpeechLayer(scene, scene.layers.find((item) => item.id === operation.speechId), "add_captions");
  const found = captionWordsFromSpeech(speechWords(scene, pieces, checkTranscript(operation.transcript, "add_captions")), operation.fix ?? {});
  if (!found.words.length) fail(`no words of "${pieces[0].name}" play in this scene.`);
  const { speechId, transcript, fix, ...rest } = operation;
  return {
    operation: { ...rest, words: found.words },
    speech: {
      layer: pieces[0].name,
      words: found.words.length,
      ...(found.fixed ? { fixed: found.fixed } : {}),
      ...(found.left ? { leftOut: `${found.left} filler or unclear` } : {}),
      ...(found.unused ? { notFound: found.unused } : {}),
    },
  };
}

/** The page's layers: a box group with the text inside, shown only during the page. */
function pageLayers(page, index, { scene, style, fonts, name, parentId }) {
  const text = captionText(page.text, style, fonts);
  const width = text.width + 2 * style.padX;
  const height = text.height + 2 * style.padY;
  const safe = safeRect(scene);
  const y = style.position === "top" ? safe.y0 + scene.height * 0.01
    : style.position === "middle" ? (scene.height - height) / 2
      : safe.y1 - scene.height * 0.01 - height;
  const group = createLayer("group", {
    name: `${name}-${index + 1}`,
    parentId,
    x: Math.round((scene.width - width) / 2),
    y: Math.round(y),
    width,
    height,
    fill: style.box === false ? "#000000" : style.box,
    fillEnabled: style.box !== false,
    radius: Math.round(style.fontSize * 0.25),
  });
  const animations = [];
  if (page.start > 0) animations.push(createVisibilityOperation("show", page.start, uid()));
  if (style.appear === "fade") {
    // Fading takes time from reading, so a page fades only within its spare time: what is left
    // after characters ÷ 20 (the reading check). A page with under 0.1 s to spare cuts instead.
    const spare = page.end - page.start - Math.max(charactersOf(page.text) / 20, 20 / 30);
    const fadeIn = round(Math.min(FADE_IN_SECONDS, spare / (1 + FADE_OUT_SHARE)));
    if (fadeIn >= 0.1) {
      const fadeOut = round(fadeIn * FADE_OUT_SHARE);
      animations.push({ ...presetAnimation("fade-in", group, page.start, scene), id: uid(), duration: fadeIn });
      if (page.end < scene.duration) animations.push({ ...presetAnimation("fade-out", group, round(page.end - fadeOut), scene), id: uid(), duration: fadeOut });
    }
  }
  if (page.end < scene.duration) animations.push(createVisibilityOperation("hide", page.end, uid()));
  group.animations = animations;
  return [group, { ...text, id: uid(), name: `${name}-${index + 1}-text`, parentId: group.id, x: style.padX, y: style.padY }];
}

/**
 * Everything add_captions would do, without changing the document:
 * {layers, pages (scene time), cues, report}. `fonts` measures the lines; `fps` sets the 2-frame
 * gap (30 unless given). `span` {start, end} keeps word pages inside a stretch (keep_line).
 */
export function planCaptions(document, scene, given, { fonts, fps = 30, span } = {}) {
  const { operation: asked, speech } = fromSpeech(scene, given);
  // A look's font, size, color, box, place and entrance, under the operation's own fields.
  const operation = asked.look === undefined ? asked
    : { ...lookDefaults(scene, asked.look), ...Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== undefined)) };
  const phrased = operation.look !== undefined && CAPTION_LOOKS[operation.look].unit === "phrase";
  const style = captionStyle(scene, operation);
  const name = operation.name ?? "captions";
  if (typeof name !== "string" || !cueSlug(name)) fail("name must contain letters or digits.");
  const offset = optionalNumber(operation.offset, "offset", { min: -36000, max: 36000 }) ?? 0;
  const clip = operation.layerId === undefined ? null : clipTimes(scene, operation);
  const place = clip ? clip.place : (time) => round(time + offset);
  // What can be shown: the scene, or with layerId the part of it where the clip plays.
  const bounds = clip?.bounds ?? { start: 0, end: scene.duration };
  // Phrase looks lay out their own lines (captionLooks.js), so only the 42-character limit pages them here.
  const fits = phrased ? () => true : captionFits(scene, style, fonts);
  const source = sourcePages(scene, operation, { fits, fps, span });
  const minimum = 1 / fps;
  let dropped = 0;
  let cut = 0;
  const pages = [];
  for (const page of source.pages) {
    const start = place(page.start);
    const end = place(page.end);
    const shown = { start: Math.max(bounds.start, start), end: Math.min(bounds.end, end) };
    if (shown.end - shown.start < minimum - 1e-9) { dropped += 1; continue; }
    if (shown.start !== start || shown.end !== end) cut += 1;
    const words = page.words?.map((word) => ({ text: word.text, start: place(word.start), end: place(word.end) }))
      .filter((word) => word.start >= bounds.start && word.start <= bounds.end);
    pages.push({ ...shown, text: page.text, ...(words?.length ? { words } : {}) });
  }
  if (!pages.length && clip) fail(`no caption falls inside the part of "${clip.layer.name}"'s file it plays (${clip.from}s to ${clip.to}s).`);
  if (!pages.length) fail(`no caption falls inside the scene (0 to ${scene.duration}s)${source.pages.length ? `; the first starts at ${round(source.pages[0].start + offset)}s, so set offset` : ""}.`);
  const container = createLayer("group", { name, x: 0, y: 0, width: scene.width, height: scene.height });
  const phrases = phrased ? phraseCaptions(pages.flatMap(wordsOfPage), { scene, style, fonts, fps, name, parentId: container.id, bounds, operation }) : null;
  const layers = [container, ...(phrases ? phrases.layers : pages.flatMap((page, index) => pageLayers(page, index, { scene, style, fonts, name, parentId: container.id })))];
  if (phrases) pages.splice(0, pages.length, ...phrases.phrases);
  const slug = cueSlug(name);
  const lineCues = pages.map((page, index) => ({ name: `${slug}-${index + 1}`, time: page.start, kind: "line" }));
  const wordCues = [];
  let wordCount = 0;
  for (const page of pages) for (const word of page.words ?? []) {
    wordCount += 1;
    const part = cueSlug(word.text, 16);
    wordCues.push({ name: `${slug}-w${wordCount}${part ? `-${part}` : ""}`, time: word.start, kind: "word" });
  }
  const others = (document.cues ?? []).filter((cue) => !isCaptionCue(cue, slug)).length;
  const keepWords = others + lineCues.length + wordCues.length <= MAX_CUES;
  // Phrases are shown as they are said, so the page limits (reading speed, length) do not apply.
  const problems = phrases ? {} : pageProblems(pages, { fps, limits: SUBTITLE_LIMITS });
  const report = {
    name,
    format: source.format,
    events: source.events,
    pages: pages.length,
    ...(source.split ? { split: source.split } : {}),
    ...(dropped ? { dropped } : {}),
    ...(cut ? { cut } : {}),
    ...Object.fromEntries(Object.entries(source.changes).filter(([, count]) => count)),
    cues: lineCues.length + (keepWords ? wordCues.length : 0),
    ...(wordCues.length && !keepWords ? { note: `Word cues left out: the document can hold ${MAX_CUES} cues.` } : {}),
    ...(speech ? { speech } : {}),
    ...(phrases ? phrases.report : operation.look !== undefined ? { look: operation.look } : {}),
    fontSize: style.fontSize,
    first: round(pages[0].start),
    last: round(pages.at(-1).end),
  };
  for (const [problem, list] of Object.entries(problems)) if (list.length) report[problem] = { count: list.length, first: list[0] };
  return { layers, pages, cues: [...lineCues, ...(keepWords ? wordCues : [])], report };
}

// Removes a top-level group with this name and everything inside it. True when there was one.
function removeCaptionGroup(scene, name) {
  const group = scene.layers.find((layer) => layer.type === "group" && layer.parentId === null && layer.name === name);
  if (!group) return false;
  const removed = new Set([group.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const layer of scene.layers) if (removed.has(layer.parentId) && !removed.has(layer.id)) { removed.add(layer.id); grew = true; }
  }
  scene.layers = scene.layers.filter((layer) => !removed.has(layer.id));
  return true;
}

/** Applies add_captions to the document (changed in place). Returns the plan's report. */
export function applyAddCaptions(document, operation, { fonts, fps, span } = {}) {
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) throw new Error(`Scene ${operation.sceneId} was not found.`);
  const plan = planCaptions(document, scene, operation, { fonts, fps, span });
  const replaced = removeCaptionGroup(scene, plan.report.name);
  scene.layers.push(...plan.layers);
  const slug = cueSlug(plan.report.name);
  const old = (document.cues ?? []).filter((cue) => isCaptionCue(cue, slug)).map((cue) => cue.name);
  document.cues = withCues(document.cues, plan.cues, { names: old });
  if (!document.cues.length) delete document.cues;
  return { ...plan.report, ...(replaced ? { replaced: true } : {}) };
}
