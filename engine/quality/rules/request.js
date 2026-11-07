// request_unmet: before an edit is reported done, each thing the person asked for (their brief
// lines and notes, ctx.asks) is compared with the document, so each
// requested item is checked before the edit is called finished.
// Only items the document can prove are judged: words in quotes on screen, music, a voice,
// captions, a logo, sound effects, an end card; "no X" or "remove the X" the other way round.
// A note with none of them is listed for the agent to confirm by looking, never guessed.
// A concrete miss holds the final render (waive_check request_unmet when the person changed their mind).
import { readingTexts, sec } from "../analysis.js";

const fold = (text) => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const QUOTED = /["“”]([^"“”]{2,80})["“”]/g;
const NEGATE = "(?:no|remove|without|drop|delete|lose|cut|kill|get rid of)";

const layersOf = (ctx) => ctx.scene?.layers ?? [];
const named = (layer, pattern) => pattern.test(`${layer.name ?? ""} ${layer.role ?? ""}`.toLowerCase());
const audio = (ctx) => layersOf(ctx).filter((layer) => layer.type === "audio" && layer.enabled !== false && layer.visible !== false);

// What each kind of item looks for in the document: true when present.
const KINDS = [
  { kind: "music", words: "music|song|soundtrack|track|beat", has: (model, ctx) => (ctx.speech ?? []).some((entry) => entry.music) || audio(ctx).some((layer) => !named(layer, /voice|vo\b|narrat|sfx|whoosh|hit/)) },
  { kind: "voice", words: "voiceover|voice over|voice-over|narration|narrator|vo", has: (model, ctx) => (ctx.speech ?? []).some((entry) => !entry.music && entry.words?.length) || audio(ctx).some((layer) => named(layer, /voice|vo\b|narrat/)) },
  { kind: "captions", words: "captions?|subtitles?|subs", has: (model, ctx) => layersOf(ctx).some((layer) => layer.type === "text" && named(layer, /caption|subtitle/)) },
  { kind: "logo", words: "logo|wordmark", has: (model, ctx) => layersOf(ctx).some((layer) => named(layer, /logo|wordmark|\bmark\b/)) },
  { kind: "sound effects", words: "sound effects?|sfx|whoosh(?:es)?", has: (model, ctx) => audio(ctx).some((layer) => named(layer, /sfx|whoosh|hit|swoosh|click|riser|impact/)) },
  { kind: "end card", words: "end card|end screen|call to action|cta", has: (model) => readingTexts(model).some((item) => model.times.some((time, index) => time >= model.duration * 0.8 && item.samples.opacity[index] >= 0.3)) },
];

// The texts on screen, folded, as one string per text.
const onScreen = (model) => readingTexts(model).map((item) => fold(item.text));

/** The checkable items of one ask: [{what, ok, negated}], or [] when it names nothing checkable. */
export function askItems(text, model, ctx, { never = false } = {}) {
  const items = [];
  const said = String(text ?? "");
  const texts = onScreen(model);
  for (const [, quote] of said.matchAll(QUOTED)) {
    const want = fold(quote);
    if (!want) continue;
    const shown = texts.some((entry) => entry.includes(want));
    const negated = never || new RegExp(`\\b${NEGATE}\\b[^"“]{0,12}["“]${quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(said);
    items.push({ what: `the words "${quote}" ${negated ? "off" : "on"} screen`, ok: negated ? !shown : shown });
  }
  if (never) return items;
  const plain = said.replace(QUOTED, " ").toLowerCase();
  for (const entry of KINDS) {
    const word = new RegExp(`\\b(?:${entry.words})\\b`);
    if (!word.test(plain)) continue;
    const negated = new RegExp(`\\b${NEGATE}\\b(?:\\s+\\S+){0,2}?\\s+(?:${entry.words})\\b`).test(plain);
    const present = entry.has(model, ctx);
    items.push({ what: `${negated ? "no " : ""}${entry.kind}`, ok: negated ? !present : present });
  }
  return items;
}

/** request_unmet: an item the person asked for that the document does not show. */
export function requestUnmet(model, ctx) {
  const asks = ctx.asks ?? [];
  if (!asks.length) return [];
  const findings = [];
  const unclear = [];
  for (const ask of asks) {
    const items = askItems(ask.text, model, ctx, { never: ask.field === "never" });
    if (!items.length) { if (ask.note) unclear.push(ask); continue; }
    for (const item of items.filter((entry) => !entry.ok)) findings.push({
      rule: "request_unmet", severity: "warn", final: true, at: 0, until: sec(model.duration),
      measured: `${ask.id}: ${item.what} is not in the edit`, required: `every item the person asked for (${ask.id}: "${String(ask.text).slice(0, 80)}")`,
      message: `${ask.id} asked for ${item.what}; the edit does not show it yet.`,
      fix: { kind: "hint", text: `Make the edit for ${ask.id}, or, if the person changed their mind, waive_check request_unmet with their words.` },
    });
  }
  if (unclear.length) findings.push({
    rule: "request_unmet", severity: "warn", at: 0, until: sec(model.duration),
    measured: `${unclear.length} note${unclear.length === 1 ? "" : "s"} kino cannot check from the document: ${unclear.slice(0, 3).map((ask) => `${ask.id} "${String(ask.text).slice(0, 50)}"`).join(", ")}${unclear.length > 3 ? ", ..." : ""}`,
    required: "each confirmed by looking (look frame at its time) before you say it is done",
    message: `Confirm by looking that ${unclear.map((ask) => ask.id).slice(0, 3).join(", ")} landed; kino can only check words in quotes, music, voice, captions, a logo, sound effects and an end card.`,
    fix: { kind: "hint", text: "look {mode:\"frame\", t:<the note's time>} for each, then say what you saw." },
  });
  return findings;
}
