// The footage finder's agent surface: library {topic:"footage"} lists, searches, scans and notes
// found videos for one project. The service (agent/service.mjs) reads the project's saved footage
// state, calls handle(), and saves what the answer's `update` returns. Nothing here touches the
// network: `finder` (index.mjs createFootageFinder) does the searching and scanning.
//
// Each candidate video gets a short code per project (F1, F2, ...). At most FOOTAGE_KEPT stay;
// the oldest go first, but a scanned, noted or imported one is never dropped. A scan waits up to
// about 50 s; a longer one answers with its progress and a next call that repeats it.
import { call, callText } from "../agent/next-call.mjs";
import { offeredLine, saidWords } from "../inspire.mjs";
import { readTime } from "./scan.mjs";
import { cleanShot, placeName, SCAN_VERSION } from "./score.mjs";
import { candidateLine, droppedLine, editsLast, elsewhereLine, nothingFoundText, scannedLine, someoneElses, withStudies } from "./search.mjs";
import { scanCall, searchCall } from "./step.mjs";
import { needLine, wantBySection } from "./needs.mjs";
import { applySaid, linesBlock, lineStretch, spokenLines } from "./words.mjs";

/** Candidates kept per project. */
export const FOOTAGE_KEPT = 24;
/**
 * How long a scan call waits before it answers with progress (ms). Under a minute, like kino's
 * other blocking waits (render, inspire), so an agent client's tool timeout never cuts it off.
 */
export const FOOTAGE_WAIT_MS = 50_000;
/** How long a finished scan's result stays for the repeat call that collects it (ms). */
export const FOOTAGE_RESULT_KEEP_MS = 10 * 60_000;
/** Shots listed in a scan answer. */
export const FOOTAGE_SHOTS_SHOWN = 12;
/** Shots the scan answer's import call names. */
export const FOOTAGE_IMPORT_PICKS = 6;
/**
 * The footage topic's line in the library topics answer. At most 150 characters, as the topics
 * answer is read by every agent.
 */
export const FOOTAGE_TOPIC_LINE = 'footage {search, want?, scan?, note?} (found video from YouTube, or source:"commons"; scan ranks shots to import)';

const VERDICTS = ["pick", "maybe", "no"];
const TITLE_SHOWN = 70;
const SAID_SHOWN = 120;

/** An expected refusal: the service turns it into an error answer with this code and next call. */
export class FootageError extends Error {
  constructor(code, message, nextCall = null) {
    super(message);
    this.code = code;
    this.nextCall = nextCall;
  }
}

/** The import call for chosen shots of one candidate. */
export const importCall = (code, shots) => call("project", { action: "import", file: code, options: { shots } });

/** The import call for one spoken line: its time range (words.mjs lineStretch) as from/to, in seconds. */
export const importLineCall = (code, line, duration = null) => {
  const { from, to } = lineStretch(line, duration);
  return call("project", { action: "import", file: code, options: { from, to } });
};

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const short = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

/** "3:17.2": a time in a video, to a tenth of a second. */
export function stamp(seconds) {
  const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

const clockOf = (seconds) => stamp(seconds).replace(/\.\d$/, "");

/** The first line of every footage answer when the video has clips of the person's, else "". */
export function personClipsLine(count) {
  return count > 0 ? `This video has ${count} clip${count === 1 ? "" : "s"} of the person's: they lead; found clips fill the gaps.` : "";
}

/** True for a media item the footage finder imported (P9 marks it); the rest are the person's. */
export const isFoundClip = (item) => Boolean(item?.footage);

/** How many of the person's own videos the document plays: distinct video sources that were not found. */
export function personClipCount(document, media = []) {
  const found = new Set(media.filter(isFoundClip).flatMap((item) => [item.src, item.id && `/api/media/${item.id}`]).filter(Boolean));
  const sources = new Set();
  for (const scene of document?.scenes ?? []) {
    for (const layer of scene.layers ?? []) if (layer.type === "video" && layer.src && !found.has(layer.src)) sources.add(layer.src);
  }
  return sources.size;
}

/** A candidate's saved-scan id: "yt-<11>" or "commons-<pageid>". */
export const scanIdOf = (candidate) => String(candidate.id).replace(/^clip:/, "");

/**
 * What a ref names: {code: "F3"} for F3 or F3.12, {id: "clip:yt-<11>"} for yt:<11>, clip:yt-<11>
 * or a YouTube link, {id: "clip:commons-<n>"}, {top: true}, or null.
 */
export function parseRef(ref) {
  const text = oneLine(ref);
  if (!text || text.toLowerCase() === "top") return { top: true };
  const code = /^f(\d{1,3})(?:\.\d+)?$/i.exec(text);
  if (code) return { code: `F${Number(code[1])}` };
  const yt = /^(?:yt:|clip:yt-)([A-Za-z0-9_-]{11})$/.exec(text)
    ?? /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(text);
  if (yt) return { id: `clip:yt-${yt[1]}` };
  const commons = /^clip:commons-(\d+)$/.exec(text);
  if (commons) return { id: `clip:commons-${commons[1]}` };
  return null;
}

const emptyFootage = () => ({ want: "", next: 1, order: [], candidates: [] });
/** Candidates in their order, the scanned ones with a logo on their shots after the rest. */
export const logoLast = (candidates) => [...candidates].sort((a, b) => Number(Boolean(a?.scan?.logo)) - Number(Boolean(b?.scan?.logo)));
const kept = (candidate) => Boolean(candidate.scan || candidate.note || candidate.imported);

/**
 * Adds found candidates to the project's footage, each with its code (one it had keeps it), and
 * trims to FOOTAGE_KEPT, oldest first, never a kept one. `order` becomes these candidates' codes.
 */
export function addCandidates(footage, found) {
  const next = structuredClone(footage ?? emptyFootage());
  const order = [];
  for (const candidate of found) {
    const old = next.candidates.find((entry) => entry.id === candidate.id);
    if (old) { Object.assign(old, candidate, { code: old.code }); order.push(old.code); continue; }
    const code = `F${next.next++}`;
    next.candidates.push({ ...candidate, code });
    order.push(code);
  }
  while (next.candidates.length > FOOTAGE_KEPT) {
    const index = next.candidates.findIndex((entry) => !kept(entry) && !order.includes(entry.code));
    if (index < 0) break;
    next.candidates.splice(index, 1);
  }
  next.order = order.filter((code) => next.candidates.some((entry) => entry.code === code));
  return next;
}

function findCandidate(footage, ref) {
  const asked = parseRef(ref);
  const list = footage?.candidates ?? [];
  if (!asked) return null;
  if (asked.code) return list.find((entry) => entry.code === asked.code) ?? null;
  if (asked.id) return list.find((entry) => entry.id === asked.id) ?? null;
  // top: the best of the last search not scanned yet, else the first of it.
  const ordered = (footage?.order ?? []).map((code) => list.find((entry) => entry.code === code)).filter(Boolean);
  return ordered.find((entry) => !entry.scan) ?? ordered[0] ?? null;
}

// "top" when someone else's edits are known: the best unscanned one that is not one, else findCandidate's.
function topOf(footage, known) {
  const list = footage?.candidates ?? [];
  const ordered = (footage?.order ?? []).map((code) => list.find((entry) => entry.code === code)).filter(Boolean);
  return ordered.find((entry) => !entry.scan && !someoneElses(entry, known)) ?? findCandidate(footage, "top");
}

// The candidate after `code` in the last search that is not scanned yet (nor someone else's edit).
function nextCandidate(footage, code, known = null) {
  const list = footage?.candidates ?? [];
  const order = (footage?.order ?? []).filter((each) => each !== code);
  return order.map((each) => list.find((entry) => entry.code === each)).find((entry) => entry && !entry.scan && !someoneElses(entry, known)) ?? null;
}

/** A shot's mean light, 0 to 255, or null when its scan did not keep it. */
const lightOf = (shot) => (Number.isFinite(shot.luma) ? Math.round(shot.luma * 255) : null);

/** "(middle, 6% of frame)": where a shot's subject box sits and its part of the frame. */
const subjectPlace = (subject) => `(${placeName(subject.box)}, ${Math.max(1, Math.round(subject.share * 100))}% of frame)`;

/** A face at least this tall (part of the frame's height) is a close shot. */
export const CLOSE_FACE = 0.25;
/** A face at least this tall, or a figure at least FIGURE_MEDIUM tall, is a medium shot; shorter is wide. */
export const MEDIUM_FACE = 0.08;
export const FIGURE_MEDIUM = 0.6;

/**
 * A shot's framing from its boxes: {by: "figure" or "face", height (the box's part of the frame's
 * height), room (the part of the frame outside the box), place, scale}. The figure (whole-body box)
 * when one was found, else the face box; null with neither (a salient box says where the eye goes,
 * never that someone is there). scale: close for a face CLOSE_FACE tall or more; medium for a face
 * MEDIUM_FACE tall or more, or a figure FIGURE_MEDIUM tall or more; else wide.
 */
export function framingOf(shot) {
  const face = shot.subject?.kind === "face" ? shot.subject.box : null;
  const box = shot.figure?.box ?? face;
  if (!box) return null;
  const faceHeight = face ? face[3] : 0;
  const scale = faceHeight >= CLOSE_FACE ? "close" : faceHeight >= MEDIUM_FACE || (shot.figure && box[3] >= FIGURE_MEDIUM) ? "medium" : "wide";
  return { by: shot.figure ? (shot.figure.by === "mask" ? "figure mask" : "figure") : "face", height: box[3], room: 1 - box[2] * box[3], place: placeName(box), scale };
}

/** "wide (figure 19% high, left, room 96%)": a shot's framing in the shots line ("figure mask": the subject mask's box, drawn footage). */
const framingWords = ({ by, height, room, place, scale }) => `${scale} (${by} ${Math.max(1, Math.round(height * 100))}% high, ${place}, room ${Math.round(room * 100)}%)`;

/**
 * One shot's line: `F1.37 3:17.2-3:19.0 1.8s motion 82 light 140 face 40 (middle, 6% of frame)
 * match +3.1`, flags after. light is the mean of 255. face is left out when faces were not read
 * (no face detector, or drawn footage); a shot without a face names where the eye goes instead
 * (`salient (left, 30% of frame)`, Vision saliency) when that was measured. Saliency gives a box
 * on nearly every picture, a flat dark one too (measured: 31% of a near-black frame), so it says
 * where, never that something was found. How the shot moves follows motion (`motion 40 camera`:
 * still, subject or camera), and its framing (framingOf) the boxes: `wide (figure 19% high, left,
 * room 96%)`.
 */
export function shotLine(code, shot, { matchShown = false } = {}) {
  const parts = [`${code}.${shot.n}`, `${stamp(shot.start)}-${stamp(shot.end)}`, `${(shot.end - shot.start).toFixed(1)}s`, `motion ${Math.round(shot.motion ?? 0)}${shot.moving ? ` ${shot.moving}` : ""}`];
  const light = lightOf(shot);
  if (light !== null) parts.push(`light ${light}`);
  const face = shot.subject?.kind === "face" ? shot.subject : null;
  if (Number.isFinite(shot.face)) parts.push(`face ${Math.round(shot.face)}${face ? ` ${subjectPlace(face)}` : ""}`);
  if (shot.subject && !(face && Number.isFinite(shot.face))) parts.push(`${shot.subject.kind === "face" ? "face" : "salient"} ${subjectPlace(shot.subject)}`);
  const framing = framingOf(shot);
  if (framing) parts.push(framingWords(framing));
  // Drawn footage: a subject mask too large to be a figure (score.mjs MASK_NO_FIGURE) is said, with its size.
  else if (shot.figure === null && Number.isFinite(shot.maskCover)) parts.push(`no figure read (mask covers ${shot.maskCover}% of the picture)`);
  if (matchShown && Number.isFinite(shot.match)) parts.push(`match ${shot.match >= 0 ? "+" : ""}${shot.match.toFixed(1)}`);
  if (shot.flags?.length) parts.push(shot.flags.join(" "));
  if (shot.hasSubs) parts.push("has subtitles");
  if (shot.says) parts.push(`says: "${shot.says}"`);
  return parts.join(" ");
}

// True when a face was found in the shot (its share of frames, or its subject box).
const hasFace = (shot) => shot.face > 0 || shot.subject?.kind === "face";
const asNumber = (value) => (value === null || value === "" || typeof value === "boolean" ? NaN : Number(value));
// true or false ("true" and "false" read the same).
const yesNo = (test) => (value) => {
  const asked = value === "true" ? true : value === "false" ? false : value;
  return typeof asked === "boolean" ? (shot) => test(shot) === asked : null;
};
const over = (measure, above) => (value) => {
  const limit = asNumber(value);
  if (!Number.isFinite(limit)) return null;
  return (shot) => { const known = measure(shot); return known !== null && (above ? known > limit : known < limit); };
};
const lengthOf = (shot) => shot.end - shot.start;
const sizeOf = (shot) => (shot.subject ? shot.subject.share * 100 : null);
// The framing's height and room in percent (framingOf), or null without a figure or face box.
const heightOf = (shot) => { const framing = framingOf(shot); return framing ? framing.height * 100 : null; };
const roomOf = (shot) => { const framing = framingOf(shot); return framing ? framing.room * 100 : null; };
// One word or a list of words ("wide", ["wide", "medium"]) that a shot's measure must be.
const oneOf = (measure, words) => (value) => {
  const asked = (Array.isArray(value) ? value : [value]).map((word) => String(word).toLowerCase());
  if (!asked.length || !asked.every((word) => words.includes(word))) return null;
  return (shot) => asked.includes(measure(shot));
};
// height: N (taller than N percent of the frame) or [low, high] (between them).
const heightBetween = (value) => {
  const [low, high] = Array.isArray(value) ? value.map(asNumber) : [asNumber(value), Infinity];
  if (!Number.isFinite(low) || Number.isNaN(high) || (Array.isArray(value) && value.length !== 2)) return null;
  return (shot) => { const known = heightOf(shot); return known !== null && known >= low && known <= high; };
};

/**
 * library footage scan's `filter`: each key narrows the listed shots. light is the mean of 255,
 * bigger the face (else salient) box's percent of the frame, speech a line said in the shot
 * (captions or listening). The framing keys read the figure (whole-body box), else the face box
 * (framingOf): figure (one was found), scale (wide, medium, close), height (percent of the frame's
 * height, N or [low, high]), room (more than N percent of the frame outside the box). moving:
 * still, subject or camera. A shot whose scan did not keep a measure (light from an older scan) is
 * left out by it.
 */
export const SHOT_FILTERS = {
  face: yesNo(hasFace),
  speech: yesNo((shot) => Boolean(shot.says)),
  brighter: over(lightOf, true),
  darker: over(lightOf, false),
  longer: over(lengthOf, true),
  shorter: over(lengthOf, false),
  bigger: over(sizeOf, true),
  // A shot that never read figures (no figure key: kept from an older scan, or a shot shorter than
  // the 0.5 s between frames that read them) is left out and counted, never read as "no figure".
  figure: (value) => { const test = yesNo((shot) => Boolean(shot.figure))(value); return test && ((shot) => shot.figure !== undefined && test(shot)); },
  scale: oneOf((shot) => framingOf(shot)?.scale ?? null, ["wide", "medium", "close"]),
  height: heightBetween,
  room: over(roomOf, true),
  moving: oneOf((shot) => shot.moving ?? null, ["still", "subject", "camera"]),
};

/** library footage scan's `sort`: each orders the listed shots, the first named first. */
export const SHOT_SORTS = {
  light: (shot) => -(lightOf(shot) ?? -1),
  dark: (shot) => lightOf(shot) ?? 256,
  length: (shot) => -lengthOf(shot),
  size: (shot) => -(sizeOf(shot) ?? -1),
  motion: (shot) => -(shot.motion ?? 0),
  time: (shot) => shot.start,
  // The framing's height: wide puts the smallest figure or face first, close the tallest; room the most room.
  wide: (shot) => heightOf(shot) ?? 101,
  close: (shot) => -(heightOf(shot) ?? -1),
  room: (shot) => -(roomOf(shot) ?? -1),
};

/**
 * A scan's shots narrowed by `filter` ({face: true, brighter: 100, longer: 2, ...}, SHOT_FILTERS)
 * and ordered by `sort` (SHOT_SORTS; ties keep the scan's order). Answers {shots, line}: line says
 * what was asked, how many shots are left, and any key it did not know (those are left out, never
 * refused). Without filter or sort: the shots as they are and line "". unmeasured: {key: why} for a
 * fact this scan never measured (speech without captions or listening, faces on drawn footage):
 * that key is said and left out, so "no line heard" is never read as "nobody speaks".
 */
export function narrowShots(shots = [], filter = undefined, sort = undefined, { unmeasured = {} } = {}) {
  if (filter === undefined && sort === undefined) return { shots, line: "" };
  const asked = filter && typeof filter === "object" && !Array.isArray(filter) ? filter : {};
  const used = [], ignored = [], tests = [], unknown = [];
  // Faces read on no shot at all (no face detector here, or drawn footage): face is unmeasured too.
  const why = { ...(shots.length && shots.every((shot) => !Number.isFinite(shot.face) && shot.subject?.kind !== "face") ? { face: "faces not read in this scan" } : {}), ...unmeasured };
  for (const [key, value] of Object.entries(asked)) {
    if (Object.hasOwn(SHOT_FILTERS, key) && why[key]) { unknown.push(`${key} (${why[key]})`); continue; }
    const test = Object.hasOwn(SHOT_FILTERS, key) ? SHOT_FILTERS[key](value) : null;
    if (test) { tests.push(test); used.push(`${key}:${value && typeof value === "object" ? JSON.stringify(value) : value}`); } else ignored.push(`${key}:${short(oneLine(JSON.stringify(value)), 20)}`);
  }
  if (filter !== undefined && (!filter || typeof filter !== "object" || Array.isArray(filter))) ignored.push(`filter ${short(oneLine(JSON.stringify(filter)), 30)}`);
  let out = shots.filter((shot) => tests.every((test) => test(shot)));
  const order = sort === undefined ? null : Object.hasOwn(SHOT_SORTS, sort) ? SHOT_SORTS[sort] : null;
  if (sort !== undefined && !order) ignored.push(`sort:${short(oneLine(JSON.stringify(sort)), 20)}`);
  if (order) out = out.map((shot, index) => ({ shot, index })).sort((a, b) => order(a.shot) - order(b.shot) || a.index - b.index).map(({ shot }) => shot);
  // Shots a used light or size filter could not measure (light: a scan from before every shot kept
  // it; size: no face or saliency box) are left out by it, and the line counts them.
  const lightless = used.some((part) => /^(brighter|darker):/.test(part)) ? shots.filter((shot) => lightOf(shot) === null).length : 0;
  const boxless = used.some((part) => part.startsWith("bigger:")) ? shots.filter((shot) => sizeOf(shot) === null).length : 0;
  const unframed = used.some((part) => /^(scale|height|room):/.test(part)) ? shots.filter((shot) => !framingOf(shot)).length : 0;
  // moving: a shot kept from an older scan, or one whose flow failed, has none.
  const unmoved = used.some((part) => part.startsWith("moving:")) ? shots.filter((shot) => !shot.moving).length : 0;
  const unread = used.some((part) => part.startsWith("figure:")) ? shots.filter((shot) => shot.figure === undefined).length : 0;
  const parts = [
    `${used.length ? `Filter ${used.join(" ")}` : "No filter"}${order ? `, sorted by ${sort}` : ""}: ${out.length} of ${shots.length} shot${shots.length === 1 ? "" : "s"}.`,
    lightless ? `${lightless} kept no light (an older scan) and are left out.` : "",
    boxless ? `${boxless} have no face or salient box and are left out.` : "",
    unframed ? `${unframed} have no figure or face box and are left out.` : "",
    unmoved ? `${unmoved} kept no movement measure and are left out.` : "",
    unread ? `${unread} have no figure measure (kept from an older scan, or no frame of the shot read figures) and are left out.` : "",
    unknown.length ? `Not measured, left out: ${unknown.join(", ")}.` : "",
    ignored.length ? `Not known, left out: ${ignored.join(", ")} (filter: ${Object.keys(SHOT_FILTERS).join(", ")}; sort: ${Object.keys(SHOT_SORTS).join(", ")}).` : "",
  ];
  return { shots: out, line: parts.filter(Boolean).join(" ") };
}

/** The shots a scan answer's import call names: the best clean ones (no flag but logo). */
export function importPicks(scan, most = FOOTAGE_IMPORT_PICKS) {
  return (scan.shots ?? []).filter(cleanShot).slice(0, most).map((shot) => shot.n);
}

function skippedLine(skipped = {}) {
  const names = { text: "text", subtitles: "subtitles", dark: "dark", repeats: "repeats", short: "under 0.4 s" };
  const parts = Object.entries(names).filter(([key]) => skipped[key] > 0).map(([key, name]) => `${skipped[key]} ${name}`);
  return parts.length ? `Skipped: ${parts.join(", ")}.` : "";
}

/** Where a scan's marks sit ("top-left and bottom-right"), or "" when it has none. */
export const markPlaces = (marks = []) => [...new Set(marks.map((mark) => mark.where))].join(" and ");

/** "a mark is burned into this clip's top-left" for the places markPlaces gives. */
export const burnedInto = (places) => `a mark is burned into this clip's ${places}`;

// The scan's marks, said once: a mark is burned into this clip's top-left (on every shot): the two ways out.
function marksLine(marks = []) {
  if (!marks.length) return "";
  const every = marks.every((mark) => mark.share >= 0.8);
  return `Note: ${burnedInto(markPlaces(marks))} (on ${every ? "every shot" : "most shots"}). Pick a clean clip (marked ones list last), or crop it out; the import answer gives the numbers.`;
}

const signed = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;

// Why want did not rank the shots: the image model did not run, or no shot came close enough.
function noMatchLine(scan) {
  const rest = `shots rank on motion${scan.drawn ? "" : ", faces"} and clean frames.`;
  if (!scan.model) return `The image model did not run, so "${scan.want}" was not looked for: ${rest}`;
  const closest = Number.isFinite(scan.matchBest) && Number.isFinite(scan.matchBar) ? ` (closest ${signed(scan.matchBest)}, a match needs ${signed(scan.matchBar)})` : "";
  return `No visual match for "${scan.want}"${closest}: ${rest}`;
}

/**
 * The scan answer: what was looked at, the 12 best shots, the skips, the match word and, with a
 * song in the video, how many shots it needs (needs.mjs shotsNeeded).
 */
export function scanText(candidate, scan, need = null, heard = null, view = null) {
  const looked = (scan.windows ?? []).reduce((sum, window) => sum + window.end - window.start, 0);
  const shots = scan.shots ?? [];
  // view: narrowShots' answer, the shots to list and its line.
  const listed = view?.shots ?? shots;
  const head = `${candidate.code} "${short(oneLine(candidate.title) || candidate.id, TITLE_SHOWN)}" · scanned ${clockOf(looked)}${candidate.seconds ? ` of ${clockOf(candidate.seconds)}` : ""} · ${shots.length} shot${shots.length === 1 ? "" : "s"}${listed.length > FOOTAGE_SHOTS_SHOWN ? `, best ${FOOTAGE_SHOTS_SHOWN}` : ""}:`;
  const lines = [view?.line, ...listed.slice(0, FOOTAGE_SHOTS_SHOWN).map((shot) => shotLine(candidate.code, shot, { matchShown: scan.matchShown }))].filter(Boolean);
  const tail = [skippedLine(scan.skipped), marksLine(scan.marks)];
  if (scan.drawn) tail.push("Faces: not read on drawn footage.");
  if (scan.want && !scan.matchShown) tail.push(noMatchLine(scan));
  if (shots.length) tail.push(`Stills: look {mode:"source", ref:"${candidate.code}"}`);
  tail.push(needLine(need));
  return [head, ...lines, ...tail.filter(Boolean), ...heardLines(candidate, shots, heard)].join("\n");
}

// What the captions add at the end of a scan answer: the spoken lines with the shots each covers, or
// why there are none. A video without captions is said so once; asked-for words say it every time.
function heardLines(candidate, shots, heard) {
  if (!heard) return [];
  const said = heard.said ? `"${heard.said}"` : "";
  // Listening here was tried (words asked for, no captions) and could not be done: its reason, once.
  if (heard.listenWhy) return [`${heard.retry ? "Captions could not be read now and" : "No captions, and"} listening here failed (${short(oneLine(heard.listenWhy), 140)}), so ${said} was not looked for: shots rank on the picture.`];
  if (heard.retry) return said ? [`Captions could not be read now (${short(oneLine(heard.why), 60)}), so ${said} was not looked for.`] : [];
  if (heard.none) return said ? [`No captions, so ${said} was not looked for: shots rank on the picture.`] : heard.noCaptionsKnown ? [] : [`No captions on this video. ${LISTEN_HINT}`, referenceSaid(candidate.code, heard.refLines)].filter(Boolean);
  const spoken = spokenLines(heard.lines, shots, heard.said);
  const out = [linesBlock(candidate.code, spoken, heard)];
  if (said && !heard.hits) out.push(`Nobody says ${said} in the scanned part${heard.local ? ` (listened to ${heard.listened} s here${heard.left ? `, ${heard.left} s of the scan not listened to` : ""})` : ""}.`);
  return out.filter(Boolean);
}

/**
 * Said after "No captions on this video." once: the way to find a shot by its words anyway. The
 * speed is what two proofs measured on this machine for 60 s of speech, audio cut included, the
 * YouTube download not: 5.4 to 5.7 s (.scratch/run8/wave/said-local/RESULT.md), 8.5 to 12.5 s in a
 * second run (.scratch/run8/wave/said-local-review/RESULT.md). A rough rule, not a promise.
 */
export const LISTEN_HINT = 'said:"<words>" listens to the scanned part on this computer (English only, about 6 to 13 s per minute of video, plus the download) and puts the shots that say them first.';

/**
 * The no-captions hint's second half, when a measured reference of this project said a line
 * (search.mjs knownEdits lines): that line as a ready scan call. Run 8 scanned its footage at
 * T38, before it read any reference (T64), so the read's lines came after the shots were picked;
 * the scan answer is where the words meet the footage. "" without such a line.
 */
function referenceSaid(code, lines = []) {
  const line = offeredLine(lines);
  return line ? `A line your reference ${line.id} says at ${Number(line.at).toFixed(1)} s (a voice or the song): ${callText(scanCall(code, { said: saidWords(line.text) }))}` : "";
}

/** Said where a video's download or scan is already in the data folder (found-shared): nothing is fetched again. */
export const REUSED_LINE = "already on this computer: reused";

function candidateLabel(candidate, known = null, reused = null) {
  const line = candidateLine({ ...candidate, title: short(oneLine(candidate.title), TITLE_SHOWN) }, candidate.code);
  const status = [candidate.imported ? "imported" : candidate.scan ? `scanned, ${candidate.scan.shots} shots${candidate.scan.logo ? `, ${burnedInto(candidate.scan.logo)}` : ""}` : "", reused?.has(candidate.id) ? REUSED_LINE : ""].filter(Boolean).join(" · ");
  const note = candidate.note ? `${candidate.note.verdict}: ${short(candidate.note.why, 60)}` : "";
  const edit = someoneElses(candidate, known);
  return [line, edit ? `someone else's edit (${edit.why})` : "", status, note].filter(Boolean).join(" · ");
}

// Why a scan could not run, in the agent's words, with what to do instead: the next video of the
// last search (never "top", which names the one that just failed), else a new search.
function scanFailure(error, candidate, footage = null) {
  if (error?.name === "AbortError") throw error;
  if (error?.code === "BOT_CHECK")
    return new FootageError("bot_check", `YouTube asked for a bot check, so kino pauses YouTube downloads for 15 minutes (no cookies are ever sent). Use the person's own clips, or Commons: library {topic:"footage", search, source:"commons"}.`, call("library", { topic: "footage", search: "<subject> <scene words>", source: "commons" }));
  if (error?.code === "NO_YTDLP" || error?.code === "NO_JS_RUNTIME") return new FootageError("failed", error.message, null);
  const next = nextCandidate(footage, candidate.code);
  return new FootageError("failed", `${candidate.code} could not be scanned: ${short(oneLine(error?.message ?? error), 200)}`, next ? scanCall(next.code) : searchCall());
}

// A from or to that is no time, or a stretch that ends before it starts: refused before any download.
function checkStretch(from, to, nextCall) {
  const read = (name, value) => {
    if (value === undefined || value === null || value === "") return null;
    const time = readTime(value);
    if (time === null || time < 0) throw new FootageError("bad_input", `"${name}" (${short(oneLine(value), 20)}) is not a time: use seconds (197) or minutes and seconds ("3:17").`, nextCall);
    return time;
  };
  const start = read("from", from);
  const end = read("to", to);
  if (start !== null && end !== null && end <= start) throw new FootageError("bad_input", `"to" must come after "from".`, nextCall);
}

/**
 * The footage topic. deps: finder {search(words, {signal}), searchCommons?(words),
 * scan(candidate, {want, from, to, whole, onProgress, signal}), readScan(id)}, waitMs, now.
 * handle(input, {footage, personClips, signal, song?}) answers {text, data, nextCall, update?}: update
 * maps the saved footage state to the new one (the service applies it inside its state update);
 * song() answers the video's song needs (needs.mjs shotsNeeded) or null, asked only by a finished scan.
 */
export function createFootageActions({ finder, waitMs = FOOTAGE_WAIT_MS, keepMs = FOOTAGE_RESULT_KEEP_MS }) {
  // Scans running now, by scan id and options: a repeated call joins its scan instead of starting another.
  const scans = new Map();
  // Listenings running now (spoken.mjs), by video and stretches: a repeated call joins its listening.
  const listens = new Map();

  function withLead(personClips, lines) {
    return [personClipsLine(personClips), ...lines].filter(Boolean).join("\n");
  }

  async function search(input, { footage, personClips, signal, known = null }) {
    const words = oneLine(input.search ?? input.query);
    const want = input.want === undefined ? null : short(oneLine(input.want), 160);
    const said = input.said === undefined ? null : short(oneLine(input.said), SAID_SHOWN);
    if (!words) throw new FootageError("bad_input", 'search needs words: the series or subject and the scene, such as "<series> fight".', searchCall());
    let found;
    try {
      found = input.source === "commons"
        ? { words, candidates: await finder.searchCommons(words), dropped: {} }
        : await finder.search(words, { signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error?.code === "web_search_off") throw new FootageError("web_search_off", error.message, call("library", { topic: "footage", search: words }));
      if (error?.code === "BOT_CHECK") throw scanFailure(error, { code: "" });
      throw new FootageError(error?.code === "NO_YTDLP" ? "failed" : error?.code ?? "failed", short(oneLine(error?.message ?? error), 240));
    }
    // Someone else's edits are listed after the rest (and so scanned last), never hidden.
    known = await withStudies(known, found.candidates);
    const ranked = editsLast(found.candidates, known);
    // Videos whose scan is already in the data folder (another project scanned them): this project
    // lists them as scanned, so a scan call answers at once and nothing is downloaded again.
    const onComputer = new Map();
    for (const candidate of ranked) {
      if (candidate.source === "commons" || !finder.readScan) continue;
      const have = await finder.readScan(scanIdOf(candidate)).catch(() => null);
      if (have?.version === SCAN_VERSION && Array.isArray(have.shots)) onComputer.set(candidate.id, { id: scanIdOf(candidate), shots: have.shots.length, at: have.scannedAt ?? null, ...(have.marks?.length ? { logo: markPlaces(have.marks) } : {}) });
    }
    const update = (saved) => {
      const next = ranked.length ? addCandidates(saved, ranked) : structuredClone(saved ?? emptyFootage());
      for (const entry of next.candidates) if (!entry.scan && onComputer.has(entry.id)) entry.scan = onComputer.get(entry.id);
      if (want !== null) next.want = want;
      if (said !== null) next.said = said;
      return next;
    };
    if (!found.candidates.length) {
      return { text: withLead(personClips, [nothingFoundText(found.words ?? words, found.tried), droppedLine(found.dropped)]),
        data: { candidates: [], dropped: found.dropped }, nextCall: searchCall(), update: want !== null || said !== null ? update : undefined };
    }
    const after = update(footage);
    const listed = editsLast(logoLast(after.order.map((code) => after.candidates.find((entry) => entry.code === code))), known);
    const lines = [
      `Found ${listed.length} for "${found.tried ?? found.words ?? words}"${found.cached ? " (from today's search)" : ""}${after.want ? `; want: "${after.want}"` : ""}:`,
      ...listed.map((candidate) => candidateLabel(candidate, known, new Set(onComputer.keys()))),
      droppedLine(found.dropped),
      scannedLine(listed, known) || "Scan one to see its best shots (it waits up to about 50 s).",
    ];
    return { text: withLead(personClips, lines), data: { candidates: listed.map((candidate) => ({ code: candidate.code, id: candidate.id, title: candidate.title, seconds: candidate.seconds, license: candidate.license, ...(someoneElses(candidate, known) ? { edit: true } : {}) })), dropped: found.dropped },
      nextCall: scanCall("top"), update };
  }

  async function scan(input, { footage, personClips, signal, song: songOf, known = null }) {
    const ref = oneLine(input.scan);
    const asked = parseRef(ref);
    if (!asked) throw new FootageError("bad_input", `scan is "top", a code such as F1, or yt:<id>; "${short(ref, 40)}" is none of these.`, scanCall("top"));
    let saved = footage ?? emptyFootage();
    known = await withStudies(known, saved.candidates);
    let candidate = asked.top ? topOf(saved, known) : findCandidate(saved, ref);
    // A YouTube id not in the list joins it (the agent or the person found it elsewhere).
    if (!candidate && asked.id?.startsWith("clip:yt-")) {
      const videoId = asked.id.slice("clip:yt-".length);
      saved = addCandidates(saved, [{ id: asked.id, source: "youtube", videoId, title: "", page: `https://www.youtube.com/watch?v=${videoId}`, license: "unknown" }]);
      saved.order = footage?.order ?? [];
      candidate = saved.candidates.find((entry) => entry.id === asked.id);
    }
    if (!candidate) {
      if (!saved.candidates.length) throw new FootageError("not_found", "No footage found yet: search first.", searchCall());
      throw new FootageError("not_found", `${ref} is not one of this video's footage candidates (${saved.candidates.map((entry) => entry.code).join(", ")}).`, call("library", { topic: "footage" }));
    }
    known = await withStudies(known, [candidate]);
    // Saves the candidate (one that joined from a yt: id) in the current state when it is missing.
    const ensure = (current) => {
      const after = structuredClone(current ?? emptyFootage());
      let entry = after.candidates.find((each) => each.id === candidate.id);
      if (!entry) {
        after.candidates.push({ ...candidate });
        entry = after.candidates.at(-1);
        after.next = Math.max(after.next ?? 1, Number(candidate.code.slice(1)) + 1);
      }
      return { after, entry };
    };
    const joined = !findCandidate(footage, ref);
    const want = input.want === undefined ? saved.want ?? "" : short(oneLine(input.want), 160);
    const said = input.said === undefined ? saved.said ?? "" : short(oneLine(input.said), SAID_SHOWN);
    const options = { want, from: input.from, to: input.to, whole: input.whole === true };
    const id = scanIdOf(candidate);
    const plain = options.from === undefined && options.to === undefined && !options.whole;
    checkStretch(input.from, input.to, scanCall(candidate.code));
    const repeat = scanCall(candidate.code, { ...(input.want !== undefined ? { want } : {}), ...(input.said !== undefined ? { said } : {}), ...(plain ? {} : { from: input.from, to: input.to, ...(options.whole ? { whole: true } : {}) }),
      ...(input.filter !== undefined ? { filter: input.filter } : {}), ...(input.sort !== undefined ? { sort: input.sort } : {}) });
    // A scan saved before with the same words answers at once.
    let result = plain ? await finder.readScan(id).catch(() => null) : null;
    // A scan of an older version is scanned again. One of other words is ranked again from its saved
    // vectors when the finder can (no download); else it is scanned again.
    if (result && result.version !== SCAN_VERSION) result = null;
    else if (result && (result.want ?? "") !== want) result = await finder.rematch?.(id, want).catch(() => null) ?? null;
    const reusedScan = Boolean(result);
    if (!result) {
      const key = `${id}\n${JSON.stringify(options)}`;
      let job = scans.get(key);
      if (!job) {
        job = { progress: "Starting: reading the video's length, chapters and most-replayed parts." };
        // A finished scan stays a while, so the repeat call after a progress answer collects it
        // (a from/to or whole scan is not saved for readScan) instead of starting it again.
        job.promise = finder.scan(candidate, { ...options, signal: undefined, onProgress: (line) => { job.progress = line; } })
          .then((value) => ({ value }), (error) => ({ error }))
          .finally(() => { setTimeout(() => { if (scans.get(key) === job) scans.delete(key); }, keepMs).unref?.(); });
        scans.set(key, job);
      }
      let timer;
      const waited = await Promise.race([job.promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]);
      clearTimeout(timer);
      // A failure is told once: the next same call tries again.
      if (waited?.error && scans.get(key) === job) scans.delete(key);
      if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
      if (!waited) {
        return { text: withLead(personClips, [`${candidate.code} is still scanning. ${job.progress}`, "Send the same call again: it joins this scan and waits for it."]),
          data: { scanning: candidate.code }, nextCall: repeat, update: joined ? (current) => ensure(current).after : undefined };
      }
      if (waited.error) {
        if (waited.error?.code === "UNPLAYABLE") {
          const reason = waited.error.reason ?? "unavailable";
          const next = nextCandidate(saved, candidate.code);
          const update = (current) => {
            const after = structuredClone(current ?? emptyFootage());
            after.candidates = after.candidates.filter((entry) => entry.code !== candidate.code);
            after.order = (after.order ?? []).filter((code) => code !== candidate.code);
            return after;
          };
          return { text: withLead(personClips, [`${candidate.code} cannot play from here (${reason}). Dropped${next ? `; ${next.code} is next.` : "."}`]),
            data: { dropped: candidate.code, reason }, nextCall: next ? scanCall(next.code) : searchCall(), update };
        }
        throw scanFailure(waited.error, candidate, saved);
      }
      result = waited.value;
    }
    // The video's song (needs.mjs), when it has one: the answer says how many shots it needs, and
    // the import call names every clean shot listed, up to 1.5 times that.
    const need = await songOf?.({ signal }).catch(() => null) ?? null;
    // What is said (captions, kept once per video by the finder): each shot gets `says`, and shots
    // that say the asked words go first (words.mjs applySaid). A video without captions is no error.
    let answer = candidate.source === "commons" ? null : await finder.captions?.(candidate, { signal }).catch((error) => { if (error?.name === "AbortError") throw error; return null; });
    const noCaptions = Boolean(answer?.none && !answer.retry);
    // No captions (or none readable now) and words asked for: listen to the scanned stretch here
    // (spoken.mjs), bounded and kept per video. A long listen answers with its progress and a repeat call.
    if (said && answer && !answer.lines?.length && candidate.source !== "commons" && finder.spoken) {
      const key = `${id}\n${JSON.stringify(result.windows ?? [])}`;
      let listen = listens.get(key);
      if (!listen) {
        listen = finder.spoken(candidate, result.windows ?? [], { signal: undefined })
          .finally(() => { setTimeout(() => { if (listens.get(key) === listen) listens.delete(key); }, keepMs).unref?.(); });
        listens.set(key, listen);
      }
      let timer;
      const heardHere = await Promise.race([listen, new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]);
      clearTimeout(timer);
      if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
      if (!heardHere) {
        return { text: withLead(personClips, [`${candidate.code} has no captions; listening to the scanned part for "${said}" on this computer, still going.`, "Send the same call again: it joins the listening and waits for it."]),
          data: { listening: candidate.code }, nextCall: repeat, update: joined ? (current) => ensure(current).after : undefined };
      }
      answer = heardHere.none ? { ...answer, listenWhy: heardHere.why } : heardHere;
    }
    const lines = answer?.lines ?? [];
    const applied = lines.length ? applySaid(result.shots ?? [], lines, said) : { shots: result.shots ?? [], hits: 0 };
    result = { ...result, shots: applied.shots };
    const heard = answer ? { ...answer, said, hits: applied.hits, noCaptionsKnown: Boolean(candidate.noCaptions), refLines: known?.lines } : null;
    // filter and sort narrow the listing (and so the import call) to the shots asked for.
    // With no line heard (no captions, no listening), speech is unknown, never "nobody speaks".
    const view = narrowShots(result.shots, input.filter, input.sort, { unmeasured: {
      ...(lines.length ? {} : { speech: "no captions or listening in this scan" }),
      // Figures (whole-body boxes; on drawn footage the subject mask's too) and how shots move need
      // Vision's people (or foreground) and flow on this computer.
      ...(result.vision?.people === true || (result.drawn && result.vision?.foreground === true) ? {} : { figure: "figures not read in this scan" }),
      ...(result.vision?.flow === true ? {} : { moving: "no optical flow in this scan" }),
    } });
    const picks = importPicks({ shots: view.shots }, need ? Math.min(FOOTAGE_SHOTS_SHOWN, Math.max(FOOTAGE_IMPORT_PICKS, need.import)) : FOOTAGE_IMPORT_PICKS);
    const spoken = lines.length ? spokenLines(lines, result.shots, said) : [];
    const firstHit = spoken.find((line) => line.hit);
    const update = (current) => {
      const { after, entry } = ensure(current);
      entry.scan = { id, shots: (result.shots ?? []).length, at: result.scannedAt ?? null, ...(result.marks?.length ? { logo: markPlaces(result.marks) } : {}) };
      if (noCaptions) entry.noCaptions = true;
      if (input.want !== undefined) after.want = want;
      if (input.said !== undefined) after.said = said;
      return after;
    };
    const song = need ? { bpm: need.bpm, shots: need.shots, import: need.import, parts: need.parts.map(({ kind, from, to, shots }) => ({ kind, from, to, shots })), want: wantBySection(want, need.parts) } : undefined;
    // Someone else's edit (not the person's pasted link): the next call moves on, its import stays possible.
    const elsewhere = Boolean(someoneElses(candidate, known)) && !candidate.given;
    const importNext = firstHit ? importLineCall(candidate.code, firstHit, candidate.seconds) : picks.length ? importCall(candidate.code, picks) : null;
    const nextImport = elsewhere ? null : importNext;
    const following = nextCandidate(saved, candidate.code, known);
    // After this scan: someone else's edit says so once; and when fewer than half of the last search is scanned, how many.
    const listed = (saved.order ?? []).map((code) => saved.candidates.find((entry) => entry.code === code)).filter(Boolean).map((entry) => entry.code === candidate.code ? { ...entry, scan: entry.scan ?? { id } } : entry);
    return { text: withLead(personClips, [reusedScan ? `${candidate.code}: ${REUSED_LINE} (its scan is saved here, nothing downloaded).` : "", scanText(candidate, result, need, heard, view), elsewhereLine(candidate, known), scannedLine(listed, known)]),
      data: { code: candidate.code, id, ...(view.line ? { listed: view.shots.length } : {}), shots: view.shots.slice(0, FOOTAGE_SHOTS_SHOWN).map((shot) => [shot, framingOf(shot)]).map(([{ n, start, end, motion, moving, face, match, flags, says, said: hit, hasSubs, luma, subject, figure }, framing]) => ({ n, start, end, motion, face, match, flags,
        ...(Number.isFinite(luma) ? { light: Math.round(luma * 255) } : {}), ...(subject ? { subject } : {}),
        ...(moving ? { moving } : {}), ...(figure ? { figure: { box: figure.box, by: figure.by ?? "body" } } : {}),
        ...(framing ? { scale: framing.scale, height: Math.round(framing.height * 100), room: Math.round(framing.room * 100) } : {}),
        ...(says ? { says } : {}), ...(hit ? { said: true } : {}), ...(hasSubs ? { hasSubs: true } : {}) })), matchShown: Boolean(result.matchShown),
        ...(result.marks?.length ? { logo: markPlaces(result.marks), marks: result.marks.map(({ where, box }) => ({ where, box })) } : {}), ...(result.drawn ? { drawn: true } : {}), ...(song ? { song } : {}),
        ...(elsewhere ? { edit: true, ...(importNext ? { import: importNext } : {}) } : {}),
        ...(lines.length ? { captions: { lang: answer.lang, auto: Boolean(answer.auto), ...(answer.local ? { local: true } : {}), ...(said ? { said, hits: applied.hits } : {}) }, lines: spoken.map(({ start, end, text, gloss, hit, shots }) => ({ start, end, text, ...(gloss ? { gloss } : {}), shots, ...(hit ? { said: true } : {}) })) } : {}) },
      nextCall: nextImport ?? (following ? scanCall(following.code) : searchCall()), update };
  }

  function note(input, { footage, personClips, known = null }) {
    const given = input.note ?? {};
    const candidate = findCandidate(footage, given.id);
    if (!candidate || parseRef(given.id)?.top) throw new FootageError("not_found", "note.id is one of this video's footage codes, such as F3 (library {topic:\"footage\"} lists them).", call("library", { topic: "footage" }));
    if (!VERDICTS.includes(given.verdict)) throw new FootageError("bad_input", 'note.verdict is "pick", "maybe" or "no".');
    const why = oneLine(given.why);
    if (why.length < 8 || why.length > 300) throw new FootageError("bad_input", "note.why says in 8 to 300 characters why this video fits or not (what its shots show, its quality, a watermark).");
    const update = (current) => {
      const after = structuredClone(current ?? emptyFootage());
      const entry = after.candidates.find((each) => each.id === candidate.id);
      if (entry) entry.note = { verdict: given.verdict, why };
      return after;
    };
    const after = update(footage);
    const next = given.verdict === "no" ? nextCandidate(after, candidate.code, known) : null;
    // A no moves on to the next video; a pick or maybe scans this one (a saved scan answers at once).
    const nextCall = given.verdict === "no" ? (next ? scanCall(next.code) : searchCall()) : scanCall(candidate.code);
    return { text: withLead(personClips, [`${candidate.code}: ${given.verdict} saved.`]), data: { code: candidate.code, verdict: given.verdict }, nextCall, update };
  }

  async function list({ footage, personClips, known = null }) {
    known = await withStudies(known, footage?.candidates);
    const candidates = editsLast(logoLast(footage?.candidates ?? []), known);
    if (!candidates.length) {
      return { text: withLead(personClips, ["No footage found for this video yet. Search with the series or subject and the scene; want names what the shots should show, in visual words."]),
        data: { candidates: [] }, nextCall: searchCall() };
    }
    const lines = [`${candidates.length} found video${candidates.length === 1 ? "" : "s"}${footage.want ? `; want: "${footage.want}"` : ""}:`, ...candidates.map((candidate) => candidateLabel(candidate, known)), scannedLine(candidates, known)];
    const first = topOf(footage, known);
    return { text: withLead(personClips, lines), data: { candidates: candidates.map((entry) => ({ code: entry.code, id: entry.id, title: entry.title, scanned: Boolean(entry.scan), ...(entry.note ? { note: entry.note.verdict } : {}), ...(entry.imported ? { imported: true } : {}), ...(someoneElses(entry, known) ? { edit: true } : {}) })) },
      nextCall: first ? scanCall(first.code) : searchCall() };
  }

  async function handle(input, context) {
    if (input.note !== undefined) return note(input, context);
    if (input.scan !== undefined) return scan(input, context);
    if (input.search !== undefined || input.query !== undefined) return search(input, context);
    if (input.want !== undefined || input.said !== undefined) {
      const want = input.want === undefined ? null : short(oneLine(input.want), 160);
      const said = input.said === undefined ? null : short(oneLine(input.said), SAID_SHOWN);
      const saved = [want !== null && `want saved: "${want}". Scans rank shots by it.`, said !== null && `said saved: "${said}". Scans put shots that say it first.`].filter(Boolean);
      return { text: withLead(context.personClips, saved), data: { ...(want !== null ? { want } : {}), ...(said !== null ? { said } : {}) }, nextCall: scanCall("top"),
        update: (current) => ({ ...structuredClone(current ?? emptyFootage()), ...(want !== null ? { want } : {}), ...(said !== null ? { said } : {}) }) };
    }
    return list(context);
  }

  return { handle };
}
