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
import { barAtOrAfter, beatGrid, editBeats } from "./cuts.js";
import { faceCenter, KEEP_BAR, markedSubject, openingMoment, rankMoments, samplesIn } from "./moments.js";
import { isScreenRecording, shapeOf, shotLayout } from "./layout.js";
import { editStyle } from "./treatments.js";
import { accentTimes, PACES, phrasePlan, rateAt, runsOf } from "./pace.js";
import { round as round3 } from "../numbers.js";

const sum = (list) => list.reduce((total, value) => total + value, 0);
export const END_CARD = 2.8;
// How long each title takes, in seconds (push-through-type needs at least 1.8).
const TITLE_LENGTH = { "push-through-type": 2.4, headline: 2.4 };
// Without music, a "beat" is this long, so the treatments' shot lengths still mean something.
const FREE_BEAT = 0.6;
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
// A rise this big (dB, 4 s against the 4 s before) is a real drop: enough to motivate a hit. A
// smaller rise (a steady song's wobble, a gentle swell) still places the music, never an accent.
export const DROP_HIT_RISE = 6;

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

/** Gain (0 to 1) that brings a sound measured at `loud` dB to `target` dB, at most 1. */
const gainTo = (loud, target) => Math.min(1, Math.max(0.08, 10 ** ((target - loud) / 20)));

/**
 * Plans an edit. `input`:
 *   clips     [{key, name, src, kind, width, height, duration, in, out, words, samples, shots, sound}]
 *             (sound: {src, own, duration, loud} when the clip is heard, own: its own track)
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
    const measured = dropTime(music.curve);
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
    // A shot never runs past its clip's end.
    const room = roomOf(moment);
    if (length > room && paced) {
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
    const landing = beats.nearest(musicPlan.drop);
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
  // need: seconds the shot should play; a moment with that much room comes first.
  const nextPicture = (need = 0) => {
    for (const room of need > 0 ? [need, beat, 0] : [0]) {
      for (let tries = 0; tries < pools.length; tries += 1) {
        const pool = pools[(turn + tries) % pools.length];
        const found = pool.find((moment) => !used.has(moment) && roomOf(moment) >= room - 1e-6);
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
  // The title plays over a picture (words under it would collide), so the body opens on one.
  let lastSpeech = true;
  const queue = [...speechChosen];
  while (t < bodyEnd - (paced ? 0.05 : 0.6)) {
    let moment;
    const first = t === titleAt;
    if (queue.length && !first && (!lastSpeech || !pools.some((pool) => pool.some((entry) => !used.has(entry))))) moment = queue.shift();
    else if (first) {
      // The title's picture: the best unused one with room for the whole title.
      const need = titleLength + Math.max(beat, 0.8);
      moment = moments.filter((entry) => entry.kind === "visual" && !used.has(entry) && roomOf(entry) >= need).sort((a, b) => b.score - a.score)[0] ?? nextPicture();
    } else moment = nextPicture(paced ? plannedEnd(t) - t : 0) ?? queue.shift() ?? null;
    if (first && moment && moment.kind === "visual") {
      // Long enough to carry the title and land one beat after it; with a pace, the hero hold
      // lasts PACES[pace].hero seconds at most.
      let end = onBeat(t + titleLength + Math.max(beat, 0.8));
      if (paced && end - t > PACES[pace].hero + 1e-6) end = beats.at(beatOf(t + PACES[pace].hero) - (beats.at(beatOf(t + PACES[pace].hero)) > t + PACES[pace].hero + 1e-6 ? 1 : 0));
      addShot(moment, t, Math.min(end, bodyEnd), { role: "body" });
      t = shots.at(-1).end;
      lastSpeech = false;
      continue;
    }
    if (!moment) {
      // Out of new moments: the clips' best moments again, a second look.
      const again = moments.filter((entry) => entry.kind === "visual").sort((a, b) => b.score - a.score)[shots.length % Math.max(1, moments.length)];
      if (!again) break;
      moment = { ...again, in: round3(Math.min(clipEnd(byKey.get(again.clip)) - 1, again.in + 0.5)) };
    }
    const speech = moment.kind === "speech" && !voice;
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
  if (shots.at(-1).end > bodyEnd - 0.05 || paced) shots.at(-1).end = bodyEnd;
  addShot({ ...endMoment, kind: "visual", until: undefined }, bodyEnd, duration, { role: "end" });
  const last = shots.at(-1);
  if (last.end < duration - 1e-6) {
    // Not enough of that clip: a still of its last frame holds (the end card covers it).
    last.freezeAt = last.end;
    last.end = duration;
  }

  // ---- layouts, camera, transitions -----------------------------------------------------------
  // A camera shot behind a screen recording fills the frame: same shape as the frame.
  const camera = clips.filter((clip) => clip.kind === "camera" && shapeOf(clip.width, clip.height) === shapeOf(frame.width, frame.height));
  let side = rng.next() < 0.5 ? 0 : 1;
  for (const shot of shots) {
    const clip = byKey.get(shot.clip);
    // A subject the agent marked leads; else the faces measured.
    const marked = markedSubject(clip, shot.in, shot.in + (shot.end - shot.start));
    const focus = marked?.center ?? faceCenter(clip, shot.in, shot.in + (shot.end - shot.start));
    let partner = null;
    if (clip.kind === "screen" && camera.length) {
      // The camera shot behind a screen: the camera clip's best moment not used yet, or its first.
      const partnerClip = camera[(shot.n + seed) % camera.length];
      const partnerMoment = moments.find((moment) => moment.clip === partnerClip.key && moment.kind === "visual" && !used.has(moment)) ?? { in: Math.min(partnerClip.duration - (shot.end - shot.start), 1) };
      used.add(partnerMoment);
      partner = { clip: partnerClip, in: round3(Math.max(0, partnerMoment.in)), focus: faceCenter(partnerClip, partnerMoment.in, partnerMoment.in + 2) };
    }
    shot.layout = shotLayout(clip, frame, { focus, subject: marked?.box ?? null, partner, side, zoom: 1, captions: shot.speech || Boolean(voice) });
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
  const landing = realDrop ? beats.nearest(musicPlan.drop) : null;
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
    // A loose shot (a card and its blurred copy as separate layers) changes by fades only.
    if ((shot.layout.loose || shots[index - 1].layout.loose) && (MOVE_TRANSITIONS[kind] || kind === "push-transition")) kind = "dissolve";
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
    if (candidate) candidate.ramp = { at: round3(candidate.start + (candidate.end - candidate.start) * 0.5), to: 0.5, ...(byKey.get(candidate.clip).framesPerDrawing === 1 ? { blend: true } : {}) };
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
  const title = titleText ? { kind: titleKind, text: titleText, at: round3(titleAt), dur: titleLength, over: shots[1]?.n ?? null, enter: ["rise", "lines", "fade-up", "rise"][Math.floor(rng.next() * 4)] } : null;
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
  const left = moments.filter((moment) => !used.has(moment)).length;
  lines.push(`moments: ${moments.length} over the bar (${KEEP_BAR}), ${shots.length} used, ${left} left out`);

  let runs = null;
  if (paced) {
    runs = runsOf(shots.filter((shot) => shot.role === "body" && !shot.speech).slice(1).map((shot) => shot.end - shot.start), beat);
    lines.push(`${PACES[pace].line}; runs ${runs.map((run) => `${run.count}x${run.beats ?? "?"}`).join(", ")} beats; ${accentCount} downbeat accents`);
  } else if (accents) lines.push(`${accentCount} downbeat accents`);

  return { duration, treatment, style, frame, music: musicPlan, voice: voicePlan, shots, captions, title, endCard, hits, setPiece, words: lines, opening: opening.kind, pace, runs };
}
