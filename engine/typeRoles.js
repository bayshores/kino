// Type by job: a new text layer that names no face and no fill gets a treatment for the job its
// words do in the edit (a spoken-line subtitle, a payoff or title word, a label), so words with
// different jobs in one edit do not all share one look. The values come from the project's saved
// references' measured lettering (type labels: face, size share, fill) when there are any, else
// from the scene's own colors. Each value is an ordinary layer field the agent can change; the
// receipt names where each came from. A payoff word with no entrance gets a letter-level entrance
// picked by the song cue it lands on.

import { mediaFrameState } from "./playback.js";
import { visibleByOperations } from "./visibilityOps.js";
import { SAFE_ZONES } from "./quality/rules/layout.js";

// Only the roles that name one of the three jobs; body, subhead and ui text keep the plain defaults
// (a paragraph or the product's own words is not a subtitle line or a payoff word).
const JOBS_BY_ROLE = { caption: "subtitle", headline: "payoff", hero: "payoff", label: "label", cta: "label" };
// GUESS: size shares of the frame height when no reference was measured (subtitle lines about 4.5%,
// a payoff word about 14%, a label 3%); a measured label's own share replaces them.
const SHARE = { subtitle: 0.045, payoff: 0.14, label: 0.03 };
// Letter (ink) height to font size: capitals and x-height sit near 0.72 of the em in most faces.
const INK_TO_SIZE = 0.72;
// A measured lettering taller than this share of the frame is the picture, not a line of letters
// (strip frames of busy footage measured 0.85 and 1.0); over PAYOFF_SHARE it is a payoff's size.
const MOST_SHARE = 0.35;
const PAYOFF_SHARE = 0.08;
// GUESS: the mean advance of a letter as a share of the size (heavy capitals near 0.62, a sentence
// in mixed case near 0.52), used to keep the words inside their box: a payoff on one line, a
// subtitle on at most two.
const ADVANCE = { subtitle: 0.52, payoff: 0.62, label: 0.6 };
const LINES = { subtitle: 2, payoff: 1, label: 1 };
// A measured fill under this contrast with the scene's background is not used (WCAG large text).
const MIN_CONTRAST = 3;
const NEAR_CUE = 0.1;

/** The job of a text layer: its role when it names one, else its words (4 or more, or a sentence, read as a line). */
export function textJob(text, role) {
  if (role && JOBS_BY_ROLE[role]) return JOBS_BY_ROLE[role];
  if (role) return null;
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  return words.length >= 4 || /[.?!,;]/.test(String(text ?? "")) ? "subtitle" : "payoff";
}

const hex = (value) => /^#[0-9a-f]{6}$/i.test(String(value ?? "")) ? String(value).toLowerCase() : null;
const channels = (color) => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
const luma = (color) => { const [r, g, b] = channels(color); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const saturation = (color) => { const values = channels(color); const top = Math.max(...values), low = Math.min(...values); return top ? (top - low) / top : 0; };
const linear = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (color) => { const [r, g, b] = channels(color).map(linear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** The WCAG contrast ratio of two #rrggbb colors. */
export function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

// The scene's own colors: its background (null when it is not one plain color) and the fills of its
// shapes (not text, not media).
function sceneColors(scene) {
  const shapes = [];
  for (const layer of scene?.layers ?? []) if (!["text", "video", "image", "audio", "group"].includes(layer.type) && hex(layer.fill)) shapes.push(hex(layer.fill));
  return { background: hex(scene?.background), shapes };
}

/**
 * Which measured label each job takes: [{ref, at, family, weight, share, fill}] (share: the letters'
 * ink height over the frame height). A lettering over 35% of the height is left out (the picture, not
 * letters). Over 8% it can serve the payoff (the largest does); at 8% or under, the subtitle and the
 * label (the smallest does). A job with no label in its range keeps the plain size.
 */
export function labelsByJob(labels) {
  const usable = (labels ?? []).filter((label) => label?.family && label.share > 0 && label.share <= MOST_SHARE).sort((a, b) => b.share - a.share);
  const big = usable.filter((label) => label.share > PAYOFF_SHARE);
  const small = usable.filter((label) => label.share <= PAYOFF_SHARE);
  return { ...(big.length ? { payoff: big[0] } : {}), ...(small.length ? { subtitle: small.at(-1), label: small.at(-1) } : {}) };
}

/** The key a skipped type label ({ref, at, why}) is remembered by once it was said. */
export const skipKey = (entry) => `${entry.ref}@${entry.at}:${entry.why}`;

/**
 * Says each skipped type label once per project: the entries of `skipped` whose key is not in
 * `said` (the keys the project's saved edits already said; a dry run or a refused edit saves none).
 */
export function freshSkips(skipped, said = []) {
  const known = new Set(said);
  return (skipped ?? []).filter((entry) => !known.has(skipKey(entry)));
}

// The weight each job asks for when nothing measured gives one.
const JOB_WEIGHT = { subtitle: 600, payoff: 900, label: 500 };

/**
 * The face a job takes when no measured label gives one: the project's own text that already does
 * that job (the same role, else the largest text for a payoff and the smallest reading line for a
 * subtitle), else an installed face that really has the job's weight (`faces`: [{family, weight,
 * style}], Inter first), else Inter at the nearest weight it has. Never a weight the family lacks.
 * `family` (a family the agent named with no weight) keeps the choice inside that family: its text
 * in the project, else its installed weight nearest the job's.
 * Returns {family, weight, fontSource?, from} or null with no faces at all.
 */
export function jobFace(job, { layers = [], role = null, faces = [], family = null } = {}) {
  const named = family ? String(family).trim().toLowerCase() : null;
  const inFamily = (name) => !named || String(name).toLowerCase() === named;
  if (named) faces = faces.filter((face) => face?.family && inFamily(face.family));
  const texts = layers.filter((layer) => layer?.type === "text" && layer.fontFamily && inFamily(layer.fontFamily) && String(layer.text ?? "").trim());
  const size = (layer) => Number(layer.fontSize) || 0;
  const same = role ? texts.find((layer) => layer.role === role) : null;
  const reading = texts.filter((layer) => textJob(layer.text) === "subtitle").sort((a, b) => size(a) - size(b));
  const [layer, why] = same ? [same, `role ${role}`]
    : job === "payoff" && texts.length ? [[...texts].sort((a, b) => size(b) - size(a))[0], "the largest text"]
      : job === "subtitle" && reading.length ? [reading[0], "the smallest reading line"] : [null, ""];
  if (layer) {
    const weight = Number(layer.fontWeight) || 400;
    return { family: layer.fontFamily, weight, ...(layer.fontSource ? { fontSource: layer.fontSource } : {}), from: `the project's text ${layer.name ?? layer.id} (${layer.fontFamily} ${weight}, ${why})` };
  }
  const wanted = JOB_WEIGHT[job] ?? 400;
  const normal = faces.filter((face) => face?.family && (face.style ?? "normal") === "normal");
  const isInter = (face) => face.family.toLowerCase() === "inter";
  const exact = normal.filter((face) => face.weight === wanted).sort((a, b) => Number(isInter(b)) - Number(isInter(a)) || a.family.localeCompare(b.family))[0];
  if (exact) return { family: exact.family, weight: wanted, from: `installed ${exact.family} ${wanted} (no project text does this job)` };
  if (named) {
    const near = normal.sort((a, b) => Math.abs(a.weight - wanted) - Math.abs(b.weight - wanted))[0];
    return near ? { family: near.family, weight: near.weight, from: `${near.family} ${near.weight}, its nearest installed weight to ${wanted}` } : null;
  }
  const inter = normal.filter(isInter).sort((a, b) => Math.abs(a.weight - wanted) - Math.abs(b.weight - wanted))[0];
  return inter ? { family: inter.family, weight: inter.weight, from: `Inter ${inter.weight}, the nearest weight installed (no face has ${wanted}; no project text does this job)` } : null;
}

// When a layer is on screen at `time`: all its show and hide operations, and a clip's own play window.
function shownAt(layer, time) {
  return visibleByOperations(layer.animations ?? [], time) && (layer.type !== "video" || mediaFrameState(layer, time).visible);
}

/**
 * The pictures (video or image) of `scene` drawn behind a text box ({x, y, width, height}) at
 * `time`, topmost first: on screen then, plain (normal blend, nearly opaque, not in a group, not a
 * cut-out's subject copy, which covers only its subject) and covering at least half of the box.
 * Empty when nothing covers it (the scene's background shows).
 */
export function picturesUnder(scene, box, time) {
  const layers = (scene?.layers ?? []).filter((layer) => ["video", "image"].includes(layer.type) && layer.src && !layer.parentId && layer.visible !== false
    && !layer.cutoutOf && !(Number(layer.opacity) < 0.98) && (layer.blendMode ?? "normal") === "normal" && shownAt(layer, time));
  const area = Math.max(1, box.width * box.height);
  const covers = (layer) => {
    const width = Math.abs((layer.width ?? 0) * (layer.scaleX ?? 1)), height = Math.abs((layer.height ?? 0) * (layer.scaleY ?? 1));
    const overlapX = Math.max(0, Math.min(layer.x + width, box.x + box.width) - Math.max(layer.x, box.x));
    const overlapY = Math.max(0, Math.min(layer.y + height, box.y + box.height) - Math.max(layer.y, box.y));
    return (overlapX * overlapY) / area >= 0.5;
  };
  // Layers are drawn in list order, so the last one that covers the box is the one seen.
  return layers.filter(covers).reverse();
}

/** The topmost picture behind a text box at `time` (picturesUnder), or null. */
export function pictureUnder(scene, box, time) {
  return picturesUnder(scene, box, time)[0] ?? null;
}

/**
 * The fields a text layer of `job` gets on `scene` ({width, height, background, layers}) and where
 * they came from: { properties, from }. `labels` are the project's measured type labels; `text` (its
 * words) keeps the size inside the box: a payoff on one line, a subtitle on two. `face` ({family?,
 * weight?}) is the face the agent already named (board text): the widths are measured from it.
 * `follow` (jobFace) is the face taken when no label gives one; `behind` ({color, from}) is the
 * picture measured behind the box at the text's time: the fill and edge are chosen against it
 * instead of the scene's background.
 */
export function jobTreatment(job, { scene, labels = [], text, advance = null, face = null, follow = null, behind = null, largest = null } = {}) {
  const height = scene?.height ?? 1080;
  const width = scene?.width ?? 1920;
  const label = labelsByJob(labels)[job];
  // A payoff with no measured label takes the size of the project's largest text (`largest`: {size, name})
  // when its letters are a payoff's size (over PAYOFF_SHARE of the height, as a measured label is judged),
  // else the GUESS share, printed as a starting guess.
  const largestLetters = Number(largest?.size) > 0 ? (Number(largest.size) * INK_TO_SIZE) / height : 0;
  const byLargest = !label && job === "payoff" && largestLetters > PAYOFF_SHARE;
  const share = label ? label.share / INK_TO_SIZE : byLargest ? Number(largest.size) / height : SHARE[job];
  const largestSaid = largestLetters ? `${largest.name} (${Math.round(largest.size)} px, letters ${Math.round(largestLetters * 1000) / 10}% of the height)` : "";
  const sizeNote = label || job !== "payoff" ? ""
    : byLargest ? `; size from the project's largest text ${largestSaid}`
      : `; size ${Math.round(SHARE.payoff * 100)}% of the height, a starting guess (no type label; ${largestSaid ? `the project's largest text ${largestSaid} is ${Math.round(PAYOFF_SHARE * 100)}% or under, a subtitle's size` : "no project text"})`;
  const boxWidth = Math.round(width * (job === "subtitle" ? 0.84 : job === "payoff" ? 0.9 : 0.4));
  // The longest line the words make at the job's line count, in letters.
  const letters = String(text ?? "").trim().length;
  const longestLine = job === "payoff" ? String(text ?? "").split("\n").map((line) => line.trim()).sort((a, b) => b.length - a.length)[0] ?? "" : String(text ?? "").trim();
  const longest = job === "payoff" ? longestLine.length : Math.ceil(letters / LINES[job]);
  // The line's width in ems, measured from the face it will be set in (`advance(line, family, weight)`:
  // {em, face} or null), else the GUESS above; the job's case is applied first.
  // A family the agent named (board text) keeps the job's weight unless the followed face is that family.
  const own = label || !follow || (face?.family && String(face.family).toLowerCase() !== String(follow.family).toLowerCase()) ? null : follow;
  // Inter at the job's own weight is the plain default: its source is not printed.
  const ownNote = own && !(own.family === "Inter" && own.weight === JOB_WEIGHT[job] && /^installed /.test(own.from)) ? `; face from ${own.from}` : "";
  const weight = label?.weight ?? own?.weight ?? JOB_WEIGHT[job];
  const cased = job === "label" ? longestLine.toUpperCase() : longestLine;
  const measuredWidth = longest && advance ? advance(cased, face?.family ?? label?.family ?? own?.family ?? "Inter", face?.weight ?? weight) : null;
  // A label's letter spacing (0.08 of the size a letter) is added to its measured width.
  const ems = measuredWidth?.em > 0 ? measuredWidth.em / (job === "payoff" ? 1 : LINES[job]) + (job === "label" ? longest * 0.08 : 0) : longest * ADVANCE[job];
  const fit = longest ? Math.floor(boxWidth / ems) : Infinity;
  const wanted = Math.round(share * height);
  const size = Math.max(12, Math.min(wanted, fit));
  const { background: plainBackground, shapes } = sceneColors(scene);
  // The picture measured behind the box wins over the scene's background, which it covers.
  const behindColor = hex(behind?.color);
  const background = behindColor ?? plainBackground ?? "#000000";
  const light = luma(background) < 0.5;
  const plain = light ? "#ffffff" : "#111111";
  const accent = shapes.filter((color) => saturation(color) > 0.35 && contrast(color, background) >= MIN_CONTRAST).sort((a, b) => saturation(b) - saturation(a))[0] ?? null;
  // A measured fill that would not read on this scene's background gives way to the plain color.
  const measuredFill = label?.fill && hex(label.fill) && contrast(hex(label.fill), background) >= MIN_CONTRAST ? hex(label.fill) : null;
  const properties = { fontSize: size, textAlign: "center" };
  if (label) Object.assign(properties, { fontFamily: label.family, fontWeight: label.weight });
  else if (own) Object.assign(properties, { fontFamily: own.family, ...(own.fontSource ? { fontSource: own.fontSource } : {}) });
  // On a 9:16 video the phone app's own captions cover the bottom (SAFE_ZONES.portrait): a subtitle sits just above them.
  const portrait = Math.abs(width / height / (9 / 16) - 1) <= 0.02;
  if (job === "subtitle") {
    // A line read over footage: the reference's fill (else the plain color for the background) with a thin dark edge.
    Object.assign(properties, { fill: measuredFill ?? plain, stroke: light ? "#000000" : "#ffffff", strokeWidth: Math.max(2, Math.round(size * 0.06)), strokeAlign: "outside", lineHeight: 1.15, x: Math.round(width * 0.08), width: boxWidth, height: Math.round(size * 2.6), y: Math.round(portrait ? height * (1 - SAFE_ZONES.portrait.bottom) - size * 2.6 : height * 0.86 - size * 1.3) });
    if (!label) properties.fontWeight = weight;
  } else if (job === "payoff") {
    Object.assign(properties, { fill: measuredFill ?? accent ?? plain, lineHeight: 1, x: Math.round(width * 0.05), width: boxWidth, height: Math.round(size * 1.3), y: Math.round(height * 0.5 - size * 0.65) });
    if (!label) properties.fontWeight = weight;
  } else {
    Object.assign(properties, { fill: measuredFill ?? plain, letterSpacing: Math.round(size * 0.08), textCase: "upper", width: boxWidth, height: Math.round(size * 1.4) });
    if (!label) properties.fontWeight = weight;
  }
  const notes = [
    size < wanted ? `size fit to ${longest} letters a line (${wanted} px wanted; widths ${measuredWidth?.em > 0 ? `measured from ${measuredWidth.face}` : `a guess, ${ADVANCE[job]} of the size a letter`})` : "",
    label?.fill && !measuredFill ? `measured fill ${label.fill} under ${MIN_CONTRAST}:1 on ${background}, plain fill used` : "",
  ].filter(Boolean).join("; ");
  const where = label?.frame ? ` (read "${label.read}" in its ${label.frame} at ${label.at} s)` : "";
  const from = (label ? `label ${label.ref} @${label.labelAt ?? label.at}${where} (${label.family} ${label.weight}, letters ${Math.round(label.share * 1000) / 10}% of the height${label.fill ? `, fill ${label.fill}` : ""})`
    : `${behindColor ? `the picture behind (${behindColor} measured from ${behind.from})` : `scene colors (background ${plainBackground ?? `${background}, not one plain color`}`}${job === "payoff" && accent ? `, accent ${accent}` : ""}; no measured type label for this job${behindColor ? "" : ")"}`)
    + (behindColor ? `; fill ${properties.fill} at ${Math.round(contrast(properties.fill, background) * 10) / 10}:1 on ${background}` : "")
    + sizeNote + ownNote + (notes ? ` [${notes}]` : "");
  return { properties, from };
}

/**
 * The letter entrance a payoff word gets when it lands at `start` with no entrance named: picked by
 * the cue within 3 frames (a song drop or seam: a hard scale-in; a build: a rise; a beat or accent:
 * a quick pop; none: a short rise). Returns { animation (add_animation fields), why }.
 */
export function payoffEntrance(start, cues = []) {
  const near = cues.filter((cue) => Number.isFinite(cue.time) && Math.abs(cue.time - start) <= NEAR_CUE).sort((a, b) => Math.abs(a.time - start) - Math.abs(b.time - start))[0];
  const name = near?.name ?? "";
  const custom = (parameters, duration, stagger) => ({ preset: { id: "preset-custom-text", mode: "in", parameters }, start, duration, unit: "letters", stagger });
  if (/^song-(drop|stop)/.test(name) || near?.kind === "accent")
    return { animation: custom({ moveX: null, moveY: null, angle: null, scale: 180, opacity: 0, color: null, blur: 12 }, 0.24, 0.03), why: `letters slam in on cue:${name} (${near.time} s)` };
  if (/^song-build/.test(name))
    return { animation: custom({ moveX: null, moveY: 100, angle: null, scale: null, opacity: 0, color: null, blur: null }, 0.5, 0.07), why: `letters rise in on cue:${name} (${near.time} s)` };
  if (near)
    return { animation: custom({ moveX: null, moveY: null, angle: null, scale: 60, opacity: 0, color: null, blur: null }, 0.2, 0.04), why: `letters pop in on cue:${name} (${near.time} s)` };
  return { animation: custom({ moveX: null, moveY: 60, angle: null, scale: null, opacity: 0, color: null, blur: null }, 0.4, 0.05), why: `letters rise in at ${start} s (no cue within 3 frames)` };
}
