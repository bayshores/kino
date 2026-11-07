// Writes skills/kino/references/fields.md: every edit op's fields on one line, grouped, made from
// the same field lines a refusal's `rules` sends (backend/agent/op-examples.mjs signatureFor).
// backend/skill.test.mjs fails when the file and the ops differ; run `npm run skill:fields` then.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signatureFor } from "../backend/agent/op-examples.mjs";
import { AGENT_OPERATION_TYPES } from "../backend/agent/translate.mjs";

export const FIELD_SHEET_PATH = fileURLToPath(new URL("../skills/kino/references/fields.md", import.meta.url));

// The groups, in the order an agent builds a video. An op in no group is listed under Other.
const GROUPS = [
  ["Building blocks", ["compose", "recipe", "move", "set_brand", "remove_brand", "set_cue", "remove_cue", "variants", "pick_variant", "make_template", "use_template"]],
  ["Layers", ["add_layer", "update_layer", "update_layers", "delete_layer", "duplicate_layers", "convert_to_shape", "outline_text", "group_layers", "ungroup_layer", "create_mask", "remove_mask", "reorder_layer", "move_layers", "set_layer_flags", "multi_transform", "import_svg"]],
  ["Layout", ["place", "align", "distribute", "stack", "fit", "align_layers"]],
  ["Text", ["set_font", "style_text_range", "apply_text_effect"]],
  ["Animations", ["add_animation", "update_animation", "update_animations", "delete_animation", "rename_animation", "stagger_animations", "group_animations", "ungroup_animations", "duplicate_animations", "convert_to_actions", "copy_animations", "apply_easing"]],
  ["Scenes", ["add_scene", "update_scene", "duplicate_scene", "delete_scene", "retime", "add_sequence"]],
  ["Components", ["create_component", "create_component_from_layers", "insert_component", "detach_component", "set_component_overrides", "reset_component_overrides"]],
  ["Media, sound, captions and cues", ["replace_media", "sync_clips", "duck_audio", "isolate_voice", "cut_out", "add_captions", "detect_beats", "set_cues"]],
  ["Project, copies and data", ["rename_project", "update_project", "waive_check", "unwaive_check", "copy_layers", "copy_scene", "bulk_create"]],
];

/** The text of fields.md for the ops the agent service runs now. */
export function fieldSheet() {
  const listed = new Set(GROUPS.flatMap(([, types]) => types));
  const known = new Set(AGENT_OPERATION_TYPES);
  const groups = [...GROUPS.map(([title, types]) => [title, types.filter((type) => known.has(type))]),
    ["Other", AGENT_OPERATION_TYPES.filter((type) => !listed.has(type))]].filter(([, types]) => types.length);
  const lines = [
    "# Edit op fields",
    "",
    "Every `edit` op on one line: `?` marks a field you may leave out, `|` a choice. One scene needs",
    "no `scene`. `library {topic:\"op\", name}` gives an op's full rules and an example that works.",
    "Made by `npm run skill:fields` from the agent service; do not edit by hand.",
    "",
    `Contents: ${groups.map(([title]) => title).join(" · ")}`,
  ];
  for (const [title, types] of groups) {
    lines.push("", `## ${title}`, "");
    for (const type of types) lines.push(`- \`${signatureFor(type) ?? type}\``);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(FIELD_SHEET_PATH, fieldSheet());
  console.log(`wrote ${FIELD_SHEET_PATH}`);
}
