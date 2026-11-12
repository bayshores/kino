// The deck in the agent service: when a project is dealt its hand (engine/deck.js), what the deal
// reads (the brief's style spec and made_from line, the document, the moves library, the decks
// of this machine's last projects), and the answers of notes {action:"deck"}.
//
// When it is dealt: the first status or notes call after the brief is settled and the treatment
// is picked (or the treatments are waived or skipped), or notes {action:"deck"}. Before the
// pick there is none, so the 5 treatments come from the material, not from the dealt cards. Until the agent builds or swaps a card, a
// deal follows the project: new material or a new spec deals again with the same seed. Once
// the deal read built layers (`locked`) or a card was swapped, only reroll deals again, so the
// hand does not change under the agent's feet.
//
// Plain data in and out: the service saves the deck in the project's agent state (state.deck):
//   { seed, reroll, cards:[{tag, group, why}], setPiece:{kind, name, tags}|null,
//     swaps:[{out, in, why, at}], basis, locked, material, dealtAt, used:[tags], awayFrom,
//     media:[files], story }   media and story: what tells a later project it is kin (no steering)
import { applySwap, cardNames, dealableTags, dealDeck, DECK_GROUPS, deckLine, madeCardOf, materialOf, materialWords, mediaKeys, sharesMaterial, swapProblem, SWAP_LIMIT } from "../../engine/deck.js";
import { styleContext } from "../../engine/styleSpec.js";
import { techniqueOf } from "../../engine/techniques.js";
import { seenNameList } from "./seen-names.mjs";
import { askLine, askMatches } from "../../engine/askWords.js";

export const DECK_KEYS = Object.freeze(["action", "project", "reroll", "swap"]);
// How many of this machine's last projects the deal steers away from.
export const RECENT_PROJECTS = 3;

let moving = null;
/**
 * The moves library ([{name, tags, fits}]) of engine/blocks/moves, read once. If it cannot be read
 * the list is empty and the deck deals techniques only.
 */
export function loadMoves() {
  moving ??= import("../../engine/blocks/moves/index.js")
    // A move marked deal: false (impact-accent: only where a cue motivates it) is never dealt.
    .then((module) => Object.values(module.MOVES ?? {}).filter((move) => move.deal !== false).map((move) => ({ name: move.name, tags: [...(move.tags ?? [])], needs: [...(move.needs ?? [])], fits: move.fits ?? "", about: move.about ?? "" })))
    .catch((error) => {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") console.warn(`kino: the moves library could not be read, so the deck deals techniques only: ${error.message}`);
      return [];
    });
  return moving;
}

/** The brief's made_from line as words the material reading understands. */
export const madeFromOf = (brief) => {
  const line = brief?.fields?.made_from;
  return line ? `${line.text ?? ""} ${line.quote ?? ""}`.trim() : "";
};

/** The brief's message, compared loosely: lowercase words only. */
export const storyOf = (brief) => String(brief?.fields?.message?.text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// The on-screen kinds a label names, as the made card that builds them. A guess: "spoken" is a
// line a clip says, "composite" most often a subject cut out over another picture; the label's
// words decide the rest (SEEN_AS).
const KIND_NAMES = { spoken: ["keep_line"], composite: ["cut_out"] };
// What a card the deck can deal is: a technique of the four groups, or a made card.
const dealableName = (name) => Boolean(madeCardOf(name)) || (DECK_GROUPS.includes(techniqueOf(name)?.group) && dealableTags(techniqueOf(name).group).includes(name));

/**
 * What the project's labeled references show, as deck names: [{name, refs:[ids]}], most
 * references first. `refs` is savedFingerprints(projectId, {labeled:true}) of backend/inspire.mjs:
 * each {id, seen:[{at, kinds, words}]}. A reference labeled at only some moments counts on those.
 */
export function labelEvidence(refs = []) {
  const found = new Map();
  for (const ref of refs ?? []) {
    const names = new Set();
    for (const entry of ref?.seen ?? []) {
      for (const kind of entry?.kinds ?? []) for (const name of KIND_NAMES[kind] ?? []) names.add(name);
      for (const name of seenNameList(entry?.words ?? "")) names.add(name);
      // A technique named in the words ("dissolve", "punch in"), by its tag with spaces.
      const text = ` ${String(entry?.words ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
      for (const tag of DECK_GROUPS.flatMap(dealableTags)) if (text.includes(` ${tag.replace(/-/g, " ")} `)) names.add(tag);
    }
    for (const name of names) if (dealableName(name)) found.set(name, [...(found.get(name) ?? []), ref.id]);
  }
  return [...found].map(([name, ids]) => ({ name, refs: ids })).sort((a, b) => b.refs.length - a.refs.length || a.name.localeCompare(b.name));
}

/**
 * What a deal reads: { style, material, moves, evidence, basis, media, story }. basis changes when a new deal is due.
 * facts: what kino measured in the footage ({faceClips, lines, darkClips}, materialOf); refs: the
 * labeled references (labelEvidence). Both optional: without them the deal is as before.
 */
export async function deckInputs(state, document, { facts = {}, refs = [], slots = null } = {}) {
  const style = styleContext(state?.brief?.style);
  const material = materialOf(document, { madeFrom: madeFromOf(state?.brief), facts });
  const moves = await loadMoves();
  const evidence = labelEvidence(refs);
  // "seen in 1 of your 3 references" counts every labeled reference, not only those a card came from.
  const labeledRefs = (refs ?? []).filter((ref) => ref?.seen?.length).length;
  const { fromLayers, ...kinds } = material;
  // A new signature (moments or signatures saved) deals again around it.
  const signature = style?.moments?.length ? style.moments[0].tag : style?.signatures?.length ? "set piece" : null;
  // The moves the person's own words name (their stored ask against each move's about and fits).
  const asked = askedMoves(state?.brief, moves);
  const basis = JSON.stringify({ kinds, backed: style?.backed ?? [], guessed: style?.guessed ?? [], avoids: style?.avoids ?? [], moves: moves.map((move) => move.name), ...(signature ? { signature } : {}),
    ...(evidence.length ? { seen: evidence.map((entry) => `${entry.name}:${entry.refs.length}`) } : {}), ...(asked.length ? { asked: asked.map((entry) => entry.name) } : {}) });
  return { style, material, moves, evidence, labeledRefs, ...(slots ? { slots } : {}), ...(asked.length ? { asked } : {}), basis, media: mediaKeys(document), story: storyOf(state?.brief) };
}

/** The moves the brief's stored ask names: [{word, name}] (engine/askWords.js); [] without an ask. */
export function askedMoves(brief, moves) {
  const asks = (Array.isArray(brief?.fields?.ask) ? brief.fields.ask : []).map((entry) => entry?.text ?? "").join(" ");
  return asks.trim() ? askMatches(asks, moves.map((move) => ({ name: move.name, text: `${move.about ?? ""} ${move.fits ?? ""}` }))) : [];
}

/** True when a card of the deck was used: check recorded it (deck.used) or the document holds it (`holds`: madeNamesIn names). */
export function deckTouched(deck, holds = []) {
  const names = cardNames(deck);
  return names.some((name) => (deck?.used ?? []).includes(name) || holds.includes(name));
}

/**
 * True when the saved deck should be dealt again by itself (see the top of this file): the
 * material, the spec or the labels changed, and no card was swapped or used yet. A deck the person
 * picked or compose cut with (lockedBy) stays. An older deck's `locked` meant only that it read
 * built layers, so it no longer holds a deal whose cards were never used.
 */
export function dealDue(deck, basis, { holds = [] } = {}) {
  if (!deck) return true;
  return deck.basis !== basis && !deck.lockedBy && !(deck.swaps?.length) && !deckTouched(deck, holds);
}

/**
 * A new deal, as it is saved. `recent` is recentDecks() of the state store. A recent project
 * that shares media or the story with this one (a remake, a cut-down) is not steered away from.
 */
export function newDeal({ projectId, reroll = 0, inputs, recent = [], now = Date.now() }) {
  const own = { media: inputs.media ?? [], story: inputs.story ?? "" };
  const away = recent.filter((entry) => !sharesMaterial(entry, own));
  const tags = [...new Set(away.flatMap((entry) => [...entry.cards, ...entry.used]))];
  const dealt = dealDeck({ projectId, reroll, style: inputs.style, material: inputs.material, recent: tags, moves: inputs.moves, evidence: inputs.evidence ?? [], asked: inputs.asked ?? [] });
  const { lines, subjectClips, dark } = inputs.material ?? {};
  const seenRefs = Math.max(new Set((inputs.evidence ?? []).flatMap((entry) => entry.refs)).size, inputs.labeledRefs ?? 0);
  // The real names a made card's call is filled with (cardCall), when the service found them.
  const slots = inputs.slots && Object.keys(inputs.slots).length ? inputs.slots : null;
  return {
    ...dealt, swaps: [], basis: inputs.basis, ...(inputs.asked?.length ? { asked: inputs.asked } : {}),
    material: materialWords(inputs.material), awayFrom: away.map((entry) => entry.projectId), dealtAt: new Date(now).toISOString(), used: [],
    media: own.media, story: own.story,
    // The facts and labels the deal read, for each card's why (cardWhy); absent when none.
    ...(lines || subjectClips || dark || seenRefs ? { facts: { ...(lines ? { lines } : {}), ...(subjectClips ? { subjectClips } : {}), ...(dark ? { dark } : {}), ...(seenRefs ? { labeledRefs: seenRefs } : {}), ...(slots ? { slots } : {}) } } : {}),
  };
}

/** The line status shows, with a hint when the deck no longer follows the material or spec. */
export function deckStatusLine(deck, basis) {
  if (!deck) return "";
  const why = deckWhyLine(deck);
  // The ask's words on status too: run 8 read the deck only on status (T164, T338), and a signature
  // can take the set piece's place, so the move the ask names stays in view (askLine).
  const asked = askLine(deck.asked ?? []);
  return `${deckLine(deck)}${deck.basis !== basis ? " (material or spec changed: notes deck reroll:true deals again)" : ""}${why ? `\n${why}` : ""}${asked ? `\n${asked}` : ""}`;
}

/** Why a card was dealt, in a few words: "seen in 2 of your 3 references", "your clips say 4 lines". */
export function cardWhy(card, deck) {
  const facts = deck?.facts ?? {};
  if (card.why === "seen") return `seen in ${card.refs} of your ${Math.max(card.refs, facts.labeledRefs ?? 0)} references`;
  if (card.why === "fact" && card.fact === "lines") return `your clips say ${facts.lines} lines`;
  if (card.why === "fact" && card.fact === "subject") return `a face or marked subject in ${facts.subjectClips} ${facts.subjectClips === 1 ? "clip" : "clips"}`;
  if (card.why === "spec") return "your style spec";
  if (card.why === "signature") return "the picked idea's signature";
  if (card.why === "swap") return "swapped in";
  return "";
}

// The cards dealt on evidence in one line: "from: speed-lines seen in 2 of your 2 references · keep_line your clips say 4 lines"; "" with none.
function deckWhyLine(deck) {
  const told = (deck.cards ?? []).filter((card) => card.why === "seen" || card.why === "fact").map((card) => `${card.tag} ${cardWhy(card, deck)}`);
  return told.length ? `from: ${told.join(" · ")}` : "";
}

/**
 * The ready call for a card: a made card's own op, a move's library entry, else the technique search.
 * slots ({clip, lineClip, line, song}, deck.facts.slots) fill a made card's <clip>, <its words> and
 * <song> with the project's own names, so the call works as sent (run 6 trace section 2: the lines were
 * listed at import and never kept). A slot kino did not find stays a slot to fill.
 */
export function cardCall(name, moves = [], slots = null) {
  const made = madeCardOf(name);
  if (made) {
    const quoted = (text) => String(text).replaceAll('"', "'");
    let call = made.call;
    if (name === "keep_line" && slots?.lineClip) call = call.replace('"<clip>"', `"${quoted(slots.lineClip)}"`);
    if (name === "keep_line" && slots?.line) call = call.replace('"<its words>"', `"${quoted(slots.line)}"`);
    if (slots?.song) call = call.replace('"<song>"', `"${quoted(slots.song)}"`);
    if (slots?.clip) call = call.replace('"<clip>"', `"${quoted(slots.clip)}"`);
    return `edit {ops:[${call}]}`;
  }
  if (moves.some((move) => move.name === name)) return `library {topic:"moves", name:"${name}"}`;
  return `library {topic:"search", search:"${name.replace(/-/g, " ")}"}`;
}

// One card in a line: what it is, so the agent can build it without a lookup, and why it was dealt.
function cardText(card, moves, deck) {
  const name = card.tag ?? card;
  const why = card.tag ? cardWhy(card, deck) : "";
  const tail = why ? ` · ${why}` : "";
  const entry = techniqueOf(name);
  if (entry) return `- ${name} (${entry.group}): ${entry.line}; fits ${entry.fits}${tail}`;
  const made = madeCardOf(name);
  if (made) return `- ${name} (made, ${made.kind}): ${made.line}; ${cardCall(name, moves, deck?.facts?.slots)}${tail}`;
  const move = moves.find((item) => item.name === name);
  const word = deck?.setPiece?.name === name && deck.setPiece.word ? ` · your words: "${deck.setPiece.word}"` : "";
  return `- ${name} (set piece, move {name:"${name}"}): ${move?.fits ?? "a move"}${word}`;
}

/** The answer of notes {action:"deck"}: the hand, each card in a line, and how to change it. */
export function deckText(deck, { moves = [], said = "" } = {}) {
  const left = SWAP_LIMIT - (deck.swaps?.length ?? 0);
  const steer = [
    deck.cards.some((card) => card.why === "spec") ? `spec: ${deck.cards.filter((card) => card.why === "spec").map((card) => card.tag).join(", ")}` : "",
    deck.awayFrom?.length ? `away from ${deck.awayFrom.length} recent ${deck.awayFrom.length === 1 ? "project" : "projects"}` : "",
  ].filter(Boolean).join(" · ");
  return [
    said,
    deckLine(deck),
    `for: ${deck.material ?? "no material yet"}${steer ? ` · ${steer}` : ""}`,
    ...deck.cards.map((card) => cardText(card, moves, deck)),
    ...(deck.setPiece ? [cardText(deck.setPiece.name, moves, deck)] : []),
    // Every move the ask's words name, dealt or not (run 8: "aura" named energy-aura, never offered).
    askLine(deck.asked ?? []),
    ...(deck.swaps ?? []).map((swap) => `swapped: ${swap.out} → ${swap.in} (${swap.why})`),
    `Build each card where it fits (deck_unused warns under half). ${left ? `swap {out, in, why} (${left} left)` : "No swaps left"}; reroll:true deals again.`,
  ].filter(Boolean).join("\n");
}

/** The facts of a deck answer, for programs. */
export function deckData(deck) {
  const { basis, media, story, ...rest } = deck;
  return { deck: rest, line: deckLine(deck) };
}

/** Checks notes {action:"deck"} input: { reroll, swap } or a problem message. */
export function deckRequest(input) {
  const unknown = Object.keys(input).filter((key) => input[key] !== undefined && !DECK_KEYS.includes(key) && !["why", "next"].includes(key));
  if (unknown.length) return { problem: `deck takes reroll or swap, not ${unknown.join(", ")}.` };
  if (input.reroll !== undefined && input.reroll !== true) return { problem: "reroll is true: deal a new hand." };
  if (input.reroll && input.swap !== undefined) return { problem: "Send reroll or swap, not both." };
  return { reroll: input.reroll === true, swap: input.swap };
}

export { applySwap, mediaKeys, swapProblem, SWAP_LIMIT };
