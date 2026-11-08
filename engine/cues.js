// Editing document.cues: the named moments [{name, time, kind}] that timing can point at
// ("cue:drop"). A cue with {layer, media} is pinned to a clip's footage (footageCues.js).
// engine/qualityFields.js checks the list when the document is parsed (names, times, kinds, at
// most 5,000); this file only adds, replaces and removes entries.
//
// Who writes which kind:
//   marker      set_cues (placed by the agent or a person)
//   beat, onset detect_beats (found in the music): beat-1, beat-2, … and onset-1, onset-2, …
//   line, word  add_captions (from a caption file or a timed transcript): captions-1, … and
//               captions-w1-hello, …
import { CUE_KINDS } from "./qualityFields.js";
import { footageCueTime } from "./footageCues.js";
import { round } from "./numbers.js";

/** A short lowercase name part from any text: "Ship faster!" → "ship-faster". */
export function cueSlug(text, max = 24) {
  return String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}

/**
 * The cue list after removing and adding. `remove` takes {kinds, prefix, names}: a cue goes when
 * its kind is in kinds (and, with prefix, its name starts with prefix), or its name is in names.
 * A cue in `add` replaces any cue with the same name. Sorted by time.
 */
export function withCues(existing, add = [], remove = {}) {
  const kinds = new Set(remove.kinds ?? []);
  const names = new Set(remove.names ?? []);
  const adding = new Set(add.map((cue) => cue.name));
  const kept = (existing ?? []).filter((cue) => {
    if (names.has(cue.name) || adding.has(cue.name)) return false;
    if (kinds.has(cue.kind) && (!remove.prefix || cue.name.startsWith(remove.prefix))) return false;
    return true;
  });
  return [...kept, ...add].sort((a, b) => a.time - b.time);
}

/** Applies a set_cues operation {cues?, replace?, remove?} to the document. */
export function applySetCues(document, operation) {
  const cues = operation.cues ?? [];
  if (!Array.isArray(cues)) throw new Error("set_cues cues must be a list of {name, time, kind?}.");
  const replace = operation.replace;
  if (replace !== undefined && replace !== false && replace !== true && !CUE_KINDS.includes(replace))
    throw new Error(`set_cues replace must be true (all cues), a kind (${CUE_KINDS.join(", ")}) or false.`);
  if (operation.remove !== undefined && (!Array.isArray(operation.remove) || operation.remove.some((name) => typeof name !== "string")))
    throw new Error("set_cues remove must be a list of cue names.");
  const missing = (operation.remove ?? []).filter((name) => !(document.cues ?? []).some((cue) => cue.name === name));
  if (missing.length) throw new Error(`No cue named ${missing.slice(0, 3).join(", ")}.`);
  const added = cues.map((cue, index) => {
    if (!cue || typeof cue !== "object" || Array.isArray(cue)) throw new Error(`set_cues cues[${index}] must be {name, time, kind?}.`);
    if (cue.layer === undefined && cue.media === undefined) return { name: cue.name, time: cue.time, kind: cue.kind ?? "marker" };
    // Pinned to footage: the time comes from the clip (footageCues.js); parsing keeps it current.
    if (typeof cue.media !== "number" || !Number.isFinite(cue.media) || cue.media < 0) throw new Error(`set_cues cues[${index}] media must be seconds into the clip's file, 0 or more.`);
    const { time } = footageCueTime(document, cue.layer, cue.media);
    return { name: cue.name, time: Math.max(0, round(time)), kind: cue.kind ?? "marker", layer: cue.layer, media: cue.media };
  });
  const kinds = replace === true ? CUE_KINDS : typeof replace === "string" ? [replace] : [];
  document.cues = withCues(document.cues, added, { kinds, names: operation.remove ?? [] });
  if (!document.cues.length) delete document.cues;
}
