// The rules tied to the locked direction (the style spec's spine and rejected list,
// backend/agent/style.mjs): the timeline keeps to the story spine (spine_drift), and text the
// person turned down never comes back on screen (rejected_text). Both read ctx.style
// (engine/styleSpec.js styleContext) and stay silent without a spine or a rejected list.
import { readingTexts, sec } from "../analysis.js";
import { audibleRanges } from "../../videoSound.js";

const GAP = 2; // seconds of timeline no beat covers
const PREMISE_SHARE = 0.15; // the problem beat starts within this share of the runtime
const PREMISE_FLOOR = 3; // or within this many seconds (a short clip still has room for a hook)
const SEEN = 0.05; // opacity that counts as on screen
const SLACK = 0.5; // seconds a used layer may show before its beat starts

const finding = (at, measured, required, message, fix) => ({ rule: "spine_drift", severity: "error", at: sec(at), measured, required, message, fix: { kind: "hint", text: fix } });
const WAIVE = 'or waive_check {code:"spine_drift", target:"*", reason} if the change is on purpose.';

// A media file of that name: the name the library lists ("target.mp4", from ctx.mediaNames),
// with or without its extension, or a src that holds it.
const noExtension = (name) => name.replace(/\.[a-z0-9]{2,4}$/i, "");
function fileNamed(src, wanted, ctx) {
  if (typeof src !== "string") return false;
  const file = String(ctx.mediaNames?.[src] ?? "").toLowerCase();
  return Boolean(file) && (file === wanted || noExtension(file) === noExtension(wanted)) || src.toLowerCase().includes(wanted);
}

// The drawn layers a spine name stands for: layers of that name, the drawn layers of a group of
// that name, or else layers made from a media file of that name. Masks never count.
function layersNamed(model, name, ctx) {
  const wanted = name.toLowerCase();
  const drawn = model.items.filter((item) => item.kind !== "group" && !item.isMask);
  const byId = new Map(model.items.map((item) => [item.id, item]));
  const under = (item, id) => { for (let parent = byId.get(item.parentId); parent; parent = byId.get(parent.parentId)) if (parent.id === id) return true; return false; };
  const groups = model.items.filter((item) => item.kind === "group" && String(item.name ?? "").toLowerCase() === wanted);
  const named = [...drawn.filter((item) => String(item.name ?? "").toLowerCase() === wanted), ...drawn.filter((item) => groups.some((group) => under(item, group.id)))];
  return named.length ? named : drawn.filter((item) => fileNamed(item.src, wanted, ctx) || (typeof item.source === "string" && item.source.toLowerCase().includes(wanted)));
}

// The stretches in which the audio layers a spine name stands for are heard (sound belongs in a
// beat too): audio layers of that name or file, from the raw scene (the model draws no audio).
function soundsNamed(name, ctx) {
  const layers = ctx.scene?.layers ?? [];
  const wanted = name.toLowerCase();
  const sounds = layers.filter((layer) => layer.type === "audio" && !layer.muted && (layer.volume ?? 1) > 0);
  const named = sounds.filter((layer) => String(layer.name ?? "").toLowerCase() === wanted);
  return (named.length ? named : sounds.filter((layer) => fileNamed(layer.src, wanted, ctx)))
    .flatMap((layer) => audibleRanges(layers, layer, ctx.scene.duration ?? Infinity));
}

// The first time one of these layers is on screen or heard (at or after `from` seconds), or null.
function firstSeen(model, layers, from = 0, heard = []) {
  let first = null;
  for (const item of layers) {
    const index = item.samples.opacity.findIndex((value, at) => value > SEEN && model.times[at] >= from);
    if (index >= 0 && (first === null || model.times[index] < first)) first = model.times[index];
  }
  for (const range of heard) if (range.end > from && (first === null || Math.max(range.start, from) < first)) first = Math.max(range.start, from);
  return first;
}

/** The timeline against the spine: gaps no beat covers, a late premise, a second payoff, beats out of order. */
export function spineDrift(model, ctx) {
  const spine = ctx.style?.spine;
  if (!spine?.length) return [];
  const findings = [];
  const fixSpine = `Change the edit to match the spine, or change the spine (notes brief style.spine) and have the person approve it, ${WAIVE}`;
  // Stretches no beat covers.
  let covered = 0;
  for (const beat of [...spine].sort((a, b) => a.from - b.from)) {
    if (beat.from - covered > GAP) findings.push(finding(covered, `${sec(covered)}-${sec(beat.from)}s in no beat`, `no stretch over ${GAP} s outside the spine`,
      `${sec(covered)}s to ${sec(beat.from)}s of ${ctx.sceneName} is in no spine beat: the story does not say what it is for.`, `Give it a beat in the spine, or cut it. ${WAIVE}`));
    covered = Math.max(covered, beat.to);
  }
  const end = Math.min(model.duration, Math.max(...spine.map((beat) => beat.to), 0) + 60);
  if (model.duration - covered > GAP) findings.push(finding(covered, `${sec(covered)}-${sec(end)}s in no beat`, `no stretch over ${GAP} s outside the spine`,
    `${sec(covered)}s to the end of ${ctx.sceneName} is in no spine beat.`, `Cut it, or add the beat to the spine. ${WAIVE}`));
  // Beats past the end: the spine promises story the video does not have.
  for (const beat of spine.filter((entry) => entry.from >= model.duration - 0.1))
    findings.push(finding(model.duration, `${beat.role} at ${sec(beat.from)}s`, `every beat before the end (${sec(model.duration)}s)`, `The ${beat.role} beat starts at ${sec(beat.from)}s, after ${ctx.sceneName} ends at ${sec(model.duration)}s.`, fixSpine));
  // The premise (the problem beat) arrives late.
  const problem = spine.find((beat) => beat.role === "problem");
  const premiseBy = Math.max(PREMISE_SHARE * model.duration, PREMISE_FLOOR);
  if (problem && problem.from > premiseBy)
    findings.push(finding(problem.from, `premise at ${Math.round((problem.from / model.duration) * 100)}%`, `the problem beat by ${sec(premiseBy)}s (${PREMISE_SHARE * 100}% of the runtime, 3 s at least)`,
      `The problem beat starts at ${sec(problem.from)}s, ${Math.round((problem.from / model.duration) * 100)}% into the video: viewers do not know what is at stake until then.`,
      `Show the problem in picture or real sound by ${sec(premiseBy)}s (shorten the hook), ${WAIVE}`));
  // One payoff, and only the end (or a coda) after it.
  const payoffs = spine.filter((beat) => beat.role === "payoff");
  if (payoffs.length > 1)
    // A warning, not a gate: a double payoff can be designed (a reveal, then the slam).
    findings.push({ ...finding(payoffs[1].from, `${payoffs.length} payoff beats`, "one payoff, or a second that tops the first", `The spine has ${payoffs.length} payoffs (${payoffs.map((beat) => `${sec(beat.from)}s`).join(", ")}); make sure the second tops the first.`, `If the second does not top the first, fold it in. ${WAIVE}`), severity: "warn" });
  const lastPayoff = spine.lastIndexOf(payoffs.at(-1));
  const after = lastPayoff >= 0 ? spine.slice(lastPayoff + 1).filter((beat) => beat.role !== "end" && beat.role !== "coda") : [];
  if (after.length)
    findings.push(finding(after[0].from, `${after[0].role} after the payoff`, "only the end after the payoff", `The ${after[0].role} beat at ${sec(after[0].from)}s comes after the payoff: the story goes on once it has landed.`, `Move it before the payoff or cut it. ${WAIVE}`));
  // Beat order: the listed order is the story; the times and the used layers keep to it.
  for (let index = 1; index < spine.length; index += 1)
    if (spine[index].from < spine[index - 1].from)
      findings.push(finding(spine[index].from, `${spine[index].role} before ${spine[index - 1].role}`, "beats in the spine's order", `The spine lists ${spine[index - 1].role} before ${spine[index].role}, but their times swap them.`, fixSpine));
  // A name listed in several beats (a logo bumper at the start and the end) first shows in the
  // earliest of them, and shows again in each later one.
  const earliest = new Map();
  for (const beat of [...spine].sort((a, b) => a.from - b.from)) for (const name of beat.uses ?? []) if (!earliest.has(name)) earliest.set(name, beat);
  for (const beat of spine) {
    for (const name of beat.uses ?? []) {
      const layers = layersNamed(model, name, ctx);
      const heard = soundsNamed(name, ctx);
      const seen = firstSeen(model, layers, 0, heard);
      const where = `${name} in ${beat.role} (${sec(beat.from)}-${sec(beat.to)}s)`;
      if (seen === null) {
        findings.push(finding(beat.from, `${name} not on screen`, where, `The ${beat.role} beat uses "${name}", and no layer of that name or media file is on screen or heard.`, `Show "${name}" in the beat, or fix the spine's uses (a layer name, or a file name as library media lists it). ${WAIVE}`));
      } else if (earliest.get(name) !== beat) {
        const again = firstSeen(model, layers, beat.from - SLACK, heard);
        if (again === null || again >= beat.to)
          findings.push(finding(beat.from, `${name} not in ${beat.role}`, where, `"${name}" is listed in the ${beat.role} beat (${sec(beat.from)}-${sec(beat.to)}s) but is not on screen in it.`, fixSpine));
      } else if (seen < beat.from - SLACK || seen >= beat.to) {
        findings.push(finding(seen, `${name} first at ${sec(seen)}s`, where, `"${name}" belongs to the ${beat.role} beat (${sec(beat.from)}-${sec(beat.to)}s) but first shows at ${sec(seen)}s.`, fixSpine));
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- the never list

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const TENS = { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };

/** Text as comparable words: lower case, no punctuation, numbers spelled out as digits. */
export function textWords(text) {
  return String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean)
    .map((word) => (NUMBER_WORDS.includes(word) ? String(NUMBER_WORDS.indexOf(word)) : TENS[word] ? String(TENS[word]) : word));
}

/**
 * True when two texts say nearly the same: most words shared (Dice 0.75), or the shorter one
 * (3 words or more) nearly all inside the longer and covering half of it. "Seven open-weight
 * models. One RTX 4090." and "7 open models. one rtx 4090." match; "7 open models." alone does not.
 */
export function sameWording(a, b) {
  const left = new Set(textWords(a));
  const right = new Set(textWords(b));
  if (!left.size || !right.size) return false;
  const shared = [...left].filter((word) => right.has(word)).length;
  const smaller = Math.min(left.size, right.size);
  const larger = Math.max(left.size, right.size);
  return (2 * shared) / (left.size + right.size) >= 0.75 || (smaller >= 3 && shared / smaller >= 0.85 && shared / larger >= 0.5);
}

const textsOf = (item) => (Array.isArray(item.texts) && item.texts.length ? item.texts : [item.text]).filter((text) => typeof text === "string" && text.trim());
const shownRange = (model, item) => {
  const opacity = item.samples.opacity;
  const first = opacity.findIndex((value) => value > SEEN);
  return first < 0 ? null : { from: first, to: opacity.length - 1 - [...opacity].reverse().findIndex((value) => value > SEEN) };
};

/** On-screen text that says what the person turned down (style.rejected): a gate. */
export function rejectedText(model, ctx) {
  const rejected = ctx.style?.rejected ?? [];
  if (!rejected.length) return [];
  // Each text alone, and each two texts on screen together (a line split over two layers).
  const shown = readingTexts(model).map((item) => ({ item, text: textsOf(item).join(" "), range: shownRange(model, item) })).filter((entry) => entry.range);
  const candidates = shown.map((entry) => ({ items: [entry.item], text: entry.text, at: entry.range.from }));
  // A caption layer shows its texts list one line at a time: each line is said alone too.
  for (const entry of shown) {
    const lines = textsOf(entry.item);
    if (lines.length < 2) continue;
    for (const [index, line] of lines.entries()) {
      const at = entry.item.samples.textIndex?.findIndex((value, sample) => value === index && entry.item.samples.opacity[sample] > SEEN);
      candidates.push({ items: [entry.item], text: line, at: at >= 0 ? at : entry.range.from });
    }
  }
  for (const [index, first] of shown.entries())
    for (const second of shown.slice(index + 1))
      if (first.range.from <= second.range.to && second.range.from <= first.range.to)
        candidates.push({ items: [first.item, second.item].sort((a, b) => shownRange(model, a).from - shownRange(model, b).from), at: Math.max(first.range.from, second.range.from) });
  const findings = [];
  const flagged = new Set();
  for (const said of rejected) {
    for (const candidate of candidates) {
      const text = candidate.text ?? candidate.items.map((item) => textsOf(item).join(" ")).join(" ");
      const key = candidate.items.map((item) => item.id).join("+");
      if (flagged.has(key) || candidate.items.some((item) => flagged.has(item.id)) || !sameWording(said, text)) continue;
      flagged.add(key);
      findings.push({
        rule: "rejected_text", severity: "error", itemId: candidate.items[0].id, at: sec(model.times[candidate.at]),
        measured: `"${ctx.quote(text)}"`, required: `not "${ctx.quote(said)}" (the person turned it down)`,
        message: `${candidate.items.map((item) => ctx.name(item)).join(" and ")} say${candidate.items.length > 1 ? "" : "s"} "${ctx.quote(text)}", which is nearly "${ctx.quote(said)}", text the person turned down.`,
        fix: { kind: "hint", text: 'Write a new line from the material, or cut it. If the person asked for it back, remove it from style.rejected (notes brief) with their words.' },
      });
    }
  }
  return findings;
}
