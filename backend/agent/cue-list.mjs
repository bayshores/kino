// inspect {targets:["cues"]}: the project's named moments (document.cues) and rhythm as text, so
// an agent can time animations to beats, words and markers. "cues[kind=beat]" lists one kind;
// "cues[from=60,to=90]" (with or without kind=) lists the ones in that stretch of time.
//
//   rhythm 120 bpm, first beat at 0.437s
//   beat 40: beat-1 0.437, beat-2 0.937, …
//   line 3: captions-1 0.25, captions-2 4.8, captions-3 11
//
// A ten-minute song has over a thousand beats and up to a thousand onsets, too many for one
// answer. So one answer lists the earliest cues up to CUE_TEXT_BUDGET characters (about 4,000
// tokens) and its last line says how to ask for the next ones:
//
//   beat 1200, 560 shown: beat-1 0.437, …, beat-560 280.937
//   640 more from 281.437s: inspect "cues[kind=beat,from=281.437]" for the next ones
import { CUE_KINDS } from "../../engine/qualityFields.js";

const CUE_TARGET = /^cues(?:\[([^\]]*)\])?$/;
const CUE_TEXT_BUDGET = 10_000;

/** True for a target that asks for cues: "cues", "cues[kind=beat]", "cues[from=60,to=90]". */
export function isCueTarget(target) {
  return CUE_TARGET.test(String(target).trim());
}

// {kinds, from, to} for one cue target. Throws for an unknown kind or key, or a bad time.
function parseCueTarget(target) {
  const text = String(target).trim();
  const inside = CUE_TARGET.exec(text)[1];
  const wanted = { kind: null, from: 0, to: Infinity };
  for (const part of (inside ?? "").split(",").map((each) => each.trim()).filter(Boolean)) {
    const [key, value = "", extra] = part.split("=").map((each) => each.trim());
    if (extra !== undefined || !["kind", "from", "to"].includes(key))
      throw new Error(`${text}: write cues[kind=beat], cues[from=60,to=90] or both, as cues[kind=beat,from=60].`);
    if (key === "kind") {
      if (!CUE_KINDS.includes(value)) throw new Error(`cues[kind=${value}]: kind is one of ${CUE_KINDS.join(", ")}.`);
      wanted.kind = value;
    } else {
      const seconds = Number(value);
      if (value === "" || !Number.isFinite(seconds) || seconds < 0) throw new Error(`${text}: ${key} is a time in seconds, 0 or more.`);
      wanted[key] = seconds;
    }
  }
  if (wanted.to < wanted.from) throw new Error(`${text}: to must not be before from.`);
  return { kinds: wanted.kind ? [wanted.kind] : CUE_KINDS, from: wanted.from, to: wanted.to };
}

const matches = (cue, wanted) => wanted.kinds.includes(cue.kind) && cue.time >= wanted.from && cue.time <= wanted.to;

// The target that asks for the cues after `next` seconds, keeping a single target's kind and end.
function nextTarget(wanted, next) {
  if (wanted.length !== 1) return `cues[from=${next}]`;
  const [only] = wanted;
  const parts = [...(only.kinds.length === 1 ? [`kind=${only.kinds[0]}`] : []), `from=${next}`, ...(Number.isFinite(only.to) ? [`to=${only.to}`] : [])];
  return `cues[${parts.join(",")}]`;
}

/** {text, count, shown} for the cue targets. Throws for an unknown kind or a bad window. */
export function cueListText(document, targets) {
  const wanted = targets.map(parseCueTarget);
  const kinds = new Set(wanted.flatMap((each) => each.kinds));
  const windowed = wanted.some((each) => each.from > 0 || Number.isFinite(each.to));
  const cues = (document.cues ?? []).filter((cue) => wanted.some((each) => matches(cue, each)));
  // The earliest cues that fit the budget (document.cues is kept in time order).
  let used = 0;
  let shown = 0;
  while (shown < cues.length) {
    used += cues[shown].name.length + String(cues[shown].time).length + 3;
    if (used > CUE_TEXT_BUDGET && shown > 0) break;
    shown += 1;
  }
  const lines = [];
  if (document.rhythm) lines.push(`rhythm ${document.rhythm.bpm} bpm, first beat at ${document.rhythm.offset}s`);
  for (const kind of CUE_KINDS) {
    if (!kinds.has(kind)) continue;
    const ofKind = cues.filter((cue) => cue.kind === kind);
    const listed = cues.slice(0, shown).filter((cue) => cue.kind === kind);
    if (!ofKind.length) continue;
    const label = listed.length < ofKind.length ? `${kind} ${ofKind.length}, ${listed.length} shown` : `${kind} ${ofKind.length}`;
    lines.push(listed.length ? `${label}: ${listed.map((cue) => `${cue.name} ${cue.time}${cue.layer ? ` (${cue.layer} file ${cue.media}s)` : ""}`).join(", ")}` : label);
  }
  if (shown < cues.length) {
    const next = cues[shown].time;
    lines.push(`${cues.length - shown} more from ${next}s: inspect "${nextTarget(wanted, next)}" for the next ones`);
  }
  if (!cues.length) {
    const named = kinds.size === CUE_KINDS.length ? "" : `${[...kinds].join(" or ")} `;
    lines.push(windowed && document.cues?.length ? `no ${named}cues in that time` : `no ${named}cues yet: set_cues, add_captions and detect_beats make them`);
  }
  return { text: lines.join("\n"), count: cues.length, shown };
}
