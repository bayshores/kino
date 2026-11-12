// update_layer sets a layer's own value, but while an animation of that value runs, and after an
// animation ends and holds its last value, the animation's value is drawn. So `opacity: 0` on a
// layer whose fade-in ends at opacity 1 leaves it on screen, and a fade-out that starts from
// opacity 1 makes a layer set to 0.3 jump back to 1 when it starts. This finds those values after
// an edit and says, in one line each, what is drawn and what to send instead.
//
// x and y are different: an animation's x and y are places in the scene, so when update_layer
// moves a layer, its animations of that place stay where they were (its presets move with it in
// the same edit, engine/presetMove.js, so these are animations with places the agent wrote, or a
// preset left behind before). A line is given only when
// an animation was left behind: it met the layer's place (or the animation before it) before the
// edit and now starts somewhere else, or it is an entrance that does not rest on the layer's
// place, so that place never shows. The line says what is really drawn (the layer's own place
// shows until a custom move starts, then jumps; or it never shows because an entrance holds
// another place) and gives the ops that move those animations, and every animation joined to
// them, by one amount: the one that joins them to the layer's new place (usually the layer's own
// move), on both ends, the same shift `place`, align and check's safe_zone fix make
// (shiftAnimation). So a chain (an entrance into a drift into an exit) stays joined and each
// motion keeps its direction. An animation that already starts at the new place, or starts from
// where it is (fromCurrent), is left alone, and a jump that was there before the edit keeps its
// size (a drift 2 px off the entrance before it, or a deliberate cut, moves with the chain).
// The judgment is made on the edit's result, so an edit that aligns or groups a layer and then
// sets its x is judged on where the animations are after the align or group.
//
// Other values (opacity, scale, rotation) are not places: each end of an animation that used the
// layer's old value (an entrance's `to`, a custom animation's `from` and `to`, an exit's `from`)
// is changed to the new value, so nothing jumps where an animation starts. scaleX and scaleY set
// together give one line. When an edit sets one value twice, the last one counts.
import { evaluateLayer } from "../../engine/animation.js";
import { usesCurrentInitialValue } from "../../engine/animationInitialValue.js";
import { shiftAnimation } from "../../engine/animationShift.js";
import { animationTreeEntries } from "../../engine/animationTree.js";
import { mediaFrameState } from "../../engine/playback.js";
import { patchPresetAnimation } from "../../engine/presetCatalog.js";
import { isRecord } from "../../engine/numbers.js";

const SKIPPED = new Set(["name", "visible", "locked", "parentId", "animations", "role"]);
const POSITION = new Set(["x", "y"]);
const LIST = 5;
// How far apart two places can be (in px) and still count as the same: below what shows.
const SAME_PLACE = 0.5;
// How close two other values (opacity, scale, turn) can be and still count as the same.
const SAME_VALUE = 1e-3;
// "Just before" an animation starts, in seconds.
const JUST_BEFORE = 1e-6;
// A layer's value when it does not set one.
const DEFAULTS = { opacity: 1, scaleX: 1, scaleY: 1, rotation: 0, x: 0, y: 0 };

// Said before advice that sends a preset again, which is not plainly a change of place or value.
// The ops stay last in the line, so an agent can read them from its last ": ".
export const PRESET_NOTE = " A preset sent again works its values out from the layer's, and stays a preset.";
const round = (value) => Number(value.toFixed(3));
const sameValue = (key, set, drawn) => (typeof set === "number" && typeof drawn === "number"
  ? Math.abs(set - drawn) < (POSITION.has(key) ? SAME_PLACE : SAME_VALUE)
  : set !== undefined && drawn !== undefined && JSON.stringify(set).toLowerCase() === JSON.stringify(drawn).toLowerCase());
const shown = (value) => (typeof value === "number" ? round(value) : JSON.stringify(value));
const signed = (value) => `${value > 0 ? "+" : ""}${round(value)}`;
const sets = (values, key) => isRecord(values) && key in values;
const flat = (layer) => animationTreeEntries(layer?.animations ?? [], { enabledOnly: true, groups: false })
  .map((entry) => entry.animation).filter((animation) => animation && typeof animation === "object" && animation.kind !== "effect");

// The layer ops of an edit as [{ layerId, sceneId, properties }], one entry per layer with the
// last value each key was given: an edit that sets opacity 0.3 and then 0.8 leaves 0.8.
function layerUpdates(operations) {
  const updates = new Map();
  for (const operation of operations.flat()) {
    if (!operation || !["update_layer", "update_layers"].includes(operation.type)) continue;
    const properties = operation.properties ?? {};
    const ids = operation.type === "update_layer" ? [operation.layerId] : operation.layerIds ?? [];
    for (const layerId of ids) {
      if (typeof layerId !== "string") continue;
      if (!updates.has(layerId)) updates.set(layerId, { layerId, sceneId: operation.sceneId, properties: {} });
      Object.assign(updates.get(layerId).properties, properties);
    }
  }
  // update_animation can leave a layer's own x or y where none of its animations rest: such a
  // layer is looked at for the places this edit did not set. `placed` holds the places (x, y)
  // an update_animation set (its from, to, motion path, preset or preset settings); for the
  // others (only easing or duration changed) a line is given only when the edit made the
  // layer's own place stop showing.
  for (const operation of operations.flat()) {
    if (operation?.type !== "update_animation" || typeof operation.layerId !== "string") continue;
    if (!updates.has(operation.layerId)) updates.set(operation.layerId, { layerId: operation.layerId, sceneId: operation.sceneId, properties: {} });
    const update = updates.get(operation.layerId);
    update.animated = true;
    update.placed ??= new Set();
    const patch = isRecord(operation.properties) ? operation.properties : {};
    const whole = ["motionPath", "fromCurrent", "preset", "parameters"].some((field) => field in patch);
    for (const key of POSITION) if (whole || sets(patch.from, key) || sets(patch.to, key)) update.placed.add(key);
  }
  return [...updates.values()];
}

/**
 * One warning line for each value an update_layer or update_layers in `operations` (translated
 * engine ops) set that the layer's animations draw over in `document`: LIST lines, then one line
 * with the ops for the rest.
 * `ref(id)` gives the name an agent uses for a layer or animation. `previous` is the document
 * before the edit: a layer's move (for x and y) is its new value minus its value there.
 * `covered` gets "layerId key" for each place a line gives ops for, so jumps.mjs does not give
 * a second set of ops for the same chain. `hides` gets the update_layer ops that hide a layer whose
 * opacity 0 shows nothing (an animation draws over it): the receipt's next call.
 */
export function overriddenValues(document, operations, ref, previous = null, covered = new Set(), hides = []) {
  const entries = [];
  const oldLayers = new Map((previous?.scenes ?? []).flatMap((entry) => entry.layers).map((layer) => [layer.id, layer]));
  for (const { layerId, sceneId, properties, animated, placed } of layerUpdates(operations)) {
    const scene = document.scenes.find((entry) => entry.id === sceneId && entry.layers.some((layer) => layer.id === layerId))
      ?? document.scenes.find((entry) => entry.layers.some((layer) => layer.id === layerId));
    const layer = scene?.layers.find((entry) => entry.id === layerId);
    // A hidden layer is not drawn at all, so none of its values show.
    if (!layer || layer.visible === false) continue;
    const animations = flat(layer);
    const layerName = ref(layer.id);
    // "layer.kind" finds an animation only at the top of the layer's list (not one inside a
    // group made by group_animations or convert_to_actions) and only when no other top-level
    // animation has that kind or name; otherwise the animation's code (A3).
    const top = (layer.animations ?? []).filter(isRecord);
    const nameOf = (animation) => {
      const kind = String(animation.kind ?? "").toLowerCase();
      const matches = top.filter((other) => other.kind === kind || String(other.name ?? "").toLowerCase() === kind);
      return /^[a-z]+$/.test(kind) && matches.length === 1 && matches[0].id === animation.id ? `${layerName}.${kind}` : ref(animation.id);
    };
    const label = (animation) => `${nameOf(animation)}${animation.name ? ` (${animation.name})` : ""}`;
    const valueAt = (key, time) => {
      try {
        const evaluated = evaluateLayer(layer, Math.max(0, time));
        return evaluated.visible === false ? undefined : evaluated[key];
      } catch { return undefined; }
    };
    // The from, to (and motion path) each animation should have, with every value of this layer
    // update changed, so the op a line gives is right even when the agent sends the ops of
    // several lines (x and y of one move).
    const changed = new Map();
    const change = (animation, side, key, value) => {
      if (!changed.has(animation)) changed.set(animation, {});
      const entry = changed.get(animation);
      entry[side] = { ...(entry[side] ?? animation[side]), [key]: value };
    };
    const shift = (animation, dx, dy, position) => {
      const current = { ...animation, ...changed.get(animation), animations: undefined };
      const shifted = shiftAnimation(current, dx, dy, position);
      if (!changed.has(animation)) changed.set(animation, {});
      for (const side of ["from", "to", "motionPath"]) if (shifted[side] !== current[side]) changed.get(animation)[side] = shifted[side];
    };
    const lines = [];
    // After update_animation, a place this edit did not set is judged as the layer has it: a
    // line only when an entrance no longer rests on it (so it never shows). A place that did
    // not show before the edit either is not this edit's doing when the update_animation did
    // not change that place (only easing or duration, say) or left the layer resting where it
    // rested: an entrance's new from, or a grow's new scale, does not move where it rests.
    const keys = Object.entries(properties);
    const oldLayer = oldLayers.get(layer.id);
    if (animated) for (const key of POSITION) {
      if (key in properties || typeof own(layer, key) !== "number") continue;
      const hidden = oldLayer ? hiddenRest(oldLayer, key) : null;
      if (hidden && (!placed?.has(key) || sameValue(key, hidden.rest, hiddenRest(layer, key)?.rest))) continue;
      keys.push([key, own(layer, key), true]);
    }
    for (const [key, value, kept] of keys) {
      if (SKIPPED.has(key) || !["number", "string"].includes(typeof value)) continue;
      if (POSITION.has(key)) {
        if (typeof value !== "number") continue;
        const line = movedPlace({ key, value, layer, oldLayer: kept ? null : oldLayer, scene, animations, valueAt, label, shift, kept, layerName });
        if (line) { lines.push(line); covered.add(`${layer.id} ${key}`); }
        continue;
      }
      const line = heldValue({ key, value, layer, oldLayer, scene, animations, valueAt, label, change, layerName });
      if (line) lines.push(line);
    }
    for (const { key, value, head, what, involved, advice, hide } of mergeScale(lines)) {
      const ops = involved.map((animation) => ({ op: "update_animation", animation: nameOf(animation), properties: advisedProperties(animation, changed.get(animation), layer, document) }));
      const sent = JSON.stringify(ops.length === 1 ? ops[0] : ops);
      const named = `${layerName} ${head ?? `${key} ${shown(value)}`}`;
      const note = !hide && ops.some((op) => op.properties?.preset) ? PRESET_NOTE : "";
      // Opacity 0 under one animation: the other one-call fix is to delete that animation (its code).
      const orDelete = hide && involved.length === 1 ? ` Or delete the animation that draws over it: ${JSON.stringify({ op: "delete_animation", animation: nameOf(involved[0]) })}` : "";
      entries.push({ named, hide, text: `${named} ${what}${note} ${advice(sent)}${orDelete}`,
        ops: hide ?[{ op: "update_layer", layer: layerName, properties: { visible: false } }] : ops });
    }
  }
  // The first LIST get a line each; the rest share one line with every op they need, so no
  // advice is dropped (an edit that moves 7 slid-in layers gets ops for all 7).
  // `hides` gets the update_layer ops that hide the layers whose opacity 0 shows nothing: the receipt's next call.
  hides.push(...entries.filter((entry) => entry.hide).flatMap((entry) => entry.ops));
  const warnings = entries.slice(0, LIST).map((entry) => entry.text);
  const rest = entries.slice(LIST);
  if (rest.length) {
    warnings.push(`${rest.length} more ${rest.length === 1 ? "value is" : "values are"} drawn over by animations the same way (${rest.map((entry) => entry.named).join(", ")}). `
      + `To fix ${rest.length === 1 ? "it" : "them"} as above: ${JSON.stringify(rest.flatMap((entry) => entry.ops))}`);
  }
  return warnings;
}

/**
 * The update_animation properties a receipt gives to set `animation`'s from and to (`properties`)
 * on `layer` as it is after the edit. Setting from or to makes a preset a plain animation, so a
 * later preset edit (`preset:{parameters:{distance:80}}`) was refused. When the preset's own
 * settings, worked out again at the layer's place, give those same values (a slide that moves
 * with its layer, a fade into the layer's new opacity), the properties are
 * {preset:{id, parameters}} instead, which keeps it a preset. Otherwise they are `properties`.
 */
export function advisedProperties(animation, properties, layer, document) {
  if (animation?.keys?.length && isRecord(properties)) return keyedProperties(animation, properties);
  if (!isRecord(animation?.preset) || !isRecord(properties) || !Object.keys(properties).length
    || Object.keys(properties).some((key) => !["from", "to"].includes(key))) return properties;
  // A text layer's measured size needs its fonts, which are not here.
  if (layer?.type === "text" && !animation.preset.text) return properties;
  const parameters = animation.preset.parameters ?? {};
  const keep = { preset: { id: animation.preset.id, ...(Object.keys(parameters).length ? { parameters: { ...parameters } } : {}) } };
  let redone;
  try { redone = patchPresetAnimation(animation, keep, layer, { document }); } catch { return properties; }
  const wanted = { ...animation, ...properties };
  const same = (a, b) => {
    if (!isRecord(a) || !isRecord(b)) return a === b;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameValue(key, a[key], b[key]));
  };
  return same(redone.from, wanted.from) && same(redone.to, wanted.to) ? keep : properties;
}

// A keyed animation refuses from/to edits: a new from is its first key, a new to its last, and
// a number both ends moved by the same amount (a shift) moves every key by it.
// Properties of an animation without keys are returned as they are.
export function keyedProperties(animation, properties) {
  if (!animation?.keys?.length) return properties;
  const { from, to, ...rest } = properties;
  if (!isRecord(from) && !isRecord(to)) return rest;
  const last = animation.keys.length - 1;
  const delta = (sent, stored, key) => (typeof sent?.[key] === "number" && typeof stored?.[key] === "number" ? sent[key] - stored[key] : null);
  const keys = animation.keys.map((entry, index) => {
    const value = { ...entry.value };
    for (const key of Object.keys(value)) {
      const [a, b] = [delta(from, animation.from, key), delta(to, animation.to, key)];
      if (index === 0 && isRecord(from) && Object.hasOwn(from, key)) value[key] = from[key];
      else if (index === last && isRecord(to) && Object.hasOwn(to, key)) value[key] = to[key];
      else if (a !== null && b !== null && Math.abs(a - b) < 1e-9 && typeof value[key] === "number") value[key] += a;
    }
    return { ...entry, value };
  });
  return { ...rest, keys };
}

// The line for a value other than x and y (opacity, scale, rotation, a colour), or null. The ends
// that used the layer's old value are joined to it: an entrance's `to` (it rests there), a custom
// animation's `from` and `to`, an exit's `from` (it leaves from there). Each one is changed to the
// new value, so a custom animation that starts later starts from it (no jump), and a chain (a
// fade-in into a dim into a fade-out) keeps its other values. A line is given only when such an
// end is left on the old value, or when the new value never shows. A layer made in this edit (no
// old value) and a value that never shows with nothing joined to it change the end that holds
// (the last entrance's or custom animation's `to`) and the start of each exit instead.
function heldValue({ key, value, layer, oldLayer, scene, animations, valueAt, label, change, layerName }) {
  const list = inDrawingOrder(animations.filter((animation) => sets(animation.from, key) || sets(animation.to, key)));
  if (!list.length) return null;
  const duration = scene.duration;
  const old = oldLayer ? own(oldLayer, key) : undefined;
  const spans = showingSpans(list, duration, (time) => valueAt(key, time), (drawn) => sameValue(key, value, drawn));
  let ends = [];
  if (old !== undefined && !sameValue(key, value, old)) {
    for (const animation of list) {
      if (animation.kind !== "in" && !usesCurrentInitialValue(animation) && sets(animation.from, key) && sameValue(key, animation.from[key], old)) ends.push([animation, "from"]);
      if (animation.kind !== "out" && sets(animation.to, key) && sameValue(key, animation.to[key], old)) ends.push([animation, "to"]);
    }
  }
  if (!ends.length && (old === undefined || !spans.length)) {
    const holding = list.filter((animation) => animation.kind !== "out");
    const last = holding.length ? holding.reduce((latest, animation) => (end(animation) > end(latest) ? animation : latest)) : null;
    const exitStarts = list.filter((animation) => animation.kind === "out").map(startOf);
    const drawn = last ? valueAt(key, Math.min(end(last) + 0.01, duration, ...exitStarts)) : undefined;
    if (last && drawn !== undefined && !sameValue(key, value, drawn) && sets(last.to, key)) ends.push([last, "to"]);
    for (const exit of list) {
      if (exit.kind === "out" && !usesCurrentInitialValue(exit) && sets(exit.from, key) && !sameValue(key, value, exit.from[key])) ends.push([exit, "from"]);
    }
  }
  if (!ends.length) return null;
  const involved = list.filter((animation) => ends.some(([other]) => other === animation));
  const facts = [];
  for (const animation of involved) {
    const sides = ends.filter(([other]) => other === animation).map(([, side]) => side);
    const start = startOf(animation);
    if (sides.includes("from") && start > 0 && start < duration) {
      const [justBefore, atStart] = [valueAt(key, start - 1e-5), valueAt(key, start)];
      if (justBefore !== undefined && atStart !== undefined && !sameValue(key, justBefore, atStart))
        facts.push(`it jumps from ${key} ${shown(justBefore)} to ${shown(atStart)} when ${label(animation)} starts at ${round(start)} s`);
      else if (animation.kind === "out") facts.push(`${label(animation)} starts from ${key} ${shown(animation.from[key])} at ${round(start)} s`);
    }
    if (sides.includes("to")) {
      facts.push(end(animation) < duration
        ? `from ${round(end(animation))} s ${label(animation)} holds ${key} ${shown(valueAt(key, end(animation) + 0.01))}`
        : `${label(animation)} draws ${key} ${shown(valueAt(key, duration))} until the scene ends`);
    }
  }
  if (!facts.length) facts.push(`${involved.map(label).join(", ")} still use${involved.length === 1 ? "s" : ""} ${key} ${shown(old)}`);
  for (const [animation, side] of ends) change(animation, side, key, value);
  const what = `${showingText(spans, duration)}: ${facts.slice(0, 3).join(", ")}, and an animation's value is drawn over the layer's.`;
  const advice = (sent) => (key === "opacity" && value === 0
    ? `To hide the layer: {"op":"update_layer","layer":"${layerName}","properties":{"visible":false}}`
    : ends.length === 1 ? `To change the value it ${ends[0][1] === "to" ? "holds" : "starts from"}: ${sent}`
    : `To change the values the animations use: ${sent}`);
  return { key, value, what, involved, advice, hide: key === "opacity" && value === 0 };
}

// scaleX and scaleY set together (as `scale`) are one line with one op: the two lines name the
// same animations, and the op each gives already has both values.
function mergeScale(lines) {
  const [x, y] = ["scaleX", "scaleY"].map((key) => lines.find((line) => line.key === key));
  if (!x || !y || x.involved.length !== y.involved.length || x.involved.some((animation) => !y.involved.includes(animation))) return lines;
  const head = x.value === y.value ? `scaleX and scaleY ${shown(x.value)}` : `scaleX ${shown(x.value)} and scaleY ${shown(y.value)}`;
  const merged = { ...x, head };
  return lines.filter((line) => line !== y).map((line) => (line === x ? merged : line));
}

// The line for an update_layer that moved a layer (x or y) and left animations of that place
// behind, or null. An animation is left behind when it starts somewhere else than what is drawn
// just before it (the layer's own place, or the animation before it in a chain) although it met
// that place before the edit, or when it is an entrance (or starts at 0 s) and does not rest on
// the layer's place, so the layer's own place never shows. Each one moves by the amount that
// joins it again, and the animations joined to it move by the same amount (shiftAnimation), so
// a chain stays joined and keeps its shape. One that still starts at the layer's old place
// although something else is drawn before it (an exit after a drift that ends elsewhere) moves
// with the layer, so its jump does not grow. An animation that starts where it is drawn (a
// custom move whose `from` already is the new place, or one that starts from where it is) is
// left alone, and so is a jump that was there before the edit. `shift` collects each
// animation's new from, to and motion path.
// `kept`: the edit did not set this place (it changed the animations); the line then also offers
// to move the layer to where its entrance rests.
function movedPlace({ key, value, layer, oldLayer, scene, animations, valueAt, label, shift, kept = false, layerName }) {
  const list = inDrawingOrder(animations.filter((animation) => drawsKey(animation, key)));
  if (!list.length) return null;
  const oldList = oldLayer ? inDrawingOrder(flat(oldLayer).filter((animation) => drawsKey(animation, key))) : [];
  const oldById = new Map(oldList.map((animation) => [animation.id, animation]));
  const amounts = new Map();
  const oldPlace = oldLayer ? own(oldLayer, key) : undefined;
  // A join that was there before the edit and is not now (the layer's place met a move).
  let broke = false;
  for (const animation of list) {
    const now = joinOf(layer, list, animation, key);
    const carried = now.pred ? amounts.get(now.pred) ?? 0 : 0;
    let amount = carried;
    if (!now.joined) {
      const was = oldById.get(animation.id);
      const then = was ? joinOf(oldLayer, oldList, was, key) : null;
      // The layer's own place never shows (it rests where the entrance ends), or this edit broke
      // a join that was there: move it to meet what is drawn before it (after that moves too).
      // One that already jumped before the edit but starts at the layer's old place (an exit
      // after a drift that ends elsewhere: a preset exit's places are measured from the layer's)
      // moves with the layer, so the jump does not grow. One that already jumped from what is
      // drawn before it (a drift that starts 2 px off, or a deliberate cut) keeps the step it
      // had there, so the step neither grows nor shrinks: it moves with the animation before
      // it, or, with none before it then or now, with the layer's own place. Before, a lone
      // drift 2 px off the layer's y was left behind and a move of 200 px made it a 198 px jump.
      const step = (join) => join.start - join.before;
      if (then?.joined) broke = true;
      amount = (now.hidden && !now.pred) || then?.joined ? now.before + carried - now.start
        : then && animation.kind !== "in" && typeof oldPlace === "number" && sameValue(key, now.start, oldPlace) ? value - oldPlace
        : then && (now.pred || !then.pred) ? carried + step(then) - step(now)
        : 0;
    }
    if (Math.abs(amount) >= 1e-6) amounts.set(animation, round(amount));
  }
  if (!amounts.size) return null;
  const involved = list.filter((animation) => amounts.has(animation));

  // What is drawn now, from the scene's frames: where the layer's own place shows, the jumps
  // where an animation starts somewhere else than what is drawn just before it, and the place
  // the last animation holds. Its place and its jumps count only where the layer is seen: shown,
  // not see-through, and for a clip while its file shows (mediaFrameState: before Play starts,
  // with Freeze off, it is not drawn).
  const duration = scene.duration;
  const seen = (time) => mediaFrameState(layer, time).visible && valueAt("opacity", time) > 0.01;
  const drawn = (time) => (seen(time) ? valueAt(key, time) : undefined);
  const spans = showingSpans(list, duration, drawn, (at) => typeof at === "number" && Math.abs(at - value) < SAME_PLACE);
  const facts = [];
  let jumps = 0;
  for (const animation of involved) {
    const start = startOf(animation);
    if (animation.kind === "in" || start <= 0) {
      const held = valueAt(key, end(animation) + 0.01);
      if (animation.kind === "in" && end(animation) < duration && typeof held === "number")
        facts.push(`from ${round(end(animation))} s ${label(animation)} holds ${key} ${shown(held)}`);
      continue;
    }
    if (start >= duration) continue;
    // Seen a moment before (a layer shown when the move starts was not), drawn just before.
    const [justBefore, atStart] = [seen(start - 0.02) ? valueAt(key, start - 1e-5) : undefined, drawn(start)];
    if (typeof justBefore === "number" && typeof atStart === "number" && Math.abs(justBefore - atStart) >= SAME_PLACE) {
      jumps += 1;
      facts.push(`it jumps from ${key} ${shown(justBefore)} to ${shown(atStart)} when ${label(animation)} starts at ${round(start)} s`);
    }
  }
  const holding = list.filter((animation) => animation.kind !== "out");
  const last = holding.length ? holding.reduce((latest, animation) => (end(animation) > end(latest) ? animation : latest)) : null;
  if (last && amounts.has(last) && !(last.kind === "in" && end(last) < duration)) {
    const held = end(last) < duration ? valueAt(key, end(last) + 0.01) : valueAt(key, duration);
    if (typeof held === "number" && Math.abs(held - value) >= SAME_PLACE)
      facts.push(end(last) < duration ? `from ${round(end(last))} s ${label(last)} holds ${key} ${shown(held)}` : `${label(last)} draws ${key} until the scene ends, ending at ${shown(held)}`);
  }
  // The new place is where a move ends, between two moves (a land, then a step aside or a slow
  // drift from there): the place meant, not one left behind. No line, unless the edit broke a
  // join that was there or the layer is seen jumping where a move starts. A place no animation
  // ends on still gets its line.
  const restsAfter = (animation) => animation.kind !== "out" && end(animation) < duration && sameValue(key, value, valueAt(key, end(animation)));
  if (!broke && !jumps && list.some(restsAfter)) return null;
  if (!facts.length) facts.push(`${involved.map(label).join(", ")} still draw${involved.length === 1 ? "s" : ""} ${key} at the old place`);
  const showing = showingText(spans, duration);
  for (const animation of involved) {
    const amount = amounts.get(animation);
    shift(animation, key === "x" ? amount : 0, key === "y" ? amount : 0, (place, change) => round(place + change));
  }
  const before = oldLayer ? own(oldLayer, key) : undefined;
  const moved = typeof before === "number" ? round(value - before) : undefined;
  const same = new Set(involved.map((animation) => amounts.get(animation)));
  const amount = same.size === 1 ? [...same][0] : null;
  const what = `${showing}: ${facts.slice(0, 3).join(", ")}. ${kept ? `An animation's ${key} is drawn over the layer's own ${key}.` : `An animation's ${key} is a place in the scene, so it stays where it was when the layer moves${amount !== null && amount === moved ? ` (${signed(moved)})` : ""}.`}`;
  const them = involved.length > 1 ? "its animations" : "the animation";
  const rest = kept ? joinOf(layer, list, involved[0], key).start : undefined;
  const keep = kept && typeof rest === "number"
    ? `To keep the animations, put the layer where it rests: ${JSON.stringify({ op: "update_layer", layer: layerName, properties: { [key]: round(rest) } })}. Or, ` : "";
  const advice = (sent) => `${keep}${keep ? "to" : "To"} ${amount === null
    ? `join its animations to the layer's place again (${involved.map((animation) => `${label(animation)} by ${signed(amounts.get(animation))}`).join(", ")}): ${sent}`
    : `move ${them} ${amount === moved ? "with the layer" : "to the layer's place"} (${involved.length > 1 ? "each " : ""}by ${signed(amount)}): ${sent}`}`;
  return { key, value, what, involved, advice };
}

// When `layer`'s own `key` never shows because the first animation of it (an entrance, or one
// that starts at 0 s) does not rest on or start at that place, { rest }: the place it rests on
// (or starts at) instead. Otherwise null. What movedPlace's `kept` line is about.
function hiddenRest(layer, key) {
  const list = inDrawingOrder(flat(layer).filter((animation) => drawsKey(animation, key)));
  for (const animation of list) {
    const join = joinOf(layer, list, animation, key);
    if (join.hidden && !join.pred && !join.joined) return { rest: join.start };
  }
  return null;
}

// The frames (between animation starts and ends) where `shows(drawn)` holds, as [from, to] spans.
// A span counts when the value shows at a quarter, half and three quarters of it, so a fade that
// passes through the value on its way does not count as showing it.
function showingSpans(list, duration, drawnAt, shows) {
  const times = [...new Set([0, duration, ...list.flatMap((animation) => [startOf(animation), end(animation)])]
    .map((time) => Math.min(Math.max(time, 0), duration)))].sort((a, b) => a - b);
  const spans = [];
  for (let index = 0; index + 1 < times.length; index += 1) {
    const [from, to] = [times[index], times[index + 1]];
    if (to - from < 1e-6 || ![0.25, 0.5, 0.75].every((part) => shows(drawnAt(from + (to - from) * part)))) continue;
    if (spans.length && Math.abs(spans.at(-1)[1] - from) < 1e-6) spans.at(-1)[1] = to;
    else spans.push([from, to]);
  }
  return spans;
}

function showingText(spans, duration) {
  const span = ([from, to]) => `${round(from)}-${round(to)} s`;
  return !spans.length ? "does not show"
    : spans.length === 1 && spans[0][0] <= 1e-6 ? `shows only until ${round(spans[0][1])} s`
    : spans.length === 1 && spans[0][1] >= duration - 1e-6 ? `shows only from ${round(spans[0][0])} s`
    : `shows only at ${spans.map(span).join(", ")}`;
}

// Where `animation` meets what is drawn just before it on `layer` (`list`: the animations of
// `key` in drawing order). `before` is that value, drawn by `pred` (null: the layer's own value);
// `start` is where the animation starts (for an entrance, the value it rests on when it ends: an
// entrance draws its start until it starts, so the layer rests where it ends). `hidden`: the
// layer's own value never shows next to it (an entrance, or an animation that starts at 0 s).
// A `from` left out, or fromCurrent, starts from what is drawn, so it always meets.
function joinOf(layer, list, animation, key) {
  const alone = { ...layer, animations: [animation] };
  if (animation.kind === "in") {
    const before = own(layer, key);
    const start = drawnAt(alone, key, end(animation));
    return { pred: null, before, start, hidden: true, joined: sameValue(key, start, before) };
  }
  const time = startOf(animation);
  const pred = list.filter((other) => other !== animation && startOf(other) < time - 1e-9).at(-1) ?? null;
  const before = time > 1e-9 ? drawnAt(layer, key, time - JUST_BEFORE) : own(layer, key);
  const free = usesCurrentInitialValue(animation) || !(sets(animation.from, key) || (POSITION.has(key) && animation.motionPath?.points?.length > 0));
  const start = free ? before : drawnAt(alone, key, time);
  return { pred, before, start, hidden: !pred && time <= 1e-9, joined: sameValue(key, start, before) };
}

// The value of `key` drawn at `time` (the layer's own value when nothing sets it).
function drawnAt(layer, key, time) {
  try {
    return evaluateLayer(layer, Math.max(0, time))[key] ?? own(layer, key);
  } catch { return undefined; }
}

const own = (layer, key) => layer?.[key] ?? DEFAULTS[key];
const startOf = (animation) => animation.start ?? 0;
const drawsKey = (animation, key) => sets(animation.from, key) || sets(animation.to, key)
  || (POSITION.has(key) && animation.motionPath?.points?.length > 0);
// In the order evaluateLayer draws them: by start, then as listed; a later one draws over.
const inDrawingOrder = (list) => list.map((animation, index) => ({ animation, index }))
  .sort((a, b) => startOf(a.animation) - startOf(b.animation) || a.index - b.index).map((entry) => entry.animation);

function end(animation) {
  return (animation.start ?? 0) + (animation.duration ?? 0);
}
