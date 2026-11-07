// Consistency rules: does the video keep to one voice from start to end? They read the model only
// (no render), so they are cheap enough for every edit receipt.
//
//   role_font_drift    one family per text role, and one size for captions and speech
//   vocabulary_budget  with style.moves, no designed technique outside them (how many devices and
//                      text looks an edit may use is busy_edit's job, engine/quality/rules/restraint.js)
//   brand_consistency  one logo treatment, shown at most twice
//   story_stall        no long stretch mid-video of a near-black frame with no picture
//   hook_readable      the first 3 s show big readable type or a clear picture
//   text_only_open     a promo's first 4 s are not text with no picture for over 3 s
//   accent_budget      the style bible's accent stays within its share of the frame
//   pacing_jump        the cut rate changes 3x only at a music or story turn
//   ending_count       a payoff and an end card, no more closing beats
//   overlay_covers_subject  nothing drawn over the subject marked with mark_subject (gate)
//
// With a style bible (style.fonts, accent, logo, moves; engine/styleSpec.js) role_font_drift and
// brand_consistency hold the timeline to it. The limits came from an audit of one trailer, and
// they flagged its designed moments (a serif pull quote, a map, a second payoff) as defects, so
// every one of them warns and none blocks a render (TASTE_WARNINGS below): a warning is a
// question for the taste judge and the person, not a gate. A deliberate choice is waived with
// waive_check {code, target, reason}.
import { CUT_TIMING_TAGS, PLAIN_TAGS } from "../../techniques.js";
import { cuts, drawnSize, readableAt, readingTexts, sec, typeLimits } from "../analysis.js";
import { area, chainOf, fillColorsAt, hexRgba, intersection, isDecor, isGradient, longestRun, runs, visibleBoxAt } from "../model.js";
import { mediaFrameState, mediaPlaybackRange } from "../../playback.js";
import { subjectOnScene } from "../../sourceView.js";
import { boxNear } from "./footage.js";
import { blurred, peopleSubjects } from "./people.js";
import { safeRect } from "./layout.js";
import { backgroundLuma, coveredAt, plateChanges, plates, techniquesUsed } from "../techniques.js";

// The rules (and spine_drift's second-payoff line) that only ever warn. Inside a signature range
// (a spine beat with role "signature", or style.signatures[].at) engine/quality/index.js drops them.
export const TASTE_WARNINGS = Object.freeze(["role_font_drift", "vocabulary_budget", "story_stall", "accent_budget", "ending_count", "brand_consistency", "hook_readable", "text_only_open"]);
// True when a time (s) is inside a signature range. The rules that sum over the whole video
// (vocabulary_budget, role_font_drift) leave out what happens inside, so one designed moment
// there does not hide the same problem elsewhere.
const inSignature = (ctx, at) => (ctx.style?.signatureRanges ?? []).some(({ from, to }) => at >= from && at <= to);

const FRAME = (model) => ({ x0: 0, y0: 0, x1: model.width, y1: model.height });
// False for no fill or a fully see-through one (an outline drawn with a stroke only).
const paintShows = (fill) => Boolean(fill) && (typeof fill !== "string" || (hexRgba(fill)?.[3] ?? 255) > 0);
const frameShare = (model, item, index) => area(intersection(visibleBoxAt(model, item, index), FRAME(model))) / (model.width * model.height);
const familyKey = (family) => String(family || "Inter").trim().toLowerCase();
// A title card or logo sting shorter than this is one moment, not an edit (as in style.js).
const EDIT_SECONDS = 8;

// ---------------------------------------------------------------- role_font_drift

// Sizes in one role further apart than this read as two styles (the audit's "about 15%").
const SIZE_SPREAD = 0.15;
// A short small text (this many words or fewer) with no quote marks is a label, not a caption.
const LABEL_WORDS = 3;
// A straight apostrophe opens a quote only when one closes the line ('90s is not speech).
const QUOTED = /^\s*(["“‘«]|'(?=.*'[.!?…]*\s*$))/;
// A number with an optional sign, currency and unit: "40%", "$1.2M", "3.2x", "+120 ms", "24/7".
const STAT = /^\s*[+\-−~≈]?\s*[$€£¥]?\s*\d[\d.,:/]*\s*(%|x|×|k|m|bn|ms|s|h|min|fps|px|gb|mb|tb|km|kg|\+)?\s*$/i;
// A line that leads with a number ("3x faster", "40% less time").
const LEADS_WITH_NUMBER = /^\s*[+\-−~≈]?\s*[$€£¥]?\s*\d/;
const brandFamilies = (ctx) => (ctx.brandFonts ?? []).map((font) => (typeof font === "string" ? font : font?.family)).filter(Boolean);

/**
 * The text role a reading text plays: display (big type), speech (a quoted line someone says),
 * caption (small sentences), label (a few small words, or unmarked text under the body minimum:
 * the copy of a mock screen), subhead or body (marked so) or stat (a big number: a counter, or digits
 * with a unit like "40%" or "3.2x"; with `statFamily`, the style bible's stat
 * face, a big line in that face that leads with a number, like "3x faster"). The layer's role
 * counts where it fits its size: a 120 px text marked caption is display type.
 */
export function typeRole(model, item, statFamily = null) {
  // Product UI text (role ui) is set in the product's own font, not the edit's.
  if (["logo", "decor", "background", "ui"].includes(item.role)) return null;
  // At the headline minimum or bigger (64 px at 1080p, 90 in 9:16) it is display type: a
  // caption that big is a title, whatever its role says.
  const big = drawnSize(model, item) >= typeLimits(model).headline;
  // A big number is its own role: stats are often set in another face than the titles.
  if (big && (item.counter || STAT.test(item.text))) return "stat";
  if (big && statFamily && LEADS_WITH_NUMBER.test(item.text) && familyKey(item.fontFamily) === familyKey(statFamily)) return "stat";
  if (item.counter) return null;
  if (item.role === "subhead") return "subhead";
  if (big || ["headline", "hero"].includes(item.role)) return "display";
  if (QUOTED.test(item.text)) return "speech";
  if (item.role === "label" || item.role === "cta") return "label";
  // Body copy (a safety note, a card's paragraph) is its own role: it keeps its own size.
  if (item.role === "body") return "body";
  if (item.role === "caption") return "caption";
  if (drawnSize(model, item) < typeLimits(model).body) return "label";
  return item.text.trim().split(/\s+/).length <= LABEL_WORDS ? "label" : "caption";
}

const mostUsed = (list, key) => {
  const counts = new Map();
  for (const item of list) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
};

// Roles a video may speak in several voices (a judge, a person, the product, the brand), each
// with its own face and size.
const VOICED_ROLES = ["caption", "speech"];

/**
 * The voice a caption or spoken line belongs to: its caption track (an add_captions group: the
 * outermost group whose name starts the text's name), else its color. Two voices may differ in
 * face and size; inside one voice the role stays one face and one size.
 */
export function voiceOf(model, item) {
  const top = chainOf(model, item).at(-1);
  if (top !== item && top.kind === "group" && String(item.name ?? "").startsWith(`${top.name}-`)) return `track ${top.name}`;
  if (typeof item.fill !== "string") return "no color";
  // One color however it is written (#FFF and #ffffff, any alpha): #rrggbb.
  const rgba = hexRgba(item.fill);
  return rgba ? `#${rgba.slice(0, 3).map((channel) => channel.toString(16).padStart(2, "0")).join("")}` : item.fill.trim().toLowerCase();
}

export function roleFontDrift(model, ctx) {
  const voiced = {};
  for (const item of readingTexts(model)) {
    // A wordmark (a text named logo, or the bible's logo) is brand_consistency's, not a role's.
    if (isLogo(item, ctx.style?.logo?.asset) || inSignature(ctx, firstShown(model, item))) continue;
    // With a quote face (style.fonts.quote), a quoted line in it is a quote at any size.
    const quoteFace = ctx.style?.fonts?.quote?.family;
    const role = quoteFace && QUOTED.test(item.text) && familyKey(item.fontFamily) === familyKey(quoteFace)
      ? "quote" : typeRole(model, item, ctx.style?.fonts?.stat?.family);
    if (!role) continue;
    const voice = VOICED_ROLES.includes(role) ? voiceOf(model, item) : "";
    ((voiced[role] ??= {})[voice] ??= []).push(item);
  }
  // One group per role and voice; the role's main voice (the most texts) keeps the style bible's
  // face and size, another voice only stays true to itself.
  const groups = Object.entries(voiced).flatMap(([role, voices]) => Object.entries(voices)
    .sort((a, b) => b[1].length - a[1].length).map(([voice, all], index, list) => ({ role, all, voice: list.length > 1 ? voice : "", main: index === 0 })));
  const findings = [];
  for (const { role, all, voice, main } of groups) {
    // The style bible's face for the role (style.fonts; speech uses the quote face, else the
    // caption face), else the role's most used family. Against the bible one text can drift; it
    // warns (a second face with a job, a pull quote, is a choice the taste judge and the person weigh).
    const bibleRole = role === "speech" ? (ctx.style?.fonts?.quote ? "quote" : "caption") : role;
    const bible = main ? ctx.style?.fonts?.[bibleRole] ?? null : null;
    const roleName = voice ? `${role} (voice ${voice})` : role;
    const severity = "warn";
    // Labels belong to what they draw (a mock screen's UI font, a terminal's mono): no voice to
    // keep, unless the bible names a label face; then the texts marked label or cta keep it.
    const items = role === "label" ? (bible ? all.filter((item) => item.role === "label" || item.role === "cta") : []) : all;
    if (items.length < (bible ? 1 : 2)) continue;
    const brand = brandFamilies(ctx).map(familyKey);
    const families = new Map();
    for (const item of items) {
      const key = familyKey(item.fontFamily);
      if (!families.has(key)) families.set(key, { family: item.fontFamily || "Inter", items: [] });
      families.get(key).items.push(item);
    }
    // Display type in the brand's own pair (a serif headline over a sans one) is a choice.
    const brandPair = role === "display" && !bible && [...families.keys()].every((key) => brand.includes(key));
    if (!brandPair && (families.size > 1 || (bible?.family && !families.has(familyKey(bible.family))))) {
      // Keep the bible's family, else the most used one the brand allows (off_brand_font agrees).
      const ranked = [...families.values()].sort((a, b) => b.items.length - a.items.length);
      const keep = bible?.family ?? (ranked.find((entry) => brand.includes(familyKey(entry.family))) ?? ranked[0]).family;
      const off = items.filter((item) => familyKey(item.fontFamily) !== familyKey(keep));
      findings.push({
        rule: "role_font_drift", severity, itemId: off[0].id, itemIds: off.map((item) => item.id), at: sec(firstShown(model, off[0])),
        measured: `${roleName} in ${[...families.values()].map((entry) => `${entry.family} ×${entry.items.length}`).join(", ")}`, required: `${bible ? `the style bible's ${bible.family}` : "one family"} for ${roleName} text`,
        message: `${roleName} text uses ${families.size} families: ${off.slice(0, 3).map((item) => ctx.name(item)).join(", ")}${off.length > 3 ? ` +${off.length - 3}` : ""} differ from ${keep}. One family per role keeps the video one voice.`,
        fix: { kind: "font", itemIds: off.map((item) => item.id), family: keep, nearest: true, auto: true, why: `${roleName} text in ${keep}` },
      });
    }
    // Display type may step in size (a title and its kicker), and labels and stats too; captions
    // and speech may not. Against the bible's display or label size, a text off it is a warning
    // (display text beside one at that size is its kicker).
    if (role === "subhead" || role === "stat" || role === "quote" || (role === "label" && !bible?.size) || (role === "display" && !bible?.size)) continue;
    const sizes = items.map((item) => drawnSize(model, item));
    const [common] = mostUsed(items, (item) => Math.round(drawnSize(model, item)));
    const target = bible?.size ?? common;
    const near = (index) => Math.abs(sizes[index] - target) / target <= SIZE_SPREAD;
    const onSize = items.filter((item, index) => near(index));
    const besideOnSize = (item) => onSize.some((other) => other !== item && model.times.some((time, at) => item.samples.opacity[at] > 0.3 && other.samples.opacity[at] > 0.3));
    const odd = items.filter((item, index) => !near(index) && !(role === "display" && besideOnSize(item)));
    if (odd.length) findings.push({
      rule: "role_font_drift", severity, itemId: odd[0].id, itemIds: odd.map((item) => item.id), at: sec(firstShown(model, odd[0])),
      measured: `${roleName} at ${[...new Set(sizes.map(Math.round))].join(", ")} px`, required: `${bible?.size ? `the style bible's ${bible.size} px` : "one size"} for ${roleName} text (within ${Math.round(SIZE_SPREAD * 100)}%)`,
      message: `${odd.slice(0, 3).map((item) => ctx.name(item)).join(", ")} ${odd.length === 1 ? "is" : "are"} ${roleName} text at another size than ${bible?.size ? `the style says (${bibleRole} ${Math.round(target)} px)` : `the others (${Math.round(target)} px)`}.`,
      fix: { kind: "hint", text: `Set fontSize ${Math.round(target)} on ${odd.slice(0, 4).map((item) => ctx.name(item)).join(", ")} (update_layer)${bible?.size ? `, or change style.fonts.${bibleRole}.size (notes brief)` : ""}, or give a title the role headline.` },
    });
  }
  return findings;
}

const firstShown = (model, item) => model.times[Math.max(0, item.samples.opacity.findIndex((value) => value > 0.3))];

// ---------------------------------------------------------------- vocabulary_budget

// With a style bible's moves (style.moves), the designed techniques outside them (and its wants).
// How many devices and text looks an edit uses, at any length, is busy_edit's (restraint.js):
// this rule used to count them too, with a looser limit, so a busy edit got the same advice twice.
export function vocabularyBudget(model, ctx) {
  if (model.duration < EDIT_SECONDS) return [];
  const moves = ctx.style?.moves ?? null;
  if (!moves) return [];
  // Uses inside a signature range are the designed moment: not counted.
  const used = Object.fromEntries(Object.entries(techniquesUsed(model))
    .map(([tag, uses]) => [tag, uses.filter((use) => !inSignature(ctx, use.at))]).filter(([, uses]) => uses.length));
  // The style bible's moments (style.moments) are designed one-off set pieces: not counted.
  const moments = new Set((ctx.style?.moments ?? []).map((moment) => moment.tag));
  const outside = Object.keys(used).filter((tag) => !PLAIN_TAGS.includes(tag) && !CUT_TIMING_TAGS.includes(tag) && !moments.has(tag))
    .filter((tag) => !moves.includes(tag) && !(ctx.style.wants ?? []).includes(tag))
    .sort((a, b) => used[b].length - used[a].length);
  if (!outside.length) return [];
  return [{
    rule: "vocabulary_budget", severity: "warn", at: sec(Math.min(...outside.map((tag) => used[tag][0]?.at ?? 0))),
    measured: `outside the moves: ${outside.map((tag) => `${tag} ×${used[tag].length}`).join(", ")}`, required: `only the style bible's moves (${moves.join(", ")})`,
    message: `${ctx.sceneName} uses ${outside.join(", ")}, which the style bible's moves do not name.`,
    fix: { kind: "hint", text: `Leave it if it is a designed one-off moment; if it recurs, add it to style.moves (notes brief).` },
  }];
}

// ---------------------------------------------------------------- brand_consistency

// A brand mark shown more often than this stops being a signature (the payoff and the end card).
const LOGO_PLACEMENTS = 2;
const LOGO_NAME = /(^|[-_ .])(logo|logomark|wordmark|brand-?mark)([-_ .\d]|$)|(^|[-_ ])mark$/i;
// A picture named icon is the app's icon: in a product video, the brand mark.
// Marks that are not a brand: a check mark, a question mark.
const NOT_LOGO = /(check|tick|question|exclamation|quote|quotation|book|water|bench|land|trade|hall)[-_ ]?mark/i;
const ICON_NAME = /(^|[-_ ])(app-?)?icon$/i;
// Gaps shorter than this between two showings are one placement (a blink, a re-cut).
const SAME_PLACEMENT = 0.5;

// The style bible's logo (style.logo.asset) is a layer name or a file: layers so named or drawn
// from that file are the logo too.
const isBibleLogo = (item, asset) => Boolean(asset) && [item.name, item.src].some((value) => typeof value === "string" && value.toLowerCase() === asset.toLowerCase()
  || (typeof value === "string" && value.includes("/") && value.toLowerCase().endsWith(`/${asset.toLowerCase().split("/").pop()}`)));
const isLogo = (item, asset = null) => item.kind !== "group" && item.kind !== "audio"
  && (isBibleLogo(item, asset) || item.role === "logo" || (LOGO_NAME.test(item.name ?? "") && !NOT_LOGO.test(item.name ?? "")) || (item.kind === "image" && ICON_NAME.test(item.name ?? "")));

// How shown a logo is at a sample. A logo-shaped mask is a logo too (footage seen through the
// mark): it shows while what it masks does.
function logoOpacity(model, item, index) {
  if (!item.isMask) return coveredAt(model, item, index) ? 0 : item.samples.opacity[index];
  return Math.max(0, ...model.items.filter((other) => other.maskId === item.id && !coveredAt(model, other, index)).map((other) => other.samples.opacity[index]));
}

// What makes two logo layers look different: the file or the drawing, a glow, and an outline
// drawn in place of a fill. A color swap (a dark mark on a light card) and a reveal mask are the
// same mark: viewers read them as one.
function logoLook(item, ctx) {
  // The raw layer (ctx.scene) holds the drawing: a path's points, a stroke.
  const layer = ctx.scene?.layers?.find((entry) => entry.id === item.source?.layerId) ?? {};
  const shape = item.src ?? (item.kind === "text" ? `${familyKey(item.fontFamily)}|${String(item.text).trim().toLowerCase()}` : JSON.stringify(layer.path ?? layer.points ?? layer.d ?? item.kind));
  const glow = item.shadow?.blur > 8 ? "glow" : "";
  const outline = !paintShows(item.fill) && layer.strokeWidth > 0 ? "outline" : "";
  return `${shape}|${outline}|${glow}`;
}

export function brandConsistency(model, ctx) {
  // The style bible's logo: its asset, and its most placements (a gate when set).
  const bible = ctx.style?.logo ?? null;
  const most = bible?.max ?? LOGO_PLACEMENTS;
  const logos = model.items.filter((item) => isLogo(item, bible?.asset) && model.times.some((time, index) => logoOpacity(model, item, index) > 0.3));
  if (!logos.length) return [];
  // Each logo's showings, merged across layers.
  const shows = [];
  for (const item of logos) {
    let from = -1;
    for (let index = 0; index <= model.times.length; index += 1) {
      const on = index < model.times.length && logoOpacity(model, item, index) > 0.3;
      if (on && from < 0) from = index;
      if (!on && from >= 0) { shows.push({ item, at: model.times[from], until: model.times[index - 1] }); from = -1; }
    }
  }
  shows.sort((a, b) => a.at - b.at);
  const placements = [];
  for (const show of shows) {
    const last = placements.at(-1);
    if (last && show.at - last.until <= SAME_PLACEMENT) { last.until = Math.max(last.until, show.until); last.items.add(show.item); }
    else placements.push({ at: show.at, until: show.until, items: new Set([show.item]) });
  }
  const looks = new Map();
  for (const item of logos) {
    const look = logoLook(item, ctx);
    if (!looks.has(look)) looks.set(look, []);
    looks.get(look).push(item);
  }
  const findings = [];
  if (looks.size > 1) {
    const groups = [...looks.values()];
    findings.push({
      rule: "brand_consistency", severity: "warn", itemId: groups[1][0].id, at: sec(placements.find((entry) => entry.items.has(groups[1][0]))?.at ?? 0),
      measured: `${looks.size} logo treatments (${groups.map((group) => group.map((item) => ctx.name(item)).join("+")).join(", ")})`, required: "one logo asset and treatment",
      message: `The logo appears in ${looks.size} looks; viewers read each one as a different mark.`,
      fix: { kind: "hint", text: `Draw every logo from one layer's look (copy ${ctx.name(groups[0][0])}: same file or path, no extra glow or outline), or name the extra one something else if it is not the logo.` },
    });
  }
  if (placements.length > most) findings.push({
    rule: "brand_consistency", severity: "warn", at: sec(placements[most].at),
    measured: `logo shown ${placements.length} times (${placements.map((entry) => `${sec(entry.at)}s`).join(", ")})`, required: bible ? `at most ${most} (the style bible's logo.max)` : `at most ${LOGO_PLACEMENTS}: the payoff and the end card`,
    message: `The logo is shown ${placements.length} times; a mark that keeps coming back stops landing.`,
    fix: { kind: "hint", text: "Keep the payoff and end-card logo and cut the others (a logo before the hook spoils it)." },
  });
  return findings;
}

// ---------------------------------------------------------------- story_stall

// A frame this dark (0 to 1 luma) with no picture reads as a dead screen.
const DARK = 0.12;
// Longer than this with no picture mid-video, the story stops (the audit's 4 s).
const STALL_SECONDS = 4;
// The opening and closing share of the video, where a title or end card on black is normal.
const STALL_EDGE = 0.1;

// True when a picture (video or image) is seen at a sample: 8% of the frame or more, not hidden.
function pictureShown(model, index) {
  return model.items.some((item) => (item.kind === "video" || item.kind === "image") && !item.isMask && item.samples.opacity[index] >= 0.3
    && !coveredAt(model, item, index) && frameShare(model, item, index) >= 0.08);
}

// A big lit drawing counts as a picture where footage plays elsewhere: a product card or a
// diagram drawn in shapes (a quarter of the frame or more, not dark, not the backdrop).
const BIG_SHAPE = 0.25;
const NOT_SHAPES = ["video", "image", "text", "group", "audio"];
function shapeShown(model, index) {
  return model.items.some((item) => !NOT_SHAPES.includes(item.kind) && !item.isMask && !item.source?.sceneBackground && item.role !== "background"
    && item.samples.opacity[index] >= 0.5 && (item.samples.luma[index] >= DARK || (Number.isNaN(item.samples.luma[index]) && typeof item.fill === "object" && item.fill !== null))
    && !coveredAt(model, item, index) && frameShare(model, item, index) >= BIG_SHAPE);
}

function frameLuma(model, index) {
  let top = null;
  for (const plate of plates(model)) if (plate.samples.opacity[index] >= 0.9 && (!top || plate.z > top.z)) top = plate;
  const luma = top ? top.samples.luma[index] : backgroundLuma(model, index);
  return Number.isFinite(luma) ? luma : 0;
}

export function storyStall(model, ctx) {
  if (model.duration < EDIT_SECONDS) return [];
  // A video with no footage or picture at all (kinetic type, a vector explainer) has no story
  // picture to leave: its dark frames are the style.
  if (!model.times.some((time, index) => pictureShown(model, index))) return [];
  const from = Math.round(model.duration * STALL_EDGE * model.fps);
  const to = Math.round(model.duration * (1 - STALL_EDGE) * model.fps);
  const findings = [];
  let start = -1;
  for (let index = from; index <= to; index += 1) {
    const dead = index < to && !pictureShown(model, index) && !shapeShown(model, index) && frameLuma(model, index) < DARK;
    if (dead && start < 0) start = index;
    if (!dead && start >= 0) {
      const length = (index - start) / model.fps;
      if (length > STALL_SECONDS) findings.push({
        rule: "story_stall", severity: "warn", at: sec(model.times[start]), until: sec(model.times[index - 1]),
        measured: `${sec(length)}s of a dark frame with no footage`, required: `at most ${STALL_SECONDS}s mid-video`,
        message: `From ${sec(model.times[start])}s to ${sec(model.times[index - 1])}s ${ctx.sceneName} shows no picture on a dark frame; the story stops.`,
        fix: { kind: "hint", text: "Run this beat over the story's footage (the words over the picture, the screen as a picture in the shot), or cut it shorter." },
      });
      start = -1;
    }
  }
  return findings;
}

// ---------------------------------------------------------------- hook_readable

// The hook: the first seconds decide whether people keep watching.
const HOOK_SECONDS = 3;
// Readable display type: at least this share of the frame's short side (about 86 px at 1080p).
const HOOK_TYPE = 0.08;
// A picture blurred this much or more (px) is a backdrop, not a subject.
const HOOK_BLUR = 4;

export function hookReadable(model, ctx) {
  if (model.duration < EDIT_SECONDS) return [];
  const end = Math.min(model.times.length, Math.round(HOOK_SECONDS * model.fps));
  const big = HOOK_TYPE * Math.min(model.width, model.height);
  let typeSeen = false, clearPicture = 0;
  for (let index = 0; index < end; index += 1) {
    if (!typeSeen) typeSeen = readingTexts(model).some((item) => drawnSize(model, item) >= big && readableAt(model, item, index) && !coveredAt(model, item, index));
    if (model.items.some((item) => (item.kind === "video" || item.kind === "image") && item.samples.opacity[index] >= 0.5 && item.samples.blur[index] < HOOK_BLUR
      && !coveredAt(model, item, index) && frameShare(model, item, index) >= 0.3)) clearPicture += 1;
  }
  // A clear picture for a third of the hook, or big type at any point, is a hook people can read.
  if (typeSeen || clearPicture >= end / 3) return [];
  const largest = readingTexts(model).filter((item) => item.samples.opacity.slice(0, end).some((value) => value > 0.3))
    .reduce((best, item) => (!best || drawnSize(model, item) > drawnSize(model, best) ? item : best), null);
  return [{
    rule: "hook_readable", severity: "warn", at: 0, until: HOOK_SECONDS, ...(largest ? { itemId: largest.id } : {}),
    measured: `${largest ? `largest type ${Math.round(drawnSize(model, largest))} px` : "no type"}, a clear picture for ${sec(clearPicture / model.fps)}s`,
    required: `type ${Math.round(big)} px or more, or a clear picture (30% of the frame, unblurred) for 1 s`,
    message: `The first ${HOOK_SECONDS}s of ${ctx.sceneName} show neither big type nor a clear picture; the hook cannot be read.`,
    fix: { kind: "hint", text: `Open on the sharpest shot of the subject, or set the hook line at ${Math.round(big)} px or more.` },
  }];
}

// ---------------------------------------------------------------- text_only_open

// A promo shows the product early: the first OPEN_SECONDS with text and no picture for longer
// than OPEN_TEXT_ONLY reads as a title card before the film (the judge's "9 s of white text on
// black before any product"). A text hook over footage is fine: only no picture at all counts,
// and a frame with the logo on it is the promo's logo sting (promo_basics asks for one), not a card.
const OPEN_SECONDS = 4;
const OPEN_TEXT_ONLY = 3;
const OPEN_PICTURE = 0.25;
const OPEN_TYPES = new Set(["promo", "ad"]);

const isPicture = (item) => (item.kind === "video" || item.kind === "image") && !item.isMask && !isLogo(item);

export function textOnlyOpen(model, ctx) {
  // A promo or ad by its videoType; with none set, a video with a logo layer. A sting, an explainer
  // or a clip may open on type, and a short bumper is all type.
  const asset = ctx.style?.logo?.asset;
  if (model.duration < EDIT_SECONDS || (model.videoType ? !OPEN_TYPES.has(model.videoType) : !model.items.some((item) => isLogo(item, asset)))) return [];
  const end = Math.min(model.times.length, Math.round(OPEN_SECONDS * model.fps));
  const texts = readingTexts(model);
  let alone = 0;
  for (let index = 0; index < end; index += 1) {
    const text = texts.some((item) => readableAt(model, item, index) && !coveredAt(model, item, index));
    const picture = model.items.some((item) => isPicture(item) && item.samples.opacity[index] >= 0.5 && !coveredAt(model, item, index) && frameShare(model, item, index) >= OPEN_PICTURE);
    const logo = text && !picture && model.items.some((item) => isLogo(item, asset) && logoOpacity(model, item, index) >= 0.5);
    if (text && !picture && !logo) alone += 1;
  }
  if (alone / model.fps <= OPEN_TEXT_ONLY) return [];
  // The product's own picture to open on: the largest picture the video shows, else the signature's material.
  let best = null, bestShare = 0;
  for (const item of model.items.filter(isPicture))
    for (let index = 0; index < model.times.length; index += 1) {
      const share = item.samples.opacity[index] >= 0.5 ? frameShare(model, item, index) : 0;
      if (share > bestShare) { best = item; bestShare = share; }
    }
  const source = ctx.style?.signatures?.find((entry) => entry?.source)?.source;
  const picture = best ? ctx.name(best) : source ? `the signature's material (${source})` : "a screenshot or clip of the product";
  return [{
    rule: "text_only_open", severity: "warn", at: 0, until: OPEN_SECONDS, ...(best ? { itemId: best.id } : {}),
    measured: `${sec(alone / model.fps)}s of text with no picture in the first ${OPEN_SECONDS}s`,
    required: `at most ${OPEN_TEXT_ONLY}s, or a picture (25% of the frame) under the line`,
    message: `The first ${OPEN_SECONDS}s of ${ctx.sceneName} show only text on a plain frame; a promo shows the product early.`,
    fix: { kind: "hint", text: `Open on ${picture} under the line (a slow push into the part that matters), or move the line over it.` },
  }];
}

// ---------------------------------------------------------------- accent_budget

// A fill this close to the accent (RGB distance, 0 to 441) is the accent.
const ACCENT_NEAR = 48;
// The accent over its share for longer than this is a look swap, not an accent.
const ACCENT_SECONDS = 1;
// The share of a text's box its letters cover.
const TEXT_INK = 0.35;

/** A gradient's main color: the stop that owns the widest span (half way to each neighbor). */
function mainStop(paint) {
  const stops = paint.stops.filter((stop) => hexRgba(stop?.color));
  let best = null, widest = -1;
  stops.forEach((stop, index) => {
    const offset = (entry, fallback) => (Number.isFinite(entry?.offset) ? entry.offset : fallback);
    const here = offset(stop, index / Math.max(1, stops.length - 1));
    const left = index ? (here + offset(stops[index - 1], here)) / 2 : 0;
    const right = index < stops.length - 1 ? (here + offset(stops[index + 1], here)) / 2 : 1;
    if (right - left > widest) { widest = right - left; best = stop.color; }
  });
  return best;
}

/** accent_budget: the style bible's accent (style.accent {color, share}) stays a small part of the frame. */
export function accentBudget(model, ctx) {
  const accent = ctx.style?.accent;
  const target = hexRgba(accent?.color);
  if (!target || !Number.isFinite(accent.share)) return [];
  const isAccent = (color) => {
    const rgba = hexRgba(color);
    return Boolean(rgba) && rgba[3] > 128 && Math.hypot(rgba[0] - target[0], rgba[1] - target[1], rgba[2] - target[2]) <= ACCENT_NEAR;
  };
  // Fills and outlines (media has no paint to read): shapes and text, each by its visible share
  // of the frame. A gradient reads as its main stop.
  const painted = model.items.filter((item) => !item.isMask && !["group", "audio", "video", "image"].includes(item.kind));
  const shareAt = (index) => {
    let share = 0, top = null;
    for (const item of painted) {
      if (item.samples.opacity[index] < 0.3 || coveredAt(model, item, index)) continue;
      const colors = isGradient(item.fill) ? [mainStop(item.fill)] : fillColorsAt(item, index);
      const fillShare = paintShows(item.fill) && colors.length ? colors.filter(isAccent).length / colors.length : 0;
      // An outline covers about its length times its width: the box's edge, for a stroke under a fill.
      const box = visibleBoxAt(model, item, index);
      const edge = item.stroke && isAccent(isGradient(item.stroke.paint) ? mainStop(item.stroke.paint) : item.stroke.paint)
        ? Math.min(1, (2 * ((box.x1 - box.x0) + (box.y1 - box.y0)) * item.stroke.width) / Math.max(1, area(box))) : 0;
      const accentShare = Math.min(1, fillShare + (fillShare ? 0 : edge));
      if (!accentShare) continue;
      const part = frameShare(model, item, index) * item.samples.opacity[index] * accentShare * (item.kind === "text" ? TEXT_INK : 1);
      share += part;
      if (!top || part > top.part) top = { item, part };
    }
    return { share: Math.min(1, share), top };
  };
  const shares = model.times.map((time, index) => shareAt(index));
  const over = runs(model.times.length, (index) => shares[index].share > accent.share).filter((run) => run.length / model.fps > ACCENT_SECONDS);
  return over.slice(0, 3).map((run) => {
    const peak = shares.slice(run.from, run.to + 1).reduce((best, entry) => (entry.share > best.share ? entry : best));
    return {
      rule: "accent_budget", severity: "warn", ...(peak.top ? { itemId: peak.top.item.id } : {}), at: sec(model.times[run.from]), until: sec(model.times[run.to]),
      measured: `${accent.color} on ${Math.round(peak.share * 100)}% of the frame for ${sec(run.length / model.fps)}s`, required: `at most ${Math.round(accent.share * 100)}% (style.accent)`,
      message: `From ${sec(model.times[run.from])}s the accent ${accent.color} covers ${Math.round(peak.share * 100)}% of the frame${peak.top ? ` (most of it ${ctx.name(peak.top.item)})` : ""}; an accent that big stops being an accent.`,
      fix: { kind: "hint", text: `Shrink ${peak.top ? ctx.name(peak.top.item) : "the accent shapes"} or draw it in the main colors, keeping ${accent.color} for small marks; or raise style.accent.share if the plan makes it a set piece.` },
    };
  });
}

// ---------------------------------------------------------------- pacing_jump

// Shot lengths are compared in windows this long.
const PACE_WINDOW = 8;
// Neighboring windows whose median shot lengths differ more than this many times jump.
const PACE_JUMP = 3;
// A turn this close to where the change starts explains it...
const PACE_TURN = 1;
// ...when the new pace then lasts this long before jumping back (an 8 s burst between two slow
// stretches is whiplash).
const PACE_HOLD = 12;

// The story and music turns where the pace may change: marker cues (set_cues), the start and end
// of each sound layer's play, and the spine's beat edges.
function paceTurns(model, ctx) {
  const turns = (ctx.cues ?? []).filter((cue) => cue.kind === "marker").map((cue) => cue.time);
  for (const layer of ctx.scene?.layers ?? []) {
    if (layer.type !== "audio") continue;
    const range = mediaPlaybackRange(layer, model.duration);
    if (range) turns.push(range.start, range.end);
  }
  for (const beat of ctx.style?.spine ?? []) turns.push(beat.from, beat.to);
  return turns;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** pacing_jump: the cut rate changes sharply between neighboring 8 s windows with no turn to explain it. */
export function pacingJump(model, ctx) {
  if (model.duration < 2 * PACE_WINDOW) return [];
  // Shot starts: hard cuts of what is shown, and changes of the full-frame picture.
  const starts = [...cuts(model), ...plateChanges(model).map((change) => change.at)].sort((a, b) => a - b)
    .filter((at, index, list) => index === 0 || at - list[index - 1] >= 0.25);
  const shots = starts.map((at, index) => ({ at, end: starts[index + 1] ?? model.duration }));
  const windows = [];
  for (let from = 0; model.duration - from >= PACE_WINDOW / 2; from += PACE_WINDOW) {
    const to = Math.min(model.duration, from + PACE_WINDOW);
    const lengths = shots.filter((shot) => shot.at < to && shot.end > from).map((shot) => shot.end - shot.at);
    windows.push({ from, to, median: median(lengths), count: lengths.length });
  }
  const turns = paceTurns(model, ctx);
  // Each jump between neighboring windows, and the shot where it starts: the first shot on the
  // new side of the two paces after the last shot on the old side.
  const jumps = [];
  for (let index = 1; index < windows.length; index += 1) {
    const [before, after] = [windows[index - 1], windows[index]];
    const ratio = Math.max(before.median, after.median) / Math.min(before.median, after.median);
    if (!(ratio > PACE_JUMP)) continue;
    const middle = Math.sqrt(before.median * after.median);
    const faster = after.median < before.median;
    const isNew = (shot) => (faster ? shot.end - shot.at < middle : shot.end - shot.at > middle);
    const span = shots.filter((shot) => shot.at >= before.from && shot.at < after.to);
    const lastOld = span.filter((shot) => shot.at < after.from && !isNew(shot)).at(-1);
    const change = span.find((shot) => isNew(shot) && (!lastOld || shot.at > lastOld.at))?.at ?? after.from;
    jumps.push({ before, after, ratio, faster, change });
  }
  const findings = [];
  for (const [index, jump] of jumps.entries()) {
    const { before, after, ratio, change } = jump;
    // A turn where the change starts (within 1 s) is a reason for it, if the new pace then holds:
    // a burst that jumps back within PACE_HOLD is whiplash, turn or not.
    const back = jumps.slice(index + 1).find((next) => next.faster !== jump.faster);
    const holds = !back || back.change - change >= PACE_HOLD;
    if (holds && turns.some((time) => Math.abs(time - change) <= PACE_TURN)) continue;
    findings.push({
      rule: "pacing_jump", severity: "warn", at: sec(before.from), until: sec(after.to),
      measured: `median shot ${sec(before.median)}s (${before.count} shots) then ${sec(after.median)}s (${after.count} shots), ${sec(ratio)}x from ${sec(change)}s${holds ? "" : `, back by ${sec(back.change)}s`}`,
      required: `at most ${PACE_JUMP}x between 8 s windows, unless a music section or story beat changes within ${PACE_TURN}s of it and the new pace holds ${PACE_HOLD}s`,
      message: holds
        ? `${ctx.sceneName} goes from ${sec(before.median)}s shots to ${sec(after.median)}s shots at ${sec(change)}s with no music or story turn there; the pace lurches.`
        : `${ctx.sceneName} jumps from ${sec(before.median)}s shots to ${sec(after.median)}s shots at ${sec(change)}s and back by ${sec(back.change)}s; the pace whiplashes.`,
      fix: { kind: "hint", text: "Ramp the cut rate over a few shots, or move the change onto a music section change (set_cues a marker) or a spine beat edge." },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- ending_count

// A payoff and an end card: more closing beats than this compete with each other.
const ENDINGS = 2;
// Without a spine, the closing stretch is this last share of the video.
const CLOSING_SHARE = 0.2;
// Closing moments this close together are one beat (a title and its kicker).
const SAME_ENDING = 1.5;
// A coda (the idea spine's last beat, style.mjs IDEA_SPINE) closes like the end card.
const CLOSING_ROLES = ["payoff", "end", "coda"];
// Captions with gaps shorter than this are one running track.
const CAPTION_GAP = 0.3;

/** ending_count: after the last story beat, at most a payoff and an end card. */
export function endingCount(model, ctx) {
  if (model.duration < EDIT_SECONDS) return [];
  const spine = ctx.style?.spine ?? null;
  const story = (spine ?? []).filter((beat) => !CLOSING_ROLES.includes(beat.role));
  const from = spine?.length ? Math.max(0, ...story.map((beat) => beat.to)) : model.duration * (1 - CLOSING_SHARE);
  // Closing moments: a logo coming on, or display type coming on, after the story ends.
  const starts = [];
  const asset = ctx.style?.logo?.asset ?? null;
  const texts = new Set(readingTexts(model));
  // Running captions (layers marked caption, however big): a caption that continues a track
  // with no gap of CAPTION_GAP or more since before the closing stretch is not a new ending, and
  // a track that starts in it is one ending, however many lines it reads.
  const captions = readingTexts(model).filter((item) => item.role === "caption");
  const captionOn = (index) => captions.some((item) => item.samples.opacity[index] > 0.3);
  const gapSamples = Math.max(1, Math.round(CAPTION_GAP * model.fps));
  const trackSince = new Array(model.times.length).fill(null);
  for (let index = 0, off = Infinity, since = null; index < model.times.length; index += 1) {
    if (captionOn(index)) { if (off >= gapSamples) since = model.times[index]; off = 0; trackSince[index] = since; } else off += 1;
  }
  for (const item of model.items) {
    const logo = isLogo(item, asset);
    if (!logo && !(texts.has(item) && ["display", "stat"].includes(typeRole(model, item)))) continue;
    const on = (at) => (logo ? logoOpacity(model, item, at) : item.samples.opacity[at]) > 0.3;
    for (let index = 1; index < model.times.length; index += 1) {
      if (model.times[index] < from || !on(index) || on(index - 1)) continue;
      // Only a track's first caption can be a beat: a track running since before the closing
      // stretch is none, and one that starts in it (a closing line read out) is one.
      if (!logo && item.role === "caption" && trackSince[index] != null && trackSince[index] < model.times[index]) continue;
      starts.push({ at: model.times[index], item });
    }
  }
  starts.sort((a, b) => a.at - b.at);
  const moments = [];
  for (const start of starts) {
    if (!moments.length || start.at - moments.at(-1).at > SAME_ENDING) moments.push({ at: start.at, item: start.item });
  }
  const spineEndings = (spine ?? []).filter((beat) => CLOSING_ROLES.includes(beat.role) && beat.from >= from - 0.01);
  const count = Math.max(moments.length, spineEndings.length);
  if (count <= ENDINGS) return [];
  const extra = moments.length > ENDINGS ? moments[ENDINGS] : null;
  return [{
    rule: "ending_count", severity: "warn", ...(extra ? { itemId: extra.item.id } : {}), at: sec(extra?.at ?? spineEndings[ENDINGS].from),
    measured: extra ? `${moments.length} closing beats after ${sec(from)}s (${moments.map((entry) => `${sec(entry.at)}s`).join(", ")})` : `${spineEndings.length} payoff and end beats in the spine`,
    required: `at most ${ENDINGS}: one payoff and one end card`,
    message: `${ctx.sceneName} ends ${count} times after its last story beat${spine?.length ? "" : ` (the last ${Math.round(CLOSING_SHARE * 100)}%)`}; each new title or logo restarts the ending.`,
    fix: { kind: "hint", text: "Keep the strongest payoff and one end card; fold the other closing titles and logos into them or cut them." },
  }];
}

// ---------------------------------------------------------------- overlay_covers_subject

// An overlay may cover at most this share of the marked subject...
const SUBJECT_COVER = 0.3;
// ...for at most this long.
const COVER_SECONDS = 0.5;
// An overlay at this opacity or more (its layer times its fill's alpha) hides what is under it.
const OPAQUE = 0.6;

/** How opaque an overlay is over a run: its median opacity times its fill's alpha (media: 1). */
function opacityOf(item, run) {
  const shown = median(Array.from(item.samples.opacity.slice(run.from, run.to + 1)));
  if (["image", "video"].includes(item.kind)) return shown;
  const alphas = isGradient(item.fill) ? item.fill.stops.map((stop) => hexRgba(stop?.color)?.[3] ?? 255) : [hexRgba(item.fill)?.[3] ?? 255];
  return shown * (alphas.reduce((sum, alpha) => sum + alpha, 0) / alphas.length / 255);
}

/** The smallest move ({dx, dy}) that takes the overlay off the subject and keeps it in the safe area, or null. */
function freePlace(model, item, run, subject) {
  const safe = safeRect(model);
  const box = visibleBoxAt(model, item, Math.round((run.from + run.to) / 2));
  const margin = Math.round(24 * Math.min(model.width, model.height) / 1080);
  const moves = [
    { dx: subject.x0 - margin - box.x1, dy: 0 }, { dx: subject.x1 + margin - box.x0, dy: 0 },
    { dx: 0, dy: subject.y0 - margin - box.y1 }, { dx: 0, dy: subject.y1 + margin - box.y0 },
  ].filter(({ dx, dy }) => box.x0 + dx >= safe.x0 && box.x1 + dx <= safe.x1 && box.y0 + dy >= safe.y0 && box.y1 + dy <= safe.y1)
    .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - Math.abs(b.dx) - Math.abs(b.dy));
  return moves[0] ? { dx: Math.round(moves[0].dx), dy: Math.round(moves[0].dy) } : null;
}

/**
 * True for big type (display or stat) over footage on purpose: the style spec asks for type
 * over the footage, or the text is the hook or the end line (it first shows in the spine's hook,
 * payoff or end beat; with no spine, in the first HOOK_SECONDS or the last 20%).
 */
function deliberateType(model, ctx, item) {
  if (!["display", "stat"].includes(typeRole(model, item, ctx.style?.fonts?.stat?.family))) return false;
  if (ctx.style?.typeOverFootage) return true;
  const at = firstShown(model, item);
  const spine = ctx.style?.spine ?? null;
  if (spine?.length) return spine.some((beat) => ["hook", ...CLOSING_ROLES].includes(beat.role) && at >= beat.from - 0.05 && at < beat.to);
  return at < HOOK_SECONDS || at >= model.duration * (1 - CLOSING_SHARE);
}

/**
 * overlay_covers_subject: a layer drawn over footage covers the subject marked with mark_subject,
 * or, in a clip nobody marked, a person's head or raised hands that Apple Vision found
 * (ctx.people, people.js): a warning then, since a detector can be wrong.
 */
export function overlayCoversSubject(model, ctx) {
  const scene = ctx.scene;
  if (!scene) return [];
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const findings = [];
  for (const item of model.items) {
    const layer = item.kind === "video" && !item.source?.componentPath ? byId.get(item.source?.layerId) : null;
    if (!layer) continue;
    const marked = layer.subjectBoxes?.src === layer.src && layer.subjectBoxes.boxes.length > 0;
    const found = marked ? null : ctx.people?.[layer.src];
    if (!marked && !found?.samples?.length) continue;
    const size = ctx.mediaSizes?.[layer.src];
    const aspect = size?.width > 0 && size?.height > 0 ? size.width / size.height : 16 / 9;
    const chain = chainOf(model, item);
    // Overlays: drawn layers above the footage, not its frame or a scrim over all of it.
    // An outline (a focus ring around the subject) leaves it in view: only filled shapes count.
    const above = model.items.filter((other) => other.z > item.z && !other.isMask && !["group", "audio"].includes(other.kind) && !isDecor(other) && !chain.includes(other)
      && (["text", "image", "video"].includes(other.kind) || paintShows(other.fill)));
    const covering = new Map();
    for (let index = 0; index < model.times.length; index += 1) {
      if (item.samples.opacity[index] < 0.3 || (!marked && blurred(item, index)) || coveredAt(model, item, index)) continue;
      const time = model.times[index];
      const sourceTime = mediaFrameState(layer, time).sourceTime;
      const boxes = marked ? [boxNear(layer, sourceTime)].filter(Boolean) : peopleSubjects(found, sourceTime, aspect);
      const shown = visibleBoxAt(model, item, index);
      for (const box of boxes) {
        const placed = subjectOnScene(scene, layer, time, box, size);
        if (!placed) continue;
        const subject = intersection(intersection(placed, shown), FRAME(model));
        if (area(subject) <= 0) continue;
        // The subject's middle: the center half of its box (a face, a product).
        const [w, h] = [subject.x1 - subject.x0, subject.y1 - subject.y0];
        const middle = { x0: subject.x0 + w / 4, y0: subject.y0 + h / 4, x1: subject.x1 - w / 4, y1: subject.y1 - h / 4 };
        for (const other of above) {
          if (other.samples.opacity[index] < 0.5) continue;
          const otherBox = visibleBoxAt(model, other, index);
          if (area(intersection(otherBox, shown)) >= 0.95 * area(shown)) continue;
          if (area(intersection(otherBox, subject)) / area(subject) > SUBJECT_COVER) {
            if (!covering.has(other)) covering.set(other, { indexes: new Set(), middle: new Set(), subject });
            const entry = covering.get(other);
            entry.indexes.add(index);
            // Every place the subject is while covered, so the move clears all of them.
            entry.subject = { x0: Math.min(entry.subject.x0, subject.x0), y0: Math.min(entry.subject.y0, subject.y0), x1: Math.max(entry.subject.x1, subject.x1), y1: Math.max(entry.subject.y1, subject.y1) };
            if (area(intersection(otherBox, middle)) / area(middle) > SUBJECT_COVER) entry.middle.add(index);
          }
        }
      }
    }
    for (const [other, { indexes, middle, subject }] of covering) {
      const run = longestRun(runs(model.times.length, (index) => indexes.has(index)));
      if (!run || run.length / model.fps <= COVER_SECONDS) continue;
      // A gate for opaque things over the subject's middle: a card, a phone, a picture, a caption
      // or a label. See-through tints (under OPAQUE) leave the subject readable, and so does big
      // type set over it on purpose (deliberateType): a warning.
      const middleRun = longestRun(runs(model.times.length, (index) => middle.has(index)));
      const deliberate = other.kind === "text" && deliberateType(model, ctx, other);
      const solid = !deliberate && opacityOf(other, run) >= OPAQUE;
      const gate = marked && solid && middleRun && middleRun.length / model.fps > COVER_SECONDS;
      const place = solid ? freePlace(model, other, run, subject) : null;
      findings.push({
        rule: "overlay_covers_subject", severity: gate ? "error" : "warn", itemId: other.id, at: sec(model.times[run.from]), until: sec(model.times[run.to]),
        measured: `over ${Math.round(SUBJECT_COVER * 100)}% of ${ctx.name(item)}'s subject${gate ? " and its middle" : ""} for ${sec(run.length / model.fps)}s${deliberate ? " (big type on purpose)" : ""}`, required: `at most ${Math.round(SUBJECT_COVER * 100)}% for ${COVER_SECONDS}s`,
        message: `${ctx.name(other)} covers ${marked ? "the subject marked" : "a person's face or raised hands found"} in ${ctx.name(item)} from ${sec(model.times[run.from])}s to ${sec(model.times[run.to])}s.`,
        // A caption track keeps one place: one caption moved alone would jump, so it is a suggestion.
        fix: place ? { kind: "move", itemId: other.id, dx: place.dx, dy: place.dy, auto: marked && other.role !== "caption", why: "moved off the subject, inside the safe area" }
          : { kind: "hint", text: `Move ${ctx.name(other)} off the subject (look {mode:"source", layer:${ctx.name(item)}} shows the box) or shrink it; waive_check {code:"overlay_covers_subject", target, reason} if it is meant to.` },
      });
    }
  }
  return findings;
}
