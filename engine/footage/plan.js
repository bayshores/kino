// The plan of a whole edit from footage (compose {footage}): which moments, in what order, cut
// where, laid out how, moving how, with which transitions, captions, title, end card and music.
// Plain data in, plain data out, so the plan can be tested and printed in words (dry_run); ops.js
// turns it into edit ops.
//
// The shape of every edit:
//   1. the hook: the moment with the strongest hook (a face saying the hook line), from frame 0
//   2. the title, over the first shot of the body, landing as the music drops
//   3. the body: spoken moments in their order, shots without speech between them, cut on beats
//   4. the end card over the last shot, the music fading out
import { seeded } from "../blocks/build.js";
import { barAtOrAfter, beatGrid, editBeats, snapToImpact } from "./cuts.js";
import { faceCenter, KEEP_BAR, markedSubject, openingMoment, rankMoments, samplesIn } from "./moments.js";
import { isScreenRecording, shapeOf, shotLayout, subjectsIn } from "./layout.js";
import { editStyle } from "./treatments.js";
import { CARD_GAP, cardLines, placeCards } from "./cards.js";
import { accentTimes, burstPassages, FREE_BEAT, PACES, phrasePlan, rateAt, runsOf, songSections } from "./pace.js";
import { round as round3 } from "../numbers.js";

const sum = (list) => list.reduce((total, value) => total + value, 0);
export const END_CARD = 2.8;
// How long each title takes, in seconds (push-through-type needs at least 1.8).
const TITLE_LENGTH = { "push-through-type": 2.4, headline: 2.4 };
// The headline-reveal entrances a treatment or a type card may name for the title (never a blur).
const TITLE_ENTERS = ["fade", "lines", "letters", "fade-up", "scale", "rise"];
// The most of an edit that speech may fill (the rest is the title, the end card and pictures).
const SPEECH_SHARE = 0.65;
const SPEECH_BAR = 60;
// A cut this close to a song seam (one frame at 30 fps) is on it.
const SEAM = 1 / 30 + 1e-6;
const TRANSITION_LENGTH = { "zoom-through": 0.9, "whip-pan": 0.5, "mask-wipe": 0.9, dissolve: 0.5, "blur-through": 0.6, "fade-black": 0.6, flash: 0.3, "glitch-hit": 0.3, "push-transition": 0.5 };
// Transitions built by a move need whole shots on both sides.
const MOVE_TRANSITIONS = { "zoom-through": "zoom-through", "whip-pan": "whip-pan", "mask-wipe": "mask-through-shape" };

// Flash and glitch cuts: loud accents that need a measured moment (the song's real drop).
const LOUD_TRANSITIONS = ["flash", "glitch-hit"];
// Seam-locked cuts (music with a measured shape): soft transitions only on smooth passages, moving
// ones become a dissolve there; the shortest shot a seam may leave; the measured motion
// (moments.js) that lets a shot hold past its section's range.
const SOFT_TRANSITIONS = ["dissolve", "fade-black", "blur-through"];
const MIN_SHOT = 0.25;
const HOLD_MOTION = 0.3;
// A rise this big (dB, 4 s against the 4 s before) is a real drop: enough to motivate a hit. A
// smaller rise (a steady song's wobble, a gentle swell) still places the music, never an accent.
export const DROP_HIT_RISE = 6;
// A song onset this strong (0 to 1 against its neighbors, beatDetection.js) is a hit: what a burst
// cuts on and what a footage impact may snap a cut to.
const HIT = 0.5;
// One output frame at 30 fps: how early an impact's picture may come is counted in these (an
// impact's own frames are the clip's, at its measured rate, this when unmeasured).
const FRAME = 1 / 30;
// A burst's shots keep within this much measured brightness (luma 0 to 1) of each other, so its
// cuts, several a second, never flash (the flashing rule: a 10% luminance swing).
const BURST_LUMA = 0.1;

/**
 * The biggest rise in a loudness curve (dB every half second): where a song drops, as
 * {at: seconds, rise: dB}, or null when nothing rises 2 dB.
 */
export function dropTime(curve, { from = 4, to = Infinity } = {}) {
  if (!curve?.length) return null;
  const mean = (a, b) => { const part = curve.slice(Math.max(0, a), Math.max(0, b)); return part.length ? sum(part) / part.length : -60; };
  let best = null;
  for (let index = Math.max(8, from * 2); index < Math.min(curve.length - 8, to * 2); index += 1) {
    const rise = mean(index, index + 8) - mean(index - 8, index);
    if (!best || rise > best.rise) best = { at: index / 2, rise };
  }
  return best && best.rise >= 2 ? { at: best.at, rise: round3(best.rise) } : null;
}

/** The loudest stretch of `length` seconds in a loudness curve, as its start in seconds. */
function loudestStart(curve, length) {
  const size = Math.max(1, Math.round(length * 2));
  let best = 0, bestValue = -Infinity;
  for (let start = 0; start + size <= curve.length; start += 1) {
    const value = sum(curve.slice(start, start + size)) / size;
    if (value > bestValue) { bestValue = value; best = start; }
  }
  return best / 2;
}

/**
 * Frames per drawing of a clip: framesPerDrawing when given, else the measured drawing
 * (footage/events.mjs) when at least 60% of its readings agree, else null (unknown).
 */
const framesPerDrawing = (clip) => clip.framesPerDrawing ?? (clip.drawing?.sure >= 0.6 ? clip.drawing.frames : null);

/** Gain (0 to 1) that brings a sound measured at `loud` dB to `target` dB, at most 1. */
const gainTo = (loud, target) => Math.min(1, Math.max(0.08, 10 ** ((target - loud) / 20)));

/**
 * Plans an edit. `input`:
 *   clips     [{key, name, src, kind, width, height, duration, in, out, words, samples, shots, sound,
 *             subjectSamples?}] (sound: {src, own, duration, loud} when the clip is heard, own: its own
 *             track; subjectSamples: the file's subjects-v1 samples [{t, faces, subjects: [{box, kind}]}])
 *   music     {src, duration, analysis, loud, curve} or null
 *   voice     {src, duration, words, loud} or null
 *   frame     {width, height}; duration: seconds or undefined; treatment: a name
 *   deck      the project's deck or null; seed: a whole number; title, end: text or null
 *   pace      null, "promo" or "velocity": picture shots as runs of whole beats (pace.js)
 *   accents   true: a zoom punch on the downbeats (default off: a downbeat alone does not
 *             motivate an accent)
 * Returns the plan (see the top of this file) with `words`: the plan in plain lines.
 *
 * Quiet by default: an effect needs a measured reason. No hit lands on a beat number, only on
 * the song's real drop (a rise of DROP_HIT_RISE dB or more), sized by the rise; a flash or glitch
 * cut only on a cut on that drop (a plain cut anywhere else); no camera step on a shot's middle
 * beat; no random title slam; a push follows the footage's measured sideways motion (sample dx),
 * else one steady direction; slow motion holds frames, blending only footage measured as one
 * frame per drawing (clip.framesPerDrawing 1: drawn footage on 2s or 3s would ghost); a flash is
 * no brighter than the shot can take.
 */
export function planEdit(input) {
  const { clips, music = null, voice = null, frame, treatment, deck = null, seed = 1, pace = null } = input;
  const accents = input.accents ?? false;
  const paced = Boolean(pace);
  const rng = seeded(seed * 31 + 7);
  const style = editStyle(treatment, deck, seed);
  const byKey = new Map(clips.map((clip) => [clip.key, clip]));
  for (const clip of clips) if (clip.kind !== "picture") clip.kind = isScreenRecording(clip) ? "screen" : "camera";
  const lines = [];
  // With a voice-over, the voice speaks and the clips only show.
  const ranked = rankMoments(voice ? clips.map((clip) => ({ ...clip, words: null })) : clips);
  let moments = ranked.moments;
  const strong = moments.filter((moment) => moment.score >= KEEP_BAR);
  if (strong.filter((moment) => moment.kind === "visual").length >= 3 || strong.some((moment) => moment.kind === "speech")) moments = strong;
  const grid = music ? beatGrid(music.analysis) : null;
  const beat = grid?.period ?? FREE_BEAT;

  // ---- the hook and the length ----------------------------------------------------------------
  const opening = openingMoment(moments) ?? moments[0];
  if (!opening) throw new Error("compose found no usable moment in the footage (every stretch is dark, frozen or too short).");
  // Speech in the body must carry something: a good score and at least three words.
  const speechAll = moments.filter((moment) => moment.kind === "speech" && moment !== opening && moment.score >= SPEECH_BAR && moment.words.length >= 3);
  const openLength = opening.kind === "speech" ? opening.out - opening.in : Math.min(opening.out - opening.in, Math.max(2, 4 * beat));
  const titleKind = style.title === "push-through-type" ? "push-through-type" : "headline";
  const baseTitleLength = TITLE_LENGTH[titleKind];
  let duration = input.duration;
  if (!duration) {
    if (voice) duration = 0.4 + voice.duration + 0.8 + END_CARD;
    else {
      const speech = sum(speechAll.map((moment) => moment.out - moment.in)) + (opening.kind === "speech" ? openLength : 0);
      const footage = sum(clips.map((clip) => Math.min(clip.out ?? clip.duration, clip.duration) - (clip.in ?? 0)));
      // Long enough for the speech worth hearing and for a look at the footage (an eighth of it,
      // at most 30 s), 15 to 45 s in all.
      const pictures = Math.min(30, footage * 0.12);
      duration = Math.min(45, Math.max(speech > 0 ? 15 : 12, speech / SPEECH_SHARE * 0.8, pictures));
    }
  }
  duration = round3(Math.max(6, Math.min(600, duration)));

  // ---- the music: where it starts, so its drop lands as the title ends -------------------------
  let musicPlan = null;
  let beats = null;
  if (music) {
    const bodyAt = openLength + baseTitleLength;
    let offset;
    let measured = dropTime(music.curve);
    // A measured song shape places the drop to the millisecond (its drop section nearest the rise).
    const shapeDrop = measured && (music.shape?.sections ?? []).find((part) => part?.kind === "drop" && Number.isFinite(part.at) && Math.abs(part.at - measured.at) <= 1.5);
    if (shapeDrop) measured = { ...measured, at: shapeDrop.at };
    const drop = measured?.at ?? null;
    if (grid && drop !== null && drop - bodyAt >= 0 && drop - bodyAt + duration <= music.duration - 0.5) {
      // The downbeat nearest the drop lands where the body starts.
      const landing = barAtOrAfter(grid, drop - beat * 1.5);
      offset = landing - bodyAt;
    } else {
      const start = loudestStart(music.curve ?? [], Math.min(duration, music.duration));
      offset = grid ? barAtOrAfter(grid, Math.max(0, start)) : start;
      if (offset + duration > music.duration) offset = Math.max(0, music.duration - duration);
    }
    offset = round3(Math.max(0, offset));
    beats = grid ? editBeats(grid, { offset, start: 0 }) : null;
    musicPlan = { src: music.src, duration: music.duration, offset, start: 0, bpm: grid?.bpm ?? null, drop: drop !== null ? round3(drop - offset) : null, rise: measured?.rise ?? null };
  }
  // A measured song shape (music.shape: song-shape.mjs) locks cuts to its seams (songSections).
  // The request sets how fast every section cuts against the middle range (2 to 4 beats): a pace
  // by its beats a shot (velocity 1: half), else the treatment's shortest shot (punchy 1: half,
  // story 2: as measured, calm 4: double).
  const songScale = (pace ? PACES[pace].beats : style.beats[0]) / 2;
  const song = music?.shape && beats ? songSections(music.shape, { offset: musicPlan.offset, curve: music.curve ?? [], to: duration, scale: songScale }) : null;
  // Where a cut on the drop goes: the drop itself with a song shape, else its nearest beat.
  const dropCut = (time) => (song ? round3(time) : beats.nearest(time));
  const sectionAt = (time) => song?.sections.find((part) => time >= part.from - 1e-6 && time < part.to - 1e-6) ?? song?.sections.at(-1) ?? null;
  // The song's hits in edit time (strong onsets), for a burst and for cuts on footage impacts.
  const songHits = song ? (music.analysis?.onsets ?? []).filter((onset) => Number.isFinite(onset?.time) && (onset.strength ?? 0) >= HIT)
    .map((onset) => ({ at: round3(onset.time - musicPlan.offset), strength: onset.strength })).filter((hit) => hit.at > 0 && hit.at < duration).sort((a, b) => a.at - b.at) : [];
  // Where cuts lock: the song's seams, and a burst's start, its hits and its end once one is chosen.
  let locks = song?.seams ?? [];
  let burst = null;
  const inBurst = (time) => Boolean(burst) && time >= burst.from - 1e-6 && time < burst.to - 1e-6;
  const onSeam = (time) => locks.some((seam) => Math.abs(seam.at - time) <= SEAM);
  // A pace (or accents) without music cuts on a steady grid of FREE_BEAT beats.
  if (!beats && (pace || accents)) beats = editBeats({ first: 0, period: FREE_BEAT, bar: 0 }, { offset: 0, start: 0 });
  // The index of the beat at `time` (cut times are rounded to the millisecond), else the next one.
  const beatOf = (time) => {
    const near = beats.index(time);
    return Math.abs(beats.at(near) - time) < 0.01 ? near : beats.index(time, { up: true });
  };
  // The cut at or after `time`: the next beat when there is music, else the time itself.
  const onBeat = (time, { least = 0 } = {}) => {
    if (!beats) return round3(time);
    let at = beats.next(time - 0.02);
    while (at < time + least - 1e-6) at = round3(at + beat);
    return at;
  };

  // ---- the shots ------------------------------------------------------------------------------
  const shots = [];
  const used = new Set();
  const clipEnd = (clip) => Math.min(clip.out ?? clip.duration, clip.duration);
  // How long a moment can play: to its clip's end, or to the next cut inside the clip (a screen
  // recording's screen changes are not cuts that matter).
  const roomOf = (moment) => {
    const clip = byKey.get(moment.clip);
    return Math.min(clipEnd(clip), clip.kind === "screen" ? Infinity : moment.until ?? Infinity) - moment.in;
  };
  const addShot = (moment, start, end, extra = {}) => {
    const clip = byKey.get(moment.clip);
    let length = end - start;
    // A shot never runs past its clip's end (a shot that holds its last frame, freezeAt, may).
    const room = roomOf(moment);
    if (extra.freezeAt !== undefined) { /* the still covers the rest of the shot */ }
    else if (length > room && paced && !song) {
      // With a pace the cut stays on the beat: the last beat the moment has room for, else (under
      // a beat of room) on past the clip's own next cut, never past the clip's end.
      let index = beatOf(start + room);
      if (beats.at(index) > start + room + 1e-6) index -= 1;
      const fileRoom = clipEnd(clip) - moment.in;
      if (beats.at(index) > start + 0.3) end = beats.at(index);
      else if (length > fileRoom) end = round3(start + fileRoom);
      length = end - start;
    } else if (length > room) { length = room; end = round3(start + length); }
    const shot = { n: shots.length + 1, clip: clip.key, moment, in: round3(moment.in), start: round3(start), end: round3(end), speech: moment.kind === "speech" && !voice, ...extra };
    shots.push(shot);
    used.add(moment);
    return shot;
  };

  // 1. The hook.
  let t = 0;
  const firstCut = onBeat(openLength, { least: 0 });
  addShot(opening, 0, Math.max(firstCut, openLength), { role: "hook" });
  t = shots[0].end;
  const titleAt = t;
  // The title ends where the music drops (on that downbeat), when that is 1.8 to 3.4 s away.
  let titleLength = baseTitleLength;
  if (musicPlan?.drop !== null && musicPlan?.drop !== undefined && beats) {
    const landing = dropCut(musicPlan.drop);
    if (landing - titleAt >= 1.8 && landing - titleAt <= 3.4) titleLength = round3(landing - titleAt);
  }
  let bodyEnd = round3(duration - END_CARD);
  // With a pace the end card starts on a beat (at or before its usual time).
  let lastIndex = null;
  if (pace) {
    lastIndex = beats.index(bodyEnd);
    if (beats.at(lastIndex) > bodyEnd + 1e-6) lastIndex -= 1;
    bodyEnd = beats.at(lastIndex);
  }

  // An optional burst (pace.js burstPassages): short shots on the hits of a measured onset-dense
  // passage after the title's shot, at most one; when several passages qualify, the seed picks
  // (its own draw). No dense passage, no burst; a calm edit (sections scaled past their middle
  // range) has none. Its shots are several a second, so they are set aside first: moments whose
  // measured brightness keeps within BURST_LUMA of each other (no cut in it flashes), the best
  // ones; when the footage holds no such set, or its brightness is unmeasured, there is no burst.
  const burstMoments = new Set();
  const lumaOf = (moment) => {
    const list = samplesIn(byKey.get(moment.clip), moment.in - 0.25, moment.in + 0.25).map((sample) => sample.luma).filter(Number.isFinite);
    return list.length ? sum(list) / list.length : null;
  };
  if (song && songHits.length && songScale <= 1) {
    const beatTimes = [];
    for (let index = beats.index(0, { up: true }); beats.at(index) <= bodyEnd + 1e-6; index += 1) beatTimes.push(beats.at(index));
    const clear = titleAt + titleLength + Math.max(beat, 0.8) + beat + MIN_SHOT;
    const passages = burstPassages(songHits.map((hit) => hit.at), beatTimes, song).filter((entry) => entry.from >= clear && entry.to <= bodyEnd - MIN_SHOT);
    if (passages.length) {
      const chosen = passages[Math.floor(seeded(seed * 53 + 11).next() * passages.length)];
      const times = [chosen.from, ...chosen.cuts, chosen.to];
      const longest = Math.max(...times.slice(1).map((at, index) => at - times[index]));
      const lit = moments.filter((moment) => moment.kind === "visual" && moment !== opening && roomOf(moment) >= longest - 1e-6)
        .map((moment) => ({ moment, luma: lumaOf(moment) })).filter((entry) => entry.luma !== null).sort((a, b) => a.luma - b.luma);
      let band = [];
      for (let low = 0, high = 0; low < lit.length; low += 1) {
        high = Math.max(high, low);
        while (high + 1 < lit.length && lit[high + 1].luma - lit[low].luma <= BURST_LUMA + 1e-9) high += 1;
        if (high - low + 1 > band.length) band = lit.slice(low, high + 1);
      }
      if (band.length >= times.length - 1) {
        burst = chosen;
        for (const entry of band.sort((a, b) => b.moment.score - a.moment.score).slice(0, times.length - 1)) burstMoments.add(entry.moment);
        locks = [...locks, ...times.map((at) => ({ at, kind: "burst" }))].sort((a, b) => a.at - b.at);
      }
    }
  }

  // 2. The body: speech in its order (within the budget), pictures between.
  const budget = (bodyEnd - titleAt) * SPEECH_SHARE;
  const speechChosen = [];
  let spoken = 0;
  for (const moment of [...speechAll].sort((a, b) => b.score - a.score)) {
    const length = moment.out - moment.in;
    if (spoken + length > budget) continue;
    speechChosen.push(moment);
    spoken += length;
  }
  const order = (moment) => clips.findIndex((clip) => clip.key === moment.clip) * 1e6 + moment.in;
  speechChosen.sort((a, b) => order(a) - order(b));
  // Pictures: the clips take turns (best moment first in each), so the edit moves between them.
  const pools = clips.map((clip) => moments.filter((moment) => moment.kind === "visual" && moment.clip === clip.key && moment !== opening).sort((a, b) => b.score - a.score));
  let turn = Math.floor(rng.next() * Math.max(1, pools.length));
  // need: seconds the shot should play; a moment with that much room comes first. Inside a burst
  // only its set-aside moments play; before it, never one of them.
  const allowed = (moment) => (inBurst(t) ? burstMoments.has(moment) : !burstMoments.has(moment) || t >= burst.to - 1e-6);
  const nextPicture = (need = 0) => {
    for (const room of need > 0 ? [need, beat, 0] : [0]) {
      for (let tries = 0; tries < pools.length; tries += 1) {
        const pool = pools[(turn + tries) % pools.length];
        const found = pool.find((moment) => !used.has(moment) && allowed(moment) && roomOf(moment) >= room - 1e-6);
        if (found) { turn = (turn + tries + 1) % pools.length; return found; }
      }
    }
    return null;
  };
  const pictureLength = (moment) => {
    const [low, high] = style.beats;
    const count = low + Math.floor(rng.next() * (high - low + 1));
    const busy = (moment.motion ?? 0) > 0.25 ? 1 : 0;
    return Math.max(beat * Math.max(1, count - busy), 1.2);
  };
  // With a pace, picture shots run at a phrase's rate: phrases from the first downbeat after the
  // title's shot to the end card (pace.js). Every cut is a beat index, so no run drifts off the song.
  let runFrom = null;
  let phrases = null;
  const plannedEnd = (time) => {
    const index = beatOf(time);
    if (runFrom === null) { runFrom = index; while (!beats.isDownbeat(runFrom)) runFrom += 1; }
    phrases ??= phrasePlan(pace, Math.max(1, lastIndex - runFrom));
    // Before the first downbeat: one shot at the pace, cut on that downbeat.
    if (index < runFrom) return beats.at(Math.min(index + PACES[pace].beats, runFrom, lastIndex));
    const rate = rateAt(phrases, index - runFrom);
    return beats.at(Math.min(index + rate.beats, runFrom + rate.until, lastIndex));
  };
  // With a song shape, cuts lock to its seams: the next seam ends a shot to the millisecond, a rest
  // is held through to its return, and inside a section a shot lasts a whole number of beats from
  // the section's range (its energy). The end is planned first, then a moment with room for it;
  // the seed only picks among those lengths, and a hold of twice the range only over measured
  // motion inside the shot. No seam is ever skipped and no cut falls inside a rest: a clip too
  // short for the planned end cuts on an earlier beat that leaves no sliver before the seam, else
  // holds its last frame to the seam (freezeAt).
  const restAt = (time) => song.rests.find((rest) => time > rest.from + 1e-6 && time < rest.to - 1e-6) ?? null;
  const nextSeam = (time) => locks.find((seam) => seam.at > time + 1e-6) ?? null;
  // A cut at `end` is safe: on a seam, or outside every rest with no sliver before the next seam or the end card.
  const safeCut = (end) => {
    if (onSeam(end)) return true;
    if (restAt(end)) return false;
    const seam = nextSeam(end);
    if (seam && seam.at - end < MIN_SHOT) return false;
    return bodyEnd - end >= MIN_SHOT;
  };
  // A planned end settles on the song: a seam it passes or nearly reaches takes the cut, a rest
  // holds to its return, a sliver before the end card joins it.
  const settle = (time, end, low = 1) => {
    const seam = nextSeam(time);
    if (seam && end > seam.at - Math.max(MIN_SHOT, low * beat * 0.5)) end = seam.at;
    const rest = restAt(end);
    if (rest) end = rest.to;
    if (bodyEnd - end < MIN_SHOT) end = bodyEnd;
    return round3(end);
  };
  // The seam-locked end of a shot from `time` of `count` beats (a rest holds to its return).
  const seamCut = (time, count) => {
    const resting = song.rests.find((rest) => time >= rest.from - 1e-6 && time < rest.to - SEAM);
    if (resting) return resting.to;
    let end = beats.at(beats.index(time) + count);
    if (end < time + MIN_SHOT) end = beats.at(beats.index(time) + count + 1);
    return settle(time, end, (sectionAt(time)?.beats ?? [2, 4])[0]);
  };
  // The planned end (the seed's count) and the longer hold a moving shot may take instead.
  const seamPlan = (time) => {
    // Inside a burst every shot runs to its next hit.
    if (inBurst(time)) { const end = nextSeam(time)?.at ?? burst.to; return { end, hold: end }; }
    const [low, high] = sectionAt(time)?.beats ?? [2, 4];
    const count = low + Math.floor(rng.next() * (high - low + 1));
    return { end: seamCut(time, count), hold: seamCut(time, high * 2) };
  };
  // The end a moment with `room` seconds can reach: the planned one, else the latest earlier beat
  // that is a safe cut, else the clip's own end when that is a safe cut (inside a section a cut may
  // sit off the beat, on the footage's cut), else the planned one with the clip's last frame held
  // ({end, freezeAt}: in a rest, the still adds no energy before the return).
  const fitRoom = (time, end, room) => {
    if (end - time <= room + 1e-6) return { end };
    for (let index = beats.index(time + room); beats.at(index) >= time + MIN_SHOT - 1e-6; index -= 1) {
      const at = beats.at(index);
      if (at <= time + room + 1e-6 && at < end - 1e-6 && safeCut(at)) return { end: at };
    }
    const own = Math.floor((time + room) * 1000) / 1000;
    if (own >= time + MIN_SHOT && safeCut(own)) return { end: own };
    return { end, freezeAt: round3(time + Math.max(0, room)) };
  };
  let planned = null;
  // The title plays over a picture (words under it would collide), so the body opens on one.
  let lastSpeech = true;
  const queue = [...speechChosen];
  while (t < bodyEnd - (paced || song ? 0.05 : 0.6)) {
    let moment;
    planned = null;
    const first = t === titleAt;
    if (queue.length && !first && !inBurst(t) && (!lastSpeech || !pools.some((pool) => pool.some((entry) => !used.has(entry))))) moment = queue.shift();
    else if (first) {
      // The title's picture: the best unused one with room for the whole title.
      const need = titleLength + Math.max(beat, 0.8);
      moment = moments.filter((entry) => entry.kind === "visual" && !used.has(entry) && !burstMoments.has(entry) && roomOf(entry) >= need).sort((a, b) => b.score - a.score)[0] ?? nextPicture();
    } else {
      planned = song ? seamPlan(t) : null;
      moment = nextPicture(song ? planned.end - t : paced ? plannedEnd(t) - t : 0) ?? queue.shift() ?? null;
    }
    if (first && moment && moment.kind === "visual") {
      // Long enough to carry the title and land one beat after it; with a pace, the hero hold
      // lasts PACES[pace].hero seconds at most.
      let end = onBeat(t + titleLength + Math.max(beat, 0.8));
      if (paced && end - t > PACES[pace].hero + 1e-6) end = beats.at(beatOf(t + PACES[pace].hero) - (beats.at(beatOf(t + PACES[pace].hero)) > t + PACES[pace].hero + 1e-6 ? 1 : 0));
      // With a song shape, the first seam after the title is read (the drop) ends the title's shot.
      const seam = song?.seams.find((entry) => entry.at >= t + titleLength - SEAM && entry.at <= end + beat);
      if (seam) end = seam.at;
      else if (song) end = settle(t, end);
      const fit = song ? fitRoom(t, Math.min(end, bodyEnd), roomOf(moment)) : { end };
      addShot(moment, t, Math.min(fit.end, bodyEnd), { role: "body", ...(fit.freezeAt !== undefined ? { freezeAt: fit.freezeAt } : {}) });
      t = shots.at(-1).end;
      lastSpeech = false;
      continue;
    }
    if (!moment) {
      // Out of new moments: the best unused picture under the bar, else the clips' best moments
      // again, a second look. Why: on run 6's clips 2 pictures cleared the bar beside one spoken
      // line, the index below ran past the pictures, and the edit showed nothing from 3.2 to 12.2 s
      // (.scratch/defaults/compose-deck/before.md, main). With no picture at all, the next line said.
      moment = ranked.moments.filter((entry) => entry.kind === "visual" && !used.has(entry) && allowed(entry) && roomOf(entry) >= 0.8).sort((a, b) => b.score - a.score)[0];
      if (!moment) {
        // From every picture, over the bar or not: run 6's first 5 clips had none over it at all.
        const pictures = (moments.some((entry) => entry.kind === "visual") ? moments : ranked.moments).filter((entry) => entry.kind === "visual").sort((a, b) => b.score - a.score);
        const again = pictures[shots.length % Math.max(1, pictures.length)];
        moment = again ? { ...again, in: round3(Math.min(clipEnd(byKey.get(again.clip)) - 1, again.in + 0.5)) } : queue.shift();
        if (!moment) break;
      }
    }
    const speech = moment.kind === "speech" && !voice;
    if (song && !speech) {
      planned ??= seamPlan(t);
      // A moving shot may take the longer hold, when its clip has room for it.
      const room = roomOf(moment);
      const hold = (moment.motion ?? 0) >= HOLD_MOTION && planned.hold > planned.end && planned.hold - t <= room + 1e-6 && rng.next() < 0.5;
      const fit = fitRoom(t, Math.min(hold ? planned.hold : planned.end, bodyEnd), room);
      planned = null;
      if (fit.end <= t + 0.05) break;
      addShot(moment, t, fit.end, { role: "body", ...(fit.freezeAt !== undefined ? { freezeAt: fit.freezeAt } : {}) });
      t = shots.at(-1).end;
      lastSpeech = false;
      continue;
    }
    if (paced && !speech) {
      // A run shot: the phrase's rate in whole beats (fewer when the moment is shorter).
      let end = plannedEnd(t);
      const room = roomOf(moment);
      if (end - t > room + 1e-6) end = beats.at(beatOf(t) + Math.max(1, Math.floor((room + 1e-6) / beat))); // addShot keeps it on the beat
      if (end <= t + 0.05) break;
      addShot(moment, t, Math.min(end, bodyEnd), { role: "body" });
      t = shots.at(-1).end;
      lastSpeech = false;
      continue;
    }
    const natural = speech ? moment.out - moment.in : Math.min(moment.out - moment.in, pictureLength(moment));
    let end = onBeat(t + natural, { least: 0 });
    if (end - t < 0.8) end = onBeat(t + 0.8);
    if (!paced && end > bodyEnd - 0.6) end = bodyEnd;
    if (!paced && bodyEnd - end < 1.2) end = bodyEnd;
    if (end > bodyEnd) end = bodyEnd;
    if (end <= t + 0.3) break;
    addShot(moment, t, end, { role: "body" });
    t = shots.at(-1).end;
    lastSpeech = speech;
  }
  // The end card's shot: a picture of its own from the cut at bodyEnd, so the card's words enter
  // just after a cut. The best unused full-frame moment, else the best moment again.
  const endMoment = moments.filter((moment) => moment.kind === "visual" && !used.has(moment) && byKey.get(moment.clip).kind === "camera").sort((a, b) => b.score - a.score)[0]
    ?? moments.filter((moment) => moment.kind === "visual").sort((a, b) => b.score - a.score)[0] ?? opening;
  if (shots.at(-1).end > bodyEnd - 0.05 || paced) {
    const stretched = shots.at(-1);
    // With a song shape, a stretch past the clip's room holds its last frame.
    if (song && stretched.freezeAt === undefined && bodyEnd - stretched.start > roomOf(stretched.moment) + 1e-6) stretched.freezeAt = round3(stretched.start + roomOf(stretched.moment));
    stretched.end = bodyEnd;
  }
  addShot({ ...endMoment, kind: "visual", until: undefined }, bodyEnd, duration, { role: "end" });
  const last = shots.at(-1);
  if (last.end < duration - 1e-6) {
    // Not enough of that clip: a still of its last frame holds (the end card covers it).
    last.freezeAt = last.end;
    last.end = duration;
  }

  // ---- cuts on footage impacts ----------------------------------------------------------------
  // Inside a section a cut moves onto the action in the shot: where the outgoing clip's measured
  // impact (footage/events.mjs) can land on a song hit within reach of the planned cut, the impact
  // frame shows on the hit (up to 2 frames early, never late) and the cut follows it (cuts.js
  // snapToImpact). Seams, rests, a burst, the title's shot, speech and held frames keep their cuts.
  // Motion carried across the cut (the same measured direction on both sides) only breaks ties.
  const snaps = [];
  const motionAt = (clip, time) => (clip.events ?? []).find((event) => event?.kind === "motion" && time >= event.t - 1e-6 && time <= event.to + 1e-6)?.dir ?? null;
  if (song && songHits.length) {
    for (let index = 2; index < shots.length - 1; index += 1) {
      const shot = shots[index], next = shots[index + 1];
      if (shot.role !== "body" || next.role !== "body" || shot.speech || next.speech || shot.freezeAt !== undefined || next.freezeAt !== undefined) continue;
      const clip = byKey.get(shot.clip);
      const impacts = (clip.events ?? []).filter((event) => event?.kind === "impact");
      const cut = shot.end;
      if (!impacts.length || onSeam(cut) || restAt(cut) || inBurst(cut) || inBurst(shot.start)) continue;
      const after = nextSeam(cut);
      const low = Math.max(shot.start + MIN_SHOT, next.end - roomOf(next.moment));
      const high = Math.min(next.end - MIN_SHOT, (after?.at ?? Infinity) - MIN_SHOT, bodyEnd - MIN_SHOT);
      const roomEnd = Math.min(clipEnd(clip), clip.kind === "screen" ? Infinity : shot.moment.until ?? Infinity);
      const nextClip = byKey.get(next.clip);
      const incoming = motionAt(nextClip, next.in);
      // An impact frame and a contact drawing's hold are counted in the clip's own measured frames
      // (anime is about 24 a second, drawn on 2s or 3s); how early the picture may come, in output frames.
      const clipFrame = clip.rate > 0 ? 1 / clip.rate : FRAME;
      const carry = (newIn, at) => (incoming && motionAt(clip, newIn + (at - shot.start) - clipFrame) === incoming ? 1 : 0);
      const snap = snapToImpact({ cut, start: shot.start, in: shot.in, roomEnd, impacts, hits: songHits, low, high, reach: Math.min(0.75 * beat, 0.5), frame: FRAME, clipFrame, hold: framesPerDrawing(clip) ?? 1, carry });
      if (!snap || restAt(snap.at)) continue;
      shot.in = snap.in;
      shot.end = snap.at;
      next.start = snap.at;
      shot.impact = { at: snap.hit, file: snap.impact, early: snap.early };
      snaps.push({ shot: shot.n, at: snap.at, hit: snap.hit, early: snap.early });
    }
  }

  // ---- layouts, camera, transitions -----------------------------------------------------------
  // A camera shot behind a screen recording fills the frame: same shape as the frame.
  const camera = clips.filter((clip) => clip.kind === "camera" && shapeOf(clip.width, clip.height) === shapeOf(frame.width, frame.height));
  let side = rng.next() < 0.5 ? 0 : 1;
  for (const shot of shots) {
    const clip = byKey.get(shot.clip);
    // A subject the agent marked leads; else the faces measured; else the face in the file's
    // subjects-v1 samples (clip.subjectSamples). Where the eye goes (a saliency box, no face found)
    // only decides fill or blur-fill: it is never the shot's face.
    const stretch = [shot.in, shot.in + (shot.end - shot.start)];
    const marked = markedSubject(clip, ...stretch);
    const detected = marked ? null : subjectsIn(clip.subjectSamples, ...stretch);
    const focus = marked?.center ?? faceCenter(clip, ...stretch) ?? detected?.face ?? null;
    let partner = null;
    if (clip.kind === "screen" && camera.length) {
      // The camera shot behind a screen: the camera clip's best moment not used yet, or its first.
      const partnerClip = camera[(shot.n + seed) % camera.length];
      const partnerMoment = moments.find((moment) => moment.clip === partnerClip.key && moment.kind === "visual" && !used.has(moment)) ?? { in: Math.min(partnerClip.duration - (shot.end - shot.start), 1) };
      used.add(partnerMoment);
      partner = { clip: partnerClip, in: round3(Math.max(0, partnerMoment.in)), focus: faceCenter(partnerClip, partnerMoment.in, partnerMoment.in + 2) };
    }
    shot.layout = shotLayout(clip, frame, { focus, subject: marked?.box ?? null, salient: focus ? null : detected?.salient ?? null, partner, side, zoom: 1, captions: shot.speech || Boolean(voice) });
    if (partner) shot.layout.partner = { ...shot.layout.partner, clip: partner.clip.key, in: partner.in };
    if (shot.layout.kind !== "fill") side = 1 - side;
    shot.focus = focus;
  }
  // What the footage measured over a shot's stretch of its clip.
  const measuredIn = (shot, field) => samplesIn(byKey.get(shot.clip), shot.in, shot.in + (shot.end - shot.start)).map((sample) => sample[field]).filter(Number.isFinite);
  const mean = (list) => (list.length ? sum(list) / list.length : null);
  // -1 or 1 when the picture measurably moves left or right (sample dx, frame widths a second), else null.
  const sideways = (shot) => {
    const dx = mean(measuredIn(shot, "dx"));
    return dx !== null && Math.abs(dx) >= 0.02 ? Math.sign(dx) : null;
  };
  // A flash's peak opacity: at most `most`, lower on a dark shot (0.3 over its mean brightness).
  const flashPeak = (shot, most) => {
    const luma = shot ? mean(measuredIn(shot, "luma")) : null;
    return luma === null ? most : round3(Math.min(most, 0.3 + luma));
  };
  // The song's real drop (DROP_HIT_RISE or more): the one place a loud accent may land, on its
  // beat, sized by how far the song rises (dropSize 0 at 6 dB to 1 at 12 dB or more).
  const realDrop = Boolean(beats) && musicPlan?.drop !== null && musicPlan?.drop !== undefined && musicPlan.rise >= DROP_HIT_RISE;
  const landing = realDrop ? dropCut(musicPlan.drop) : null;
  const dropSize = realDrop ? Math.min(1, (musicPlan.rise - DROP_HIT_RISE) / 6) : 0;
  const onDrop = (time) => landing !== null && Math.abs(time - landing) <= SEAM;
  const kinds = style.transitions;
  let previous = null;
  shots.forEach((shot, index) => {
    if (index === 0) return;
    // The hook hands over to the title; the title move reveals its shot.
    if (index === 1) { shot.transition = { kind: titleKind === "push-through-type" ? "title" : "cut", at: shot.start }; return; }
    let kind = "cut";
    // The end card's shot comes in on a cut: its words enter just after it.
    if (rng.next() < style.density && shot.role !== "end") {
      const weights = kinds.map((name, place) => ({ name, weight: (name === previous ? 0.2 : 1) * (place === 0 ? 3 : place === 1 ? 2 : 1) }));
      const total = sum(weights.map((entry) => entry.weight));
      let point = rng.next() * total;
      kind = weights.find((entry) => (point -= entry.weight) <= 0)?.name ?? kinds[0];
    }
    // A flash or a glitch only on a cut on the song's real drop; anywhere else it is a plain cut.
    if (LOUD_TRANSITIONS.includes(kind) && !onDrop(shot.start)) kind = "cut";
    // With a song shape the kind follows the music's texture: a soft one (dissolve) only on a
    // smooth passage, where a moving one (whip, zoom, push, wipe) softens to a dissolve; a seam
    // in a driven section changes on the frame, by a plain cut.
    if (song && kind !== "cut" && !LOUD_TRANSITIONS.includes(kind)) {
      const smooth = sectionAt(shot.start)?.smooth;
      if (smooth && !SOFT_TRANSITIONS.includes(kind)) kind = "dissolve";
      else if (!smooth && (SOFT_TRANSITIONS.includes(kind) || onSeam(shot.start))) kind = "cut";
    }
    // A loose shot (a card and its blurred copy as separate layers) changes by fades only.
    if ((shot.layout.loose || shots[index - 1].layout.loose) && (MOVE_TRANSITIONS[kind] || kind === "push-transition")) kind = "dissolve";
    // A cut snapped onto a footage impact, and every cut of a burst (to its resolving hit), changes
    // on the frame: a transition's lead or overlap would cover the impact frame or the hit.
    if (shots[index - 1].impact || (burst && shot.start >= burst.from - SEAM && shot.start <= burst.to + SEAM)) kind = "cut";
    // A transition never cuts into a word: it needs room on both shots.
    const room = Math.min(shot.end - shot.start, shots[index - 1].end - shots[index - 1].start);
    if (kind !== "cut" && room < (TRANSITION_LENGTH[kind] ?? 0) * 1.25 + 0.4) kind = "cut";
    // Each use of a kind runs a little longer or shorter, so repeats never share one timing.
    const uses = shots.slice(0, index).filter((entry) => entry.transition?.kind === kind).length;
    const length = kind === "cut" ? 0 : round3((TRANSITION_LENGTH[kind] ?? 0) * [1, 1.15, 0.88, 1.25, 0.94][uses % 5]);
    shot.transition = { kind, at: shot.start, length, ...(MOVE_TRANSITIONS[kind] ? { move: MOVE_TRANSITIONS[kind] } : {}) };
    // A push travels the way the incoming footage moves (measured), else always the same way.
    if (kind === "push-transition") shot.transition.direction = sideways(shot) ?? -1;
    // A flash is as strong as the drop and no brighter than the leaving shot can take (a white
    // frame over a dark shot is the biggest jump there is).
    if (kind === "flash") shot.transition.peak = flashPeak(shots[index - 1], round3(0.5 + 0.4 * dropSize));
    if (kind !== "cut") previous = kind;
  });
  let cameraTurn = Math.floor(rng.next() * style.camera.length);
  for (const shot of shots) {
    const clip = byKey.get(shot.clip);
    const moving = (shot.moment.motion ?? 0) > 0.3;
    let kind = style.camera[cameraTurn % style.camera.length];
    cameraTurn += 1;
    if (kind === "parallax" && shot.layout.kind === "fill") kind = "drift";
    shot.camera = { kind, amount: moving ? 0.03 : 0.06, direction: rng.next() < 0.5 ? -1 : 1 };
    if (clip.kind === "screen") shot.camera.amount = 0.03;
  }

  // ---- speed: only from the deck ---------------------------------------------------------------
  if (style.speedRamp) {
    const candidate = shots.find((shot) => !shot.speech && shot.role === "body" && shot.end - shot.start >= 2 && (shot.moment.motion ?? 0) > 0.05 && shot.layout.kind === "fill");
    // Slow motion holds frames; only footage measured at one frame per drawing blends them.
    if (candidate) candidate.ramp = { at: round3(candidate.start + (candidate.end - candidate.start) * 0.5), to: 0.5, ...(framesPerDrawing(byKey.get(candidate.clip)) === 1 ? { blend: true } : {}) };
  }
  if (style.freeze && shots[0].moment.kind !== "speech") shots[0].freezeAt = round3(Math.max(0.5, shots[0].end - 0.5));

  // ---- a hit on the song's drop only -----------------------------------------------------------
  // A beat number is no reason for an accent: one hit at most, on the beat where the song
  // really drops (realDrop: where the title lands), over a picture with no words, sized by the
  // rise; none when no real drop was measured, or when a flash or glitch cut already marks it.
  const hits = [];
  const dropShot = landing === null ? null : shots.find((shot) => shot.role === "body" && !shot.speech && landing >= shot.start - SEAM && landing <= shot.end - 0.5) ?? null;
  const dropAt = dropShot ? round3(Math.max(dropShot.start, landing)) : null;
  const dropMarked = dropShot && onDrop(dropShot.start) && LOUD_TRANSITIONS.includes(dropShot.transition?.kind);
  // An rgb-split's strength (0.25 to 0.45) and a flash's peak (0.5 to 0.85) follow the rise.
  const hitOf = (kind) => ({ at: dropAt, shot: dropShot.n, kind, ...(kind === "flash" ? { peak: flashPeak(dropShot, round3(0.5 + 0.35 * dropSize)) } : { strength: round3(0.25 + 0.2 * dropSize) }) });
  if (style.hits.length && dropShot && !dropMarked) hits.push(hitOf(style.hits[0]));

  // ---- words on screen -------------------------------------------------------------------------
  const captions = [];
  for (const shot of shots) {
    if (!shot.speech) continue;
    const words = shot.moment.words.filter((word) => word.start >= shot.in - 0.05 && word.end <= shot.moment.out + 0.05)
      .map((word) => ({ text: word.text, at: round3(shot.start + word.start - shot.in), end: round3(shot.start + word.end - shot.in) }));
    if (words.length) captions.push({ shot: shot.n, energy: style.captions, words, until: round3(shot.end - 0.05) });
  }
  let voicePlan = null;
  if (voice) {
    voicePlan = { src: voice.src, start: 0.4, duration: voice.duration };
    const words = (voice.words ?? []).filter((word) => !word.unclear).map((word) => ({ text: word.text, at: round3(0.4 + word.start), end: round3(0.4 + word.end) }))
      .filter((word) => word.end <= duration - END_CARD + 0.5);
    if (words.length) captions.push({ voice: true, energy: style.captions, words });
  }
  const titleText = input.title;
  // Never a random slam: the seed's old slam slot (1 in 4) rises instead, so the other picks stay as they were.
  // The treatment's (or the deck's type card's) own reveal when it names one; else the seed's pick.
  const picked = ["rise", "lines", "fade-up", "rise"][Math.floor(rng.next() * 4)];
  const title = titleText ? { kind: titleKind, text: titleText, at: round3(titleAt), dur: titleLength, over: shots[1]?.n ?? null, enter: TITLE_ENTERS.includes(style.title) ? style.title : picked } : null;
  if (title && !shots[1]) title.kind = "headline";
  const endCard = { at: round3(bodyEnd + 0.2), text: titleText ?? input.end ?? null, sub: input.end && titleText ? input.end : null };

  // ---- accents on the downbeats (pace.js) --------------------------------------------------------
  // A zoom punch on each downbeat, cut or not: every other bar in the calm open, every bar in the
  // ending (the last phrase, else the last third), none under words, the title or a designed transition.
  let accentCount = 0;
  if (accents && beats) {
    const downbeats = [];
    for (let index = beats.index(0, { up: true }); beats.at(index) < bodyEnd; index += 1) if (beats.isDownbeat(index)) downbeats.push(beats.at(index));
    const quiet = captions.flatMap((caption) => caption.words.map((word) => ({ start: word.at, end: word.end })));
    if (title) quiet.push({ start: title.at, end: title.at + title.dur });
    for (const shot of shots) if (shot.transition && !["cut", "title"].includes(shot.transition.kind)) quiet.push({ start: shot.start - shot.transition.length, end: shot.start + shot.transition.length });
    const ending = phrases?.length > 1 && runFrom !== null ? beats.at(runFrom + phrases.at(-1).from) : round3(bodyEnd - (bodyEnd - titleAt) / 3);
    for (const at of accentTimes(downbeats, { from: titleAt, to: bodyEnd - 0.2, ending, quiet })) {
      const shot = shots.find((entry) => at >= entry.start - 1e-6 && at < entry.end - 0.15);
      // A loose card and its blurred copy are two layers: no single picture to punch.
      if (!shot || shot.layout.loose) continue;
      (shot.accents ??= []).push(at);
      accentCount += 1;
      // A slow push scales the same picture; a drift holds one scale the accent can punch from.
      if (shot.layout.kind === "fill" && shot.camera.kind !== "drift") shot.camera.kind = "drift";
    }
  }

  // ---- sound levels ----------------------------------------------------------------------------
  const heard = shots.filter((shot) => shot.speech).map((shot) => byKey.get(shot.clip).sound?.loud).filter(Number.isFinite);
  const speechTarget = voice?.loud ?? (heard.length ? Math.min(...heard) : null);
  for (const shot of shots) {
    const sound = byKey.get(shot.clip).sound;
    if (shot.speech && sound) shot.volume = Math.round(gainTo(sound.loud ?? speechTarget, speechTarget ?? sound.loud ?? -20) * 100) / 100;
  }
  if (musicPlan) {
    // Music alone sits 3 dB under the speech level (or at a set level), and dips 11 dB under speech.
    const alone = speechTarget !== null ? speechTarget - 3 : -18;
    musicPlan.volume = Math.round(gainTo(music.loud ?? -14, alone) * 100) / 100;
    musicPlan.under = Math.round(musicPlan.volume * 0.28 * 100) / 100;
    musicPlan.end = duration;
  }

  // ---- the set piece from the deck --------------------------------------------------------------
  let setPiece = null;
  if (style.setPiece === "tile-ring") {
    const host = [...shots].reverse().find((shot) => shot.role === "body" && !shot.speech && shot.layout.kind === "fill" && shot.end - shot.start >= 2.4 && shot.end <= bodyEnd + 1e-6);
    if (host) setPiece = { name: "tile-ring", shot: host.n, at: round3(host.start + 0.3), dur: round3(Math.min(3.2, host.end - host.start - 0.3)) };
  } else if (style.setPiece === "rgb-split-hit" && !hits.length && dropShot && !dropMarked) {
    // A color split only on the song's real drop, never on a fixed shot.
    hits.push(hitOf("rgb-split"));
    setPiece = { name: "rgb-split-hit", shot: dropShot.n, at: dropAt };
  }

  // ---- the deck's other cards as made graphics (cards.js) ---------------------------------------
  // The cards editStyle did not build, the set piece the plan did not, then compose {cards}; none with cards:false.
  const handled = new Set([...style.cardsUsed, ...(setPiece ? [setPiece.name] : []), "tile-ring", "rgb-split-hit"]);
  const dealt = [...(deck?.cards ?? []).map((card) => card.tag), ...(deck?.setPiece ? [deck.setPiece.name] : [])].filter((card) => !handled.has(card));
  const wanted = input.cards === false ? [] : [...dealt, ...(Array.isArray(input.cards) ? input.cards : [])];
  const gap = input.cardGap ?? (accents ? CARD_GAP / 2 : CARD_GAP);
  const cards = wanted.length ? placeCards({ shots, title, endCard, song: song ? { sections: song.sections } : null }, wanted, { drop: dropAt, gap }) : null;

  // ---- the plan in words -----------------------------------------------------------------------
  const describe = (shot) => {
    const clip = byKey.get(shot.clip);
    return `${shot.start}-${shot.end} s ${clip.name} ${shot.in}-${round3(shot.in + shot.end - shot.start)} s (${shot.layout.kind}${shot.speech ? `, says "${shot.moment.text.slice(0, 48)}"` : `, ${shot.moment.why}`}; score ${shot.moment.score}: hook ${shot.moment.hook}, flow ${shot.moment.flow}, value ${shot.moment.value})${shot.transition && !["cut", "title"].includes(shot.transition.kind) ? ` in by ${shot.transition.kind}` : ""}`;
  };
  lines.push(`treatment ${treatment}: ${style.line}; ${duration} s${musicPlan ? `, music from ${musicPlan.offset} s${musicPlan.bpm ? ` at ${musicPlan.bpm} BPM` : ""}${musicPlan.drop !== null ? `, its drop at ${musicPlan.drop} s (${musicPlan.rise} dB up${realDrop ? "" : ", too small for a hit"})` : ""}` : ", no music"}`);
  lines.push(`opens on: ${opening.kind === "speech" ? `"${opening.text.slice(0, 60)}"` : opening.why} (hook ${opening.hook})`);
  for (const shot of shots) lines.push(`shot ${shot.n}: ${describe(shot)}`);
  if (title) lines.push(`title "${title.text}" (${title.kind}) at ${title.at} s`);
  lines.push(`end card at ${endCard.at} s${endCard.text ? `: "${endCard.text}"` : ""}`);
  if (deck) lines.push(`deck ${deck.seed}: builds ${style.cardsUsed.join(", ") || "none of its cards"}${style.setPiece ? `; set piece ${style.setPiece}${setPiece ? "" : " (no shot fits it; left out)"}` : ""}`);
  lines.push(...cardLines(cards));
  const left = moments.filter((moment) => !used.has(moment)).length;
  lines.push(`moments: ${moments.length} over the bar (${KEEP_BAR}), ${shots.length} used, ${left} left out`);

  let runs = null;
  if (paced) {
    runs = runsOf(shots.filter((shot) => shot.role === "body" && !shot.speech).slice(1).map((shot) => shot.end - shot.start), beat);
    // With a song shape the sections set the cuts; the pace only scales their ranges (the song line).
    lines.push(`${song ? `${pace} pace over the song's sections: their beat ranges x${songScale}` : PACES[pace].line}; runs ${runs.map((run) => `${run.count}x${run.beats ?? "?"}`).join(", ")} beats; ${accentCount} downbeat accents`);
  } else if (accents) lines.push(`${accentCount} downbeat accents`);
  let songPlan = null;
  if (song) {
    // The seams in the cut body, and which ones a cut landed on (within a frame).
    const inBody = song.seams.filter((seam) => seam.at > titleAt + 1e-6 && seam.at <= bodyEnd + 1e-6);
    const locked = inBody.filter((seam) => shots.some((shot) => shot.n > 1 && Math.abs(shot.start - seam.at) <= SEAM));
    songPlan = { seams: inBody, locked, rests: song.rests, sections: song.sections.filter((part) => part.to > titleAt && part.from < bodyEnd) };
    const held = shots.filter((shot) => shot.role === "body" && shot.freezeAt !== undefined).length;
    lines.push(`song seams: cuts on ${locked.length} of ${inBody.length}${locked.length ? ` (${locked.map((seam) => `${seam.kind} ${seam.at}`).join(", ")})` : ""}; sections ${songPlan.sections.map((part) => `${part.kind} ${part.beats[0]}-${part.beats[1]} beats a shot${part.smooth ? " smooth" : ""}`).join(", ")}${song.rests.length ? `; held through ${song.rests.length} rest${song.rests.length > 1 ? "s" : ""} to the return` : ""}${held ? `; ${held} shot${held > 1 ? "s" : ""} hold${held > 1 ? "" : "s"} its clip's last frame to the cut` : ""}`);
    if (burst) lines.push(`burst ${round3(burst.from)}-${round3(burst.to)} s: ${burst.cuts.length + 1} shots on the hits of a dense passage (${burst.density} hits a beat)`);
    if (snaps.length) lines.push(`cuts on footage impacts: ${snaps.length}${snaps.length > 4 ? ", the first 4" : ""} (${snaps.slice(0, 4).map((snap) => `shot ${snap.shot} ${snap.at} s (impact on the hit at ${snap.hit} s${snap.early ? `, ${snap.early} frames early` : ""})`).join(", ")})`);
  }

  return { duration, treatment, style, frame, music: musicPlan, voice: voicePlan, shots, captions, title, endCard, hits, setPiece, cards, words: lines, opening: opening.kind, pace, runs, song: songPlan, burst, snaps };
}
