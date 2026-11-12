// The deck's cards that compose {footage} builds as made graphics (plan.js calls placeCards, ops.js
// adds the ops). editStyle (treatments.js) already turns transition, camera, title and hit cards into
// the plan; this file places the rest: punch-in, speed-lines, the one-call treatments (moves
// overexpose, smear, shatter, split-fields, backdrop-flash; effects edge-lines, rim-light; cut_out
// outline; the scene finish) and a named signature move. Why: run 6's deck held punch-in,
// type-swap, speed-lines and build-in, compose built none of them, and the agent built no made
// graphic by hand (.scratch/ceiling/trace-run6.md section 1, trace-code.md section 2).
//
// One table, CARDS: a card's name to {wants, fits, ops} (placed by compose) or {hand} (built by the
// agent with the ready call). wants lists the moments it may go on, best first:
//   drop      the song's real drop (plan.js realDrop), on the shot under it
//   section   a cut onto a new section of the song (plan.song sections), else any plain cut
//   face      a shot with a face or a marked subject (shot.focus)
//   strongest the body shots by moment score, best first
// A subject treatment that needs a cut-out (backdrop-flash, rim-light, outline) is never run inside
// compose: a cut-out takes up to a minute and refuses the edit while it is made (cutout-operation.mjs
// CUTOUT_RUNNING), so it gets a ready call on the best face shot instead.
import { round as round3 } from "../numbers.js";

// Restraint: at most one made graphic per this many seconds. A guess (the directors' builds in
// .scratch/ceiling a, b and c used 3 to 5 in 18 s, about one per 4 to 6 s); compose {cardGap} sets it,
// accents:true halves it.
export const CARD_GAP = 5;

const pct = (focus) => [Math.round(focus[0] * 100), Math.round(focus[1] * 100)];
const name = (shot) => `shot-${shot.n}`;
const room = (slot) => slot.shot.end - slot.at;
// A shot whose own place or size moves under a move (a zoom, whip or push into or out of it) cannot take a punch.
const MOVING = new Set(["zoom-through", "whip-pan", "mask-wipe", "push-transition"]);
const steady = (slot, plan) => ![slot.shot.transition?.kind, plan.shots[slot.shot.n]?.transition?.kind].some((kind) => MOVING.has(kind));
const fill = (shot) => shot?.layout?.kind === "fill";
// A plain cut between two full-frame clips: what a transition treatment replaces.
const plainCut = (slot) => Boolean(slot.prev) && slot.shot.transition?.kind === "cut" && fill(slot.shot) && fill(slot.prev) && slot.prev.end - slot.prev.start >= 0.6 && slot.shot.end - slot.shot.start >= 1;
const transition = (move, extra = {}) => ({
  wants: ["drop", "section"], fits: (slot) => plainCut(slot) && slot.at === slot.shot.start,
  ops: (slot) => [{ op: "move", name: move, id: `card-${move}`, at: round3(slot.at + (extra.lead ?? 0)), ...extra.fields(slot) }],
});
const overlay = (effect, longest) => ({
  wants: ["drop", "section", "strongest"], fits: (slot) => room(slot) >= 0.4,
  ops: (slot) => [{ op: "add_animation", layer: name(slot.shot), effect, start: round3(slot.at), duration: round3(Math.min(longest, room(slot))) }],
});
// The scene's finish (grain, black lift, halation, vignette): color.md "finish:true is a mild start".
const finish = { scene: true, ops: () => [{ op: "update_scene", properties: { finish: true } }] };
// Subject treatments: only on a shot with a face or a marked subject.
const subject = (reason, ops) => ({ hand: reason, wants: ["face"], fits: (slot) => Boolean(slot.shot.focus), ops });
const CUT_OUT = "a cut-out takes up to a minute to make, so compose leaves it to one call";

export const CARDS = {
  "punch-in": {
    wants: ["drop", "face", "strongest"],
    // 0.85 s: the move's snap 0.1, hold 0.5 and ease back 0.25 (engine/blocks/moves/camera.js).
    fits: (slot, plan) => !slot.shot.layout.loose && !slot.shot.accents?.length && room(slot) >= 0.9 && steady(slot, plan),
    ops: (slot) => [{ op: "move", name: "punch-in", id: "card-punch-in", layer: name(slot.shot), at: round3(slot.at), ...(slot.shot.focus ? { point: pct(slot.shot.focus) } : {}) }],
    // The punch holds the shot's place and size, so its slow push or drift is left out.
    claims: (slot) => { if (fill(slot.shot)) slot.shot.camera = { ...slot.shot.camera, kind: "hold" }; },
  },
  // 1 s, as check's own ready fix lays it (engine/quality/rules/referenceKinds.js overlayFix).
  "speed-lines": overlay("speed-lines", 1),
  "impact-lines": overlay("impact-lines", 1),
  // Line art for up to 2 s (a guess: long enough to read the drawing, short enough to stay an accent).
  "edge-lines": overlay("edge-lines", 2),
  // overexpose peaks on the cut (its into: peak 0.5 of 0.4 s, engine/blocks/moves/overexpose.js).
  overexpose: transition("overexpose", { lead: -0.2, fields: (slot) => ({ layer: name(slot.prev), into: name(slot.shot), dur: 0.4 }) }),
  smear: transition("smear", { fields: (slot) => ({ from: name(slot.prev), to: name(slot.shot) }) }),
  shatter: transition("shatter", { fields: (slot) => ({ from: name(slot.prev), to: name(slot.shot) }) }),
  "split-fields": {
    wants: ["drop", "strongest"], fits: (slot) => fill(slot.shot) && room(slot) >= 0.6,
    ops: (slot) => [{ op: "move", name: "split-fields", id: "card-split-fields", layer: name(slot.shot), at: round3(slot.at) }],
  },
  finish, grain: finish, vignette: finish,
  "backdrop-flash": subject(CUT_OUT, (slot) => [{ op: "move", name: "backdrop-flash", layer: name(slot.shot), at: round3(slot.at) }]),
  "rim-light": subject(CUT_OUT, (slot) => [{ op: "cut_out", layer: name(slot.shot), name: `${name(slot.shot)}-cut` }, { op: "add_animation", layer: `${name(slot.shot)}-cut`, effect: "rim-light" }]),
  outline: subject(CUT_OUT, (slot) => [{ op: "cut_out", layer: name(slot.shot), output: "outline" }]),
  "type-swap": { hand: "compose sets no text that turns into other words", wants: ["strongest"], fits: () => true,
    ops: (slot) => [{ op: "move", name: "rewrite", layer: "<a text layer>", new: "<the words it turns into>", at: round3(slot.at) }] },
  "build-in": { hand: "it builds split_image pieces, which compose does not cut", wants: ["strongest"], fits: () => true,
    ops: (slot) => [{ op: "split_image", layer: name(slot.shot), boxes: [{ name: "<part>", rect: ["<x>", "<y>", "<w>", "<h>"] }] }, { op: "move", name: "build-in", layers: [`${name(slot.shot)}-<part>`], at: round3(slot.at) }] },
};
export const CARD_NAMES = Object.freeze(Object.keys(CARDS));

/** The moments a card may go on, by kind (see the top of this file). */
function slotsOf(plan, drop) {
  const quiet = (at) => (plan.title && at >= plan.title.at - 0.05 && at < plan.title.at + plan.title.dur) || at >= plan.endCard.at - 0.3;
  // The end shot counts until its end card starts (quiet() leaves out the card's own time).
  const shots = plan.shots;
  const slot = (shot, at) => ({ shot, at: round3(at), prev: Math.abs(at - shot.start) < 1e-3 ? plan.shots[shot.n - 2] ?? null : null });
  const keep = (list) => list.filter((entry) => entry && !quiet(entry.at));
  const under = (at) => shots.find((shot) => at >= shot.start - 1e-3 && at < shot.end - 0.3);
  // A section that starts the edit is no change of section.
  const sections = (plan.song?.sections ?? []).map((part) => shots.find((shot) => shot.n > 1 && Math.abs(shot.start - part.from) <= 0.05)).filter(Boolean);
  const cuts = sections.length ? sections : shots.filter((shot) => shot.n > 1 && shot.transition?.kind === "cut");
  const body = shots.filter((shot) => shot.role === "body" || shot.role === "end");
  return {
    drop: keep([drop !== null && under(drop) ? slot(under(drop), drop) : null]),
    section: keep(cuts.map((shot) => slot(shot, shot.start))),
    face: keep(shots.filter((shot) => shot.focus && shot.end - shot.start >= 1).map((shot) => slot(shot, shot.start + Math.min(0.5, (shot.end - shot.start) * 0.25)))),
    strongest: keep([...body].sort((a, b) => (b.moment.score ?? 0) - (a.moment.score ?? 0)).map((shot) => slot(shot, shot.start + Math.min(0.5, (shot.end - shot.start) * 0.25)))),
  };
}

/**
 * Places the cards: `names` (the deck's cards compose did not build, then the ones compose {cards}
 * adds), at most one made graphic per `gap` seconds. Returns {ops, placed:[{card, at, layer}],
 * missed:[{card, why, ops}]}: missed cards carry the ready ops that build them by hand (`<...>`
 * marks a word the agent fills in).
 */
export function placeCards(plan, names, { drop = null, gap = CARD_GAP } = {}) {
  const slots = slotsOf(plan, drop);
  const ops = [], placed = [], missed = [];
  const taken = [];
  const spaced = (at) => taken.every((time) => Math.abs(time - at) >= gap - 1e-6);
  // Where a ready call points when no moment fits: the first moment, else the shot with the most
  // picture outside the title and the end card (the longest shot alone put a punch-in under the
  // end card on run 6's clips: compose-deck review probe).
  const open = plan.shots.map((shot) => {
    let from = shot.start, to = Math.min(shot.end, plan.endCard.at - 0.3);
    if (plan.title) {
      const titleEnd = plan.title.at + plan.title.dur;
      if (plan.title.at <= from + 0.05 && titleEnd > from) from = titleEnd;
      else if (plan.title.at > from && plan.title.at < to) to = plan.title.at;
    }
    return { shot, from, to };
  }).filter((span) => span.to > span.from).sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
  const firstSlot = Object.values(slots).flat()[0] ?? (open ? { shot: open.shot, at: round3(open.from + Math.min(0.5, (open.to - open.from) * 0.25)), prev: null } : null);
  for (const card of [...new Set(names)]) {
    const entry = CARDS[card];
    if (!entry) {
      missed.push({ card, why: "compose has no builder for it", ops: null });
      continue;
    }
    if (entry.scene) {
      ops.push(...entry.ops());
      placed.push({ card, at: 0, layer: "the scene" });
      continue;
    }
    const fitting = entry.wants.flatMap((kind) => slots[kind]).filter((slot) => entry.fits(slot, plan));
    if (entry.hand) {
      const at = fitting[0] ?? null;
      missed.push({ card, why: at || !entry.wants.includes("face") ? entry.hand : `${entry.hand}, and no shot shows a face or a marked subject (mark_subject first)`, ops: at || !entry.wants.includes("face") ? entry.ops(at ?? firstSlot ?? { shot: plan.shots[0], at: 0 }) : null });
      continue;
    }
    const slot = fitting.find((entry2) => spaced(entry2.at));
    if (!slot) {
      const near = fitting[0] ?? firstSlot;
      missed.push({ card, why: fitting.length ? `another made graphic is within ${gap} s of each fitting moment (cardGap sets the spacing)` : "no moment in the plan fits it", ops: near && entry.fits(near, plan) ? entry.ops(near) : null });
      continue;
    }
    entry.claims?.(slot);
    ops.push(...entry.ops(slot));
    taken.push(slot.at);
    placed.push({ card, at: slot.at, layer: name(slot.shot) });
  }
  return { ops, placed, missed };
}

/** The receipt's lines: what the deck's cards became, and one line for each card left to build by hand. */
export function cardLines(cards) {
  if (!cards) return [];
  const lines = [];
  if (cards.placed.length) lines.push(`from your deck: ${cards.placed.map((entry) => `${entry.card} at ${entry.at} s on ${entry.layer}`).join(", ")}`);
  for (const entry of cards.missed)
    lines.push(`not placed: ${entry.card} (${entry.why}): ${entry.ops ? `edit ${JSON.stringify({ ops: entry.ops })}` : `library {topic:"search", search:"${entry.card}"}`}`);
  return lines;
}
