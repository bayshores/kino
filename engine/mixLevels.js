// Voice and music levels in LUFS, from a file's measured loudness curve (backend/loudness-curve.mjs:
// FFmpeg's ebur128 momentary loudness, a 400 ms window, every 0.1 s, kept beside the file as
// <file>.lufs). Pure math, shared by duck_audio (how deep a dip goes), the export (each spoken
// line leveled) and the sound rules (voice_under_bed, voice_level_spread).
//
// A curve is {step, momentary: [LUFS or null]}. Loudness over several stretches is the energy mean
// of the values in them (silence under -70 LUFS left out), the way an integrated meter adds them.
import { volumeAt } from "./animation.js";

// Spoken lines are leveled to this at export, each by one gain from its measured words.
export const VOICE_TARGET_LUFS = -16;
// The gain leveling may give a line, either way.
export const MAX_LEVEL_DB = 12;
// A layer turned down under this volume is a bed or background sound (street sound, chatter on
// footage), not a line: the export does not level it and the voice rules leave it out.
export const BED_VOLUME = 0.5;
/**
 * Whether the export levels `layer`'s words (when its file has a transcript). A line keep_line
 * leveled (voiceLevel) is leveled at any volume: its voiceLevel already counts the volume (measured
 * on dm2-a 2026-11-12: a kept line at volume 0.38 rendered 10 LU under its receipt, unleveled).
 */
export const leveledVoice = (layer) => Number.isFinite(layer?.voiceLevel) || Number(layer?.volume ?? 1) >= BED_VOLUME;
// duck_audio sets the music this far under the voice during a dip.
export const VOICE_OVER_MUSIC = 9;
// A spoken line is heard at least this many LU over the music under it (voice_under_bed).
export const VOICE_OVER_BED = 6;
const SILENCE = -70;

const db = (volume) => 20 * Math.log10(Math.max(1e-6, volume));
const round1 = (value) => Math.round(value * 10) / 10;

/** The energy mean (LUFS) of `values`, or null when none is above silence. */
export function energyMean(values) {
  const heard = values.filter((value) => Number.isFinite(value) && value > SILENCE);
  if (!heard.length) return null;
  return 10 * Math.log10(heard.reduce((sum, value) => sum + 10 ** (value / 10), 0) / heard.length);
}

/** The curve's values whose times fall in `spans` ([{start, end}] in file seconds). */
export function curveValues(curve, spans) {
  if (!Array.isArray(curve?.momentary) || !(curve.step > 0)) return [];
  const values = [];
  for (const { start, end } of spans) {
    const first = Math.max(0, Math.floor(start / curve.step));
    const last = Math.min(curve.momentary.length - 1, Math.ceil(end / curve.step) - 1);
    for (let index = first; index <= last; index += 1) values.push(curve.momentary[index]);
  }
  return values;
}

/** The loudness (LUFS) of a file over `spans` (file seconds), or null. */
export const loudnessOver = (curve, spans) => energyMean(curveValues(curve, spans));

/** The gain (dB) that brings a line measured at `lufs` to `target` (VOICE_TARGET_LUFS by default), or null. */
export function levelGain(lufs, target = VOICE_TARGET_LUFS) {
  if (!Number.isFinite(lufs)) return null;
  return round1(Math.max(-MAX_LEVEL_DB, Math.min(MAX_LEVEL_DB, target - lufs)));
}

// A kept clip line over music (keep_line). Leveled to the fixed VOICE_TARGET_LUFS under a song
// dipped 9 dB, run 8's only kept line left the mix 2 to 5 LU under the 2 s around it, a hole where
// the line should land (.scratch/run8/trace/audio.md L31-32). Human edits hold the total under a
// line (one measured -10.9 LUFS with and without speech, audio.md L84) or let the music drop out.
// So over music the line sits LINE_OVER_BED LU over the dipped music under it, and the two together
// sum to the music heard in the 2 s around the line. The design asked for 3 LU; kino's own
// voice_under_bed check warns under VOICE_OVER_BED (6) LU, so a 3 LU default handed the agent a
// warning (and a critic its "dip deeper" note). The same 6 here keeps keep_line and the check in
// agreement; the total still holds (renders in .scratch/run8/wave/line-over-music-review).
export const LINE_OVER_BED = VOICE_OVER_BED;
// A dip goes no deeper than this (dB): music under -20 dB sounds switched off (audioDucking DIP_FLOOR).
const LINE_DIP_FLOOR_DB = -20;
// A mix within this many LU under the music around a line counts as held (1.5 LU is a guess: about
// the smallest step of loudness a listener names; the run 8 mix under its one kept line fell 2 to 5 LU).
export const MIX_HOLD_LU = 1.5;
const powerSum = (...values) => 10 * Math.log10(values.filter(Number.isFinite).reduce((sum, value) => sum + 10 ** (value / 10), 0));

/**
 * The level of a kept line over music, all in LUFS as heard: `line` the line before leveling (its
 * volume applied), `around` the music in the 2 s around it, `under` the music under it before the
 * dip. Returns {target, gain, heard, dipDb, total} (dipDb: the music's change under the line, 0 or
 * less; -Infinity with dropout), or null when a level is unknown. `dropDb` sets the dip instead
 * (a given dip), `dropout` takes the music out: the line alone then holds the music's level (a guess).
 * The line is never leveled under VOICE_TARGET_LUFS: over a quiet bed (a talk over music at 0.2)
 * it stays the -16 talking-head line it was, and the mix rises under it (the receipt says by how much).
 */
export function lineOverMusic({ line, around, under }, { dropDb, dropout = false } = {}) {
  if (![line, around, under].every(Number.isFinite)) return null;
  // The line that, with a bed LINE_OVER_BED under it, sums to `around`; at least the talking-head target.
  const target = Math.max(VOICE_TARGET_LUFS, dropout ? around : around - 10 * Math.log10(1 + 10 ** (-LINE_OVER_BED / 10)));
  const gain = round1(Math.max(-MAX_LEVEL_DB, Math.min(MAX_LEVEL_DB, target - line)));
  const heard = line + gain;
  const dipDb = dropout ? -Infinity
    : Number.isFinite(dropDb) ? Math.min(0, dropDb)
    : Math.max(LINE_DIP_FLOOR_DB, Math.min(0, heard - LINE_OVER_BED - under));
  const total = powerSum(heard, under + dipDb);
  const result = { target: round1(target), gain, heard: round1(heard), dipDb: Number.isFinite(dipDb) ? round1(dipDb) : dipDb, total: round1(total) };
  // A line the gain cap (MAX_LEVEL_DB) keeps under a target the music sets: `short` LU. Under the
  // -16 floor the music is not the reason, so nothing is reported there.
  const short = target > VOICE_TARGET_LUFS ? round1(target - heard) : 0;
  if (short > 0.05) {
    result.short = short;
    // The dip at which the line and the dipped music still sum to MIX_HOLD_LU under the music around
    // it (a mix that holds to within a step the ear misses); absent when the line alone is louder.
    const room = 10 ** ((around - MIX_HOLD_LU) / 10) - 10 ** (heard / 10);
    if (!dropout && room > 0) result.holdDb = round1(Math.min(0, 10 * Math.log10(room) - under));
  }
  return result;
}

// The deepest dip lineWays tries (dB), the dip floor duck_audio uses (DIP_FLOOR 0.1).
const WAY_DIP_FLOOR_DB = -20;
// Over a quiet bed the ceiling is at least this (momentary LUFS): a line this loud with a bed under
// it stays clear of the limiter at kino's loudness targets (-14 LUFS web). A guess, not measured on a render.
export const LIFT_CEILING = -10;

/**
 * The three ways a line can be heard over a song, measured (LUFS as heard, the line's volume
 * applied): `line` the line before leveling, `under` the song under it untouched, `ceiling` the
 * song's own loudest moment in the scene (a finished song meets the master limiter there, so a mix
 * louder than it makes the limiter work; a measured stand-in for peak headroom, as the curves hold
 * no peaks). The line aims VOICE_OVER_BED LU over the song, never under VOICE_TARGET_LUFS, lifted at
 * most MAX_LEVEL_DB; the ceiling never pushes it under where it already is. Returns null when a
 * level is unknown, else
 *   lift: the song untouched: {reach (LUFS), db (the line's change), factor, over (LU over the song),
 *         headroom (dB from the mix to the ceiling, negative when over), short (LU under the aim)}
 *   dip:  the shallowest dip that reaches the aim together with the lift: {db, reach, over, headroom},
 *         or null when the -20 dB floor does not reach it
 *   out:  the music out under the line: {reach} (the line alone, lifted toward the music's level)
 */
export function lineWays({ line, under, ceiling: loudest, around }) {
  if (![line, under].every(Number.isFinite)) return null;
  // A quiet bed's loudest moment is far from the limiter: the line may still reach LIFT_CEILING.
  const ceiling = Number.isFinite(loudest) ? Math.max(loudest, LIFT_CEILING) : null;
  const roof = (bed) => (Number.isFinite(ceiling) ? (ceiling > bed + 0.01 ? 10 * Math.log10(10 ** (ceiling / 10) - 10 ** (bed / 10)) : -Infinity) : Infinity);
  const at = (dipDb) => {
    const bed = under + dipDb;
    const want = Math.max(VOICE_TARGET_LUFS, bed + VOICE_OVER_BED);
    const reach = Math.min(want, line + MAX_LEVEL_DB, Math.max(roof(bed), Math.min(line, want)));
    const total = 10 * Math.log10(10 ** (reach / 10) + 10 ** (bed / 10));
    return { reach: round1(reach), db: round1(reach - line), over: round1(reach - bed), headroom: Number.isFinite(ceiling) ? round1(ceiling - total) : null };
  };
  const lift = at(0);
  const short = round1(Math.max(0, VOICE_OVER_BED - lift.over));
  let dip = null;
  if (short > 0.05) {
    for (let dipDb = -0.5; dipDb >= WAY_DIP_FLOOR_DB - 1e-9; dipDb -= 0.5) {
      const way = at(dipDb);
      if (way.over >= VOICE_OVER_BED - 0.05) { dip = { ...way, dipDb: round1(dipDb) }; break; }
    }
  }
  const alone = Number.isFinite(around) ? Math.max(VOICE_TARGET_LUFS, around) : Math.max(VOICE_TARGET_LUFS, under);
  return {
    lift: { ...lift, factor: Math.round(10 ** (lift.db / 20) * 100) / 100, short },
    dip,
    out: { reach: round1(Math.min(alone, line + MAX_LEVEL_DB)) },
  };
}

// keep_line evens a kept line's own words: a word more than LINE_EVEN_LU over or under the line's
// median word is brought back to that edge (3 LU is a guess, twice MIX_HOLD_LU; the dm2 checkers
// heard kept lines whose loud words stood out of the mix).
export const LINE_EVEN_LU = 3;
// Each ramp into and out of an evened word lasts this long (s), centered on the word's edge (a guess:
// short enough to stay in the gap or the edge of the next word, long enough not to click).
export const EVEN_RAMP = 0.04;
// A word moves at most this far (dB) either way.
const MAX_EVEN_DB = 9;
const medianOf = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * How keep_line evens a line whose words are `words` ([{start, end}], file seconds) on its loudness
 * `curve`. Null with fewer than 3 measured words, else {median (LUFS, the median word), spread (LU,
 * loudest word less quietest), places: [{start, end, lufs, db}] (file seconds; outlying words closer
 * than two ramps joined and measured together), shift (dB the line's loudness moves with them)}.
 */
export function lineEvening(curve, words, band = LINE_EVEN_LU) {
  // A word is read from the 400 ms windows that sit inside it (centered 0.2 s in from each edge), or
  // the one centered on it when it is shorter: a window over its edge hears the next word too.
  const wordLufs = (word) => {
    const inner = { start: word.start + 0.2, end: word.end - 0.2 };
    if (inner.end - inner.start >= curve.step) return loudnessOver(curve, [inner]);
    const value = curve.momentary?.[Math.round((word.start + word.end) / 2 / curve.step)];
    return Number.isFinite(value) && value > SILENCE ? value : loudnessOver(curve, [word]);
  };
  const measured = words.map((word) => ({ start: word.start, end: word.end, lufs: wordLufs(word) })).filter((word) => word.lufs !== null);
  if (measured.length < 3) return null;
  const median = medianOf(measured.map((word) => word.lufs));
  const gainFor = (lufs) => {
    const off = lufs - median;
    return Math.abs(off) <= band ? 0 : round1(Math.max(-MAX_EVEN_DB, Math.min(MAX_EVEN_DB, Math.sign(off) * band - off)));
  };
  const places = [];
  for (const word of measured) {
    const db = gainFor(word.lufs);
    if (!db) continue;
    const last = places.at(-1);
    if (last && Math.sign(last.db) === Math.sign(db) && word.start - last.end < 2 * EVEN_RAMP) {
      last.end = word.end;
      last.lufs = wordLufs(last);
      last.db = gainFor(last.lufs) || last.db;
    } else places.push({ ...word });
    places.at(-1).db ??= db;
  }
  for (const place of places) place.lufs = round1(place.lufs);
  // The line's loudness before and with the gains: each word's own reading, weighted by its length
  // (the curve itself smears a loud word into its neighbors' windows).
  const energy = (gain) => measured.reduce((sum, word) => sum + (word.end - word.start) * 10 ** ((word.lufs + gain(word)) / 10), 0);
  const placeOf = (word) => places.find((place) => word.start >= place.start - 1e-6 && word.end <= place.end + 1e-6)?.db ?? 0;
  const lufs = measured.map((word) => word.lufs);
  return { median: round1(median), spread: round1(Math.max(...lufs) - Math.min(...lufs)), places, shift: round1(10 * Math.log10(energy(placeOf) / energy(() => 0))) };
}

/** The ways of lineWays in a few words, `level` the music's volume (for a dip's volume). */
export function waysText(ways, level = 1) {
  if (!ways) return null;
  const signed = (value) => `${value >= 0 ? "+" : ""}${value}`;
  const { lift, dip, out } = ways;
  const room = (way) => (way.headroom === null ? "" : `, ${way.headroom >= 0 ? `${way.headroom} dB under` : `${-way.headroom} dB over`} the song's loudest moment`);
  const factor = (db) => `x${Math.round(10 ** (db / 20) * 100) / 100} (${signed(db)} dB)`;
  return [
    `song untouched, line ${factor(lift.db)}: ${signed(lift.over)} LU over it${lift.short > 0 ? ` (${lift.short} LU short of +${VOICE_OVER_BED})` : ""}${room(lift)}`,
    dip ? `dip ${Math.round(level * 10 ** (dip.dipDb / 20) * 1000) / 1000} (${dip.dipDb} dB), line ${factor(dip.db)}: ${signed(dip.over)} LU${room(dip)}`
      : lift.short > 0 ? `no dip down to ${WAY_DIP_FLOOR_DB} dB reaches +${VOICE_OVER_BED} LU` : "no dip needed",
    `music out: the line alone at ${out.reach} LUFS`,
  ].join(" · ");
}

/** The loudest a sound layer is heard (momentary LUFS, its volume and animations applied) over its Play `range`, or null. */
export function loudestHeard(curve, layer, range) {
  if (!Array.isArray(curve?.momentary) || !(curve.step > 0) || !range) return null;
  let loudest = null;
  for (let time = range.start; time < range.end; time += curve.step) {
    const value = curve.momentary[Math.floor((range.offset + (time - range.start)) / curve.step)];
    if (!Number.isFinite(value) || value <= SILENCE) continue;
    const heard = value + db(volumeAt(layer, time + curve.step / 2));
    if (loudest === null || heard > loudest) loudest = heard;
  }
  return loudest === null ? null : round1(loudest);
}

// A clip whose spoken lines need leveling gains more than this apart is leveled line by line.
export const LINE_SPREAD_DB = 6;

/**
 * How the export levels a voice whose heard words are `spans` [{start, end}] (file seconds): one
 * gain for all of them, or, when its lines (split at pauses over LINE_PAUSE) need gains more than
 * LINE_SPREAD_DB apart (TTS lines made at different levels), one gain per line. Returns null, or
 * {gain, lines?: [{from, to, gain}]} whose lines cover the file, changing gain mid-pause.
 */
export function voiceLeveling(curve, spans, target = VOICE_TARGET_LUFS) {
  const gain = levelGain(loudnessOver(curve, spans), target);
  if (gain === null) return null;
  const groups = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const group = groups.at(-1);
    if (group && span.start - group.at(-1).end <= LINE_PAUSE) group.push(span);
    else groups.push([span]);
  }
  const lines = groups.map((group) => ({ start: group[0].start, end: group.at(-1).end, gain: levelGain(loudnessOver(curve, group), target) ?? gain }));
  const gains = lines.map((line) => line.gain);
  if (lines.length < 2 || Math.max(...gains) - Math.min(...gains) <= LINE_SPREAD_DB) return { gain };
  const middle = (index) => Math.round((lines[index].end + lines[index + 1].start) * 500) / 1000;
  return { gain, lines: lines.map((line, index) => ({ from: index ? middle(index - 1) : -Infinity, to: index < lines.length - 1 ? middle(index) : Infinity, gain: line.gain })) };
}

/**
 * The loudness (LUFS) a leveled voice is heard at in the render, at volume 1: its words `spans`
 * (file seconds) through its curve with the export's leveling gains. Usually VOICE_TARGET_LUFS,
 * but a voice too quiet or loud for MAX_LEVEL_DB stays off it (a TTS line at -34 LUFS is heard at
 * -22). Null without a measurement.
 */
export function leveledLoudness(curve, spans) {
  const leveling = voiceLeveling(curve, spans);
  if (!leveling) return null;
  return energyMean(spans.flatMap((span) => curveValues(curve, [span]).map((value) => (Number.isFinite(value) ? value + levelAt(leveling, span.start) : value))));
}

/**
 * A voiceLeveling result with `own` stretches ([{start, end}], file seconds: sounds keep_line kept at
 * their own level) at 0 dB: {gain, lines} whose lines cover the file, or the result unchanged.
 */
export function withOwnLevel(leveling, own = []) {
  if (!leveling || !own.length) return leveling;
  const cuts = [...new Set([...(leveling.lines ?? []).flatMap((line) => [line.from, line.to]), ...own.flatMap((span) => [span.start, span.end])])]
    .filter(Number.isFinite).sort((a, b) => a - b);
  const edges = [-Infinity, ...cuts, Infinity];
  const lines = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const [from, to] = [edges[index], edges[index + 1]];
    const probe = Number.isFinite(from) ? (Number.isFinite(to) ? (from + to) / 2 : from) : to - 1;
    const gain = own.some((span) => probe >= span.start && probe < span.end) ? 0 : levelAt(leveling, probe);
    if (lines.at(-1)?.gain === gain) lines.at(-1).to = to;
    else lines.push({ from, to, gain });
  }
  return { gain: leveling.gain, lines };
}

/** The leveling gain (dB) at file second `time` of a voiceLeveling result (0 without one). */
export const levelAt = (leveling, time) => (leveling?.lines?.find((line) => time >= line.from && time < line.to)?.gain ?? leveling?.gain ?? 0);

/**
 * The music volume for a dip: the music (`music` LUFS at volume 1) sits VOICE_OVER_MUSIC LU under
 * the voice (`voice` LUFS as heard). Never above `current` (a dip does not raise the music), never
 * under 0.02. Null when either is unknown.
 */
export function duckDepth(voice, music, current = 1) {
  if (!Number.isFinite(voice) || !Number.isFinite(music)) return null;
  const volume = 10 ** ((voice - VOICE_OVER_MUSIC - music) / 20);
  return Math.round(Math.max(0.02, Math.min(current, volume)) * 1000) / 1000;
}

/**
 * The loudness (LUFS) of `layer` as heard from `from` to `to` scene seconds: its file's curve
 * through its Play range (`range` from mediaPlaybackRange), its volume at each moment and `gain` dB.
 */
export function heardLoudness(curve, layer, range, from, to, gain = 0) {
  if (!Array.isArray(curve?.momentary) || !range) return null;
  const values = [];
  const step = curve.step;
  for (let time = Math.max(from, range.start); time < Math.min(to, range.end); time += step) {
    const index = Math.floor((range.offset + (time - range.start)) / step);
    const value = curve.momentary[index];
    if (Number.isFinite(value) && value > SILENCE) values.push(value + gain + db(volumeAt(layer, time + step / 2)));
  }
  return energyMean(values);
}

// Beds are measured in steps this long (the curves' step).
const BED_STEP = 0.1;

/**
 * The loudness (LUFS) of several beds heard together from `from` to `to` scene seconds: at each
 * step their energies add up (two beds at -20 LUFS make -17), then the steps are energy-averaged.
 * `beds` are [{curve, layer, range}] as heardLoudness takes them. Null when none is heard.
 */
export function bedLoudness(beds, from, to) {
  const totals = [];
  for (let time = from; time < to - 1e-9; time += BED_STEP) {
    let energy = 0;
    for (const { curve, layer, range } of beds) {
      if (!Array.isArray(curve?.momentary) || !range || time < range.start || time >= range.end) continue;
      const value = curve.momentary[Math.floor((range.offset + (time - range.start)) / curve.step)];
      if (Number.isFinite(value) && value > SILENCE) energy += 10 ** ((value + db(volumeAt(layer, time + BED_STEP / 2))) / 10);
    }
    if (energy > 0) totals.push(10 * Math.log10(energy));
  }
  return energyMean(totals);
}

// A pause this long ends a spoken line.
export const LINE_PAUSE = 0.6;

/**
 * A voice's spoken lines as heard, measured the one way voice_under_bed and duck_audio both use:
 * `words` ([{text, start, end}] in file seconds, inside its Play `range`) split at pauses over
 * LINE_PAUSE and where `breaks(word, next)` says, the voice leveled as the export does
 * (voiceLeveling), its volume applied. Returns [{words, start, end (scene s), lufs, heard}]
 * (heard: each word's {text, start, end (scene s), lufs}); lines under 0.4 s are left out.
 */
export function voiceLines(curve, layer, range, words, breaks = () => false) {
  // A line keep_line leveled over music (layer.voiceLevel) is heard at that level, as the export does.
  const leveling = voiceLeveling(curve, words.map((word) => ({ start: word.start, end: word.end })), layer?.voiceLevel ?? VOICE_TARGET_LUFS);
  const at = (time) => range.start + (time - range.offset);
  const lines = [];
  let run = [];
  const close = () => {
    if (!run.length) return;
    const start = at(run[0].start), end = at(run.at(-1).end);
    const heard = run.map((word) => ({ text: word.text, start: at(word.start), end: at(word.end), lufs: heardLoudness(curve, layer, range, at(word.start), at(word.end), levelAt(leveling, word.start)) }));
    const lufs = energyMean(heard.map((word) => word.lufs).filter((value) => value !== null));
    if (lufs !== null && end - start >= 0.4) lines.push({ words: run, start, end, lufs, heard });
    run = [];
  };
  for (const word of words) {
    const last = run.at(-1);
    if (last && (word.start - last.end > LINE_PAUSE || breaks(last, word))) close();
    run.push(word);
  }
  close();
  return lines;
}

/**
 * The loudest volume a song may have from `from` to `to` scene seconds for a voice heard at `voice`
 * LUFS to stay VOICE_OVER_BED LU over it, measured like voice_under_bed. `pieces` [{layer, range}]
 * are the song's layers (fit_music's pieces) playing `curve`, with their Play ranges. Rounded down
 * to 0.001; null without a measurement.
 */
export function clearVolume(curve, pieces, voice, from, to) {
  const heard = pieces.map(({ layer, range }) => heardLoudness(curve, { ...layer, volume: 1, animations: [] }, range, from, to)).filter((value) => value !== null);
  const music = energyMean(heard);
  if (music === null) return null;
  return Math.floor(10 ** ((voice - VOICE_OVER_BED - music) / 20) * 1000) / 1000;
}

// Section cues (set_cues, or a song's sections stored as cues) name a song's parts: "drop",
// "drop-2", "section-break" and so on. duck_audio warns when a dip covers one.
const SECTION = /^(?:section-|song-)?(intro|verse|pre-?chorus|chorus|build|drop|break|bridge|outro)\b/i;
export const sectionCues = (cues) => (cues ?? []).filter((cue) => Number.isFinite(cue?.time) && SECTION.test(String(cue.name ?? "")));
