// The edit-operation reference (backend/agent/operations.md), split into topics so an agent
// can read only the part it needs with the describe_operation tool.
import { readFileSync } from "node:fs";
import { effectDocumentation, MIX_DOCUMENTATION, sharedEffectDocumentation } from "../engine/effects/catalog.js";
import { effectPresetDocumentation } from "../engine/effects/presetCatalog.js";
import { BACKDROP_STYLE_DEFINITIONS } from "../engine/backdropStyles.js";

const GUIDE_PATH = new URL("./agent/operations.md", import.meta.url);
const BLUR_TOPIC_EFFECTS = ["directional-blur", "zoom-blur", "spin-blur", "focus-band", "edge-fill", "mirror", "kaleidoscope"];
// Keeps every describe_operation answer under the 8k-token answer budget: prose is about 2.5
// characters a token (backend/meter.mjs), and the topic list and the "more topics" line add up to
// about 2,000 characters. A lookup by type is kept shorter: it names the remaining topics instead.
const MAX_ANSWER_CHARS = 17_000;
const MAX_TYPE_ANSWER_CHARS = 8_000;

export const OPERATION_TYPES = Object.freeze([
  "rename_project", "update_project", "waive_check", "unwaive_check", "add_scene", "update_scene", "duplicate_scene", "delete_scene",
  "create_component", "create_component_from_layers", "insert_component", "detach_component",
  "set_component_overrides", "reset_component_overrides", "replace_media", "bulk_create",
  "add_layer", "update_layer", "update_layers", "convert_to_shape", "outline_text", "delete_layer",
  "align_layers", "group_layers", "ungroup_layer", "create_mask", "remove_mask",
  "reorder_layer", "move_layers", "set_layer_flags", "style_text_range",
  "add_animation", "update_animation", "update_animations", "delete_animation",
  "rename_animation", "group_animations", "ungroup_animations", "duplicate_animations",
  "convert_to_actions", "stagger_animations",
  "set_cues", "add_captions", "detect_beats", "add_sequence", "duck_audio", "cut_speech", "sync_clips", "fit_music",
  "place_broll", "color_filter", "keep_line", "frame_shot", "place_sounds",
]);
// Operations the agent service runs itself, not engine/operations.js, because they need this
// computer's tools first: isolate_voice splits a layer's sound (backend/voice) and then uses the
// engine's replace_media and add_layer; cut_out finds a layer's subject (backend/cutout) and then
// copies the layer and uses replace_media; match_color reads small frames of the footage
// (backend/agent/color-operation.mjs) and adds color effects. The guide describes them like any other operation.
// track follows an object through a video file (backend/cutout/track.mjs) and pin makes a layer
// follow a track (backend/agent/track-operation.mjs).
export const SERVICE_OPERATION_TYPES = Object.freeze(["isolate_voice", "cut_out", "match_color", "track", "pin", "stabilize"]);

// Reads the guide into {id, title, ops, text} topics. The "operations" topic lists every
// operation's fields, one per line.
export function parseGuide(markdown) {
  return markdown.split(/^## /m).slice(1).map((chunk) => {
    const [heading, opsLine, ...rest] = chunk.split("\n");
    const colon = heading.indexOf(": ");
    const [id, title] = colon < 0 ? [heading, ""] : [heading.slice(0, colon), heading.slice(colon + 2)];
    const ops = opsLine.replace(/^ops:\s*/, "").split(",").map((op) => op.trim()).filter((op) => op && op !== "-");
    return { id: id.trim(), title: title.trim(), ops, text: rest.join("\n").trim() };
  });
}

let topics;
export function guideTopics() {
  // The color, blur, light and particles topics' notes are in operations.md; their parameter lists come from the catalog.
  // The eight particle generators share most settings, so that topic writes each range once (about 1.6k characters, not 6k).
  const catalog = {
    color: () => `${effectDocumentation({ group: "Color" })}.`,
    blur: () => `${effectDocumentation({ keys: BLUR_TOPIC_EFFECTS })}.`,
    light: () => `${effectDocumentation({ group: "Light" })}.`,
    particles: () => sharedEffectDocumentation({ group: "Generate" }),
  };
  topics ??= [...parseGuide(readFileSync(GUIDE_PATH, "utf8")).map((topic) => catalog[topic.id]
    ? { ...topic, text: `${topic.text}\n\nCatalog: ${catalog[topic.id]()}` } : topic), ...catalogTopics()];
  return topics;
}

// Topics written from the effect and backdrop catalogs, so their lists always match the engine.
function catalogTopics() {
  const backdrops = Object.entries(BACKDROP_STYLE_DEFINITIONS).map(([key, definition]) =>
    `${key} (${definition.label}): enabled boolean, default false; ${definition.fields.map((field) =>
      `${field.key} number ${field.min}..${field.max}${field.suffix ? ` ${field.suffix}` : ""}, default ${definition.defaults[field.key]}`).join("; ")}`).join(". ");
  return [
    { id: "effects", title: "Effect animations", ops: ["add_animation", "update_animation", "delete_animation"],
      text: "library {topic:\"effects\"} lists every effect; with name it gives one effect's fields, ranges and defaults. Effect animations use kind:'effect', effect:<catalog key>, to:{parameters}, optional from:{initial parameters}, start, duration, easing and optional intensity. Add one with add_animation {sceneId,layerId,effect,parameters,start}; preset:'effect:<key>' is equivalent. Value effects default to 0.8 seconds at the playhead (clamped to the scene end); ranged effects default to the whole scene with keepStill:'both', and given a start or duration run only in that window (to the scene end without a duration) with keepStill:'off' unless keepStill is given. Override duration/easing, optional from, and ranged keepStill on add_animation, or edit them with update_animation properties; update_animation properties.to changes the settings it names and keeps the others. delete_animation removes them. Unknown keys, wrong types and out-of-range parameters are refused. Settings drawn 0..4 where 1 is unchanged (exposure, saturation) read 0.5 as half as much; \"+0.5 stop\" and \"-0.7\" as text mean a step in stops and a relative change. An omitted value-effect from samples the previous same effect at its start, or neutral, then holds its target; later value effects replace earlier ones of the same key. Ranged effects stack and use keepStill off/start/end/both: Off is active only within [start,start+duration), and held frames clamp both progress and the effect clock. Effects have no per-letter or preset In/Out fields; audio refuses effects. " + MIX_DOCUMENTATION + ". noise-mask cellSize 0 keeps scale's cells, which stretch with the layer; 1..64 makes square cells that many pixels wide on any layer size and ignores scale (it cuts holes; film grain is the grain effect); the grain repeats only on layers longer than 256 cells (512 px for 1-2 px cells). field works out expression (math: + - * / ^ %, comparisons, sin cos noise hash smoothstep mix length...) of u, v (0..1 across the layer), t (seconds into the effect), seed and a, b, c (animate these) at grid points; use alpha cuts where it is below threshold (0 keeps all, 1 cuts all: animate it to dissolve or wipe), color mixes toward color by it (0..1), displace moves each point amount px by (expression, expressionY) each -1..1, or with no expressionY toward the angle expression (radians). A bad expression is refused with where it fails. The Color effects (curves, lut, hue-saturation, white-balance, color-wheels, keep-color, color-ranges, color-look), their color space and recipes for common looks are in library {topic:\"rules\", name:\"color\"}; directional, zoom and spin blur, edge fill, mirror, kaleidoscope, their order and cost, and motion blur from movement are in library {topic:\"rules\", name:\"blur\"}. The Light effects (glow, light-rays, lens-flare) and their recipes are in library {topic:\"rules\", name:\"light\"}. The Generate effects (embers, sparks, snow, dust, rain, bokeh, fog, light-leaks) are in library {topic:\"rules\", name:\"particles\"} and overlay recipes in name:\"particle-recipes\". Catalog: " + effectDocumentation({ exceptGroup: ["Color", "Light", "Generate"] }) + "." },
    { id: "effect-presets", title: "Effect presets (In/Out)", ops: ["add_animation", "update_animation", "update_animations"],
      text: "Additional effect presets use the same add/update preset operations, In/Out mode, copy and text-unit timing as the catalog presets. They drive an effectPreset:{id,parameters,progress:0..1} endpoint channel, where 0 hides and 1 leaves the content untouched; later presets replace that channel in timeline order like Wipe. Mode changes keep fields. Changing the preset ID resets fields and easing to its defaults; an explicit easing override is retained. Catalog: " + effectPresetDocumentation() + "." },
    { id: "backdrop-styles", title: "Background blur and glass", ops: ["update_layer", "update_layers", "set_component_overrides", "add_animation"],
      text: "Visual layers also accept backgroundBlur and glass style objects through update_layer/update_layers and component overrides. Set enabled:true to turn a style on; null clears it. Missing members use the catalog defaults; unknown members, wrong types and values outside their ranges are refused. Audio cannot use these styles. Catalog: " + backdrops + ". Add the CUSTOM animations with preset:'background-blur' or preset:'glass'; their from/to endpoints contain the corresponding style object and interpolate its numeric fields. Background blur Blend 0 hides both the layer and its blur; any positive Blend applies the full backdrop blur with the layer's own appearance at that percentage. Glass Blend 0 keeps clear glass, with the layer's appearance added at positive Blend. Both sample lower paint inside their nearest scene or isolated-group backdrop root." },
  ];
}

function signature(type) {
  const list = guideTopics().find((topic) => topic.id === "operations").text;
  return list.split("\n").find((line) => line.startsWith(`- ${type} `) || line === `- ${type}`)?.slice(2);
}

function closest(word, choices) {
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0]++;
      for (let j = 1; j <= b.length; j++) {
        const current = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = current;
      }
    }
    return row[b.length];
  };
  return [...choices].sort((a, b) => distance(word, a) - distance(word, b)).slice(0, 3);
}

function render(sections, note, limit = MAX_ANSWER_CHARS) {
  let text = "";
  const skipped = [];
  for (const section of sections) {
    const block = `## ${section.id}: ${section.title}\n${section.text}\n\n`;
    // Topics that do not fit are named by id only, so the list stays short as topics are added
    // (add_animation's answer names about 16); the index has their titles.
    if (text.length + block.length > limit) skipped.push(section.id);
    else text += block;
  }
  if (skipped.length) text += `More topics match; read them with describe_operation {topic}: ${skipped.join(", ")}.\n`;
  return (note ? `${note}\n\n` : "") + text.trim();
}

// One topic read by name: the whole topic, or, when it is longer than an answer may be, its lines
// up to the limit and how to read the rest by a word (a topic too long once answered only "More
// topics match ...: <itself>", so none of it could be read whole).
function topicAnswer(entry) {
  const head = `## ${entry.id}: ${entry.title}\n`;
  if (head.length + entry.text.length + 2 <= MAX_ANSWER_CHARS) return render([entry]);
  const lines = entry.text.split("\n");
  let text = head;
  let shown = 0;
  while (shown < lines.length && text.length + lines[shown].length + 1 <= MAX_ANSWER_CHARS - 200) text += `${lines[shown++]}\n`;
  const left = lines.slice(shown).filter((line) => line.trim()).length;
  return `${text.trim()}\n\n(${left} more lines of ${entry.id}: describe_operation {topic} with search:"<word>" reads its lines that mention a word.)`;
}

// One topic cut down to its lines (paragraphs, list items, table rows) that mention a word, so an
// agent can read one recipe of a long topic: {topic:"particle-recipes", search:"snow-loop"}.
// A list item ("- " or indented) keeps the line that introduces its list (one ending in ":"), which
// says how to use it or, in rules quality, whether the item is an error or a warning.
export function linesMentioning(entry, search) {
  const needle = search.toLowerCase();
  const lines = [];
  let intro = null;
  for (const line of entry.text.split("\n")) {
    if (!line.trim()) continue;
    const listItem = line.startsWith("- ") || line.startsWith("  ");
    if (!listItem) intro = line.trimEnd().endsWith(":") ? line : null;
    if (!line.toLowerCase().includes(needle)) continue;
    if (listItem && intro && !lines.includes(intro)) lines.push(intro);
    lines.push(line);
  }
  if (!lines.length) return `No line of ${entry.id} mentions "${search}"; leave out search for the whole topic.`;
  return `## ${entry.id}: ${entry.title} (the lines that mention "${search}")\n${lines.join("\n")}`;
}

// The answer for describe_operation: an index (no arguments), one operation type with every
// topic that covers it, one topic (with a search word, only its lines that mention it), or every
// topic containing a search word.
export function describeOperation({ type, topic, search } = {}) {
  const all = guideTopics();
  if (type) {
    const types = [...OPERATION_TYPES, ...SERVICE_OPERATION_TYPES];
    if (!types.includes(type))
      throw new Error(`Unknown operation type "${type}". Did you mean ${closest(type, types).join(", ")}?`);
    const sections = all.filter((entry) => entry.ops.includes(type));
    return render(sections, signature(type), MAX_TYPE_ANSWER_CHARS);
  }
  if (topic) {
    const found = all.find((entry) => entry.id === topic);
    if (!found)
      throw new Error(`Unknown topic "${topic}". Did you mean ${closest(topic, all.map((entry) => entry.id)).join(", ")}?`);
    return search ? linesMentioning(found, search) : topicAnswer(found);
  }
  if (search) {
    const needle = search.toLowerCase();
    const sections = all.filter((entry) => `${entry.title}\n${entry.text}`.toLowerCase().includes(needle));
    if (!sections.length) return `No topic mentions "${search}". Topics: ${all.map((entry) => entry.id).join(", ")}.`;
    return render(sections, `Topics mentioning "${search}": ${sections.map((entry) => entry.id).join(", ")}`);
  }
  return render([all.find((entry) => entry.id === "operations")],
    `Topics: ${all.map((entry) => `${entry.id} (${entry.title})`).join("; ")}.`);
}
