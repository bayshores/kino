// The blind pick box (taste plan T1): the person watches two videos side by side in the app and
// picks the better one, "same" (a tie) or "neither" (both bad). An agent fills the queue (notes {action:"judge", videos:[[a, b]]});
// the dashboard shows the pairs as "A" and "B" with random sides, at most 5 picks a sitting.
// The queue is <taste>/queue.json; each pick is one line of <taste>/picks.jsonl (evals/taste/picks.md
// has the format). The dashboard never sees the file paths, only the pair id and which side to load.
import { randomInt } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SITTING_PICKS = 5;
// A new sitting starts when no pick came in this long.
export const SITTING_GAP_MS = 30 * 60 * 1000;
export const PICK_WORDS = ["story", "directing", "unique", "impressive", "quality", "smooth", "mix"];
// "neither" is "both bad": no win for either side; the ladder counts it as a tie and notes it.
export const PICK_SIDES = ["left", "right", "same", "neither"];
const QUEUE_MOST = 40;
const NOTE_MOST = 500;
const VIDEO_TYPES = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

/** The pairs an agent sent: [[a, b]], [{a, b, audio|picture}] or one pair [a, b]. Each is {a, b, mode}. */
export function readPairs(videos, { audio = false, picture = false } = {}) {
  const list = Array.isArray(videos) && videos.length === 2 && videos.every((entry) => typeof entry === "string") ? [videos] : videos;
  if (!Array.isArray(list) || !list.length) throw new Error('videos lists pairs of two video files: videos:[["/path/one.mp4", "/path/two.mp4"]].');
  return list.map((entry) => {
    const [a, b] = Array.isArray(entry) ? entry : [entry?.a, entry?.b];
    if (typeof a !== "string" || typeof b !== "string" || !a || !b) throw new Error('Each pair is two video files: ["/path/one.mp4", "/path/two.mp4"] or {a, b, audio:true}.');
    if (a === b) throw new Error(`A pair needs two different videos (${a} twice).`);
    const sound = (entry?.audio ?? audio) === true;
    const sight = (entry?.picture ?? picture) === true;
    if (sound && sight) throw new Error("A pair is audio (sound only) or picture (no sound), not both.");
    return { a, b, mode: sound ? "audio" : sight ? "picture" : "video" };
  });
}

/** How many picks the sitting still takes at `at` (ms), from the queue state's sitting. */
export function sittingLeft(sitting, at) {
  const fresh = sitting && at - Date.parse(sitting.lastAt) < SITTING_GAP_MS;
  return Math.max(0, SITTING_PICKS - (fresh ? sitting.count : 0));
}

/** The pick line saved for `pair` when the person chose `side` (left, right, same or neither). */
export function pickRecord(pair, { side, words = [], note = "" }, at) {
  if (!PICK_SIDES.includes(side)) throw new Error(`pick is ${PICK_SIDES.join(", ")}.`);
  const chosen = [...new Set([words].flat().map(String))];
  const unknown = chosen.filter((word) => !PICK_WORDS.includes(word));
  if (unknown.length) throw new Error(`words are ${PICK_WORDS.join(", ")} (not ${unknown.join(", ")}).`);
  const winner = side === "same" || side === "neither" ? side : side === "left" ? pair.shown_left : pair.shown_left === "a" ? "b" : "a";
  return { pair_id: pair.pair_id, a: pair.a, b: pair.b, shown_left: pair.shown_left, pick: winner,
    words: PICK_WORDS.filter((word) => chosen.includes(word)), note: String(note ?? "").trim().slice(0, NOTE_MOST), at, mode: pair.mode };
}

/**
 * deps: directory (<data>/taste), mediaRoot (relative paths resolve there), emit(view) when the
 * queue or sitting changes, now, random(n) → 0..n-1 (the side shown left).
 */
export function createPicks(deps) {
  const { directory } = deps;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? ((n) => randomInt(n));
  const queueFile = path.join(directory, "queue.json");
  const picksFile = path.join(directory, "picks.jsonl");
  let chain = Promise.resolve();

  async function read() {
    try { return JSON.parse(await readFile(queueFile, "utf8")); }
    catch { return { next: 1, pairs: [], sitting: null }; }
  }
  async function write(state) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(`${queueFile}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(`${queueFile}.tmp`, queueFile);
  }
  // One change at a time, so two quick picks never lose each other.
  function change(work) {
    const run = chain.then(async () => { const state = await read(); const result = await work(state); await write(state); return result; });
    chain = run.catch(() => {});
    return run;
  }

  /** What the dashboard sees: the pairs this sitting still takes (no paths, no sides). */
  async function view() {
    const state = await read();
    const left = sittingLeft(state.sitting, now());
    const fresh = left < SITTING_PICKS;
    return { queued: state.pairs.length, picked: fresh ? state.sitting.count : 0, most: SITTING_PICKS,
      pairs: state.pairs.slice(0, left).map((pair) => ({ pair_id: pair.pair_id, mode: pair.mode })) };
  }
  const publish = async () => deps.emit?.(await view());

  async function checkVideo(file) {
    const full = path.resolve(deps.mediaRoot ?? process.cwd(), file);
    if (!VIDEO_TYPES[path.extname(full).toLowerCase()]) throw new Error(`${file} is not an mp4, m4v, mov or webm video.`);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) throw new Error(`${file} was not found.`);
    return full;
  }

  /** Adds pairs to the queue. Returns {added: [pair ids], queued}. A pair already waiting (either order) is not added twice. */
  async function queue(videos, options = {}) {
    const pairs = readPairs(videos, options);
    for (const pair of pairs) { pair.a = await checkVideo(pair.a); pair.b = await checkVideo(pair.b); }
    const result = await change((state) => {
      const added = [];
      for (const pair of pairs) {
        const same = (entry) => entry.mode === pair.mode && ((entry.a === pair.a && entry.b === pair.b) || (entry.a === pair.b && entry.b === pair.a));
        if (state.pairs.some(same)) continue;
        if (state.pairs.length >= QUEUE_MOST) throw new Error(`The queue holds at most ${QUEUE_MOST} pairs; ${state.pairs.length} wait.`);
        const made = { pair_id: `P${state.next++}`, a: pair.a, b: pair.b, shown_left: random(2) === 0 ? "a" : "b", mode: pair.mode, queuedAt: new Date(now()).toISOString() };
        state.pairs.push(made);
        added.push(made.pair_id);
      }
      return { added, queued: state.pairs.length };
    });
    await publish();
    return result;
  }

  /** The person's pick: saves a line to picks.jsonl and takes the pair off the queue. */
  async function pick({ pair_id: id, side, words, note }) {
    const result = await change(async (state) => {
      const pair = state.pairs.find((entry) => entry.pair_id === id);
      if (!pair) throw new Error(`No pair ${id} waits.`);
      const at = now();
      const left = sittingLeft(state.sitting, at);
      if (!left) throw new Error(`This sitting has its ${SITTING_PICKS} picks; the next one starts after a break.`);
      const record = pickRecord(pair, { side, words, note }, new Date(at).toISOString());
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(picksFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      state.pairs = state.pairs.filter((entry) => entry !== pair);
      state.sitting = { count: SITTING_PICKS - left + 1, lastAt: record.at };
      return record;
    });
    await publish();
    return result;
  }

  /** The file and type to play for `side` (left or right) of a waiting pair, or null. */
  async function file(id, side) {
    const pair = (await read()).pairs.find((entry) => entry.pair_id === id);
    if (!pair || !["left", "right"].includes(side)) return null;
    const shown = side === "left" ? pair.shown_left : pair.shown_left === "a" ? "b" : "a";
    const full = pair[shown];
    return { path: full, type: VIDEO_TYPES[path.extname(full).toLowerCase()] };
  }

  return { queue, pick, view, file, picksFile };
}
