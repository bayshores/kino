// The inspire screen's data (F3, inspire.jsx draws it): the project's YouTube searches, the
// references they found and the numbers kino measured (backend/inspire.mjs). Pure functions, so
// they are tested without a browser (inspireView.test.js).
//
// data.inspire = {searches: [{n, query, by, at, state, wanted, ids, count, error?}], saved: [id],
//   refs: {id: {id, title, channel, duration, url, thumb, state, phase?, place?, numbers?, bpm?, error?,
//               print?: {still, camera, text, lowercase, words, blurDips} (fingerprint shares), strips?}},
//   queue: {running, phase, waiting}}

/** Empty tiles shown for a search that is still running (at most this many). */
export const SEARCHING_TILES = 6;

/**
 * The inspire data after one dashboard event: "inspire" for a project, "inspire-ref" for a
 * reference, "inspire-live" for the frame being measured now (kept only while it is measured).
 */
export function withInspireEvent(inspire, event, projectId) {
  if (event?.type === "inspire") return event.projectId === projectId && event.inspire ? event.inspire : inspire;
  if (event?.type === "inspire-live") {
    const id = event.live?.id;
    const known = id && inspire && (Boolean(inspire.refs?.[id]) || inspire.searches?.some((search) => search.ids?.includes(id)));
    return known ? { ...inspire, live: event.live } : inspire;
  }
  if (event?.type !== "inspire-ref" || !inspire || !event.ref?.id) return inspire;
  const id = event.ref.id;
  const known = Boolean(inspire.refs?.[id]) || inspire.searches?.some((search) => search.ids?.includes(id));
  if (!known) return inspire;
  const running = event.ref.state === "measuring" ? id : inspire.queue?.running === id ? null : inspire.queue?.running ?? null;
  const live = event.ref.state !== "measuring" && inspire.live?.id === id ? null : inspire.live ?? null;
  return { ...inspire, live, refs: { ...inspire.refs, [id]: event.ref }, queue: { ...inspire.queue, running, phase: event.ref.state === "measuring" ? event.ref.phase ?? null : inspire.queue?.phase ?? null } };
}

/** "39 s" under a minute, else "4:19" (or "1:02:05"). */
export function lengthWords(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  if (whole < 60) return `${whole} s`;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Who is searching (a search still running), else who searched last: {you: true} or the agent {id, name, color}; null before any search. */
export function searcher(inspire) {
  const searches = inspire?.searches ?? [];
  const last = searches.findLast((search) => search.state === "searching") ?? searches.at(-1);
  if (!last) return null;
  return last.by === "you" ? { you: true, name: "you" } : { you: false, id: last.by?.id ?? null, name: last.by?.name ?? "agent", color: last.by?.color ?? null };
}

/**
 * The grid's tiles, in search order, each reference once: {key, id, number, ref, state}.
 * state: "searching" (an empty tile for a search still running), "queued", "measuring",
 * "measured", "failed" or "found" (not measured: cancelled, or kino stopped while measuring).
 */
export function tiles(inspire, kind = "videos") {
  const out = [];
  const seen = new Set();
  for (const search of inspire?.searches ?? []) {
    if (kindOf(search) !== kind) continue;
    if (search.state === "searching") {
      const count = Math.min(SEARCHING_TILES, search.wanted ?? SEARCHING_TILES);
      for (let index = 0; index < count; index += 1) out.push({ key: `s${search.n}-${index}`, id: null, ref: null, state: "searching" });
      continue;
    }
    for (const id of search.ids ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const ref = inspire.refs?.[id] ?? null;
      // A sounds search's ranking (backend/sfx-rank.mjs): match to the words, taste, near-duplicates folded.
      const rank = search.ranks?.[id] ?? null;
      out.push({ key: id, id, ref, state: ref?.state ?? "found", ...(rank ? { rank } : {}) });
    }
  }
  let number = 0;
  for (const tile of out) if (tile.id) tile.number = (number += 1);
  return out;
}

/** How many references the grid shows (the "found N" title). */
export const foundCount = (list) => list.filter((tile) => tile.id).length;

/** Cut ticks across the measured stretch: [{x: 0–1, beat: true|false|null}]. */
export function ticks(numbers) {
  if (!numbers?.seconds) return [];
  return numbers.cuts.map((time, index) => ({ x: Math.min(1, Math.max(0, time / numbers.seconds)), beat: numbers.onBeat ? Boolean(numbers.onBeat[index]) : null, time }));
}

const PHASES = { fetching: "fetching 360p", "reading cuts": "reading cuts", "finding the beat": "finding the beat",
  "reading motion and text": "reading motion and text", "keeping frame strips": "keeping frame strips", "looking at shots": "looking at shots" };

/** The words under a tile: {left, right} ("1.2 cuts/s", "20 s"), or a status on the left. */
export function tileWords(tile) {
  const ref = tile.ref;
  if (tile.state === "searching" || !ref) return { left: "", right: "" };
  const right = lengthWords(ref.duration);
  if (tile.state === "measuring") return { left: PHASES[ref.phase] ?? "reading cuts", right, busy: true };
  if (tile.state === "queued") return { left: "waits to be read", right };
  if (tile.state === "failed") return { left: /sign in/i.test(ref.error ?? "") ? "YouTube wants sign-in" : "could not read", right, error: true };
  if (tile.state !== "measured" || !ref.numbers) return { left: "not read", right };
  return { left: `${ref.numbers.cutsPerSecond} cuts/s`, right };
}

/**
 * After the channel in the reference panel: " · 12k views · verified · doubt: few views" (views,
 * a verified channel, and why kino doubts it as a reference), or "" when YouTube said none.
 */
export function sourceWords(ref) {
  const views = viewWords(ref?.views);
  return `${views ? ` · ${views}` : ""}${ref?.verified ? " · verified" : ""}${ref?.doubt ? ` · doubt: ${ref.doubt}` : ""}`;
}

/** "2.1M views", "618 views", or "" when YouTube said none. */
export function viewWords(count) {
  const views = Number(count);
  if (count == null || !Number.isFinite(views)) return "";
  const size = [[1e9, "B"], [1e6, "M"], [1e3, "k"]].find(([step]) => views >= step);
  return `${size ? `${views / size[0] < 10 ? Math.floor((views / size[0]) * 10) / 10 : Math.floor(views / size[0])}${size[1]}` : String(views)} views`;
}

/**
 * The picked reference's facts as a two-column list: [[label, value, more?]] in plain words
 * ("Cuts on the beat", "31 of 69"); `more` is the rest of a row, shown on hover. Empty unread.
 */
export function factRows(ref) {
  const numbers = ref?.numbers;
  if (!numbers) return [];
  const { rows } = detailRows(ref);
  const value = (label) => rows.find(([name]) => name === label)?.[1];
  const print = ref.print ?? {};
  const out = [];
  if (numbers.onBeat) out.push(["Cuts on the beat", `${numbers.onBeatCount} of ${numbers.cuts.length}`]);
  out.push(["Shots", value("shots")], ["Cuts a second", value("cuts/s")], ["Longest shot", value("longest")]);
  if (numbers.seconds < (ref.duration ?? 0) - 0.5) out.push(["Read", `the first ${Math.round(numbers.seconds)} s`]);
  out.push(["Beat", ref.bpm ? `${Math.round(ref.bpm)} bpm` : "no steady beat"]);
  if (print.camera != null) out.push(["Camera moves", share(print.camera), `still ${share(print.still)}`]);
  if (print.text != null) out.push(["Text on screen", share(print.text), value("text")?.replace(/^on screen [^,]+(, )?/, "")]);
  if (print.blurDips != null) out.push(["Blur dips", String(print.blurDips)]);
  return out;
}

/**
 * The short chips on a video tile: views ("12k"), then why kino doubts it ("ai", "tutorial",
 * "template", "stock", "few views", "short", "seo", "tags"), "same frames" and copies hidden ("+1 copy").
 */
export function tileChips(ref) {
  const chips = [];
  const views = Number(ref?.views);
  if (ref?.views != null && Number.isFinite(views)) chips.push({ text: sourceWords({ views }).replace(/^ · | views$/g, ""), doubt: false });
  const words = { "ai title": "ai", "ai description": "ai", hashtags: "tags", "seo title": "seo", tutorial: "tutorial", template: "template", stock: "stock", "few views": "few views", "very short": "short" };
  for (const doubt of String(ref?.doubt ?? "").split(", ").filter(Boolean)) chips.push({ text: words[doubt] ?? doubt, doubt: true });
  if (ref?.same) chips.push({ text: "same frames", doubt: true });
  if (ref?.copies?.length) chips.push({ text: `+${ref.copies.length} cop${ref.copies.length === 1 ? "y" : "ies"}`, doubt: false });
  return chips.filter((chip, index, all) => all.findIndex((other) => other.text === chip.text) === index);
}

/** What a screen reader says for a tile. */
export function tileLabel(tile) {
  if (tile.state === "searching") return "searching";
  const ref = tile.ref;
  const words = tileWords(tile);
  const numbers = ref?.numbers;
  const measured = numbers ? `, ${numbers.shots} shots, ${words.left}${numbers.onBeat ? `, ${numbers.onBeatCount} of ${numbers.cuts.length} cuts on the beat` : ""}` : `, ${words.left}`;
  return `${tile.number}. ${ref?.title ?? tile.id}${ref?.channel ? `, ${ref.channel}` : ""}, ${words.right}${measured}`;
}

/** Panel 3's rows for a measured reference: [[label, value]]; and the beat line, or null. */
export function detailRows(ref) {
  const numbers = ref?.numbers;
  if (!numbers) return { rows: [], beat: null };
  const partial = numbers.seconds < (ref.duration ?? 0) - 0.5;
  const where = numbers.longest.where;
  const start = Math.round(numbers.longest.start);
  const longest = `${numbers.longest.seconds} s, ${where === "the whole clip" ? where : where ? `at ${where}` : `from ${Math.floor(start / 60)}:${String(start % 60).padStart(2, "0")}`}`;
  const rows = [
    ["shots", `${numbers.shots} in ${Math.round(numbers.seconds)} s`],
    ["cuts/s", String(numbers.cutsPerSecond)],
    ["longest", longest],
    ["length", partial ? `${lengthWords(ref.duration)} (read the first ${Math.round(numbers.seconds)} s)` : lengthWords(ref.duration)],
    ["beat", ref.bpm ? `${Math.round(ref.bpm)} bpm` : "no steady beat"],
    ...printRows(ref),
  ];
  const beat = numbers.onBeat ? { n: numbers.onBeatCount, m: numbers.cuts.length } : null;
  return { rows, beat };
}

const share = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : "?");

// The fingerprint's few numbers (backend/inspire.mjs screenNumbers), and what kino keeps of the
// video: the numbers, the thumbnail and the small frame strips (never the footage).
function printRows(ref) {
  const print = ref.print;
  if (!print) return [["kept", ref.thumb ? "numbers and a thumbnail" : "numbers"]];
  const rows = [];
  if (print.camera != null) rows.push(["camera", `moves ${share(print.camera)}, still ${share(print.still)}`]);
  if (print.text != null) rows.push(["text", `on screen ${share(print.text)}${print.lowercase != null ? `, ${share(print.lowercase)} lowercase` : ""}${print.words != null ? `, ${share(print.words)} word by word` : ""}`]);
  if (print.blurDips != null) rows.push(["blur dips", String(print.blurDips)]);
  rows.push(["kept", `numbers${ref.thumb ? ", a thumbnail" : ""} and ${ref.strips ?? 0} small frame strips (240 px); the video is deleted`]);
  return rows;
}

/** The first line of the project's brief (what the person asked for), or "". */
export function briefLine(agent) {
  const lines = agent?.brief?.lines ?? [];
  return (lines.find((line) => line.name === "message") ?? lines[0])?.text ?? "";
}

// ---- the simple views: watching a reference being read, and the ideas an agent took ----------

/** "0:05" (or "1:02:05"). */
export function clockWords(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(whole / 3600), minutes = Math.floor((whole % 3600) / 60), rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

const STEPS = [["cuts", "reading cuts"], ["beat", "finding the beat"], ["movement and text", "reading motion and text"], ["frames", "keeping frame strips"]];

/** The watch view's steps for a measuring phase: [{name, state: "done"|"now"|"next"}]. */
export function stepStates(phase) {
  const at = STEPS.findIndex(([, name]) => name === phase);
  return STEPS.map(([name], index) => ({ name, state: at < 0 ? "next" : index < at ? "done" : index === at ? "now" : "next" }));
}

/**
 * The live frame's motion in words, from its flow arrows (fractions of the picture per 1/12 s):
 * "still", "drifting right", "moving fast, up and to the left" … ; "" without flow.
 */
export function motionWords(flow) {
  if (!flow?.u?.length) return "";
  const count = flow.u.length;
  const u = flow.u.reduce((sum, value) => sum + value, 0) / count, v = flow.v.reduce((sum, value) => sum + value, 0) / count;
  const spread = flow.u.reduce((sum, value, index) => sum + Math.hypot(value - u, flow.v[index] - v), 0) / count;
  const speed = Math.hypot(u, v);
  if (speed < 0.002 && spread < 0.003) return "still";
  if (speed < 0.002) return "moving inside the picture, the camera stays put";
  const sideways = Math.abs(u) >= Math.abs(v) * 0.5 ? (u > 0 ? "right" : "left") : "";
  const upDown = Math.abs(v) >= Math.abs(u) * 0.5 ? (v > 0 ? "down" : "up") : "";
  const way = [upDown, sideways].filter(Boolean).join(" and to the ");
  return `${speed > 0.02 ? "moving fast" : "drifting"} ${way || "around"}`;
}

/** The sentence under the watched picture: what kino is doing now, in plain words. */
export function watchSentence(phase, live) {
  if (phase === "fetching") return "getting a small 360p copy to measure. it is deleted when kino is done.";
  if (phase === "reading cuts") return "finding every cut: each tick on the line below is one.";
  if (phase === "finding the beat") return "listening for the beat, to see whether the cuts land on it.";
  if (phase === "keeping frame strips") return "keeping a few small frames around the moments worth borrowing.";
  if (phase === "reading motion and text") {
    const moving = motionWords(live?.flow);
    // Only a line that reads as words: Vision's guesses at blurry text ("Open8d9e") are left out.
    const words = (live?.text ?? []).map((line) => String(line.s ?? "").trim()).find((line) => /^[\p{L}][\p{L}\s'’,.!?&-]{2,}$/u.test(line));
    const parts = [moving ? `the arrows show which way the picture moves. right now: ${moving}.` : "reading how the picture moves."];
    if (words) parts.push(`words on screen: "${words}".`);
    return parts.join(" ");
  }
  return "waiting its turn to be read.";
}

/** The "so far" lines while a reference is read, from its partial numbers: plain sentences. */
export function soFarWords(partial) {
  if (!partial?.cuts) return [];
  const lines = [];
  const count = partial.cuts.length;
  if (!count) lines.push("no cuts: one long shot");
  else {
    const every = partial.seconds / Math.max(1, count);
    lines.push(`${count} cut${count === 1 ? "" : "s"}, about one ${every < 1.5 ? "a second" : `every ${Math.round(every)} seconds`}`);
  }
  if (partial.onBeat && count >= 4) {
    const share = partial.onBeatCount / count;
    lines.push(share >= 0.6 ? `the cuts follow the music (${partial.onBeatCount} of ${count} on the beat)` : share <= 0.3 ? "the cuts ignore the music" : `some cuts land on the beat (${partial.onBeatCount} of ${count})`);
  }
  return lines;
}

/**
 * Their video as a film strip: one cell per kept strip, placed at its time and running to the
 * next one, as fractions of the measured stretch: [{file, x, w}]. Empty without strips.
 */
export function filmCells(strips, seconds) {
  const list = [...(strips ?? [])].filter((strip) => Number.isFinite(strip.at)).sort((a, b) => a.at - b.at);
  if (!list.length || !(seconds > 0)) return [];
  return list.map((strip, index) => {
    const start = index === 0 ? 0 : Math.min(1, strip.at / seconds);
    const end = index + 1 < list.length ? Math.min(1, list[index + 1].at / seconds) : 1;
    return { file: strip.file, x: start, w: Math.max(0, end - start) };
  });
}

/** The strip nearest a time: {file, frame} (frame 3 of 6 is the moment itself), or null. */
export function stripNear(strips, time) {
  let best = null;
  for (const strip of strips ?? []) if (!best || Math.abs(strip.at - time) < Math.abs(best.at - time)) best = strip;
  return best ? { file: best.file, frame: 3 } : null;
}

/** Up to three frames that show an idea: at its start, middle and end (or just the moment). */
export function ideaFrames(strips, idea) {
  if (!strips?.length) return [];
  const times = idea.to != null && idea.to - idea.from >= 0.6 ? [idea.from, (idea.from + idea.to) / 2, idea.to] : [idea.from];
  if (times.length === 1) {
    const strip = stripNear(strips, idea.from);
    return [0, 3, 5].map((frame) => ({ file: strip.file, frame }));
  }
  return times.map((time) => stripNear(strips, time));
}

/** "0:01 to 0:05", or "0:09". */
export const ideaTimeWords = (idea) => (idea.to != null && clockWords(idea.to) !== clockWords(idea.from) ? `${clockWords(idea.from)} to ${clockWords(idea.to)}` : clockWords(idea.from));

/** The approval bar's words: {on, total, line}. */
export function ideasSummary(ideas) {
  const all = [...(ideas?.take ?? []), ...(ideas?.skip ?? [])];
  const on = all.filter((idea) => idea.on).length;
  return { on, total: ideas?.take?.length ?? 0, line: `${on} of ${ideas?.take?.length ?? 0} ideas on${(ideas?.skip ?? []).some((idea) => idea.on) ? ", and a skipped one" : ""}` };
}

/**
 * Soundtrack candidates (backend/soundtrack.mjs) as rows for the inspire screen: the chips, and the
 * energy curve over the video's length as an SVG path on a 100 x 24 box, with the story beats'
 * starts as x positions. The song is drawn from where the agent's comparison would start it (`start`
 * seconds in). `key` names its preview (/api/dashboard/inspire/song/<key>), and `preview` says which
 * stretch of the song it holds ({from, seconds}); null when it was measured before previews were kept.
 */
export function soundtrackRows(soundtrack) {
  const story = soundtrack?.story ?? { length: 0, beats: [] };
  const length = Math.max(1, Number(story.length) || 1);
  const marks = (story.beats ?? []).slice(1).map((beat) => Math.round((beat.from / length) * 1000) / 10);
  return (soundtrack?.candidates ?? []).map((entry) => {
    const energy = entry.measure?.energy ?? [];
    const payoff = story.beats?.length > 1 ? story.beats.at(-1).from : length * 0.75;
    const drop = (entry.measure?.sections ?? []).find((part) => part.kind === "drop" && part.at >= payoff);
    const start = drop ? Math.max(0, Math.min(drop.at - payoff, energy.length - length)) : 0;
    const points = [];
    for (let t = 0; t <= Math.min(length, energy.length - start - 1); t += 1)
      points.push(`${Math.round((t / length) * 1000) / 10},${Math.round((24 - (energy[Math.floor(start + t)] / 100) * 22) * 10) / 10}`);
    return {
      id: entry.id, title: entry.title, creator: entry.creator,
      license: entry.source === "youtube" ? "YouTube" : entry.license,
      bpm: entry.measure?.bpm ? `${Math.round(entry.measure.bpm)} bpm` : entry.measure ? "no beat" : "not measured",
      path: points.length > 1 ? `M${points.join(" L")}` : "", marks,
      key: songKey(entry.id), measured: Boolean(entry.measure), preview: entry.measure?.preview ?? null, start, length, peaks: previewPeaks(energy, entry.measure?.preview),
      verdict: entry.note?.verdict ?? null, why: entry.note?.why ?? "", picked: Boolean(entry.picked), rejected: Boolean(entry.rejected),
      fit: entry.fit?.fit ?? null, fitWhy: entry.fit?.why ?? "", lane: entry.fit?.lane ?? null, order: entry.fit?.order ?? null,
    };
  });
}

/**
 * The music tab's order: measured songs in the server's shortlist order (backend/songTaste.mjs
 * rankSongs: varied lanes first), else by fit, newest first on a tie; songs you said no to last.
 */
export function musicOrder(rows) {
  return rows.map((row, index) => ({ row, index })).filter(({ row }) => row.measured)
    .sort((a, b) => Number(a.row.rejected) - Number(b.row.rejected) || (a.row.order ?? Infinity) - (b.row.order ?? Infinity) || (b.row.fit ?? -1) - (a.row.fit ?? -1) || b.index - a.index)
    .map(({ row }) => row);
}

/** The energy (0 to 1) over a song's preview stretch, at most 64 bars, for the player. */
function previewPeaks(energy, preview) {
  if (!preview) return [];
  const part = energy.slice(Math.floor(preview.from), Math.ceil(preview.from + preview.seconds));
  const count = Math.min(64, part.length);
  return Array.from({ length: count }, (_, index) => (part[Math.floor((index * part.length) / count)] ?? 0) / 100);
}

/** A song id's preview name: yt-<video id>, ov-<Openverse id> or ia-<Archive item and file> (backend/soundtrack.mjs songKey). */
export function songKey(id) {
  const text = String(id ?? "");
  const youtube = /^yt:([A-Za-z0-9_-]{11})$/.exec(text);
  if (youtube) return `yt-${youtube[1]}`;
  if (/^archive:[A-Za-z0-9._-]{1,100}\/[^\s/]{1,240}$/.test(text)) {
    // As backend/soundtrack.mjs archiveKey: a name over 120 keeps its first 111 and a hash of the id.
    const name = text.slice(8).replace(/[^A-Za-z0-9_-]+/g, "_");
    if (name.length <= 120) return `ia-${name}`;
    let hash = 0x811c9dc5;
    for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    return `ia-${name.slice(0, 111)}_${hash.toString(16).padStart(8, "0")}`;
  }
  const openverse = /^openverse:([0-9a-f-]{36})$/i.exec(text);
  return openverse ? `ov-${openverse[1].toLowerCase()}` : null;
}

/** Where the playhead sits on a row's energy curve (0 to 100), `t` seconds into its preview; null off the curve. */
export function songPlayhead(row, t) {
  if (!row?.preview) return null;
  const x = ((row.preview.from + t - row.start) / row.length) * 100;
  return x >= 0 && x <= 100 ? Math.round(x * 10) / 10 : null;
}

/** The time in a row's preview that a click at `x` (0 to 100) on its energy curve means; null outside the preview. */
export function songSeek(row, x) {
  if (!row?.preview) return null;
  const t = row.start + (x / 100) * row.length - row.preview.from;
  return t >= 0 && t <= row.preview.seconds ? Math.round(t * 100) / 100 : null;
}

/** The player's seek bar: the time `x` pixels into a bar `width` wide means, for audio `seconds` long. */
export function seekTime(x, width, seconds) {
  if (!(seconds > 0) || !(width > 0)) return 0;
  return Math.round(Math.min(1, Math.max(0, x / width)) * seconds * 100) / 100;
}

// ---- boards, shelves and sounds (the mouse-first page) ----------------------------------------

/** A search's kind: "videos" (the default) or "sounds". */
export const kindOf = (search) => (search?.kind === "sounds" ? "sounds" : "videos");

/** The sound categories on the sounds tab; each runs a sounds search with its word. */
export const SOUND_CATEGORIES = ["whooshes", "impacts", "risers", "ticks", "ambience"];

/** Boards shown before the "N more boards" button. */
export const BOARD_LIMIT = 8;

const isSound = (ref) => ref?.kind === "sound";
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * The left pane's boards: "All found" and "Saved" pinned first, then one board per search, newest
 * first: {key, n?, name, sub, count, cover: [up to 4 ids with thumbnails], kind?, state?}.
 */
export function boardRows(inspire) {
  const searches = inspire?.searches ?? [];
  const refs = inspire?.refs ?? {};
  const cover = (ids) => ids.filter((id) => refs[id]?.thumb).slice(0, 4);
  const all = [...new Set(searches.flatMap((search) => search.ids ?? []))];
  const saved = inspire?.saved ?? [];
  const savedSounds = saved.filter((id) => isSound(refs[id])).length;
  const rows = [
    { key: "all", name: "All found", count: all.length, sub: `${all.length}, ${plural(searches.length, "search", "searches")}`, cover: cover(all) },
    { key: "saved", name: "Saved", count: saved.length, sub: `${plural(saved.length - savedSounds, "video")}, ${plural(savedSounds, "sound")}`, cover: cover(saved) },
  ];
  for (const search of [...searches].reverse()) {
    const ids = search.ids ?? [];
    const count = search.count ?? ids.length;
    const names = ids.slice(0, 2).map((id) => String(refs[id]?.title ?? "").split(/[\s:|(]/).filter(Boolean)[0]).filter(Boolean);
    const sub = search.state === "searching" ? "searching" : search.state === "failed" ? "failed" : [names.join(", "), String(count)].filter(Boolean).join(": ");
    rows.push({ key: `s${search.n}`, n: search.n, name: search.query, sub, count, cover: cover(ids), kind: kindOf(search), state: search.state });
  }
  return rows;
}

/** The boards a filter keeps (the two pinned ones always), the first `limit` of the rest, and how many more. */
export function filterBoards(rows, text = "", limit = BOARD_LIMIT) {
  const words = text.trim().toLowerCase();
  const pinned = rows.filter((row) => row.key === "all" || row.key === "saved");
  const rest = rows.filter((row) => !pinned.includes(row) && (!words || row.name.toLowerCase().includes(words)));
  return { pinned, shown: limit == null ? rest : rest.slice(0, limit), more: limit == null ? 0 : Math.max(0, rest.length - limit) };
}

/** The tiles a board holds, of one kind: "all", "saved", or one search ("s3"). */
export function boardTiles(inspire, board, kind = "videos") {
  const list = tiles(inspire, kind);
  if (board === "all" || !board) return list;
  if (board === "saved") {
    const saved = new Set(inspire?.saved ?? []);
    return list.filter((tile) => tile.id && saved.has(tile.id));
  }
  const search = (inspire?.searches ?? []).find((entry) => `s${entry.n}` === board);
  if (!search || kindOf(search) !== kind) return [];
  return tiles({ ...inspire, searches: [search] }, kind);
}

/** "All found" as shelves: one per search of the kind, newest first, with its first `per` tiles. */
export function shelves(inspire, kind = "videos", per = 4) {
  return [...(inspire?.searches ?? [])].reverse().filter((search) => kindOf(search) === kind).map((search) => {
    const list = tiles({ ...inspire, searches: [search] }, kind);
    return { key: `s${search.n}`, name: search.query, count: foundCount(list), tiles: list.slice(0, per) };
  });
}

/** How many references each tab holds: {videos, music, sounds}. */
export function kindCounts(inspire, soundtrack) {
  return { videos: foundCount(tiles(inspire, "videos")), music: (soundtrack?.candidates ?? []).filter((entry) => entry.measure).length, sounds: foundCount(tiles(inspire, "sounds")) };
}

/** The "show" menu's options for a tab: [[value, label]]. */
export const SHOW_OPTIONS = {
  videos: [["all", "show all"], ["read", "readable"], ["saved", "saved"]],
  sounds: [["all", "any length"], ["short", "under 2 s"], ["mid", "under 5 s"]],
};
/** The "sort" menu's options: [[value, label]]. */
export const SORT_OPTIONS = [["match", "best match"], ["short", "shortest"], ["cuts", "most cuts"]];

/** The tiles a show and a sort keep, in order. Tiles still searching stay at the end. */
export function arrange(list, { show = "all", sort = "match", saved = [] } = {}) {
  const keep = new Set(saved);
  const length = (tile) => tile.ref?.sound?.length ?? tile.ref?.duration ?? 0;
  const shown = list.filter((tile) => {
    if (!tile.id) return show === "all";
    if (show === "read") return tile.state === "measured";
    if (show === "saved") return keep.has(tile.id);
    if (show === "short") return length(tile) < 2;
    if (show === "mid") return length(tile) < 5;
    return true;
  });
  // Best match: ranked sounds in their order (a near-duplicate folded into another last), the rest as found.
  if (sort === "match") {
    if (!shown.some((tile) => tile.rank)) return shown;
    const folded = new Set(shown.flatMap((tile) => tile.rank?.alike ?? []));
    const place = (tile) => (folded.has(tile.id) ? 2e9 : tile.rank?.order ?? 1e9);
    return shown.map((tile, index) => ({ tile, index })).sort((a, b) => place(a.tile) - place(b.tile) || a.index - b.index).map(({ tile }) => tile);
  }
  const value = (tile) => (sort === "short" ? length(tile) : -(tile.ref?.numbers?.cutsPerSecond ?? -1));
  return [...shown].sort((a, b) => Number(!a.id) - Number(!b.id) || value(a) - value(b));
}

/**
 * A sound reference as a row: {id, videoId, title, source, tags, peaks, peak (0 to 1 or null),
 * length, seconds, saved, state}.
 */
export function soundRow(tile, saved = []) {
  const ref = tile.ref ?? {};
  const sound = ref.sound ?? null;
  const seconds = sound?.length ?? ref.duration ?? 0;
  return {
    id: tile.id, videoId: tile.id?.slice(3) ?? "", title: ref.title ?? tile.id, source: ref.channel ?? "YouTube", tags: ref.tags ?? [],
    peaks: sound?.peaks ?? [], peak: sound && seconds ? Math.min(1, Math.max(0, (sound.peakAt ?? 0) / seconds)) : null,
    seconds, length: clockWords(seconds > 0 ? Math.max(1, seconds) : 0), state: tile.state, saved: saved.includes(tile.id),
    match: tile.rank?.match ?? null, taste: tile.rank?.taste ?? null, why: tile.rank?.why ?? "", alike: tile.rank?.alike?.length ?? 0,
  };
}

/** The sound detail's rows: [[label, value]]. */
export function soundDetail(ref) {
  const sound = ref?.sound;
  const tenth = (value) => `${Math.round(value * 10) / 10} s`;
  return [
    ["length", tenth(sound?.length ?? ref?.duration ?? 0)],
    ["peak", sound?.peakAt != null ? `${tenth(sound.peakAt)} in` : "not read"],
    ["loudness", Number.isFinite(sound?.loudness) ? `${Math.round(sound.loudness)} LUFS` : "not read"],
    ["source", "YouTube"],
  ];
}

/** The note "send to <agent>" leaves: `use sound yt:<id> "<title>"`. */
export const soundNote = (ref) => `use sound ${ref.id} "${String(ref.title ?? "").replace(/"/g, "'")}"`;
