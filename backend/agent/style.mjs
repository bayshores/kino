// Checks a style spec sent as the brief field `style` (notes {action:"brief", fields:{style}}).
// The spec names techniques from the vocabulary (engine/techniques.js); engine/styleSpec.js says what
// the checks do with it. A spec is { wants, avoids, lines, by, quote? }:
//   wants   tags the video should use (the references do)
//   avoids  tags it should not use
//   lines   up to 8 short lines, each { text, ref?, at?, tags? }: what a reference does, the
//           reference (yt:<id>, a file or a link), the second it happens at, and the tags it backs
//   by      "you" (the person asked for it; send quote, their words) or "guessed" (your reading)
//   sources where wants, avoids or moves came from when it is not `by`: {avoids:"copied"} (from
//           another project's brief), {moves:"dealt"} (the deck's cards), "guessed" or "you".
//           Only the person's ("you") avoids block (style_avoided); an approval keeps the rest.
// The direction lock (all optional; a spine and fonts lock it, with by:"you" or waived):
//   spine     the story beats in order: [{role, from, to, uses?:[layer names], purpose}]
//   fonts     one face per text role: {caption:{family, size}, display:{...}, label:{...}}
//   accent    {color, share}: the accent color and the most of the frame it may cover (0 to 1)
//   moves     up to 4 named moves (technique tags) and where each recurs: [{tag, where}]
//   logo      {asset, max}: the one logo layer or file, shown at most max times
//   rejected  text the person turned down (rejected_text gates it on screen)
//   waived    why the agent locks it with no person to approve (by stays "guessed")
// The idea and its signature (once a treatment is picked, the lock needs idea and a signature):
//   idea        one sentence: what only this product can show
//   type        the type direction, up to 60 characters ("<family class>, <size>, <case>, <how it appears>"):
//               the picked treatment's type (kino has no default type); fonts name its faces
//   signatures  1 or 2 designed moments [{beat, what, source, why, at?:[from, to]}]: beat is the
//               index of a spine beat, source the material it uses, why why only this product
//   moments     up to 3 set pieces [{tag, beat, what}]: one-off techniques, exempt from
//               vocabulary_budget and technique_repeat (moves stay the recurring glue)
import { TECHNIQUE_TAGS } from "../../engine/techniques.js";
import { closest } from "./refs.mjs";
import { isRecord } from "../../engine/numbers.js";
import { ONLY } from "./subject-edit.mjs";

export const STYLE_LIMITS = Object.freeze({ tags: 16, lines: 8, text: 120, ref: 120, quote: 200, beats: 16, moves: 4, rejected: 12, idea: 120, signatures: 2, moments: 3, short: 80 });
const SPEC_KEYS = ["wants", "avoids", "lines", "by", "quote", "spine", "fonts", "accent", "moves", "logo", "rejected", "waived", "idea", "type", "signatures", "moments", "sources"];
export const BEAT_ROLES = ["hook", "problem", "turn", "product", "how", "proof", "signature", "breath", "payoff", "end", "coda"];
// The spine kino drafts (brief.mjs orderSteps before the build, lockCall after), around the idea
// and its signature: the problem is the pick's tension, the turn where it flips. With no idea
// the lock asks for one first: there is no template spine.
export const IDEA_SPINE = Object.freeze(["hook", "problem", "turn", "signature", "payoff", "end"]);
// The lists a spec's sources can name, and where each can come from.
export const SOURCE_FIELDS = Object.freeze(["wants", "avoids", "moves"]);
export const SOURCES = Object.freeze(["you", "guessed", "copied", "dealt"]);
// quote: a voice or pull-quote face with its own job (role_font_drift holds quoted lines to it).
const TEXT_ROLES = ["caption", "display", "label", "stat", "quote"];
const LINE_KEYS = ["text", "ref", "at", "tags"];
const hasText = (value) => typeof value === "string" && value.trim() !== "";

/** A refusal: { code, message, details? }. */
const problem = (message, details) => ({ code: "bad_input", message, ...(details ? { details } : {}) });

// The tags nearest a word: the ones that contain it or that it contains first ("glitch" is
// glitch-hit), then by spelling.
function closestTags(word) {
  const lower = String(word).toLowerCase().trim();
  const containing = TECHNIQUE_TAGS.filter((tag) => lower.length >= 3 && (tag.includes(lower) || lower.includes(tag)));
  return [...new Set([...containing, ...closest(lower, TECHNIQUE_TAGS)])].slice(0, 3);
}

// The problems with a list of tags (wants, avoids or a line's tags): one for each tag that is not
// a technique, or none.
function tagsProblems(where, list) {
  if (!Array.isArray(list)) return [problem(`style.${where} is a list of technique tags, such as ["dissolve", "type-words"] (library {topic:"techniques"}).`)];
  if (list.length > STYLE_LIMITS.tags) return [problem(`style.${where} has ${list.length} tags; at most ${STYLE_LIMITS.tags}.`)];
  return list.filter((tag) => !TECHNIQUE_TAGS.includes(tag)).map((tag) => {
    const near = closestTags(tag);
    return problem(`style.${where}: "${tag}" is not a technique; the closest is ${near[0]}. library {topic:"techniques"} lists them.`, { didYouMean: near });
  });
}

/**
 * The problem with a spec, or null. Every problem the spec has comes in one answer: the first
 * one's code and details, and all the messages. `spec` null removes it; the person's spec
 * (by:"you") can only be replaced by another of theirs, like a brief line.
 */
export function styleProblem(spec, current, { subject = false } = {}) {
  if (spec === null) return current?.by === "you" ? { code: "yours", message: `style is the person's ("${current.quote}"). Ask them in the chat, then save their new words with by:"you".` } : null;
  if (!isRecord(spec)) return problem('style is {wants:[tags], avoids:[tags], lines:[{text, ref?, at?, tags?}], by:"you"|"guessed", quote?}, or null to remove it.');
  const found = [];
  const add = (...list) => found.push(...list);
  const extra = Object.keys(spec).filter((key) => !SPEC_KEYS.includes(key));
  if (extra.length) add(problem(`style takes ${SPEC_KEYS.join(", ")}, not ${extra.join(", ")}.`, { didYouMean: closest(extra[0], SPEC_KEYS) }));
  for (const where of ["wants", "avoids"]) if (spec[where] !== undefined) add(...tagsProblems(where, spec[where]));
  const tags = (list) => (Array.isArray(list) ? list : []);
  const both = tags(spec.wants).filter((tag) => tags(spec.avoids).includes(tag));
  if (both.length) add(problem(`style wants and avoids ${both.join(", ")}; keep each tag in one list.`));
  add(...lockProblems(spec, subject));
  if (!(spec.wants?.length || spec.avoids?.length || spec.moves?.length || spec.spine?.length || spec.rejected?.length || spec.idea || spec.signatures?.length || spec.moments?.length)) add(problem("style needs a tag in wants or avoids: the techniques the references use, or the ones to stay away from."));
  if (spec.lines !== undefined) {
    if (!Array.isArray(spec.lines) || spec.lines.length > STYLE_LIMITS.lines) add(problem(`style.lines is a list of up to ${STYLE_LIMITS.lines} lines {text, ref?, at?, tags?}.`));
    else for (const [index, line] of spec.lines.entries()) {
      const where = `style.lines[${index}]`;
      if (!isRecord(line)) { add(problem(`${where} is {text, ref?, at?, tags?}.`)); continue; }
      const extraKeys = Object.keys(line).filter((key) => !LINE_KEYS.includes(key));
      // Inspire's suggested lines carry guess:true; a line goes in the spec once you confirmed it.
      if (extraKeys.includes("guess")) add(problem(`${where} has guess: look at the reference's strips (look {mode:"reference", ref, t}), then send the lines you confirm without guess.`));
      else if (extraKeys.length) add(problem(`${where} takes ${LINE_KEYS.join(", ")}, not ${extraKeys.join(", ")}.`, { didYouMean: closest(extraKeys[0], LINE_KEYS) }));
      if (!hasText(line.text) || line.text.trim().length > STYLE_LIMITS.text) add(problem(`${where}.text is 1 to ${STYLE_LIMITS.text} characters: what the reference does.`));
      if (line.ref !== undefined && (!hasText(line.ref) || line.ref.trim().length > STYLE_LIMITS.ref)) add(problem(`${where}.ref names the reference (yt:<id>, a file or a link), up to ${STYLE_LIMITS.ref} characters.`));
      if (line.at !== undefined && (typeof line.at !== "number" || !Number.isFinite(line.at) || line.at < 0)) add(problem(`${where}.at is the second in the reference where it happens (a number, 0 or more).`));
      else if (line.at !== undefined && line.ref === undefined) add(problem(`${where} has at but no ref: name the reference the time is in.`));
      if (line.tags !== undefined) add(...tagsProblems(`lines[${index}].tags`, line.tags));
    }
  }
  if (spec.by !== "you" && spec.by !== "guessed") add(problem('style.by is "you" (the person asked for this style; send quote, their words) or "guessed" (your reading of the references).'));
  if (spec.by === "you") {
    if (!hasText(spec.quote)) add({ code: "quote_needed", message: 'style is by:"you", so it needs quote: the person\'s exact words from the chat. If they did not say it, send by:"guessed" with lines that name the reference and the time (ref, at).' });
    else if (spec.quote.trim().length > STYLE_LIMITS.quote) add(problem(`style.quote is up to ${STYLE_LIMITS.quote} characters; copy the part that says it.`));
  } else if (hasText(spec.quote)) add(problem('style is by:"guessed", so it has no quote. If the person said it, send by:"you" with the quote.'));
  if (spec.sources !== undefined) {
    const how = `style.sources is {avoids:"copied", moves:"dealt"}: for ${SOURCE_FIELDS.join(", ")}, one of ${SOURCES.join(", ")}`;
    if (!isRecord(spec.sources)) add(problem(`${how}.`));
    else for (const [key, value] of Object.entries(spec.sources)) {
      if (!SOURCE_FIELDS.includes(key) || !SOURCES.includes(value)) add(problem(`${how}, not ${key}:${JSON.stringify(value)}.`, { didYouMean: closest(String(SOURCE_FIELDS.includes(key) ? value : key), SOURCE_FIELDS.includes(key) ? SOURCES : SOURCE_FIELDS) }));
      else if (value === "you" && spec.by !== "you") add(problem(`style.sources.${key} is "you" only with by:"you" and their quote.`));
    }
  }
  if (current?.by === "you" && spec.by === "guessed") add({ code: "yours", message: `style is the person's ("${current.quote}"). Ask them in the chat, then save their new words with by:"you".` });
  if (found.length <= 1) return found[0] ?? null;
  return { ...found[0], message: `${found.length} problems in style: ${found.map((entry) => entry.message).join(" ")}` };
}

const number = (value, low, high) => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;

// The problems with the direction lock's keys (spine, fonts, accent, moves, logo, rejected,
// waived), as a list (empty when there are none). A beat's role is one of BEAT_ROLES or another
// short name.
function lockProblems(spec, subject = false) {
  const found = [];
  if (spec.spine !== undefined) {
    const how = 'style.spine is the beats in order: [{role:"hook", from:0, to:3, uses:["<layer>"], purpose:"<one sentence>"}]';
    if (!Array.isArray(spec.spine) || !spec.spine.length || spec.spine.length > STYLE_LIMITS.beats) found.push(problem(`${how}, 1 to ${STYLE_LIMITS.beats} beats.`));
    else for (const [index, beat] of spec.spine.entries()) {
      const where = `style.spine[${index}]`;
      if (!isRecord(beat) || !hasText(beat.role) || beat.role.length > 24) { found.push(problem(`${where}.role is ${BEAT_ROLES.join(", ")} or another short name. ${how}.`)); continue; }
      if (!number(beat.from, 0, 3600) || !number(beat.to, beat.from + 0.1, 3600)) found.push(problem(`${where} needs from and to in seconds, to after from.`));
      if (!hasText(beat.purpose) || beat.purpose.length > STYLE_LIMITS.text) found.push(problem(`${where}.purpose is one sentence (up to ${STYLE_LIMITS.text} characters): what the beat does for the story.`));
      if (beat.uses !== undefined && (!Array.isArray(beat.uses) || !beat.uses.every(hasText))) found.push(problem(`${where}.uses lists the layer or media names the beat shows.`));
    }
  }
  if (spec.fonts !== undefined) {
    if (!isRecord(spec.fonts) || !Object.keys(spec.fonts).length) found.push(problem("style.fonts is {caption:{family, size}, display:{...}, label:{...}}: one face per text role."));
    else for (const [role, face] of Object.entries(spec.fonts)) {
      if (!TEXT_ROLES.includes(role)) found.push(problem(`style.fonts takes ${TEXT_ROLES.join(", ")}, not ${role}.`, { didYouMean: closest(role, TEXT_ROLES) }));
      else if (!isRecord(face) || !hasText(face.family) || !number(face.size, 8, 600)) found.push(problem(`style.fonts.${role} is {family:"<font>", size:<px at the video's size>}.`));
    }
  }
  if (spec.accent !== undefined && (!isRecord(spec.accent) || !/^#[0-9a-f]{6}$/i.test(spec.accent.color ?? "") || !number(spec.accent.share, 0, 1)))
    found.push(problem('style.accent is {color:"#rrggbb", share:0.1}: the accent and the most of the frame it may cover.'));
  if (spec.moves !== undefined) {
    if (!Array.isArray(spec.moves) || spec.moves.length > STYLE_LIMITS.moves) found.push(problem(`style.moves is up to ${STYLE_LIMITS.moves} moves [{tag, where}]: a small vocabulary, each repeated as a motif.`));
    else for (const [index, move] of spec.moves.entries()) {
      if (!isRecord(move) || !hasText(move.where)) found.push(problem(`style.moves[${index}] is {tag:"<technique>", where:"<where it recurs>"}.`));
      else found.push(...tagsProblems(`moves[${index}].tag`, [move.tag]));
    }
  }
  if (spec.logo !== undefined && (!isRecord(spec.logo) || !hasText(spec.logo.asset) || !number(spec.logo.max, 1, 6)))
    found.push(problem('style.logo is {asset:"<logo layer or file>", max:2}: one logo, shown at most max times.'));
  if (spec.rejected !== undefined && (!Array.isArray(spec.rejected) || spec.rejected.length > STYLE_LIMITS.rejected || !spec.rejected.every((text) => hasText(text) && text.length <= STYLE_LIMITS.text)))
    found.push(problem(`style.rejected lists up to ${STYLE_LIMITS.rejected} texts the person turned down (each up to ${STYLE_LIMITS.text} characters).`));
  if (spec.waived !== undefined && (!hasText(spec.waived) || spec.by === "you")) found.push(problem('style.waived is why you lock it with no person to approve (by:"guessed"); with their approval send by:"you" and quote instead.'));
  found.push(...ideaProblems(spec, subject));
  return found;
}

const shortText = (value, most = STYLE_LIMITS.short) => hasText(value) && value.trim().length <= most;
const SIGNATURE_EXAMPLE = '[{beat:3, what:"the note flies into a card", source:"deck.png, the review screen", why:"only this app turns notes into cards"}]';
const SIGNATURE_KEYS = ["beat", "what", "source", "why", "at"];
const SIGNATURE_HELP = { what: "the designed moment", source: "the material it uses (a file or screen, and the moment)", why: "why only this product can show it" };
// The same questions for an edit of a subject in footage (subject-edit.mjs): run 8 was refused
// with "why only this product can show it" for an edit with no product (T220).
const SUBJECT_HELP = { ...SIGNATURE_HELP, source: "the material it uses (a clip or found shot, and the moment)", why: `why ${ONLY.subject.only} can show it` };
const IDEA_HELP = { product: 'what only this product can show, such as "your notes turn into a deck while you watch"', subject: `what ${ONLY.subject.only} can show, such as "the rookie misses twice, then takes the last shot anyway"` };

// The problems with idea, signatures and moments. A beat is the index of a spine beat.
function ideaProblems(spec, subject = false) {
  const help = subject ? SUBJECT_HELP : SIGNATURE_HELP;
  const found = [];
  const beats = Array.isArray(spec.spine) ? spec.spine.length : 0;
  const beatOk = (beat) => Number.isInteger(beat) && beat >= 0 && (!beats || beat < beats);
  const beatHelp = beats ? `0 to ${beats - 1} (the index of a spine beat)` : "the index (0 = first) of a spine beat";
  if (spec.idea !== undefined && !shortText(spec.idea, STYLE_LIMITS.idea))
    found.push(problem(`style.idea is one sentence, 1 to ${STYLE_LIMITS.idea} characters: ${IDEA_HELP[subject ? "subject" : "product"]}.`));
  if (spec.type !== undefined && !shortText(spec.type, 60))
    found.push(problem('style.type is the type direction, 1 to 60 characters: "<family class>, <size>, <case>, <how it appears>", from the references you studied.'));
  if (spec.signatures !== undefined) {
    if (!Array.isArray(spec.signatures) || !spec.signatures.length || spec.signatures.length > STYLE_LIMITS.signatures)
      found.push(problem(`style.signatures is 1 or ${STYLE_LIMITS.signatures} designed moments: ${SIGNATURE_EXAMPLE}.`));
    else for (const [index, entry] of spec.signatures.entries()) {
      const where = `style.signatures[${index}]`;
      const extra = isRecord(entry) ? Object.keys(entry).filter((key) => !SIGNATURE_KEYS.includes(key)) : [];
      if (!isRecord(entry) || extra.length) { found.push(problem(`${where} is {beat, what, source, why, at?}${extra.length ? `, not ${extra.join(", ")}` : ""}: ${SIGNATURE_EXAMPLE}.`)); continue; }
      if (!beatOk(entry.beat)) found.push(problem(`${where}.beat is ${beatHelp}.`));
      for (const key of ["what", "source", "why"]) if (!shortText(entry[key])) found.push(problem(`${where}.${key} is 1 to ${STYLE_LIMITS.short} characters: ${help[key]}.`));
      if (entry.at !== undefined && !(Array.isArray(entry.at) && entry.at.length === 2 && number(entry.at[0], 0, 3600) && number(entry.at[1], entry.at[0] + 0.1, 3600)))
        found.push(problem(`${where}.at is [from, to] in seconds of the video, to after from, such as [12, 16].`));
    }
  }
  if (spec.moments !== undefined) {
    if (!Array.isArray(spec.moments) || spec.moments.length > STYLE_LIMITS.moments)
      found.push(problem(`style.moments is up to ${STYLE_LIMITS.moments} set pieces [{tag:"screen-zoom", beat:3, what:"<the moment>"}]: one-off techniques, not the recurring moves.`));
    else for (const [index, entry] of spec.moments.entries()) {
      if (!isRecord(entry) || !shortText(entry.what) || !beatOk(entry.beat)) { found.push(problem(`style.moments[${index}] is {tag:"<technique>", beat:<${beatHelp}>, what:"<the moment, up to ${STYLE_LIMITS.short} characters>"}.`)); continue; }
      found.push(...tagsProblems(`moments[${index}].tag`, [entry.tag]));
    }
  }
  return found;
}

/**
 * Adds text the person turned down (notes answer {rejected:[...]}) to the brief's style spec,
 * making a guessed spec when there is none. The list keeps the newest STYLE_LIMITS.rejected; returns
 * the older texts it dropped (the answer says so). Throws an Error with a plain message on bad input.
 */
export function addRejected(draft, texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((text) => (typeof text === "string" ? text.trim() : ""));
  if (!list.length || list.some((text) => !text || text.length > STYLE_LIMITS.text))
    throw Object.assign(new Error(`rejected is the text the person turned down, word for word (1 to ${STYLE_LIMITS.text} characters each).`), { code: "bad_input" });
  const brief = draft.brief ?? (draft.brief = { rev: 0, savedAt: null, confirmedRev: null, noPlayback: null, fields: {}, log: [] });
  const style = brief.style ?? { wants: [], avoids: [], lines: [], by: "guessed" };
  const all = [...new Set([...(style.rejected ?? []), ...list])];
  style.rejected = all.slice(-STYLE_LIMITS.rejected);
  brief.style = style;
  return all.slice(0, -STYLE_LIMITS.rejected);
}

/**
 * A style sent over a saved one is a partial update: its keys replace the saved spec's (fonts
 * merges per role and field, so {fonts:{caption:{size:60}}} changes one size; null removes a key),
 * the keys not sent stay. A tag moved to the other list leaves the one it was in. Without by, by
 * and quote are kept; by:"you" needs its own quote (the saved one is not reused) and drops a saved
 * waiver, as the person's approval replaces it. Returns { spec, dropped? } or { problem }: an
 * update without by cannot change the person's spec (by:"you"), which needs their words.
 * The waiver stays unless the update changes the direction (directionChange): then it is dropped
 * (dropped names what changed) and the lock needs a new waiver or the person's approval.
 */
export function mergeStyle(spec, current) {
  if (!isRecord(spec) || !current || (spec.by === "guessed" && current.by === "you")) return { spec };
  if (spec.by === undefined && current.by === "you") return { problem: { code: "yours", message: `style is the person's ("${current.quote}"). Ask them in the chat, then send the change with by:"you" and their new words.` } };
  const merged = cleanStyle(current);
  if (spec.by === "you") delete merged.quote;
  if (spec.by === "you" && spec.waived === undefined) delete merged.waived;
  for (const [key, value] of Object.entries(spec)) {
    if (value === null) delete merged[key];
    else if (key === "fonts" && isRecord(value) && isRecord(merged.fonts))
      merged.fonts = { ...merged.fonts, ...Object.fromEntries(Object.entries(value).map(([role, face]) => [role, isRecord(face) && isRecord(merged.fonts[role]) ? { ...merged.fonts[role], ...face } : face])) };
    else merged[key] = value;
  }
  for (const [list, other] of [["wants", "avoids"], ["avoids", "wants"]])
    if (Array.isArray(spec[list]) && spec[other] === undefined && Array.isArray(merged[other])) merged[other] = merged[other].filter((tag) => !spec[list].includes(tag));
  // Sources: a list the update leaves as it was keeps where it came from. An approval (by:"you")
  // makes the wants and moves the person saw theirs, but never a copied or dealt list, and never
  // a guessed avoid (the board stop asks about it). A changed list takes the update's source, else its by.
  if (spec.sources === undefined || isRecord(spec.sources)) {
    const sources = {};
    for (const field of SOURCE_FIELDS) {
      const same = JSON.stringify(merged[field] ?? []) === JSON.stringify(current[field] ?? []);
      const was = current.sources?.[field] ?? current.by ?? "guessed";
      const kept = spec.by !== "you" || was === "copied" || was === "dealt" || (field === "avoids" && was === "guessed");
      sources[field] = spec.sources?.[field] ?? (same ? (kept ? was : "you") : merged.by);
    }
    merged.sources = sources;
  }
  const dropped = spec.waived === undefined && merged.waived ? directionChange(current, merged) : null;
  if (dropped) delete merged.waived;
  return { spec: merged, ...(dropped ? { dropped } : {}) };
}

/**
 * What changes the direction, so a waiver given for the old one no longer holds: another idea,
 * a saved signature gone or rewritten (by what it shows), or another story (the spine's roles in order).
 * Retiming beats, their uses and purposes, signature times and sources, a new signature, fonts,
 * accent, moves, tags and lines refine the same direction. Returns the names of what changed, or null.
 */
export function directionChange(before, after) {
  const norm = (text) => (typeof text === "string" ? text.trim().toLowerCase().replace(/\s+/g, " ") : "");
  const isList = (list) => Array.isArray(list) ? list : [];
  const changed = [
    norm(before?.idea) !== norm(after?.idea) && norm(before?.idea) ? "idea" : "",
    isList(before?.signatures).some((entry) => !isList(after?.signatures).some((other) => norm(other?.what) === norm(entry?.what))) ? "signatures" : "",
    isList(before?.spine).map((beat) => norm(beat?.role)).join(">") !== isList(after?.spine).map((beat) => norm(beat?.role)).join(">") && isList(before?.spine).length ? "spine roles" : "",
  ].filter(Boolean);
  return changed.length ? changed.join(", ") : null;
}

/** The spec as it is saved: trimmed, without empty lists. */
export function cleanStyle(spec) {
  if (spec === null) return null;
  const lines = (spec.lines ?? []).map((line) => ({
    text: line.text.trim(),
    ...(line.ref !== undefined ? { ref: line.ref.trim() } : {}),
    ...(line.at !== undefined ? { at: Math.round(line.at * 100) / 100 } : {}),
    ...(line.tags?.length ? { tags: [...new Set(line.tags)] } : {}),
  }));
  return {
    wants: [...new Set(spec.wants ?? [])],
    avoids: [...new Set(spec.avoids ?? [])],
    lines,
    by: spec.by,
    ...(spec.by === "you" ? { quote: spec.quote.trim() } : {}),
    ...(spec.spine ? { spine: spec.spine.map((beat) => ({ role: beat.role.trim().toLowerCase(), from: beat.from, to: beat.to,
      ...(beat.uses?.length ? { uses: beat.uses.map((name) => name.trim()) } : {}), purpose: beat.purpose.trim() })) } : {}),
    ...Object.fromEntries(["fonts", "accent", "moves", "logo"].filter((key) => spec[key] !== undefined).map((key) => [key, spec[key]])),
    ...(spec.rejected?.length ? { rejected: spec.rejected.map((text) => text.trim()) } : {}),
    ...(hasText(spec.waived) ? { waived: spec.waived.trim() } : {}),
    ...(hasText(spec.idea) ? { idea: spec.idea.trim() } : {}),
    ...(hasText(spec.type) ? { type: spec.type.trim() } : {}),
    ...(spec.signatures?.length ? { signatures: spec.signatures.map((entry) => ({ beat: entry.beat, what: entry.what.trim(), source: entry.source.trim(), why: entry.why.trim(), ...(entry.at ? { at: entry.at } : {}) })) } : {}),
    ...(spec.moments?.length ? { moments: spec.moments.map((entry) => ({ tag: entry.tag, beat: entry.beat, what: entry.what.trim() })) } : {}),
    ...sourcesOf(spec),
  };
}

// The spec's sources as saved: only lists it has whose source is not its by ({} when none).
function sourcesOf(spec) {
  if (!isRecord(spec.sources)) return {};
  const kept = Object.fromEntries(SOURCE_FIELDS.filter((field) => spec.sources[field] && spec.sources[field] !== spec.by && spec[field]?.length).map((field) => [field, spec.sources[field]]));
  return Object.keys(kept).length ? { sources: kept } : {};
}
