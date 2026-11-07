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
  lines.push({ name: "sound", text: shot.sound && shot.sound !== NONE ? shot.sound.what : NONE });
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
  parts.push(shot.sound && shot.sound !== NONE ? `sound ${shot.sound.what}` : "no sound effect");
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
 * The shots a phone's stop card shows: what changed after a redo first, then the flagged ones,
 * then the rest, each in board order; at most `limit` (2: a shot row is most of a phone's
 * screen, and the answers come after the rows). The stop screen shows every shot.
 */
export function phoneShots(data, limit = 2) {
  const missed = new Set(data?.redone?.missed ?? []);
  const rank = (shot) => (shot.change || missed.has(shot.id) ? 0 : shot.measures?.flags?.length ? 1 : 2);
  return [...(data?.shots ?? [])].sort((a, b) => rank(a) - rank(b) || a.n - b.n).slice(0, limit);
}

/** The notes on shots, as the buttons say them: "notes on shots 2 and 4" (notes: {id: {n, text}}). */
export function shotNotesWords(notes = {}) {
  const numbers = Object.values(notes).filter((note) => String(note?.text ?? "").trim()).map((note) => note.n).sort((a, b) => a - b);
  if (!numbers.length) return null;
  return `note${numbers.length === 1 ? "" : "s"} on ${shotList(numbers)}`;
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
