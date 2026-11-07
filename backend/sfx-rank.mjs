// Sound effects ranked by how they sound (the inspire screen's sounds tab, library inspire sounds).
//
// Each measured sound effect gets a LAION-CLAP embedding (backend/music-embed.mjs, the same model
// as songs; a sound effect is short, so it is one 10 s window of its sounding stretch). A search's
// words become a CLAP text prompt ("soft whoosh card slide" → "the sound of a soft whoosh card
// slide"), and every sound is ranked by:
// - match: how close the sound is to the words (CLAP text-to-audio cosine, 0 to 100);
// - taste: the person's use and no on sounds (kept like song taste, <data>/sound-taste.json): the
//   closest used sound minus half the closest rejected one, by centered cosine;
// - near-duplicates (centered cosine above 0.95 among the results) collapse into the best one,
//   which lists the others as `alike`;
// - when the words ask for a hit (whoosh, tap, click, swipe, pop, hit, impact, ding, ...), a clean
//   single sound wins: clips past 2 s lose up to 40 points by length and clips of several separate
//   hits (onsets in the measured stretch) up to 36; "short" in the words asks for the length alone.
// YouTube results also pass a junk filter first (junkSound): compilations, packs, meme sounds,
// "earrape", long ambiences when a hit is asked, sci-fi when it is not.
import { centeredCosine, dot, meanVector, normalize, songVector } from "./music-embed.mjs";

export const SFX_DUPLICATE = 0.95;

/** The CLAP text prompt for a search's words: "the sound of <words>" (words already a sentence stay as they are). */
export function sfxPrompt(words) {
  const text = String(words ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return "";
  return /^(?:a|an|the)\s|\bsound\b/.test(text) ? text : `the sound of a ${text}`;
}

const COMPILATION = /compilation|\b\d{2,}\s*(?:\+\s*)?(?:sound|sfx|effects?)\b|sound ?effects? ?pack|sfx ?pack|\ball sound effects\b|\bevery sound\b|top \d+|\bbest sound effects\b|\bfor editing\b.*\b(?:pack|collection)\b|\bcollection\b/i;
const MEME = /\bmeme\b|earrape|ear ?rape|\bbruh\b|vine boom|\bmlg\b|\bairhorn\b|\bdank\b|fart|\bsus\b|among us|\bmoan|loud (?:af|as hell)|\bbass ?boosted\b|\bspongebob\b|\bdisappointed\b/i;
const LONG = /\b(?:\d+\s*(?:hours?|hrs?|minutes?|mins?)|1 ?hour|loop(?:ed)?|ambien(?:ce|t)|atmosphere|background|white noise|for sleep|relax)/i;
const SCIFI = /sci[- ]?fi|laser|spaceship|space ?ship|futuristic|robot|cyber|hologram|warp|teleport|alien|ufo|blaster|phaser|transformer/i;
const HIT = /\b(?:hit|tap|click|pop|whoosh|swoosh|swish|thud|knock|snap|ding|clap|cheer|slide|swipe|impact|beep|boop|tick|clink|riser|transition|short)\b/i;

/**
 * Why a YouTube sound result is junk for the search `words`, or null when it is not: a
 * compilation or pack, a meme sound, an ambience or long loop when a hit is asked (or anything
 * over 20 s then), sci-fi when the words do not ask for it.
 */
export function junkSound(title, { words = "", seconds = null } = {}) {
  const name = String(title ?? "");
  if (COMPILATION.test(name)) return "compilation";
  if (MEME.test(name) && !MEME.test(words)) return "meme";
  const hit = HIT.test(words) && !LONG.test(words);
  if (hit && (LONG.test(name) || (Number(seconds) > 20))) return "long";
  if (SCIFI.test(name) && !SCIFI.test(words)) return "sci-fi";
  return null;
}

/** A sound's CLAP vector: the stored {model, vector} on a measured sound, or null. */
export const soundVector = (sound, model) => songVector(sound?.embedding, model);

const HIT_WORDS = /\b(?:whoosh|swoosh|swish|tap|taps|click|clicks|swipe|pop|hit|impact|ding|thud|snap|knock|beep|tick)\b/i;

/** What the words ask of a sound's shape: {hit} one clean sound, {short} a brief one. */
export function askedShape(words) {
  const text = String(words ?? "");
  const hit = HIT_WORDS.test(text) && !LONG.test(text);
  return { hit, short: hit || /\bshort\b/i.test(text) };
}

const clamp = (value) => Math.max(0, Math.min(1, value));

/**
 * Text-to-audio cosines as 0 to 100 matches, half absolute and half against the pool. Absolute:
 * CLAP's cosine for a sound that fits sits near 0.3 to 0.5, so 0.6 is full marks. Against the
 * pool: how many spreads above or below the pool's mean (a lone sound sits in the middle). So
 * the best of a pool of close sounds is not 100 and the rest are spread out.
 */
export function matchScores(cosines) {
  const mean = cosines.reduce((sum, value) => sum + value, 0) / (cosines.length || 1);
  const spread = Math.sqrt(cosines.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (cosines.length || 1));
  return cosines.map((cosine) => Math.round(100 * (0.5 * clamp(cosine / 0.6) + 0.5 * clamp(0.5 + (spread > 1e-6 ? (cosine - mean) / spread : 0) / 4))));
}

/** Points off for a sound's shape when the words ask for a hit or a short sound (0 to 76), and why. */
export function shapePenalty({ seconds, onsets }, asked) {
  let off = 0;
  const why = [];
  if (asked.short && Number(seconds) > 2) { off += Math.round(40 * clamp((seconds - 2) / 6)); why.push(`${Math.round(seconds)} s long`); }
  if (asked.hit && Number(onsets) > 1) { off += 12 * Math.min(3, onsets - 1); why.push(`${onsets} hits`); }
  return { off, why };
}

/**
 * Sounds ranked best first: [{id, match, taste, score, alike?, why}] for the entries that have a
 * vector, then the rest in their order (match null). `entries` [{id, title, vector}], `query` the
 * prompt's CLAP text vector (null: no match), `taste` {liked, rejected} (taste entries with an
 * embedding). With taste, score is 70% match and 30% taste; a sound the person said no to is last.
 */
export function rankSounds(entries, { query = null, taste = null, model, words = "" } = {}) {
  const asked = askedShape(words);
  const liked = (taste?.liked ?? []).map((entry) => ({ entry, vector: songVector(entry.embedding, model) })).filter((item) => item.vector);
  const rejected = (taste?.rejected ?? []).map((entry) => ({ entry, vector: songVector(entry.embedding, model) })).filter((item) => item.vector);
  const own = new Map([...(taste?.liked ?? []).map((entry) => [entry.id, "used"]), ...(taste?.rejected ?? []).map((entry) => [entry.id, "rejected"])]);
  const withVector = entries.filter((entry) => entry.vector);
  const pool = [...withVector.map((entry) => entry.vector), ...liked.map((item) => item.vector), ...rejected.map((item) => item.vector)];
  const center = pool.length >= 3 ? meanVector(pool) : null;
  const matches = query ? matchScores(withVector.map((entry) => dot(normalize(query), normalize(entry.vector)))) : [];
  const rows = withVector.map((entry, index) => {
    const match = query ? matches[index] : null;
    const nearest = (list) => list.reduce((best, item) => {
      if (item.entry.id === entry.id) return best;
      const near = centeredCosine(entry.vector, item.vector, center);
      return near > best.near ? { near, item } : best;
    }, { near: 0, item: null });
    let tasteScore = null;
    const why = [];
    if (own.get(entry.id) === "used") { tasteScore = 100; why.push("you used it"); }
    else if (own.get(entry.id) === "rejected") { tasteScore = 0; why.push("you said no"); }
    else if (liked.length || rejected.length) {
      const like = nearest(liked);
      const reject = nearest(rejected);
      tasteScore = Math.round(Math.max(0, Math.min(100, (liked.length ? like.near * 100 : 50) - reject.near * 50)));
      if (like.near >= 0.6) why.push(`like ${short(like.item.entry.title)}`);
      if (reject.near >= 0.6) why.push(`near rejected ${short(reject.item.entry.title)}`);
    }
    const base = match ?? 50;
    const shape = shapePenalty(entry, asked);
    why.push(...shape.why);
    const score = (tasteScore === null ? base : Math.round(0.7 * base + 0.3 * tasteScore)) - shape.off;
    return { id: entry.id, match, taste: tasteScore, score, rejected: own.get(entry.id) === "rejected", vector: entry.vector, why };
  }).sort((a, b) => Number(a.rejected) - Number(b.rejected) || b.score - a.score);
  // Near-duplicates collapse into the best of them.
  const kept = [];
  for (const row of rows) {
    const twin = kept.find((other) => centeredCosine(row.vector, other.vector, center) > SFX_DUPLICATE);
    if (twin) (twin.alike ??= []).push(row.id);
    else kept.push(row);
  }
  const ranked = kept.map(({ vector, rejected: no, why, ...row }) => ({ ...row, ...(why.length ? { why: why.join(", ") } : {}) }));
  const placed = new Set(rows.map((row) => row.id));
  return [...ranked, ...entries.filter((entry) => !placed.has(entry.id)).map((entry) => ({ id: entry.id, match: null, taste: null, score: null }))];
}

const short = (title) => { const text = String(title ?? ""); return text.length > 24 ? `${text.slice(0, 23)}…` : text; };
