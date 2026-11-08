// Log footage (a video layer's `log`) turned into ordinary Rec.709 pictures: per-channel tables, then
// a generated LUT (effects/colorGrading.js renderFunctionLut). Absent `log`: the picture as decoded.
import { renderFunctionLut } from "./effects/colorGrading.js";
import { filterEffect } from "./effects/svg.js";

export const LOG_PROFILES = Object.freeze(["apple-log"]);

// Apple Log curve constants, from Apple's "Apple Log Profile" white paper (2023). Code value P is
// 0..1; scene light R is 0.18 for middle gray.
const R0 = -0.05641088;
const RT = 0.01;
const C = 47.28711236;
const BETA = 0.00964052;
const GAMMA = 0.08550479;
const DELTA = 0.69336945;
const PT = C * (RT - R0) ** 2;

/** Apple Log code value 0..1 -> scene-linear light (0.18 is middle gray). */
export function appleLogToLinear(code) {
  if (code >= PT) return 2 ** ((code - DELTA) / GAMMA) - BETA;
  return Math.sqrt(Math.max(0, code) / C) + R0;
}

/** Scene-linear light -> Apple Log code value (the inverse, for tests and charts). */
export function linearToAppleLog(light) {
  if (light >= RT) return GAMMA * Math.log2(light + BETA) + DELTA;
  if (light >= R0) return C * (light - R0) ** 2;
  return 0;
}

// Apple Log uses BT.2020 primaries; this is the standard BT.2020 -> BT.709 linear matrix (ITU-R BT.2087).
const TO_709 = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];

// kino's own tone map: straight up to KNEE, then a smooth shoulder (no kink at the knee) that
// reaches 1 at TOP, the brightest light Apple Log holds (code value 1), so highlights roll off
// instead of clipping flat.
const KNEE = 0.55;
const TOP = 2 ** ((1 - DELTA) / GAMMA) - BETA;
const REACH = (TOP - KNEE) / (1 - KNEE);
function shoulder(x) {
  if (x <= KNEE) return x;
  const t = Math.min(REACH, (x - KNEE) / (1 - KNEE));
  return KNEE + (1 - KNEE) * (t * (1 + t / REACH ** 2)) / (1 + t);
}
// Rec.709 camera curve (ITU-R BT.709 OETF) and its inverse.
const rec709 = (light) => (light < 0.018 ? 4.5 * light : 1.099 * light ** 0.45 - 0.099);
const fromRec709 = (value) => (value < 0.081 ? value / 4.5 : ((value + 0.099) / 1.099) ** (1 / 0.45));
const clamp01 = (value) => Math.min(1, Math.max(0, value));

// Each channel on its own: code value -> scene light -> tone map -> Rec.709 curve. A gray's answer.
const grayCurve = (code) => rec709(shoulder(Math.max(0, appleLogToLinear(code))));
/** BT.2020 colors (tone mapped, Rec.709 curve) to BT.709: the gamut step, done after the tone map. */
export function gamutTo709(r, g, b) {
  const light = [r, g, b].map(fromRec709);
  return TO_709.map((row) => rec709(clamp01(row[0] * light[0] + row[1] * light[1] + row[2] * light[2])));
}

/** The pixel function: Apple Log r, g, b 0..1 -> Rec.709 r, g, b 0..1. */
export function appleLogToRec709(r, g, b) {
  return gamutTo709(grayCurve(r), grayCurve(g), grayCurve(b));
}

// Drawn in two steps: per-channel tables (256 entries, exact) for the curve, then a 3D LUT for the
// gamut step only. That LUT is smooth and leaves grays as they are, so a gray ramp stays even; one
// 3D LUT of the whole conversion drew grays up to 8/255 off and not always rising.
const CONVERSIONS = { "apple-log": grayCurve };
const shaperTables = new Map();
function curveStep(name, curve) {
  if (!shaperTables.has(name)) {
    const values = Array.from({ length: 256 }, (_, index) => Number(curve(index / 255).toFixed(5))).join(" ");
    shaperTables.set(name, `<feComponentTransfer><feFuncR type="table" tableValues="${values}"/><feFuncG type="table" tableValues="${values}"/><feFuncB type="table" tableValues="${values}"/></feComponentTransfer>`);
  }
  return shaperTables.get(name);
}

/** Wraps a video layer's picture markup in its log conversion; `frame` is {content, bounds, helpers}. */
export function footageLogMarkup(layer, frame) {
  const curve = CONVERSIONS[layer?.log];
  if (layer?.type !== "video" || !curve) return frame.content;
  const curved = filterEffect(frame, curveStep(layer.log, curve), { padding: 0 });
  return renderFunctionLut({ ...frame, content: curved }, { name: "log-gamut-2020-709", color: gamutTo709, size: 17 });
}
