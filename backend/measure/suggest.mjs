// Suggested style lines from a reference's fingerprint (fingerprint.mjs) and cut numbers
// (inspire.mjs measureNumbers): 3 to 6 short lines an agent can put in the brief's style spec,
// each with the reference time it came from and the technique tags it maps to (PLAN.md vocabulary).
//
// They are guesses: numbers cannot see design. The agent confirms each one by looking at the frame
// strips around that time (look {mode:"reference", ref, t}) before it writes it into the brief.
import { FAST_ZOOM, WHIP_SPEED } from "./fingerprint.mjs";

const percent = (value) => `${Math.round(value * 100)}%`;
const times = (list = [], count = 3) => list.slice(0, count).map((time) => `${Number(time).toFixed(1)} s`).join(", ");

const REVEALS = {
  whole: { words: "whole lines appear at once", tags: ["type-cut"] },
  words: { words: "words appear one or a few at a time", tags: ["type-words"] },
  letters: { words: "letters appear one by one", tags: ["type-letters"] },
  slides: { words: "lines slide in", tags: ["type-slide"] },
  grows: { words: "type grows in", tags: ["type-pop"] },
};

/**
 * The suggested lines: [{text, ref, at, tags, guess: true}] (the brief's style line shape plus
 * tags), most telling first. `numbers` is the reference's cut numbers (cuts, cutsPerSecond,
 * onBeat), or null; `ref` its id (yt:…).
 */
export function suggestStyleLines(fp, numbers = null, ref = undefined) {
  if (!fp) return [];
  const lines = [];
  const add = (score, text, at, tags = []) => lines.push({ score, text, at: Number.isFinite(at) ? Math.round(at * 10) / 10 : undefined, tags });

  const camera = fp.camera, motion = fp.motion;
  if (camera && camera.moving >= 0.35) {
    const kinds = [["zoom-in", camera.zoomIn], ["zoom-out", camera.zoomOut], ["pan", camera.pan], ["rotate", camera.rotate]].sort((a, b) => b[1] - a[1]);
    const [kind] = kinds[0];
    const example = camera.examples?.[kind] ?? [];
    let phrase, tags;
    if (kind === "zoom-in") [phrase, tags] = camera.zoomSpeed < FAST_ZOOM ? ["slow push-ins", ["slow-push"]] : ["fast push-ins", ["zoom-through"]];
    else if (kind === "zoom-out") [phrase, tags] = ["pull-backs", ["drift"]];
    else if (kind === "pan") [phrase, tags] = camera.panSpeed >= WHIP_SPEED ? ["whip pans", ["whip-pan"]] : ["sideways drifts", ["drift"]];
    else [phrase, tags] = ["turns", ["orbit-3d"]];
    const shake = camera.shaky >= 0.4 ? "; often shaky (handheld)" : "";
    add(0.9, `camera moves ${percent(camera.moving)} of the time; mostly ${phrase}${example.length ? ` (${times(example)})` : ""}${shake}`, example[0], camera.shaky >= 0.4 ? [...tags, "shake"] : tags);
  } else if (motion && motion.stillShare >= 0.4) {
    add(0.8, `the picture holds still ${percent(motion.stillShare)} of the time (longest ${motion.longestStill.seconds} s at ${Number(motion.longestStill.at ?? 0).toFixed(1)} s)`, motion.longestStill.at, ["hold"]);
  }

  const text = fp.text;
  if (text && (text.share >= 0.3 || text.bigShare >= 0.2)) {
    const casing = text.lowercase == null ? "" : text.lowercase >= 0.7 ? `lowercase (${percent(text.lowercase)}) ` : text.lowercase <= 0.3 ? "capitals " : "";
    // Words that come in a few at a time are the telling style even when whole lines are more
    // common (interface text counts as whole lines too).
    const total = text.counts ? Object.values(text.counts).reduce((sum, value) => sum + value, 0) : 0;
    const style = total && text.counts.words / total >= 0.25 ? "words" : text.dominant;
    const reveal = style ? REVEALS[style] : null;
    const example = reveal ? text.examples?.[style] ?? [] : [];
    add(0.85, `${casing}text on screen ${percent(text.share)} of the time${reveal ? `; ${reveal.words}${example.length ? ` (${times(example)})` : ""}` : ""}`, example[0], reveal?.tags ?? []);
  } else if (text) {
    add(0.6, `little text: on screen ${percent(text.share)} of the time`, undefined, []);
  }

  const transitions = fp.transitions;
  if (transitions) {
    if (transitions.blurDips.length >= 2) add(0.75, `blur dips between pictures, ${transitions.blurDips.length} in all (${times(transitions.blurDips)})`, transitions.blurDips[0], ["blur-through"]);
    if (transitions.dissolves.length >= 2) add(0.7, `dissolves, ${transitions.dissolves.length} in all (${times(transitions.dissolves)})`, transitions.dissolves[0], ["dissolve"]);
    if (transitions.fades.length >= 1) add(0.55, `fades through black (${times(transitions.fades)})`, transitions.fades[0], ["fade-black"]);
    if (!transitions.blurDips.length && !transitions.dissolves.length && !transitions.fades.length && numbers?.cuts?.length) add(0.6, `hard cuts only: ${numbers.cuts.length} cuts, no blur dips, dissolves or fades`, numbers.cuts[0], ["cut"]);
  }

  for (const element of (fp.persistent ?? []).slice(0, 1)) {
    const where = `${element.box[1] > 0.6 ? "bottom" : element.box[1] < 0.25 ? "top" : "middle"} ${element.box[0] < 0.33 ? "left" : element.box[0] > 0.6 ? "right" : "center"}`;
    add(0.65, `${element.kind === "text" ? `"${element.text}"` : "an element"} stays in place at the ${where} across cuts (${percent(element.share)})`, undefined, ["status-line"]);
  }

  if (numbers?.cuts?.length >= 3) {
    const onBeat = numbers.onBeat ? numbers.onBeatCount / numbers.cuts.length : null;
    const every = numbers.cutsPerSecond > 0 ? 1 / numbers.cutsPerSecond : null;
    if (every) add(onBeat >= 0.6 ? 0.6 : 0.45, `a cut every ${every.toFixed(1)} s on average${onBeat != null ? `; ${numbers.onBeatCount} of ${numbers.cuts.length} on the beat` : ""}`, numbers.cuts[0], onBeat >= 0.6 ? ["beat-cut"] : []);
  }

  if (fp.handoff && fp.handoff.cuts >= 4 && fp.handoff.inMotion / fp.handoff.cuts >= 0.5) {
    add(0.4, `cuts land mid-motion (${fp.handoff.inMotion} of ${fp.handoff.cuts})`, undefined, []);
  }

  if (fp.look && fp.look.brightness != null && (fp.look.brightness < 0.15 || fp.look.brightness > 0.7)) {
    add(0.35, `${fp.look.brightness < 0.15 ? "dark" : "bright"} picture (brightness ${fp.look.brightness}); palette ${fp.look.palette.slice(0, 3).map((entry) => entry.hex).join(" ")}`, undefined, []);
  }

  return lines.sort((a, b) => b.score - a.score).slice(0, 6).map(({ score, ...line }) => ({ text: line.text, ...(ref ? { ref } : {}), ...(line.at != null ? { at: line.at } : {}), tags: line.tags, guess: true }));
}

/**
 * The line that asks for the reference's type, or null when it shows little text. Numbers give the
 * case, the size share and how lines appear; the family class (serif, sans, mono, script) is only
 * seen, so the agent reads it off the text strips and saves one style line with its time.
 */
export function typeNote(fp, refId) {
  const text = fp?.text;
  if (!text || (text.share < 0.1 && text.bigShare < 0.1)) return null;
  const examples = [...new Set(Object.values(text.examples ?? {}).flat())].sort((a, b) => a - b);
  const case_ = text.lowercase == null ? "case" : text.lowercase >= 0.7 ? "case (mostly lowercase)" : text.lowercase <= 0.3 ? "case (mostly capitals)" : "case (mixed)";
  return `type to note (the family class is not measured): look at the text strips${examples.length ? ` (${times(examples)})` : ""}, then save a style line "type: <family class (serif, sans, mono, script), size (big type ${percent(text.bigShare ?? 0)} of the time), ${case_}, how it appears>" with ref "${refId}" and its time in at, such as "small serif, lowercase, each word cut on".`;
}

/** The lines as text for an agent, one a line with their tags. */
export function suggestionText(lines, refId) {
  if (!lines.length) return null;
  return [`suggested style lines (guesses from numbers: look at the strips first, look {mode:"reference", ref:"${refId}", t}; keep the ones you confirm in the brief's style, with ref and at):`,
    ...lines.map((line) => `- ${line.text}${line.tags.length ? ` [${line.tags.join(", ")}]` : ""}`)].join("\n");
}
