// Song taste: the person's liked and rejected songs, and how well a measured song fits.
//
// The person likes a song with "use" on the inspire screen's music tab and rejects one with "no"
// (library soundtrack, person only). Both are kept across projects in <data>/song-taste.json: each
// song's id, title, creator, tempo and measured features, newest first.
//
// rankSongs gives every measured candidate a fit from 0 to 100 and the shortlist's order. Pros pick
// the lane first, then the shape, so taste, lane and the brief decide first and story fit (the drop
// near the payoff, energy rising with the beats, sung vocals clear of the spoken lines) only
// orders songs inside that:
// - Songs with a CLAP embedding (backend/music-embed.mjs) compare by centered cosine (the pool's
//   mean vector subtracted first, so "alike" means alike among these songs): taste is the closest
//   liked song minus half the closest rejected one. Each song gets a lane by zero-shot CLAP; two or
//   more rejects in one lane (and no like there) exclude that lane: ranked last, with the reason.
// - The brief (want, not[]) scores want and subtracts each "not" separately (CLAP has no "no").
// - Songs without an embedding fall back to tempo plus 5 measured features (tasteScore).
// The shortlist is ordered with MMR, so the first songs cover several lanes. Plain numbers; the
// agent still writes why a song fits (library soundtrack note).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLAP_MODEL, dot, meanVector, normalize, songVector } from "./music-embed.mjs";

export const TASTE_LIMITS = Object.freeze({ kept: 60 });
// Measured features (0 to 100) compared between songs; groove is a label.
const FEATURES = ["bass", "brightness", "density", "dynamics", "vocals"];

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

/** What taste keeps of a song: who made it and its measured shape (no file addresses). */
export function tasteEntry(candidate, at = new Date().toISOString()) {
  const measure = candidate.measure ?? {};
  const curve = measure.energy ?? [];
  const level = mean(curve);
  return {
    id: candidate.id, title: candidate.title, creator: candidate.creator, source: candidate.source,
    bpm: measure.bpm ?? null, features: measure.features ?? null, embedding: measure.embedding ?? null,
    // The energy curve's level and spread stand in for features a song was measured without.
    energy: curve.length ? { level: Math.round(level), spread: Math.round(Math.sqrt(mean(curve.map((value) => (value - level) ** 2)))) } : null,
    at,
  };
}

/** How close two tempos are, 0 to 1: equal is 1, 15% apart is 0; half and double time count as close. */
export function tempoCloseness(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  const gap = Math.min(...[1, 2, 0.5].map((factor) => Math.abs(a * factor - b) / b));
  return clamp(1 - gap / 0.15);
}

/** How alike two songs (taste entries) sound, 0 to 1: tempo, then features (or the energy curve). */
export function songCloseness(a, b) {
  const parts = [];
  const tempo = tempoCloseness(a.bpm, b.bpm);
  if (tempo !== null) parts.push(tempo);
  if (a.features && b.features) {
    const gaps = FEATURES.filter((name) => Number.isFinite(a.features[name]) && Number.isFinite(b.features[name])).map((name) => Math.abs(a.features[name] - b.features[name]));
    if (gaps.length) parts.push(clamp(1 - mean(gaps) / 50));
    if (a.features.groove && b.features.groove) parts.push(a.features.groove === b.features.groove ? 1 : 0);
  } else if (a.energy && b.energy) {
    parts.push(clamp(1 - (Math.abs(a.energy.level - b.energy.level) + Math.abs(a.energy.spread - b.energy.spread)) / 60));
  }
  return parts.length ? mean(parts) : 0;
}

/**
 * Taste 0 to 100 for a measured candidate, or null with no likes or rejects: 100 for a song the
 * person liked, 0 for one they rejected, else the closeness to the nearest liked song (50 with no
 * likes) minus half the closeness to the nearest rejected one.
 */
export function tasteScore(candidate, taste) {
  const liked = (taste?.liked ?? []).filter((entry) => entry.id !== candidate.id);
  const rejected = (taste?.rejected ?? []).filter((entry) => entry.id !== candidate.id);
  if (!taste?.liked?.length && !taste?.rejected?.length) return null;
  if (liked.length < (taste?.liked?.length ?? 0)) return { score: 100, like: null, reject: null, yours: "liked" };
  if (rejected.length < (taste?.rejected?.length ?? 0)) return { score: 0, like: null, reject: null, yours: "rejected" };
  const song = tasteEntry(candidate);
  const nearest = (list) => list.reduce((best, entry) => {
    const closeness = songCloseness(song, entry);
    return closeness > best.closeness ? { closeness, entry } : best;
  }, { closeness: 0, entry: null });
  const like = nearest(liked);
  const reject = nearest(rejected);
  const score = (liked.length ? like.closeness * 100 : 50) - reject.closeness * 50;
  return { score: Math.round(clamp(score, 0, 100)), like: like.closeness >= 0.6 ? like.entry : null, reject: reject.closeness >= 0.6 ? reject.entry : null };
}

/** Seconds of [[from, to]] spans `a` that overlap spans `b`. */
function overlap(a, b) {
  let total = 0;
  for (const [from, to] of a) for (const [start, end] of b) total += Math.max(0, Math.min(to, end) - Math.max(from, start));
  return total;
}

/**
 * Story fit 0 to 100 from compareToStory's comparison: the drop near the payoff (45), energy rising
 * to the payoff beat (35), the song covering the video (20); sung vocals over the spoken lines
 * (`spoken`: [[from, to]] video seconds) take up to 40 off.
 */
export function storyScore(measure, comparison, { spoken = [], length } = {}) {
  const c = comparison;
  const drop = c.dropOff === null ? 0.3 : clamp(1 - Math.abs(c.dropOff) / 4);
  const loudest = c.beats.length > 1 && c.beats.at(-1).energy >= Math.max(...c.beats.slice(0, -1).map((beat) => beat.energy));
  const rise = c.beats.length > 1 ? clamp(0.4 + c.rise / 50 + (loudest ? 0.2 : 0)) : 0.6;
  const video = Number(length) || c.end - c.start || 1;
  const cover = clamp(1 - c.short / video);
  let clash = 0;
  const speech = spoken.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0);
  if (speech > 0 && Array.isArray(measure?.vocals)) {
    const sung = measure.vocals.map(([from, to]) => [from - c.start, to - c.start]);
    clash = clamp(overlap(sung, spoken) / speech);
  }
  return { score: Math.round(clamp(100 * (0.45 * drop + 0.35 * rise + 0.2 * cover) - 40 * clash, 0, 100)), drop, rise, clash };
}

const z = (values) => {
  const avg = mean(values);
  const spread = Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
  return values.map((value) => (spread > 1e-6 ? (value - avg) / spread : 0));
};

/**
 * Every candidate with `fit` added when it is measured: {fit, taste, story, brief, lane, excluded,
 * why, order}. `compare(measure)` is compareToStory for the video; lanes [{id, vector}] and brief
 * {want, not: [vector]} are CLAP text vectors (null when embeddings are off).
 */
export function rankSongs(candidates, { taste, compare, spoken, length, lanes = null, brief = null, model = CLAP_MODEL } = {}) {
  const liked = taste?.liked ?? [];
  const rejected = taste?.rejected ?? [];
  const measured = candidates.filter((entry) => entry.measure);
  const vectorOf = new Map();
  for (const entry of [...measured.map((item) => ({ id: item.id, embedding: item.measure.embedding })), ...liked, ...rejected]) {
    const vector = songVector(entry.embedding, model);
    if (vector && !vectorOf.has(entry.id)) vectorOf.set(entry.id, vector);
  }
  // Centered on the pool's mean once there are enough songs to have one.
  const pool = [...vectorOf.values()];
  const center = pool.length >= 4 ? meanVector(pool) : null;
  const centered = new Map([...vectorOf].map(([id, vector]) => [id, normalize(center ? vector.map((value, i) => value - center[i]) : vector)]));
  const laneCenter = lanes?.length ? meanVector(lanes.map((lane) => lane.vector)) : null;
  const laneVectors = lanes?.length ? lanes.map((lane) => ({ id: lane.id, vector: normalize(lane.vector.map((value, i) => value - laneCenter[i])) })) : [];
  const laneOf = (id) => {
    const vector = centered.get(id);
    if (!vector || !laneVectors.length) return null;
    return laneVectors.reduce((best, lane) => { const score = dot(vector, lane.vector); return score > best.score ? { id: lane.id, score } : best; }, { id: null, score: -Infinity }).id;
  };
  const count = (list) => list.reduce((counts, entry) => { const lane = laneOf(entry.id); if (lane) counts[lane] = (counts[lane] ?? 0) + 1; return counts; }, {});
  const rejectsIn = count(rejected);
  const likesIn = count(liked);
  const likedVectors = liked.filter((entry) => centered.has(entry.id));
  const rejectedVectors = rejected.filter((entry) => centered.has(entry.id));
  const nearest = (vector, list, id) => list.filter((entry) => entry.id !== id).reduce((best, entry) => {
    const closeness = dot(vector, centered.get(entry.id));
    return closeness > best.closeness ? { closeness, entry } : best;
  }, { closeness: -1, entry: null });
  const short = (title) => (title.length > 24 ? `${title.slice(0, 23)}…` : title);

  const rows = measured.map((entry) => {
    const comparison = compare(entry.measure);
    const story = storyScore(entry.measure, comparison, { spoken, length });
    const vector = centered.get(entry.id);
    const lane = laneOf(entry.id);
    const why = [];
    let tasteValue = null;
    const own = liked.some((item) => item.id === entry.id) ? "liked" : rejected.some((item) => item.id === entry.id) ? "rejected" : null;
    if (own) { tasteValue = own === "liked" ? 100 : 0; why.push(`you ${own} it`); }
    else if (vector && (likedVectors.length || rejectedVectors.length)) {
      const like = nearest(vector, likedVectors, entry.id);
      const reject = nearest(vector, rejectedVectors, entry.id);
      const raw = (likedVectors.length ? like.closeness : 0) - 0.5 * Math.max(0, reject.closeness);
      tasteValue = Math.round(clamp(50 + 50 * raw, 0, 100));
      if (like.entry && like.closeness >= 0.4) why.push(`like ${short(like.entry.title)}`);
      if (reject.entry && reject.closeness >= 0.4) why.push(`near rejected ${short(reject.entry.title)}`);
    } else {
      // Tempo and the 5 measured features, against the songs that have them.
      const comparable = (item) => item.bpm || item.features || item.energy;
      const old = tasteScore(entry, { liked: liked.filter(comparable), rejected: rejected.filter(comparable) });
      if (old) {
        tasteValue = old.score;
        if (old.like) why.push(`like ${short(old.like.title)}`);
        if (old.reject) why.push(`near rejected ${short(old.reject.title)}`);
      }
    }
    const briefValue = vector && brief?.want ? dot(vector, brief.want) - (brief.not ?? []).reduce((sum, not) => sum + dot(vector, not), 0) : null;
    const excluded = lane && own !== "liked" && (rejectsIn[lane] ?? 0) >= 2 && !likesIn[lane] ? rejectsIn[lane] : 0;
    return { entry, comparison, story, lane, own, tasteValue, briefValue, excluded, why };
  });

  // Spread taste and brief over the pool (z-scores) so fits do not bunch; a small pool keeps the
  // plain numbers.
  const spread = (key, plain) => {
    const values = rows.filter((row) => row[key] !== null);
    const scores = values.length >= 3 ? z(values.map((row) => row[key])) : values.map((row) => plain(row[key]));
    values.forEach((row, index) => { row[`${key}Z`] = scores[index]; });
  };
  spread("tasteValue", (value) => (value - 50) / 25);
  spread("briefValue", (value) => value * 6);
  const compared = rows.some((row) => row.tasteValue !== null || row.briefValue !== null);
  for (const row of rows) {
    const parts = [[row.tasteValueZ, 0.6], [row.briefValueZ, 0.4]].filter(([value]) => value !== undefined);
    const weight = parts.reduce((sum, [, w]) => sum + w, 0);
    // A song kino cannot compare sits in the middle when others can be compared.
    const pref = weight ? clamp(50 + 20 * (parts.reduce((sum, [value, w]) => sum + value * w, 0) / weight), 0, 100) : compared ? 50 : null;
    let fit = pref === null ? row.story.score : Math.round(0.75 * pref + 0.25 * row.story.score);
    if (row.own === "liked") fit = Math.max(fit, 90);
    if (row.own === "rejected" || row.excluded) fit = Math.min(fit, 15);
    const c = row.comparison;
    const why = [...(row.lane ? [row.lane] : []), ...(row.excluded ? [`you said no to ${row.excluded} ${row.lane} songs`] : []), ...row.why];
    if (row.briefValueZ !== undefined && row.briefValueZ >= 0.8) why.push("matches the brief");
    else if (row.briefValueZ !== undefined && row.briefValueZ <= -0.8) why.push("far from the brief");
    if (c.dropOff === null) why.push("no drop in the video");
    else if (row.story.drop >= 0.75) why.push("drop on the payoff");
    else why.push(`drop ${Math.abs(c.dropOff)}s off the payoff`);
    if (row.story.rise >= 0.8) why.push("energy rises");
    else if (row.story.rise < 0.4) why.push("energy falls");
    if (row.story.clash >= 0.25) why.push("vocals over the voice");
    row.fit = { fit, taste: row.tasteValue, story: row.story.score, brief: row.briefValue === null ? null : Math.round(clamp(50 + 50 * row.briefValueZ / 2.5, 0, 100)), lane: row.lane, excluded: row.excluded, why: why.join(", ") };
  }

  // MMR: each next song is the most relevant one least like those already picked. Wider (0.5)
  // until the person liked 2 songs, then closer to plain relevance (0.8).
  const lambda = liked.length >= 2 ? 0.8 : 0.5;
  const open = rows.filter((row) => !row.excluded && row.own !== "rejected" && !row.entry.rejected);
  const picked = [];
  while (open.length) {
    let best = 0;
    let bestScore = -Infinity;
    open.forEach((row, index) => {
      const vector = centered.get(row.entry.id);
      const alike = picked.reduce((most, other) => {
        const near = vector && centered.get(other.entry.id) ? Math.max(0, dot(vector, centered.get(other.entry.id))) : 0;
        return Math.max(most, near);
      }, 0);
      const score = lambda * (row.fit.fit / 100) - (1 - lambda) * alike;
      if (score > bestScore) { bestScore = score; best = index; }
    });
    picked.push(...open.splice(best, 1));
  }
  const last = rows.filter((row) => !picked.includes(row)).sort((a, b) => b.fit.fit - a.fit.fit);
  [...picked, ...last].forEach((row, index) => { row.fit.order = index + 1; });
  const fits = new Map(rows.map((row) => [row.entry.id, row.fit]));
  return candidates.map((entry) => (fits.has(entry.id) ? { ...entry, fit: fits.get(entry.id) } : entry));
}

/** The person's taste file: read() → {liked, rejected}; like/reject(candidate) save one song. */
export function createSongTaste({ file, now = () => Date.now() }) {
  let queue = Promise.resolve();

  async function read() {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      return { liked: Array.isArray(saved.liked) ? saved.liked : [], rejected: Array.isArray(saved.rejected) ? saved.rejected : [] };
    } catch { return { liked: [], rejected: [] }; }
  }

  // One write at a time: a song moves to the front of one list and leaves the other.
  function mark(list, candidate) {
    const job = queue.then(async () => {
      const taste = await read();
      const other = list === "liked" ? "rejected" : "liked";
      const entry = tasteEntry(candidate, new Date(now()).toISOString());
      taste[other] = taste[other].filter((item) => item.id !== entry.id);
      taste[list] = [entry, ...taste[list].filter((item) => item.id !== entry.id)].slice(0, TASTE_LIMITS.kept);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(`${file}.tmp`, JSON.stringify(taste, null, 1), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      return taste;
    });
    queue = job.catch(() => {});
    return job;
  }

  /** Adds embeddings ({id: embedding}) to liked and rejected songs that were saved without one. */
  function fill(embeddings) {
    const job = queue.then(async () => {
      const taste = await read();
      for (const list of [taste.liked, taste.rejected]) for (const entry of list) if (!entry.embedding && embeddings[entry.id]) entry.embedding = embeddings[entry.id];
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(`${file}.tmp`, JSON.stringify(taste, null, 1), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      return taste;
    });
    queue = job.catch(() => {});
    return job;
  }

  return { read, fill, like: (candidate) => mark("liked", candidate), reject: (candidate) => mark("rejected", candidate) };
}
