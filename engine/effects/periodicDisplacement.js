import { effectMapImage } from "./mapImage.js";
import { filterEffect } from "./svg.js";

const byte = (value) => Math.max(0, Math.min(255, Math.round(value)));
// Carry X in alpha and Y in equal RGB channels. Color management can mix unequal
// RGB components before Chrome's displacement sampler, even with sRGB filters.
// Alpha and a neutral gray avoid that cross-channel change. Keeping both encoded
// values in [.25,.75] also avoids losing Y when an X sample has zero alpha.
const channel = (value) => byte(127.5 + Math.max(-1, Math.min(1, value)) * 63.75);

export function numberParameter(frame, key, fallback, min, max, { integer = false } = {}) {
  const supplied = frame?.parameters?.[key];
  let value = Number.isFinite(supplied) ? supplied : fallback;
  value = Math.max(min, Math.min(max, value));
  return integer ? Math.round(value) : value;
}

export function booleanParameter(frame, key, fallback) {
  const supplied = frame?.parameters?.[key];
  return typeof supplied === "boolean" ? supplied : fallback;
}

export function timeSeconds(frame) {
  return Number.isFinite(frame?.time) ? frame.time : 0;
}

// A field's mapSide (optional) caps its map's longer side (effectMapImage maxSide).
function mapUri(frame, key, vectorAt, mapSide) {
  if (typeof vectorAt !== "function") throw new TypeError("A displacement vector function is required.");
  const { width, height } = frame.bounds;
  const opaque = Boolean(frame.helpers.raster);
  return effectMapImage(frame, `${opaque ? "opaque-half-rg-v1" : "gray-alpha-v1"}|${key}|${width}x${height}`,
    (pixelX, pixelY, mapWidth, mapHeight) => {
      const u = (pixelX + 0.5) / mapWidth;
      const v = (pixelY + 0.5) / mapHeight;
      const vector = vectorAt(u, v, width, height);
      if (!vector || !Number.isFinite(vector.x) || !Number.isFinite(vector.y))
        throw new TypeError("Displacement fields must return finite x and y values.");
      const y = channel(vector.y);
      return opaque ? [channel(vector.x), y, 128, 255] : [y, y, y, channel(vector.x)];
    }, { outside: opaque ? [128, 128, 128, 255] : [0, 0, 0, 0], ...(mapSide ? { maxSide: mapSide } : {}) });
}

function opaqueRasterDisplacement(frame, fields, scale) {
  // The native sampler reads premultiplied bytes as straight map values. Keep
  // its map opaque from decoding onward, avoiding another 8-bit premultiply /
  // unpremultiply cycle on the numeric Y field. Both encodings use the exact
  // same channel() bytes and original vector field.
  const { x, y, width, height } = frame.bounds;
  const primitives = ['<feFlood flood-color="rgb(128,128,128)" result="displacementMapNeutral"/>'];
  const results = fields.map((field, index) => {
    const image = `displacementMapImage${index}`, result = `displacementMap${index}`;
    primitives.push(`<feImage href="${mapUri(frame, field.key, field.vectorAt, field.mapSide)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" result="${image}"/>`);
    primitives.push(`<feComposite in="${image}" in2="displacementMapNeutral" operator="over" result="${result}"/>`);
    return result;
  });
  let input = results[0];
  if (fields.length === 2) {
    input = "displacementMapMix";
    primitives.push(`<feComposite in="${results[0]}" in2="${results[1]}" operator="arithmetic" k2="${fields[0].weight}" k3="${fields[1].weight}" result="${input}"/>`);
  }
  // resvg 2.6.2 drops the direction of rotation/shear/reflection when deriving
  // displacement scale from transform row lengths. Correct the signed field.
  const [a, b, c, d] = Array.isArray(frame.helpers.transform) ? frame.helpers.transform : [1, 0, 0, 1];
  const sx = Math.hypot(a, c), sy = Math.hypot(b, d);
  const ax = sx > 1e-12 ? a / sx : 0, cx = sx > 1e-12 ? c / sx : 0;
  const by = sy > 1e-12 ? b / sy : 0, dy = sy > 1e-12 ? d / sy : 0;
  const factor = Math.max(1, Math.abs(ax) + Math.abs(cx), Math.abs(by) + Math.abs(dy));
  const ar = ax / factor, cr = cx / factor, br = by / factor, dr = dy / factor;
  if (Math.abs(ar - 1) + Math.abs(cr) + Math.abs(br) + Math.abs(dr - 1) > 1e-12) {
    primitives.push(`<feColorMatrix in="${input}" values="${ar} ${cr} 0 0 ${0.5 * (1 - ar - cr)} ${br} ${dr} 0 0 ${0.5 * (1 - br - dr)} 0 0 1 0 0 0 0 0 1 0" result="displacementMapTransformed"/>`);
    input = "displacementMapTransformed";
  }
  return { primitives, input, scale: 2 * scale * factor, xChannel: "R", yChannel: "G" };
}

/**
 * Mix X and Y separately, before putting X back into alpha. Directly blending
 * translucent map colors would weight Y by X's alpha. Opaque grayscale Y and
 * scalar alpha X keep the requested convex weights for both coordinates.
 */
export function vectorDisplacementMap(frame, fields, scale, {
  contain = false,
  padding = Math.abs(scale) / 2 + 1,
} = {}) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 2)
    throw new RangeError("A displacement mix needs one or two static fields.");
  if (!Number.isFinite(scale) || Math.abs(scale) > 512)
    throw new RangeError("Displacement scale must be within 512 SVG units.");
  if (!Number.isFinite(padding) || padding < 0 || padding > 512)
    throw new RangeError("Displacement padding must be from 0 to 512 SVG units.");
  if (typeof contain !== "boolean") throw new TypeError("contain must be a boolean.");
  if (scale === 0) return null;
  const weights = fields.map((field) => field.weight);
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 1))
    throw new RangeError("Displacement mix weights must be between 0 and 1.");
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(totalWeight - 1) > 1e-9) throw new RangeError("Displacement mix weights must sum to 1.");
  if (frame.helpers.raster) return opaqueRasterDisplacement(frame, fields, scale);

  const { x, y, width, height } = frame.bounds;
  const paint = frame.paintBounds ?? frame.bounds;
  const region = `x="${paint.x - padding}" y="${paint.y - padding}" width="${paint.width + 2 * padding}" height="${paint.height + 2 * padding}"`;
  const coverage = effectMapImage(frame, "displacement-coverage-v1", () => [0, 0, 0, 255], { outside: [0, 0, 0, 0] });
  const primitives = [
    `<feImage href="${coverage}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" result="displacementCoverage"/>`,
    `<feColorMatrix in="displacementCoverage" ${region} values="0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 1" result="displacementCoverageGray"/>`,
  ];
  const xResults = [], yResults = [];
  fields.forEach((field, index) => {
    const uri = mapUri(frame, field.key, field.vectorAt, field.mapSide);
    const imageResult = `displacementMapImage${index}`;
    primitives.push(`<feImage href="${uri}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" result="${imageResult}"/>`);
    // Extend each numeric coordinate with its .5 neutral value outside the
    // map's rectangle, including the corners of a raster prewarp's AABB.
    const xResult = `displacementX${index}`, yResult = `displacementY${index}`;
    // Explicit primitive regions matter in Chromium: the inferred image-sized
    // subregion otherwise clips off the neutral padding and creates a displaced
    // extra copy of source pixels outside the original map rectangle.
    primitives.push(`<feComposite in="${imageResult}" in2="displacementCoverage" ${region} operator="arithmetic" k2="1" k3="-0.5" k4="0.5" result="${xResult}"/>`);
    primitives.push(`<feColorMatrix in="${imageResult}" ${region} values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1" result="displacementYOpaque${index}"/>`);
    primitives.push(`<feComposite in="displacementYOpaque${index}" in2="displacementCoverageGray" operator="arithmetic" k2="1" k3="-0.5" k4="0.5" result="${yResult}"/>`);
    xResults.push(xResult); yResults.push(yResult);
  });

  let xInput = xResults[0], yInput = yResults[0];
  if (fields.length === 2) {
    xInput = "displacementXMix"; yInput = "displacementYMix";
    primitives.push(`<feComposite in="${xResults[0]}" in2="${xResults[1]}" operator="arithmetic" k2="${weights[0]}" k3="${weights[1]}" result="${xInput}"/>`);
    primitives.push(`<feComposite in="${yResults[0]}" in2="${yResults[1]}" operator="arithmetic" k2="${weights[0]}" k3="${weights[1]}" result="${yInput}"/>`);
  }
  let inputMap = "displacementMap";
  primitives.push(`<feComposite in="${yInput}" in2="${xInput}" operator="in" result="${inputMap}"/>`);
  // The map uses half the former channel excursion, so double the SVG scale.
  return { primitives, input: inputMap, scale: 2 * scale, xChannel: "A", yChannel: "R" };
}

// The map builder is shared with Glass, which samples three color channels at
// slightly different scales while retaining one map and one source graphic.
export function renderVectorDisplacementMix(frame, fields, scale, options = {}) {
  const settings = { contain: false, padding: Math.abs(scale) / 2 + 1, ...options };
  const map = vectorDisplacementMap(frame, fields, scale, settings);
  if (!map) return frame.content;
  return filterEffect(frame, [...map.primitives,
    `<feDisplacementMap in="SourceGraphic" in2="${map.input}" scale="${map.scale}" xChannelSelector="${map.xChannel}" yChannelSelector="${map.yChannel}" result="displacementResult"/>`], settings);
}

/**
 * Encode a normalized [-1, 1] vector field as an opaque displacement map.
 * `maxDisplacement` is the largest absolute local-space displacement in SVG
 * units. The 8-bit neutral channel is approximate by at most one pixel at
 * the 128 px safety limit; amount-zero effects bypass the filter entirely.
 */
export function renderVectorDisplacement(frame, cacheKey, maxDisplacement, vectorAt, options = {}) {
  if (!Number.isFinite(maxDisplacement) || maxDisplacement < 0 || maxDisplacement > 128)
    throw new RangeError("Displacement must be between 0 and 128 local units.");
  if (maxDisplacement === 0) return frame.content;
  return renderVectorDisplacementMix(frame, [{ key: cacheKey, vectorAt, weight: 1 }], 2 * maxDisplacement, {
    ...options,
    padding: options.padding ?? maxDisplacement + 1,
  });
}

export function temporalSeed(time, speed) {
  const position = time * speed;
  const seed = Math.floor(position);
  return { seed, weight: position - seed };
}

export function radialVector(nx, ny, centerX, centerY, width = 1, height = 1) {
  const dx = (nx - centerX) * width;
  const dy = (ny - centerY) * height;
  const length = Math.hypot(dx, dy);
  return length > 1e-12 ? { x: dx / length, y: dy / length, length } : { x: 0, y: 0, length: 0 };
}
