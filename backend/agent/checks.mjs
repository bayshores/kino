// `check`: problems an agent can fix, each with a ready-made fix. This file has the render
// checks (missing media and fonts, empty text, off-canvas layers, animations past the scene's
// end) and the reports; the quality gates and warnings (plan §4.3 and §4.4) are in
// engine/quality/, run through server/agent/quality.mjs.
//
// Every finding: { severity: "error" | "warn" | "info", rule, ref, at?, message, fix?, auto?, waived? }.
// `fix` is an edit operation, a list of them, or a short instruction when no operation fixes it.
// `auto` marks a fix that check {fix:"auto"} applies. `waived` is the reason of a waiver.
import { existsSync } from "node:fs";
import path from "node:path";
import { evaluateLayer } from "../../engine/animation.js";
import { documentTextLayers } from "../../engine/fontDocuments.js";
import { documentGlyphProblems, layerGlyphProblems } from "../../engine/fontGlyphReferences.js";
import { missingDocumentFonts } from "../../engine/fontRecovery.js";
import { RULES } from "../../engine/quality/index.js";
import { mediaIdFromSource } from "../../engine/replaceMedia.js";
import { animationSpan, layerAnimations, refName, sec } from "./describe.mjs";
import { missingGlyphsHelp } from "./font-help.mjs";

export const MAX_FINDINGS = 10;
const MEDIA_TYPES = new Set(["image", "video", "audio"]);
const MOVING = new Set(["x", "y", "width", "height", "scaleX", "scaleY", "rotation"]);

// True when the layer's media will not draw: an imported file that is gone, or a source that is
// neither an imported file (/api/media/…) nor an embedded image (data:…), such as "logo.png".
function mediaMissing(layer, mediaRoot) {
  if (!MEDIA_TYPES.has(layer.type) || typeof layer.src !== "string" || !layer.src) return false;
  if (!/^(\/api\/media\/|data:)/i.test(layer.src)) return true;
  const id = mediaIdFromSource(layer.src);
  if (!id) return false; // Data URLs and frame and poster addresses are checked by the renderer.
  return !existsSync(path.join(mediaRoot, `${id}.json`));
}

// True for a shown image or video layer with no src at all: drawing it stops renders and the
// contrast check. (An audio layer with no src only plays nothing.)
function sourceBlank(layer) {
  return (layer.type === "image" || layer.type === "video") && layer.visible !== false && !String(layer.src ?? "").trim();
}

// True when the layer's box never meets the scene: it rests outside and nothing moves it.
function alwaysOffCanvas(layer, scene) {
  if (layer.parentId || layer.type === "audio" || layer.type === "group") return false;
  const moves = layerAnimations(layer).some(({ animation }) =>
    [...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})].some((key) => MOVING.has(key)) || animation.motionPath);
  if (moves) return false;
  let at;
  try { at = evaluateLayer(layer, 0); } catch { return false; }
  const width = Math.abs(at.width * (at.scaleX ?? 1));
  const height = Math.abs(at.height * (at.scaleY ?? 1));
  return at.x + width <= 0 || at.y + height <= 0 || at.x >= scene.width || at.y >= scene.height;
}

/** Runs every rule on one document. `fonts` is the project's font registry. */
export function checkDocument(document, { fonts, mediaRoot, codes, sceneId } = {}) {
  const findings = [];
  const name = (id) => refName(id, codes);
  const scenes = document.scenes.filter((scene) => !sceneId || scene.id === sceneId);

  for (const scene of scenes) {
    for (const layer of scene.layers) {
      if (mediaMissing(layer, mediaRoot))
        findings.push({ severity: "error", rule: "missing_media", ref: name(layer.id),
          message: `${name(layer.id)} uses media that is not in this workspace, so it renders empty.`,
          fix: "Import the file again (project import) and set the layer's src, or delete the layer." });
      if (sourceBlank(layer))
        findings.push({ severity: "error", rule: "missing_media", ref: name(layer.id),
          message: `${name(layer.id)} is ${layer.type === "image" ? "an" : "a"} ${layer.type} layer with no src (no media file), so it cannot be drawn.`,
          fix: "Import the file (project import) and set the layer's src to the /api/media/... address it answers, or delete the layer." });
      if (layer.type === "text" && !String(layer.text ?? "").trim() && layer.visible !== false)
        findings.push({ severity: "warn", rule: "empty_text", ref: name(layer.id),
          message: `${name(layer.id)} is a text layer with no text.`,
          fix: { op: "delete_layer", layerId: name(layer.id) } });
      if (layer.visible !== false && alwaysOffCanvas(layer, scene))
        findings.push({ severity: "warn", rule: "off_canvas", ref: name(layer.id),
          message: `${name(layer.id)} sits outside the ${scene.width}×${scene.height} scene and never moves in, so it is never seen.`,
          fix: { op: "update_layer", layerId: name(layer.id), properties: { x: Math.round((scene.width - layer.width) / 2), y: Math.round((scene.height - layer.height) / 2) } } });
      for (const { animation, offset } of layerAnimations(layer)) {
        // Members of animation groups are checked one by one; the group itself only spans them.
        if (animation.kind === "composed" || animation.enabled === false || ["hide", "show"].includes(animation.kind)) continue;
        const [start, end] = animationSpan(animation, offset);
        if (end > scene.duration + 0.001) {
          const duration = sec(Math.max(0.05, scene.duration - start));
          findings.push({ severity: start >= scene.duration ? "error" : "warn", rule: "past_scene_end", ref: name(animation.id), at: start,
            message: `${name(animation.id)} runs ${start}–${end}s but ${name(scene.id)} ends at ${sec(scene.duration)}s${start >= scene.duration ? ", so it never plays" : ", so it is cut off"}.`,
            fix: start < scene.duration
              ? { op: "update_animation", animationId: name(animation.id), properties: { duration } }
              : { op: "update_scene", sceneId: name(scene.id), properties: { duration: sec(end) } } });
        }
      }
    }
  }

  if (fonts) {
    const scoped = { ...document, scenes };
    for (const font of missingDocumentFonts(scoped, fonts)) {
      const layers = [...new Set(font.locations.map((site) => name(site.layerId)))];
      findings.push({ severity: "warn", rule: "missing_font", ref: layers[0],
        message: `${font.fontFamily} ${font.fontWeight} ${font.fontStyle} is not installed; ${layers.length} layer${layers.length === 1 ? "" : "s"} draw with ${font.fallbackFamily || "a fallback font"} (${layers.slice(0, 5).join(", ")}${layers.length > 5 ? ", …" : ""}).`,
        fix: { op: "set_font", layerIds: layers, family: font.fontFamily, weight: font.fontWeight } });
    }
    for (const problem of documentGlyphProblems(scoped, fonts))
      findings.push({ severity: "warn", rule: "missing_glyphs", ref: name(problem.layerId),
        message: `${name(problem.layerId)} has characters its font lacks (${problem.glyphs.slice(0, 5).map((glyph) => JSON.stringify(glyph.text)).join(", ")}); they render as boxes.`,
        fix: "Choose a font that has these characters (set_font), or change the text." });
  }

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return findings;
}

/**
 * Each missing_glyphs warning (up to MAX_FINDINGS) then names fonts that have its characters
 * (glyphs checked, see font-help.mjs), and its fix becomes the update_layer op that draws just
 * those characters in the first of them. This looks fonts up and may download a catalog
 * subset, so check runs it after the findings are made. Changes `findings` in place.
 */
export async function explainMissingGlyphs(findings, document, { fonts, catalog, codes } = {}) {
  const wanted = findings.filter((finding) => finding.rule === "missing_glyphs" && !finding.waived).slice(0, MAX_FINDINGS);
  if (!wanted.length) return;
  const layers = documentTextLayers(document);
  for (const finding of wanted) {
    const layer = layers.find((entry) => refName(entry.id, codes) === finding.ref);
    const characters = layer ? [...new Set(layerGlyphProblems(layer, fonts).map((glyph) => glyph.text))] : [];
    if (!characters.length) continue;
    const help = await missingGlyphsHelp({ layer, layerRef: finding.ref, characters, fonts, catalog });
    if (help.message) finding.message = `${finding.message} ${help.message}`;
    finding.fix = help.fix;
  }
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

/**
 * The render checks and the quality findings together: waivers applied to the render checks
 * (the quality findings come with theirs), errors first, then warnings, then info.
 */
export function mergeFindings(basic, quality, { document, codes } = {}) {
  const waivers = document?.checkWaivers ?? [];
  const waived = basic.map((finding) => {
    const waiver = waivers.find((entry) => entry.code === finding.rule && (entry.target === "*" || refName(entry.target, codes) === finding.ref));
    return waiver ? { ...finding, waived: waiver.reason } : finding;
  });
  // A rendered check that stopped on media the render checks already report as missing adds nothing.
  const missing = basic.some((finding) => finding.rule === "missing_media");
  const shown = missing ? quality.filter((finding) => !(finding.internal && /must use \/api\/media|has no src/.test(finding.message))) : quality;
  return [...waived, ...shown].map((finding, index) => ({ finding, index }))
    .sort((a, b) => (SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]) || a.index - b.index)
    .map(({ finding }) => finding);
}

/** Errors, warnings and info findings that count (not waived), and how many are waived. */
export function checkCounts(findings) {
  const counted = findings.filter((finding) => !finding.waived);
  return {
    errors: counted.filter((finding) => finding.severity === "error").length,
    warnings: counted.filter((finding) => finding.severity === "warn").length,
    info: counted.filter((finding) => finding.severity === "info").length,
    waived: findings.length - counted.length,
  };
}

// The findings an agent should read: not waived, and not info (blips of 2 samples or less).
const shownFindings = (findings) => findings.filter((finding) => !finding.waived && finding.severity !== "info");

// The gates that need rendered frames (contrast, flashing, luma_jump, frozen_picture).
const PIXEL_GATES = RULES.filter((rule) => rule.pixels && rule.level === "error").map((rule) => rule.code).join(", ");

// "0 err · 2 warn (past_scene_end hero-title.in, missing_font L4)". Status, edit receipts and dry
// runs do not render frames, so their counts leave out the pixel gates unless check ran on the
// scene since it last changed; `unchecked` ("all", or the names of some scenes) names them.
/**
 * check {fix:"auto"}'s "rule ref: reason" lines, one per rule and reason: "exit_ratio d1-time,
 * d2-time +12: still adds an error after 3 tries". A first pass got 42 such lines and spent
 * three calls cutting them down to one a rule.
 */
export function groupFixLines(lines, shown = 4) {
  const groups = new Map();
  for (const line of lines) {
    const match = /^(\S+) (\S+?)(?:: (.*))?$/.exec(line);
    const key = match ? `${match[1]}\n${match[3] ?? ""}` : `\n${line}`;
    if (!groups.has(key)) groups.set(key, { rule: match?.[1], reason: match?.[3], refs: [], line });
    if (match && !groups.get(key).refs.includes(match[2])) groups.get(key).refs.push(match[2]);
  }
  return [...groups.values()].map(({ rule, reason, refs, line }) => !rule ? line
    : `${rule} ${refs.slice(0, shown).join(", ")}${refs.length > shown ? ` +${refs.length - shown}` : ""}${reason ? `: ${reason}` : ""}`);
}

export function checkSummary(findings, { unchecked = [] } = {}) {
  const counts = checkCounts(findings);
  const top = shownFindings(findings).slice(0, 2).map((finding) => `${finding.rule} ${finding.ref}`).join(", ");
  const where = unchecked === "all" ? "" : unchecked.length > 3 ? ` in ${unchecked.slice(0, 3).join(", ")} +${unchecked.length - 3}` : ` in ${unchecked.join(", ")}`;
  const left = unchecked === "all" || unchecked.length ? ` · unchecked${where}: ${PIXEL_GATES}` : "";
  return `${counts.errors} err · ${counts.warnings} warn${counts.waived ? ` · ${counts.waived} waived` : ""}${top ? ` (${top})` : ""}${left}`;
}

export const CHECK_RULES = "Rules: render checks (missing_media, empty_text, off_canvas, past_scene_end, missing_font, missing_glyphs), gates that block a final render (linear_motion, reading_time, type_min, overlap, safe_zone, contrast, flashing, luma_jump, frozen_picture, assertions, spring_on_fade, same_motion, promo_basics; av_offset after it), and warnings (in a real edit, a brief and 30+ layers, each also blocks a final render until fixed or waived); advice (info) never blocks. library {topic:\"rules\", name:\"quality\"} explains each.";

// {rule: {errors, warnings}} for the findings that count (not waived, not info), for
// --json readers and the eval runner; MCP answers carry only the text.
function countsByRule(findings) {
  const counts = {};
  for (const finding of findings) {
    if (finding.waived || !["error", "warn"].includes(finding.severity)) continue;
    const row = (counts[finding.rule] ??= { errors: 0, warnings: 0 });
    if (finding.severity === "error") row.errors += 1;
    else row.warnings += 1;
  }
  return counts;
}

// Warnings about what the person asked for (the brief's style spec, the brand, their own words):
// listed right after the gates, so they are not lost under many small warnings.
export const BRIEF_RULES = new Set(["style_avoided", "style_wanted", "off_brand_font", "own_words", "deck_unused", "brand_consistency", "vocabulary_budget", "role_font_drift", "busy_edit"]);
// At most this many findings of one rule are listed, so the list shows many rules.
const PER_RULE = 2;

/**
 * The findings to list, triaged: gates first, then warnings tied to the brief, then the rest,
 * at most PER_RULE of a rule, up to `limit`. `left` counts the rest by rule ("held_static 30, hold 20").
 */
export function triageFindings(shown, limit = MAX_FINDINGS) {
  const tier = (finding) => (finding.severity === "error" ? 0 : BRIEF_RULES.has(finding.rule) ? 1 : 2);
  const ordered = shown.map((finding, index) => ({ finding, index })).sort((a, b) => tier(a.finding) - tier(b.finding) || a.index - b.index).map(({ finding }) => finding);
  const listed = [];
  // Tier by tier, so every gate is listed before any warning: first at most PER_RULE of a rule,
  // then, with room left (few rules), more of the same rules in order.
  for (const level of [0, 1, 2]) {
    const inTier = ordered.filter((finding) => tier(finding) === level);
    const perRule = {};
    for (const finding of inTier) {
      if (listed.length >= limit || (perRule[finding.rule] ?? 0) >= PER_RULE) continue;
      perRule[finding.rule] = (perRule[finding.rule] ?? 0) + 1;
      listed.push(finding);
    }
    for (const finding of inTier) if (listed.length < limit && !listed.includes(finding)) listed.push(finding);
  }
  listed.sort((a, b) => ordered.indexOf(a) - ordered.indexOf(b));
  const left = {};
  for (const finding of ordered) if (!listed.includes(finding)) left[finding.rule] = (left[finding.rule] ?? 0) + 1;
  // Rules tied to the brief first, so they are named even when the list is full of gates.
  const rows = Object.entries(left).sort((a, b) => BRIEF_RULES.has(b[0]) - BRIEF_RULES.has(a[0]) || b[1] - a[1]);
  const text = rows.slice(0, 8).map(([rule, count]) => `${rule} ${count}`).join(", ") + (rows.length > 8 ? `, +${rows.length - 8} rules` : "");
  return { listed, more: shown.length - listed.length, left: text };
}

// "rule xN" by rule, the most first: "busy_edit x3, pacing_jump".
const byRuleLine = (list, { first = false } = {}) => {
  const rows = new Map();
  for (const finding of list) {
    const row = rows.get(finding.rule) ?? { count: 0, ref: finding.ref };
    row.count += 1;
    rows.set(finding.rule, row);
  }
  return [...rows].sort((a, b) => b[1].count - a[1].count)
    .map(([rule, { count, ref }]) => `${rule}${count > 1 ? ` x${count}` : ""}${first && ref != null ? ` (${ref})` : ""}`);
};

/** Advice (info findings, not waived) in one line, or "": "busy_edit x2, pacing_jump". */
export const adviceLine = (findings) => byRuleLine(findings.filter((finding) => !finding.waived && finding.severity === "info")).join(", ");

/**
 * What still holds a final render: one line per rule with its count and first target
 * ("hold x2 (say4)"), errors first. Empty when nothing is open.
 */
export function openFindingLines(findings) {
  const open = findings.filter((finding) => !finding.waived && (finding.severity === "error" || finding.severity === "warn"));
  return [...byRuleLine(open.filter((finding) => finding.severity === "error"), { first: true }), ...byRuleLine(open.filter((finding) => finding.severity === "warn"), { first: true })];
}

// More waivers than this for one rule in a project and the rule is likely wrong, not the video.
export const WAIVER_LIMIT = 5;
// Rules whose waiver keeps a crop kino cannot see into: a mark made after a look clears them instead.
const CROP_WAIVERS = new Set(["narrow_window", "head_cut_off", "crop_no_subject"]);
/** A note for each rule waived more than WAIVER_LIMIT times (document.checkWaivers), or []. `codes` keeps only those rules. */
export function waiverNotes(waivers = [], { codes = null } = {}) {
  const counts = {};
  for (const waiver of waivers) if (waiver?.code && (!codes || codes.includes(waiver.code))) counts[waiver.code] = (counts[waiver.code] ?? 0) + 1;
  return Object.entries(counts).filter(([, count]) => count > WAIVER_LIMIT)
    .map(([code, count]) => CROP_WAIVERS.has(code)
      ? `${code} is waived ${count} times here: each keeps a crop kino cannot see into; a mark after look {mode:"source"} clears it, and every stop shows the count.`
      : `${code} is waived ${count} times here: likely a kino false positive, not taste. Tell the kino maintainers what it flagged and why it was right.`);
}

/** The waivers that still count: all but the stale ones (a full check's `stale`, quality.mjs staleWaivers). */
export const liveWaivers = (waivers = [], stale = []) => waivers.filter((waiver) => !stale.includes(waiver));

/** One line naming the stale waivers (their rule no longer fires) and the call that drops one, or "". */
export function staleWaiverLine(stale = [], nameOf = (id) => id) {
  if (!stale.length) return "";
  const named = stale.map((waiver) => `${waiver.code} ${nameOf(waiver.target)}`);
  const [first] = stale;
  return `stale waivers (nothing left to waive): ${named.slice(0, 4).join(", ")}${named.length > 4 ? ` +${named.length - 4}` : ""}. Drop each: edit unwaive_check {code:"${first.code}", target:"${nameOf(first.target)}"}.`;
}

// info: true lists advice too (a check that names its rules asked for them).
export function checkReport(findings, { limit = MAX_FINDINGS, info = false } = {}) {
  const shown = info ? findings.filter((finding) => !finding.waived) : shownFindings(findings);
  const { listed, more, left } = triageFindings(shown, limit);
  const advice = adviceLine(findings);
  return {
    ...checkCounts(findings),
    findings: listed,
    ...(more ? { more, moreByRule: left } : {}),
    ...(advice ? { advice } : {}),
    autoFixes: shown.filter((finding) => finding.auto).length,
    byRule: countsByRule(findings),
    waivedFindings: findings.filter((finding) => finding.waived).map((finding) => ({ rule: finding.rule, ref: finding.ref, reason: finding.waived })),
    rules: CHECK_RULES,
  };
}
