// Looks: five ready-made styles. Each sets a 6-step type scale, the colour roles,
// the motion feel and the background treatment. A brand kit (document.brands) can replace the
// colours, the fonts and the feel; the look fills in the rest.
//
// All five are dark and avoid purple, pure black and pure white. Type sizes are pixels in a
// frame whose short side is 1080; vertical frames use their own, larger scale, and both stay
// at or above the checker's minimums (body 36 / headline 64 in 16:9, 32 / 90 in 9:16).
import { COLOR_ROLES, TYPE_STEPS, feelOf } from "./tokens.js";
import { frameScale, isPortraitFrame } from "./formats.js";

const look = (definition) => Object.freeze(definition);

export const LOOKS = Object.freeze({
  crisp: look({
    name: "crisp",
    about: "clean product look: neutral near-black, coral accent, tight snappy motion",
    fonts: { display: { family: "Inter", weight: 700 }, body: { family: "Inter", weight: 500 } },
    type: { display: 136, h1: 96, h2: 72, body: 40, label: 32, caption: 30 },
    portrait: { display: 150, h1: 112, h2: 96, body: 44, label: 36, caption: 34 },
    colors: { bg: "#0E0F11", surface: "#1B1D21", text: "#F4F2EE", accent: "#FF6B4A", accent2: "#F2C14E" },
    feel: "snappy",
    background: "solid",
    tracking: -0.02,
  }),
  editorial: look({
    name: "editorial",
    about: "magazine look: warm ink background, cream serif headlines, an accent rule, smooth motion",
    fonts: { display: { family: "Noto Serif", weight: 700 }, body: { family: "Inter", weight: 400 } },
    type: { display: 128, h1: 92, h2: 70, body: 38, label: 30, caption: 30 },
    portrait: { display: 140, h1: 108, h2: 94, body: 42, label: 36, caption: 34 },
    colors: { bg: "#17130F", surface: "#262019", text: "#F1E9DC", accent: "#E8A25C", accent2: "#B9C9B0" },
    feel: "smooth",
    background: "rule",
    tracking: -0.01,
  }),
  bold: look({
    name: "bold",
    about: "loud look: very large heavy type, yellow on charcoal, a surface block, the sharpest motion",
    fonts: { display: { family: "Montserrat", weight: 700 }, body: { family: "Montserrat", weight: 500 } },
    type: { display: 156, h1: 112, h2: 80, body: 42, label: 34, caption: 30 },
    portrait: { display: 164, h1: 124, h2: 100, body: 46, label: 38, caption: 34 },
    colors: { bg: "#141414", surface: "#232323", text: "#FAFAF7", accent: "#FFD23F", accent2: "#FF6B4A" },
    feel: "snappy",
    intensity: 0.9,
    background: "block",
    tracking: -0.03,
  }),
  calm: look({
    name: "calm",
    about: "quiet look: deep slate green, serif headlines, a slow drifting glow, long gentle motion",
    fonts: { display: { family: "Noto Serif", weight: 400 }, body: { family: "Inter", weight: 400 } },
    type: { display: 120, h1: 88, h2: 68, body: 38, label: 30, caption: 30 },
    portrait: { display: 132, h1: 104, h2: 92, body: 42, label: 36, caption: 34 },
    colors: { bg: "#13201F", surface: "#1D2E2C", text: "#E7EFEC", accent: "#8FD3C1", accent2: "#F0C9A0" },
    feel: "calm",
    background: "glow",
    tracking: 0,
  }),
  data: look({
    name: "data",
    about: "explainer look: blue-grey background, clear sans type, blue and amber for numbers and charts",
    fonts: { display: { family: "Inter", weight: 700 }, body: { family: "Inter", weight: 400 } },
    type: { display: 128, h1: 88, h2: 68, body: 38, label: 30, caption: 30 },
    portrait: { display: 140, h1: 104, h2: 92, body: 42, label: 36, caption: 34 },
    colors: { bg: "#0F1720", surface: "#1A2531", text: "#E6EDF3", accent: "#4FB0FF", accent2: "#FFB547" },
    feel: "smooth",
    background: "band",
    tracking: -0.01,
  }),
});

export const LOOK_NAMES = Object.freeze(Object.keys(LOOKS));

/**
 * The smallest sizes the recipes draw at for this frame: {headline, body} in pixels (body 36 and
 * headline 64 at 1080p in 16:9 and square frames, 32 and 90 in 9:16). type_min's readability
 * floor is lower (engine/quality/analysis.js readableFloor): a recipe never draws below it.
 */
export function typeFloor(frame) {
  const scale = frameScale(frame);
  return isPortraitFrame(frame) ? { headline: Math.ceil(90 * scale), body: Math.ceil(32 * scale) } : { headline: Math.ceil(64 * scale), body: Math.ceil(36 * scale) };
}

/**
 * The look a project gets when it names none and has no picked type or brand: its seed picks among
 * the looks, so no single face is the fallback (type comes from references, the picked
 * treatment's type, a style frame and Recall; a look only supplies the rest).
 */
export function seededLook(seed = 1) {
  let hash = Math.imul((Math.trunc(Number(seed)) || 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0xc2b2ae35) >>> 0;
  return LOOK_NAMES[((hash ^ (hash >>> 13)) >>> 0) % LOOK_NAMES.length];
}

// lookOf() with no name is a document saved before looks were seeded: it was made in crisp.
export function lookOf(name) {
  const found = LOOKS[name ?? "crisp"];
  if (!found) throw new Error(`Unknown look "${name}". Looks: ${LOOK_NAMES.join(", ")}.`);
  return found;
}

/**
 * The style a recipe draws with: the look, with the brand's colours, fonts and feel on top,
 * sized for the frame. `faces` are the font faces the server prepared for the brand fonts:
 * {display: {fontFamily, fontSource, fontWeight, fontStyle}, body: {…}}.
 */
export function styleFor({ look: lookName, brand = null, frame, faces = null, feel = null }) {
  const base = lookOf(lookName);
  const scale = frameScale(frame);
  const steps = isPortraitFrame(frame) ? base.portrait : base.type;
  const floor = typeFloor(frame);
  const type = {};
  for (const step of TYPE_STEPS) {
    const minimum = ["display", "h1", "h2"].includes(step) ? floor.headline : floor.body;
    type[step] = Math.max(minimum, Math.round(steps[step] * scale));
  }
  const colors = {};
  for (const role of COLOR_ROLES) colors[role] = brand?.colors?.[role] ?? base.colors[role];
  const face = (slot) => faces?.[slot] ?? { fontFamily: base.fonts[slot].family, fontSource: "", fontWeight: base.fonts[slot].weight, fontStyle: "normal" };
  const feelName = feel ?? brand?.motion ?? base.feel;
  const motion = { name: feelName, ...feelOf(feelName) };
  if (base.intensity !== undefined && !brand?.motion && !feel) motion.intensity = base.intensity;
  return {
    look: base.name, brand: brand?.name ?? null, frame, scale, type, colors,
    fonts: { display: face("display"), body: face("body") },
    feel: motion, background: base.background, tracking: base.tracking,
  };
}
