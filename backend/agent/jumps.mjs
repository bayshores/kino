// A custom animation or an exit starts from its own `from`, whatever is drawn just before it. When
// that is more than half a pixel away from where the layer is drawn just before the animation
// starts, the layer jumps there. The edit receipt warns about each jump an edit made, on the layers
// whose animations it added or changed (a jump that was there before the edit is left alone), with
// the update_animation that starts the animation where the layer is.
// An entrance (kind "in") draws its start until it starts, so it never jumps when it starts. A
// layer whose x or y an update_layer in the same edit set is left to overridden-values.mjs, which
// gives the ops that move its animations with it, and so is a place its moved-place line already
// joins (`covered`): two lines with ops for one chain could be sent together and break it.
// The op that joins a custom move changes only its `from`, so it still ends where it was told to
// (and stays joined to what starts there). An exit's `to` is worked out from its `from` (a Slide
// Out ends its distance away from where it starts), so the op moves both ends by the same amount
// (engine/animationShift.js) and the exit keeps its length and direction.
// A jump that was there before the edit is left alone only when it is the same jump: the same
// step on each key (where it lands minus where it was). One that now goes the other way is new.
import { evaluateLayer } from "../../engine/animation.js";
import { shiftValues } from "../../engine/animationShift.js";
import { animationTreeEntries } from "../../engine/animationTree.js";
import { advisedProperties, PRESET_NOTE } from "./overridden-values.mjs";
import { isRecord } from "../../engine/numbers.js";

const SAME_PLACE = 0.5;
const JUST_BEFORE = 1e-6;
const POSITION = ["x", "y"];
const LIST = 5;

const shown = (value) => Number(value.toFixed(1));
const exact = (value) => Number(value.toFixed(3));
const seconds = (value) => Number(value.toFixed(2));

function evaluated(layer, time) {
  try {
    const state = evaluateLayer(layer, Math.max(0, time));
    // A layer that is not drawn (hidden, or at opacity 0 such as before a carry's crossfade) cannot jump.
    return state.visible === false || state.opacity <= 0 ? null : state;
  } catch {
    return null;
  }
}

// The jump `animation` (with its absolute start) makes on `layer`, or null.
function jumpOf(layer, animation) {
  const start = animation.start ?? 0;
  if (!isRecord(animation) || ["in", "effect"].includes(animation.kind) || start <= JUST_BEFORE) return null;
  const path = animation.motionPath?.points?.length > 0;
  const keys = POSITION.filter((key) => path || Object.hasOwn(animation.from ?? {}, key) || Object.hasOwn(animation.to ?? {}, key));
  if (!keys.length) return null;
  const before = evaluated(layer, start - JUST_BEFORE);
  const at = evaluated(layer, start);
  // What this animation draws at its start by itself: the jump is this animation's only when the
  // layer is drawn there (a later one that starts at the same time draws over it).
  const { animations: _children, ...single } = animation;
  const alone = evaluated({ ...layer, animations: [single] }, start);
  if (!before || !at || !alone) return null;
  const moved = keys.filter((key) => typeof before[key] === "number" && typeof at[key] === "number"
    && Math.abs(at[key] - before[key]) > SAME_PLACE && Math.abs(alone[key] - at[key]) <= SAME_PLACE);
  if (!moved.length) return null;
  return { keys: moved, before, at, start, path, distance: Math.hypot(...moved.map((key) => at[key] - before[key])) };
}

// The from (and, for an exit, the to) that start `stored` where the layer is drawn just before it.
function joined(stored, jump) {
  const from = { ...(stored.from ?? {}), ...Object.fromEntries(jump.keys.map((key) => [key, exact(jump.before[key])])) };
  if (stored.kind !== "out" || !isRecord(stored.to)) return { from };
  const change = (key) => (jump.keys.includes(key) ? jump.before[key] - (typeof stored.from?.[key] === "number" ? stored.from[key] : jump.at[key]) : 0);
  return { from, to: shiftValues(stored.to, change("x"), change("y"), (place, amount) => exact(place + amount)) };
}

// Layer ids whose x or y an update_layer or update_layers in `operations` set.
function placedLayers(operations) {
  const ids = new Set();
  for (const operation of (operations ?? []).flat()) {
    if (!["update_layer", "update_layers"].includes(operation?.type)) continue;
    if (!POSITION.some((key) => Object.hasOwn(operation.properties ?? {}, key))) continue;
    for (const id of operation.type === "update_layer" ? [operation.layerId] : operation.layerIds ?? []) ids.add(id);
  }
  return ids;
}

/**
 * Warning lines for the jumps an edit made: LIST lines, then one line with the ops for the rest.
 * `document` is after the edit, `previous` before it, `operations` the translated engine ops and
 * `ref(id)` the name an agent uses for a layer or animation.
 */
export function animationJumps(document, operations, ref, previous = null, covered = new Set()) {
  const oldLayers = new Map((previous?.scenes ?? []).flatMap((scene) => scene.layers ?? []).map((layer) => [layer.id, layer]));
  const placed = placedLayers(operations);
  const entries = [];
  for (const layer of (document?.scenes ?? []).flatMap((scene) => scene.layers ?? [])) {
    if (layer.visible === false || !layer.animations?.length || placed.has(layer.id)) continue;
    const old = oldLayers.get(layer.id);
    if (old && JSON.stringify(old.animations ?? []) === JSON.stringify(layer.animations)) continue;
    const oldEntries = new Map(old ? animationTreeEntries(old.animations ?? [], { enabledOnly: true, groups: false }).map((entry) => [entry.stored?.id, entry]) : []);
    const layerName = ref(layer.id);
    const top = layer.animations.filter(isRecord);
    for (const { animation, stored, parents } of animationTreeEntries(layer.animations, { enabledOnly: true, groups: false })) {
      const found = jumpOf(layer, animation);
      const keys = found?.keys.filter((key) => !covered.has(`${layer.id} ${key}`)) ?? [];
      if (!keys.length) continue;
      const jump = { ...found, keys, distance: Math.hypot(...keys.map((key) => found.at[key] - found.before[key])) };
      const was = oldEntries.has(stored.id) ? jumpOf(old, oldEntries.get(stored.id).animation) : null;
      // The same jump moved with its layer is left alone too; one that now goes the other way is not.
      const step = (state, key) => state.at[key] - state.before[key];
      if (was && jump.keys.every((key) => was.keys.includes(key) && Math.abs(step(jump, key) - step(was, key)) <= SAME_PLACE)) continue;
      // layer.kind finds a top-level animation that is the only one of its kind; else its code.
      const kind = String(stored.kind ?? "").toLowerCase();
      const unique = top.filter((other) => String(other.kind ?? "").toLowerCase() === kind || String(other.name ?? "").toLowerCase() === kind);
      const named = !parents.length && /^[a-z]+$/.test(kind) && unique.length === 1 && unique[0].id === stored.id ? `${layerName}.${kind}` : ref(stored.id);
      const place = (state) => jump.keys.map((key) => `${key} ${shown(state[key])}`).join(", ");
      const what = `${named}${stored.name ? ` (${stored.name})` : ""} starts at ${place(jump.at)} at ${seconds(jump.start)} s, but ${layerName} is drawn at ${place(jump.before)} just before, so it jumps ${shown(jump.distance)} px.`;
      if (jump.path) {
        entries.push({ named, text: `${what} To start where it is, move the first point of its path to ${place(jump.before)}.`, ops: [] });
        continue;
      }
      // A preset that starts where the layer is when worked out again keeps its preset.
      const ops = [{ op: "update_animation", animation: named, properties: advisedProperties(stored, joined(stored, jump), layer, document) }];
      entries.push({ named, text: `${what}${ops[0].properties.preset ? PRESET_NOTE : ""} To start where it is: ${JSON.stringify(ops)}`, ops });
    }
  }
  const lines = entries.slice(0, LIST).map((entry) => entry.text);
  const rest = entries.slice(LIST);
  if (rest.length) {
    lines.push(`${rest.length} more ${rest.length === 1 ? "animation jumps" : "animations jump"} the same way (${rest.map((entry) => entry.named).join(", ")}). `
      + `To start ${rest.length === 1 ? "it" : "them"} where the layer is: ${JSON.stringify(rest.flatMap((entry) => entry.ops))}`);
  }
  return lines;
}
