// The ten MCP tools agents use by default. Each one sends its input to the server's agent
// service through the shared client, so the MCP tools and the kino command line behave the
// same. Descriptions are short on purpose: every agent reads them on every turn, and the
// whole list must stay within TOOL_LIST_TOKEN_BUDGET (backend/agent-mcp.test.mjs and
// `npm run mcp:budget` check this). Each description's first sentence says what the tool does
// in the words an agent would search for: Claude Code finds deferred tools by their description.
import os from "node:os";
import { z } from "zod";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { importedText } from "./client.mjs";
import { closest } from "./refs.mjs";
import { LIBRARY_TOPICS, NOTES_ACTIONS, SEARCH_KINDS } from "./actions.mjs";

/**
 * The most the ten tool definitions may cost an agent, in estimated Claude tokens: the JSON of
 * the tools/list answer ÷ 2.1 characters per token (backend/meter.mjs). Set on 2026-10-19 at the
 * trimmed list's size (11,097 characters, about 5,285 tokens) plus about 10%.
 */
export const TOOL_LIST_TOKEN_BUDGET = 5_800;

/**
 * What Claude Code shows the agent at the start of every session, before any tool is loaded
 * (it cuts this text at 4,096 characters). The first paragraph stands on its own: what kino is,
 * when to use it, and the loop. Tool names are as Claude Code shows them.
 */
export const AGENT_INSTRUCTIONS = [
  "kino makes motion videos: animated promos, social clips, explainers, title cards, logo animations, kinetic text and captions, rendered to MP4, GIF, WebM, MOV, PNG or Lottie. Use kino's tools whenever the person wants a video or animation made, changed, checked or exported. The loop: mcp__kino__status (read the open project) → mcp__kino__edit (all changes for a step in one call) → mcp__kino__check (quality gates) → mcp__kino__look (see rendered frames) → mcp__kino__render (export the file).",
  "Load the other tools by searching for them when needed: mcp__kino__project (create, open, import media and fonts, share), mcp__kino__library (exact op fields, easings, fonts, recipes), mcp__kino__inspect (exact layer details), mcp__kino__history (undo a turn, restore a version) and mcp__kino__notes (the plan and the person's notes). Installed as a plugin, the names start with mcp__plugin_kino_kino__ instead.",
  [
    "How to work:",
    "- Start with status, and deal with notes in its inbox first. A person may be watching in the kino app and can leave notes, approve or undo.",
    "- New video: project create, then the brief from the chat (notes brief; library guide direction), then notes set_plan with a few steps; set_plan {done:[n]} ticks one off.",
    "- Every answer ends with next: the most likely next call, written out. When unsure, send it as it is; put your own words where it has <angle brackets>.",
    "- Read each edit's receipt instead of calling status again. Refer to layers, scenes and animations by name or code (L1, s1, A1).",
    "- A refused edit saves nothing: its next call resends it with the fix (retry and fix).",
    "- Check errors (in a real edit, warnings too) block a final render; check fix:\"auto\" applies the safe fixes.",
    "- Ask each stop when status next: names it (notes checkpoint). A stop may answer waiting_for_you: send its ask to the person and end your turn. Until they answer, that project's writes answer {waiting}; record their reply with notes answer.",
    "- Look once per pass, then look mode:\"changed\" after fixes. Before a final render, look mode:\"review\" until every moment is reviewed, and fix what it shows.",
    "- Footage: look mode:\"source\" shows every clip (never FFmpeg sheets, grabs or re-encodes). To crop it to another shape, look source on its layer first, then mark the subject (library guide framing).",
    "- Unsure of an op's fields: library topic:\"op\". Without the kino skill: library topic:\"guide\".",
    "- If a tool says kino is not running, ask the person to open the kino app.",
    "- Every tool takes why (a few words: the reason for this call) and next (what you do after it); the person watching sees them. project defaults to the open one; scene is a name or code (s1).",
  ].join("\n"),
].join("\n\n");

// The instructions say once what these mean (project: default the open one; scene: name or
// code), so the tools do not repeat it ten times. status keeps its own words.
const project = z.string().optional();
const scene = z.string().optional();
// Frames a second: 1 to 120, or 23.976, 29.97, 59.94. The service reads each with readFps
// (engine/frameRate.js), which also takes "30000/1001" and {num, den} (render options.fps, HTTP, CLI).
const fps = z.number().min(1).max(120);
// What the agent says about each call: why it makes it and what it does next (said.mjs). Every
// tool takes them; the dashboard shows them to the person watching. Explained in the instructions.
const SAID = { why: z.string().optional(), next: z.string().optional() };

// MCP behaviour hints. When a hint is left out, the MCP spec assumes the cautious value (not
// read-only, destructive, not idempotent, open world), so every tool sets all four.
// openWorldHint is false everywhere: kino works on this computer only.
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const CAN_LOSE_DATA = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export const AGENT_TOOLS = withSaid([
  {
    name: "status",
    title: "Read the project",
    hints: READS, // reads; only notes which layers the agent has seen
    alwaysLoad: true,
    description: "Read the open motion project as an outline: one line per layer: name, code (L1), type, position, size, look, animations (A1 in fade 0.2–0.8); layers already read are only counted. Also: direction, step and deck (trust them over memory), the plan, check counts, the person's notes (inbox). No project open: lists projects.",
    input: {
      project: z.string().optional().describe("Project id or name; default: the open project"),
      scene,
      page: z.number().int().min(1).optional(),
      full: z.boolean().optional().describe("Repeat unchanged layers"),
    },
  },
  {
    name: "edit",
    title: "Edit the project",
    hints: WRITES, // every edit is a saved revision that history can revert or restore
    alwaysLoad: true,
    description: [
      "Change the motion project (layers, animations, scenes) with a list of operations, saved as one revision. The receipt: new names, codes, changes, check counts.",
      "Each op is {op, ...fields}; refer to things by name, code (L3, s1, A2) or layer.kind (title.in); one scene needs no sceneId.",
      "Common ops: add_layer {layerType:rectangle|ellipse|text|image|video|audio|group, name, properties:{x,y,width,height,fill,text,fontSize}} · update_layer {layer, properties} · delete_layer · add_animation {layer, preset, start, duration} (preset-fade, move, …) · set_font {layers, family, weight}",
      "library {topic:\"op\", name} gives exact fields. A refused edit saves nothing; resend it fixed: {retry:\"E1\", fix:{\"3\":{fields}}}.",
    ].join("\n"),
    input: {
      ops: z.array(z.record(z.string(), z.any())).min(1).max(200).optional().describe("add_layer may hold animations:[{preset, start, duration}]. compose {format, look, duration, beats:[{recipe, text}]} builds a scene, format {name, slots} a whole video; recipe, move, place/align/stack/fit, set_brand, set_cue, variants, templates, retime: library blocks. at: seconds, \"after:x\", \"with:x+0.1\", \"cue:x\", \"auto\"."),
      retry: z.string().max(16).optional().describe("A refused edit's code: send its ops again"),
      fix: z.record(z.string(), z.any()).optional().describe("With retry: op number → fields to change (null removes one), a whole op, or null to drop it"),
      rev: z.number().int().min(1).optional().describe("The rev you read: the edit is rebased, or refused if it no longer applies"),
      project,
      dry_run: z.boolean().optional().describe("Plan: the receipt, nothing saved"),
      request_id: z.string().max(128).optional().describe("Repeat-safe: the same id is saved once"),
    },
  },
  {
    name: "check",
    title: "Check quality",
    hints: WRITES, // fix:"auto" saves its fixes as one edit (a revision history can undo); a second run may fix more
    alwaysLoad: true,
    description: [
      "Check the animation's quality: the top 10 findings, each with a measured value, what is required and a fix op.",
      "Errors (type size, overlap, contrast, reading time, …) block a final render, in a real edit warnings too; advice (info) never.",
      "fix:\"auto\" applies the fixes marked (auto) as one edit. rules: only these rule codes (true: repeat the Rules line). pixels:false skips pixel checks.",
      "A deliberate exception: edit with waive_check {code, target, reason}.",
    ].join("\n"),
    input: {
      project, scene,
      fix: z.literal("auto").optional(),
      rules: z.union([z.literal(true), z.array(z.string()).max(40)]).optional(),
      pixels: z.boolean().optional(),
      fps: fps.optional().describe("Output frame rate to judge judder at (default 30)"),
    },
  },
  {
    name: "look",
    title: "See frames",
    hints: READS, // renders the saved project to images; changes nothing
    alwaysLoad: true,
    // source times:[s] is not listed (the tool list's budget): keepUnknownKeys passes it on.
    keepUnknownKeys: true,
    description: [
      "See the saved animation. Modes:",
      "sheet (default): 12 frames a scene, by shot; from/to a stretch.",
      "review: each moment that matters, findings, seams; again: what changed. Final needs it.",
      "frame: one at t, up to 1280 px.",
      "frames: every frame (30 fps) from/to, 36 max.",
      "motion: graph + trace of pushes, movers, cover, slivers, cuts.",
      "zoom: one layer close up.",
      "strip: 6 frames of one animation (anim); every:true all.",
      "compare: beside rev.",
      "changed: since your last look.",
      "variants: in rows.",
      "source: every clip, or a layer's crop; times:[s].",
      "board: the storyboard, 4 shots a page.",
      "reference: an inspire ref near t.",
      "versus: beside saved references, gaps; final needs it.",
      "viewer: packet for a fresh viewer (after notes intents).",
      "critique: packet for a fresh critic; P0s block final.",
    ].join("\n"),
    input: {
      mode: z.enum(["sheet", "review", "frame", "frames", "motion", "zoom", "strip", "compare", "changed", "variants", "source", "board", "reference", "versus", "viewer", "critique"]).optional(),
      scene,
      t: z.number().min(0).optional(),
      from: z.number().min(0).optional(),
      to: z.number().min(0).optional(),
      layer: z.string().optional(),
      anim: z.string().optional(),
      every: z.boolean().optional(),
      ref: z.string().optional(),
      rev: z.number().int().min(1).optional(),
      width: z.number().int().min(64).max(1920).optional(),
      page: z.number().int().min(1).optional(),
      project,
    },
  },
  {
    name: "inspect",
    title: "Inspect layers",
    hints: READS, // reads only
    description: "Exact properties of up to 10 layers or animations: non-default fields, every animation. Targets: names, codes or selectors like text, text[fontSize>40], *[name~=title], animation[kind=in], s2 rectangle. fields: only those keys. cues (or cues[kind=beat]) lists named moments and rhythm; speech:<layer> a voice's words; cuts the cut list.",
    input: { targets: z.array(z.string()).min(1).max(20), fields: z.array(z.string()).max(20).optional(), project },
  },
  {
    name: "render",
    title: "Render video",
    hints: CAN_LOSE_DATA, // can overwrite an earlier export file (after the person approves); history cannot bring that file back
    description: "Export: start, wait (checked files, 55s), status, queue, cancel. draft: half size/30fps; preview:fast: 640px/15fps. from/to: draft excerpt. final: full size, gated. awaiting_approval: wait {job:id}. Details: library rules render.",
    input: {
      action: z.enum(["start", "wait", "status", "cancel", "queue"]).optional(),
      quality: z.enum(["draft", "final"]).optional(),
      preview: z.literal("fast").optional(),
      from: z.number().nonnegative().optional(),
      to: z.number().positive().optional(),
      format: z.enum(["mp4", "webm", "mov", "gif", "png", "apng", "png-sequence", "lottie"]).optional(),
      motionBlur: z.number().min(0).max(1).optional(),
      dither: z.boolean().optional(),
      options: z.record(z.string(), z.unknown()).optional(),
      scene,
      fps: fps.optional(),
      job: z.string().optional(),
      wait: z.boolean().optional().describe("start: answer once files are checked"),
      out: z.string().optional().describe("Absolute folder"),
      project,
    },
  },
  {
    name: "library",
    title: "Look up docs",
    // Reads the project; inspire also keeps its searches and saved references (not the document).
    hints: READS,
    // Fields the list leaves out for its budget (music note and measure, sounds source, footage
    // scan and want) still reach the service: keepUnknownKeys passes them on.
    keepUnknownKeys: true,
    description: "How kino works: op {name} (exact fields), rules {name} (captions, beats, cues…), search {search}, fonts {search}, media {page}, sounds|music {search} (CC0 effects; moods), blocks (recipes, looks), inspire {search|name|ideas} (YouTube edits), techniques.",
    input: {
      topic: z.enum(LIBRARY_TOPICS),
      name: z.union([z.string(), z.array(z.string()).max(8)]).optional(),
      search: z.string().optional(),
      full: z.boolean().optional(),
      ideas: z.record(z.string(), z.any()).optional(),
      page: z.number().int().min(1).optional(),
      kind: z.enum(SEARCH_KINDS).optional(),
      count: z.number().int().min(1).optional(), // inspire.mjs asks for at most MAX_SEARCH_COUNT
    },
  },
  {
    name: "history",
    title: "Undo and versions",
    hints: WRITES, // revert and restore save a new revision, so nothing is lost; revert without turn undoes the next turn back
    description: "Undo turns (groups of edits) or saved revisions. list; revert {turn} undoes one turn, keeping later ones; restore {rev} brings one back.",
    input: { action: z.enum(["list", "revert", "restore"]).optional(), turn: z.string().optional(), rev: z.number().int().min(1).optional(), project },
  },
  {
    name: "notes",
    title: "Plan and notes",
    hints: WRITES, // adds notes and replies; set_plan replaces only the agent's own step list; brief saves what the person said
    // A key the schema does not name still reaches the service, which refuses it for brief: a
    // typo such as "field" must not turn a save into a read (the SDK drops unknown keys otherwise).
    keepUnknownKeys: true,
    description: "Plan and notes the person sees. set_plan {steps}, then {done:[2]}; list; reply {id, text}; resolve {id}; add {text}; keep {id, layers} ties layers to a note; brief {fields?, log?, no_playback?}; deck {reroll|swap}; checkpoint {id} asks a stop; answer {id, rev, words, read_as, rejected?}; helper {text}; release; judge: blind picks vs references or videos:[[a,b]]. intents {beats:[{from,to,intent}]}; viewer {rev, report, matches, bugs}; critique {rev, lines, +matches, bugs if carried}; verdict {of, rev, words, best}: their verdict, best = bar; needs {items:[{what,why,ask,options}]} or {id, answer|status}: missing material.",
    input: {
      // helper's may ("all" or "look") is not listed: keepUnknownKeys passes it to the service.
      action: z.enum(NOTES_ACTIONS).optional(),
      steps: z.array(z.union([z.string(), z.object({ text: z.string(), done: z.boolean().optional() })])).max(12).optional(),
      done: z.union([z.number().int(), z.array(z.number().int())]).optional(),
      id: z.string().optional(),
      text: z.string().max(2000).optional(),
      layer: z.string().optional(),
      layers: z.array(z.string()).optional(),
      t: z.number().min(0).optional(),
      fields: z.record(z.string(), z.any()).optional(),
      log: z.array(z.any()).optional(),
      no_playback: z.string().optional(),
      rev: z.number().int().optional(),
      words: z.string().optional(),
      read_as: z.string().optional(),
      reroll: z.boolean().optional(),
      swap: z.object({ out: z.string(), in: z.string(), why: z.string() }).optional(),
      project,
    },
  },
  {
    name: "project",
    title: "Manage projects",
    hints: CAN_LOSE_DATA, // manage can delete a trashed project forever and remove saved items (after the person approves)
    // import's from/to (a found video's stretch) is not listed: keepUnknownKeys passes it on.
    keepUnknownKeys: true,
    description: "list; create {id, name, width, height, duration}; open, duplicate, archive (to Trash) {id}; import {file} (absolute path or openverse:<id>); share {id, role} (the person approves); record {options:{step}} the screen (library guide recording); manage {options} (library rules workspace).",
    input: {
      action: z.enum(["list", "create", "open", "duplicate", "archive", "import", "share", "record", "manage"]),
      role: z.enum(["view", "comment", "edit"]).optional(),
      options: z.record(z.string(), z.any()).optional(),
      id: z.string().optional(),
      name: z.string().max(120).optional(),
      width: z.number().int().min(16).max(8192).optional(),
      height: z.number().int().min(16).max(8192).optional(),
      duration: z.number().min(0.1).max(600).optional(),
      background: z.string().optional(),
      file: z.string().optional(),
    },
  },
]);

// Every tool's input ends with why and next.
function withSaid(tools) {
  return tools.map((tool) => ({ ...tool, input: { ...tool.input, ...SAID } }));
}

// ---- a smaller, fixed tools/list ----------------------------------------------------------
// The JSON Schema the MCP SDK makes from zod carries words every agent pays for and that
// change nothing:
// - $schema: the dialect, repeated in every tool (without it, MCP reads JSON Schema 2020-12);
// - maximum 9007199254740991 and minimum -9007199254740991: zod's whole-number bounds;
// - propertyNames {type:"string"} and additionalProperties {}: true of every JSON object;
// - execution {taskSupport:"forbidden"}: what MCP assumes when it is left out.
// Real limits (enum, required, min and max) stay. Keys are written in one fixed order, so the
// answer is the same, byte for byte, every time and in every process.

const SCHEMA_KEY_ORDER = ["type", "description", "enum", "const", "default", "minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum",
  "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "items", "properties", "required", "additionalProperties", "anyOf", "oneOf", "allOf"];
// Keywords whose value is another schema, a list of schemas, or a map of name → schema.
const SUBSCHEMA = new Set(["items", "additionalProperties", "propertyNames", "not", "contains"]);
const SUBSCHEMA_LIST = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SUBSCHEMA_MAP = new Set(["properties", "$defs", "definitions", "patternProperties"]);

function inOrder(object, order) {
  const rank = (key) => (order.includes(key) ? order.indexOf(key) : order.length);
  return Object.keys(object).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

const isEmptyObject = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
const isPlainString = (value) => value && typeof value === "object" && Object.keys(value).length === 1 && value.type === "string";

/** A JSON Schema without the words that change nothing, keys in a fixed order. */
export function compactSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out = {};
  for (const key of inOrder(schema, SCHEMA_KEY_ORDER)) {
    const value = schema[key];
    if (key === "$schema") continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    if (key === "propertyNames" && isPlainString(value)) continue;
    if (key === "additionalProperties" && isEmptyObject(value)) continue;
    if (SUBSCHEMA.has(key)) out[key] = Array.isArray(value) ? value.map(compactSchema) : compactSchema(value);
    else if (SUBSCHEMA_LIST.has(key) && Array.isArray(value)) out[key] = value.map(compactSchema);
    // Property names keep the order they were declared in (ops before project, and so on).
    else if (SUBSCHEMA_MAP.has(key) && value && typeof value === "object") out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, compactSchema(child)]));
    else out[key] = value;
  }
  return out;
}

const TOOL_KEY_ORDER = ["name", "title", "description", "inputSchema", "outputSchema", "annotations", "execution", "_meta"];
const HINT_ORDER = ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

/** One tools/list entry, compacted and with its keys in a fixed order. */
export function compactTool(tool) {
  const out = {};
  for (const key of inOrder(tool, TOOL_KEY_ORDER)) {
    const value = tool[key];
    if (value === undefined) continue;
    if (key === "execution" && Object.keys(value).length === 1 && value.taskSupport === "forbidden") continue;
    if (key === "inputSchema" || key === "outputSchema") out[key] = compactSchema(value);
    else if (key === "annotations") out[key] = Object.fromEntries(inOrder(value, HINT_ORDER).map((hint) => [hint, value[hint]]));
    else out[key] = value;
  }
  return out;
}

/**
 * Makes the server's tools/list answer compact and stable (see above). Call it before the
 * first registerTool: the SDK installs its tools/list handler then, and this wraps it.
 */
export function compactToolList(server) {
  const lowLevel = server.server;
  const setRequestHandler = lowLevel.setRequestHandler.bind(lowLevel);
  lowLevel.setRequestHandler = (schema, handler) => setRequestHandler(schema, schema !== ListToolsRequestSchema ? handler
    : async (request, extra) => {
      const result = await handler(request, extra);
      return { ...result, tools: result.tools.map(compactTool) };
    });
}

/**
 * A tools/call result the SDK refused by the input schema ("Input validation error: Invalid
 * arguments for tool look: Invalid option: expected one of "sheet"|... at mode"), rewritten in
 * kino's refusal shape: the field, what it takes, the closest choice and the call with it.
 */
export function schemaRefusal(result, { name, arguments: input = {} } = {}) {
  const text = result.content?.[0]?.text ?? "";
  const said = text.replace(/^.*?Invalid arguments for tool \S+:\s*/s, "").trim();
  const choice = /expected one of ((?:"[^"]*"\|?)+) at (\S+)/.exec(said);
  const reply = { error: "bad_input", reason: said };
  if (choice) {
    const choices = [...choice[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    const field = choice[2];
    const path = field.split(".");
    const value = path.reduce((object, key) => (object == null ? undefined : object[key]), input);
    const best = closest(String(value ?? ""), choices, 1)[0];
    reply.reason = `${field} ${JSON.stringify(value)} is not one of ${choices.join(", ")}.${best ? ` Did you mean ${best}?` : ""}`;
    if (best && path.length === 1) reply.next = `${name} ${JSON.stringify({ ...input, [field]: best })}`;
  }
  return { content: [{ type: "text", text: JSON.stringify(reply) }], isError: true };
}

// An output folder must be absolute. A leading ~ is your home folder, as on the kino command
// line; anything else is sent as typed (the service refuses a relative folder).
function homeFolder(folder) {
  return typeof folder === "string" ? folder.replace(/^~(?=$|\/)/, os.homedir()) : folder;
}

// render out and project manage exports out, with a leading ~ made absolute.
function withHomeFolders(name, input) {
  if (name === "render" && input.out !== undefined) return { ...input, out: homeFolder(input.out) };
  if (name === "project" && input.options?.resource === "exports" && input.options.out !== undefined)
    return { ...input, options: { ...input.options, out: homeFolder(input.options.out) } };
  return input;
}

// A service reply as MCP content: the text, then any images (also saved as files).
export function toolResult(reply) {
  const content = [{ type: "text", text: reply.text ?? "" }];
  for (const image of reply.images ?? []) if (image.data) content.push({ type: "image", data: image.data, mimeType: image.mime ?? "image/png" });
  return { content, ...(reply.isError ? { isError: true } : {}) };
}

/**
 * Runs one agent tool through the client and answers MCP content. The registered tools and the
 * tools reloaded from a newer kino (tool-sync.mjs) both use it, so they behave the same.
 */
export async function runAgentTool(server, client, name, input, context) {
  // The connected agent's own name (such as "claude-code"), shown in the dashboard.
  const clientName = server.server?.getClientVersion?.()?.name;
  try {
    if (name === "project" && input.action === "import") {
      if (!input.file) return toolResult({ isError: true, text: "import needs file: an absolute path." });
      const media = await client.importFile(input.file, { signal: context?.signal, client: clientName, input });
      return toolResult(media.refused ?? media.reply ?? { text: importedText(media) });
    }
    return toolResult(await client.call(name, withHomeFolders(name, input), { signal: context?.signal, client: clientName }));
  } catch (error) {
    return toolResult({ isError: true, text: error instanceof Error ? error.message : String(error) });
  }
}

/** Registers the ten tools on an McpServer. `client` comes from createAgentClient. */
export function registerAgentTools(server, client) {
  for (const tool of AGENT_TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.keepUnknownKeys ? z.looseObject(tool.input) : tool.input,
      annotations: tool.hints,
      // Claude Code loads these four up front instead of behind tool search.
      ...(tool.alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
    }, (input, context) => runAgentTool(server, client, tool.name, input, context));
  }
}
