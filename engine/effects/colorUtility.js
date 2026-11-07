import { filterEffect } from "./svg.js";
import { numberParameter } from "./periodicDisplacement.js";
import { clamp, smoothstep } from "../numbers.js";

const LUMA = [0.2126, 0.7152, 0.0722];
const number = (value) => Number(value.toFixed(8));

/**
 * Color Grade uses bounded multipliers in sRGB. Exposure and Brightness multiply
 * RGB, Contrast pivots at middle gray, and Saturation mixes against sRGB luma.
 * The alpha row stays the identity so transparent and semitransparent paint keeps
 * its original coverage.
 */
export function renderColorGrade(frame) {
  const exposure = numberParameter(frame, "exposure", 1, 0, 4);
  const brightness = numberParameter(frame, "brightness", 1, 0, 4);
  const contrast = numberParameter(frame, "contrast", 1.5, 0, 4);
  const saturation = numberParameter(frame, "saturation", 1, 0, 4);
  if (exposure === 1 && brightness === 1 && contrast === 1 && saturation === 1)
    return frame.content;

  const scale = exposure * brightness * contrast;
  const offset = (1 - contrast) / 2;
  const [redLuma, greenLuma, blueLuma] = LUMA;
  const saturationMatrix = [
    redLuma + (1 - redLuma) * saturation, greenLuma * (1 - saturation), blueLuma * (1 - saturation),
    redLuma * (1 - saturation), greenLuma + (1 - greenLuma) * saturation, blueLuma * (1 - saturation),
    redLuma * (1 - saturation), greenLuma * (1 - saturation), blueLuma + (1 - blueLuma) * saturation,
  ];
  const values = [
    `${number(saturationMatrix[0] * scale)} ${number(saturationMatrix[1] * scale)} ${number(saturationMatrix[2] * scale)} 0 ${number(offset)}`,
    `${number(saturationMatrix[3] * scale)} ${number(saturationMatrix[4] * scale)} ${number(saturationMatrix[5] * scale)} 0 ${number(offset)}`,
    `${number(saturationMatrix[6] * scale)} ${number(saturationMatrix[7] * scale)} ${number(saturationMatrix[8] * scale)} 0 ${number(offset)}`,
    "0 0 0 1 0",
  ].join(" ");
  return filterEffect(frame, `<feColorMatrix type="matrix" values="${values}"/>`, { padding: 0 });
}

function normalizedColor(value) {
  const match = typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return [0, 1, 0];
  const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function keepAlphaTable(range, softness) {
  const start = range * range;
  const end = (range + softness) ** 2;
  return Array.from({ length: 257 }, (_, index) => {
    const distanceSquared = index / 256;
    return number(smoothstep((distanceSquared - start) / (end - start)));
  }).join(" ");
}

/**
 * Color Remover computes straight RGB distance, normalized to [0, 1] by
 * sqrt((dr² + dg² + db²) / 3). SVG's color-matrix step temporarily unpremultiplies
 * input colors; it emits an opaque straight-color buffer so channel squares are
 * independent of source alpha. The final `in` composite applies the keep mask to
 * SourceGraphic, retaining correct antialiased and semitransparent edge alpha.
 */
export function renderColorRemover(frame) {
  const [targetRed, targetGreen, targetBlue] = normalizedColor(frame?.parameters?.targetColor);
  const range = numberParameter(frame, "range", 0.18, 0, 1);
  const softness = numberParameter(frame, "softness", 0.18, 0, 1);
  const channels = [targetRed, targetGreen, targetBlue];
  const straighten = [
    "1 0 0 0 0",
    "0 1 0 0 0",
    "0 0 1 0 0",
    "0 0 0 0 1",
  ].join(" ");
  if (range === 0 && softness === 0) {
    const differenceMatrix = (sign) => [
      ...channels.map((target, index) => {
        const row = [0, 0, 0, 0, sign > 0 ? -target * 255 : target * 255];
        row[index] = sign * 255;
        return row.join(" ");
      }),
      "0 0 0 0 1",
    ].join(" ");
    const exactMatchMask = [
      "0 0 0 0 1",
      "0 0 0 0 1",
      "0 0 0 0 1",
      "1 1 1 0 0",
    ].join(" ");
    return filterEffect(frame, [
      `<feColorMatrix in="SourceGraphic" type="matrix" values="${straighten}" result="straightSource"/>`,
      `<feColorMatrix in="straightSource" type="matrix" values="${differenceMatrix(1)}" result="positiveDifference"/>`,
      `<feColorMatrix in="straightSource" type="matrix" values="${differenceMatrix(-1)}" result="negativeDifference"/>`,
      '<feComposite in="positiveDifference" in2="negativeDifference" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="absoluteDifference"/>',
      `<feColorMatrix in="absoluteDifference" type="matrix" values="${exactMatchMask}" result="keepMask"/>`,
      '<feComposite in="SourceGraphic" in2="keepMask" operator="in"/>',
    ], { padding: 0 });
  }

  const encodeDifference = channels.map((target, index) => {
    const row = [0, 0, 0, 0, 0];
    row[index] = 0.5;
    row[4] = 0.5 * (1 - target);
    return row.join(" ");
  });
  encodeDifference.push("0 0 0 0 1");
  // For a positive Range, matrix outputs clamp to [0, 1], so a hard threshold
  // can use one steep line directly instead of a low-resolution table.
  const distanceAlpha = softness > 0
    ? "0.333333333333 0.333333333333 0.333333333333 0 0"
    : "333333.333333333 333333.333333333 333333.333333333 0 " + number(-(range ** 2) * 1_000_000);
  const normalizedDistance = [
    "0 0 0 0 1",
    "0 0 0 0 1",
    "0 0 0 0 1",
    distanceAlpha,
  ].join(" ");

  const transfer = softness > 0
    ? `<feComponentTransfer in="distanceMask" result="keepMask"><feFuncA type="table" tableValues="${keepAlphaTable(range, softness)}"/></feComponentTransfer>`
    : "";

  return filterEffect(frame, [
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${straighten}" result="straightSource"/>`,
    `<feColorMatrix in="straightSource" type="matrix" values="${encodeDifference.join(" ")}" result="encodedDifference"/>`,
    '<feComposite in="encodedDifference" in2="encodedDifference" operator="arithmetic" k1="4" k2="-4" k3="0" k4="1" result="squaredDifference"/>',
    `<feColorMatrix in="squaredDifference" type="matrix" values="${normalizedDistance}" result="${softness > 0 ? "distanceMask" : "keepMask"}"/>`,
    transfer,
    '<feComposite in="SourceGraphic" in2="keepMask" operator="in"/>',
  ], { padding: 0 });
}
