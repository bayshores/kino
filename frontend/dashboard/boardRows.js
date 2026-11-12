// The storyboard screen's words (board.jsx, direction plan §5 "You see"), as plain data: the header
// line, each shot's layer lines, the one sentence a screen reader hears for a shot, where the crop,
// subject boxes and eye line go on the source frame, and what changed after a redo.
//
// Data flow: GET /api/dashboard/board-data (backend/agent/board-data.mjs builds it from the project's
// document.board, the brief and kino's measures) → these functions → board.jsx. Plain data in,
// plain data out, so it is easy to test (frontend/dashboardBoard.test.js). Every meaning is in words;
// colors are extra.
import { READ_WORDS } from "./words.js";

const NONE = "none";

/** Seconds to one decimal, without a trailing zero: 8.8, 0, 1.3. */
export function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toFixed(1))) : "?";
}

// A shot's sound in words: the sound it adds, "clip sound" or "clip sound 2.1-3.4 s" when it keeps
// its clip's own (sound {keep}, engine/boardSound.js), or both.
const soundText = (sound) => [sound.what ?? "", sound.keep === "all" ? "clip sound" : Array.isArray(sound.keep) ? `clip sound ${seconds(sound.keep[0])}-${seconds(sound.keep[1])} s` : ""].filter(Boolean).join(" + ");

// A share of the source frame (crop, boxes), to one decimal: 24, 7.8.
const share = (value) => String(Number(Number(value).toFixed(1)));

/** "shot 2", "shots 2 and 4", "shots 2, 4 and 5" (places on the board, from 1). */
export function shotList(numbers) {
  const list = [...numbers];
  if (!list.length) return "no shots";
  if (list.length === 1) return `shot ${list[0]}`;
  return `shots ${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

// The video shapes kino names; any other is width×height.
const ASPECTS = [["9:16", 9 / 16], ["16:9", 16 / 9], ["1:1", 1], ["4:5", 4 / 5]];

/** The video's shape in words: the server's `aspect`, else 9:16, 16:9, 1:1, 4:5 or 1080×1350. */
export function aspectWords({ aspect = null, width, height } = {}) {
  if (aspect) return aspect;
  if (!(width > 0 && height > 0)) return "shape not set";
  const found = ASPECTS.find(([, ratio]) => Math.abs(width / height / ratio - 1) <= 0.02);
  return found ? found[0] : `${width}×${height}`;
}

/** The header: "C1 · board r3 · 5 shots · 8.8 s · 9:16 · TikTok" (a board not asked yet starts so). */
export function boardHeader(data) {
  const header = data?.header ?? {};
  const count = Number(header.shots) || 0;
  return [data?.stop ?? "not asked yet", `board r${header.board ?? "?"}`, `${count} shot${count === 1 ? "" : "s"}`, `${seconds(header.seconds)} s`,
    aspectWords(header), header.platform || "platform not set"].join(" · ");
}

/** Whether the agent had a second agent read the board before it asked (plan §5 "Before showing it"). */
export function freshLine(data) {
  if (!data?.stop) return null;
  if (data.fresh === "ran") return "fresh-eyes check: ran (a second agent read the board before you)";
  if (data.fresh === "skipped") return "fresh-eyes check: skipped (the agent's app cannot start a second agent)";
  return "fresh-eyes check: not reported by the agent";
}

const placeOf = (data, id) => data.shots.find((shot) => shot.id === id)?.n ?? id;
const removedWords = (removed = []) => removed.map((shot) => `the shot at ${seconds(shot.start)}–${seconds(shot.end)} s (removed)`);

// A new shot order or new music since the board they answered: "the shot order and the music".
function boardWide(redone) {
  const wide = [redone.order ? "the shot order" : "", redone.music ? "the music" : ""].filter(Boolean);
  return wide.join(" and ");
}

/**
 * What changed since the board the person last answered: after a lapse, kino's reasons; after a
 * redo (or approve with notes) that named shots, the shots changed as asked, those changed without
 * being asked, and those named but not changed (F4 round.redone), then a new shot order or new
 * music on a line of its own; with no shot named, every change.
 */
export function changeLines(data) {
  const lines = [];
  if (data?.lapsed?.why?.length) lines.push(`changed since you approved${data.lapsed.approved ? ` ${data.lapsed.approved}` : " it"}: ${data.lapsed.why.join("; ")}`);
  const redone = data?.redone;
  if (!redone) return lines;
  const removed = removedWords(redone.removed);
  const wide = boardWide(redone);
  if (redone.named?.length) {
    if (redone.asked?.length) lines.push(`changed as you asked in ${redone.stop}: ${shotList(redone.asked.map((id) => placeOf(data, id)))}`);
    const unasked = [...(redone.unasked ?? []).map(({ id, what }) => `shot ${placeOf(data, id)} (${what.join(", ")})`), ...removed];
    if (unasked.length) lines.push(`changed without being asked: ${unasked.join(", ")}`);
    if (redone.missed?.length) lines.push(`named but not changed: ${shotList(redone.missed.map((id) => placeOf(data, id)))}`);
    if (wide) lines.push(`also changed: ${wide}`);
    return lines;
  }
  const changed = [...data.shots.filter((shot) => shot.change).map((shot) => `shot ${shot.n} (${shot.change.what.join(", ")})`), ...removed, ...(wide ? [wide] : [])];
  lines.push(changed.length ? `changed since ${redone.stop}: ${changed.join(", ")}` : `nothing changed since ${redone.stop}`);
  return lines;
}

/** One shot's change after a redo, for its row: "changed without being asked: crop", or null. */
export function changeWords(shot, data) {
  const redone = data?.redone;
  if (redone?.missed?.includes(shot.id)) return "named but not changed";
  if (!shot.change) return null;
  const what = shot.change.what.join(", ");
  if (!redone?.named?.length) return `changed since ${redone?.stop ?? "the last ask"}: ${what}`;
  return shot.change.asked ? `changed as you asked: ${what}` : `changed without being asked: ${what}`;
}

const hasFootage = (shot) => Boolean(shot.media && shot.media !== NONE);
const fileName = (src) => String(src ?? "").split(/[\\/]/).pop() || "a file";
const footageName = (media) => media.name ?? fileName(media.src);
const boxesOf = (subject) => (subject && subject !== NONE ? subject.boxes ?? [] : []);

function textWords(text, header) {
  if (!text || text === NONE) return NONE;
  const size = text.size ?? Math.round((Number(header?.height) || 0) * 0.05);
  return `"${text.text}" · ${text.family} ${text.weight ?? 700} · ${size} px · y ${share(text.y ?? 20)}%`;
}

/** kino's numbers for a shot with footage: "100% in the crop · edge 6% · eyes 31% from the top", or null. */
export function measureWords(shot) {
  if (!hasFootage(shot) || shot.media.missing) return null;
  const { inside = [], edge = null, eyes = null } = shot.measures ?? {};
  const parts = [];
  if (inside.length) {
    parts.push(`${Math.min(...inside)}% in the crop`);
    if (edge != null) parts.push(edge === 0 ? "touches the edge" : `edge ${edge}%`);
  } else parts.push("no subject box to measure");
  parts.push(eyes == null ? "eyes not marked" : `eyes ${eyes}% from the top`);
  return parts.join(" · ");
}

/**
 * Every layer of a shot, one line each, "none" where it is empty (plan §5: a meme font or a
 * synthesized ding shows before building): [{name, text, tone}]. tone "look" marks kino's flags
 * and "change" what changed after a redo; both are said in words too.
 */
export function shotLines(shot, data) {
  const lines = [];
  const media = shot.media;
  let footage = NONE;
  if (hasFootage(shot)) {
    if (media.missing) footage = `missing: ${footageName(media)} is not in the media library`;
    else {
      const where = media.kind === "image" ? `${footageName(media)} (a picture)` : `${footageName(media)} from ${seconds(shot.in)} s`;
      const [x, y, w, h] = Array.isArray(shot.crop) ? shot.crop : [];
      footage = `${where} · ${Array.isArray(shot.crop) ? `crop ${share(w)} × ${share(h)}% at ${share(x)}, ${share(y)}` : "shown whole"}`;
    }
  }
  lines.push({ name: "footage", text: footage });
  const boxes = boxesOf(shot.subject);
  lines.push({ name: "subject", text: shot.subject && shot.subject !== NONE
    ? `${shot.subject.what} · ${boxes.length === 1 ? "box" : `${boxes.length} boxes`} by the ${shot.subject.by ?? "agent"}` : NONE });
  const measured = measureWords(shot);
  if (measured) lines.push({ name: "measured", text: measured });
  const flags = shot.measures?.flags ?? [];
  if (flags.length) lines.push({ name: "look at", text: flags.join(" · "), tone: "look" });
  lines.push({ name: "follow", text: shot.follow || NONE });
  lines.push({ name: "pacing", text: String(shot.pacing || NONE).replaceAll("_", " ") });
  lines.push({ name: "text", text: textWords(shot.text, data?.header) });
  lines.push({ name: "sound", text: shot.sound && shot.sound !== NONE ? soundText(shot.sound) : NONE });
  lines.push({ name: "why", text: shot.why || NONE });
  if (shot.alts?.length) lines.push({ name: "options", text: `${shot.alts.length}: ${shot.alts.map((alt) => alt.why).join(" · ")}` });
  const change = changeWords(shot, data);
  if (change) lines.push({ name: "change", text: change, tone: "change" });
  return lines;
}

/**
 * The one sentence a screen reader hears for a shot (plan §13), e.g. "Shot 2 of 5, 1.3 to 3.3
 * seconds: park.mp4 from 1.3 s, cropped to 24 by 76 percent; subject the dragon, 100 percent in
 * the crop, 6 percent from the edge, marked by the agent; text "The dragon is back" in Inter 700;
 * no sound effect; follow steady; why: the dragon over the village. Look at:
 * subject touches the crop edge."
 */
export function shotSentence(shot, data) {
  const total = data?.shots?.length ?? 0;
  const parts = [];
  const media = shot.media;
  if (!hasFootage(shot)) parts.push("no footage");
  else if (media.missing) parts.push(`${footageName(media)} is missing from the media library`);
  else {
    const where = media.kind === "image" ? `${footageName(media)}, a picture` : `${footageName(media)} from ${seconds(shot.in)} s`;
    parts.push(`${where}, ${Array.isArray(shot.crop) ? `cropped to ${share(shot.crop[2])} by ${share(shot.crop[3])} percent` : "shown whole"}`);
  }
  if (shot.subject && shot.subject !== NONE) {
    const { inside = [], edge = null, eyes = null } = shot.measures ?? {};
    const said = [`subject ${shot.subject.what}`];
    if (inside.length) said.push(`${Math.min(...inside)} percent in the crop`);
    if (inside.length && edge != null) said.push(edge === 0 ? "touching the edge" : `${edge} percent from the edge`);
    if (eyes != null) said.push(`eyes ${eyes} percent from the top`);
    said.push(`marked by the ${shot.subject.by ?? "agent"}`);
    parts.push(said.join(", "));
  } else if (hasFootage(shot)) parts.push("no subject marked");
  parts.push(shot.text && shot.text !== NONE ? `text "${shot.text.text}" in ${shot.text.family} ${shot.text.weight ?? 700}` : "no text");
  parts.push(shot.sound && shot.sound !== NONE ? `sound ${soundText(shot.sound)}` : "no sound effect");
  if (shot.follow && shot.follow !== NONE) parts.push(`follow ${shot.follow}`);
  parts.push(`why: ${shot.why || "none"}`);
  let sentence = `Shot ${shot.n} of ${total}, ${seconds(shot.start)} to ${seconds(shot.end)} seconds: ${parts.join("; ")}.`;
  const flags = shot.measures?.flags ?? [];
  if (flags.length) sentence += ` Look at: ${flags.join(", ")}.`;
  if (shot.alts?.length) sentence += ` ${shot.alts.length} other option${shot.alts.length === 1 ? "" : "s"}.`;
  const change = changeWords(shot, data);
  if (change) sentence += ` ${change[0].toUpperCase()}${change.slice(1)}.`;
  return sentence;
}

// The room a label takes on the source frame, used to place it where the frame's edge does not
// cut it off and it does not cover a box: a line of the card's text is about 6.5% of the frame's
// width (a frame 40ch wide), so of its height by the frame's shape; a letter about 2.7% of the
// width, and the label's padding one letter more.
const LINE_SHARE = 6.5;
const LETTER_SHARE = 2.7;

// Rooms that meet by under 1% do not overlap: the estimates are a little larger than the labels.
const overlaps = (a, b) => a.left + 1 < b.left + b.width && b.left + 1 < a.left + a.width && a.top + 1 < b.top + b.height && b.top + 1 < a.top + a.height;
const inFrame = (room) => room.left >= -0.01 && room.top >= -0.01 && room.left + room.width <= 100.01 && room.top + room.height <= 100.01;
const percent = (value) => `${Number(value.toFixed(2))}%`;

// A label with a corner at (x, y), in % of the frame, that runs right or left of x and down or
// up from y: its CSS place (left or right, top or bottom; no transform) and the room it takes.
function labelAt(kind, text, [x, y], { right, down }, line) {
  const width = (text.length + 1) * LETTER_SHARE;
  return {
    kind, text,
    style: { [right ? "left" : "right"]: percent(right ? x : 100 - x), [down ? "top" : "bottom"]: percent(down ? y : 100 - y) },
    room: { left: right ? x : x - width, top: down ? y : y - line, width, height: line },
  };
}

/**
 * Where to draw on the source frame, in % of it (the board keeps crops, boxes and the eye line
 * so): {crop: {left, top, width, height} | null, subjects: [{left, top, width, height}], eyes:
 * {top, left, width} | null, labels: [{kind, text, style}]}, or null for a shot with no footage
 * to show. Each label's `style` is its CSS place, inside the frame (review round 2 of B4b: one
 * by the frame's top or right edge was cut off, and the crop's could cover a subject box).
 */
export function overlayBoxes(shot) {
  if (!hasFootage(shot) || shot.media.missing) return null;
  const box = ([left, top, width, height]) => ({ left, top, width, height });
  const line = LINE_SHARE * ((shot.media.width || 16) / (shot.media.height || 9));
  const crop = Array.isArray(shot.crop) ? box(shot.crop) : null;
  const subjects = boxesOf(shot.subject).map(box);
  const eyeLine = typeof shot.subject?.eyes === "number" ? shot.subject.eyes : null;
  // The eye line runs across the crop (the picture the video keeps), or the whole frame.
  const eyes = eyeLine == null ? null : { top: eyeLine, left: crop?.left ?? 0, width: crop?.width ?? 100 };
  // A subject's label: under its box, or inside it at its bottom when the frame ends first; from
  // the box's left edge, or back from its right edge when the box starts in the frame's right half.
  const labels = subjects.map((entry) => {
    const bottom = entry.top + entry.height;
    const right = entry.left <= 50;
    return labelAt("subject", shot.subject.by ?? "agent", [right ? entry.left : entry.left + entry.width, bottom], { right, down: bottom + line <= 100 }, line);
  });
  // The eye line's label: above the line, or under it near the frame's top; at its right end, or
  // at its left end when the line ends in the frame's left half.
  if (eyes) {
    const end = eyes.left + eyes.width;
    labels.push(labelAt("eyes", "eyes", [end < 50 ? eyes.left : end, eyes.top], { right: end < 50, down: eyes.top < line }, line));
  }
  // The crop's label: in the first of its corners that keeps it in the frame and off the boxes
  // and the other labels, else off the boxes, else its top left corner.
  if (crop) {
    const [left, top, right, bottom] = [crop.left, crop.top, crop.left + crop.width, crop.top + crop.height];
    const corners = [[left, top, true, true], [right, top, false, true], [left, bottom, true, false], [right, bottom, false, false]]
      .map(([x, y, toRight, down]) => labelAt("crop", "crop", [x, y], { right: toRight, down }, line));
    const fits = corners.filter((label) => inFrame(label.room));
    const clear = (label, rooms) => !rooms.some((room) => overlaps(label.room, room));
    labels.unshift(fits.find((label) => clear(label, [...subjects, ...labels.map((other) => other.room)]))
      ?? fits.find((label) => clear(label, subjects)) ?? fits[0] ?? corners[0]);
  }
  return { crop, subjects, eyes, labels: labels.map(({ kind, text, style }) => ({ kind, text, style })) };
}

/**
 * Where a board stands, for the read-only screen, in the stop line's words (state.js): "waits for
 * you", "answered: approved with notes on the dashboard at 14:03", "not asked yet: the agent has
 * not shown you this board", … `time` turns an ISO time into "14:03" (format.js timeOfDay).
 */
export function statusWords(data, time = (iso) => iso ?? "") {
  const answer = data?.answer;
  switch (data?.status) {
    case "waiting": return "waits for you";
    case "answered": {
      const at = answer?.at ? ` at ${time(answer.at)}` : "";
      const read = READ_WORDS[answer?.read_as] ?? answer?.read_as ?? "answered";
      return `answered: ${read} ${answer?.via === "dashboard" ? "on the dashboard" : "in chat"}${at}`;
    }
    case "allowed": return "allowed: no stop (your settings or \"stop asking\")";
    case "lapsed": return "lapsed: the work changed after it was asked; the agent asks again";
    case "reopened": return "reopened: the agent asks again";
    default: return "not asked yet: the agent has not shown you this board";
  }
}

// ---- the rough cut and the timeline (board.jsx) -------------------------------------------------

/** The place in `data.shots` of the shot at `time` (seconds): the first before it starts, the last after it ends. */
export function shotIndexAt(data, time) {
  const shots = data?.shots ?? [];
  if (!shots.length) return -1;
  const found = shots.findIndex((shot) => Number(time) < Number(shot.end));
  return found < 0 ? shots.length - 1 : found;
}

/** The reel's clock: "0:04.4". */
export function clockWords(value) {
  const whole = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

// A move's words on its tag: its name ("zoom through"), else what it is planned as; a plain cut has none.
function moveWords(move) {
  if (!move || move === NONE || move.none) return null;
  const name = move.name ?? (move.planned ? `planned ${move.kind ?? "move"}` : move.kind);
  return name ? String(name).replaceAll("-", " ") : null;
}

/**
 * A shot card's tags, each layer in a few words (the numbers stay in the card's details):
 * [{kind, text, tone}]. kind: "text", "sound", "move", "follow", "look", "change" or "options";
 * tone "look" is kino's flag and "change" what changed after a redo, both said in words too.
 */
export function shotTags(shot, data) {
  const tags = [];
  if (shot.text && shot.text !== NONE) tags.push({ kind: "text", text: `"${shot.text.text}"` });
  if (shot.sound && shot.sound !== NONE) tags.push({ kind: "sound", text: soundText(shot.sound) });
  const move = moveWords(shot.move);
  if (move) tags.push({ kind: "move", text: move });
  if (shot.follow && shot.follow !== NONE && shot.follow !== "steady") tags.push({ kind: "follow", text: shot.follow });
  for (const flag of shot.measures?.flags ?? []) tags.push({ kind: "look", text: flag, tone: "look" });
  const change = changeWords(shot, data);
  if (change) tags.push({ kind: "change", text: change, tone: "change" });
  if (shot.alts?.length) tags.push({ kind: "options", text: `${shot.alts.length} other option${shot.alts.length === 1 ? "" : "s"}` });
  return tags;
}

/** The header's facts as chips: ["5 shots", "8.8 s", "9:16", "TikTok", "no music", "fresh eyes: ran"]. */
export function headChips(data) {
  const header = data?.header ?? {};
  const count = Number(header.shots) || 0;
  const chips = [`${count} shot${count === 1 ? "" : "s"}`, `${seconds(header.seconds)} s`, aspectWords(header)];
  if (header.platform) chips.push(header.platform);
  chips.push(data?.music && data.music !== NONE ? `music: ${data.music}` : "no music");
  if (data?.audio?.length) chips.push(`sound files: ${data.audio.join(", ")}`);
  if (data?.stop) chips.push({ ran: "fresh eyes: ran", skipped: "fresh eyes: skipped" }[data.fresh] ?? "fresh eyes: not reported");
  return chips;
}

/** The ask's style frame as the figure shows it: the picture's request and its words, or null without one. */
export function styleFrameView(data) {
  const frame = data?.styleFrame;
  if (!frame?.shot) return null;
  return { shot: frame.shot, part: "style", width: 960, alt: `The type over ${frame.shot}: ${frame.type}`, caption: frame.type };
}

/** What a "no" on the agent's calls adds to the answer: 'no to your call "Inter 700 for every line"'. */
export function callNoWords(calls = []) {
  return (calls ?? []).map((call) => String(call ?? "").trim()).filter(Boolean).map((call) => `no to your call "${call}"`).join("; ");
}

// ---- the person's directions on shots (board.jsx shot panel, the answer bar) ------------------
//
// A direction is one shot's entry in the notes: {n, text, pick, length, remove}. pick is
// {n: 1 or 2 (the option), letter: "B", why}, length {to, was} in seconds, remove true. They go to
// the agent as that shot's note, in words it already reads (no new op).

/** The option letters: A is the shot as the agent made it, B and C its options (alts). */
export const OPTION_LETTERS = ["A", "B", "C"];
/** The shortest and longest a person can make a shot, and the step of the length buttons. */
export const LENGTH_LIMITS = Object.freeze({ min: 0.3, max: 20, step: 0.1 });

/** Whether a shot's entry says anything: a note, an option, a length or remove. */
export function hasDirection(entry) {
  return Boolean(entry && (String(entry.text ?? "").trim() || entry.pick || entry.length || entry.remove));
}

/** One shot's directions as the words the agent hears: 'use option B: wider; make it 1.8 s (was 2.1 s); tighter'. */
export function directionWords(entry) {
  if (!entry) return "";
  const text = String(entry.text ?? "").trim();
  if (entry.remove) return ["remove this shot", text].filter(Boolean).join("; ");
  return [
    entry.pick ? `use option ${entry.pick.letter}: ${entry.pick.why}` : "",
    entry.length ? `make it ${seconds(entry.length.to)} s (was ${seconds(entry.length.was)} s)` : "",
    text,
  ].filter(Boolean).join("; ");
}

/**
 * The answer bar's chips, one a direction, in shot order: [{id, field, text}], field "remove",
 * "pick", "length" or "text" (the chip's × takes that one back).
 */
export function directionChips(notes = {}) {
  const chips = [];
  const entries = Object.entries(notes ?? {}).filter(([, entry]) => hasDirection(entry)).sort(([, a], [, b]) => a.n - b.n);
  for (const [id, entry] of entries) {
    if (entry.remove) chips.push({ id, field: "remove", text: `shot ${entry.n}: remove` });
    else {
      if (entry.pick) chips.push({ id, field: "pick", text: `shot ${entry.n}: ${entry.pick.why}` });
      if (entry.length) chips.push({ id, field: "length", text: `shot ${entry.n}: ${seconds(entry.length.to)} s` });
    }
    if (String(entry.text ?? "").trim()) chips.push({ id, field: "text", text: `shot ${entry.n}: note` });
  }
  return chips;
}

/** A shot's entry without one field (a chip's ×); null when nothing is left. */
export function withoutDirection(entry, field) {
  const next = { ...entry };
  if (field === "text") next.text = "";
  else delete next[field];
  return hasDirection(next) ? next : null;
}

/** A length a step longer or shorter, within LENGTH_LIMITS, to one decimal. */
export function steppedLength(value, step) {
  const next = Math.round((Number(value) + step) * 10) / 10;
  return Math.min(LENGTH_LIMITS.max, Math.max(LENGTH_LIMITS.min, next));
}

/**
 * The board as the person directs it, for the rough cut and the timeline: each shot with its
 * picked option's footage, in-point, crop and subject, its new length, and new start and end;
 * a removed shot keeps its place at no length (removed: true). picked is the option (0 is A).
 */
export function directedShots(data, notes = {}) {
  let at = 0;
  return (data?.shots ?? []).map((shot) => {
    const entry = notes?.[shot.id] ?? null;
    const option = entry?.pick ? shot.alts?.[entry.pick.n - 1] ?? null : null;
    const { why, ...fields } = option ?? {};
    const removed = Boolean(entry?.remove);
    const dur = removed ? 0 : Number(entry?.length?.to ?? shot.dur) || 0;
    const start = at;
    at += dur;
    return { ...shot, ...fields, dur, start, end: at, removed, picked: option ? entry.pick.n : 0, lengthChanged: Boolean(entry?.length) };
  });
}


/**
 * Where a shot's footage sits in the video's frame, in % of it, as the still draws it
 * (backend/agent/board-look.mjs stillScene): a crop fills the frame at the footage's own shape
 * (the larger scale), crop "none" fits the whole picture inside. null without footage or sizes.
 */
export function footageBox(shot, header) {
  const media = shot?.media;
  const width = Number(header?.width), height = Number(header?.height);
  if (!media || media === NONE || media.missing || !(media.width > 0 && media.height > 0) || !(width > 0 && height > 0)) return null;
  const place = (x, y, w, h) => ({ left: (x / width) * 100, top: (y / height) * 100, width: (w / width) * 100, height: (h / height) * 100 });
  if (Array.isArray(shot.crop)) {
    const [x, y, w, h] = shot.crop;
    const cropWidth = (w / 100) * media.width, cropHeight = (h / 100) * media.height;
    const scale = Math.max(width / cropWidth, height / cropHeight);
    const centerX = ((x + w / 2) / 100) * media.width, centerY = ((y + h / 2) / 100) * media.height;
    return place(width / 2 - centerX * scale, height / 2 - centerY * scale, media.width * scale, media.height * scale);
  }
  const scale = Math.min(width / media.width, height / media.height);
  const w = media.width * scale, h = media.height * scale;
  return place((width - w) / 2, (height - h) / 2, w, h);
}
