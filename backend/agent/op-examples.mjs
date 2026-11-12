// One short example for every edit op, written the way an agent sends it.
//
// A refusal carries the example of its op (`example` in the answer), the library's op answer
// shows it, and scripts/field-sheet.mjs prints it in skills/kino/references/fields.md. Every
// example runs as written (backend/agent-op-examples.test.mjs) on the same small project:
//
//   one scene s1, 1920 × 1080, 6 s, with a text layer "title" ("Ship faster") and a
//   rectangle "card", each with a preset-fade entrance (title.in, card.in), and a fade-out exit
//   on title (title.out).
//
// `setup` lists the ops that make what an example needs first (a second scene, a component,
// a cue); with `saveSetup` they are saved in an edit of their own first. `media` names the
// imported files an example needs: "image", "music", "voice" or "video"; their `src`
// placeholders (/api/media/<music>.m4a) are replaced with real ones. `more` holds a few other
// examples that library {topic:"op"} shows on lines of their own ("Effect: {…}"), each with the
// same fields (label, op, setup, saveSetup), for a use that is easy to get wrong.

import { describeOperation } from "../operation-guide.mjs";
import { blockRules } from "./blocks.mjs";
import { REACH_HELP } from "./reach-operations.mjs";
import { MOVES } from "../../engine/blocks/moves/index.js";

export const EXAMPLE_PROJECT = {
  width: 1920,
  height: 1080,
  duration: 6,
  ops: [
    { op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 360, y: 240, width: 1200, height: 600, fill: "#151b33", radius: 32 }, animations: [{ preset: "preset-fade", start: 0, duration: 0.5 }] },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "Ship faster", x: 360, y: 420, width: 1200, height: 160, fontSize: 120, fill: "#ffffff", textAlign: "center" }, animations: [{ preset: "preset-fade", start: 0.3, duration: 0.5 }, { preset: "preset-fade", mode: "out", start: 5.4, duration: 0.4 }] },
  ],
};

const ctaScene = { op: "add_scene", name: "cta", width: 1920, height: 1080, duration: 4 };
const cardComponent = [
  { op: "add_scene", name: "badge", width: 560, height: 320 },
  { op: "add_layer", scene: "badge", layerType: "text", name: "badge-title", properties: { text: "Title", x: 32, y: 32, width: 496, height: 60, fontSize: 44 } },
  { op: "create_component", scene: "badge" },
];
const featureInstance = [...cardComponent,
  { op: "insert_component", scene: "s1", component: "badge", name: "feature-1", properties: { x: 120, y: 400 } }];
const musicLayer = { op: "add_layer", layerType: "audio", name: "music", properties: { src: "/api/media/<music>.m4a" } };
const voiceLayer = { op: "add_layer", layerType: "audio", name: "voice", properties: { src: "/api/media/<voice>.m4a", mediaSourceDuration: 2, mediaStart: 2 } };
const promo = { op: "compose", id: "promo", type: "promo", duration: 15, beats: [{ recipe: "logo-sting", text: "Orbit", tagline: "Plan the week in one view" }, { recipe: "feature-callout", text: "Shared calendars", sub: "Everyone sees the same week" }, { recipe: "cta-end", text: "Try Orbit free", sub: "orbit.app" }] };

export const OP_EXAMPLES = {
  rename_project: { op: { op: "rename_project", name: "Spring launch" } },
  update_project: { op: { op: "update_project", properties: { videoType: "promo" } } },
  waive_check: { op: { op: "waive_check", code: "default_font", target: "*", reason: "brand font" } },
  unwaive_check: { op: { op: "unwaive_check", code: "default_font", target: "*" }, setup: [{ op: "waive_check", code: "default_font", target: "*", reason: "brand font" }] },
  add_scene: { op: ctaScene },
  update_scene: { op: { op: "update_scene", properties: { duration: 8, background: "#0b1020" } } },
  duplicate_scene: { op: { op: "duplicate_scene", scene: "s1" } },
  delete_scene: { op: { op: "delete_scene", scene: "cta" }, setup: [ctaScene] },
  create_component: { op: { op: "create_component", scene: "badge" }, setup: cardComponent.slice(0, 2) },
  create_component_from_layers: { op: { op: "create_component_from_layers", layers: ["card", "title"], name: "hero-card" } },
  insert_component: { op: { op: "insert_component", scene: "s1", component: "badge", name: "feature-1", properties: { x: 120, y: 400, componentOverrides: { "badge-title": { text: "Shared calendars" } } } }, setup: cardComponent },
  detach_component: { op: { op: "detach_component", layer: "feature-1" }, setup: featureInstance },
  set_component_overrides: { op: { op: "set_component_overrides", layer: "feature-1", overrides: { "badge-title": { text: "Shared calendars" } } }, setup: featureInstance },
  reset_component_overrides: { op: { op: "reset_component_overrides", layer: "feature-1" }, setup: featureInstance },
  replace_media: { op: { op: "replace_media", layer: "logo", mediaId: "<image>.png" }, setup: [{ op: "add_layer", layerType: "image", name: "logo", properties: { src: "/api/media/<image>.png" } }], media: ["image"] },
  bulk_create: { op: { op: "bulk_create", csv: "id,title\nspring,Spring sale\nsummer,Summer sale\n" } },
  add_layer: { op: { op: "add_layer", layerType: "rectangle", name: "badge", properties: { x: 1500, y: 80, width: 320, height: 120, fill: "#ff7a45", radius: 24 } } },
  update_layer: { op: { op: "update_layer", layer: "title", properties: { fill: "#ffd166", fontSize: 96 } },
    // opacity 0 does not hide a layer whose fade-in ends at opacity 1; visible:false does.
    more: [{ label: "Hide", op: { op: "update_layer", layer: "title", properties: { visible: false } } }] },
  update_layers: { op: { op: "update_layers", layers: ["title", "card"], properties: { opacity: 0.8 } } },
  convert_to_shape: { op: { op: "convert_to_shape", layer: "card" } },
  outline_text: { op: { op: "outline_text", layer: "title" } },
  delete_layer: { op: { op: "delete_layer", layer: "card" } },
  align_layers: { op: { op: "align_layers", layers: ["title", "card"], align: "center" } },
  group_layers: { op: { op: "group_layers", layers: ["card", "title"], name: "hero" } },
  ungroup_layer: { op: { op: "ungroup_layer", layer: "hero" }, setup: [{ op: "group_layers", layers: ["card", "title"], name: "hero" }] },
  create_mask: { op: { op: "create_mask", layers: ["title", "card"], maskLayerId: "card", name: "masked" } },
  remove_mask: { op: { op: "remove_mask", layer: "masked" }, setup: [{ op: "create_mask", layers: ["title", "card"], maskLayerId: "card", name: "masked" }] },
  reorder_layer: { op: { op: "reorder_layer", layer: "card", to: "front" } },
  move_layers: { op: { op: "move_layers", layers: ["card"], position: "above", referenceId: "title" } },
  set_layer_flags: { op: { op: "set_layer_flags", layers: ["card"], locked: true } },
  style_text_range: { op: { op: "style_text_range", layer: "title", text: "faster", style: { fill: "#ff7a45", fontWeight: 700 } } },
  add_animation: { op: { op: "add_animation", layer: "title", preset: "preset-slide", start: 0.3, duration: 0.6, parameters: { direction: "up", distance: 40 } },
    // A Lowpass animation (Hz): music muffled until a drop at 4 s, opening over the bar before it.
    more: [{ label: "Muffled until the drop", op: { op: "add_animation", layer: "music", animation: { kind: "in", start: 2, duration: 2, easing: "ease-in", from: { lowpass: 400 }, to: { lowpass: 20000 } } },
      setup: [musicLayer], media: ["music"] }] },
  update_animation: { op: { op: "update_animation", animation: "title.in", properties: { start: 0.5, duration: 0.8 } },
    // An effect's settings are its to (and from); the effect is named title.effect once saved.
    more: [{ label: "Effect", op: { op: "update_animation", animation: "title.effect", properties: { to: { gamma: 0.6 } } },
      setup: [{ op: "add_animation", layer: "title", effect: "color-wheels", parameters: { gamma: 0.9 } }], saveSetup: true }] },
  update_animations: { op: { op: "update_animations", animationIds: ["title.in", "card.in"], properties: { easing: "ease-out" } } },
  delete_animation: { op: { op: "delete_animation", animation: "title.in" } },
  rename_animation: { op: { op: "rename_animation", animation: "title.in", name: "Title entrance" } },
  group_animations: { op: { op: "group_animations", animationIds: ["title.in", "title.out"], name: "intro" } },
  // A group is named <layer>.composed once saved (its setup is saved first).
  ungroup_animations: { op: { op: "ungroup_animations", animationIds: ["title.composed"] }, setup: [{ op: "group_animations", animationIds: ["title.in", "title.out"], name: "intro" }], saveSetup: true },
  duplicate_animations: { op: { op: "duplicate_animations", animationIds: ["title.in"] } },
  convert_to_actions: { op: { op: "convert_to_actions", animationIds: ["card.in"] } },
  stagger_animations: { op: { op: "stagger_animations", items: ["card", "title"], delay: 0.12 } },
  set_cues: { op: { op: "set_cues", cues: [{ name: "drop", time: 4.2 }] } },
  add_captions: { op: { op: "add_captions", text: "Plan, build and ship from one place.", start: 1, end: 4, name: "tagline", position: "top" } },
  detect_beats: { op: { op: "detect_beats", layer: "music" }, setup: [musicLayer], media: ["music"] },
  add_sequence: { op: { op: "add_sequence", properties: { name: "Film" }, scenes: ["s1", "cta"], transition: { type: "crossfade", duration: 0.4 } }, setup: [ctaScene] },
  fit_music: { op: { op: "fit_music", layer: "music", payoff: 4 }, setup: [musicLayer], media: ["music"] },
  duck_audio: { op: { op: "duck_audio", layer: "music", under: ["voice"], to: 0.25, fade: 0.25 }, setup: [musicLayer, voiceLayer], media: ["music", "voice"] },
  // With from, to and text no transcript is made; with line, the clip is transcribed (agent-speech.test.mjs).
  keep_line: { op: { op: "keep_line", layer: "voice", from: 2.2, to: 3.6, text: "I will be there.", duck: "music" }, setup: [musicLayer, voiceLayer], media: ["music", "voice"] },
  // An action id ("a2") needs a cut with moves (library sounds actions:true lists them); a time with a file runs anywhere.
  place_sounds: { op: { op: "place_sounds", at: [{ at: 2, sound: "/api/media/<voice>.m4a" }], under: 3 }, setup: [musicLayer], media: ["music", "voice"] },
  set_font: { op: { op: "set_font", layers: ["title"], family: "Montserrat", weight: 700 } },
  isolate_voice: { op: { op: "isolate_voice", layer: "interview", keep: "both" }, setup: [{ op: "add_layer", layerType: "video", name: "interview", properties: { src: "/api/media/<video>.mp4" } }], media: ["video"] },
  cut_out: { op: { op: "cut_out", layer: "footage", above: "title" }, setup: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: "/api/media/<video>.mp4" } }, { op: "reorder_layer", layer: "footage", to: "back" }], media: ["video"] },
  trace_image: { op: { op: "trace_image", layer: "plate", time: 1, region: [0, 0, 640, 360], colors: 4, name: "shape" }, setup: [{ op: "add_layer", layerType: "video", name: "plate", properties: { src: "/api/media/<video>.mp4" } }], media: ["video"] },
  track: { op: { op: "track", layer: "walk", at: 1, point: [50, 40], name: "phone" }, setup: [{ op: "add_layer", layerType: "video", name: "walk", properties: { src: "/api/media/<video>.mp4" } }], media: ["video"] },
  stabilize: { op: { op: "stabilize", layer: "walk", smooth: 1 }, setup: [{ op: "add_layer", layerType: "video", name: "walk", properties: { src: "/api/media/<video>.mp4" } }], media: ["video"] },
  pin: { op: { op: "pin", layer: "label", to: "phone", offset: [0, -80] }, setup: [{ op: "add_layer", layerType: "video", name: "walk", properties: { src: "/api/media/<video>.mp4" } }, { op: "track", layer: "walk", at: 1, point: [50, 40], name: "phone" }, { op: "add_layer", layerType: "text", name: "label", properties: { text: "Zuri" } }], media: ["video"] },
  place_broll: { op: { op: "place_broll", speech: "voice", clips: { walk: "the city at night" } }, setup: [voiceLayer, { op: "add_layer", layerType: "video", name: "walk", properties: { src: "/api/media/<video>.mp4" } }], media: ["voice", "video"] },
  color_filter: { op: { op: "color_filter", layer: "card", filter: "warm", strength: 0.8 }, setup: [{ op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 0, y: 0, width: 400, height: 300, fill: "#C8935A" } }] },
  match_color: { op: { op: "match_color", layers: ["walk"], to: "hero" }, setup: [{ op: "add_layer", layerType: "video", name: "hero", properties: { src: "/api/media/<video>.mp4" } }, { op: "add_layer", layerType: "video", name: "walk", properties: { src: "/api/media/<video>.mp4" } }], media: ["video"] },
  cut_speech: { op: { op: "cut_speech", layer: "voice", words: [3, 4], pauses: 0.4 }, setup: [voiceLayer], media: ["voice"] },
  // Without at, the two files' sound is matched (agent-sync.test.mjs); at names one moment in each file.
  sync_clips: { op: { op: "sync_clips", layer: "voice", to: "music", at: { layer: 0.5, to: 3 } }, setup: [musicLayer, voiceLayer], media: ["music", "voice"] },
  recipe: { op: { op: "recipe", name: "cta-end", id: "cta-end", text: "Start free today" } },
  move: { op: { op: "move", name: "rgb-split-hit", layer: "title", at: 1.5, beats: [2.5] } },
  compose: { op: promo },
  format: { op: { op: "format", id: "quote", name: "testimonial", slots: { name: "Orbit", quote: "We stopped double-booking in the first week", person: "Maya Lin, Head of Ops at Fieldwork", cta: "Try Orbit free", site: "orbit.app" } } },
  variants: { op: { op: "variants", scene: "promo", vary: "layout", count: 2 }, setup: [promo] },
  pick_variant: { op: { op: "pick_variant", scene: "promo" }, setup: [promo, { op: "variants", scene: "promo", vary: "layout", count: 2 }] },
  place: { op: { op: "place", layers: ["title"], slot: "center" } },
  align: { op: { op: "align", layers: ["title"], to: "center" } },
  distribute: { op: { op: "distribute", layers: ["card", "title"], axis: "y", within: "safe" } },
  stack: { op: { op: "stack", layers: ["title", "card"], direction: "down", gap: 24 } },
  fit: { op: { op: "fit", layers: ["title"], into: "safe" } },
  frame: { op: { op: "frame", layer: "card", rect: [25, 25, 50, 50], at: 2, cut: true } },
  set_cue: { op: { op: "set_cue", name: "drop", at: 2 } },
  remove_cue: { op: { op: "remove_cue", name: "drop" }, setup: [{ op: "set_cue", name: "drop", at: 2 }] },
  set_brand: { op: { op: "set_brand", name: "orbit", colors: { bg: "#0f1420", surface: "#1a2233", text: "#f4f6fb", accent: "#ff7a45", accent2: "#4fd1c5" }, fonts: [{ family: "Noto Serif" }], logos: [{ text: "Orbit" }] } },
  remove_brand: { op: { op: "remove_brand", name: "orbit" }, setup: [{ op: "set_brand", name: "orbit", colors: { bg: "#0f1420", surface: "#1a2233", text: "#f4f6fb", accent: "#ff7a45", accent2: "#4fd1c5" } }] },
  make_template: { op: { op: "make_template", scene: "s1", intro: 1, outro: 1 } },
  use_template: { op: { op: "use_template", template: "s1", name: "Spring", values: { title: "Spring sale" }, duration: 8 }, setup: [{ op: "make_template", scene: "s1", intro: 1, outro: 1 }] },
  retime: { op: { op: "retime", scene: "s1", duration: 8 } },
  shift: { op: { op: "shift", at: 2, by: 1.5 } },
  split_layer: { op: { op: "split_layer", layer: "footage", at: 0.8 }, setup: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: "/api/media/<video>.mp4" } }], media: ["video"] },
  split_image: { op: { op: "split_image", layer: "shot", boxes: [{ name: "bar", rect: [0, 0, 100, 20] }, { name: "row1", rect: [0, 20, 100, 40] }] }, setup: [{ op: "add_layer", layerType: "image", name: "shot", properties: { src: "/api/media/<image>.png" } }], media: ["image"] },
  mark_subject: { op: { op: "mark_subject", layer: "footage", t: 1, box: [30, 10, 40, 80] }, setup: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: "/api/media/<video>.mp4" } }], media: ["video"] },
  match_references: { op: { op: "match_references" } },
  lift_dark: { op: { op: "lift_dark", layer: "footage", target: 120 }, setup: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: "/api/media/<video>.mp4" } }], media: ["video"] },
  frame_shot: { op: { op: "frame_shot", layer: "footage" }, setup: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: "/api/media/<video>.mp4" } }], media: ["video"] },
  // A board covers the whole video (6 s here) or its music: one shot of the 2 s clip needs a 2 s scene
  // (an example stays under 400 characters, so it has one shot). The speaker's shot keeps its clip's
  // own sound: run 8 copied this example's sound "none" onto all 11 shots and built every clip
  // silent (.scratch/run8/trace/audio.md L69; transcript T235 to T243).
  board: { op: { op: "board", music: "none", shots: [{ cue: 0, dur: 2, pacing: "free", media: "<video>.mp4", in: 0, crop: [0, 7.8, 100, 84.4], subject: { what: "the speaker", box: [30, 10, 40, 80] },
    follow: "steady", text: { text: "Ship faster", family: "Montserrat", y: 80 }, sound: { keep: "all" }, why: "the speaker says the line" }] }, setup: [{ op: "update_scene", properties: { duration: 2 } }], media: ["video"] },
  source: { op: { op: "source", name: "their message", text: "Make a 15 s promo for Orbit: plan the week in one view. Link orbit.app at the end." } },
  duplicate_layers: { op: { op: "duplicate_layers", layers: ["card"], offset: 24 } },
  multi_transform: { op: { op: "multi_transform", layers: ["card"], action: { kind: "scale", scaleX: 120, scaleY: 120 } } },
  import_svg: { op: { op: "import_svg", svg: "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='#FF6B4A'/></svg>" } },
  copy_layers: { op: { op: "copy_layers", fromScene: "s1", layers: ["title"], scene: "cta" }, setup: [ctaScene] },
  copy_scene: { op: { op: "copy_scene", fromScene: "s1" } },
  copy_animations: { op: { op: "copy_animations", sourceAnimations: ["card.in"], layers: ["title"] } },
  // These two use an easing or text effect saved in the workspace (project manage easings/effects).
  apply_easing: { op: { op: "apply_easing", name: "Snappy", animationIds: ["title.in"] }, saved: "easings" },
  apply_text_effect: { op: { op: "apply_text_effect", name: "Pop words", layers: ["title"] }, saved: "effects" },
};

// The example op for a type (a copy), or null. A string `layer` (the layer the agent named)
// takes the place of the example's own layer, so the example reads as the agent's next op.
// A move op's example is the named move's own (a refused tile-ring answers with a tile-ring).
export function exampleFor(type, layer, moveName = null) {
  const move = type === "move" && typeof moveName === "string" ? MOVES[moveName] : null;
  if (move) return { op: "move", name: move.name, ...structuredClone(move.example) };
  const entry = OP_EXAMPLES[type];
  if (!entry) return null;
  const example = structuredClone(entry.op);
  if (typeof layer === "string" && layer && typeof example.layer === "string" && !entry.setup) example.layer = layer;
  return example;
}

/** The other examples of a type, as [{label, op}] (copies); none for most ops. */
export function moreExamplesFor(type) {
  return (OP_EXAMPLES[type]?.more ?? []).map(({ label, op }) => ({ label, op: structuredClone(op) }));
}

// The engine's field names and the shorter names agents send (both work).
const AGENT_NAMES = [[/\bsceneId\b/g, "scene"], [/\blayerIds\b/g, "layers"], [/\blayerId\b/g, "layer"],
  [/\bcomponentSceneId\b/g, "component"], [/\banimationId\b/g, "animation"], [/\bparentId\b/g, "parent"], [/\btoId\b/g, "to"]];

// "type {…}" (and " or {…}" after it) at the start of a rule: the op's fields.
function leadingFields(text) {
  const groups = [];
  let at = text.indexOf("{");
  while (at !== -1) {
    let depth = 0;
    let end = at;
    for (; end < text.length; end += 1) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}" && (depth -= 1) === 0) break;
    }
    groups.push(text.slice(at, end + 1));
    at = text.startsWith(" or {", end + 1) ? end + 5 : -1;
  }
  return groups.join(" or ");
}

/**
 * An op's fields in one short line, with the names agents send: `add_layer {scene?, layerType,
 * properties, animations?}`. scene is optional while the project has one scene. Null for an
 * unknown type.
 */
export function signatureFor(type) {
  let rule = type === "set_font" ? "set_font {layers, family, weight?, style?}" : blockRules(type) ?? REACH_HELP[type];
  // The engine's ops fill in sceneId when the project has one scene.
  const engine = !rule;
  if (engine) {
    try { rule = describeOperation({ type }).split("\n\n")[0]; } catch { return null; }
  }
  if (!rule.startsWith(`${type} {`)) return null;
  let fields = leadingFields(rule);
  // An op with two forms (compose from footage, compose from beats) shows both.
  const second = rule.indexOf(`. ${type} {`);
  if (second > 0) fields = `${fields} or ${leadingFields(rule.slice(second + 2))}`;
  for (const [pattern, name] of AGENT_NAMES) fields = fields.replace(pattern, name);
  if (engine) fields = fields.replace(/\{scene, /g, "{scene?, ");
  return `${type} ${fields}`;
}
