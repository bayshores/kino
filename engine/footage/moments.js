// Which stretches of the footage are worth showing (compose {footage}). Each candidate gets three
// scores from 0 to 100, like a clip ranker's virality score, and their mix:
//   hook   would it stop a scroll: a question, a strong claim, a number, a face, a burst of motion
//   flow   does it play as a whole: a complete sentence that starts and ends in a pause, a steady
//          shot with no cut inside, not dark, not frozen
//   value  does it carry the video's subject: its topic words (said more than once), a face, text
//          on a screen, a good length
// Speech moments are sentences of the transcript; visual moments are windows inside a shot.
// Moments under KEEP_BAR are left out unless the edit runs short.
import { isFiller, sentences, speechSpan } from "./cuts.js";

export const KEEP_BAR = 45;
const STOP = new Set("a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its just like me my no not now of on or our out so some than that the their them then there these they this to too up us was we were what when where which who why will with would you your yeah okay oh well also very really get got go going gonna one two".split(" "));
const HOOK_WORDS = /\b(best|worst|never|always|first|only|secret|finally|insane|crazy|lowkey|literally|imagine|free|win|won|winner|biggest|fastest|easiest|proof|truth|mistake|why|how)\b/i;
// Swearing stays out of the picks (it can still be heard in a shot kept for its picture).
const SWEARING = /\b(fuck\w*|shit\w*|bitch\w*|damn|ass|asshole|bastard|crap|dick|piss\w*|cunt|motherfuck\w*|wtf)\b/i;
export const isSwearing = (text) => SWEARING.test(String(text ?? ""));
const round = (value) => Math.round(value);
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const words = (text) => String(text).toLowerCase().match(/[a-z0-9']+/g) ?? [];

/** Words said at least twice across every transcript, without small words: the topic. */
export function topicWords(transcripts) {
  const counts = new Map();
  for (const list of transcripts) for (const word of list ?? []) for (const token of words(word.text)) {
    if (token.length < 4 || STOP.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count >= 2).map(([token]) => token));
}

// The measured samples of a clip between two file times.
const samplesIn = (clip, from, to) => (clip.samples ?? []).filter((sample) => sample.t >= from - 1e-6 && sample.t <= to + 1e-6);
const measuredFaces = (list) => list.filter((sample) => Array.isArray(sample.faces));
// A face counts when it is at least 0.4% of the frame (a person, not a poster in the back).
const hasFace = (sample) => (sample.faces ?? []).some(([, , w, h]) => w * h >= 0.004);

/** The share (0 to 1) of measured samples in [from, to] that show a face, or null when unknown. */
export function faceShare(clip, from, to) {
  const measured = measuredFaces(samplesIn(clip, from, to));
  if (!measured.length) return null;
  return measured.filter(hasFace).length / measured.length;
}

/**
 * The subject an agent marked (mark_subject) on the clip's file in [from, to], or within half a
 * second of it: {center: [x, y], box: [x, y, w, h]} in fractions of the frame (the box holds
 * every mark there), or null. clip.subjects is [{at, box}] with box in % (backend/agent/blocks.mjs).
 */
export function markedSubject(clip, from, to) {
  const marks = (clip.subjects ?? []).filter((entry) => entry.at >= from - 0.5 && entry.at <= to + 0.5);
  if (!marks.length) return null;
  const left = Math.min(...marks.map(({ box }) => box[0])) / 100;
  const top = Math.min(...marks.map(({ box }) => box[1])) / 100;
  const right = Math.max(...marks.map(({ box }) => box[0] + box[2])) / 100;
  const bottom = Math.max(...marks.map(({ box }) => box[1] + box[3])) / 100;
  return { center: [(left + right) / 2, (top + bottom) / 2], box: [left, top, right - left, bottom - top] };
}

/** The middle of the faces in [from, to] as [x, y] fractions of the frame, or null. */
export function faceCenter(clip, from, to) {
  const boxes = measuredFaces(samplesIn(clip, from, to)).flatMap((sample) => (sample.faces ?? []).filter(([, , w, h]) => w * h >= 0.004));
  if (!boxes.length) return null;
  // The largest face matters most.
  let x = 0, y = 0, weight = 0;
  for (const [left, top, w, h] of boxes) { const size = w * h; x += (left + w / 2) * size; y += (top + h / 2) * size; weight += size; }
  return [x / weight, y / weight];
}

function speechScores(sentence, clip, topic) {
  const tokens = words(sentence.text);
  const count = tokens.length;
  const fillers = sentence.words.filter((word) => isFiller(word.text)).length;
  let hook = 20;
  if (/\?/.test(sentence.text)) hook += 25;
  if (HOOK_WORDS.test(sentence.text)) hook += 30;
  if (/\d/.test(sentence.text)) hook += 10;
  if (/!/.test(sentence.text)) hook += 10;
  if (count >= 3 && count <= 12) hook += 15;
  let flow = 10;
  if (sentence.complete) flow += 40;
  if (sentence.pauseBefore >= 0.25) flow += 30;
  if (!fillers) flow += 20;
  if (count < 2) flow -= 30;
  const topical = tokens.filter((token) => topic.has(token)).length;
  const face = faceShare(clip, sentence.start, sentence.end);
  const length = sentence.end - sentence.start;
  let value = 15 + Math.min(40, topical * 15);
  if (face !== null) value += 25 * face;
  else value += 10;
  // A line said over a dark picture is worth less: the shot itself shows little.
  const lit = samplesIn(clip, sentence.start, sentence.end);
  if (lit.length && lit.reduce((sum, sample) => sum + sample.luma, 0) / lit.length < 0.15) value -= 20;
  if (length >= 1.2 && length <= 8) value += 20;
  return { hook: clamp(hook, 0, 100), flow: clamp(flow, 0, 100), value: clamp(value, 0, 100), face };
}

/**
 * Speech moments of a clip with a transcript: one per sentence (very short ones join the next).
 * File times `in`/`out` are padded to the silence around the words (speechSpan).
 */
export function speechMoments(clip, topic) {
  if (!clip.words?.length) return [];
  const all = clip.words.filter((word) => !word.unclear);
  const found = [];
  const list = sentences(all).filter((sentence) => sentence.start >= (clip.in ?? 0) - 1e-6 && sentence.end <= (clip.out ?? Infinity) + 1e-6);
  for (let index = 0; index < list.length; index += 1) {
    let sentence = list[index];
    // A one- or two-word sentence ("Okay.") rides with the next one when it follows closely.
    if (sentence.words.length <= 2 && list[index + 1] && list[index + 1].start - sentence.end < 0.6) {
      const next = list[index + 1];
      sentence = { ...next, start: sentence.start, words: [...sentence.words, ...next.words], text: `${sentence.text} ${next.text}`, pauseBefore: sentence.pauseBefore };
      index += 1;
    }
    if (isSwearing(sentence.text)) continue;
    const scores = speechScores(sentence, clip, topic);
    const span = speechSpan(sentence.words[0], sentence.words.at(-1), all);
    const score = round(0.4 * scores.hook + 0.3 * scores.flow + 0.3 * scores.value);
    found.push({
      clip: clip.key, kind: "speech", in: span.in, out: span.out, text: sentence.text, words: sentence.words,
      hook: round(scores.hook), flow: round(scores.flow), value: round(scores.value), score, face: scores.face,
      why: [scores.hook >= 60 ? "a hook line" : "", sentence.complete ? "a whole sentence" : "", scores.face > 0.5 ? "on a face" : ""].filter(Boolean).join(", ") || "speech",
    });
  }
  return found;
}

function visualScores(clip, from, to, cutInside) {
  const list = samplesIn(clip, from, to);
  if (!list.length) return { hook: 40, flow: 50, value: 45, face: null, dark: false };
  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  const luma = mean(list.map((sample) => sample.luma));
  const motions = list.map((sample) => sample.motion ?? sample.change * 3).filter((value) => Number.isFinite(value));
  const motion = mean(motions);
  const peak = Math.max(0, ...motions);
  const spread = Math.sqrt(mean(motions.map((value) => (value - motion) ** 2)));
  const face = faceShare(clip, from, to);
  const measuredText = list.filter((sample) => Array.isArray(sample.text));
  const textLines = measuredText.length ? mean(measuredText.map((sample) => sample.text.length)) : 0;
  const frozen = mean(list.map((sample) => sample.change)) < 0.003 && motion < 0.01;
  const dark = luma < 0.11;
  let hook = 20 + 45 * clamp(peak / 0.35) + 35 * (face ?? 0);
  let flow = 30 + (cutInside ? 0 : 35) + 20 * clamp(1 - spread / 0.25) + (frozen ? -25 : 15);
  let value = 20 + 35 * (face ?? 0.2) + 20 * clamp(textLines / 4) + (motion > 0.015 && motion < 0.6 ? 20 : 5);
  if (dark) { hook -= 30; flow -= 30; value -= 30; }
  return { hook: clamp(hook, 0, 100), flow: clamp(flow, 0, 100), value: clamp(value, 0, 100), face, dark, motion, textLines };
}

/**
 * Visual moments of a clip: windows of about `length` seconds inside its shots, scored, the best
 * few that do not overlap. A still picture is one moment.
 */
export function visualMoments(clip, { length = 3, most = 8 } = {}) {
  const from = clip.in ?? 0;
  const to = Math.min(clip.out ?? clip.duration, clip.duration);
  if (clip.kind === "picture") return [{ clip: clip.key, kind: "visual", in: 0, out: Math.max(1, to - from), hook: 40, flow: 70, value: 55, score: 55, face: null, why: "a picture" }];
  const shots = (clip.shots?.length ? clip.shots : [{ start: 0, end: clip.duration }])
    .map((shot) => ({ start: Math.max(shot.start, from), end: Math.min(shot.end, to) })).filter((shot) => shot.end - shot.start >= 0.6);
  const windows = [];
  for (const shot of shots) {
    const span = shot.end - shot.start;
    const size = Math.min(length, span);
    const step = Math.max(0.5, size / 2);
    for (let start = shot.start; start + size <= shot.end + 1e-6; start += step) {
      // A window is kept 0.15 s inside its shot, so a cut never shows a frame of the next one.
      const a = start === shot.start ? start + (shot.start > 0 ? 0.15 : 0) : start;
      const b = Math.min(start + size, shot.end - (shot.end < clip.duration - 0.05 ? 0.15 : 0));
      if (b - a < 0.5) continue;
      const scores = visualScores(clip, a, b, false);
      const score = round(0.35 * scores.hook + 0.3 * scores.flow + 0.35 * scores.value);
      windows.push({ clip: clip.key, kind: "visual", in: Math.round(a * 1000) / 1000, out: Math.round(b * 1000) / 1000, until: Math.round((shot.end < clip.duration - 0.05 ? shot.end - 0.15 : shot.end) * 1000) / 1000, hook: round(scores.hook), flow: round(scores.flow), value: round(scores.value), score, face: scores.face, motion: scores.motion ?? 0, textLines: scores.textLines ?? 0, dark: scores.dark,
        why: [scores.face > 0.5 ? "a face" : "", (scores.motion ?? 0) > 0.2 ? "movement" : "", (scores.textLines ?? 0) >= 3 ? "a screen" : ""].filter(Boolean).join(", ") || "a steady shot" });
    }
  }
  // The clip is split into `most` equal parts and each part gives its best window, so the moments
  // come from all through the clip (not all from its best minute); then the best of the rest.
  const usable = windows.filter((window) => !window.dark).sort((a, b) => b.score - a.score || a.in - b.in);
  const kept = [];
  const overlaps = (window) => kept.some((other) => window.in < other.out + 1 && window.out > other.in - 1);
  const part = (to - from) / most;
  for (let index = 0; index < most; index += 1) {
    const best = usable.find((window) => window.in >= from + index * part - 1e-6 && window.in < from + (index + 1) * part && !overlaps(window));
    if (best && best.score >= KEEP_BAR - 10) kept.push(best);
  }
  for (const window of usable) {
    if (kept.length >= most) break;
    if (!overlaps(window)) kept.push(window);
  }
  return kept.sort((a, b) => a.in - b.in);
}

/**
 * Every moment of every clip, scored: speech moments where a clip is heard, visual ones for the
 * rest (and for a clip's quiet parts). Returns {moments, topic} with moments in clip order.
 */
export function rankMoments(clips, { length = 3 } = {}) {
  const topic = topicWords(clips.map((clip) => clip.words));
  const moments = [];
  for (const clip of clips) {
    const speech = speechMoments(clip, topic);
    moments.push(...speech);
    // Visual moments of the parts nobody speaks in.
    const quiet = visualMoments(clip, { length, most: speech.length ? 4 : 8 })
      .filter((moment) => !speech.some((spoken) => moment.in < spoken.out && moment.out > spoken.in));
    moments.push(...quiet);
  }
  return { moments, topic: [...topic] };
}

/**
 * The opening moment: the strongest hook that shows a face or says the hook line (never a dark
 * frame or an empty one). Speech with a face first, then any speech, then a face, then the most
 * movement.
 */
export function openingMoment(moments) {
  const usable = moments.filter((moment) => !moment.dark);
  const best = (list) => list.sort((a, b) => b.hook - a.hook || b.score - a.score)[0] ?? null;
  return best(usable.filter((moment) => moment.kind === "speech" && (moment.face ?? 0) >= 0.3 && moment.hook >= 50))
    ?? best(usable.filter((moment) => moment.kind === "speech" && moment.hook >= 55))
    ?? best(usable.filter((moment) => (moment.face ?? 0) >= 0.5))
    ?? best([...usable]);
}
