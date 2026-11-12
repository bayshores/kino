// One exact next call at the end of every answer: the most likely next step as a complete call
// (a tool and its JSON input), never a menu. A weak agent copies it; a strong one may do
// something else. Words in <angle brackets> are the agent's to fill in (kino cannot know what a
// headline should say); everything else runs as written.
//
// Text answers end with a line `next: look {"mode":"review"}`. JSON answers (edit receipts and
// refusals) end with a "next" key holding the same words; a refusal's older advice in prose
// moves to "hint". The service picks the call (service.mjs nextCallFor); this file only writes
// it and finds the fixed call for a refused input.

/** A call: {tool, input}. */
export const call = (tool, input = {}) => ({ tool, input });

/** `look {"mode":"review"}`: a call as the agent types it. */
export const callText = (next) => `${next.tool} ${JSON.stringify(next.input ?? {})}`;

/** Every answer can always fall back to this: read the project. */
export const STATUS_CALL = call("status");

/**
 * The fields of a JSON answer with the next call as its last key. A `next` already there in
 * prose (an older hint, such as "Nothing was saved. …") moves to `hint`; `inbox` lines (from
 * a refusal) come before it.
 */
export function withNextField(data, next, inbox = []) {
  const { next: prose, ...rest } = data ?? {};
  return {
    ...rest,
    ...(typeof prose === "string" && prose ? { hint: prose } : {}),
    ...(inbox.length ? { inbox } : {}),
    next: callText(next),
  };
}

// Compact JSON as the service writes it: empty lists and objects are left out.
const compact = (value) => JSON.stringify(value, (key, entry) =>
  key && entry && typeof entry === "object" && (Array.isArray(entry) ? !entry.length : !Object.keys(entry).length) ? undefined : entry);

/**
 * An answer's text with its next call written in. `json`: the answer is its data as JSON (a
 * receipt, a refusal), so next is its last key, after the inbox; else the inbox lines and then
 * `next: …` end the text. A refused edit whose next call resends it fixed drops its prose about
 * retry and the example the call already carries: they would say the same thing twice.
 */
export function answerText({ text, data, json }, next, inbox = []) {
  if (json) {
    let fields = data;
    if (fields?.retry && next.tool === "edit" && next.input?.retry === fields.retry) {
      const carried = JSON.stringify(Object.values(next.input.fix ?? {}));
      const { next: prose, example, ...rest } = fields;
      fields = { ...rest, ...(example && !carried.includes(JSON.stringify(example)) ? { example } : {}), next: "Nothing was saved. The next call resends the edit with the fix." };
    }
    return compact(withNextField(fields, next, inbox));
  }
  const lines = inbox.length ? `\ninbox ◆${inbox.length}\n${inbox.map((line) => `  ${line}`).join("\n")}` : "";
  return `${text}${lines}\nnext: ${callText(next)}`;
}

const wordsOf = (text) => String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The origin word the footage still lacks, as {word, query}, or null. state.origin names what
 * the subject is known for; the person's own footage wins, and so does any found video whose
 * title already has the word. The query is the about quote and the word.
 */
export function originFootage({ origin, about, footage, personClips = 0 } = {}) {
  const word = String(origin?.words?.[0]?.word ?? "").toLowerCase();
  const quote = String(about?.quote ?? about?.text ?? "").replace(/\s+/g, " ").trim();
  if (!word || !quote || personClips > 0) return null;
  if ((footage?.candidates ?? []).some((candidate) => wordsOf(candidate.title).includes(word))) return null;
  return { word, query: `${quote} ${word}` };
}

/**
 * The next call that fetches the origin footage, or null to leave the answer's own next call.
 * After a footage search, a footage scan or an inspire search it is the footage search for the
 * origin query; once that search ran (its answer has candidates) it is a scan wanting the word.
 * A scan already wanting the word is left alone (its next call is the import), so this ends.
 */
export function originFootageNext({ found, topic, input = {}, footage, reply } = {}) {
  if (!found) return null;
  const same = (text) => wordsOf(text).join(" ");
  if (topic === "inspire") return input.search && (input.kind ?? "videos") === "videos" ? call("library", { topic: "footage", search: found.query }) : null;
  if (topic !== "footage") return null;
  const search = input.search ?? input.query;
  if (search !== undefined && input.source !== "commons") {
    if (same(search) !== same(found.query)) return call("library", { topic: "footage", search: found.query });
    return reply?.data?.candidates?.length ? call("library", { topic: "footage", scan: "top", want: found.word }) : null;
  }
  if (input.scan !== undefined) {
    return wordsOf(input.want ?? footage?.want).includes(found.word) ? null : call("library", { topic: "footage", search: found.query });
  }
  return null;
}

// The edit distance between two short words (for didYouMean substitution).
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

/**
 * The same input with a misspelled value replaced by the suggestion kino gave (didYouMean): the
 * top-level string field closest to `suggestion` (a mode, an action, a topic, a layer name).
 * Null when no field is near it.
 */
export function withSuggestion(input, suggestion) {
  if (!input || typeof input !== "object" || typeof suggestion !== "string") return null;
  let best = null;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" || value === suggestion || ["why", "next", "project", "client"].includes(key)) continue;
    const apart = distance(value.toLowerCase(), suggestion.toLowerCase());
    const near = apart <= Math.max(2, Math.ceil(Math.max(value.length, suggestion.length) / 2));
    if (near && (!best || apart < best.apart)) best = { key, apart };
  }
  return best ? { ...input, [best.key]: suggestion } : null;
}

/**
 * An op with the name kino could not find replaced by the one it suggests, anywhere in the op
 * (layer, layers[], target, …). Null when the op does not hold `missing`.
 */
export function opWithName(op, missing, suggestion) {
  if (!op || typeof missing !== "string" || typeof suggestion !== "string") return null;
  let found = false;
  const swap = (value) => {
    if (typeof value === "string") {
      if (value === missing) { found = true; return suggestion; }
      // layer.kind selectors such as "title.in": swap the name part.
      if (value.startsWith(`${missing}.`)) { found = true; return `${suggestion}${value.slice(missing.length)}`; }
      return value;
    }
    // A list that already held the suggestion keeps it once: ["box", "widht"] → ["box"].
    if (Array.isArray(value)) return value.map(swap).filter((entry, index, list) => typeof entry !== "string" || list.indexOf(entry) === index);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, swap(entry)]));
    return value;
  };
  const fixed = swap(op);
  return found ? fixed : null;
}

// The input fields that are only about the call itself, never part of what to send again.
const SAID_KEYS = ["why", "next", "client"];

/** `input` without the words the agent says about a call (why, next) and empty fields. */
export function cleanInput(input) {
  if (!input || typeof input !== "object") return {};
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => !SAID_KEYS.includes(key) && value !== undefined));
}

// The fields a call cannot do without, as slots to fill: notes reply with no id was refused with
// next `check {"fix":"auto"}`, which does not send the reply. Keyed by tool, then tool.action or
// tool.topic.
const NEEDED_FIELDS = {
  "notes.reply": { id: "<the note's id, such as N2>", text: "<what you changed>" },
  "notes.resolve": { id: "<the note's id, such as N2>" },
  "notes.keep": { id: "<the note's id, such as N2>", layers: ["<the layer it is about>"] },
  "notes.add": { text: "<the note>" },
  "notes.checkpoint": { id: "<the stop status step: names: board, rough, color, sound or critique>" },
  "notes.answer": { id: "<the stop's id, such as C1>", words: "<their words, whole>", read_as: "<what you take them to mean>" },
  "notes.set_plan": { steps: ["<step 1>", "<step 2>", "<step 3>"] },
  "notes.helper": { text: "<the task, such as: find 3 fast-cut edits like this one>" },
  "library.op": { name: "<the op's name, such as add_layer>" },
  "library.search": { search: "<a word, such as move>" },
  inspect: { targets: ["<a layer's name or code, such as L1>"] },
};

/**
 * A refused call sent again with each field it needs and lacks as a slot to fill, or null when
 * nothing it needs is missing.
 */
export function missingFieldCall(tool, input) {
  const asked = cleanInput(input);
  const needed = NEEDED_FIELDS[`${tool}.${asked.action ?? asked.topic}`] ?? NEEDED_FIELDS[tool];
  if (!needed) return null;
  const missing = Object.entries(needed).filter(([key]) => asked[key] === undefined || asked[key] === "");
  return missing.length ? call(tool, { ...asked, ...Object.fromEntries(missing) }) : null;
}

// A slot kino's next call leaves for the agent: "<your headline>", "<your guess: never>".
const PLACEHOLDER = /^<[a-z][^<>]*[\s:][^<>]*>$/i;

/**
 * The first slot of a next call the agent sent back unfilled, as {path, value}, or null: a
 * value (or a key) such as "<your headline>". kino refuses the call rather than save the words.
 */
export function unfilledSlot(input, path = "") {
  if (typeof input === "string") return PLACEHOLDER.test(input.trim()) ? { path, value: input } : null;
  if (Array.isArray(input)) {
    for (const [index, value] of input.entries()) {
      const found = unfilledSlot(value, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      if (SAID_KEYS.includes(key)) continue;
      const here = path ? `${path}.${key}` : key;
      if (PLACEHOLDER.test(key)) return { path: here, value: key };
      const found = unfilledSlot(value, here);
      if (found) return found;
    }
  }
  return null;
}
