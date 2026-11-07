import { noise2d } from "./maps.js";
import { clipEffect, copiesEffect, copySource, filterEffect } from "./svg.js";
import { multiply } from "../geometry.js";
import { clamp } from "../numbers.js";

export const MAX_UTILITY_COPY_COUNT = 128;
export const MAX_GRID_REPETITIONS_PER_AXIS = 10;
export const MAX_NOISE_TILE_REPETITIONS_PER_AXIS = 10;
export const MAX_INWARD_ECHO_COPIES = 64;
export const MAX_RADIAL_REPEAT_COPIES = 64;

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });

const freezeParameters = (parameters) => {
  for (const field of Object.values(parameters)) Object.freeze(field);
  return Object.freeze(parameters);
};

const definition = (key, label, render, parameters, easing = "linear") => Object.freeze({
  key, label, group: "Utility", kind: "ranged", easing, duration: null, render,
  parameters: freezeParameters(parameters),
});

const gridParameters = () => ({
  repeatX: number("Repeat X", 5, 1, MAX_GRID_REPETITIONS_PER_AXIS, 1, "", { integer: true }),
  repeatY: number("Repeat Y", 5, 1, MAX_GRID_REPETITIONS_PER_AXIS, 1, "", { integer: true }),
  gapX: number("Gap X", 60, 0, 512, 1, "px"),
  gapY: number("Gap Y", 60, 0, 512, 1, "px"),
  baseSpeed: number("Base Speed", 0.25, -8, 8, 0.01, "layer sizes/s"),
  speedVariation: number("Speed Variation", 0.5, 0, 1, 0.01, "×"),
  lineOffset: number("Line Offset", 0.5, 0, 1, 0.01, "cell"),
  scaleFactor: number("Scale Factor", 0.7, 0, 2, 0.01, "×"),
});

export const UTILITY_COPY_EFFECTS = Object.freeze([
  definition("grid-scroll-x", "Grid Scroll X", renderGridScrollX, gridParameters()),
  definition("grid-scroll-y", "Grid Scroll Y", renderGridScrollY, gridParameters()),
  definition("inward-echoes", "Inward Echoes", renderInwardEchoes, {
      scaleDown: number("Scale Down", 0.3, 0, 1, 0.01, "×", { initial: 1 }),
      repeatCount: number("Repeat Count", 5, 0, MAX_INWARD_ECHO_COPIES, 1, "", { integer: true }),
      centerX: number("Center X", 0.5, 0, 1, 0.01, "layer fraction"),
      centerY: number("Center Y", 0.5, 0, 1, 0.01, "layer fraction"),
    }, "smooth"),
  definition("noise-tile", "Noise Tile", renderNoiseTile, {
      repetitionsX: number("X Repetitions", 5, 1, MAX_NOISE_TILE_REPETITIONS_PER_AXIS, 1, "", { integer: true }),
      repetitionsY: number("Y Repetitions", 5, 1, MAX_NOISE_TILE_REPETITIONS_PER_AXIS, 1, "", { integer: true }),
      gapX: number("Gap X", 12, 0, 512, 1, "px"),
      gapY: number("Gap Y", 12, 0, 512, 1, "px"),
      scale: number("Scale", 1, 0, 4, 0.01, "×"),
      noiseScale: number("Noise Scale", 1.5, 0.01, 32, 0.01),
      noiseMoveX: number("Noise Move X", 0.6, -16, 16, 0.01, "noise units/s"),
      noiseMoveY: number("Noise Move Y", 0.4, -16, 16, 0.01, "noise units/s"),
      fps: number("FPS", 12, 0, 60, 1, "fps", { integer: true }),
      threshold: number("Threshold", 0.45, 0, 1, 0.01),
      seedOffset: number("Seed Offset", 0, -1_000_000, 1_000_000, 1, "", { integer: true }),
    }),
  definition("radial-repeat-blur", "Radial Repeat Blur", renderRadialRepeatBlur, {
      angle: number("Angle", 300, -360, 360, 1, "°", { initial: 0 }),
      centerX: number("Center X", 1, -1, 1, 0.01, "layer coordinate", { initial: -1 }),
      blurAmount: number("Blur Amount", 0.18, 0, 16, 0.01, "px"),
      repeats: number("Repeats", 40, 1, MAX_RADIAL_REPEAT_COPIES, 1, "", { integer: true }),
      edgeFalloff: number("Edge Falloff", 0.5, 0, 1, 0.01),
      centerY: number("Center Y", 0, -1, 1, 0.01, "layer coordinate"),
    }, "smooth"),
  definition("wiggle", "Wiggle", renderWiggle, {
      wiggleX: number("Wiggle X", 3, 0, 512, 0.1, "px"),
      wiggleY: number("Wiggle Y", 3, 0, 512, 0.1, "px"),
      speed: number("Speed", 3, 0, 60, 0.01, "cycles/s"),
      angle: number("Angle", 0, -360, 360, 0.1, "°"),
      seed: number("Seed", 1, 0, 1_000_000, 1, "", { integer: true }),
    }),
]);

const DEFAULTS = new Map(UTILITY_COPY_EFFECTS.map((effect) => [effect.key,
  Object.fromEntries(Object.entries(effect.parameters).map(([key, field]) => [key, field.default]))]));

function read(frame, effectKey, key, limits, options) {
  const value = frame.parameters?.[key] ?? DEFAULTS.get(effectKey)?.[key];
  const { min, max } = limits;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (options?.integer && !Number.isInteger(value)))
    throw new RangeError(`${effectKey}.${key} must be ${options?.integer ? "an integer" : "a number"} from ${min} to ${max}.`);
  return value;
}

function bounds(frame) {
  if (!frame || typeof frame !== "object" || typeof frame.content !== "string")
    throw new TypeError("Utility effect needs a frame with SVG content.");
  const value = frame.bounds;
  if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width <= 0 || value.height <= 0)
    throw new RangeError("Utility effect bounds must be finite with positive width and height.");
  if (!frame.helpers || typeof frame.helpers.id !== "function" || !Array.isArray(frame.helpers.defs))
    throw new TypeError("Utility effect helpers must provide id(kind) and a defs array.");
  if (!Number.isFinite(frame.time)) throw new RangeError("Utility effect time must be finite.");
  return value;
}

function paintBounds(frame, layerBounds) {
  const value = frame.paintBounds ?? layerBounds;
  if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width < 0 || value.height < 0)
    throw new RangeError("Utility effect paint bounds must be finite and nonnegative.");
  return { ...value, width: Math.max(0.001, value.width), height: Math.max(0.001, value.height) };
}

const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;
const mix = (start, end, amount) => start + (end - start) * amount;

function fmt(value) {
  if (!Number.isFinite(value)) throw new RangeError("Utility transform must be finite.");
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function matrixString(matrix) {
  return `matrix(${matrix.map(fmt).join(" ")})`;
}

function copyMarkup(matrix, opacity = 1) {
  return `<g transform="${matrixString(matrix)}" opacity="${fmt(clamp(opacity, 0, 1))}">`;
}

function tileMatrix(layerBounds, cellX, cellY, cellWidth, cellHeight, scale) {
  const sx = cellWidth * scale / layerBounds.width;
  const sy = cellHeight * scale / layerBounds.height;
  const sourceCenterX = layerBounds.x + layerBounds.width / 2;
  const sourceCenterY = layerBounds.y + layerBounds.height / 2;
  return [sx, 0, 0, sy, cellX + cellWidth / 2 - sx * sourceCenterX, cellY + cellHeight / 2 - sy * sourceCenterY];
}

function translateMatrix(x, y) { return [1, 0, 0, 1, x, y]; }

function scaleAround(scaleX, scaleY, x, y) {
  return [scaleX, 0, 0, scaleY, x - scaleX * x, y - scaleY * y];
}

function rotateAround(degrees, x, y) {
  const angle = degrees * Math.PI / 180;
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return [cosine, sine, -sine, cosine,
    x - cosine * x + sine * y,
    y - sine * x - cosine * y];
}

function transformPoint(matrix, x, y) {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

function transformBounds(box, matrix) {
  const points = [
    transformPoint(matrix, box.x, box.y),
    transformPoint(matrix, box.x + box.width, box.y),
    transformPoint(matrix, box.x, box.y + box.height),
    transformPoint(matrix, box.x + box.width, box.y + box.height),
  ];
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  return { x: left, y: top, width: Math.max(0.001, right - left), height: Math.max(0.001, bottom - top) };
}

function boundsIntersect(first, second) {
  if (![first.x, first.y, first.width, first.height, second.x, second.y, second.width, second.height].every(Number.isFinite))
    throw new RangeError("Utility copy bounds must be finite.");
  return first.x < second.x + second.width && first.x + first.width > second.x &&
    first.y < second.y + second.height && first.y + first.height > second.y;
}

function clippedCopyCollector(frame, sourceBounds, clipBounds) {
  const copies = [];
  let source = null;
  return {
    copies,
    add(matrix) {
      // These effects clip their finished output to the layer box. Drop only copies whose
      // transformed actual paint AABB cannot touch that clip; prior effects may have made
      // the paint larger than the original design box.
      if (!boundsIntersect(transformBounds(sourceBounds, matrix), clipBounds)) return;
      source ??= copySource(frame);
      copies.push(copy(source, matrix));
    },
  };
}

function unionBounds(boxes) {
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: Math.max(0.001, right - left), height: Math.max(0.001, bottom - top) };
}

function copy(source, matrix, opacity = 1) {
  return `${copyMarkup(matrix, opacity)}${source}</g>`;
}

function finishCopies(frame, markup, outputBounds, { clip = false } = {}) {
  const visible = clip ? clipEffect(frame, markup, frame.bounds) : markup;
  if (!clip) frame.helpers.includeBounds?.(outputBounds);
  return copiesEffect(frame, visible);
}

function renderGridScroll(frame, axis) {
  const box = bounds(frame);
  const effectKey = axis === "x" ? "grid-scroll-x" : "grid-scroll-y";
  const repeatX = read(frame, effectKey, "repeatX", { min: 1, max: MAX_GRID_REPETITIONS_PER_AXIS }, { integer: true });
  const repeatY = read(frame, effectKey, "repeatY", { min: 1, max: MAX_GRID_REPETITIONS_PER_AXIS }, { integer: true });
  const gapX = read(frame, effectKey, "gapX", { min: 0, max: 512 });
  const gapY = read(frame, effectKey, "gapY", { min: 0, max: 512 });
  const baseSpeed = read(frame, effectKey, "baseSpeed", { min: -8, max: 8 });
  const variation = read(frame, effectKey, "speedVariation", { min: 0, max: 1 });
  const lineOffset = read(frame, effectKey, "lineOffset", { min: 0, max: 1 });
  const scaleFactor = read(frame, effectKey, "scaleFactor", { min: 0, max: 2 });
  // Repeat counts divide the source into cells. Gaps stay in pixels and extend the
  // scroll pitch, so small boxes can show sparse/cropped tiles rather than zero-area cells.
  const cellWidth = box.width / repeatX, cellHeight = box.height / repeatY;
  const stepX = cellWidth + gapX, stepY = cellHeight + gapY;
  const copyCount = axis === "x" ? (repeatX + 2) * repeatY : repeatX * (repeatY + 2);
  if (copyCount > MAX_UTILITY_COPY_COUNT) throw new RangeError(`Grid Scroll needs at most ${MAX_UTILITY_COPY_COUNT} copies.`);
  if (scaleFactor === 0) return finishCopies(frame, "", box, { clip: true });
  const sourcePaintBounds = paintBounds(frame, box);
  const collector = clippedCopyCollector(frame, sourcePaintBounds, box);

  if (axis === "x") {
    const period = stepX;
    for (let row = 0; row < repeatY; row += 1) {
      const random = noise2d(row * 0.754877666, 0.314159, 71);
      const speed = baseSpeed * (1 + variation * random);
      const alternate = row % 2 ? lineOffset * stepX : 0;
      const scroll = mod(speed * box.width * frame.time + alternate, period);
      for (let column = -1; column <= repeatX; column += 1) {
        const centerX = box.x + column * stepX + cellWidth / 2 - scroll;
        const centerY = box.y + row * stepY + cellHeight / 2;
        collector.add(tileMatrix(box, centerX - cellWidth / 2, centerY - cellHeight / 2, cellWidth, cellHeight, scaleFactor));
      }
    }
  } else {
    const period = stepY;
    for (let column = 0; column < repeatX; column += 1) {
      const random = noise2d(column * 0.754877666, 0.314159, 83);
      const speed = baseSpeed * (1 + variation * random);
      const alternate = column % 2 ? lineOffset * stepY : 0;
      const scroll = mod(speed * box.height * frame.time + alternate, period);
      for (let row = -1; row <= repeatY; row += 1) {
        const centerX = box.x + column * stepX + cellWidth / 2;
        const centerY = box.y + row * stepY + cellHeight / 2 - scroll;
        collector.add(tileMatrix(box, centerX - cellWidth / 2, centerY - cellHeight / 2, cellWidth, cellHeight, scaleFactor));
      }
    }
  }
  return finishCopies(frame, collector.copies.join(""), box, { clip: true });
}

export function renderGridScrollX(frame) { return renderGridScroll(frame, "x"); }
export function renderGridScrollY(frame) { return renderGridScroll(frame, "y"); }

export function renderInwardEchoes(frame) {
  const box = bounds(frame);
  const scaleDown = read(frame, "inward-echoes", "scaleDown", { min: 0, max: 1 });
  const repeatCount = read(frame, "inward-echoes", "repeatCount", { min: 0, max: MAX_INWARD_ECHO_COPIES }, { integer: true });
  const centerX = read(frame, "inward-echoes", "centerX", { min: 0, max: 1 });
  const centerY = read(frame, "inward-echoes", "centerY", { min: 0, max: 1 });
  if (repeatCount === 0) {
    frame.helpers.includeBounds?.(paintBounds(frame, box));
    return copiesEffect(frame, frame.content);
  }
  const cx = box.x + box.width * centerX, cy = box.y + box.height * centerY;
  const copies = [];
  const source = copySource(frame);
  for (let index = repeatCount; index > 0; index -= 1) {
    const factor = mix(1, scaleDown, index / repeatCount);
    copies.push(copy(source, scaleAround(factor, factor, cx, cy)));
  }
  // The visible original sits above the inward echoes; copiesEffect adds its own hidden proxy last.
  copies.push(copy(source, [1, 0, 0, 1, 0, 0]));
  return finishCopies(frame, copies.join(""), paintBounds(frame, box));
}

export function renderNoiseTile(frame) {
  const box = bounds(frame);
  const repetitionsX = read(frame, "noise-tile", "repetitionsX", { min: 1, max: MAX_NOISE_TILE_REPETITIONS_PER_AXIS }, { integer: true });
  const repetitionsY = read(frame, "noise-tile", "repetitionsY", { min: 1, max: MAX_NOISE_TILE_REPETITIONS_PER_AXIS }, { integer: true });
  const gapX = read(frame, "noise-tile", "gapX", { min: 0, max: 512 });
  const gapY = read(frame, "noise-tile", "gapY", { min: 0, max: 512 });
  const scale = read(frame, "noise-tile", "scale", { min: 0, max: 4 });
  const noiseScale = read(frame, "noise-tile", "noiseScale", { min: 0.01, max: 32 });
  const moveX = read(frame, "noise-tile", "noiseMoveX", { min: -16, max: 16 });
  const moveY = read(frame, "noise-tile", "noiseMoveY", { min: -16, max: 16 });
  const fps = read(frame, "noise-tile", "fps", { min: 0, max: 60 }, { integer: true });
  const threshold = read(frame, "noise-tile", "threshold", { min: 0, max: 1 });
  const seedOffset = read(frame, "noise-tile", "seedOffset", { min: -1_000_000, max: 1_000_000 }, { integer: true });
  const copyCount = repetitionsX * repetitionsY;
  if (copyCount > MAX_UTILITY_COPY_COUNT) throw new RangeError(`Noise Tile needs at most ${MAX_UTILITY_COPY_COUNT} copies.`);
  if (scale === 0) return finishCopies(frame, "", box, { clip: true });
  const sourcePaintBounds = paintBounds(frame, box);
  const collector = clippedCopyCollector(frame, sourcePaintBounds, box);
  const stepX = box.width / repetitionsX, stepY = box.height / repetitionsY;
  const cellWidth = Math.max(0, stepX - gapX), cellHeight = Math.max(0, stepY - gapY);
  // FPS 0 freezes the noise field at its initial time; positive FPS values quantize the clock.
  const sampledTime = fps === 0 ? 0 : Math.floor(frame.time * fps) / fps;
  for (let row = 0; row < repetitionsY; row += 1) {
    for (let column = 0; column < repetitionsX; column += 1) {
      const fieldX = column * noiseScale + sampledTime * moveX;
      const fieldY = row * noiseScale + sampledTime * moveY;
      const value = (noise2d(fieldX, fieldY, seedOffset) + 1) / 2;
      if (value < threshold) continue;
      const x = box.x + column * stepX, y = box.y + row * stepY;
      collector.add(tileMatrix(box, x, y, cellWidth, cellHeight, scale));
    }
  }
  return finishCopies(frame, collector.copies.join(""), box, { clip: true });
}

export function renderRadialRepeatBlur(frame) {
  const box = bounds(frame), sourceBounds = paintBounds(frame, box);
  const angle = read(frame, "radial-repeat-blur", "angle", { min: -360, max: 360 });
  const centerX = read(frame, "radial-repeat-blur", "centerX", { min: -1, max: 1 });
  const blurAmount = read(frame, "radial-repeat-blur", "blurAmount", { min: 0, max: 16 });
  const repeats = read(frame, "radial-repeat-blur", "repeats", { min: 1, max: MAX_RADIAL_REPEAT_COPIES }, { integer: true });
  const edgeFalloff = read(frame, "radial-repeat-blur", "edgeFalloff", { min: 0, max: 1 });
  const centerY = read(frame, "radial-repeat-blur", "centerY", { min: -1, max: 1 });
  const cx = box.x + (centerX + 1) * box.width / 2;
  const cy = box.y + (centerY + 1) * box.height / 2;
  const copies = [], copyBounds = [];
  // <use> copies of one definition of the layer that starts with a home rectangle as large as
  // everything the layer draws (copySource in svg.js). Without it, Chromium (Electron 44) left out
  // parts of many copies once there were more than about 30 see-through copies of a layer
  // reaching past the frame: 64 copies of 60 shapes at 1080p were 12.8 levels away from resvg.
  const source = copySource(frame, { home: frame.drawnBounds ?? sourceBounds });
  for (let index = 0; index < repeats; index += 1) {
    const progress = repeats === 1 ? 0 : index / (repeats - 1);
    const matrix = rotateAround(angle * progress, cx, cy);
    const opacity = 1 - edgeFalloff * progress;
    if (opacity > 0) {
      copies.push(copy(source, matrix, opacity));
      copyBounds.push(transformBounds(sourceBounds, matrix));
    }
  }
  const extent = unionBounds(copyBounds) ?? sourceBounds;
  let output = copies.join("");
  if (blurAmount > 0) {
    const filterFrame = { ...frame, content: output, paintBounds: extent };
    output = filterEffect(filterFrame, `<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(blurAmount)}"/>`, { padding: blurAmount * 3 });
  } else frame.helpers.includeBounds?.(extent);
  return copiesEffect(frame, output);
}

export function renderWiggle(frame) {
  const box = bounds(frame), sourceBounds = paintBounds(frame, box);
  const wiggleX = read(frame, "wiggle", "wiggleX", { min: 0, max: 512 });
  const wiggleY = read(frame, "wiggle", "wiggleY", { min: 0, max: 512 });
  const speed = read(frame, "wiggle", "speed", { min: 0, max: 60 });
  const angle = read(frame, "wiggle", "angle", { min: -360, max: 360 });
  const seed = read(frame, "wiggle", "seed", { min: 0, max: 1_000_000 }, { integer: true });
  if (wiggleX === 0 && wiggleY === 0 && angle === 0) {
    frame.helpers.includeBounds?.(sourceBounds);
    return copiesEffect(frame, frame.content);
  }
  // Sample a closed loop so Speed really is cycles per second and held endpoints freeze.
  const phase = frame.time * speed * Math.PI * 2;
  const clockX = Math.cos(phase), clockY = Math.sin(phase);
  const dx = noise2d(clockX, clockY, seed) * wiggleX;
  const dy = noise2d(clockX, clockY, seed + 1) * wiggleY;
  const rotation = noise2d(clockX, clockY, seed + 2) * angle;
  const centerX = box.x + box.width / 2, centerY = box.y + box.height / 2;
  const matrix = multiply(translateMatrix(dx, dy), rotateAround(rotation, centerX, centerY));
  frame.helpers.includeBounds?.(transformBounds(sourceBounds, matrix));
  return copiesEffect(frame, copy(copySource(frame), matrix));
}
