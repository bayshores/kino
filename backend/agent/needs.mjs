// What the material cannot give the video (notes {action:"needs"}). A need is a question to the
// person with ready answers, like a plan: the agent looked through the material for a substitute
// first, then asks "do you have ...?" and offers 1 to 3 things it can do without it, one
// recommended. The person answers (on the dashboard, or the agent records their words with
// by:"you" and quote): "have" (they send it: waiting until sent), "option N" (the agent does it:
// planned until made) or "drop" (do without). "your call" from the person takes the recommended
// option. "other" (with plan: what you will make) is something else they asked for, such as
// "mute only that word"; it works like a picked option. The agent alone never answers, so it cannot lower the bar or choose for them.
// items:[] records "the material is enough". A final render waits while a need is unfinished
// (needs_open) and, on a 15 s+ video with footage or speech, until needs were checked
// (needs_unchecked); waive_check {code:"needs"} skips both. Saved in the agent state as
// state.needs = { checked: {rev, at, enough} | null, items: [...], next }.
import { viewerWho } from "./subject-edit.mjs";

export const NEEDS_WAIVER = "needs";
export const NEEDS_OPEN_LIMIT = 8;
export const NEED_FROM = ["you", "agent", "music"];
export const NEED_LIMITS = { what: [8, 120], why: [8, 160], ask: [8, 160], do: [8, 160], cost: [4, 100], quote: 300 };
// The cost of found footage (library {topic:"footage"}), said the same way everywhere.
export const FOUND_COST = "found clips, not your own shots: quality and framing vary";
// A slot left inside an option, such as search:"<visual words>": the draft's words to replace.
const INNER_SLOT = /<[a-z][^<>]*>/i;
// open: not answered; waiting: the person has it and will send it; planned: an option to make.
const UNFINISHED = ["open", "waiting", "planned"];

export const emptyNeeds = () => ({ checked: null, items: [], next: 1 });
export const openNeeds = (needs) => (needs?.items ?? []).filter((item) => UNFINISHED.includes(item.status));

function words(value, name, [least, most]) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (text.length < least || text.length > most) throw new Error(`${name} is ${least} to ${most} characters${text ? ` (it has ${text.length})` : ""}.`);
  return text;
}

/** The items of a needs call, checked: [{what, why, ask, options:[{do, cost, recommended?}], from?}]. */
export function parseNeedItems(items) {
  if (!Array.isArray(items)) throw new Error('items lists what is missing: [{what, why, ask:"Do you have ...?", options:[{do, cost, recommended:true}]}], or [] when the material is enough.');
  return items.map((item, index) => {
    const at = `items[${index}]`;
    const ask = words(item?.ask, `${at}.ask`, NEED_LIMITS.ask);
    if (/^(get|shoot|film|record|take|find|send|go)\b/i.test(ask)) throw new Error(`${at}.ask is a question the person can say no to ("Do you have ...?"), not an order: they may not be able to get it.`);
    const options = Array.isArray(item?.options) ? item.options : [];
    if (options.length < 1 || options.length > 3) throw new Error(`${at}.options lists 1 to 3 things you can do without it, from the material there is or what you can make: [{do, cost, recommended:true}].`);
    const slot = options.map((option) => INNER_SLOT.exec(String(option?.do ?? ""))?.[0]).findIndex(Boolean);
    if (slot >= 0) throw new Error(`${at}.options[${slot}].do still has ${INNER_SLOT.exec(options[slot].do)[0]}: put your own words there, or leave that option out.`);
    const parsed = options.map((option, number) => ({
      do: words(option?.do, `${at}.options[${number}].do`, NEED_LIMITS.do),
      cost: words(option?.cost, `${at}.options[${number}].cost`, NEED_LIMITS.cost),
      ...(option?.recommended === true ? { recommended: true } : {}),
    }));
    if (parsed.filter((option) => option.recommended).length !== 1) throw new Error(`${at}.options marks exactly one recommended:true: the one you would pick.`);
    const from = item?.from == null ? null : String(item.from);
    if (from && !NEED_FROM.includes(from)) throw new Error(`${at}.from is "you", "agent" or "music" (optional).`);
    // file: the clip this need is about, if the project may already have it (its name, src or source address).
    const file = item?.file == null ? null : words(item.file, `${at}.file`, [1, 300]);
    return { what: words(item?.what, `${at}.what`, NEED_LIMITS.what), why: words(item?.why, `${at}.why`, NEED_LIMITS.why), ask, options: parsed, ...(from ? { from } : {}), ...(file ? { file } : {}) };
  });
}

// A name, src or address to compare: lowercase, no scheme or "www.", no "/api/media/" folder.
const sameKey = (value) => String(value ?? "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/^\/api\/media\//, "");

/**
 * The library item a need's `file` names, as {src, name, how}, or null. `media` is the library
 * list. Matched by src or id, by the address it was fetched from (credit.page, credit.id), or by
 * its name; `how` says which. The library keeps no content hash, so a renamed copy of the same
 * bytes is not matched.
 */
export function importedAs(media, file) {
  const want = sameKey(file);
  if (!want) return null;
  const tests = [["src", (item) => item.src ?? (item.id ? `/api/media/${item.id}` : null)], ["id", (item) => item.id], ["source address", (item) => item.credit?.page], ["source id", (item) => item.credit?.id], ["name", (item) => item.name]];
  for (const [how, read] of tests) {
    const found = (media ?? []).find((item) => typeof read(item) === "string" && sameKey(read(item)) === want);
    if (found) return { src: found.src ?? `/api/media/${found.id}`, name: found.name ?? found.id, how };
  }
  return null;
}

/** Splits parsed need items into those still to ask and those the library already holds. */
export function splitImported(items, media) {
  const ask = [];
  const have = [];
  for (const item of items) {
    const { file, ...need } = item;
    const found = file ? importedAs(media, file) : null;
    if (found) have.push({ what: need.what, ...found });
    else ask.push(need);
  }
  return { ask, have };
}

/**
 * Adds the needs (or records "enough" for items:[]) to `needs` in place; returns the new items.
 * `rev` and `at` say when the material was checked.
 */
export function addNeeds(needs, items, { rev, at }) {
  const open = openNeeds(needs);
  if (!items.length && open.length) throw new Error(`${open.map((item) => item.id).join(", ")} not finished: the material is not enough until each is answered and done.`);
  if (open.length + items.length > NEEDS_OPEN_LIMIT) throw new Error(`At most ${NEEDS_OPEN_LIMIT} needs open at once (${open.length} open): ask about the ones that matter most.`);
  const added = items.map((item) => ({ id: `M${needs.next++}`, ...item, status: "open", rev, at }));
  needs.items.push(...added);
  needs.checked = { rev, at, enough: !items.length };
  return added;
}

const findNeed = (needs, id) => {
  const need = (needs?.items ?? []).find((item) => item.id.toLowerCase() === String(id ?? "").trim().toLowerCase());
  if (!need) throw Object.assign(new Error(`No need ${id}.`), { code: "not_found" });
  return need;
};

/** "have", "drop", "other", "your call", 2 or "option 2" → {kind, option?}; throws for anything else. */
export function readAnswer(answer, need) {
  const text = String(answer ?? "").trim().toLowerCase();
  if (["have", "i have it", "sent"].includes(text)) return { kind: "have" };
  if (["drop", "do without", "dropped"].includes(text)) return { kind: "drop" };
  if (text === "other") return { kind: "other" };
  if (["your call", "you pick", "recommended"].includes(text)) return { kind: "option", option: need.options.findIndex((option) => option.recommended) + 1, yourCall: true };
  const number = Number(/^(?:option\s*)?(\d)$/.exec(text)?.[1]);
  if (number >= 1 && number <= need.options.length) return { kind: "option", option: number };
  throw new Error(`answer is "have", "option 1"${need.options.length > 1 ? ` to "option ${need.options.length}"` : ""}, "drop", "your call", or "other" with plan (what you will make of their own idea).`);
}

/**
 * The person's answer to a need, in place: `you` when they made the call on the dashboard; from
 * the agent it needs by:"you" and quote (their words). Returns the need.
 */
export function answerNeed(needs, { id, answer, you = false, by, quote, plan, at }) {
  const need = findNeed(needs, id);
  if (!UNFINISHED.includes(need.status)) throw new Error(`${need.id} is already ${need.status}.`);
  const said = typeof quote === "string" ? quote.trim() : "";
  if (!you && (by !== "you" || !said)) throw new Error(`Only the person answers ${need.id}: ask them "${need.ask}" with its options, then save their answer with by:"you" and quote (their words). "your call" from them takes your recommended option.`);
  const picked = readAnswer(answer, need);
  if (picked.kind === "other") picked.plan = words(plan, "plan (with answer \"other\": what you will make of their idea)", NEED_LIMITS.do);
  else if (plan !== undefined) throw new Error('plan goes with answer "other": the person asked for something none of the options does.');
  need.status = picked.kind === "have" ? "waiting" : picked.kind === "drop" ? "dropped" : "planned";
  need.answer = { kind: picked.kind, ...(picked.option ? { option: picked.option } : {}), ...(picked.plan ? { plan: picked.plan } : {}), ...(picked.yourCall ? { yourCall: true } : {}), by: "you", ...(said ? { quote: said.slice(0, NEED_LIMITS.quote) } : {}), at };
  return need;
}

/**
 * Marks a need done, in place: "made" (a planned option, with the layers that do it) or "sent"
 * (what the person gave: media or layers). `layers` are resolved ids, `media` a checked src.
 */
export function finishNeed(needs, { id, status, layers = [], media = null, at }) {
  const need = findNeed(needs, id);
  if (status === "made") {
    if (need.status !== "planned") throw new Error(`${need.id} is ${need.status}: made is for an option or other plan the person picked (answer first).`);
    if (!layers.length) throw new Error(`made needs layers: the layers that do ${pickedText(need)} (names or codes).`);
    Object.assign(need, { status, layers, doneAt: at });
  } else if (status === "sent") {
    if (!["open", "waiting"].includes(need.status)) throw new Error(`${need.id} is ${need.status}: sent is for what the person gave.`);
    if (!layers.length && !media) throw new Error("sent needs media (the imported src, /api/media/...) or layers that use what the person gave.");
    Object.assign(need, { status, ...(layers.length ? { layers } : {}), ...(media ? { media } : {}), doneAt: at });
  } else throw new Error('status is "made" (layers) or "sent" (media or layers); the person\'s choice is answer: "have", "option N", "drop", "your call" or "other" with plan.');
  return need;
}

/** What the person picked to be made: `option 2` or their own idea, `"mute only that word"`. */
export const pickedText = (need) => (need.answer?.plan ? `"${need.answer.plan}"` : `option ${need.answer?.option}`);

/** What is left to do for an unfinished need, in a few words. */
export function needState(need) {
  if (need.status === "waiting") return "waiting for theirs";
  if (need.status === "planned") return `make ${pickedText(need)}`;
  return "unanswered";
}

// The ask a step leads to when nothing better is known: every field a placeholder.
const BLANK_NEED = { what: "<missing piece>", why: "<what the video loses>", ask: "Do you have <it>?",
  options: [{ do: "<what you can do with what exists>", cost: "<what is lost>", recommended: true }] };

/**
 * The needs call the check-material step drafts, from the picked treatment (brief.treatments):
 * the first item asks for footage of the pick's who (a person or a thing), because its tension is
 * what the video loses without it, with what kino can make now and telling it with what exists,
 * each with its cost. What to make now stays a slot only the material fills (the files the agent
 * found), so kino refuses the draft sent unedited (next-call.mjs unfilledSlot) and the agent
 * still looks first. With no pick or a pick from before who, every field is a placeholder.
 * `search` (web search on, the footage finder offered): a third option finds footage of the who
 * (library {topic:"footage"}, then scan and import), with its cost (found clips, not theirs). The person's files
 * still lead: making it from them stays the recommended option, found clips fill the gap.
 * Returns {tool:"notes", input:{action:"needs", items}}.
 */
export function needsCall(treatments, { search = false, subject = false } = {}) {
  const entry = treatments?.picked ? treatments.list?.[treatments.picked.index] : null;
  const who = typeof entry?.who === "string" ? entry.who.trim() : "";
  const tension = typeof entry?.tension === "string" ? entry.tension.trim() : "";
  if (subject && who) return { tool: "notes", input: { action: "needs", items: [subjectNeed(entry, who, tension, search)] } };
  const item = !who ? BLANK_NEED : {
    what: `footage of ${who}`,
    why: tension.length >= NEED_LIMITS.why[0] ? tension : BLANK_NEED.why,
    ask: `Do you have footage of ${who}, even from a phone?`,
    options: [
      { do: "<make it now from the files you found: a screen recording (project record), type, or cut-outs of them>", cost: `${who} is never on camera`, recommended: true },
      ...(search ? [{ do: findDo(who), cost: FOUND_COST }] : []),
      { do: "tell it with what exists, no new footage", cost: `${who} is never on camera; type and the files carry the story` },
    ],
  };
  return { tool: "notes", input: { action: "needs", items: [item] } };
}

// The found-footage option's do: the footage search for the who, with slots for its words.
function findDo(who, moment = "<doing what the tension needs>") {
  const text = (name) => `library {topic:"footage", search:"${name} ${moment}", want:"<visual words>"}, then scan and import`;
  const plain = who.replace(/"/g, "'");
  return text(plain).length <= NEED_LIMITS.do[1] ? text(plain) : text("<who>");
}

/**
 * The drafted need of an edit of a subject in footage (subject-edit.mjs): the person did not film
 * it and the viewer is never on camera, so it asks which clip shows the pick's turn, not for
 * footage "from a phone". Run 8 was drafted "footage of you, the viewer ... even from a phone?"
 * (T222). A who that is the viewer stands for the subject; options make it from the found clips,
 * find another clip (with search on), or tell it with what exists.
 */
function subjectNeed(entry, who, tension, search) {
  const onCamera = viewerWho(who) ? "the subject" : who;
  const turn = typeof entry?.turn === "string" ? entry.turn.trim() : "";
  const cost = turn ? "the turn is told, not shown" : `${onCamera} is never on screen`;
  return {
    what: turn ? `a shot of ${onCamera}: ${turn}` : `footage of ${onCamera}`,
    why: tension.length >= NEED_LIMITS.why[0] ? tension : BLANK_NEED.why,
    ask: turn ? `Which clip shows it: "${turn.replace(/"/g, "'")}"?` : `Which clip shows ${onCamera}?`,
    options: [
      { do: "<make it now from the clips you have: the shot that shows it, a freeze or push in on it, or the line it says>", cost, recommended: true },
      ...(search ? [{ do: findDo(viewerWho(who) ? "<the subject's name>" : who, "<the moment the turn needs>"), cost: FOUND_COST }] : []),
      { do: "tell it with what exists, no new footage", cost: `${cost}; the clips you have carry the story` },
    ],
  };
}

/** The short status line: `needs: M1 "Do you have ..." (3 options) · M2 make option 2`, or "". */
export function needsLine(needs) {
  const open = openNeeds(needs);
  if (!open.length) return "";
  const cut = (text) => (text.length > 36 ? `${text.slice(0, 35)}…` : text);
  const shown = open.slice(0, 3).map((item) => (item.status === "open" ? `${item.id} "${cut(item.ask)}" (${item.options.length} option${item.options.length > 1 ? "s" : ""})` : `${item.id} ${needState(item)}`));
  return `needs: ${shown.join(" · ")}${open.length > 3 ? ` +${open.length - 3}` : ""}`;
}
