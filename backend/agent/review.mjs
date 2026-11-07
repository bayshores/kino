// look {mode:"review"} and the review gate on final renders.
//
// A review shows the moments of a scene where something can go wrong (risky ones at full size,
// quiet ones on compact pages: reviewSizes below): every
// cut, every transition effect, the start, middle and end of every big move (and of every set
// piece a `move` op built), every caption or title as it lands and changes, and one frame in each
// quiet stretch over 3 s. These are the review's "events".
//
// Each event also gets a signature: a hash of what is on screen at its time (the scene's
// background and every visible layer as it is evaluated then, with the animations running then).
// An edit elsewhere in the video leaves the signature alone, so a second review shows only the
// events whose picture could have changed. The service keeps the signatures the agent has seen
// (agent state `reviews`), and a final render of the whole video asks that every current event's
// signature is among them.
import { createHash } from "node:crypto";
import { evaluateLayer } from "../../engine/animation.js";
import { animationTreeEntries } from "../../engine/animationTree.js";
import { point, worldMatrix } from "../../engine/geometry.js";
import { hasTextChanges } from "../../engine/textChange.js";
import { shownTextAt } from "../../engine/textChangeDraw.js";
import { animationSpan, sec } from "./describe.mjs";

// Events closer than this (seconds) are one frame: the frame of the first.
export const MERGE_WINDOW = 0.35;
// A stretch with no event longer than this gets frames of its own (one per QUIET_STEP seconds).
export const QUIET_GAP = 3;
const QUIET_STEP = 6;
// A move counts as big when the layer's center travels this share of the frame's long edge, its
// size changes by this factor, or it turns this many degrees.
const BIG_TRAVEL = 0.08;
const BIG_SCALE = 1.25;
const BIG_TURN = 15;
// A shot shorter than this (seconds) is part of a fast montage.
const QUICK_SHOT = 1.2;
// Scenes shorter than this (seconds) are not gated: a sting or a test card is seen whole by any look.
export const REVIEW_SKIP_UNDER = 5;
// How many signatures a project keeps per scene (the newest).
export const REVIEW_MEMORY = 3000;
// The waiver code that lets a final render go without a review (waive_check {code:"review"}).
export const REVIEW_WAIVER = "review";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const short = (text, most = 28) => {
  const words = String(text ?? "").replace(/\s+/g, " ").trim();
  return words.length > most ? `${words.slice(0, most - 1)}…` : words;
};

// Every animation of a layer that is switched on, with its span on the scene clock.
function animationsOf(layer) {
  let entries = [];
  try { entries = animationTreeEntries(layer.animations ?? [], { enabledOnly: true, groups: false }); } catch { return []; }
  // animationTreeEntries already moved a grouped animation's start onto the layer's clock.
  return entries.filter(({ animation }) => animation && animation.kind !== "composed").map(({ animation }) => {
    const [start, end] = animationSpan(animation);
    return { animation, start, end };
  });
}

// Where a layer is at `time`: its center in scene pixels, its size factor and its turn (degrees).
function placeAt(layer, layers, time) {
  const evaluate = (item) => { try { return evaluateLayer(item, time); } catch { return item; } };
  const state = evaluate(layer);
  const matrix = worldMatrix(layer, layers, evaluate);
  const center = point(matrix, (state.width ?? 0) / 2, (state.height ?? 0) / 2);
  const size = Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]));
  const turn = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI;
  return { center, size, turn };
}

// Whether an animation moves its layer a lot between its start and end.
function bigMove(layer, layers, scene, start, end) {
  const before = placeAt(layer, layers, start);
  const after = placeAt(layer, layers, end);
  const travel = Math.hypot(after.center.x - before.center.x, after.center.y - before.center.y) / Math.max(scene.width, scene.height);
  const ratio = before.size > 1e-6 && after.size > 1e-6 ? Math.max(after.size / before.size, before.size / after.size) : 1;
  let turn = Math.abs(after.turn - before.turn) % 360;
  if (turn > 180) turn = 360 - turn;
  return travel >= BIG_TRAVEL || ratio >= BIG_SCALE || turn >= BIG_TURN;
}

/**
 * The review events of a scene (already expanded: linked components drawn out), as
 * [{time, names}], sorted and merged. `shots` are the scene's footage shots ({start, end},
 * sceneShots.js); `from` and `to` keep only the events in that stretch; `name(id)` names a layer
 * (its readable ID or code).
 */
export function reviewEvents(scene, { shots = [], fps = 30, from = 0, to = scene.duration, name = (id) => id } = {}) {
  const frame = 1 / fps;
  const last = Math.max(0, scene.duration - frame);
  const raw = [];
  // `kind` says how risky the moment is (KIND_RISK): a quiet one is shown smaller.
  const add = (time, name, kind) => {
    if (!Number.isFinite(time)) return;
    raw.push({ time: sec(Math.min(last, Math.max(0, time))), name, kind });
  };
  add(0, "first frame", "first");
  add(last, "last frame", "last");
  // Cuts in the footage: the first frame of each new shot.
  // A cut inside a fast montage (both shots under QUICK_SHOT) is one of many alike.
  const length = (shot) => shot.end - shot.start;
  for (const [index, shot] of shots.entries()) {
    if (index > 0) add(shot.start + frame, `cut to shot ${index + 1}`, length(shot) < QUICK_SHOT && length(shots[index - 1]) < QUICK_SHOT ? "quick cut" : "cut");
  }
  // Set pieces a move op built (scene.moves): where each starts, its middle and where it ends.
  for (const move of scene.moves ?? []) {
    if (!Number.isFinite(move?.start) || !Number.isFinite(move?.end)) continue;
    add(move.start + frame, `${move.name} starts`, "set piece");
    if (move.end - move.start >= 0.4) add((move.start + move.end) / 2, `${move.name} middle`, "set piece");
    add(move.end, `${move.name} ends`, "set piece");
  }
  const layers = scene.layers ?? [];
  for (const layer of layers) {
    if (layer.type === "audio" || layer.visible === false) continue;
    const label = name(layer.id);
    const isText = layer.type === "text";
    const words = isText ? `"${short(layer.text)}"` : label;
    for (const { animation, start, end } of animationsOf(layer)) {
      const kind = animation.kind;
      if (kind === "show") { if (start > 0) add(start + frame, `${words} shows`, isText ? "text" : "show"); continue; }
      if (kind === "hide") { if (start > 0 && start < scene.duration) add(start + frame, `${label} cut away`, "hide"); continue; }
      if (kind === "change-text") {
        const settle = (animation.out?.duration ?? 0) + (animation.in?.duration ?? 0);
        add(start + settle + 0.04, `text changes to "${short(animation.text)}"`, "text");
        continue;
      }
      if (kind === "effect") {
        if (end - start >= 0.1) add((start + end) / 2, `${animation.effect ?? "effect"} on ${label}`, "effect");
        continue;
      }
      if (kind === "in") {
        // A caption or title is checked once it has landed; anything else too, as it settles.
        add(end + 0.04, isText ? `text in ${words}` : `${label} in`, isText ? "text" : "in");
        if (end - start >= 0.3 && bigMove(layer, layers, scene, start, end)) add(start + (end - start) * 0.3, `${label} entering`, "move");
        continue;
      }
      if (end - start < 0.05) continue;
      if (!bigMove(layer, layers, scene, start, end)) continue;
      const what = kind === "out" ? "exit" : "move";
      add(start + Math.min(0.1, (end - start) * 0.15), `${label} ${what} starts`, "move");
      if (end - start >= 0.4) add((start + end) / 2, `${label} ${what} middle`, "move");
      add(Math.min(end + 0.02, scene.duration), `${label} ${what} ends`, "move");
    }
  }
  raw.sort((a, b) => a.time - b.time);
  // Merge events closer than MERGE_WINDOW to the first of their group.
  const merged = [];
  for (const entry of raw) {
    const group = merged.at(-1);
    if (group && entry.time - group.time < MERGE_WINDOW) {
      if (!group.names.includes(entry.name)) group.names.push(entry.name);
      if (!group.kinds.includes(entry.kind)) group.kinds.push(entry.kind);
      continue;
    }
    merged.push({ time: entry.time, names: [entry.name], kinds: [entry.kind] });
  }
  // Quiet stretches: one frame per QUIET_STEP seconds in each gap over QUIET_GAP.
  const quiet = [];
  for (let index = 1; index < merged.length; index += 1) {
    const gap = merged[index].time - merged[index - 1].time;
    if (gap <= QUIET_GAP) continue;
    const count = Math.ceil(gap / QUIET_STEP);
    for (let step = 1; step <= count; step += 1) quiet.push({ time: sec(merged[index - 1].time + (gap * step) / (count + 1)), names: ["quiet stretch"], kinds: ["quiet"] });
  }
  return [...merged, ...quiet].sort((a, b) => a.time - b.time).filter((event) => event.time >= from - 1e-6 && event.time <= to + 1e-6);
}

/**
 * What is on screen at `time`, as a short hash: the scene's background, then each visible layer
 * as it is evaluated then (with the text it shows) and the animations running then. `missing`
 * names fonts drawn with a fallback (they change the picture too).
 */
export function frameSignature(scene, time, { fonts, missing = "" } = {}) {
  const parts = [JSON.stringify([scene.width, scene.height, scene.background, scene.backgroundEnabled, scene.backgroundAnimations ?? []]), missing];
  for (const layer of scene.layers ?? []) {
    if (layer.type === "audio") continue;
    let state;
    try { state = evaluateLayer(layer, time); } catch { state = { ...layer }; }
    // A hidden layer, or one at opacity 0 (before its fade in), draws nothing.
    if (state.visible === false || state.opacity === 0) continue;
    const { animations, ...shown } = state;
    const running = animationsOf(layer).filter(({ start, end }) => start <= time + 1e-6 && time <= end + 1e-6).map(({ animation }) => animation);
    let text = null;
    if (layer.type === "text" && hasTextChanges(layer)) { try { text = shownTextAt(layer, time, fonts); } catch { /* the layer's own text */ } }
    parts.push(JSON.stringify([layer.id, shown, running, text]));
  }
  return hash(`${time}\n${parts.join("\n")}`).slice(0, 24);
}

/** The key a reviewed event is remembered by. */
export const reviewKey = (time, signature) => `${sec(time)}|${signature}`;

/** The events (with `key`) not in `seen` (a Set of reviewKey). */
export const unreviewed = (events, seen) => events.filter((event) => !seen.has(event.key));

/** Adds `keys` to a scene's remembered list, keeping the newest REVIEW_MEMORY. */
export function rememberReviewed(list = [], keys) {
  const kept = [...list.filter((key) => !keys.includes(key)), ...keys];
  return kept.slice(-REVIEW_MEMORY);
}

// ---- one review call: which moments, at which size ----------------------------------------
// A review costs image tokens, so moments are ranked by risk (reviewSizes). The riskiest are
// shown at full size (REVIEW_FULL_EDGE): moments where a check finding first shows, the first
// frame, set pieces, effects, text landing or changing, and cuts. The rest (quiet stretches,
// cuts inside a fast montage, plain entrances, moves and exits) go on compact pages
// (REVIEW_COMPACT_EDGE, 4 across). How many are full size is set so the whole review fits in
// about REVIEW_TARGET_CALLS calls. A frame that looks the same as the one shown before it is not
// shown again: it counts as reviewed with it ("as 3"). Each call fills REVIEW_IMAGE_BUDGET image
// tokens, so an answer stays under 8k tokens with its words.
export const REVIEW_FULL_EDGE = 1280;
export const REVIEW_COMPACT_EDGE = 560;
export const REVIEW_IMAGE_BUDGET = 6600;
export const REVIEW_TARGET_CALLS = 8;
// About what one frame costs on a page (image tokens, with its label strip).
const FULL_COST = 1200;
const COMPACT_COST = 300;
// How risky each kind of moment is; a moment's risk is its riskiest kind, plus a little for each
// other thing happening then, plus a finding first showing then.
export const KIND_RISK = Object.freeze({ first: 6, "set piece": 3, effect: 3, text: 3, cut: 2, move: 1, in: 1, "quick cut": 0.5, show: 0.5, hide: 0.5, last: 0.5, quiet: 0 });
// A moment needs at least this risk to be shown at full size.
const FULL_RISK = 2;

/**
 * "full" or "compact" for each of a scene's review events (by key, or time), worked out over the
 * whole scene so a moment keeps its size from call to call. A finding (not waived, not info)
 * adds risk to the first moment it touches: one that spans many moments is seen once at full
 * size. The riskiest moments are full size, as many as fit REVIEW_TARGET_CALLS calls.
 */
export function reviewSizes(events, findings = [], { targetCalls = REVIEW_TARGET_CALLS } = {}) {
  const ordered = [...events].sort((a, b) => a.time - b.time);
  const seenFindings = new Set();
  const scored = ordered.map((event, index) => {
    const risks = (event.kinds ?? []).map((kind) => KIND_RISK[kind] ?? 1).sort((a, b) => b - a);
    let risk = (risks[0] ?? 1) + 0.25 * Math.min(4, risks.length - 1);
    for (const finding of findingsAt(findings, event.time)) {
      const id = `${finding.rule}|${finding.ref}`;
      if (seenFindings.has(id)) continue;
      seenFindings.add(id);
      risk += finding.severity === "error" ? 8 : 4;
    }
    return { key: event.key ?? event.time, risk, index };
  });
  // The most full-size frames the target allows: each costs FULL_COST - COMPACT_COST more.
  const room = targetCalls * REVIEW_IMAGE_BUDGET - ordered.length * COMPACT_COST;
  const most = Math.max(0, Math.floor(room / (FULL_COST - COMPACT_COST)));
  const full = new Set(scored.filter((entry) => entry.risk >= FULL_RISK).sort((a, b) => b.risk - a.risk || a.index - b.index).slice(0, most).map((entry) => entry.key));
  return new Map(scored.map((entry) => [entry.key, full.has(entry.key) ? "full" : "compact"]));
}

/**
 * Whether two review thumbnails (grey, REVIEW_THUMB cells) show nearly the same picture: on
 * average under 1.5 levels apart and no cell more than 16 levels (of 255). A moved caption, a new
 * word or another shot of footage is more than that. `strict` (a risky moment) asks for under
 * 0.4 on average and 4 at most: only the same picture.
 */
export function nearDuplicate(a, b, { strict = false } = {}) {
  if (!a || !b || a.length !== b.length) return false;
  const [mean, most] = strict ? [0.4, 4] : [1.5, 16];
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    const difference = Math.abs(a[index] - b[index]);
    if (difference > most) return false;
    total += difference;
  }
  return total / a.length < mean;
}

/** The findings ({at?, until?}) that touch `time` (within `margin` seconds). */
export function findingsAt(findings, time, margin = 0.25) {
  return findings.filter((finding) => finding.at != null && finding.at - margin <= time && time <= (finding.until ?? finding.at) + margin);
}

// When each touched layer is on screen ([start, end], scene seconds), per scene id: the stretch
// an edit changed. A change to the scene itself (its background, size or length) is the whole
// scene. `touched` is [{sceneId, layerId}] (live.mjs touchedLayers).
export function changedStretches(before, after, touched, changedIds = []) {
  const stretches = new Map();
  const widen = (sceneId, start, end) => {
    const old = stretches.get(sceneId);
    stretches.set(sceneId, old ? [Math.min(old[0], start), Math.max(old[1], end)] : [start, end]);
  };
  for (const scene of after.scenes ?? []) {
    if (changedIds.includes(scene.id)) widen(scene.id, 0, scene.duration);
  }
  for (const { sceneId, layerId } of touched) {
    for (const document of [before, after]) {
      const scene = document?.scenes?.find((item) => item.id === sceneId);
      const layer = scene?.layers?.find((item) => item.id === layerId);
      if (!layer) continue;
      const spans = animationsOf(layer).filter(({ animation }) => ["in", "out", "show", "hide"].includes(animation.kind));
      // On screen from its first entrance (or 0) to its last exit (or the scene's end).
      const ins = spans.filter(({ animation }) => animation.kind === "in" || animation.kind === "show").map(({ start }) => start);
      const outs = spans.filter(({ animation }) => animation.kind === "out" || animation.kind === "hide").map(({ end }) => end);
      widen(sceneId, ins.length ? Math.min(...ins) : 0, outs.length ? Math.max(...outs) : scene.duration);
    }
  }
  return stretches;
}

/**
 * The edit receipt's newFindings line: findings after the edit (not waived, not info) that were
 * not there before, by rule, ref and second, and that touch a stretch the edit changed. Null
 * when there are none. "overlap said-2-w1 @11.2s, contrast L5 @15s (+2 more)".
 */
export function newFindingsLine(beforeFindings, afterFindings, stretches, { most = 5 } = {}) {
  const identity = (finding) => `${finding.rule}|${finding.ref}|${finding.scene ?? ""}|${finding.at == null ? "" : Math.round(finding.at)}`;
  const known = new Set(beforeFindings.map(identity));
  const ranges = [...stretches.values()];
  const inside = (finding) => {
    if (finding.at == null) return ranges.length > 0;
    const end = finding.until ?? finding.at;
    return ranges.some(([start, stop]) => finding.at <= stop + 0.05 && end >= start - 0.05);
  };
  const fresh = afterFindings.filter((finding) => !finding.waived && finding.severity !== "info" && !known.has(identity(finding)) && inside(finding));
  if (!fresh.length) return null;
  const words = fresh.slice(0, most).map((finding) => `${finding.severity === "error" ? "E " : ""}${finding.rule} ${finding.ref}${finding.at != null ? ` @${sec(finding.at)}s` : ""}`);
  return `${words.join(", ")}${fresh.length > most ? ` (+${fresh.length - most} more)` : ""}`;
}
