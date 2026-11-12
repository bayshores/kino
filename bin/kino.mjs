#!/usr/bin/env node
// The kino command line. It has the same ten verbs as the MCP tools, and two more:
//   kino mcp     runs the MCP server (what agents connect to)
//   kino setup   connects Claude Code and Codex to kino (asks before changing anything)
// Run `kino help` for examples.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentSession } from "../backend/agent/agent-session.mjs";
import { KINO_IMPORT, createAgentClient, importedText, resolveConnection } from "../backend/agent/client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERBS = ["status", "edit", "check", "look", "inspect", "render", "library", "history", "notes", "project"];

// Field names agents type that mean another field of the verb.
const FIELD_ALIASES = { inspect: { layer: "targets", layers: "targets" } };

// Words after the verb that fill fields, in order: `kino look sheet s2`, `kino history revert T3`.
const POSITIONAL = {
  status: ["scene"],
  check: ["scene"],
  look: ["mode", "scene"],
  render: ["action", "job"],
  library: ["topic", "name"],
  history: ["action", "turn"],
  notes: ["action", "text"],
  project: ["action", "id"],
};

const HELP = `kino: make motion videos from the command line or an AI agent.

  kino status                          the open project as an outline
  kino edit ops.json                   apply operations from a file (or - for stdin)
  kino edit '[{"op":"update_layer","layer":"title","properties":{"fill":"#ff5500"}}]'
  kino check                           problems and their fixes
  kino check fix=auto                  apply the fixes marked (auto)
  kino look sheet                      the scene in one image (saved as a PNG; the path is printed)
  kino look frame t=2.5                one frame
  kino look source layer=clip t=2      a clip's whole frame, crop and boxes
  kino look board page=2               the storyboard, 4 shots a page
  kino inspect title "text[fontSize>40]"   (or layers=title,body)
  kino render start quality=final out=~/Movies && kino render wait
  kino library op add_animation        one operation's fields
  kino history                         turns; kino history revert T3 undoes one
  kino notes add "Make the logo bigger" layer=logo
  kino project create id=launch name="Launch" duration=15
  kino project import /path/to/logo.png   (or path=~/logo.png)

  key=value sets any field (values are read as JSON when they can be: t=2 full=true).
  A JSON object after the verb sets all fields: kino look '{"mode":"zoom","layer":"logo"}'.
  Every verb takes why= and next=, a few words the person watching in kino sees:
  kino check why="see what blocks a final render" next="fix the contrast".
  Fields are never --flags: kino look frame t=3, not --time 3. The only options are below.
  A list is one word: kino inspect tagline fields=x,width. After a comma and a space the list
  goes on only into a field inspect knows, so in fields=x, tagline the word tagline is a name.

Options go before or after the verb: kino --project launch status, kino status --project launch.
  --json          print the whole reply as JSON
  --you           record the action as yours, not an agent's (shown to the agent in its inbox)
  --project <id>  act on this project instead of the open one (--project=<id> works too)

Exit code: 0 when it worked; 1 when kino is not running, refused the command or the render
failed; 2 for an unknown command or option.

Connecting agents:
  kino mcp     run the MCP server (agents start this themselves)
  kino setup   connect Claude Code and Codex (lists every change and asks first)
  kino watch   print the person's new notes as they leave them, one line per batch (run it in the
               background; notes written close together come as one line, after 8 s without a
               new one: settle=<seconds> changes that); kino watch pending lists the unread ones
               and exits 2 when there are any (for an agent's stop hook)

kino must be running: open the kino app, or run npm run dev in the kino folder.`;

function parseValue(text) {
  try { return JSON.parse(text); } catch { return text; }
}

async function readOps(source) {
  if (source === "-") {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return JSON.parse(text);
  }
  if (/^\s*[[{]/.test(source)) return JSON.parse(source);
  return JSON.parse(await readFile(path.resolve(source), "utf8"));
}

// A folder typed on the command line as an absolute path, which is all kino accepts: ~ is
// your home folder, and a relative folder is read from the folder you ran kino in.
function absoluteFolder(folder) {
  return path.resolve(String(folder).replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
}

// Takes out the options every verb understands (--json, --you, --project <id>), wherever they
// are: `kino --project demo status` and `kino status --project demo` mean the same thing.
// What is left is the command and its words, in order.
function splitOptions(argv) {
  const options = { json: false, you: false };
  const words = [];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === "--json") options.json = true;
    else if (word === "--you") options.you = true;
    else if (word === "--project" || word.startsWith("--project=")) {
      const id = word === "--project" ? argv[++index] : word.slice(10);
      if (!id || id.startsWith("--")) throw new Error("--project needs a project id: kino --project <id> <verb> ...");
      options.project = id;
    } else words.push(word);
  }
  return { options, words };
}

/** A mistake in how the command was typed. kino prints it and exits 2, without asking the server. */
export class UsageError extends Error {}

// A word that looks like an option: --time, --time=3, -t. A lone "-" (stdin for edit), a number
// such as -5 and text with spaces ("Use -5 px") are not options.
const OPTION_WORD = /^--?[a-z][a-z0-9_-]*(=.*)?$/i;

// Quotes a word for the shell when it needs it, so the suggested command can be pasted.
function shellWord(word) {
  return /^[\w.,:/@%+=~-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

// Option names people type for kino's time field `t`.
const TIME_WORDS = new Set(["time", "at", "seconds", "sec", "secs"]);
// How each notes action is typed, for an action given as --resolve.
const NOTE_ACTIONS = { list: "list", set_plan: "set_plan <step> <step>", add: "add <text>", reply: "reply <id> <text>", resolve: "resolve <id> [text]", brief: "brief [fields={…}] [log=[…]] [no_playback=…]",
  checkpoint: "checkpoint id=<board|rough|color|sound> [all=true] [words=…]", answer: "answer id=C1 rev=4 words=… read_as=approve" };
// Options every verb understands, which take no value (--project takes one).
const VALUELESS = new Set(["json", "you"]);

// The field an unknown option means, from the verb's own fields, or null when none is close:
// the same name (--dry-run is dry_run, --motion-blur is motionBlur), --time for t, a field of 2
// or more letters it starts with (--layers is layer), the one field it is the start of (--dry
// is dry_run), or a field one letter off (two for long names). An unrelated flag such as
// --limit gets no field, so kino does not suggest a command that fails.
// Also says whether the field is true or false, so `--dry-run ops.json` keeps ops.json as the ops.
async function fieldFor(verb, name) {
  const { AGENT_TOOLS } = await import("../backend/agent/tools.mjs");
  const input = AGENT_TOOLS.find((tool) => tool.name === verb)?.input ?? {};
  const fields = Object.keys(input).filter((field) => field !== "project");
  const plain = (word) => word.toLowerCase().replace(/[-_]/g, "");
  const wanted = plain(name);
  const startsWith = fields.filter((field) => field.length >= 2 && wanted.startsWith(plain(field))).sort((a, b) => b.length - a.length);
  const startOf = wanted.length >= 3 ? fields.filter((field) => plain(field).startsWith(wanted)) : [];
  const field = fields.find((each) => plain(each) === wanted)
    ?? (TIME_WORDS.has(wanted) && fields.includes("t") ? "t" : undefined)
    ?? startsWith[0]
    ?? (startOf.length === 1 ? startOf[0] : undefined)
    ?? (await import("../backend/agent/refs.mjs")).nearMiss(name.replace(/-/g, "_"), fields);
  if (!field) return { field: null, fields };
  const schema = input[field];
  const inner = typeof schema?.unwrap === "function" ? schema.unwrap() : schema;
  // A field that is a list or one word (check's rules: true or a list of codes) splits a typed
  // word at its commas: rules=contrast,overlap is ["contrast","overlap"].
  const orList = inner?.def?.type === "union" && inner.def.options.some((option) => option?.def?.type === "array");
  return { field, yesNo: inner?.def?.type === "boolean", list: inner?.def?.type === "array", orList, fields };
}

const isFieldWord = (word) => /^[a-z_]+=/i.test(word);

// Whether `name` is exactly one of the verb's list fields (fields, targets, …).
async function isListField(verb, name) {
  const found = await fieldFor(verb, name);
  return found.field === name && found.list;
}
const looksLikeOption = (word) => OPTION_WORD.test(word) || word === "--";

// Whether every name in a word (`width,` or `,size.width`) is a field inspect knows.
async function inspectFieldsOnly(word) {
  const { isInspectField } = await import("../backend/agent/inspect.mjs");
  return word.split(",").map((name) => name.trim()).filter(Boolean).every(isInspectField);
}

// A list value goes on past a comma: the shell splits `fields=name, width` and `--fields name ,
// width` into several words, and the rest were read as names (width became a layer to inspect).
// Which word after a comma goes on depends on the list, so an agent can tell where it ends:
//   fields (inspect)  a word whose names are all fields inspect knows (width, color, size.width);
//                     another word ends the list, so `fields=x, tagline` asks for tagline's x
//   ops (edit)        any word: a JSON list that ends with a comma is not closed yet
//   steps (notes)     any word: a step is text
// A layer may be named like a field (shadow, text, label, size), and text is a type selector, so
// `fields=x, shadow` asks for shadow's x when no other word names what to inspect:
// `targetBesides(last)` says whether a word outside the list (up to position `last`) does.
// Gives the joined value, the position of the last word it took from `words`, and each word read
// after a comma with whether it went on (`joined`), for the note an error prints.
async function joinedList(name, words, index, value, targetBesides) {
  const guesses = [];
  const before = [];
  for (let next = words[index + 1]; next !== undefined && !looksLikeOption(next) && !isFieldWord(next)
    && (value.trim().endsWith(",") || next.trim().startsWith(",")); next = words[index + 1]) {
    if (name === "fields" && !(await inspectFieldsOnly(next))) {
      guesses.push({ word: next, list: name, joined: false });
      // The comma before tagline does not belong to the list.
      value = value.replace(/\s*,[\s,]*$/, "");
      break;
    }
    before.push([value, index]);
    index += 1;
    value += next;
    // A lone comma is no guess.
    if (next.replace(/,/g, "").trim()) guesses.push({ word: next, list: name, joined: true });
  }
  // The list stops before its last word when that word is one name and nothing else is a target.
  const last = words[index];
  if (name === "fields" && targetBesides && before.length && /^[^,\s]+$/.test(last) && !targetBesides(index)) {
    [value, index] = before.at(-1);
    value = value.replace(/\s*,[\s,]*$/, "");
    guesses.pop();
    guesses.push({ word: last, list: name, joined: false, target: true });
  }
  return [value, index, guesses];
}

// Whether a word names what inspect looks at: a name or selector, or targets=… (layer= and layers= too)
const isTargetWord = (word) => /^(targets|layers?)=/.test(word) || (/^\s*\{/.test(word) ? /"targets"/.test(word) : !isFieldWord(word) && !looksLikeOption(word));

// What kino took each word after a comma as, printed when the answer is an error, so a word read
// the wrong way is plain (`fields=x, widht`: widht is no field, so it was read as a layer).
async function guessNote(guesses) {
  const { nearMiss } = await import("../backend/agent/refs.mjs");
  const { inspectFieldNames, isInspectField } = await import("../backend/agent/inspect.mjs");
  const names = (word) => word.split(",").map((name) => name.trim()).filter(Boolean);
  const parts = guesses.map(({ word, list, joined, target }) => {
    if (target) return `"${word}" as the layer, animation or scene to inspect, not as one of ${list}, since no other word names one`;
    if (joined) return `"${word}" as more of ${list}${list === "fields" ? " (inspect has that field)" : ""}`;
    const unknown = names(word).filter((name) => !isInspectField(name));
    const near = unknown.map((name) => nearMiss(name, inspectFieldNames())).filter(Boolean);
    return `"${word}" as a layer, animation or scene to inspect, not as one of ${list}: inspect has no field ${unknown.join(", ")}${near.length ? ` (${near.join(", ")} ${near.length > 1 ? "are fields" : "is one"})` : ""}`;
  });
  const fields = guesses.some(({ list }) => list === "fields") ? " Write fields as one word, fields=x,width, so nothing is guessed." : "";
  return `kino took ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.${fields}`;
}

// The words after the verb that could be options, as [position in argv, word]. A note's text
// is kept as typed: it starts after the action (and the note's id for reply and resolve), at the
// first word that is not an option there. `kino notes add --layer logo Make it big` is refused,
// but in `kino notes add Make the text -bold` and `kino notes reply N1 -really good` the dash
// words are text; a word with one dash there is an option only when it is a field's name (-t).
// After the text has started, a word with two dashes is still an option when it names one of
// the note's fields or actions (--layer, --time, --resolve), so `kino notes add "Make it big"
// --layer logo` is refused instead of saving "--layer logo" as text; --big stays text.
async function optionPlaces(argv, verb) {
  const words = [];
  let seenVerb = false;
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at];
    if (word === "--project") { at += 1; continue; }
    if (word === "--json" || word === "--you" || word.startsWith("--project=")) continue;
    if (!seenVerb) { seenVerb = true; continue; }
    words.push([at, word]);
  }
  if (verb !== "notes") return words;
  const { AGENT_TOOLS } = await import("../backend/agent/tools.mjs");
  const fields = Object.keys(AGENT_TOOLS.find((tool) => tool.name === "notes")?.input ?? {});
  const given = (key) => words.some(([, word]) => word.startsWith(`${key}=`));
  const action = words.find(([, word]) => word.startsWith("action="))?.[1].slice(7)
    ?? words.find(([, word]) => !looksLikeOption(word) && !isFieldWord(word))?.[1];
  const lead = (given("action") ? 0 : 1) + (["reply", "resolve"].includes(action) && !given("id") ? 1 : 0);
  const actions = AGENT_TOOLS.find((tool) => tool.name === "notes")?.input?.action?.unwrap?.().options ?? [];
  const notesWord = (word) => {
    if (!word.startsWith("--") || !looksLikeOption(word)) return false;
    const name = word.slice(2).split("=")[0].toLowerCase().replace(/-/g, "_");
    return fields.includes(name) || actions.includes(name) || TIME_WORDS.has(name);
  };
  const places = [];
  let plainWords = 0;
  let inText = false;
  for (const entry of words) {
    const [, word] = entry;
    if (inText) {
      if (notesWord(word)) places.push(entry);
      continue;
    }
    const option = word.startsWith("--") ? looksLikeOption(word) : OPTION_WORD.test(word) && fields.includes(word.slice(1).split("=")[0]);
    if (!option && !isFieldWord(word)) {
      if (plainWords >= lead) { inText = true; continue; }
      plainWords += 1;
    }
    places.push(entry);
  }
  return places;
}

// kino takes fields as key=value, never as --flags. An unknown option is refused with the
// command written the right way, instead of being read as a name: `kino look frame --time 3`
// would otherwise look for a scene called "--time". When an option is not close to any of the
// verb's fields, the refusal lists them instead of guessing.
async function refuseUnknownOptions(argv, verb) {
  const flags = (await optionPlaces(argv, verb)).filter(([, word]) => looksLikeOption(word));
  if (!flags.length) return;
  const [[, first]] = flags;
  if (["--help", "-h"].includes(first)) throw new UsageError(`Unknown option "${first}". For help: kino help`);
  // `kino notes reply N1 Thanks --resolve`: an action is the word after notes, not an option.
  const action = verb === "notes" ? flags.map(([, word]) => word.replace(/^--?/, "").split("=")[0].toLowerCase()).find((name) => Object.hasOwn(NOTE_ACTIONS, name)) : undefined;
  if (action) throw new UsageError(`Unknown option "--${action}". ${action} is a notes action, the word after notes: kino notes ${NOTE_ACTIONS[action]} (kino help)`);
  const at = new Set(flags.map(([index]) => index));
  const typed = [];
  const names = [];
  let unmatched = false;
  let fields = [];
  // A list field given more than once is one list: `--fields name --fields width` is
  // fields='["name","width"]', written where the first one was, and so is a flag after a
  // fields=… word that is already there (`fields='["name"]' --fields width`).
  const lists = new Map();
  // inspect's targets: a word outside the list that is not the verb, kino's own options, an
  // option or an option's value (`fields=x, shadow` alone asks for shadow's x).
  const own = kinoOwnWords(argv);
  const targetAt = (place) => !own.has(place) && isTargetWord(argv[place])
    && !(place > 0 && !own.has(place - 1) && looksLikeOption(argv[place - 1]) && !argv[place - 1].includes("="));
  const besides = (start) => (verb === "inspect" ? (last) => argv.some((_, place) => (place < start || place > last) && targetAt(place)) : undefined);
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (!at.has(index)) {
      const [name, typedValue] = isFieldWord(word) ? word.split(/=(.*)/s) : [];
      if (name !== undefined && await isListField(verb, name)) {
        const [value, last] = await joinedList(name, argv, index, typedValue, besides(index));
        index = last;
        const items = listItems(value);
        if (lists.has(name)) {
          const list = lists.get(name);
          list.items.push(...items.filter((item) => !list.items.includes(item)));
          typed[list.at] = `${name}=${JSON.stringify(list.items)}`;
          continue;
        }
        lists.set(name, { at: typed.length, items: [...items] });
        typed.push(value === typedValue ? word : `${name}=${JSON.stringify(items)}`);
        continue;
      }
      typed.push(word);
      continue;
    }
    if (word === "--") { names.push('"--" (not needed)'); continue; }
    const [name, inline] = word.replace(/^--?/, "").split(/=(.*)/s);
    if (VALUELESS.has(name.toLowerCase()) && word.startsWith("--")) {
      names.push(`"${word}" (--${name.toLowerCase()} takes no value)`);
      typed.push(`--${name.toLowerCase()}`);
      continue;
    }
    names.push(`"${word.split("=")[0]}"`);
    const found = await fieldFor(verb, name);
    fields = found.fields;
    if (!found.field) { unmatched = true; typed.push(word); continue; }
    // The value is what follows "=", else the next word (for a true/false field only true or
    // false), else true.
    const next = argv[index + 1];
    const takesNext = inline === undefined && next !== undefined && !looksLikeOption(next) && !isFieldWord(next)
      && (!found.yesNo || ["true", "false"].includes(next));
    // A field that is not true or false and was given no value: the command shows where it goes.
    let value = inline ?? (takesNext ? next : found.yesNo ? "true" : null);
    const flagAt = index;
    if (takesNext) index += 1;
    // A list field takes a JSON list: --fields name is fields='["name"]', and --fields name,width
    // is fields='["name","width"]' (one item per comma, as a list field reads "a,b"). A value
    // that ends with a comma, or a next word that starts with one, goes on as joinedList says:
    // --fields name, width and --fields name , width are both; --fields x, tagline is x.
    if (found.list && value !== null) [value, index] = await joinedList(found.field, argv, index, value, besides(flagAt));
    const items = value !== null && found.list ? listItems(value) : null;
    if (items && lists.has(found.field)) {
      const list = lists.get(found.field);
      list.items.push(...items.filter((item) => !list.items.includes(item)));
      typed[list.at] = `${found.field}=${JSON.stringify(list.items)}`;
    } else if (items) {
      lists.set(found.field, { at: typed.length, items: [...items] });
      typed.push(`${found.field}=${JSON.stringify(items)}`);
    } else typed.push(value === null ? { placeholder: `${found.field}=<value>` } : `${found.field}=${value}`);
  }
  const what = `Unknown option${names.length > 1 ? "s" : ""} ${names.join(", ")}.`;
  const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
  if (unmatched) throw new UsageError(`${what} kino takes fields as key=value, and the fields of ${verb} are ${list(fields.filter((field) => field !== "why" && field !== "next"))}. (kino help)`);
  const command = typed.map((word) => (typeof word === "string" ? shellWord(word) : word.placeholder)).join(" ");
  throw new UsageError(`${what} kino takes fields as key=value: kino ${command} (kino help)`);
}

// The positions in argv of the verb and of kino's own options (--json, --you, --project <id>).
function kinoOwnWords(argv) {
  const own = new Set();
  let verbSeen = false;
  for (let place = 0; place < argv.length; place += 1) {
    const word = argv[place];
    if (word === "--json" || word === "--you" || word.startsWith("--project=")) own.add(place);
    else if (word === "--project") { own.add(place); own.add(place + 1); place += 1; }
    else if (!verbSeen) { verbSeen = true; own.add(place); }
  }
  return own;
}

// The items of a list option's value: a JSON list as written, else one item per comma.
function listItems(value) {
  if (/^\s*\[/.test(value)) {
    try {
      const items = JSON.parse(value);
      if (Array.isArray(items)) return items;
    } catch {}
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

// A plan's steps from the words the shell made. Each word is a step ("Draft the scene" quoted),
// unless commas separate them unquoted (Draft the logo, Polish timing, or a,b): then the words
// are one text, split at its commas. A comma inside a quoted step ("Build, then check") is kept.
function planSteps(words) {
  const texts = words.map(String);
  const unquotedComma = texts.some((word) => /^,|,$/.test(word.trim()) || (word.includes(",") && !/\s/.test(word.trim())));
  return unquotedComma ? texts.join(" ").split(",").map((step) => step.trim()).filter(Boolean) : texts;
}

/** Turns command-line words into { verb, input, options }. Exported for tests. */
export async function parseCommand(argv) {
  const { options, words } = splitOptions(argv);
  const [verb, ...rest] = words;
  await refuseUnknownOptions(argv, verb);
  const input = {};
  if (options.project) input.project = options.project;
  const free = [];
  const given = new Set();
  const guesses = [];
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at];
    const equals = word.indexOf("=");
    if (/^\s*\{/.test(word) && verb !== "edit") Object.assign(input, JSON.parse(word));
    else if (equals > 0 && /^[a-z_]+$/i.test(word.slice(0, equals))) {
      // inspect layer=walk-3 (or layers=) means targets.
      const name = (FIELD_ALIASES[verb] ?? {})[word.slice(0, equals)] ?? word.slice(0, equals);
      let typed = word.slice(equals + 1);
      // fields=name, width is one list (width was a target before); fields=x, tagline is not.
      if (await isListField(verb, name)) {
        let read;
        const start = at;
        const besides = verb === "inspect" ? (last) => rest.some((each, place) => (place < start || place > last) && isTargetWord(each)) : undefined;
        [typed, at, read] = await joinedList(name, rest, at, typed, besides);
        guesses.push(...read);
      }
      let value = parseValue(typed);
      if (typeof value === "string") {
        const found = await fieldFor(verb, name);
        if (found.field === name && found.orList) value = listItems(value);
      }
      // A list field given twice is one list (`fields=name fields=width` reads both): before,
      // the last word replaced the first.
      if (given.has(name) && await isListField(verb, name)) {
        const items = (each) => (Array.isArray(each) ? each : listItems(String(each)));
        const merged = items(input[name]);
        input[name] = [...merged, ...items(value).filter((item) => !merged.includes(item))];
      } else input[name] = value;
      given.add(name);
    } else free.push(word);
  }
  if (verb === "edit") {
    if (free.length) {
      const ops = await readOps(free[0]);
      Object.assign(input, Array.isArray(ops) ? { ops } : ops);
    }
  } else if (verb === "inspect") {
    // Names after targets= (or layer=, layers=) join them: `layers=walk-3, walk-4` is two words
    // to the shell, and `kino inspect walk-3 layer=walk-4` names both. A comma inside a
    // selector's [...] does not split it.
    if (free.length) {
      const typed = [input.targets ?? []].flat().flatMap((each) => (typeof each === "string" ? each.split(/,(?![^[]*\])/) : [each]));
      input.targets = [...typed, ...free].map((each) => (typeof each === "string" ? each.trim() : each)).filter((each) => each !== "");
    }
  } else if (verb === "notes" && ["reply", "resolve"].includes(input.action ?? free[0])) {
    input.action ??= free.shift();
    if (free.length) input.id ??= free.shift();
    if (free.length) input.text ??= free.join(" ");
  } else if (verb === "notes" && (input.action ?? free[0]) === "set_plan") {
    input.action ??= free.shift();
    // Words after steps= are more of it (steps=Draft the logo, Polish kept only "Draft").
    if (free.length) input.steps = planSteps([...(input.steps === undefined ? [] : [input.steps].flat()), ...free]);
  } else if (verb === "project" && (input.action ?? free[0]) === "record") {
    // kino project record start target='{"app":"Notes"}' maxSeconds=60 · kino project record
    // mark Open the menu · kino project record stop: the step is the word after record, and
    // every other key=value is one of its options.
    input.action ??= free.shift();
    const recordOptions = { ...(input.options ?? {}) };
    for (const key of Object.keys(input)) if (!["action", "options", "project"].includes(key)) { recordOptions[key] = input[key]; delete input[key]; }
    if (free.length) recordOptions.step ??= free.shift();
    if (free.length && recordOptions.step === "mark") recordOptions.label ??= free.join(" ");
    input.options = recordOptions;
  } else if (verb === "project" && (input.action ?? free[0]) === "import") {
    input.action ??= free.shift();
    // The file: path=, source= or file=, or the word after import.
    for (const alias of ["path", "source"]) {
      if (input.file === undefined && input[alias] !== undefined) input.file = String(input[alias]);
      delete input[alias];
    }
    if (input.file === undefined && free.length) input.file = free.shift();
    // A file path is read from the folder kino runs in, and ~ is your home folder (zsh leaves the
    // ~ in path=~/song.wav as typed); ids kino resolves itself (openverse:, archive:, yt:, sfx:,
    // music:, clip: and footage codes F1 or F1.15) stay as typed.
    if (typeof input.file === "string" && !KINO_IMPORT.test(input.file.trim())) input.file = absoluteFolder(input.file);
  } else {
    // Words in these places are names and text, kept as typed ("1.50" stays a string). A note's
    // text may be several words: `kino notes add Make the logo bigger`.
    // A place already given as key=value is skipped, so `kino notes action=add Make it big`
    // keeps all three words of the text.
    const names = (POSITIONAL[verb] ?? []).filter((name) => input[name] === undefined);
    names.forEach((name, index) => {
      const word = verb === "notes" && name === "text" ? free.slice(index).join(" ") || undefined : free[index];
      if (word !== undefined) input[name] = word;
    });
    if (verb === "history" && /^\d+$/.test(String(input.turn ?? "")) && input.action === "restore") { input.rev = Number(input.turn); delete input.turn; }
    // Output folders: render out and project manage exports out.
    if (verb === "render" && input.out) input.out = absoluteFolder(input.out);
    if (verb === "project" && input.options?.resource === "exports" && input.options.out)
      input.options = { ...input.options, out: absoluteFolder(input.options.out) };
  }
  return { verb, input, options, ...(guesses.length ? { guesses } : {}) };
}

// The live view's session for this command (x-kino-session): each `kino` command is a new
// process, so it names the agent program that runs it, the same session that agent's MCP server
// sends (agent-session.mjs); "cli" when `ps` cannot tell (Windows).
const cliSession = () => agentSession({ fallback: "cli" });

async function runVerb(argv) {
  const { verb, input, options, guesses } = await parseCommand(argv);
  // One session per agent, so its calls keep one name and color in the dashboard's live view.
  const client = createAgentClient(await resolveConnection(), { name: "cli", session: cliSession() });
  // Images stay on disk; the reply prints their paths.
  if (verb === "look") input.inline = false;
  let reply;
  if (verb === "project" && input.action === "import") {
    if (!input.file) throw new Error("kino project import needs a file path.");
    { const media = await client.importFile(input.file, { input }); reply = media.refused ?? media.reply ?? { text: importedText(media) }; }
  } else {
    reply = await client.call(verb, input, { by: options.you ? "you" : undefined });
  }
  if (options.json) {
    const images = (reply.images ?? []).map(({ data, ...image }) => image);
    console.log(JSON.stringify({ ...reply, ...(images.length ? { images } : {}) }, null, 2));
  } else console.log(reply.text);
  if (reply.isError && guesses) console.error(await guessNote(guesses));
  const code = exitCodeFor(verb, input, reply);
  if (code) process.exitCode = code;
}

/** The exit code for a service answer: 1 when nothing the command asked for came of it. Exported for tests. */
export function exitCodeFor(verb, input, reply) {
  if (reply.isError) return 1;
  // A render that failed is a normal answer to the service, but a script waiting for the file
  // must not carry on: `kino render wait` (and start wait=true, and status) exit 1 when it failed.
  // A canceled one too (it exited 0), except the answer to `kino render cancel` itself.
  const status = reply.data?.status;
  if (verb === "render" && (status === "failed" || (status === "canceled" && input?.action !== "cancel"))) return 1;
  // So is a write refused during a hold ({held}) or while a stop waits for the person ({waiting,
  // next}): nothing changed. status also names a waiting stop, but refused nothing.
  if (reply.data?.held || (reply.data?.waiting && reply.data.next)) return 1;
  return 0;
}

export async function main(argv) {
  // The command is the first word that is not an option, so options may come before it.
  const { words } = splitOptions(argv);
  const [command] = words;
  if (!command || ["help", "--help", "-h"].includes(command)) return console.log(HELP);
  if (command === "--version" || command === "version") {
    const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    return console.log(version);
  }
  if (command === "mcp") {
    const { startKinoMcp } = await import("../backend/mcp.mjs");
    await startKinoMcp();
    return;
  }
  if (command === "setup") {
    const { runSetup } = await import("./setup.mjs");
    return runSetup(words.slice(1));
  }
  if (command === "watch") {
    const { pendingNotes, watchNotes, batchLine } = await import("../backend/agent/watch.mjs");
    const { options } = splitOptions(argv);
    const settle = Number(words.find((word) => word.startsWith("settle="))?.slice(7) ?? 8);
    const client = createAgentClient(await resolveConnection(), { name: "cli", session: cliSession() });
    if (words[1] === "pending") {
      const { projectId, notes } = await pendingNotes(client, options.project);
      if (notes.length) { console.error(batchLine(projectId, notes)); process.exitCode = 2; }
      return;
    }
    return watchNotes(client, { project: options.project, settleMs: Math.max(0, settle) * 1000 });
  }
  if (command.startsWith("-")) {
    console.error(`Unknown option "${command}". Options: --json, --you, --project <id>, before or after the verb. (kino help)`);
    process.exitCode = 2;
    return;
  }
  if (!VERBS.includes(command)) {
    const { closest } = await import("../backend/agent/refs.mjs");
    console.error(`Unknown command "${command}". Did you mean ${closest(command, [...VERBS, "mcp", "setup", "watch", "help"]).join(", ")}? (kino help)`);
    process.exitCode = 2;
    return;
  }
  try {
    await runVerb(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    process.exitCode = 2;
  }
}

// Also true when started through a symlink (npm link puts one on your PATH).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (startedDirectly()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
