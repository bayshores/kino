// look {mode:"board", page?}: the storyboard (document.board, engine/board.js) as pictures, 4 shots
// a page, so the person sees every shot before anything is built. A row per shot: the source
// frame at the shot's in-point with the crop, the subject boxes and the eye line (as look source
// draws them), the cropped still with the real font and text and the phone app's covered areas
// shaded, kino's numbers (engine/boardMeasure.js) and the agent's one-line reason. The text gives
// each shot's place and id, kino's numbers and every flag in words, so an agent that cannot see
// the image, or a screen reader, gets every measured meaning; each shot's designed move is
// printed; a chosen plain cut (move {none}) is not flagged, a shot naming no move is ("plain"). The shot's text and sound
// (what the agent sent) are quoted as far as the page's token budget allows. boardShotImage
// draws one shot's source frame or still alone, for the dashboard's board screen (B4b).
import { mainScene, boardSpan, isPlainShot, isUnplannedShot, moveWords } from "../../engine/board.js";
import { shotMeasures, isPortrait } from "../../engine/boardMeasure.js";
import { createDocument, createLayer, createScene, parseDocument } from "../../engine/model.js";
import { SAFE_ZONES } from "../../engine/quality/rules/layout.js";
import { sceneKey } from "./look.mjs";
import { sec } from "./describe.mjs";
import { estimateTextTokens } from "../meter.mjs";

export const BOARD_PAGE = 4;
// Plan §12: about 100 tokens of text a page, never more than this before the image line.
export const PAGE_TOKENS = 200;
// A quoted text or sound name in the page's text is cut to fit, 4 characters at a time from the
// longest line, down to this many, then left out (the image shows it).
const SHORTEST = 8;
// The music layer's name in the page's first line.
const MUSIC_NAME = 24;
// The still's text box: centered, this share of the video's width.
const TEXT_WIDTH = 0.86;
// Quoted texts in the look's text are cut to this many characters.
const QUOTE = 32;

/** A refusal from look board: the service answers it as an AgentError with the same code. */
export class BoardLookError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const clip = (text, most) => (text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text);
const span = (from, to) => `${sec(from)}–${sec(to)} s`;
const isNone = (value) => value === "none" || value == null;

/**
 * The look: { image: {png, frames}, text, extra }. `input.page` (1 by default) picks the page;
 * `look` is createLook's renderer, `fontsFor(document)` the fonts a document draws with,
 * `mediaRecord(src)` a library file's record ({width, height, duration, name, mime}) or null, and
 * `soundSearch` whether sound search is on in Settings (the header says so). An empty sound is
 * "none": kino's built-in library needs no switch.
 */
export async function boardLook(input, { document, look, fontsFor, mediaRecord, soundSearch = false }) {
  const board = document.board;
  if (!board?.shots?.length) throw new BoardLookError("not_found", 'No storyboard yet: edit {ops:[{op:"board", music, shots}]} (library {topic:"op", name:"board"}).');
  const pages = Math.ceil(board.shots.length / BOARD_PAGE);
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > pages)
    throw new BoardLookError("bad_input", `page is 1 to ${pages} (${plural(board.shots.length, "shot")}, ${BOARD_PAGE} a page).`);

  const scene = mainScene(document);
  const frame = { width: scene.width, height: scene.height };
  const portrait = isPortrait(frame);
  const music = boardSpan(document, board).music;

  const first = (page - 1) * BOARD_PAGE;
  const shots = board.shots.slice(first, first + BOARD_PAGE).map((shot, index) => ({ shot, n: first + index + 1 }));

  // The files the page shows, once each.
  const records = new Map();
  for (const { shot } of shots) if (!isNone(shot.media) && !records.has(shot.media)) records.set(shot.media, await mediaRecord(shot.media));

  // One temporary document holds every still and source frame of the page, so its fonts load once.
  const stills = shots.map(({ shot }) => stillScene(shot, records.get(shot.media), scene));
  const sources = shots.map(({ shot }) => sourceScene(shot, records.get(shot.media)));
  const temporary = parseDocument(createDocument({ id: "board-view", name: "board", scenes: [...stills, ...sources.filter(Boolean)] }));
  const fonts = await fontsFor(temporary);
  const prepared = (id) => {
    const found = temporary.scenes.find((item) => item.id === id);
    return { scene: found, fonts, key: sceneKey(found, fonts) };
  };

  const rows = [];
  const listed = [];
  const head = `board r${board.rev}, page ${page} of ${pages}: ${shots.length > 1 ? `shots ${first + 1}–${first + shots.length}` : `shot ${first + 1}`} of ${board.shots.length}, ${sec(scene.duration)} s, ${frame.width}×${frame.height}, music ${music ? clip(music, MUSIC_NAME) : "none"}, sound search ${soundSearch ? "on" : "off"}`;
  const shotLines = [];
  for (const [index, { shot, n }] of shots.entries()) {
    const record = records.get(shot.media) ?? null;
    const missing = !isNone(shot.media) && !record;
    const measures = shotMeasures(shot, frame);
    const crop = Array.isArray(shot.crop) ? shot.crop : [0, 0, 100, 100];
    const boxes = isNone(shot.subject) ? [] : shot.subject.boxes ?? [];
    const eyes = !isNone(shot.subject) && typeof shot.subject.eyes === "number" ? { y: shot.subject.eyes, from: crop[0], to: crop[0] + crop[2] } : null;
    rows.push({
      header: `${n} · ${span(shot.cue, shot.cue + shot.dur)} · ${shot.pacing} · ${shot.follow}`,
      source: sources[index] ? prepared(sources[index].id) : null,
      note: missing ? "media missing" : "no footage",
      quad: [[crop[0], crop[1]], [crop[0] + crop[2], crop[1]], [crop[0] + crop[2], crop[1] + crop[3]], [crop[0], crop[1] + crop[3]]],
      boxes: boxes.map((box) => ({ by: "agent", box })),
      eyes,
      still: prepared(stills[index].id),
      covered: portrait ? { right: SAFE_ZONES.portrait.right, bottom: SAFE_ZONES.portrait.bottom } : null,
      lines: rowLines(shot, measures, { record, missing }),
    });
    shotLines.push({ shot, n, measures, missing, most: { quote: QUOTE, sound: 40, move: 1 } });
    listed.push({ n, id: shot.id, start: sec(shot.cue), end: sec(shot.cue + shot.dur), inside: measures.inside, edge: measures.edge, eyes: measures.eyes, flags: measures.flags, move: shot.move ?? null, plain: isUnplannedShot(shot) });
  }
  const from = first + BOARD_PAGE + 1, to = Math.min(first + 2 * BOARD_PAGE, board.shots.length);
  const more = page < pages
    ? `more: ${from < to ? `shots ${from}–${to}` : `shot ${from}`} on page ${page + 1}`
    : "step: ask the person (notes checkpoint board)";
  const nextCall = page < pages ? { tool: "look", input: { mode: "board", page: page + 1 } } : { tool: "notes", input: { action: "checkpoint", id: "board" } };

  const image = await look.boardImage(rows);
  return { image, text: fitPage(head, shotLines, more), extra: { board: board.rev, page, pages, shots: listed }, nextCall };
}

// The widths the board screen asks a shot's image at (its srcset).
export const SHOT_WIDTHS = Object.freeze([240, 480, 960]);
const SHOT_PARTS = ["source", "still", "last", "alt1", "alt2"];
// The last frame is one frame before the shot ends, so it is still the shot's own footage.
const LAST_FRAME = 1 / 30;

// The shot a picture part shows: "last" is the shot at its last frame (its file time moved by
// its length at its speed); "alt1" and "alt2" are the shot with that option's media, in-point,
// crop and subject (an option leaves out what it keeps). Null when the shot has no such option.
export function shotForPart(shot, part) {
  if (part === "last") {
    if (typeof shot.in !== "number") return shot;
    return { ...shot, in: shot.in + Math.max(0, shot.dur * (shot.speed ?? 1) - LAST_FRAME) };
  }
  const option = part === "alt1" ? shot.alts?.[0] : part === "alt2" ? shot.alts?.[1] : undefined;
  if (part === "alt1" || part === "alt2") {
    if (!option) return null;
    const { why, ...fields } = option;
    return { ...shot, ...fields };
  }
  return shot;
}

/**
 * One shot of the board in `document` as a picture, for the dashboard's board screen (GET
 * /api/dashboard/board-shot): `part` "source" is the file's frame at the shot's in-point, with
 * nothing drawn on it (the screen draws the crop and the boxes); "still" the cropped still in
 * the video's shape with the shot's text in its real font; "last" the same at the shot's last
 * frame; "alt1" and "alt2" the still of the shot's first and second option. `width` is one of
 * SHOT_WIDTHS; `rev` names the revision in refusals. Returns { png } or throws BoardLookError
 * (bad_input, not_found). The same scenes as the look board's rows, drawn on their own.
 */
export async function boardShotImage({ shot: shotId, part, width }, { document, rev, look, fontsFor, mediaRecord }) {
  if (!SHOT_PARTS.includes(part)) throw new BoardLookError("bad_input", `part is ${SHOT_PARTS.slice(0, -1).join(", ")} or ${SHOT_PARTS.at(-1)}.`);
  if (!SHOT_WIDTHS.includes(width)) throw new BoardLookError("bad_input", `w is ${SHOT_WIDTHS.slice(0, -1).join(", ")} or ${SHOT_WIDTHS.at(-1)}.`);
  const saved = (document.board?.shots ?? []).find((entry) => entry.id === shotId);
  if (!saved) throw new BoardLookError("not_found", `shot ${shotId} is not in rev ${rev}.`);
  const shot = shotForPart(saved, part);
  if (!shot) throw new BoardLookError("not_found", `shot ${shotId} has no option ${part === "alt1" ? 1 : 2}.`);
  const record = isNone(shot.media) ? null : await mediaRecord(shot.media);
  const scene = part === "source" ? sourceScene(shot, record) : stillScene(shot, record, mainScene(document));
  if (!scene) throw new BoardLookError("not_found", `shot ${shotId} has no footage.`);
  const temporary = parseDocument(createDocument({ id: "board-view", name: "board", scenes: [scene] }));
  const fonts = await fontsFor(temporary);
  const found = temporary.scenes[0];
  const { png } = await look.frame({ scene: found, fonts, key: sceneKey(found, fonts) }, 0, width);
  return { png };
}

// The page's text within PAGE_TOKENS: while it is over, the longest shot line gives up 4
// characters of its longer quoted word, and below SHORTEST leaves that part out. With every
// quote and sound gone, the longest line leaves out its move (the image row still names it).
function fitPage(head, entries, next) {
  const page = () => [head, ...entries.map(shotLine), next].join("\n");
  const longestOf = (list) => list.reduce((a, b) => (shotLine(b).length > shotLine(a).length ? b : a));
  for (let text = page(); estimateTextTokens(text) > PAGE_TOKENS; text = page()) {
    const open = entries.filter((entry) => entry.most.quote > 0 || entry.most.sound > 0);
    if (!open.length) {
      const moves = entries.filter((entry) => entry.most.move > 0 && !isPlainShot(entry.shot));
      if (!moves.length) return text;
      longestOf(moves).most.move = 0;
      continue;
    }
    const longest = longestOf(open);
    const field = longest.most.quote >= longest.most.sound ? "quote" : "sound";
    longest.most[field] = longest.most[field] > SHORTEST ? Math.max(SHORTEST, longest.most[field] - 4) : 0;
  }
  return page();
}

// The words in a row's column: what kino measured, the shot's text, sound and file, then its
// flags and the agent's reason.
function rowLines(shot, measures, { record, missing }) {
  const lines = [];
  if (!isNone(shot.media)) {
    if (isNone(shot.subject)) lines.push({ text: "subject: not marked" });
    else {
      lines.push({ text: `subject: ${shot.subject.what} · ${measures.inside.join("%, ")}% in the crop` });
      lines.push({ text: `edge ${measures.edge}% · ${measures.eyes == null ? "eyes: not marked" : `eyes ${measures.eyes}% from the top`}` });
    }
  }
  const text = shot.text;
  lines.push({ text: isNone(text) ? "text: none" : `text: "${clip(text.text, QUOTE)}" ${text.family} ${text.weight}, ${text.size} px`, most: 2 });
  lines.push({ text: isNone(shot.sound) ? "sound: none" : `sound: ${shot.sound.what}` });
  if (isNone(shot.media)) lines.push({ text: "media: none" });
  else {
    const name = record?.name ?? String(shot.media).replace(/^\/api\/media\//, "");
    lines.push({ text: `media: ${name}${missing ? " (missing)" : isNone(shot.in) ? "" : ` @ ${sec(shot.in)} s`}` });
  }
  for (const flag of measures.flags) lines.push({ text: `look: ${flag}`, ink: "flag" });
  lines.push(isUnplannedShot(shot) ? { text: "plain: no move chosen (a designed one, or none: cut)", ink: "flag", most: 2 } : { text: `move: ${moveWords(shot)}`, most: 2 });
  lines.push({ text: `why: ${shot.why}`, ink: "why", most: 3 });
  return lines;
}

// A flag in few words for the page's text, and the numbers it stands for there (said once: a
// subject the crop cuts is 0% from its edge).
const SHORT_FLAGS = [
  [/^no subject marked$/, "no subject", ["in", "edge"]],
  [/^subject (\d+)% in the crop$/, "$1% in", ["in", "edge"]],
  [/^subject touches the crop edge$/, "touching the edge", ["edge"]],
  [/^subject (\d+)% from the crop edge$/, "$1% from the edge", ["edge"]],
  [/^eyes outside the crop$/, "eyes outside", ["eyes"]],
  [/^eyes (\d+)% from the top$/, "eyes $1%", ["eyes"]],
  [/^eyes under the app's captions$/, "eyes under captions", []],
  [/^text under the app's captions$/, "text under captions", []],
];
function shortFlags(flags) {
  const short = flags.map((flag) => {
    const found = SHORT_FLAGS.find(([pattern]) => pattern.test(flag));
    return found ? { words: flag.replace(found[0], found[1]), numbers: found[2] } : { words: flag, numbers: [] };
  });
  // Both under the captions: said once.
  const eyes = short.find((flag) => flag.words === "eyes under captions");
  const text = short.find((flag) => flag.words === "text under captions");
  if (eyes && text) {
    text.words = "eyes and text under captions";
    short.splice(short.indexOf(eyes), 1);
  }
  return short;
}

// "2 (S2) 1.25–3.33 s: 100% in; text none; sound none · look: 4% from the edge": the shot's place
// and id (the id the board op keeps), kino's numbers, a flagged one only under look:, then the
// shot's move (left out at most.move 0), text and sound, each cut to `most` characters or left
// out at 0.
function shotLine({ shot, n, measures, missing, most }) {
  const flags = shortFlags(measures.flags);
  if (isUnplannedShot(shot)) flags.push({ words: "plain", numbers: [] });
  const flagged = new Set(flags.flatMap((flag) => flag.numbers));
  const picture = [];
  if (isNone(shot.media)) picture.push("no footage");
  else if (missing) picture.push("media missing");
  else if (measures.inside.length) {
    if (!flagged.has("in")) picture.push(`${Math.min(...measures.inside)}% in`);
    if (!flagged.has("edge") && measures.edge != null && measures.edge < 5) picture.push(`${measures.edge}% from the edge`);
    if (!flagged.has("eyes") && measures.eyes != null) picture.push(`eyes ${measures.eyes}%`);
  }
  const parts = [picture.join(", ")];
  if (!isPlainShot(shot) && most.move > 0) parts.push(`move ${shot.move.name}`);
  if (most.quote > 0) parts.push(isNone(shot.text) ? "text none" : `text "${clip(shot.text.text, most.quote)}"`);
  if (most.sound > 0) parts.push(isNone(shot.sound) ? "sound none" : `sound ${clip(shot.sound.what, most.sound)}`);
  const said = [parts.filter(Boolean).join("; "), flags.length ? `look: ${flags.map((flag) => flag.words).join(", ")}` : ""].filter(Boolean).join(" · ");
  return `${n} (${shot.id}) ${span(shot.cue, shot.cue + shot.dur)}: ${said}`;
}

// The file as a layer: a video at `fileTime` (sound off), or a picture. Layer ids are unique in
// a document, so each is named after its scene.
function mediaLayer(id, record, src, fileTime, box) {
  const isPicture = String(record.mime ?? "").startsWith("image/");
  return createLayer(isPicture ? "image" : "video", {
    id, name: "media", src, ...box,
    ...(isPicture ? {} : { mediaStart: 0, mediaOffset: fileTime, mediaSourceDuration: record.duration || 0, volume: 0 }),
  });
}

// The source frame: the file alone in a scene its own size (as look source draws it), or null
// when the shot has no media or its file is not in the library.
function sourceScene(shot, record) {
  if (isNone(shot.media) || !(record?.width > 0 && record?.height > 0)) return null;
  const fileTime = typeof shot.in === "number" ? shot.in : 0;
  return createScene({
    id: `source-${shot.id}`, name: "source", width: record.width, height: record.height, duration: 1, background: "#000000",
    layers: [mediaLayer(`source-${shot.id}-media`, record, shot.media, fileTime, { x: 0, y: 0, width: record.width, height: record.height })],
  });
}

// The still: a scene the video's size on the main scene's background, with the footage placed so
// the crop fills it (crop "whole" fits the whole picture inside the frame) and the text as a centered layer
// 86% of the width wide, its middle at `text.y` % from the top, in its own font.
export function stillScene(shot, record, main) {
  const width = main.width, height = main.height;
  const layers = [];
  if (!isNone(shot.media) && record?.width > 0 && record?.height > 0) {
    const fileTime = typeof shot.in === "number" ? shot.in : 0;
    if (Array.isArray(shot.crop)) {
      const [x, y, w, h] = shot.crop;
      const cropWidth = (w / 100) * record.width, cropHeight = (h / 100) * record.height;
      // One scale for both sides keeps the footage's shape; the larger one fills the frame (the
      // board op allows the crop's shape 2% off the video's).
      const scale = Math.max(width / cropWidth, height / cropHeight);
      const centerX = ((x + w / 2) / 100) * record.width, centerY = ((y + h / 2) / 100) * record.height;
      layers.push(mediaLayer(`still-${shot.id}-media`, record, shot.media, fileTime, {
        x: width / 2 - centerX * scale, y: height / 2 - centerY * scale, width: record.width * scale, height: record.height * scale,
      }));
    } else {
      // crop "whole": the source fits inside the frame at its own shape (a phone screen as a card).
      const scale = Math.min(width / record.width, height / record.height);
      const w = record.width * scale, h = record.height * scale;
      layers.push(mediaLayer(`still-${shot.id}-media`, record, shot.media, fileTime, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h }));
    }
  }
  if (!isNone(shot.text)) {
    const size = shot.text.size ?? Math.round(height * 0.05);
    const boxHeight = Math.round(size * 1.2 * 3);
    const middle = ((shot.text.y ?? 20) / 100) * height;
    layers.push(createLayer("text", {
      id: `still-${shot.id}-text`, name: "text", text: shot.text.text, fontFamily: shot.text.family, fontWeight: shot.text.weight ?? 700, fontSize: size,
      fill: shot.text.fill ?? "#ffffff", textAlign: "center", verticalAlign: "middle",
      x: Math.round((width * (1 - TEXT_WIDTH)) / 2), y: Math.round(middle - boxHeight / 2), width: Math.round(width * TEXT_WIDTH), height: boxHeight,
    }));
  }
  return createScene({
    id: `still-${shot.id}`, name: "still", width, height, duration: 1,
    background: main.background, backgroundEnabled: main.backgroundEnabled !== false, layers,
  });
}
