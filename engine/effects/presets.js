import { noise2d } from "./maps.js";
import { effectMapImage } from "./mapImage.js";
import { renderBulge } from "./bulge.js";
import { renderNoiseMask, renderRgbShift } from "./postFx.js";
import { clipEffect, copiesEffect, copySource, filterEffect } from "./svg.js";
import { multiply } from "../geometry.js";
import { clamp, smoothstep } from "../numbers.js";

export const EFFECT_PRESET_KEYS = Object.freeze([
  "dissolve", "pixel", "pixel-wipe", "luma-reveal", "glitch", "barrel", "film-roll",
]);

const MAX_PRESET_SLICES = 256;
const MAX_FILM_COPIES = 12;

function number(frame, key, fallback, min, max, { integer = false } = {}) {
  const supplied = frame?.parameters?.[key];
  const value = clamp(Number.isFinite(supplied) ? supplied : fallback, min, max);
  return integer ? Math.round(value) : value;
}

function enumValue(frame, key, fallback, values) {
  const supplied = frame?.parameters?.[key];
  return values.includes(supplied) ? supplied : fallback;
}

function fmt(value) {
  if (!Number.isFinite(value)) throw new RangeError("Preset transforms must be finite.");
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function matrixString(matrix) { return `matrix(${matrix.map(fmt).join(" ")})`; }

function translate(x, y) { return [1, 0, 0, 1, x, y]; }

function scaleAround(scaleX, scaleY, x, y) {
  return [scaleX, 0, 0, scaleY, x - scaleX * x, y - scaleY * y];
}

function drawCopy(source, matrix, opacity = 1) {
  return `<g transform="${matrixString(matrix)}" opacity="${fmt(clamp(opacity, 0, 1))}">${source}</g>`;
}

function reveal(frame, visibleMarkup) {
  return copiesEffect(frame, visibleMarkup);
}

function sourceFor(frame) {
  return { ...frame, content: copySource(frame) };
}

function hidden(frame) {
  return copiesEffect(frame, "");
}

function table(values) {
  return values.map((value) => fmt(clamp(value, 0, 1))).join(" ");
}

function selectedValues(progress, softness = 0) {
  return Array.from({ length: 129 }, (_, index) => {
    const rank = index / 128;
    if (softness <= 0) return rank <= progress ? 1 : 0;
    return smoothstep((progress - rank + softness / 2) / softness);
  });
}

function mapImage(frame, uri, result) {
  const { x, y, width, height } = frame.bounds;
  return `<feImage href="${uri}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none" result="${result}"/>`;
}

function pixelNoiseMap(frame, cellSize, variant, { position = null, direction = "right" } = {}) {
  const { width, height } = frame.bounds;
  const directions = {
    right: (u, v) => u,
    left: (u, v) => 1 - u,
    down: (u, v) => v,
    up: (u, v) => 1 - v,
  };
  const readPosition = directions[direction] ?? directions.right;
  return effectMapImage(frame,
    JSON.stringify(["preset-pixel-field-v1", cellSize, variant, position ? direction : null, width, height]),
    (x, y, mapWidth, mapHeight) => {
      const localX = (x + 0.5) * width / mapWidth;
      const localY = (y + 0.5) * height / mapHeight;
      const cellX = Math.floor(localX / cellSize), cellY = Math.floor(localY / cellSize);
      const rank = (noise2d(cellX * 0.754877666, cellY * 0.569840291, variant) + 1) / 2;
      const q = position ? readPosition((x + 0.5) / mapWidth, (y + 0.5) / mapHeight) : null;
      return [Math.round(rank * 255), position ? Math.round(q * 255) : 128, 128, 255];
    }, { outside: [0, 128, 128, 255] });
}

function renderPixel(frame, progress, { pixelSize, variant }) {
  const map = pixelNoiseMap(frame, pixelSize, variant);
  const maskTransfer = `<feComponentTransfer in="presetCellRanks" result="presetCellMask"><feFuncA type="table" tableValues="${table(selectedValues(progress))}"/></feComponentTransfer>`;
  const filter = [
    mapImage(frame, map, "presetPixelRanks"),
    `<feColorMatrix in="presetPixelRanks" type="matrix" values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0" result="presetCellRanks"/>`,
    maskTransfer,
    '<feComposite in="SourceGraphic" in2="presetCellMask" operator="in"/>',
  ];
  const content = filterEffect({ ...frame, content: copySource(frame) }, filter, { padding: 0, contain: true });
  return reveal(frame, content);
}

function renderPixelWipe(frame, progress, { direction, scale, spread, variant }) {
  const { width, height } = frame.bounds;
  const alongSize = direction === "left" || direction === "right" ? width : height;
  const band = Math.max(1 / 255, spread / Math.max(1, alongSize));
  const map = pixelNoiseMap(frame, scale, variant, { position: true, direction });
  const intercept = (progress + band / 2) / band;
  const compare = [
    mapImage(frame, map, "presetWipeField"),
    '<feColorMatrix in="presetWipeField" type="matrix" values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1" result="presetWipeRank"/>',
    `<feColorMatrix in="presetWipeField" type="matrix" values="0 ${fmt(-1 / band)} 0 0 ${fmt(intercept)} 0 ${fmt(-1 / band)} 0 0 ${fmt(intercept)} 0 ${fmt(-1 / band)} 0 0 ${fmt(intercept)} 0 0 0 0 1" result="presetWipeFront"/>`,
    '<feComposite in="presetWipeFront" in2="presetWipeRank" operator="arithmetic" k1="0" k2="1" k3="-1" k4="1" result="presetWipeCompare"/>',
    '<feComponentTransfer in="presetWipeCompare" result="presetWipeBinary"><feFuncR type="linear" slope="1000" intercept="-999"/><feFuncG type="linear" slope="1000" intercept="-999"/><feFuncB type="linear" slope="1000" intercept="-999"/><feFuncA type="table" tableValues="1 1"/></feComponentTransfer>',
    '<feColorMatrix in="presetWipeBinary" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0" result="presetWipeMask"/>',
    '<feComposite in="SourceGraphic" in2="presetWipeMask" operator="in"/>',
  ];
  const content = filterEffect({ ...frame, content: copySource(frame) }, compare, { padding: 0, contain: true });
  return reveal(frame, content);
}

function lumaValues(threshold, sharpness, direction) {
  const softness = (100 - sharpness) / 100 * 0.2;
  return Array.from({ length: 129 }, (_, index) => {
    const luma = index / 128;
    if (softness <= 0) return direction === "light-to-dark" ? Number(luma >= threshold) : Number(luma <= threshold);
    const lightAmount = smoothstep((luma - (threshold - softness / 2)) / softness);
    return direction === "light-to-dark" ? lightAmount : 1 - lightAmount;
  });
}

function renderLumaReveal(frame, progress, { sharpness, direction }) {
  const threshold = direction === "light-to-dark" ? 1 - progress : progress;
  const matrix = [
    "0.2126 0.7152 0.0722 0 0", "0.2126 0.7152 0.0722 0 0",
    "0.2126 0.7152 0.0722 0 0", "0 0 0 0 1",
  ].join(" ");
  const alphaFromLuma = ["0 0 0 0 0", "0 0 0 0 0", "0 0 0 0 0", "1 0 0 0 0"].join(" ");
  const filter = [
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${matrix}" result="presetLuma"/>`,
    `<feColorMatrix in="presetLuma" type="matrix" values="${alphaFromLuma}" result="presetLumaMaskInput"/>`,
    `<feComponentTransfer in="presetLumaMaskInput" result="presetLumaMask"><feFuncA type="table" tableValues="${table(lumaValues(threshold, sharpness, direction))}"/></feComponentTransfer>`,
    '<feComposite in="SourceGraphic" in2="presetLumaMask" operator="in"/>',
  ];
  const content = filterEffect({ ...frame, content: copySource(frame) }, filter, { padding: 0, contain: true });
  return reveal(frame, content);
}

function renderDissolve(frame, progress, { scale, sharpness, variant }) {
  const source = sourceFor(frame);
  const softness = (100 - sharpness) / 100 * 0.2;
  const filtered = renderNoiseMask({
    ...source,
    parameters: {
      threshold: 1 - progress,
      scale: clamp(1 / scale, 0.01, 16),
      seed: variant,
      octaves: 4,
      edgeSoftness: softness,
    },
  });
  return reveal(frame, filtered);
}

function renderGlitch(frame, progress, { sliceSize, speed, colorShift, variant }) {
  const box = frame.bounds;
  const sliceHeight = Math.max(sliceSize, box.height / MAX_PRESET_SLICES);
  const count = Math.min(MAX_PRESET_SLICES, Math.ceil(box.height / sliceHeight));
  const source = copySource(frame);
  const envelope = 4 * progress * (1 - progress);
  const phase = Math.floor(progress * speed * 0.25);
  const shiftBound = Math.min(box.width * 0.18, (sliceSize * 0.5 + speed / 100 * box.width * 0.1) * envelope);
  const slices = [];
  for (let index = 0; index < count; index += 1) {
    const y = box.y + index * box.height / count;
    const height = Math.min(box.y + box.height, box.y + (index + 1) * box.height / count) - y;
    const dx = noise2d(index * 0.754877666, phase * 0.569840291, variant) * shiftBound;
    const copy = drawCopy(source, translate(dx, 0));
    slices.push(clipEffect(frame, copy, { x: box.x, y, width: box.width, height: Math.max(0.001, height) }));
  }
  const shifted = renderRgbShift({
    ...frame,
    content: slices.join(""),
    parameters: { amount: colorShift / 100, direction: 0, overflow: true },
  });
  return reveal(frame, `<g opacity="${fmt(progress)}">${shifted}</g>`);
}

function renderBarrel(frame, progress, { intensity, direction }) {
  const source = sourceFor(frame);
  const sign = direction === "inward" ? 1 : -1;
  const amount = sign * intensity * 4 * progress * (1 - progress);
  const warped = renderBulge({ ...source, parameters: { amount } });
  return reveal(frame, `<g opacity="${fmt(progress)}">${warped}</g>`);
}

function directionVector(direction) {
  return ({ right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] })[direction];
}

function renderFilmRoll(frame, progress, { direction, copies, motionBlur, stretch }) {
  const box = frame.bounds;
  const [directionX, directionY] = directionVector(direction);
  const axisSize = directionX ? box.width : box.height;
  const pitch = axisSize / copies;
  const centerX = box.x + box.width / 2, centerY = box.y + box.height / 2;
  const source = copySource(frame);
  const rolling = [];
  const stretchFactor = 1 + (stretch / 100) * 4 * progress * (1 - progress);
  for (let index = 0; index <= copies; index += 1) {
    const distance = (progress * copies - index) * pitch;
    const dx = directionX * distance, dy = directionY * distance;
    const scale = scaleAround(directionX ? stretchFactor : 1, directionY ? stretchFactor : 1, centerX, centerY);
    const matrix = multiply(translate(dx, dy), scale);
    rolling.push(drawCopy(source, matrix, 0.82 * (1 - progress)));
  }
  rolling.push(drawCopy(source, [1, 0, 0, 1, 0, 0], progress));

  const blur = (motionBlur / 100) * (pitch / 2) * 4 * progress * (1 - progress);
  let output = rolling.join("");
  if (blur > 0) {
    const sigmaX = directionX ? blur : 0;
    const sigmaY = directionY ? blur : 0;
    output = filterEffect({ ...frame, content: output },
      `<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(sigmaX)} ${fmt(sigmaY)}"/>`,
      { padding: blur * 3, contain: true });
  }
  const clipped = clipEffect(frame, output, frame.bounds);
  return reveal(frame, clipped);
}

/**
 * Render one deterministic transition preset. Progress is the visible amount:
 * zero uses the hidden hit-test proxy, one returns the untouched source string,
 * and intermediate frames are decorative copies/filters of a single copySource.
 */
export function renderEffectPreset(key, frame) {
  if (!EFFECT_PRESET_KEYS.includes(key))
    throw new RangeError(`Unknown effect preset "${String(key)}".`);
  if (!frame || typeof frame !== "object" || typeof frame.content !== "string" || !Number.isFinite(frame.progress))
    throw new TypeError("Effect presets need a frame with SVG content and finite progress.");
  const progress = clamp(frame.progress, 0, 1);
  if (progress <= 0) return hidden(frame);
  if (progress >= 1) return frame.content;

  switch (key) {
    case "dissolve": {
      const scale = number(frame, "scale", 10, 1, 256);
      const sharpness = number(frame, "sharpness", 100, 0, 100);
      const variant = number(frame, "variant", 2, 0, 1_000_000, { integer: true });
      return renderDissolve(frame, progress, { scale, sharpness, variant });
    }
    case "pixel": {
      const pixelSize = number(frame, "pixelSize", 40, 1, 256);
      const variant = number(frame, "variant", 2, 0, 1_000_000, { integer: true });
      return renderPixel(frame, progress, { pixelSize, variant });
    }
    case "pixel-wipe": {
      const direction = enumValue(frame, "direction", "right", ["up", "down", "left", "right"]);
      const scale = number(frame, "scale", 34, 1, 256);
      const spread = number(frame, "spread", 25, 0, 512);
      const variant = number(frame, "variant", 2, 0, 1_000_000, { integer: true });
      return renderPixelWipe(frame, progress, { direction, scale, spread, variant });
    }
    case "luma-reveal": {
      const sharpness = number(frame, "sharpness", 90, 0, 100);
      const direction = enumValue(frame, "direction", "light-to-dark", ["light-to-dark", "dark-to-light"]);
      return renderLumaReveal(frame, progress, { sharpness, direction });
    }
    case "glitch": {
      const sliceSize = number(frame, "sliceSize", 30, 1, 256);
      const speed = number(frame, "speed", 65, 0, 100);
      const colorShift = number(frame, "colorShift", 40, 0, 100);
      const variant = number(frame, "variant", 2, 0, 1_000_000, { integer: true });
      return renderGlitch(frame, progress, { sliceSize, speed, colorShift, variant });
    }
    case "barrel": {
      const intensity = number(frame, "intensity", 0.5, 0, 2);
      const direction = enumValue(frame, "direction", "inward", ["inward", "outward"]);
      return renderBarrel(frame, progress, { intensity, direction });
    }
    case "film-roll": {
      const direction = enumValue(frame, "direction", "up", ["up", "down", "left", "right"]);
      const copies = number(frame, "copies", 6, 1, MAX_FILM_COPIES, { integer: true });
      const motionBlur = number(frame, "motionBlur", 50, 0, 100);
      const stretch = number(frame, "stretch", 50, 0, 100);
      return renderFilmRoll(frame, progress, { direction, copies, motionBlur, stretch });
    }
    default: throw new RangeError(`Unknown effect preset "${String(key)}".`);
  }
}
