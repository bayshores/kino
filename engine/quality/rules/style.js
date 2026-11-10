// Style warnings about the edit as a whole: what techniques (engine/techniques.js) it uses and how
// it is paced. They catch the "basic edit" an agent makes by default: text slides on a plain
// background (text_slides), a flat edit with no designed device at all (few_techniques), one
// move used on nearly everything (technique_repeat; a device repeated 2 or 3 times is a motif), cuts like a metronome (metronome), the same scale kick on every beat
// (beat_kick), cuts with no reason to fall where they do (cut_motivation) and sections that all
// feel the same (flat_sections). With a style spec on the brief
// (engine/styleSpec.js), style_avoided warns about a technique the spec avoids and style_wanted
// about one it wants that the video does not use. With a deck (engine/deck.js), deck_unused warns
// when the video uses fewer than half of its cards.
//
// Every fix hint names concrete techniques from the vocabulary, never "add motion".
import { CUT_TIMING_TAGS, PLAIN_TAGS, TECHNIQUES, isTechnique, techniqueOf } from "../../techniques.js";
import { deckUse } from "../../deck.js";
import { boardPicks, pickOp, pickWords } from "../../movePicks.js";
import { heardEdges, heardWords } from "./speech.js";
import { designedTexts, readableAt, primaryItems, scaleOf, sec, sections, speedAt } from "../analysis.js";
import { area, boxAt, intersection, tintsAt, movingAt, tweensOf, visibleBoxAt } from "../model.js";
import { backgroundLuma, coveredAt, plateChanges, plates, pulses, techniquesUsed, textEntrances, transitions } from "../techniques.js";

const FRAME = (model) => ({ x0: 0, y0: 0, x1: model.width, y1: model.height });
// The share of the frame the item is seen in (a masked video counts by its tile).
const frameShare = (model, item, index) => area(intersection(visibleBoxAt(model, item, index), FRAME(model))) / (model.width * model.height);
const percent = (value) => `${Math.round(value * 100)}%`;
// A title card or a logo sting shorter than this is one moment, not an edit: text_slides and
// few_techniques leave it alone.
const EDIT_SECONDS = 8;
const CAMERA_KEYS = new Set(["x", "y", "scaleX", "scaleY", "rotation", "width", "height"]);
// A wanted tag the spec backs (a reference or the person's words): the rules leave it alone.
const wanted = (ctx, tag) => Boolean(ctx.style?.backed?.includes(tag));

// The techniques suggested first in each group: ones that change how a video feels without a
// set piece. The rest of the vocabulary follows in its own order.
const FIRST_PICKS = {
  transition: ["dissolve", "blur-through", "zoom-through", "mask-wipe", "whip-pan", "push-transition"],
  camera: ["drift", "parallax", "slow-push", "speed-ramp"],
  type: ["type-words", "type-mask-rise", "type-blur-in", "type-giant", "type-swap"],
  texture: ["depth-blur", "light-sweep", "motion-blur", "particles"],
  // For the signature beat: set pieces that show the product doing its one thing.
  "set-piece": ["screen-zoom", "device-in-scene", "draw-on", "logo-match-move", "split-screen"],
};

/**
 * Techniques to suggest, as "tag (fits when)" joined by "; ": the spec's wanted ones not used yet
 * first (its moments' set pieces too), then one unused technique from each group, the groups the
 * video uses least first. With a signature and no set piece used yet, a set piece comes first.
 */
function suggestions(ctx, used, count = 3, groups = ["transition", "camera", "type", "texture"], skip = []) {
  const setPieceUsed = TECHNIQUES.some((entry) => entry.group === "set-piece" && used[entry.tag]);
  if (ctx.style?.signatures?.length && !setPieceUsed) groups = ["set-piece", ...groups];
  const wantedTags = [...(ctx.style?.moments ?? []).map((moment) => moment.tag), ...(ctx.style?.wants ?? [])];
  const picks = [...new Set(wantedTags)].filter((tag) => !used[tag] && techniqueOf(tag)?.detect && !skip.includes(tag));
  const usedIn = (group) => TECHNIQUES.filter((entry) => entry.group === group && used[entry.tag] && !PLAIN_TAGS.includes(entry.tag)).length;
  const ordered = [...groups].sort((a, b) => usedIn(a) - usedIn(b));
  const free = (tag) => techniqueOf(tag)?.detect && techniqueOf(tag).deal !== false && !used[tag] && !PLAIN_TAGS.includes(tag) && !ctx.style?.avoids?.includes(tag) && !skip.includes(tag);
  for (const group of ordered) {
    const pool = [...(FIRST_PICKS[group] ?? []), ...TECHNIQUES.filter((entry) => entry.group === group).map((entry) => entry.tag)];
    const pick = pool.find((tag) => free(tag) && !picks.includes(tag));
    if (pick) picks.push(pick);
  }
  return [...new Set(picks)].slice(0, count).map((tag) => `${tag} (${techniqueOf(tag).fits})`).join("; ");
}

// ---------------------------------------------------------------- text_slides

/**
 * True at a sample where something other than text moves on screen: a playing clip, particles, or
 * a large picture or shape that moves, scales or fades (a camera move). Text moving by itself does
 * not count: kinetic type on a flat card is still a card.
 */
function pictureMoves(model, index) {
  if (index === 0) return false;
  for (const item of model.items) {
    if (item.isMask || item.kind === "text" || item.samples.opacity[index] < 0.3 || coveredAt(model, item, index)) continue;
    if (item.kind === "group") continue;
    const share = frameShare(model, item, index);
    if ((item.kind === "video" || item.samples.moving?.[index]) && share >= 0.08) return true;
    if (share < 0.25) continue;
    // A move or scale running on it (or a group it is in): the slow ends of an eased push count too.
    if (movingAt(model, item, model.times[index], { keys: CAMERA_KEYS })) return true;
    const { x0, y0, x1, y1, opacity } = item.samples;
    const step = index - 1;
    if (Math.abs(x0[index] - x0[step]) > 0.2 || Math.abs(y0[index] - y0[step]) > 0.2 || Math.abs(x1[index] - x1[step]) > 0.2
      || Math.abs(y1[index] - y1[step]) > 0.2 || Math.abs(opacity[index] - opacity[step]) > 0.01) return true;
  }
  return false;
}

// A clip blurred this much (px at 1080p) or more is a backdrop, as in blurred_backdrop.
const BACKDROP_BLUR = 8;
// A sharp picture covering this share of the frame in front of the blur is the shot: the blur is its fill.
const SHARP_SHARE = 0.2;

/**
 * True at a sample where the footage is wallpaper, not a shot: a dark full-frame tint over it
 * (tintsAt), or a full-frame clip blurred BACKDROP_BLUR px or more (unless `blur` is false: a spec
 * that wants depth-blur), each with no sharp picture covering SHARP_SHARE of the frame in front.
 * fp-8 typed its prompt over a log both blurred and dimmed, and the judges read it as a card.
 */
function backdropAt(model, index, { blur = true } = {}) {
  const s = scaleOf(model);
  const blurOf = (item) => Math.max(item.samples.blur?.[index] ?? 0, item.blur ?? 0);
  const pictures = model.items.filter((item) => (item.kind === "video" || item.kind === "image") && !item.isMask
    && item.samples.opacity[index] >= 0.5 && !coveredAt(model, item, index));
  // A floating screen over the dimmed or blurred footage is the shot: the backdrop is its fill.
  const sharpAbove = (z) => pictures.some((front) => front.z > z && blurOf(front) <= 2 * s && frameShare(model, front, index) >= SHARP_SHARE);
  if (tintsAt(model, index).some((tint) => !sharpAbove(tint.z))) return true;
  return blur && pictures.some((back) => back.kind === "video" && blurOf(back) >= BACKDROP_BLUR * s && frameShare(model, back, index) >= 0.9
    && !sharpAbove(back.z));
}

// A line typing on letter by letter or word by word is read while it types (as reading_time
// counts it): fp-8's prompt typed for 3.5 s and was readable for 0.1 s of it. Hidden, it is not.
function typingAt(model, item, index) {
  const time = model.times[index];
  const tweens = tweensOf(model, item.id);
  return tweens.some((tween) => tween.kind === "in" && tween.unit !== "layer" && tween.spread > 0 && tween.keys.includes("opacity")
    && tween.start <= time && time < tween.end && !tweens.some((hide) => hide.kind === "hide" && hide.start > tween.start && hide.start <= time));
}

/**
 * The samples where text being read (or typing on) sits over a still picture, a flat color or
 * footage dimmed or blurred to a backdrop (backdropAt): a text slide. The voice's captions are no
 * slide: they read along with what is said. A spec that wants depth-blur (as blurred_backdrop
 * backs off) keeps blurred footage a shot.
 */
export function textSlideSamples(model, ctx = {}) {
  const texts = designedTexts(model);
  const slide = new Uint8Array(model.times.length);
  const backdrop = { blur: !wanted(ctx, "depth-blur") };
  for (let index = 0; index < model.times.length; index += 1) {
    const reading = texts.some((item) => (readableAt(model, item, index) || typingAt(model, item, index)) && !coveredAt(model, item, index));
    if (reading && (!pictureMoves(model, index) || backdropAt(model, index, backdrop))) slide[index] = 1;
  }
  return slide;
}

// A text card held still longer than this (the closing card aside) reads as a slide by itself.
const LONGEST_CARD = 3;
// This many cards (the closing one aside) of CARD_SECONDS or more read as a slideshow however
// short each is: fp-7 cut three 1.7 s lines on black between its shots.
const MOST_CARDS = 3;
const CARD_SECONDS = 1.2;
// Text over full-frame footage blurred to a backdrop is itself a card (backdropAt): never the fix.
const NOT_FOR_SLIDES = ["depth-blur"];

export function textSlides(model, ctx) {
  if (!designedTexts(model).length || model.duration < EDIT_SECONDS) return [];
  const slide = textSlideSamples(model, ctx);
  const count = slide.reduce((sum, value) => sum + value, 0);
  const share = count / model.times.length;
  // The runs of slide samples (cards); the one that runs to the end is the closing card.
  const cards = [];
  for (let index = 0, from = -1; index <= slide.length; index += 1) {
    if (index < slide.length && slide[index]) { if (from < 0) from = index; continue; }
    if (from >= 0) cards.push({ from, length: index - from, closing: index === slide.length });
    from = -1;
  }
  const seconds = (card) => card.length / model.fps;
  const held = cards.filter((card) => !card.closing && seconds(card) > LONGEST_CARD);
  const titled = cards.filter((card) => !card.closing && seconds(card) >= CARD_SECONDS);
  if (share <= 0.25 && !held.length && titled.length < MOST_CARDS) return [];
  const longest = (held.length ? held : cards).reduce((best, card) => (card.length > best.length ? card : best));
  const used = techniquesUsed(model);
  return [{
    rule: "text_slides", severity: "warn", at: sec(model.times[longest.from]), until: sec(model.times[longest.from + longest.length - 1]),
    measured: `${percent(share)} of the video is text over a still, flat or dimmed background, in ${cards.length} ${cards.length === 1 ? "card" : "cards"} (longest ${sec(seconds(longest))}s)`,
    required: `at most 25%, no card held over ${LONGEST_CARD}s and fewer than ${MOST_CARDS} cards of ${CARD_SECONDS}s or more, the closing one aside`,
    message: `For ${sec(count / model.fps)}s of ${sec(model.duration)}s, ${ctx.sceneName} shows text over a picture that does not move or is dimmed to a backdrop (${cards.slice(0, 4).map((card) => `${sec(model.times[card.from])}s for ${sec(seconds(card))}s`).join(", ")}): it reads as slides.`,
    fix: { kind: "hint", text: `Put the words over moving footage at full strength or move the frame: ${suggestions(ctx, used, 3, ["camera", "texture", "type"], NOT_FOR_SLIDES)}.` },
  }];
}

// ---------------------------------------------------------------- few_techniques

// Restraint (engine/quality/rules/restraint.js, busy_edit): a pro edit is mostly plain cuts with one
// or two signature devices repeated as a motif. So this rule only catches a flat edit, with no
// designed device at all: one under 70 s needs one, a longer film two, at most 4.
/** The number of distinct designed techniques a video of this length should show: 1 under 70 s, then slowly more (4 at most). */
export const techniquesWanted = (duration) => Math.max(1, Math.min(4, Math.round(Math.sqrt(Math.max(1, duration) / 30))));

export function fewTechniques(model, ctx) {
  if (model.duration < EDIT_SECONDS) return [];
  const used = techniquesUsed(model);
  const designed = Object.keys(used).filter((tag) => !PLAIN_TAGS.includes(tag) && !CUT_TIMING_TAGS.includes(tag));
  const required = techniquesWanted(model.duration);
  if (designed.length >= required) return [];
  return [{
    rule: "few_techniques", severity: "warn",
    measured: `${designed.length} designed ${designed.length === 1 ? "technique" : "techniques"}${designed.length ? ` (${designed.join(", ")})` : ""}`, required: `at least ${required} for ${sec(model.duration)}s`,
    message: `${ctx.sceneName} uses ${designed.length ? designed.join(", ") : "only cuts and plain text"}; a ${sec(model.duration)}s video needs ${required === 1 ? "one signature device" : `${required} signature devices`}, repeated as a motif at alike moments, to read as designed rather than flat.`,
    fix: { kind: "hint", text: `Add ${required === 1 ? "one device" : "devices"} and repeat ${required === 1 ? "it" : "them"} at alike moments (the hook, the turn, the payoff), where they fit: ${suggestions(ctx, used)}. Keep the other shots plain cuts. library {topic:"techniques"} lists them all.` },
  }];
}

// ---------------------------------------------------------------- plain_beats

// Craft plan section 3, with restraint: a pro edit cuts most shots plainly on the voice or the
// beat, and that is right. Only the key beats need emphasis: the hook (the first shot), the
// reveal (engine/movePicks.js shotRoles) and the payoff (the last). A key beat whose only contents
// are footage, words and plain changes (a cut, a fade, a blur, a freeze, captions word by word)
// gets a warning; these tags do not make a beat designed, every other technique kino finds does.
export const PLAIN_BEAT_TAGS = Object.freeze([...PLAIN_TAGS, ...CUT_TIMING_TAGS, "dissolve", "fade-black", "type-fade", "type-words", "blur-through", "freeze-frame"]);
// With no board, the video is judged in windows of this length: the first is the hook, the last the payoff.
const BEAT_WINDOW = 2.5;
// A technique this close outside a beat (a transition on its cut) still belongs to it.
const BEAT_EDGE = 0.25;
// Two kino moves for each kind of board move (engine/board.js MOVE_KINDS), named in the fix.
export const BEAT_MOVES = Object.freeze({
  type: ["masked-type", "push-through-type"],
  transition: ["zoom-through", "whip-pan"],
  camera: ["parallax-stack", "window-punch-in"],
  ui: ["lift-focus", "swipe-cards"],
});
const BEAT_KINDS = Object.keys(BEAT_MOVES);
// The kind of move named for a key beat that plans none.
const ROLE_KINDS = Object.freeze({ hook: "camera", reveal: "transition", payoff: "type" });

// The key beats to judge: the board's hook, reveal and payoff shots (ctx.board, cue and dur)
// inside the video, else the first and last 2.5 s windows.
function keyBeatsOf(model, ctx) {
  const shots = (ctx.board ?? []).filter((shot) => Number.isFinite(shot.cue) && shot.dur > 0 && shot.cue < model.duration);
  if (shots.length) {
    // Each key shot is offered the moves that fit what it holds, the board's own device first (engine/movePicks.js).
    const picks = boardPicks(shots, ctx.mediaNames ?? {});
    return shots.flatMap((shot, index) => (picks[index].role
      ? [{ from: shot.cue, to: Math.min(model.duration, shot.cue + shot.dur), n: index + 1, role: picks[index].role, kind: shot.move?.kind, fits: picks[index] }] : []));
  }
  const count = Math.max(1, Math.floor(model.duration / BEAT_WINDOW));
  const window = (index, role) => ({ from: index * BEAT_WINDOW, to: index === count - 1 ? model.duration : (index + 1) * BEAT_WINDOW, role });
  return count > 1 ? [window(0, "hook"), window(count - 1, "payoff")] : [window(0, "hook")];
}

// True when footage (a clip or picture of 25% of the frame or more) is seen in the beat and no
// graphic moves in it: a beat of pure motion graphics is not plain. A camera move on the footage
// itself (a slow push, drift or parallax over the whole shot) makes every beat it covers
// designed, not only the one where techniquesUsed saw it start.
function footageOnly(model, from, to) {
  let footage = false;
  for (let index = 0; index < model.times.length; index += 1) {
    const time = model.times[index];
    if (time < from || time >= to) continue;
    for (const item of model.items) {
      if (item.isMask || item.kind === "text" || item.kind === "group" || item.kind === "audio" || item.source?.sceneBackground) continue;
      if (item.samples.opacity[index] < 0.3 || coveredAt(model, item, index)) continue;
      if (item.kind === "video" || item.kind === "image") {
        if (frameShare(model, item, index) < 0.25) continue;
        if (movingAt(model, item, time, { keys: CAMERA_KEYS })) return false;
        footage = true;
        continue;
      }
      if (frameShare(model, item, index) >= 0.02 && (item.samples.moving?.[index] || movingAt(model, item, time, { keys: CAMERA_KEYS }))) return false;
    }
  }
  return footage;
}

export function plainBeats(model, ctx) {
  if (model.duration < EDIT_SECONDS) return [];
  const used = techniquesUsed(model);
  const designed = Object.entries(used).filter(([tag]) => !PLAIN_BEAT_TAGS.includes(tag)).flatMap(([tag, list]) => list.map((use) => ({ tag, at: use.at })));
  const keys = keyBeatsOf(model, ctx).map((beat) => ({ ...beat,
    plain: !designed.some((use) => use.at >= beat.from - BEAT_EDGE && use.at <= beat.to + BEAT_EDGE) && footageOnly(model, beat.from, beat.to) }));
  const plain = keys.filter((beat) => beat.plain);
  if (!plain.length) return [];
  // Every key beat plain: the video never lands a designed moment, so the first one holds a final render.
  const gate = plain.length === keys.length;
  // The device the video already uses most: a plain key beat reuses it (a motif), not a new move.
  const counts = designed.reduce((all, use) => all.set(use.tag, (all.get(use.tag) ?? 0) + 1), new Map());
  const signature = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const name = (beat) => `the ${beat.role} (${beat.n ? `shot ${beat.n}` : `${sec(beat.from)}-${sec(beat.to)}s`}${beat.fits ? `, ${beat.fits.word}` : ""})`;
  const hint = (beat) => {
    const fits = (beat.fits?.picks ?? []).filter((entry) => entry.kind !== "cut");
    if (fits.length && !BEAT_KINDS.includes(beat.kind)) {
      const [one, two] = fits;
      return `Build ${name(beat)} with ${pickWords(one)}${two ? ` or ${pickWords(two)}` : ""} (edit {ops:[${pickOp(one)}]}; library {topic:"moves"}).`;
    }
    if (!beat.kind && signature) return `Reuse ${signature}, the device this video already uses, on ${name(beat)}: repeat it as a motif rather than add a new move.`;
    const kind = BEAT_KINDS.includes(beat.kind) ? beat.kind : ROLE_KINDS[beat.role];
    const [one, two] = BEAT_MOVES[kind];
    return `Build ${name(beat)} with a designed ${kind} move: ${one} or ${two} (edit {ops:[{op:"move", name:"${one}", ...}]}; library {topic:"op", name:"move"}).`;
  };
  return plain.map((beat, index) => {
    const finding = {
      rule: "plain_beats", severity: "warn", at: sec(beat.from), until: sec(beat.to),
      measured: `${sec(beat.to - beat.from)}s of footage and words with no designed move at the ${beat.role}${gate ? ` (no key beat has one)` : ""}`,
      required: "a designed move on the hook, reveal or payoff, at least one at a final render; plain cuts elsewhere are right",
      message: `${ctx.sceneName}'s ${beat.role} (${sec(beat.from)}s to ${sec(beat.to)}s) is only footage, words and a plain cut: the moment that needs emphasis gets none.`,
      fix: { kind: "hint", text: hint(beat) },
    };
    // The first carries the final-render gate when no key beat is designed.
    return gate && index === 0 ? { ...finding, final: true } : finding;
  });
}

// ---------------------------------------------------------------- technique_repeat

// Restraint (busy_edit) asks for one or two signature devices repeated as a motif, so a device
// used up to MOTIF times is right. Only true monotony warns: a set piece past MOTIF uses, one
// non-cut transition on nearly every change with no plain cut at all, a loud accent past MOTIF
// (or one per 15 s), the same slide past MOTIF, one entrance on most texts. Plain cuts never count.
const MOTIF = 3;
// Techniques that are loud, so they wear out: at most MOTIF, or one per 15 s.
const ACCENTS = ["glitch-hit", "flash", "rgb-split", "shake", "zoom-through", "whip-pan"];
// One transition on this share of the changes or more (and no plain cut) is nearly every one.
const NEARLY_ALL = 0.75;
// The same literal move (one slide, one distance) more often than this reads as a loop.
const MOVE_REPEATS = MOTIF;
// Slides this close together are one staggered gesture.
const MOVE_STAGGER = 1;

export function techniqueRepeat(model, ctx) {
  const used = techniquesUsed(model);
  const findings = [];
  // The style bible's moments (style.moments) are designed one-off set pieces: each one leaves out
  // one use of its tag, the one in (or nearest) its spine beat, the first when the beat has no
  // time. The other uses still count.
  const spine = ctx.style?.spine ?? [];
  const counted = (tag, list) => {
    const left = [...list];
    for (const moment of (ctx.style?.moments ?? []).filter((entry) => entry.tag === tag)) {
      if (!left.length) break;
      const beat = spine[moment.beat];
      const timed = Number.isFinite(beat?.from) && Number.isFinite(beat?.to);
      const away = (use) => (timed ? Math.max(0, beat.from - use.at, use.at - beat.to) : 0);
      left.splice(left.reduce((best, use, index) => (away(use) < away(left[best]) ? index : best), 0), 1);
    }
    return left;
  };
  const finding = (tag, measured, required, message, hint, at) => findings.push({
    rule: "technique_repeat", severity: "warn", ...(at != null ? { at: sec(at) } : {}), measured, required, message,
    fix: { kind: "hint", text: hint },
  });
  // A set piece repeated at alike moments (2 or 3 times) is a motif; past that it is monotony.
  for (const entry of TECHNIQUES.filter((technique) => technique.group === "set-piece")) {
    const list = counted(entry.tag, used[entry.tag] ?? []);
    if (list.length > MOTIF && !wanted(ctx, entry.tag))
      finding(entry.tag, `${entry.tag} ${list.length} times`, `a set piece at most ${MOTIF} times (a motif)`, `${entry.tag} happens ${list.length} times (${list.map((use) => `${use.at}s`).join(", ")}); a set piece on that many shots stops being a moment.`, `Keep ${entry.tag} for the ${MOTIF} alike moments that matter (the hook, the turn, the payoff) and make the other shots plain cuts.`, list[MOTIF].at);
  }
  // One non-cut transition on nearly every shot change, with no plain cut at all. A plain cut is
  // never a repeated transition, and a transition kept for a few alike changes is a motif.
  const changes = transitions(model).filter((change) => change.tag);
  const plainCuts = changes.filter((change) => change.tag === "cut").length;
  if (changes.length > MOTIF && !plainCuts) {
    for (const tag of new Set(changes.map((change) => change.tag))) {
      const list = counted(tag, changes.filter((change) => change.tag === tag));
      const count = list.length;
      if (count <= MOTIF || count / changes.length < NEARLY_ALL || wanted(ctx, tag)) continue;
      finding(tag, `${tag} at ${count} of ${changes.length} shot changes, no plain cut`, `plain cuts at most changes; one transition at ${MOTIF} alike changes at most, or under ${Math.round(NEARLY_ALL * 100)}%`, `${count} of the ${changes.length} shot changes in ${ctx.sceneName} are ${tag} and none is a plain cut; one transition everywhere reads as a template.`, `Cut most changes plainly on an action, the voice or the beat, and keep ${tag} as the motif for the 2 or 3 changes that mean something.`, list[0].at);
    }
  }
  // Loud accents used past their budget.
  const budget = Math.max(MOTIF, Math.round(model.duration / 15));
  for (const tag of ACCENTS) {
    const list = counted(tag, used[tag] ?? []);
    if (list.length <= budget || wanted(ctx, tag)) continue;
    finding(tag, `${tag} ${list.length} times`, `at most ${budget} in ${sec(model.duration)}s`, `${tag} happens ${list.length} times in ${ctx.sceneName}; an accent that comes back often stops landing.`, `Keep ${tag} for the ${budget} biggest hits; elsewhere cut plainly on the voice or the beat.`, list[budget].at);
  }
  // One literal move over and over: a picture or card sliding the same way, the same distance
  // (its way in and its way out count as one move), on any layer.
  const moves = new Map();
  // The raw animations (ctx.scene) hold where a slide starts and ends; samples miss its ends.
  const layers = new Map((ctx.scene?.layers ?? []).map((layer) => [layer.id, layer]));
  for (const item of model.items) {
    if (item.kind === "text" || item.kind === "audio" || item.isMask || item.perpetual || item.loops) continue;
    const layer = layers.get(item.source?.layerId);
    for (const tween of tweensOf(model, item.id)) {
      if (!(tween.duration > 0) || !tween.keys.some((key) => key === "x" || key === "y") || tween.keys.some((key) => key.startsWith("scale") || key === "width")) continue;
      const animation = layer?.animations?.find((entry) => entry.id === tween.source?.animationId);
      if (!animation) continue;
      const delta = (key) => (animation.to?.[key] ?? layer[key] ?? 0) - (animation.from?.[key] ?? layer[key] ?? 0);
      const [dx, dy] = [delta("x"), delta("y")];
      const a = boxAt(item, Math.min(model.times.length - 1, Math.round(tween.start * model.fps)));
      const step = 0.05 * Math.min(model.width, model.height);
      if (Math.hypot(dx, dy) < 2 * step) continue;
      const key = `${Math.abs(dx) >= Math.abs(dy) ? "x" : "y"}|${Math.round(Math.hypot(dx, dy) / step)}|${Math.round((a.x1 - a.x0) / step)}x${Math.round((a.y1 - a.y0) / step)}`;
      if (!moves.has(key)) moves.set(key, []);
      moves.get(key).push({ at: tween.start, item });
    }
  }
  for (const all of moves.values()) {
    // Slides starting within MOVE_STAGGER of the one before are one staggered gesture
    // (a row of cards rising together), not a repeat.
    const list = all.sort((a, b) => a.at - b.at).filter((use, index, sorted) => index === 0 || use.at - sorted[index - 1].at >= MOVE_STAGGER);
    if (list.length <= MOVE_REPEATS) continue;
    finding("move", `the same slide ${list.length} times (${list.slice(0, 6).map((use) => `${sec(use.at)}s`).join(", ")})`, `at most ${MOVE_REPEATS}`, `${ctx.name(list[0].item)} and its copies make the same slide ${list.length} times in ${ctx.sceneName}; a move seen that often reads as a loop.`, `Keep the slide for the ${MOVE_REPEATS} moments that matter; let the others cut in or hold.`, list[MOVE_REPEATS].at);
  }
  // The same entrance on most texts (a text that cuts in is the plain default, not counted).
  const entries = textEntrances(model).filter((entry) => entry.tag);
  if (entries.length >= 5) {
    for (const tag of new Set(entries.map((entry) => entry.tag))) {
      const list = counted(tag, entries.filter((entry) => entry.tag === tag));
      const count = list.length;
      if (tag === "type-cut" || count / entries.length < 0.75 || wanted(ctx, tag)) continue;
      finding(tag, `${tag} on ${count} of ${entries.length} texts`, "one entrance on under 75% of texts", `${count} of ${entries.length} texts in ${ctx.sceneName} enter with ${tag}.`, `Let most text cut in with the picture and keep ${tag} for the key lines, so the words keep one look.`, list[0].at);
    }
  }
  return findings;
}

// ---------------------------------------------------------------- metronome

/** The times the shot changes: full-frame picture changes and content cuts, from 0 to the end. */
export function shotBounds(model) {
  const times = [0, ...plateChanges(model).map((change) => change.at), ...(techniquesUsed(model).cut ?? []).map((entry) => entry.at), model.duration].sort((a, b) => a - b);
  const bounds = [];
  for (const time of times) if (!bounds.length || time - bounds.at(-1) >= 0.3) bounds.push(time);
  if (model.duration - bounds.at(-1) > 1e-6) bounds.push(model.duration);
  return bounds;
}

const spread = (values) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return { mean, ratio: mean ? deviation / mean : 0 };
};

export function metronome(model, ctx) {
  const bounds = shotBounds(model);
  const lengths = bounds.slice(1).map((time, index) => time - bounds[index]);
  const findings = [];
  const hint = "Vary shot lengths in waves: let one shot hold twice as long, run a few quick ones, and move a cut off the beat (syncopated) or onto an action; a dissolve or match cut can join two shots without a count.";
  if (lengths.length >= 5) {
    const { mean, ratio } = spread(lengths);
    if (ratio < 0.2) findings.push({
      rule: "metronome", severity: "warn", measured: `${lengths.length} shots of ${sec(mean)}s ± ${percent(ratio)}`, required: "lengths spread by 20% or more",
      message: `The ${lengths.length} shots of ${ctx.sceneName} all last about ${sec(mean)}s; an even count feels mechanical.`, fix: { kind: "hint", text: hint },
    });
  }
  if (!findings.length && model.rhythm?.bpm > 0) {
    const beat = 60 / model.rhythm.bpm;
    const frame = 1 / (ctx.outputFps ?? 30);
    const cutTimes = bounds.slice(1, -1);
    if (cutTimes.length >= 6) {
      const beatsOf = (time) => (time - (model.rhythm.offset ?? 0)) / beat;
      const onBeat = cutTimes.filter((time) => Math.abs(beatsOf(time) - Math.round(beatsOf(time))) * beat <= frame + 1e-3);
      const gaps = cutTimes.slice(1).map((time, index) => Math.round(beatsOf(time)) - Math.round(beatsOf(cutTimes[index])));
      const counts = {};
      for (const gap of gaps) counts[gap] = (counts[gap] ?? 0) + 1;
      const [gap, common] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
      if (onBeat.length / cutTimes.length >= 0.9 && common / gaps.length >= 0.7) findings.push({
        rule: "metronome", severity: "warn", measured: `${onBeat.length} of ${cutTimes.length} cuts on the beat, ${common} of ${gaps.length} every ${gap} beats`, required: "cuts that vary their count",
        message: `Nearly every cut in ${ctx.sceneName} lands on the beat, every ${gap} beats; the edit ticks like a metronome.`, fix: { kind: "hint", text: hint },
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- cut_motivation

// A video needs this many cuts before cut_motivation judges it, and warns over this share of
// unmotivated ones.
const MOTIVATED_MIN_CUTS = 8;
const UNMOTIVATED_SHARE = 0.4;
// A cut on a moving layer's peak: this close to the time its box moves fastest, at 5% of the
// frame width a second or more.
const PEAK_NEAR = 0.1;
const PEAK_SPEED = 0.05;
// A pause in a voice this long or longer is a sentence edge a cut may sit in.
const SPEECH_PAUSE = 0.25;

// When each moving layer's box moves fastest, once per tween: [time].
function motionPeaks(model) {
  const peaks = [];
  const { times } = model;
  for (const item of model.items) {
    const { x0, y0, x1, y1 } = item.samples ?? {};
    if (!x0) continue;
    for (const tween of tweensOf(model, item.id)) {
      if (!tween.keys.some((key) => !/opacity|visible|color|fill|effect/.test(key))) continue;
      let best = null;
      for (let index = 1; index < times.length; index += 1) {
        if (times[index] < tween.start || times[index] > tween.end) continue;
        const step = times[index] - times[index - 1];
        if (!(step > 0) || !(item.samples.opacity?.[index] > 0.05)) continue;
        const rate = (Math.abs(x0[index] - x0[index - 1]) + Math.abs(x1[index] - x1[index - 1]) + Math.abs(y0[index] - y0[index - 1]) + Math.abs(y1[index] - y1[index - 1])) / 2 / step / model.width;
        if (!best || rate > best.rate) best = { rate, time: times[index] - step / 2 };
      }
      if (best && best.rate >= PEAK_SPEED) peaks.push(best.time);
    }
  }
  return peaks;
}

/**
 * Why each cut falls where it does: "beat" (within a frame of the beat or half-beat grid, or a beat, onset or
 * marker cue), "speech" (on a heard word's edge, or inside a pause), "motion" (on a moving
 * layer's peak) or "none". [{at, why}]
 */
export function cutReasons(model, ctx) {
  const frame = 1 / (ctx.outputFps ?? 30) + 1e-3;
  const cueTimes = [...(ctx.cues ?? []), ...(ctx.beatCues ?? [])].map((cue) => cue.time).filter(Number.isFinite);
  // The grid in half beats: a cut on the "and" is syncopated, a technique (techniquesUsed), not loose.
  const half = model.rhythm?.bpm > 0 ? 30 / model.rhythm.bpm : null;
  const offset = model.rhythm?.offset ?? 0;
  const onBeat = (time) => cueTimes.some((cue) => Math.abs(cue - time) <= frame)
    || (half != null && Math.abs((time - offset) / half - Math.round((time - offset) / half)) * half <= frame);
  const words = heardEdges(ctx).filter((edge) => edge.words?.length).flatMap((edge) => heardWords(edge)).sort((a, b) => a.start - b.start);
  const pauses = words.slice(1).map((word, index) => ({ from: words[index].end, to: word.start })).filter((gap) => gap.to - gap.from >= SPEECH_PAUSE);
  const onSpeech = (time) => words.some((word) => Math.abs(word.start - time) <= frame || Math.abs(word.end - time) <= frame)
    || pauses.some((gap) => time >= gap.from - 0.1 && time <= gap.to + 0.1);
  const peaks = motionPeaks(model);
  const onMotion = (time) => peaks.some((peak) => Math.abs(peak - time) <= PEAK_NEAR);
  return shotBounds(model).slice(1, -1).map((at) => ({ at: sec(at), why: onBeat(at) ? "beat" : onSpeech(at) ? "speech" : onMotion(at) ? "motion" : "none" }));
}

/** cut_motivation: over 40% of the cuts in a video of 8 or more fall on no beat, word or motion peak. */
export function cutMotivation(model, ctx) {
  const reasons = cutReasons(model, ctx);
  if (reasons.length < MOTIVATED_MIN_CUTS) return [];
  const loose = reasons.filter((reason) => reason.why === "none");
  if (loose.length / reasons.length <= UNMOTIVATED_SHARE) return [];
  const count = (why) => reasons.filter((reason) => reason.why === why).length;
  return [{
    rule: "cut_motivation", severity: "warn", at: loose[0].at,
    measured: `${loose.length} of ${reasons.length} cuts unmotivated (beat ${count("beat")} · speech ${count("speech")} · motion ${count("motion")})`, required: `at most ${Math.round(UNMOTIVATED_SHARE * 100)}% of cuts on no beat, word edge or motion peak`,
    message: `${loose.length} of ${reasons.length} cuts in ${ctx.sceneName} fall on no beat, word edge or motion peak (first at ${loose.slice(0, 4).map((reason) => `${reason.at}s`).join(", ")}); they read as arbitrary.`,
    fix: { kind: "hint", text: "Move each loose cut onto a beat or half beat (set_cue or the rhythm), the end of a spoken line, or the fastest point of a move (cut on action)." },
  }];
}

// ---------------------------------------------------------------- beat_kick

export function beatKick(model, ctx) {
  const list = pulses(model);
  if (list.length < 6) return [];
  // The most common pulse size (to the percent).
  const bySize = {};
  for (const pulse of list) (bySize[pulse.amount] ??= []).push(pulse);
  const same = Object.values(bySize).sort((a, b) => b.length - a.length)[0];
  if (same.length < 6) return [];
  let onBeats = "";
  if (model.rhythm?.bpm > 0) {
    const beat = 60 / model.rhythm.bpm;
    const near = same.filter((pulse) => { const beats = (pulse.at - (model.rhythm.offset ?? 0)) / beat; return Math.abs(beats - Math.round(beats)) * beat <= 0.07; });
    onBeats = `, ${near.length} on the beat`;
  }
  return [{
    rule: "beat_kick", severity: "warn", at: sec(same[0].at), measured: `the same ${percent(same[0].amount)} pulse ${same.length} times${onBeats}`, required: "at most 5 alike",
    message: `${ctx.sceneName} pulses by ${percent(same[0].amount)} ${same.length} times (${same.slice(0, 4).map((pulse) => `${sec(pulse.at)}s`).join(", ")}${same.length > 4 ? ", …" : ""}); a kick on every hit becomes a tic.`,
    fix: { kind: "hint", text: "Keep a kick for the 2 or 3 biggest hits; on the others let the picture do something else: a cut, a speed-ramp, a type-swap or a push-transition." },
  }];
}

// ---------------------------------------------------------------- flat_sections

// What a section is like: how often it cuts, how much moves (mean motionEnergy), how bright or what
// kind of picture it is, and how large the main thing is.
function sectionLook(model, section, bounds) {
  const from = Math.round(section.start * model.fps);
  const to = Math.min(model.times.length - 1, Math.round(section.end * model.fps) - 1);
  const length = Math.max(1e-6, section.end - section.start);
  const cutsInside = bounds.filter((time) => time > section.start + 0.3 && time < section.end - 0.3).length;
  let moving = 0;
  const kinds = {};
  const sizes = [];
  for (let index = from; index <= to; index += 1) {
    moving += motionEnergy(model, index);
    let top = null;
    for (const plate of plates(model)) if (plate.samples.opacity[index] >= 0.9 && (!top || plate.z > top.z)) top = plate;
    // No plate: the scene background shows.
    const luma = top ? top.samples.luma[index] : backgroundLuma(model, index);
    const kind = top && (top.kind === "video" || top.kind === "image") ? "footage" : Number.isFinite(luma) ? (luma < 0.2 ? "dark" : luma > 0.6 ? "light" : "mid") : "color";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    let largest = 0;
    for (const item of primaryItems(model)) if (item.samples.opacity[index] >= 0.5 && !coveredAt(model, item, index)) largest = Math.max(largest, frameShare(model, item, index));
    sizes.push(largest || 1);
  }
  sizes.sort((a, b) => a - b);
  const samples = Math.max(1, to - from + 1);
  return {
    cutRate: cutsInside / length,
    motion: moving / samples,
    picture: Object.entries(kinds).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
    scale: sizes[Math.floor(sizes.length / 2)] ?? 1,
  };
}

/**
 * How much moves at a sample: for each thing on screen, its share of the frame times how fast it
 * travels (frame widths a second), scales and fades, plus a little for a clip or particles playing
 * (kino cannot see how much moves inside them). 0 is still; a full-frame whip is about 3.
 */
export function motionEnergy(model, index) {
  if (index === 0) return 0;
  let energy = 0;
  for (const item of model.items) {
    if (item.isMask || item.kind === "group" || item.samples.opacity[index] < 0.3 || coveredAt(model, item, index)) continue;
    const share = frameShare(model, item, index);
    if (share < 0.02) continue;
    const { scale, opacity } = item.samples;
    const scaling = (Math.abs(scale[index] - scale[index - 1]) * model.fps) / Math.max(1e-6, scale[index]);
    const fading = Math.abs(opacity[index] - opacity[index - 1]) * model.fps * 0.5;
    const playing = item.kind === "video" || item.samples.moving?.[index] ? 0.05 : 0;
    energy += share * (speedAt(model, item, index) + scaling + fading + playing);
  }
  return Math.min(3, energy);
}

export function flatSections(model, ctx) {
  const list = sections(model).filter((section) => section.end - section.start >= 1.5);
  if (list.length < 2) return [];
  const bounds = shotBounds(model);
  const looks = list.map((section) => sectionLook(model, section, bounds));
  const findings = [];
  for (let index = 1; index < list.length; index += 1) {
    const [a, b] = [looks[index - 1], looks[index]];
    const ratio = (x, y) => Math.max(x, y) / Math.max(1e-6, Math.min(x, y));
    const differs = {
      "cut rate": Math.abs(a.cutRate - b.cutRate) >= 0.25 && ratio(a.cutRate + 0.05, b.cutRate + 0.05) >= 1.5,
      motion: ratio(a.motion + 0.01, b.motion + 0.01) >= 2,
      picture: a.picture !== b.picture,
      "framing scale": ratio(a.scale, b.scale) >= 1.6,
    };
    const different = Object.entries(differs).filter(([, value]) => value).map(([name]) => name);
    if (different.length >= 2) continue;
    const same = Object.entries(differs).filter(([, value]) => !value).map(([name]) => name);
    findings.push({
      rule: "flat_sections", severity: "warn", at: sec(list[index].start),
      measured: different.length ? `differ only in ${different.join(", ")}` : "alike in all 4", required: "differ in 2 of cut rate, motion, picture, framing scale",
      message: `The sections at ${sec(list[index - 1].start)}s and ${sec(list[index].start)}s are alike in ${same.join(", ")}; the video has no shape.`,
      fix: { kind: "hint", text: "Make the next section change pace and scale: quicker cuts and close framing (type-giant, screen detail) after a calm wide one, or a hold with a slow-push after a fast run; a change of picture (footage to color) helps too." },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- the style spec

export function styleAvoided(model, ctx) {
  if (!ctx.style?.avoids?.length) return [];
  const used = techniquesUsed(model);
  // Only the person's avoids (by:"you" with their quote, not copied or dealt) are a ban; any
  // other is a question.
  const yours = ctx.style.avoidsBacked === true;
  const from = ctx.style.avoidsFrom === "copied" ? "copied from another brief" : ctx.style.avoidsFrom === "dealt" ? "dealt" : "guessed";
  return ctx.style.avoids.filter((tag) => used[tag]?.length).map((tag) => ({
    rule: "style_avoided", severity: yours ? "error" : "warn", at: used[tag][0].at, ...(used[tag][0].itemId ? { itemId: used[tag][0].itemId } : {}),
    measured: `${tag} ${used[tag].length} ${used[tag].length === 1 ? "time" : "times"}`, required: `no ${tag} (the style spec avoids it${yours ? "" : `, ${from}`})`,
    message: `The style spec avoids ${tag}${yours ? "" : ` (${from}, not the person's words)`}, and ${ctx.sceneName} uses it at ${used[tag].slice(0, 4).map((use) => `${use.at}s`).join(", ")}${used[tag].length > 4 ? ", …" : ""}.`,
    fix: { kind: "hint", text: yours
      ? `Replace it with a technique the spec wants${ctx.style.wants.length ? ` (${ctx.style.wants.slice(0, 3).join(", ")})` : ""}, or change the spec if the person changed their mind.`
      : `Ask the person whether ${tag} is a ban (the board stop lists guessed bans); keep it if it is a designed moment, or drop it from avoids.` },
  }));
}

/**
 * A wanted technique the video does not use. Only backed wants count (styleSpec.js). A wanted
 * transition is one more tool, not a rule for every cut: hard cuts stay free.
 */
export function styleWanted(model, ctx) {
  const backed = (ctx.style?.backed ?? []).filter((tag) => isTechnique(tag) && techniqueOf(tag).detect);
  if (!backed.length) return [];
  const used = techniquesUsed(model);
  const findings = [];
  for (const tag of backed) {
    if (!used[tag]) {
      findings.push({
        rule: "style_wanted", severity: "warn", measured: `no ${tag}`, required: `${tag}, as the spec wants`,
        message: `The style spec wants ${tag} (${techniqueOf(tag).line}), and ${ctx.sceneName} does not use it.`,
        fix: { kind: "hint", text: `Use ${tag} where it fits: ${techniqueOf(tag).fits}.` },
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- the deck

/**
 * The project's deck (engine/deck.js, ctx.deck) mostly unused: the video shows fewer than half of
 * its cards. A card swapped out is no longer in the deck, so it does not count.
 */
export function deckUnused(model, ctx) {
  if (!ctx.deck || model.duration < EDIT_SECONDS) return [];
  const counts = Object.fromEntries(Object.entries(techniquesUsed(model)).map(([tag, list]) => [tag, list.length]));
  const { used, unused } = deckUse(ctx.deck, counts, ctx.movesUsed ?? []);
  const total = used.length + unused.length;
  if (!total || used.length * 2 >= total) return [];
  return [{
    rule: "deck_unused", severity: "warn",
    measured: `${used.length} of ${total} cards used${used.length ? ` (${used.join(", ")})` : ""}`, required: `at least ${Math.ceil(total / 2)} of the deck's ${total}`,
    message: `${ctx.sceneName} leaves ${unused.join(", ")} of the deck (seed ${ctx.deck.seed}) unused, so it drifts back to the default edit.`,
    fix: { kind: "hint", text: `Build ${unused.slice(0, 2).map((tag) => (techniqueOf(tag) ? `${tag} (${techniqueOf(tag).fits})` : tag)).join(" and ")}, or swap a card that does not fit: notes {action:"deck", swap:{out, in, why}}.` },
  }];
}
