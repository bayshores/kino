// The viewer test (story engine, milestone 1): a fresh agent that never saw the brief watches the
// cut in order and says what it understood, expected and missed. kino never calls a model: it
// makes the packet (look {mode:"viewer"}: frames every 0.5 s, 9 to a sheet, and what is heard
// when), keeps the beats' intents written before any report (notes intents), records the report
// and the match against the intents (notes viewer), and holds a final render until a recent
// revision passed (viewer_needed, like review_needed). Tried by hand on a product trailer: two
// fresh viewers agreed on the story bugs the person saw.
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { hasTextChanges } from "../../engine/textChange.js";
import { plainWord } from "../../engine/speech.js";
import { sec } from "./describe.mjs";
import { PREFER_FORM, preferLine } from "./bar.mjs";

// One frame every VIEWER_STEP seconds, VIEWER_PER_SHEET to a sheet, VIEWER_TILE px on the long edge.
export const VIEWER_STEP = 0.5;
export const VIEWER_PER_SHEET = 9;
export const VIEWER_TILE = 480;
// The final-render gate holds videos this long or longer (seconds) with footage or speech.
export const VIEWER_UNDER = 15;
// waive_check {code:"viewer"} lets a final render go without a viewer report.
export const VIEWER_WAIVER = "viewer";
// A new packet deletes older packets of the same kind and scene (to save disk space), but
// never one younger than this (ms): a subagent may still be reading it (a viewer once lost its
// packet to the critique packet made a minute later).
export const PACKET_KEEP_MS = 30 * 60 * 1000;
// A look image look.save wrote beside the packets (frame-<hash>.png, critique-<hash>.png).
const LOOK_IMAGE = /^[a-z]+-[a-f0-9]{12}\.png$/;
// A report counts for this many revisions after the one it watched (small fixes after a pass).
export const VIEWER_RECENT = 10;
// Viewer rounds (reports on different revisions) asked per scene, like the critic's rounds; after
// them a final render no longer waits on the last report's story bugs (a test run made 6 packets).
export const VIEWER_ROUNDS = 2;
// Heard words this far apart start a new line.
const LINE_GAP = 0.7;
const GOT = ["yes", "partly", "no"];

// The prompt for the fresh viewer: PLAN.md's viewer protocol, plus the keep-watching score the
// hand-run proof asked for. Nothing about the maker's intent.
export const VIEWER_PROTOCOL = [
  "You are seeing a video for the first time. Read heard.txt, then go through the sheets in order (9 frames each, left to right, top to bottom, every frame labeled with its time).",
  "For each sheet: what is happening, who this is about and what they want, what you expect next (one guess), anything you could not follow or that pulled your attention away, and every text you had time to read.",
  "At the end: the story in one sentence, the moment you cared most, where it dragged, anything that felt unfinished, and from 0 to 10 how much you wanted to keep watching at the start, the middle and the end.",
  "Do not guess the maker's intent; report what you saw. Change nothing.",
  "End with these lines: KEEP start=<0-10> middle=<0-10> end=<0-10>, then DRAG <from>-<to>s for each stretch that dragged (or DRAG none), then CARED t=<seconds> for the moment you cared most.",
].join("\n");

// Used when the project has a bar (bar.mjs): two cuts of one video, A then B, at the same density
// (a B frame at the same story point as each A frame). Blind: which one is the bar changes from
// packet to packet (barSide) and the viewer is never told which is newer or which the person liked.
export const viewerBarProtocol = (a, b) => `There are two cuts of the same video: cut A on sheets ${a}, cut B on sheets ${b}, each frame of B at the same story point as the frame of A in the same place. heard.txt gives what is heard in each. Do the per-sheet notes and the end questions for cut A, then the same for cut B, then compare. Which would you rather watch, and why, specifically (what you read, when it cuts, what moves, at which times)? The KEEP, DRAG and CARED lines are about cut A. Add the line: ${PREFER_FORM}.`;

// A drag this long (seconds) or longer is an open story bug (a warning: it does not hold a render).
export const DRAG_OVER = 5;
const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const SCORES = new RegExp(String.raw`start\D{0,12}?${NUMBER}[^\n]{0,40}?middle\D{0,12}?${NUMBER}[^\n]{0,40}?end\D{0,12}?${NUMBER}`, "gi");
const DRAG = new RegExp(String.raw`^\W*DRAG\W+${NUMBER}\s*s?\s*(?:-|–|to)\s*${NUMBER}`, "gim");
const CARED = new RegExp(String.raw`^\W*CARED\W+(?:t\s*=\s*)?${NUMBER}`, "im");

/**
 * The machine lines at the end of a viewer's report (VIEWER_PROTOCOL): scores {start, middle, end}
 * (0 to 10) or null, drags [{from, to}] and cared (seconds) or null. A report without them gives
 * nulls and no drags.
 */
export function viewerScores(report) {
  const last = [...String(report).matchAll(SCORES)].at(-1);
  const values = last ? last.slice(1, 4).map(Number) : null;
  const scores = values && values.every((value) => value >= 0 && value <= 10) ? { start: values[0], middle: values[1], end: values[2] } : null;
  const drags = [...String(report).matchAll(DRAG)].map((match) => ({ from: sec(Number(match[1])), to: sec(Number(match[2])) })).filter((drag) => drag.to > drag.from).slice(0, 10);
  const cared = CARED.exec(String(report));
  return { scores, drags, cared: cared ? sec(Number(cared[1])) : null };
}

/** The frame times of a packet: every VIEWER_STEP seconds from 0, inside the scene. */
export function viewerTimes(duration) {
  const times = [];
  for (let time = 0; time < duration - 0.01; time = sec(time + VIEWER_STEP)) times.push(time);
  return times.length ? times : [0];
}

// The scene stretch a layer is shown in, from its own Show and Hide operations and its groups':
// shown from the last first-Show of the chain to the first last-Hide.
function shownSpan(layer, byId, duration) {
  let from = 0;
  let to = duration;
  for (let item = layer; item; item = item.parentId ? byId.get(item.parentId) : null) {
    const operations = (item.animations ?? []).filter((animation) => animation?.kind === "show" || animation?.kind === "hide");
    const shows = operations.filter((animation) => animation.kind === "show").map((animation) => animation.start);
    const hides = operations.filter((animation) => animation.kind === "hide").map((animation) => animation.start);
    if (shows.length) from = Math.max(from, Math.min(...shows));
    if (hides.length) to = Math.min(to, Math.max(...hides));
  }
  return to > from ? { start: from, end: to } : null;
}

/** The edit's captions (text layers with role caption) and when each is shown. */
export function captionWindows(scene) {
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const list = [];
  for (const layer of scene.layers) {
    if (layer.type !== "text" || layer.role !== "caption" || typeof layer.text !== "string" || !layer.text.trim() || hasTextChanges(layer)) continue;
    const span = shownSpan(layer, byId, scene.duration);
    if (span) list.push({ id: layer.id, ...span, text: layer.text.replace(/[“”"]/g, "").replace(/\s+/g, " ").trim() });
  }
  return list.sort((a, b) => a.start - b.start);
}

/**
 * The heard lines: each voice's words (scene times, from its transcript) grouped by pauses, and
 * a line the edit's own captions cover takes their words (the maker checked those; a machine
 * transcript mishears names). words: [{voice, start, end, text}]; captions from captionWindows.
 */
export function heardLines(words, captions = []) {
  const lines = [];
  const open = new Map();
  for (const word of [...words].sort((a, b) => a.start - b.start)) {
    const line = open.get(word.voice);
    if (line && word.start - line.end <= LINE_GAP) {
      line.words.push(word.text);
      line.end = Math.max(line.end, word.end);
      continue;
    }
    const fresh = { voice: word.voice, start: word.start, end: word.end, words: [word.text] };
    open.set(word.voice, fresh);
    lines.push(fresh);
  }
  return lines.map((line) => {
    const heard = new Set(line.words.map(plainWord).filter(Boolean));
    const covering = captions.filter((caption) => caption.start < line.end + 0.3 && caption.end > line.start - 0.3).filter((caption) => {
      const said = caption.text.split(/\s+/).map(plainWord).filter(Boolean);
      return said.length && said.filter((word) => heard.has(word)).length >= Math.max(1, Math.floor(said.length / 2));
    });
    const text = covering.length ? covering.map((caption) => caption.text).join(" ") : line.words.join(" ").replace(/\s+([,.?!…])/g, "$1");
    return { voice: line.voice, start: sec(line.start), end: sec(line.end), text, ...(covering.length ? { caption: true } : {}) };
  });
}

/**
 * A song's stretches: muffled while its low-pass filter is on, full after it opens.
 * cutoffAt(time) is animation.js lowpassSampler (0 = off or fully open).
 */
export function musicSections(range, cutoffAt, step = 0.1) {
  const sections = [];
  for (let time = range.start; time < range.end; time += step) {
    const what = cutoffAt(time) > 0 ? "song (muffled)" : "song (full)";
    if (sections.at(-1)?.what === what) sections.at(-1).end = Math.min(range.end, time + step);
    else sections.push({ start: time, end: Math.min(range.end, time + step), what });
  }
  return sections.map((section) => ({ ...section, start: sec(section.start), end: sec(section.end) }));
}

/** heard.txt: what a first-time viewer hears, and when. Nothing from the brief or the plan. */
export function heardText({ duration, sheets, lines, music, missing = [] }) {
  const time = (value) => `${value.toFixed(1)}`.padStart(5);
  const out = [`Video length ${sec(duration)} s. Frames every ${VIEWER_STEP} s on ${sheets} sheets, ${VIEWER_PER_SHEET} to a sheet, left to right, top to bottom, each labeled with its time.`];
  out.push(lines.length ? "What is heard (lines not shown as captions are a machine transcript, so a few words may be misheard):" : "No words are heard.");
  for (const line of lines) out.push(`  ${time(line.start)}-${time(line.end)}s  [${line.voice}] ${line.text}`);
  for (const voice of missing) out.push(`  [${voice.voice}] speaks, but there is no transcript (${voice.why})`);
  out.push(music.length ? "Music:" : "No music.");
  for (const section of music) out.push(`  ${time(section.start)}-${time(section.end)}s  ${section.what}`);
  return out.join("\n");
}

const bad = (message) => Object.assign(new Error(message), { code: "bad_input" });

/** notes intents {beats:[{from, to, intent}]}: what each beat should leave the viewer with. */
export function parseIntents(beats, duration) {
  const example = 'beats:[{from:0, to:6, intent:"the viewer knows a judge called it the best project"}]';
  if (!Array.isArray(beats) || !beats.length || beats.length > 20) throw bad(`intents needs beats: 1 to 20 of {from, to, intent}, such as ${example}.`);
  return beats.map((beat, index) => {
    const from = Number(beat?.from);
    const to = Number(beat?.to);
    const intent = String(beat?.intent ?? "").trim();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || from >= duration + 0.01)
      throw bad(`beat ${index + 1}: from and to are seconds with from < to, inside the ${sec(duration)} s video.`);
    if (intent.length < 8 || intent.length > 400) throw bad(`beat ${index + 1}: intent says in 8 to 400 characters what the viewer should know or feel after it.`);
    return { from: sec(from), to: sec(Math.min(to, duration)), intent };
  });
}

/**
 * notes viewer {rev, report, matches:[{beat, got, note}], bugs:[{at, what}]}: a fresh viewer's
 * report and its match against every intent. got is yes, partly or no.
 */
export function parseViewer(input, intents, duration = null, { bar = false } = {}) {
  const report = String(input.report ?? "").trim();
  if (report.length < 40 || report.length > 20000) throw bad("report is the fresh viewer's whole answer (40 to 20000 characters), pasted as it came back.");
  const matches = Array.isArray(input.matches) ? input.matches : [];
  const parsed = matches.map((match, index) => {
    const beat = Number(match?.beat);
    if (!Number.isInteger(beat) || beat < 1 || beat > intents.length) throw bad(`matches[${index}]: beat is a beat number from 1 to ${intents.length}.`);
    const got = match.got === true ? "yes" : match.got === false ? "no" : String(match?.got ?? "");
    if (!GOT.includes(got)) throw bad(`matches[${index}]: got is "yes", "partly" or "no" (did the viewer's report show they got this beat).`);
    return { beat, got, note: String(match?.note ?? "").trim().slice(0, 400) };
  });
  const missingBeats = intents.map((_, index) => index + 1).filter((beat) => !parsed.some((match) => match.beat === beat));
  if (missingBeats.length) throw bad(`matches needs every beat: beat ${missingBeats.join(", ")} has no {beat, got, note}.`);
  const bugs = (Array.isArray(input.bugs) ? input.bugs : []).map((bug, index) => {
    const at = Number(bug?.at);
    const what = String(bug?.what ?? "").trim();
    if (!Number.isFinite(at) || at < 0 || !what) throw bad(`bugs[${index}]: {at: seconds, what: the story problem}.`);
    return { at: sec(at), what: what.slice(0, 300) };
  });
  if (bugs.length > 30) throw bad("bugs lists at most 30 story problems.");
  const length = Number.isFinite(duration) ? duration : Math.max(0, ...intents.map((intent) => intent.to));
  const prefer = bar ? preferLine(report) : null;
  if (bar && !prefer) throw bad(`report has no PREFER line: with a bar the viewer compares the last two sheets and ends with "${PREFER_FORM}". Ask the viewer for it.`);
  return { report, matches: parsed, bugs, ...viewerScores(report), duration: sec(length), ...(prefer ? { prefer } : {}) };
}

/**
 * The open story bugs a viewer's scores and drags make (warnings, warn:true, not a render hold):
 * a middle or end keep-watching score under the start score, and each drag over DRAG_OVER s.
 */
export function scoreBugs(record) {
  const bugs = [];
  const length = record.duration ?? 0;
  const third = sec(length / 3);
  const { scores } = record;
  if (scores && scores.middle < scores.start)
    bugs.push({ at: third, to: sec(2 * third), what: `keep-watching fell from ${scores.start} at the start to ${scores.middle} in the middle: raise ${third}-${sec(2 * third)} s (a push into what matters, a detail lift, a hit on the music)`, warn: true });
  if (scores && scores.end < scores.start)
    bugs.push({ at: sec(2 * third), to: sec(length), what: `keep-watching fell from ${scores.start} at the start to ${scores.end} at the end: raise ${sec(2 * third)}-${sec(length)} s`, warn: true });
  for (const drag of record.drags ?? [])
    if (drag.to - drag.from > DRAG_OVER) bugs.push({ at: drag.from, to: drag.to, what: `dragged ${drag.from}-${drag.to} s (${sec(drag.to - drag.from)} s): cut it shorter or keep the screen moving`, warn: true });
  return bugs;
}

/** A direction miss (one line, or null): the moment the viewer cared most is not a signature. */
export function directionMiss(record, ranges = []) {
  if (!Number.isFinite(record.cared) || !ranges.length) return null;
  if (ranges.some((range) => record.cared >= range.from - 0.5 && record.cared <= range.to + 0.5)) return null;
  return `direction miss: the viewer cared most about ${record.cared} s, outside every signature (${ranges.map((range) => `${sec(range.from)}-${sec(range.to)} s`).join(", ")}); build on that moment or make the signature land harder`;
}

/**
 * A report's open story bugs: a preference for the bar, its bugs, every beat the viewer did not get, and the scores' and
 * drags' warnings (warn:true), by time.
 */
export function openStoryBugs(record, intents = []) {
  const missed = record.matches.filter((match) => match.got === "no").map((match) => ({ at: intents[match.beat - 1]?.from ?? 0, what: `beat ${match.beat} missed: ${match.note || intents[match.beat - 1]?.intent || ""}`.trim() }));
  // A viewer who would rather watch the bar (cut B) is an open story bug: the cut is not better yet.
  // Advisory (warn): blind viewers have picked cut B in both orders (position, not taste), so
  // only the critic's BAR line blocks a render.
  const bar = record.prefer?.bar ? [{ at: 0, what: `the viewer preferred the bar: ${record.prefer.why || "no reason given"}`, warn: true }] : [];
  return [...bar, ...record.bugs, ...missed, ...scoreBugs(record)].sort((a, b) => a.at - b.at);
}

/**
 * Why a scene still needs a viewer pass (null when it has one): no report, a report too many
 * revisions back (a changed cut is watched again, whatever the rounds), or a report with open
 * story bugs. Bugs on the revision the viewer watched ask for a fix first (fix:true), never a new
 * viewer of the same cut; after VIEWER_ROUNDS rounds (last:true) that fix is all they ask, and
 * once an edit follows nothing holds. story is the agent state's story record.
 */
export function viewerGap(story, sceneId, rev) {
  const latest = (story?.viewers ?? []).filter((record) => record.sceneId === sceneId).at(-1);
  if (!latest) return { why: "no viewer report yet" };
  if (rev - latest.rev > VIEWER_RECENT) return { why: `the last viewer report watched rev ${latest.rev}, more than ${VIEWER_RECENT} revisions ago` };
  const last = viewerRounds(story, sceneId) >= VIEWER_ROUNDS;
  if (last && rev > latest.rev) return null;
  // The scores' and drags' bugs are warnings: shown with the report, they hold no render.
  const bugs = openStoryBugs(latest, story.intents?.[sceneId]?.beats).filter((bug) => !bug.warn);
  if (bugs.length) return { why: `rev ${latest.rev}'s viewer report has ${bugs.length} open story bug${bugs.length === 1 ? "" : "s"}: ${bugs.slice(0, 3).map((bug) => `@${bug.at}s ${bug.what}`).join("; ")}${bugs.length > 3 ? "; ..." : ""}`, bugs, ...(rev <= latest.rev ? { fix: true } : {}), ...(last ? { last: true } : {}) };
  return null;
}

// How a story bug is fixed: by showing, a caption last (captions added for each viewer bug can
// give away the ending).
export const SHOW_FIRST = "fix it by showing first (a push into what explains it, a freeze, a cut to the shot that shows it); a caption is the last resort, and it never names what the ending reveals";
const PLAIN = new Set(["viewer", "viewers", "know", "knows", "feel", "feels", "sees", "that", "this", "with", "they", "their", "them", "what", "when", "where", "from", "into", "about", "after", "before", "there", "then", "have", "been", "will", "just", "more", "also", "only", "every", "each", "gets", "understands"]);
const contentWords = (text) => String(text ?? "").toLowerCase().split(/[^a-z0-9']+/).filter((word) => word.length >= 4 && !PLAIN.has(word));

// The waiver for one caption the spoiler check flags by mistake (target: the caption layer).
export const SPOILER_WAIVER = "spoiler";
// A word heard this many seconds around a caption counts as said while it shows.
const HEARD_SLACK = 0.5;
const byStart = (beats) => [...beats].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));

/** What only the last beat's intent says (its words in no earlier intent): the ending's reveal. */
export function endingWords(beats = []) {
  if (beats.length < 2) return [];
  const sorted = byStart(beats);
  const before = new Set(sorted.slice(0, -1).flatMap((beat) => contentWords(beat.intent)));
  return [...new Set(contentWords(sorted.at(-1).intent))].filter((word) => !before.has(word));
}

/**
 * Captions shown before the last beat that say what only the ending reveals: [{id, start, text,
 * words}]. A caption added to fix a story bug must not spoil the end. A word the voice says while
 * the caption shows (`heard`: [{start, end, text}] scene times) is the speech's, not a spoiler;
 * `waived` lists caption layer ids to skip (waive_check {code:"spoiler"}).
 */
export function captionSpoilers(scene, beats = [], { heard = [], waived = [] } = {}) {
  const ending = endingWords(beats);
  if (!ending.length) return [];
  const from = byStart(beats).at(-1).from;
  return captionWindows(scene).filter((caption) => caption.start < from && !waived.includes(caption.id)).map((caption) => {
    const said = new Set(contentWords(caption.text));
    const voiced = new Set(heard.filter((word) => word.end >= caption.start - HEARD_SLACK && word.start <= caption.end + HEARD_SLACK).flatMap((word) => contentWords(word.text)));
    return { id: caption.id, start: sec(caption.start), text: caption.text, words: ending.filter((word) => said.has(word) && !voiced.has(word)) };
  }).filter((caption) => caption.words.length);
}

/** A scene's viewer rounds so far: its reports on different revisions. */
export function viewerRounds(story, sceneId) {
  return new Set((story?.viewers ?? []).filter((record) => record.sceneId === sceneId).map((record) => record.rev)).size;
}

/**
 * Writes a packet into `folder` (emptied first): the sheets as JPEG (sheet-01.jpg, ...) and
 * heard.txt (or `textName`: look critique writes packet.txt). Older packet folders of the same
 * kind and scene (viewer-<scene>-r<rev>, critique-<scene>-r<rev>[-from-to]) beside it are deleted
 * once older than PACKET_KEEP_MS, and so are look images (frame-<hash>.png) past it: the only
 * cleanup of out/<project>. Other kinds and scenes stay. Returns the sheet and text file paths.
 */
export async function writePacket(folder, sheetPngs, heard, textName = "heard.txt") {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const sheets = [];
  for (const [index, png] of sheetPngs.entries()) {
    const picture = await loadImage(png);
    const canvas = createCanvas(picture.width, picture.height);
    canvas.getContext("2d").drawImage(picture, 0, 0);
    const file = path.join(folder, `sheet-${String(index + 1).padStart(2, "0")}.jpg`);
    await writeFile(file, await canvas.encode("jpeg", 85), { mode: 0o600 });
    sheets.push(file);
  }
  const heardFile = path.join(folder, textName);
  await writeFile(heardFile, `${heard}\n`, { mode: 0o600 });
  const parent = path.dirname(folder);
  const kind = packetKind(path.basename(folder));
  for (const name of await readdir(parent)) {
    const full = path.join(parent, name);
    const packet = kind && packetKind(name) === kind && full !== folder;
    if (!packet && !LOOK_IMAGE.test(name)) continue;
    const info = await stat(full).catch(() => null);
    if (info && Date.now() - info.mtimeMs > PACKET_KEEP_MS) await rm(full, { recursive: true, force: true });
  }
  return { sheets, heard: heardFile };
}

/** A packet folder's kind and scene ("critique-<scene>" for critique-<scene>-r27-1.5-3), or null. */
export function packetKind(name) {
  return /^((?:viewer|critique)-.+)-r\d+(?:-[\d.]+-[\d.]+)?$/.exec(name)?.[1] ?? null;
}
