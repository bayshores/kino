// effect_fit: every loud effect, text animation and sound effect in a music edit has a reason in
// the song or the footage, and is sized by it. Past kino effects were placed by beat number or
// seed, stacked on one frame and kept one look (white flash, 28 Hz wiggle), so they "looked bad and
// didnt really fit". This rule asks each one, by the cues kino measured:
//   untriggered  a loud effect (flash, shake, impact frame, strobe, glitch, RGB split, zoom punch)
//                with no cue that motivates it on its frame (it may come up to 2 frames early,
//                never late): a footage impact or light (a cue pinned to a clip), a fitted song seam
//                or rest, a top accent, a drum fill. A text animation or sound effect with no cue,
//                shot change or heard word start under it (a text may follow a cut or a named
//                marker cue by 0.1 to 0.3 s).
//   strength     a stronger effect on a weaker trigger than another effect has (strength ranks with
//                the trigger's weight).
//   budget       more loud effects in a song section than its energy allows (one per 4 s at full
//                energy, at least 1), and none inside a break or dropout except on its edges.
//   stacked      3 or more effects (loud, text, sound) within 0.15 s.
//   face         a shake or zoom punch on a clip while a face in it talks (its own voice, or a
//                face found while a word is heard).
//   jitter       a shake that cycles faster than a third of the output frame rate (it reads as
//                noise), or one that holds steady past 4 frames instead of decaying.
// It runs only in a music edit: a project with weighted accents (detect_beats) or song seams
// (fit_music). Warns while editing, blocks the final render; a waiver names the cue (translate.mjs).
// ctx.triggerCues: the document's marker, accent and onset cues.
import { cueMotives } from "../../blocks/moves/impact.js";
import { mediaFrameState } from "../../playback.js";
import { sec } from "../analysis.js";
import { itemById } from "../model.js";
import { plateChanges, punches, techniquesUsed, textEntrances } from "../techniques.js";
import { peopleNear } from "./people.js";
import { soundEffectsOf } from "./sound.js";
import { heardEdges, heardWords } from "./speech.js";

const FRAME = 1 / 30;
// The picture may come up to 2 frames before its trigger, never late (half a frame of rounding).
const EARLY = 2 * FRAME + 0.006;
const LATE = 0.5 * FRAME + 0.006;
// Loud effects: what techniquesUsed tags them.
export const LOUD_TAGS = Object.freeze(["flash", "shake", "glitch-hit", "rgb-split", "beat-kick"]);
// How much energy each song section has (fit_music seams song-<kind>-<n>): budget per second.
const ENERGY = { drop: 1, return: 0.9, switch: 0.8, build: 0.6, "vocal-in": 0.6, intro: 0.4, outro: 0.4, break: 0, dropout: 0 };
const RESTS = new Set(["break", "dropout"]);
const PER_SECONDS = 4;
const STACK_SECONDS = 0.15;
const STACK_MOST = 2;
// A strength this much above another's, on a trigger this much weaker, is out of rank.
const RANK_GAP = 0.25;
const SONG = /^song-([a-z]+(?:-[a-z]+)?)-\d+$/;

const fitted = (cue) => cue.kind === "marker" && cue.fitted === true && SONG.test(cue.name ?? "");
/** True when the project is a music edit kino measured: weighted accents or fitted song seams. */
export const musicEdit = (cues) => cues.some((cue) => cue.kind === "accent" || fitted(cue));

/** The reasons a cue gives a loud effect, strongest first: [{motive, weight}]. A marker pinned to a clip (set_cues layer, media) is a footage moment. */
function motivesOf(cue, cues) {
  const found = cueMotives(cue, { cues, events: [] });
  if (cue.kind === "marker" && cue.layer && cue.media !== undefined && !SONG.test(cue.name ?? "")) found.push({ motive: "footage", weight: Number.isFinite(cue.weight) ? cue.weight : 0.6 });
  return found.sort((a, b) => b.weight - a.weight);
}

// The cue under an effect at `at`: the effect starts at most 2 frames before it, never after.
const onCue = (at, time) => time - at >= -LATE && time - at <= EARLY;

/** The song sections from the fitted seams: [{kind, from, to, energy}], or [] without them. */
export function songSections(cues, duration) {
  const seams = cues.filter(fitted).sort((a, b) => a.time - b.time);
  return seams.map((cue, index) => {
    const kind = SONG.exec(cue.name)[1];
    return { kind, name: cue.name, from: cue.time, to: seams[index + 1]?.time ?? duration, energy: ENERGY[kind] ?? 0.6 };
  }).filter((section) => section.to > section.from);
}

// The loud effects, each with its trigger: [{tag, at, itemId, strength, frames, shape, rate, cue, weight, motive}].
// `motivated` is every cue with its strongest reason, worked out once: [{cue, best}].
function loudEffects(model, cues, motivated) {
  // A flat frame on a cut (techniques.js flatJoins) is part of the join, as a cut is: not a loud effect.
  const used = Object.fromEntries(Object.entries(techniquesUsed(model)).map(([tag, list]) => [tag, list.filter((use) => !use.join)]));
  // Zoom punches one at a time, of any size, timed from where they start to rise; a punch a move
  // names its cue for is read from the move's record.
  const named = (used["beat-kick"] ?? []).filter((use) => use.cue);
  const kicks = [...named, ...punches(model).filter((punch) => !named.some((use) => Math.abs(use.at - punch.at) < 0.1))
    .map((punch) => ({ at: sec(punch.at), itemId: punch.itemId, strength: Math.round(Math.min(1, punch.amount / 0.1) * 100) / 100, frames: 12, shape: "pulse", animationIds: punch.animationIds }))];
  const list = [];
  // A zoom punch on the same layer within 0.1 s of another loud effect is that effect's own part
  // (the shake move scales up as it shakes): one effect, one finding. The ceiling study's director
  // c got a shake and a zoom punch flagged for one shake move on legs2 at 7.99 s (measured on a
  // copy of that project).
  const others = LOUD_TAGS.filter((tag) => tag !== "beat-kick").flatMap((tag) => used[tag] ?? []);
  const partOf = (kick) => !kick.cue && others.some((use) => use.itemId && use.itemId === kick.itemId && Math.abs(use.at - kick.at) < 0.1);
  for (const tag of LOUD_TAGS) for (const use of tag === "beat-kick" ? kicks.filter((kick) => !partOf(kick)) : used[tag] ?? []) {
    let trigger = null;
    if (use.cue) {
      // An accent move names its cue: it fits while the cue is still there, on its frame.
      const found = motivated.find((entry) => entry.cue.name === use.cue) ?? (cues.some((cue) => cue.name === use.cue) ? { cue: cues.find((cue) => cue.name === use.cue), best: null } : null);
      if (found && onCue(use.at, found.cue.time)) trigger = { cue: found.cue.name, weight: use.strength ?? found.best?.weight ?? 0.5, motive: found.best?.motive ?? "cue" };
    } else {
      for (const { cue, best } of motivated) {
        if (onCue(use.at, cue.time) && (!trigger || best.weight > trigger.weight)) trigger = { cue: cue.name, weight: best.weight, motive: best.motive };
      }
    }
    list.push({ tag, ...use, ...(trigger ? { trigger } : {}) });
  }
  return list.sort((a, b) => a.at - b.at);
}

// What takes an untriggered effect off: its own animations, or the card that flashes (a layer
// that does nothing else). null when it is not one kino can take off alone (a glitch transition).
function removal(model, use) {
  const item = use.itemId && itemById(model, use.itemId);
  if (item?.source?.componentPath) return null;
  if (use.tag === "flash" && use.shape === "card" && item) return { kind: "remove", layerItemId: item.id, auto: true };
  let ids = use.animationIds ?? [];
  if (!ids.length && use.tag === "shake" && item) ids = (model.effects ?? []).filter((effect) => effect.itemId === item.id && effect.effect === "wiggle" && Math.abs(effect.start - use.at) < 0.02).map((effect) => effect.animationId).filter(Boolean);
  // Its own zoom punch goes with it (loudEffects counts the two as one effect).
  if (ids.length && use.tag !== "beat-kick" && item) {
    // And every scale animation of that layer inside the shake's own time: the shake move's
    // "cover back" starts 0.3 s after its grow (measured on director c's copy: grow 7.99, settle
    // 8.29 to 8.49, shake 7.99 to 8.49), so taking only the grow off left a scale pop at 8.29.
    const end = Math.max(use.at, ...[...model.tweens, ...(model.effects ?? [])].filter((entry) => ids.includes(entry.source?.animationId ?? entry.animationId)).map((entry) => entry.end));
    const cover = model.tweens.filter((tween) => tween.itemId === item.id && tween.keys.some((key) => key === "scaleX" || key === "scaleY") && tween.start >= use.at - 0.05 && tween.end <= end + 0.05);
    ids = [...new Set([...ids, ...punches(model).filter((punch) => punch.itemId === item.id && Math.abs(sec(punch.at) - use.at) < 0.1).flatMap((punch) => punch.animationIds ?? []), ...cover.map((tween) => tween.source?.animationId).filter(Boolean)])];
  }
  return ids.length ? { kind: "remove", animationIds: ids, auto: true } : null;
}

// A face in the clip talking at `time`: the clip's own voice says a word, or a face is found in
// it while any word is heard.
function talkingFace(model, ctx, item, time) {
  const layer = item && ctx.scene?.layers?.find((entry) => entry.id === item.source?.layerId);
  if (!layer || layer.type !== "video") return false;
  const near = (word) => word.start <= time + 0.3 && word.end >= time - 0.2;
  let heard = false;
  for (const edge of heardEdges(ctx)) {
    if (!edge.words?.length) continue;
    const words = heardWords({ words: edge.words, range: edge.range });
    if (!words.some(near)) continue;
    if (edge.layer?.src && edge.layer.src === layer.src) return true;
    heard = true;
  }
  if (!heard || !ctx.people?.[layer.src]) return false;
  const sample = peopleNear(ctx.people[layer.src], mediaFrameState(layer, time).sourceTime);
  return Boolean(sample?.faces?.length);
}

// The clip a shake or zoom punch moves: its own item when it is a clip, else the top clip shown then.
function clipAt(model, use) {
  const own = use.itemId && itemById(model, use.itemId);
  if (own?.kind === "video") return own;
  const index = Math.max(0, Math.min(model.times.length - 1, Math.round(use.at * model.fps)));
  return model.items.filter((item) => item.kind === "video" && !item.isMask && item.samples.opacity[index] >= 0.5).sort((a, b) => b.z - a.z)[0] ?? null;
}

const TAG_WORDS = { flash: "flash", shake: "shake", "glitch-hit": "glitch", "rgb-split": "RGB split", "beat-kick": "zoom punch" };
// The impact-accent kind that remakes each loud effect on a cue (moves/impact.js IMPACT_KINDS);
// a zoom punch is a hit of the camera, so a shake (a guess: impact-accent has no punch kind).
const ACCENT_KIND = { flash: "flash", shake: "shake", "beat-kick": "shake" };
const fix = (text) => ({ kind: "hint", text });
// One move's loud effects are one effect (impact-accent hit records light and shake as two tags,
// techniques.js marks each with the move's id): the first of each move stays.
const oneEach = (entries) => {
  const seen = new Set();
  return entries.filter((entry) => !entry.move || (!seen.has(entry.move) && seen.add(entry.move)));
};

export function effectFit(model, ctx) {
  const cues = ctx.triggerCues ?? [];
  if (!musicEdit(cues)) return [];
  const findings = [];
  const finding = (reason, at, measured, required, message, hint, extra = {}) => findings.push({
    rule: "effect_fit", severity: "warn", final: true, reason, at: sec(at), measured, required, message, fix: fix(hint), ...extra });
  // The cues that motivate a loud effect, with their strongest reason, once per run.
  const motivated = cues.map((cue) => ({ cue, best: motivesOf(cue, cues)[0] })).filter((entry) => entry.best);
  const nearest = (at) => motivated.reduce((near, entry) => (!near || Math.abs(entry.cue.time - at) < Math.abs(near.time - at) ? entry.cue : near), null);
  const effects = loudEffects(model, cues, motivated);

  // untriggered: a loud effect with no reason on its frame. Its fix takes it off (check fix:"auto").
  for (const use of effects.filter((entry) => !entry.trigger)) {
    const near = nearest(use.at);
    // A ready op, not a template: the effect's own impact-accent kind and layer when it has one
    // (directors b and c were blocked 3 to 4 times each by this finding, ceiling result.md).
    const kind = ACCENT_KIND[use.tag] ?? "<flash|shake>";
    const owner = use.itemId && itemById(model, use.itemId);
    // Some ctx.name callers quote the name and some do not: quote it once here.
    const layerField = owner ? `, layer:${JSON.stringify(String(ctx.name?.(owner) ?? owner.id).replace(/^"(.*)"$/, "$1"))}` : "";
    const reason = `put it on a reason: edit {ops:[{op:"move", name:"impact-accent", kind:"${kind}"${layerField}, at:"cue:${near?.name ?? "<cue>"}"}]}${near ? ` (${sec(near.time)}s)` : ""} after taking it off. Most moments need no effect.`;
    const off = removal(model, use);
    finding("untriggered", use.at, `${TAG_WORDS[use.tag]} at ${sec(use.at)}s on no measured cue${use.cue ? ` (its cue ${use.cue} moved or is gone)` : ""}`,
      "each loud effect on a cue that motivates it (footage impact or light, song seam or rest, top accent, fill), up to 2 frames early, never late",
      `The ${TAG_WORDS[use.tag]} at ${sec(use.at)}s in ${ctx.sceneName} has nothing under it in the song or the footage: it is decoration.${off ? ` The fix takes it off; or ${reason}` : ""}`,
      `Take it off, or ${reason}`, { ...(use.itemId ? { itemId: use.itemId } : {}), ...(off ? { fix: off } : {}) });
  }

  // strength ranks with the trigger's weight.
  const ranked = effects.filter((entry) => entry.trigger && Number.isFinite(entry.strength));
  for (const strong of ranked) {
    const over = ranked.find((other) => other !== strong && other.tag === strong.tag && strong.strength > other.strength + RANK_GAP && strong.trigger.weight < other.trigger.weight - RANK_GAP);
    if (!over) continue;
    finding("strength", strong.at, `${TAG_WORDS[strong.tag]} strength ${strong.strength} on cue ${strong.trigger.cue} (weight ${strong.trigger.weight}); ${over.strength} at ${sec(over.at)}s on ${over.trigger.cue} (weight ${over.trigger.weight})`,
      "a stronger trigger gets the stronger effect", `The ${TAG_WORDS[strong.tag]} at ${sec(strong.at)}s is louder than the one at ${sec(over.at)}s, on a weaker hit: the size does not follow the music.`,
      `Size each by its cue: impact-accent sizes from the cue's weight; or soften the one at ${sec(strong.at)}s.`);
    break;
  }

  // budget per song section, from its energy; a rest takes none except on its edges.
  for (const section of songSections(cues, model.duration)) {
    const inside = oneEach(effects.filter((entry) => entry.at >= section.from - EARLY && entry.at < section.to - EARLY));
    const rest = RESTS.has(section.kind);
    const counted = rest ? inside.filter((entry) => Math.abs(entry.at - section.from) > EARLY && Math.abs(entry.at - section.to) > EARLY) : inside;
    const budget = rest ? 0 : Math.max(1, Math.floor(section.energy * (section.to - section.from) / PER_SECONDS));
    if (counted.length <= budget) continue;
    finding("budget", counted[budget].at, `${counted.length} loud effects in the ${section.kind} (${section.name}, ${sec(section.from)}-${sec(section.to)}s)`,
      rest ? "none inside a break or dropout, except on its edges" : `at most ${budget} in this section (one per ${PER_SECONDS} s at full energy; a ceiling, not a target)`,
      rest ? `The song rests from ${sec(section.from)}s to ${sec(section.to)}s and the picture adds energy anyway.` : `The ${section.kind} from ${sec(section.from)}s holds more loud effects than its energy carries: they stop landing.`,
      rest ? "Let the rest hold (a near freeze, a dip or plain footage) and restart on the return's frame." : `Keep the ${budget} on the hardest hits (the heaviest cues) and cut the rest plainly.`, { until: sec(section.to) });
  }

  // stacked: 3 or more effects within 0.15 s.
  const step = 1 / model.fps;
  const texts = textEntrances(model).filter((entry) => entry.tag && entry.tag !== "type-cut" && itemById(model, entry.itemId)?.role !== "caption");
  // A hit (impact-accent kind hit) is one effect, and a sound on its cue is part of it.
  const hits = (model.moves ?? []).filter((move) => move.trigger?.kind === "hit").map((move) => ({ id: move.id, time: cues.find((cue) => cue.name === move.trigger.cue)?.time ?? move.trigger.at }));
  const sounds = soundEffectsOf(ctx).filter((entry) => !hits.some((hit) => onCue(entry.at, hit.time)));
  const whatOf = (entry) => (hits.some((hit) => hit.id === entry.move) ? "hit" : TAG_WORDS[entry.tag]);
  const all = [...oneEach(effects).map((entry) => ({ at: entry.at, what: whatOf(entry) })), ...texts.map((entry) => ({ at: entry.at, what: entry.tag })),
    ...sounds.map((entry) => ({ at: entry.at, what: `sound ${entry.layer.name ?? entry.layer.id}` }))].sort((a, b) => a.at - b.at);
  for (let index = 0; index < all.length; index += 1) {
    const group = all.filter((entry) => entry.at >= all[index].at && entry.at <= all[index].at + STACK_SECONDS + 1e-6);
    if (group.length <= STACK_MOST) continue;
    finding("stacked", all[index].at, `${group.length} effects within ${STACK_SECONDS}s: ${group.map((entry) => entry.what).join(", ")}`, `at most ${STACK_MOST} within ${STACK_SECONDS}s`,
      `${group.length} effects land together at ${sec(all[index].at)}s: stacked, none of them reads.`, "Keep the one the trigger asks for (a contact shakes, light flashes) and take the others off.");
    break;
  }

  // a text animation or sound effect needs something under it too: a cue, a shot change or a word.
  const changes = plateChanges(model).map((change) => change.at);
  const words = heardEdges(ctx).filter((edge) => edge.words?.length).flatMap((edge) => heardWords({ words: edge.words, range: edge.range }).map((word) => word.start));
  const placed = (at) => cues.some((cue) => cue.kind !== "onset" && onCue(at, cue.time) && (cue.kind !== "marker" || !SONG.test(cue.name ?? "") || fitted(cue)))
    || changes.some((time) => Math.abs(time - at) <= EARLY + step) || words.some((time) => Math.abs(time - at) <= 0.1);
  // Text may start 0.1 to 0.3 s after a cut or the scene's start (first_entrance asks for that delay).
  // Compose has no cut under the end card: the last shot only softens there.
  const afterCut = (at) => [0, ...changes].some((time) => at - time >= 0.1 - 1e-6 && at - time <= 0.3 + 1e-6);
  // The same delay after a named moment: a marker cue that is not a song section (compose marks
  // the end card's entrance with one; an agent names its own with set_cues).
  const named = cues.filter((cue) => cue.kind === "marker" && !SONG.test(cue.name ?? ""));
  const afterNamed = (at) => named.some((cue) => at - cue.time >= 0.1 - 1e-6 && at - cue.time <= 0.3 + 1e-6);
  const loose = [...texts.map((entry) => ({ at: entry.at, what: `text ${entry.tag}`, itemId: entry.itemId, text: true })), ...sounds.map((entry) => ({ at: entry.at, what: `sound ${entry.layer.name ?? entry.layer.id}` }))]
    .filter((entry) => !placed(entry.at) && !(entry.text && (afterCut(entry.at) || afterNamed(entry.at))));
  // The nearest place it could start instead, named, so the fix is one retime (not a cue hunt).
  const spots = [...cues.filter((cue) => cue.kind !== "onset" && (cue.kind !== "marker" || !SONG.test(cue.name ?? "") || fitted(cue))).map((cue) => ({ time: cue.time, words: `"cue:${cue.name}"` })),
    ...changes.map((time) => ({ time, words: "the cut" })), ...words.map((time) => ({ time, words: "the word" }))];
  const spot = loose.length ? spots.sort((a, b) => Math.abs(a.time - loose[0].at) - Math.abs(b.time - loose[0].at))[0] : null;
  const item = loose[0]?.itemId && itemById(model, loose[0].itemId);
  const spotWords = spot ? `Start it at ${spot.words} (${sec(spot.time)}s, the nearest place${item ? `: move the entrance of ${ctx.name?.(item) ?? item.id} there` : ""})` : `Start it at "cue:<name>" (cue list: inspect {what:"cues"})`;
  if (loose.length) finding("untriggered", loose[0].at, `${loose.length} text animation${loose.length === 1 ? "" : "s"} or sound effect${loose.length === 1 ? "" : "s"} on no cue, cut or word (${loose.slice(0, 4).map((entry) => `${entry.what} ${sec(entry.at)}s`).join(", ")})`,
    "each text animation and sound effect on a cue, a shot change or a word start", `In ${ctx.sceneName} ${loose[0].what} at ${sec(loose[0].at)}s starts on nothing the viewer hears or sees.`,
    `${spotWords}, on a cut, or on the word it belongs to; or leave it out.`, loose[0].itemId ? { itemId: loose[0].itemId } : {});

  // face: no shake or zoom punch on a talking face.
  for (const use of effects.filter((entry) => entry.tag === "shake" || entry.tag === "beat-kick")) {
    const clip = clipAt(model, use);
    if (!clip || !talkingFace(model, ctx, clip, use.at)) continue;
    finding("face", use.at, `${TAG_WORDS[use.tag]} at ${sec(use.at)}s on ${ctx.name(clip)} while a face in it talks`, "no shake or zoom punch on a talking or singing face",
      `The ${TAG_WORDS[use.tag]} at ${sec(use.at)}s shakes a face while it speaks: the line is the moment, the effect fights it.`, "Take it off; let the line play on a steady shot, or cut on its first word.", { itemId: clip.id });
    break;
  }

  // jitter: a shake that cycles faster than a third of the output frame rate, or holds steady.
  const fps = ctx.outputFps ?? 30;
  for (const use of effects.filter((entry) => entry.tag === "shake" && entry.shape === "steady")) {
    const fast = (use.rate ?? 0) > fps / 3;
    if (!fast && (use.frames ?? 0) <= 4) continue;
    finding("jitter", use.at, fast ? `shake at ${use.rate} cycles a second, ${sec(fps / use.rate)} frames a cycle at ${fps} fps` : `a steady shake for ${use.frames} frames`,
      `a shake of 2 to 4 frames that decays (at most ${sec(fps / 3)} cycles a second at ${fps} fps)`,
      fast ? `The shake at ${sec(use.at)}s cycles faster than ${fps} fps can show: it reads as jitter, not a hit.` : `The shake at ${sec(use.at)}s holds for ${use.frames} frames: a hit shakes once and settles.`,
      `Use move {name:"impact-accent", kind:"shake", at:"cue:<impact>"} (a decaying wave on the hit's direction) instead of a wiggle.`, use.itemId ? { itemId: use.itemId } : {});
    break;
  }
  return findings;
}
