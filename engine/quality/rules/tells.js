// Warnings for the things that make a video read as AI-made: copy the agent invented
// (own_words), stock promo phrases (stock_copy), every text entering the same way
// (same_entrance), every text revealed word by word (word_by_word), a fade or blur at every
// section change (soft_cuts), titles over blurred full-frame footage beat after beat
// (blurred_backdrop), glowing text (text_glow) and a small label stacked over a headline
// (stacked_label). One designed use (a word-by-word hook, one
// title over a blur) is a choice; the same move on every beat is the template. Each says what to do instead; ideas.md in the skill has the alternatives.
//
// These are kino's default style, not rules for every video: a style spec on the brief that wants
// the technique (backed by a reference or the person's words) turns word_by_word, soft_cuts and
// blurred_backdrop off (SILENCED_BY in ../index.js), and same_entrance stays silent when the
// entrance it sees is a wanted one.
import { coversFrame, entrances, readingTexts, scaleOf, sec, sections, motions, speechTimed } from "../analysis.js";
import { area, boxAt, intersection } from "../model.js";
import { TEXT_PRESET_TAGS } from "../techniques.js";
import { contentWords, sourceVocabulary, stem } from "../../sources.js";

// A sharp clip covering this share of the frame in front of a blurred one makes the blur a fill.
const FILL_CLIP_SHARE = 0.2;

const textsOf = (item) => (Array.isArray(item.texts) && item.texts.length ? item.texts : [item.text]).filter((text) => typeof text === "string" && text.trim());

const CREDIT_LINE = /^\s*(music|song|track|footage|photos?|credits?)\s*(by)?\s*[:\-]|^\s*(music|song|footage|photos?)\s+by\b|\bCC[ -]?(BY|0)\b|\blicen[cs]ed?\b|\bcourtesy of\b/i;

/** On-screen text whose words are mostly in none of the saved sources. */
export function ownWords(model, ctx) {
  if (!Array.isArray(ctx.sources)) return [];
  const texts = readingTexts(model);
  if (!texts.length) return [];
  if (!ctx.sources.length) {
    ctx.note('own_words: no source saved. Save the person\'s material (their message, README, script) with {op:"source", name, text}, and check names on-screen words that are in none of it.');
    return [];
  }
  const known = sourceVocabulary(ctx.sources);
  const findings = [];
  for (const item of texts) {
    // A credit line (music, footage, license) names other people's work by design.
    if (CREDIT_LINE.test(textsOf(item).join(" "))) continue;
    const words = [...new Set(textsOf(item).flatMap(contentWords))];
    const missing = words.filter((word) => !known.has(word) && !known.has(stem(word)));
    if (missing.length < 2 || missing.length / words.length <= 0.5) continue;
    findings.push({
      rule: "own_words", severity: "warn", itemId: item.id,
      measured: `${missing.length} of ${words.length} words in no source`, required: "words from the material",
      message: `${ctx.name(item)} says "${ctx.quote(textsOf(item).join(" "))}": ${missing.slice(0, 6).join(", ")} ${missing.length === 1 ? "is" : "are"} in no saved source, so it may be invented copy.`,
      fix: { kind: "hint", text: "Use the material's own words (a line from the README, a real number, the product's own message), or waive own_words for this layer if the line is yours on purpose." },
    });
  }
  return findings;
}

// Phrases from template promos. Each is matched on word boundaries, case-insensitively.
const STOCK = [
  "introducing", "meet the", "say goodbye to", "say hello to", "revolutioniz\\w*", "game[- ]chang\\w*", "next[- ]level",
  "seamless(?:ly)?", "effortless(?:ly)?", "unleash\\w*", "unlock (?:your|the)", "supercharg\\w*", "elevate your", "empower\\w*",
  "cutting[- ]edge", "state[- ]of[- ]the[- ]art", "like never before", "the future of", "reimagin\\w*", "redefin\\w*",
  "all[- ]in[- ]one", "one[- ]stop", "ai[- ]powered", "powered by ai", "transform (?:your|the way)", "boost your productivity", "made simple",
].map((phrase) => ({ phrase, pattern: new RegExp(`(?:^|[^\\p{L}])(${phrase})(?![\\p{L}])`, "iu") }));
const EMOJI = /(?![©®™])\p{Extended_Pictographic}/u;
// A sentence ends at . ! or ? followed by a space or the end ("0.6" is one word).
const sentencesOf = (text) => text.split(/[.!?]+(?=\s|$)/u).map((part) => part.trim()).filter((part) => /\p{L}/u.test(part));
const wordCount = (text) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;

/** Template promo copy: stock phrases, three-beat slogans ("Fast. Simple. Secure.") and emoji. */
export function stockCopy(model, ctx) {
  const findings = [];
  const finding = (item, measured, message, text) => findings.push({
    rule: "stock_copy", severity: "warn", itemId: item.id, measured, required: "the product's own words",
    message, fix: { kind: "hint", text },
  });
  const oneWordBeats = [];
  // The voice's captions break where the voice does ("notes." is a word said, not a beat of a
  // slogan): only their words are judged, not how they split into lines.
  const timed = speechTimed(model);
  for (const item of readingTexts(model)) {
    const all = textsOf(item).join(" ");
    const stock = STOCK.map(({ pattern }) => all.match(pattern)?.[1]).find(Boolean);
    if (stock) { finding(item, `"${stock}"`, `${ctx.name(item)} says "${stock}", a stock promo phrase that reads as template copy.`, "Say what the product does in its own words, or show it doing it instead of naming it."); continue; }
    if (timed.has(item.id)) continue;
    const sentences = sentencesOf(all);
    if (sentences.length >= 3 && sentences.every((part) => wordCount(part) <= 3)) {
      finding(item, `${sentences.length} beats`, `${ctx.name(item)} is a three-beat slogan ("${ctx.quote(all)}"), the most common template line.`, "Replace it with one concrete line: a real number, a real moment, or the product's own message.");
      continue;
    }
    if (EMOJI.test(all)) { finding(item, "emoji", `${ctx.name(item)} uses emoji, which reads as generated social copy.`, "Drop the emoji, or show the real thing it stands for."); continue; }
    if (textsOf(item).length === 1 && wordCount(all) === 1 && /\.\s*$/.test(all)) oneWordBeats.push(item);
  }
  if (oneWordBeats.length >= 3) finding(oneWordBeats[0], `${oneWordBeats.length} one-word lines`, `${oneWordBeats.slice(0, 3).map(ctx.name).join(", ")} are one-word lines with a full stop ("Fast." "Simple."), the three-beat template.`, "Replace them with one concrete line, or show each quality happening.");
  return findings;
}

const presetOf = (motion) => motion.tweens.find((tween) => tween.preset)?.preset ?? null;

/** Four or more reading texts that all enter with the same preset (a text that cuts in is different). */
export function sameEntrance(model, ctx) {
  const texts = readingTexts(model);
  const textIds = new Set(texts.map((item) => item.id));
  const list = entrances(model).filter((motion) => textIds.has(motion.itemId) && motion.duration > 1.5 / model.fps);
  if (list.length < 4 || list.length < texts.length) return [];
  const presets = new Set(list.map(presetOf));
  if (presets.size !== 1 || presets.has(null)) return [];
  const [preset] = presets;
  if (ctx.style?.backed?.includes(TEXT_PRESET_TAGS[preset])) {
    ctx.note(`same_entrance is quiet: every text enters with ${preset}, which the style spec wants (${TEXT_PRESET_TAGS[preset]}).`);
    return [];
  }
  return [{
    rule: "same_entrance", severity: "warn", itemId: list[0].itemId, at: sec(list[0].start),
    measured: `${list.length} texts, all ${preset}`, required: "entrances that fit each moment",
    message: `All ${list.length} texts in ${ctx.sceneName} enter with ${preset}; one entrance for everything reads as a template.`,
    fix: { kind: "hint", text: "Let most text cut in (no entrance) on an action, and keep one considered entrance for the moment that matters." },
  }];
}

const byUnit = (tween) => ["words", "word", "letters", "letter"].includes(tween.unit) && (tween.stagger ?? 0) > 0;

/** Every text (three or more) revealed word by word or letter by letter: no line set apart. */
export function wordByWord(model, ctx) {
  const textIds = new Set(readingTexts(model).map((item) => item.id));
  const items = [...new Set(motions(model).filter((motion) => textIds.has(motion.itemId) && motion.kind === "in" && motion.tweens.some(byUnit)).map((motion) => motion.itemId))];
  if (items.length < 3 || items.length < textIds.size) return [];
  return [{
    rule: "word_by_word", severity: "warn", itemId: items[0],
    measured: `all ${items.length} texts revealed by word or letter`, required: "a reveal chosen for each line",
    message: `Every text in ${ctx.sceneName} (${items.length}) appears word by word or letter by letter, the auto-caption look.`,
    fix: { kind: "hint", text: "Let some lines land whole, cut on the speech or the action, so the per-word reveals mean something. If the references reveal every caption word by word, say so in the style spec (wants type-words, with the ref and time) and this warning stops." },
  }];
}

const SOFT_PRESETS = new Set(["fade", "blur", "blur-slide", "dissolve", "preset-fade", "preset-blur", "preset-blur-slide"]);
const isSoft = (motion) => {
  if (SOFT_PRESETS.has(presetOf(motion))) return true;
  const keys = new Set(motion.tweens.flatMap((tween) => tween.keys));
  return keys.size > 0 && [...keys].every((key) => ["opacity", "blur"].includes(key));
};

/** Every section change (three or more) is a fade or a blur. */
export function softCuts(model, ctx) {
  const list = sections(model);
  if (list.length < 4) return [];
  const window = 0.35;
  const soft = motions(model).filter((motion) => motion.duration >= 0.15 && isSoft(motion));
  const changes = list.slice(1).map((section) => section.start);
  const softAt = (time) => soft.some((motion) => (motion.kind === "out" && Math.abs(motion.end - time) <= window) || (motion.kind === "in" && Math.abs(motion.start - time) <= window));
  if (!changes.every(softAt)) return [];
  return [{
    rule: "soft_cuts", severity: "warn", at: sec(changes[0]),
    measured: `${changes.length} of ${changes.length} section changes fade or blur`, required: "hard cuts, with one soft change at most where it means something",
    message: `Every section change in ${ctx.sceneName} (${changes.map((time) => `${sec(time)}s`).join(", ")}) is a fade or blur, the default template transition.`,
    fix: { kind: "hint", text: "Vary the changes: cut on an action or a match, and keep a fade for the one change that should feel like time passing. If the references dissolve or blur between shots, say so in the style spec (wants dissolve, with the ref and time) and this warning stops." },
  }];
}

// Beats of text over a blur before it reads as the template look, not one designed moment.
const BACKDROP_REPEATS = 3;
// Texts that come on within this many seconds of each other are one beat (a title and its subtitle).
const BACKDROP_BEAT = 1;

/**
 * Reading texts centered over a full-frame image or video blurred 8 px or more, on three beats or
 * more (one title over a blur, a hook, is a choice, even made of several texts). A blur that is a
 * fill behind a sharp clip (a 16:9 clip in a 9:16 frame over a blurred copy) is not the look: the
 * picture people watch is sharp.
 */
export function blurredBackdrop(model, ctx) {
  const blurry = model.items.filter((item) => (item.kind === "image" || item.kind === "video") && !item.isMask && coversFrame(model, item));
  if (!blurry.length) return [];
  const s = scaleOf(model);
  const frame = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const sharpInFront = (back, index) => model.items.some((front) => front.z > back.z && (front.kind === "image" || front.kind === "video") && !front.isMask
    && front.samples.opacity[index] >= 0.5 && Math.max(front.samples.blur[index] ?? 0, front.blur ?? 0) <= 2 * s
    && area(intersection(boxAt(front, index), frame)) >= FILL_CLIP_SHARE * model.width * model.height);
  const found = [];
  for (const text of readingTexts(model)) {
    for (let index = 0; index < model.times.length; index += 1) {
      if (text.samples.opacity[index] < 0.5) continue;
      const box = boxAt(text, index);
      const centered = Math.abs((box.x0 + box.x1) / 2 - model.width / 2) <= model.width * 0.06;
      if (!centered) continue;
      const behind = blurry.find((item) => item.samples.opacity[index] >= 0.5 && Math.max(item.samples.blur[index] ?? 0, item.blur ?? 0) >= 8 * s && !sharpInFront(item, index));
      if (!behind) continue;
      found.push({ text, behind, at: model.times[index] });
      break;
    }
  }
  // One beat per run of texts that come on less than BACKDROP_BEAT apart.
  found.sort((a, b) => a.at - b.at);
  const beats = found.filter((entry, index) => index === 0 || entry.at - found[index - 1].at >= BACKDROP_BEAT);
  if (beats.length < BACKDROP_REPEATS) return [];
  const [first] = found;
  return [{
    rule: "blurred_backdrop", severity: "warn", itemId: first.text.id, itemIds: found.map((entry) => entry.text.id), at: sec(first.at),
    measured: `${beats.length} beats of text centered over blurred footage`, required: `fewer than ${BACKDROP_REPEATS} beats: keep the blur for one designed moment`,
    message: `${found.slice(0, 3).map((entry) => ctx.name(entry.text)).join(", ")}${found.length > 3 ? ` +${found.length - 3}` : ""} sit centered over blurred footage (from ${beats.map((entry) => `${sec(entry.at)}s`).slice(0, 4).join(", ")}), the stock "title over blurred video" look on beat after beat.`,
    fix: { kind: "hint", text: "Keep the blur for the one moment it is designed for; elsewhere keep the footage sharp and put the text where the picture leaves room, or cut to the text on its own. A depth blur the references use throughout goes in the style spec (wants depth-blur, with the ref and time)." },
  }];
}

/** Reading text with a glow (a wide shadow with no offset). */
export function textGlow(model, ctx) {
  const s = scaleOf(model);
  return readingTexts(model).filter((item) => item.shadow && item.shadow.blur >= 12 * s && Math.abs(item.shadow.x ?? 0) <= 3 * s && Math.abs(item.shadow.y ?? 0) <= 3 * s).map((item) => ({
    rule: "text_glow", severity: "warn", itemId: item.id, measured: `glow ${Math.round(item.shadow.blur)} px`, required: "no glow on text",
    message: `${ctx.name(item)} glows, a common generated look that also softens the letters.`,
    fix: { kind: "item", itemId: item.id, properties: { shadow: null } },
  }));
}

// stacked_label: a short text (at most STACK_WORDS words, STACK_CHARS characters, one line) at
// most STACK_RATIO of a display text's size (STACK_DISPLAY px at 1080 or more) right above it:
// the gap under it at most STACK_GAP of the display size, the two overlapping across by half the
// narrower one, both on screen together for STACK_SECONDS. A caption under a title, or a label
// beside or far from it, is left alone.
const STACK_WORDS = 5;
const STACK_CHARS = 40;
const STACK_RATIO = 0.5;
const STACK_DISPLAY = 64;
const STACK_GAP = 0.6;
const STACK_SECONDS = 0.5;

const isCaps = (item) => {
  const value = String(item.text ?? "");
  return item.textCase === "upper" || ((value.match(/\p{L}/gu) ?? []).length >= 2 && value === value.toUpperCase() && value !== value.toLowerCase());
};
const paintKey = (paint) => (typeof paint === "string" ? paint.toLowerCase().slice(0, 7) : null);

/** A small label stacked right above a headline (a kicker or eyebrow), the template title layout. */
export function stackedLabel(model, ctx) {
  const s = scaleOf(model);
  const timed = speechTimed(model);
  const texts = readingTexts(model).filter((item) => !["ui", "logo"].includes(item.role) && !timed.has(item.id));
  const findings = [];
  const flagged = new Set();
  for (const head of texts) {
    if (!(head.fontSize >= STACK_DISPLAY * s)) continue;
    for (const label of texts) {
      if (label === head || flagged.has(label.id) || !(label.fontSize <= STACK_RATIO * head.fontSize)) continue;
      const words = textsOf(label).map(wordCount);
      if (!words.length || Math.max(...words) > STACK_WORDS || textsOf(label).some((text) => text.trim().length > STACK_CHARS)) continue;
      let together = 0;
      let first = -1;
      for (let index = 0; index < model.times.length; index += 1) {
        if (label.samples.opacity[index] < 0.5 || head.samples.opacity[index] < 0.5) continue;
        const [top, under] = [boxAt(label, index), boxAt(head, index)];
        const labelSize = label.fontSize * (label.samples.scale?.[index] ?? 1);
        const headSize = head.fontSize * (head.samples.scale?.[index] ?? 1);
        const gap = under.y0 - top.y1;
        const across = Math.min(top.x1, under.x1) - Math.max(top.x0, under.x0);
        if (top.y1 - top.y0 > 2.2 * labelSize || gap < -0.15 * labelSize || gap > STACK_GAP * headSize) continue;
        if (across < 0.5 * Math.min(top.x1 - top.x0, under.x1 - under.x0)) continue;
        together += 1;
        if (first < 0) first = index;
      }
      if (together / model.fps < STACK_SECONDS) continue;
      flagged.add(label.id);
      const marks = [isCaps(label) && "caps", paintKey(label.fill) && paintKey(label.fill) !== paintKey(head.fill) && "another color"].filter(Boolean);
      findings.push({
        rule: "stacked_label", severity: "warn", itemId: label.id, itemIds: [label.id, head.id], at: sec(model.times[first]),
        measured: `${Math.round(label.fontSize)} px label${marks.length ? ` (${marks.join(", ")})` : ""} over ${Math.round(head.fontSize)} px ${ctx.name(head)}`, required: "no small label stacked over a headline",
        message: `${ctx.name(label)} ("${ctx.quote(label.text)}") sits right above ${ctx.name(head)}: a small label stacked over a headline (a kicker or eyebrow) reads as a template.`,
        fix: { kind: "delete_item", itemId: label.id },
      });
    }
  }
  return findings;
}
