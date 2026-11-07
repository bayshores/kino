import { glyphContours } from "../engine/textLayout.js";
import { pathBounds, serializePath } from "../engine/vectorPath.js";
import { lottieShapeParts } from "./lottie-shapes.mjs";
import { vectorLayer } from "./lottie-vector.mjs";

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

function drawRecords(glyphs, label) {
  const records = [];
  for (const [glyphIndex, glyph] of glyphs.entries()) {
    const color = glyph.color;
    if (color?.kind === "image") {
      if (!new Set(["image/png", "image/svg+xml"]).has(color.mime) ||
          typeof color.href !== "string" || !color.href.startsWith(`data:${color.mime};base64,`) ||
          ![color.x, color.y, color.width, color.height, glyph.scale].every(Number.isFinite) ||
          color.width <= 0 || color.height <= 0 || glyph.scale <= 0) {
        throw new Error(`${label} has invalid embedded color-glyph image data.`);
      }
      records.push({ key: `${glyphIndex}:image`, kind: "image", glyph, color });
      continue;
    }
    if (color?.kind === "layers") {
      if (!Array.isArray(color.layers) || !color.layers.length) {
        throw new Error(`${label} has an empty color-glyph palette.`);
      }
      for (const [layerIndex, palette] of color.layers.entries()) {
        if (typeof palette?.path !== "string" || typeof palette?.fill !== "string") {
          throw new Error(`${label} has invalid color-glyph palette layer ${layerIndex + 1}.`);
        }
        records.push({ key: `${glyphIndex}:palette:${layerIndex}`, kind: "path", glyph, path: palette.path, fill: palette.fill });
      }
      continue;
    }
    if (color && color.kind !== "unsupported") {
      throw new Error(`${label} has an unsupported color-glyph representation.`);
    }
    if (color?.kind === "unsupported") {
      throw new Error(`${label} has an unsupported color glyph: ${String(color.message ?? "font format is unavailable")}`);
    }
    if (glyph.path) records.push({ key: `${glyphIndex}:outline`, kind: "path", glyph, path: glyph.path });
  }
  return records;
}

function transformedPath(record, originX, originY) {
  const glyph = { ...record.glyph, x: record.glyph.x - originX, y: record.glyph.y - originY, path: record.path };
  const contours = glyphContours(glyph);
  return contours.length ? serializePath(contours) : "";
}

function localImageBox(record, originX, originY) {
  const { glyph, color } = record;
  const width = color.width * glyph.scale;
  const height = color.height * glyph.scale;
  const x = glyph.x + color.x * glyph.scale - originX;
  const y = glyph.y + color.y * glyph.scale - originY;
  return { x, y, width, height };
}

function geometryBounds(samples, unitStates, label) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let strokeOutset = 0;
  const include = (bounds) => {
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite))
      throw new Error(`${label} has non-finite color-glyph geometry.`);
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  };

  samples.forEach((sample, sampleIndex) => {
    for (const record of sample.records) {
      if (record.kind === "image") {
        const box = localImageBox(record, 0, 0);
        include(box);
      } else {
        const path = transformedPath(record, 0, 0);
        if (path) include(pathBounds(path));
      }
    }
    const state = unitStates[sampleIndex];
    if (sample.records.some((record) => record.kind === "path" && !record.key.includes(":palette:")) &&
        finite(state.strokeWidth) > 0 && state.stroke !== "none" && state.stroke != null)
      strokeOutset = Math.max(strokeOutset, Math.max(0, finite(state.strokeWidth)) *
        (state.strokeAlign === "inside" ? 0 : state.strokeAlign === "outside" ? 1 : 0.5));
  });

  if (left === Infinity) return null;
  left -= strokeOutset;
  top -= strokeOutset;
  right += strokeOutset;
  bottom += strokeOutset;
  const x = Math.floor(left);
  const y = Math.floor(top);
  return { x, y, width: Math.max(1, Math.ceil(right - x)), height: Math.max(1, Math.ceil(bottom - y)) };
}

function stableDrawOrder(samples, label) {
  const first = samples[0]?.records ?? [];
  const expected = first.map(({ key, kind }) => `${key}:${kind}`);
  for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex += 1) {
    const next = samples[sampleIndex].records.map(({ key, kind }) => `${key}:${kind}`);
    if (next.length !== expected.length || next.some((value, index) => value !== expected[index])) {
      throw new Error(`${label} changes its color and outline draw order across sampled frames; Lottie cannot safely preserve that text topology.`);
    }
  }
  return first;
}

function imageRequestSize(records, matrices) {
  let width = 1, height = 1;
  records.forEach((record, index) => {
    const box = localImageBox(record, 0, 0);
    const [a, b, c, d] = matrices[index];
    width = Math.max(width, Math.ceil(Math.abs(a) * box.width + Math.abs(c) * box.height));
    height = Math.max(height, Math.ceil(Math.abs(b) * box.width + Math.abs(d) * box.height));
  });
  return { width, height };
}

function imageAsset(record, size, helpers, label) {
  if (typeof helpers.inlineImage !== "function") {
    throw new TypeError("Color-glyph Lottie export requires the inlineImage helper.");
  }
  const result = helpers.inlineImage(record.color, size);
  if (!result || typeof result.refId !== "string" || !result.refId ||
      !Number.isFinite(result.width) || result.width < 1 || !Number.isFinite(result.height) || result.height < 1) {
    throw new Error(`${label} could not embed a color-glyph image asset.`);
  }
  return result;
}

function imageLayer(recordSamples, assets, origin, frameCount, nextIndex, helpers, label) {
  const grouped = [];
  for (let index = 0; index < recordSamples.length; index += 1) {
    const asset = assets[index];
    const key = `${asset.refId}:${asset.width}:${asset.height}`;
    const previous = grouped.at(-1);
    if (previous?.key === key) previous.last = index;
    else grouped.push({ key, asset, first: index, last: index });
  }

  return grouped.flatMap((run) => {
    if (run.first >= frameCount) return [];
    const positions = [], scales = [];
    recordSamples.forEach((record, index) => {
      const box = localImageBox(record, origin.x, origin.y);
      const asset = assets[index];
      positions.push([box.x, box.y, 0]);
      scales.push([box.width / asset.width * 100, box.height / asset.height * 100, 100]);
    });
    const [width, height] = [run.asset.width, run.asset.height];
    const image = {
      ddd: 0,
      ind: nextIndex(),
      ty: 2,
      nm: `${label} image`,
      refId: run.asset.refId,
      sr: 1,
      w: width,
      h: height,
      ks: {
        a: { a: 0, k: [0, 0, 0] },
        p: helpers.property(positions, 3),
        s: helpers.property(scales, 3),
        r: { a: 0, k: 0 },
        o: { a: 0, k: 100 },
        sk: { a: 0, k: 0 },
        sa: { a: 0, k: 0 },
      },
      ao: 0,
      ip: run.first,
      op: Math.min(frameCount, run.last + 1),
      st: 0,
      bm: 0,
    };
    return [image];
  });
}

function vectorBlock(records, samples, origin, domain, layer, unitStates, frameCount, nextIndex, helpers, label) {
  const paints = records.map((record) => {
    const shapeStates = samples.map((sample, index) => {
      const item = sample.records.find((candidate) => candidate.key === record.key);
      if (!item || item.kind !== "path") throw new Error(`${label} changed its vector glyph topology.`);
      const path = transformedPath(item, origin.x, origin.y);
      const { pathBounds: _pathBounds, ...state } = unitStates[index];
      const layout = sample.layout;
      const textFill = item.glyph.fill === undefined ? state.fill : item.glyph.fill;
      return {
        ...state,
        ...(item.fill === undefined ? { fill: textFill } : { fill: item.fill }),
        ...(item.kind === "path" && record.key.includes(":palette:") ? { stroke: "none", strokeWidth: 0, fillEnabled: true } : {}),
        path,
        width: domain.width,
        height: domain.height,
        gradientBounds: {
          x: -origin.x,
          y: -origin.y,
          width: layout.width,
          height: layout.height,
        },
      };
    });
    const pseudoLayer = {
      ...layer,
      fill: shapeStates[0].fill,
      type: "path",
      name: record.key.includes(":palette:") ? `${layer.name ?? "Text"} Palette` : `${layer.name ?? "Text"} Glyph`,
      path: shapeStates[0].path,
      width: domain.width,
      height: domain.height,
      gradientBounds: shapeStates[0].gradientBounds,
    };
    return lottieShapeParts(pseudoLayer, shapeStates, `${label} ${record.key}`, helpers);
  });

  const identity = {
    a: { a: 0, k: [0, 0, 0] }, p: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
    r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 },
  };
  const composeLocal = (content, name, options = {}) => helpers.compose(content, name, {
    ...options,
    precompose: options.precompose ?? true,
    domain: { width: domain.width, height: domain.height },
  });
  return vectorLayer(paints, identity, {
    name: `${layer.name ?? "Text"} vector glyphs`, frameCount, nextIndex, compose: composeLocal,
  });
}

function orderedChildren(records, samples, imageAssets, origin, domain, layer, unitStates, frameCount, nextIndex, helpers, label) {
  const children = [];
  let index = 0;
  while (index < records.length) {
    if (records[index].kind === "image") {
      const slot = records[index].key;
      const imageSamples = samples.map((sample) => sample.records.find((record) => record.key === slot));
      const assets = imageAssets.get(slot);
      children.push(...imageLayer(imageSamples, assets, origin, frameCount, nextIndex, helpers, `${label} ${slot}`));
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < records.length && records[end].kind === "path") end += 1;
    children.push(vectorBlock(records.slice(index, end), samples, origin, domain, layer, unitStates,
      frameCount, nextIndex, helpers, label));
    index = end;
  }
  return children;
}

/** Export one text unit with its colored glyphs inside a single effects/opacity composition. */
export function lottieColorTextUnit({
  layer, unitIndex, samples, layouts, unitStates, parentMatrices, parentOpacities,
  helpers, nextIndex, frameCount,
}) {
  const label = `Text layer “${layer.name ?? layer.id}” unit ${unitIndex + 1}`;
  const recordsBySample = samples.map((sample) => ({ ...sample, records: drawRecords(sample.glyphs, label) }));
  const records = stableDrawOrder(recordsBySample, label);
  if (!records.length) return [];
  if (!Array.isArray(layouts) || layouts.length !== samples.length || !Array.isArray(unitStates) || unitStates.length !== samples.length)
    throw new Error(`${label} is missing sampled layout or state data.`);

  const samplesWithLayout = recordsBySample.map((sample, index) => ({ ...sample, layout: layouts[index] }));
  const bounds = geometryBounds(samplesWithLayout, unitStates, label);
  if (!bounds) return [];
  const origin = { x: bounds.x, y: bounds.y };
  const domain = { width: bounds.width, height: bounds.height };
  const matrices = unitStates.map((state, index) => helpers.multiplyMatrix(parentMatrices[index], helpers.localMatrix(layer, state)));
  const imageAssetSizes = new Map();
  const imageSlots = records.filter((record) => record.kind === "image").map((record) => record.key);
  for (const slot of imageSlots) {
    const slotSamples = samplesWithLayout.map((sample) => sample.records.find((item) => item.key === slot));
    const bySource = new Map();
    slotSamples.forEach((record, index) => {
      const sourceKey = `${record.color.mime}:${record.color.href}`;
      if (!bySource.has(sourceKey)) bySource.set(sourceKey, []);
      bySource.get(sourceKey).push({ record, matrix: matrices[index] });
    });
    for (const [sourceKey, entries] of bySource) {
      const maximum = imageRequestSize(entries.map(({ record }) => record), entries.map(({ matrix }) => matrix));
      const old = imageAssetSizes.get(sourceKey);
      imageAssetSizes.set(sourceKey, old
        ? { width: Math.max(old.width, maximum.width), height: Math.max(old.height, maximum.height), record: entries[0].record }
        : { ...maximum, record: entries[0].record });
    }
  }
  const assetsBySource = new Map();
  for (const [sourceKey, size] of imageAssetSizes) {
    assetsBySource.set(sourceKey, imageAsset(size.record, size, helpers, label));
  }
  const imageAssets = new Map();
  for (const slot of imageSlots) {
    const slotSamples = samplesWithLayout.map((sample) => sample.records.find((item) => item.key === slot));
    imageAssets.set(slot, slotSamples.map((record) => assetsBySource.get(`${record.color.mime}:${record.color.href}`)));
  }

  const children = orderedChildren(records, samplesWithLayout, imageAssets, origin, domain, layer, unitStates,
    frameCount, nextIndex, helpers, label);
  const composition = helpers.compose(children, `${layer.name ?? "Text"} ${unitIndex + 1}`, {
    precompose: true,
    domain,
  });
  if (!composition || composition.ty !== 0) {
    throw new Error(`${label} requires a local Lottie composition to preserve colored glyph geometry.`);
  }

  const matricesForUnit = matrices;
  const visibleStates = unitStates.map((state, index) => ({
    ...state,
    opacity: (state.visible === false ? 0 : Math.max(0, Math.min(1, finite(state.opacity)))) *
      Math.max(0, Math.min(1, finite(parentOpacities[index]))),
  }));
  composition.ks = helpers.sampledTransform(layer, matricesForUnit, visibleStates, label);
  composition.ks.a = helpers.property(unitStates.map((state) => [
    finite(state.width) / 2 - origin.x,
    finite(state.height) / 2 - origin.y,
    0,
  ]), 3);

  const effected = helpers.applyEffects
    ? helpers.applyEffects(composition, layer, unitStates, matricesForUnit, visibleStates, {
      bounds: { x: 0, y: 0, width: domain.width, height: domain.height },
      contentOrigin: origin,
    })
    : composition;
  return [effected];
}
