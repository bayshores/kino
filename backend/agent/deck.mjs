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
import { applySwap, cardNames, dealDeck, deckLine, materialOf, materialWords, mediaKeys, sharesMaterial, swapProblem, SWAP_LIMIT } from "../../engine/deck.js";
import { styleContext } from "../../engine/styleSpec.js";
import { techniqueOf } from "../../engine/techniques.js";

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
    .then((module) => Object.values(module.MOVES ?? {}).map((move) => ({ name: move.name, tags: [...(move.tags ?? [])], needs: [...(move.needs ?? [])], fits: move.fits ?? "" })))
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

/** What a deal reads: { style, material, moves, basis, media, story }. basis changes when a new deal is due. */
export async function deckInputs(state, document) {
  const style = styleContext(state?.brief?.style);
  const material = materialOf(document, { madeFrom: madeFromOf(state?.brief) });
  const moves = await loadMoves();
  const { fromLayers, ...kinds } = material;
  // A new signature (moments or signatures saved) deals again around it.
  const signature = style?.moments?.length ? style.moments[0].tag : style?.signatures?.length ? "set piece" : null;
  const basis = JSON.stringify({ kinds, backed: style?.backed ?? [], guessed: style?.guessed ?? [], avoids: style?.avoids ?? [], moves: moves.map((move) => move.name), ...(signature ? { signature } : {}) });
  return { style, material, moves, basis, media: mediaKeys(document), story: storyOf(state?.brief) };
}

/** True when the saved deck should be dealt again by itself (see the top of this file). */
export function dealDue(deck, basis) {
  if (!deck) return true;
  return deck.basis !== basis && !deck.locked && !(deck.swaps?.length);
}

/**
 * A new deal, as it is saved. `recent` is recentDecks() of the state store. A recent project
 * that shares media or the story with this one (a remake, a cut-down) is not steered away from.
 */
export function newDeal({ projectId, reroll = 0, inputs, recent = [], now = Date.now() }) {
  const own = { media: inputs.media ?? [], story: inputs.story ?? "" };
  const away = recent.filter((entry) => !sharesMaterial(entry, own));
  const tags = [...new Set(away.flatMap((entry) => [...entry.cards, ...entry.used]))];
  const dealt = dealDeck({ projectId, reroll, style: inputs.style, material: inputs.material, recent: tags, moves: inputs.moves });
  return {
    ...dealt, swaps: [], basis: inputs.basis, locked: Boolean(inputs.material.fromLayers),
    material: materialWords(inputs.material), awayFrom: away.map((entry) => entry.projectId), dealtAt: new Date(now).toISOString(), used: [],
    media: own.media, story: own.story,
  };
}

/** The line status shows, with a hint when the deck no longer follows the material or spec. */
export function deckStatusLine(deck, basis) {
  if (!deck) return "";
  return `${deckLine(deck)}${deck.basis !== basis ? " (material or spec changed: notes deck reroll:true deals again)" : ""}`;
}

// One card in a line: what it is, so the agent can build it without a lookup.
function cardText(name, moves) {
  const entry = techniqueOf(name);
  if (entry) return `- ${name} (${entry.group}): ${entry.line}; fits ${entry.fits}`;
  const move = moves.find((item) => item.name === name);
  return `- ${name} (set piece, move {name:"${name}"}): ${move?.fits ?? "a move"}`;
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
    ...cardNames(deck).map((name) => cardText(name, moves)),
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
