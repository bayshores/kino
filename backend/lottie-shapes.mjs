import { matchPathContours, parsePath, pathBounds, serializePath } from "../engine/vectorPath.js";
import { resolvedCornerRadii, shapeContours } from "../engine/shapes.js";
import { gradientCoordinates, pathGradientBounds, withVisibleFill } from "../engine/paints.js";
import { isGradientPaint } from "../engine/paintInterpolation.js";
import { holdKeyframesAt } from "./lottie-visibility.mjs";
import { isTrimmed, trimOf } from "../engine/strokeTrim.js";
import { modifiersOf, modifyContours } from "../engine/shapeModifiers.js";
import { lottieGradientTracks, trackSwitchFrames } from "./lottie-paints.mjs";

const MAX_PARAMETRIC_VERTICES = 500_000;

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));

function requireHelpers(helpers) {
  if (typeof helpers?.property !== "function" || typeof helpers?.colorToRgba !== "function") {
    throw new TypeError("Lottie shape export requires property and colorToRgba helpers.");
  }
}

function color(value, label, colorToRgba) {
  const rgba = colorToRgba(value);
  if (!Array.isArray(rgba) || rgba.length < 4 || !rgba.slice(0, 4).every(Number.isFinite)) {
    throw new Error(`${label} uses a color that Lottie export cannot represent: ${String(value)}.`);
  }
  return [clamp(rgba[0], 0, 255) / 255, clamp(rgba[1], 0, 255) / 255, clamp(rgba[2], 0, 255) / 255, clamp(rgba[3], 0, 1)];
}

function paintKind(fill, label) {
  if (fill == null || (typeof fill === "string" && fill.trim().toLowerCase() === "none")) return "none";
  if (typeof fill === "string") return "solid";
  if (fill && typeof fill === "object" && ["linear", "radial"].includes(fill.type) && Array.isArray(fill.stops)) return "gradient";
  throw new Error(`${label} has an unsupported fill value.`);
}

// The Lottie paint for all samples: "gradient" when any sample is a gradient (a Color animation
// between a solid and a gradient exports as a gradient whose solid frames have one color),
// otherwise "solid", or "none" when nothing is painted.
function resolvePaints(states, label) {
  const kinds = states.map((state) => paintKind(state.fill, label));
  const kind = kinds.includes("gradient") ? "gradient" : kinds.includes("solid") ? "solid" : "none";
  return { kind, kinds };
}

function solidFillItems(states, label, helpers, fillRule = 1) {
  const colors = states.map((state) =>
    paintKind(state.fill, label) === "none" ? [0, 0, 0, 0] : color(state.fill, label, helpers.colorToRgba),
  );
  return [{
    ty: "fl",
    c: helpers.property(colors.map((rgba) => rgba.slice(0, 3)), 3),
    o: helpers.property(colors.map((rgba) => rgba[3] * 100)),
    r: fillRule,
    bm: 0,
    nm: "Fill",
    hd: false,
  }];
}

// Checks every sampled paint, then returns the gradient tracks from lottieGradientTracks
// (lottie-paints.mjs): one track, or two when the paint switches between linear and radial.
function validatedGradients(states, label, helpers) {
  for (const [index, state] of states.entries()) {
    const kind = paintKind(state.fill, label);
    if (kind === "solid") color(state.fill, label, helpers.colorToRgba);
    if (kind !== "gradient") continue;
    const gradient = state.fill;
    if (gradient.stops.length < 2) {
      throw new Error(`${label} has a gradient with fewer than two stops at sample ${index + 1}.`);
    }
    let previous = -Infinity;
    for (const [stopIndex, stop] of gradient.stops.entries()) {
      if (!Number.isFinite(stop?.offset) || stop.offset < 0 || stop.offset > 1 || stop.offset < previous) {
        throw new Error(`${label} has invalid or unordered gradient stop ${stopIndex + 1} at sample ${index + 1}.`);
      }
      previous = stop.offset;
      color(stop.color, label, helpers.colorToRgba);
    }
    if (!isGradientPaint(gradient)) {
      throw new Error(`${label} has a gradient stop color that is not a hex color at sample ${index + 1}.`);
    }
  }
  const paints = states.map((state) => paintKind(state.fill, label) === "none" ? null : state.fill);
  return lottieGradientTracks(paints)?.tracks ?? null;
}

function gradientFillItems(gradients, label, helpers, opacities = null, bounds = null, fillRule = 1) {
  const colorStops = gradients.map((gradient) => gradient.stops.map((stop) => {
    const rgba = color(stop.color, label, helpers.colorToRgba);
    return [stop.offset, ...rgba.slice(0, 3)];
  }));
  const flatColorStops = colorStops.map((stops) => stops.flat());
  const hasAlpha = gradients.some((gradient) => gradient.stops.some((stop) => color(stop.color, label, helpers.colorToRgba)[3] !== 1));
  const gradientValues = flatColorStops.map((stops, index) => {
    if (!hasAlpha) return stops;
    return [
      ...stops,
      ...gradients[index].stops.flatMap((stop) => {
        const rgba = color(stop.color, label, helpers.colorToRgba);
        return [stop.offset, rgba[3] * (opacities?.[index] ?? 1)];
      }),
    ];
  });
  const coordinates = gradients.map((gradient, index) => gradientCoordinates(gradient, bounds?.[index] ?? { width: 1, height: 1 }));
  const items = [{
    ty: "gf",
    o: { a: 0, k: 100 },
    r: fillRule,
    bm: 0,
    g: { p: gradients[0].stops.length, k: helpers.property(gradientValues, gradientValues[0].length) },
    s: helpers.property(coordinates.map((item) => item.start), 2),
    e: helpers.property(coordinates.map((item) => item.end), 2),
    t: gradients[0].type === "linear" ? 1 : 2,
    h: { a: 0, k: 0 },
    a: { a: 0, k: 0 },
    nm: gradients[0].type === "linear" ? "Linear Gradient Fill" : "Radial Gradient Fill",
    hd: false,
  }];
  if (!hasAlpha && opacities?.some((value) => value !== 1)) {
    items[0].o = helpers.property(opacities.map((value) => value * 100));
  }
  return items;
}

// One gradient item per track. With two tracks (linear and radial), each item is shown only in
// the frames of its type, and hold keyframes at the switch frames make the change instant instead
// of a cross-fade between the frames.
function gradientTrackItems(tracks, label, helpers, opacities, bounds, fillRule = 1) {
  return tracks.map((track) => {
    const trackOpacities = track.active.map((active, index) => (active ? opacities[index] : 0));
    const [item] = gradientFillItems(track.gradients, label, helpers, trackOpacities, bounds, fillRule);
    if (tracks.length > 1) {
      const frames = trackSwitchFrames(track.active);
      for (const property of [item.o, item.g.k, item.s, item.e]) holdKeyframesAt(property, frames);
    }
    return item;
  });
}

// A dashed stroke's "d" list: dash and gap lengths, then the offset (Lottie's stroke dashes).
// Every sample needs the same number of lengths, as an animation of the pattern keeps it.
function dashItems(states, label, helpers) {
  const trims = states.map(trimOf);
  const first = trims.find((trim) => trim.dash.length);
  if (!first) return [];
  const even = (dash) => dash.length % 2 ? [...dash, ...dash] : dash;
  const count = even(first.dash).length;
  if (trims.some((trim) => even(trim.dash).length !== count))
    throw new Error(`${label} changes how many lengths its dash has; native Lottie needs one dash pattern per layer.`);
  return [
    ...Array.from({ length: count }, (_, index) => ({
      n: index % 2 ? "g" : "d", nm: index % 2 ? "gap" : "dash",
      v: helpers.property(trims.map((trim) => even(trim.dash)[index])),
    })),
    { n: "o", nm: "offset", v: helpers.property(trims.map((trim) => trim.dashOffset)) },
  ];
}

// Lottie's Trim Paths modifier: start and end in percent, offset in degrees (360 = one turn),
// each contour trimmed by the same amount (m 1), as the renderer draws it (strokeTrim.js).
function trimItem(states, helpers) {
  const trims = states.map(trimOf);
  return {
    ty: "tm",
    s: helpers.property(trims.map((trim) => Math.min(trim.start, trim.end) * 100)),
    e: helpers.property(trims.map((trim) => Math.max(trim.start, trim.end) * 100)),
    o: helpers.property(trims.map((trim) => trim.offset * 360)),
    m: 1,
    nm: "Trim Paths",
    hd: false,
  };
}

// The group with the trim placed after its shapes and before its paint.
function withTrim(group, trim) {
  const at = group.it.findIndex((item) => ["st", "gs", "fl", "gf", "tr"].includes(item.ty));
  const items = [...group.it.slice(0, at), trim, ...group.it.slice(at)];
  return { ...group, it: items, np: items.length };
}

function strokeItems(layer, states, label, helpers, fillRule = 1) {
  const enabled = states.some((state) => finite(state.strokeWidth) > 0 && paintKind(state.stroke, label) !== "none");
  if (!enabled) return [];
  const paintStates = states.map((state) => ({
    ...state, fill: finite(state.strokeWidth) > 0 ? state.stroke : "none",
  }));
  const paints = resolvePaints(paintStates, label);
  if (paints.kind === "gradient") {
    const tracks = validatedGradients(paintStates, label, helpers);
    const items = gradientTrackItems(tracks, label, helpers,
      paints.kinds.map((kind) => kind === "none" ? 0 : 1),
      states.map((state) => paintBounds(layer, state, label)), fillRule);
    return items.map((item) => ({
      ...item, ty: "gs", nm: item.t === 1 ? "Linear Gradient Stroke" : "Radial Gradient Stroke",
      w: helpers.property(states.map((state) => Math.max(0, finite(state.strokeWidth)))),
      lc: 1, lj: 1, ml: 10, d: dashItems(states, label, helpers),
    }));
  }
  const rgba = states.map((state) => {
    if (paintKind(state.stroke, label) === "none" || finite(state.strokeWidth) <= 0) return [0, 0, 0, 0];
    return color(state.stroke, label, helpers.colorToRgba);
  });
  return [{
    ty: "st",
    c: helpers.property(rgba.map((value) => value.slice(0, 3)), 3),
    o: helpers.property(rgba.map((value) => value[3] * 100)),
    w: helpers.property(states.map((state) => Math.max(0, finite(state.strokeWidth)))),
    lc: 1,
    lj: 1,
    ml: 10,
    bm: 0,
    nm: "Stroke",
    hd: false,
    d: dashItems(states, label, helpers),
  }];
}

function groupTransform(position, scale, helpers, name = "Transform") {
  return {
    ty: "tr",
    p: helpers.property(position, 2),
    a: { a: 0, k: [0, 0] },
    s: helpers.property(scale, 2),
    r: { a: 0, k: 0 },
    o: { a: 0, k: 100 },
    sk: { a: 0, k: 0 },
    sa: { a: 0, k: 0 },
    nm: name,
  };
}

function makeGroup(items, name) {
  if (!items.length) return null;
  return {
    ty: "gr",
    it: items,
    nm: name,
    np: items.length,
    cix: 2,
    bm: 0,
    ix: 1,
    mn: "ADBE Vector Group",
    hd: false,
  };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function shapeProperty(shapes, { compress = false } = {}) {
  if (shapes.every((shape) => sameJson(shape, shapes[0]))) return { a: 0, k: shapes[0] };
  const indexes = compress
    ? shapes.map((shape, index) => index === 0 || index === shapes.length - 1 || !sameJson(shape, shapes[index + 1]) ? index : -1).filter((index) => index >= 0)
    : shapes.map((_, index) => index);
  return {
    a: 1,
    k: indexes.map((index) => {
      const shape = shapes[index];
      const next = shapes[index + 1];
      const frame = { t: index, s: [shape] };
      if (next) {
        frame.e = [next];
        frame.i = { x: 1, y: 1 };
        frame.o = { x: 0, y: 0 };
      } else frame.h = 1;
      return frame;
    }),
  };
}

function heldShapeProperty(shapes) {
  const keyframes = [];
  let previous;
  shapes.forEach((shape, index) => {
    if (index === 0 || !(shape === previous || sameJson(shape, previous))) {
      keyframes.push({ t: index, s: [shape], h: 1 });
    }
    previous = shape;
  });
  if (keyframes.length === 1) {
    return { a: 0, k: keyframes[0].s[0] };
  }
  return { a: 1, k: keyframes };
}

function contourShape(contour) {
  const vertices = [contour.start, ...contour.segments.map((segment) => segment.end)];
  const incoming = vertices.map(() => [0, 0]);
  const outgoing = vertices.map(() => [0, 0]);
  contour.segments.forEach((segment, index) => {
    const start = vertices[index];
    const end = vertices[index + 1];
    outgoing[index] = [segment.c1[0] - start[0], segment.c1[1] - start[1]];
    incoming[index + 1] = [segment.c2[0] - end[0], segment.c2[1] - end[1]];
  });
  return { c: contour.closed, v: vertices, i: incoming, o: outgoing };
}

function shapePropertyVertexCount(property) {
  if (property.a === 0) return property.k.v.length;
  return property.k.reduce((count, keyframe) =>
    count + [...(keyframe.s ?? []), ...(keyframe.e ?? [])].reduce((sum, shape) => sum + shape.v.length, 0), 0);
}

const EMPTY_CONTOUR = { start: [0, 0], segments: [], closed: true };

function emptyContour(segmentCount = 0) {
  return {
    start: [0, 0],
    segments: Array.from({ length: segmentCount }, () => ({
      c1: [0, 0],
      c2: [0, 0],
      end: [0, 0],
    })),
    closed: true,
  };
}

function explicitlyClosed(contour) {
  if (!contour.closed) return contour;
  const last = contour.segments.at(-1)?.end ?? contour.start;
  if (last[0] === contour.start[0] && last[1] === contour.start[1]) return contour;
  const dx = contour.start[0] - last[0];
  const dy = contour.start[1] - last[1];
  return {
    ...contour,
    segments: [
      ...contour.segments,
      {
        c1: [last[0] + dx / 3, last[1] + dy / 3],
        c2: [last[0] + (2 * dx) / 3, last[1] + (2 * dy) / 3],
        end: [...contour.start],
      },
    ],
  };
}

function normalizedStartAngle(value) {
  const angle = finite(value);
  const normalized = ((angle % 360) + 360) % 360;
  return normalized === 0 ? 0 : normalized;
}

function needsParametricShape(layer, states) {
  if (layer.type === "star") return true;
  // A trimmed stroke starts where kino's path data starts (shapes.js), not where Lottie's
  // rectangle and ellipse items start.
  if (states.some(isTrimmed)) return true;
  if (layer.type === "rectangle") {
    return states.some((state) => state.cornerRadii !== null && state.cornerRadii !== undefined);
  }
  if (layer.type !== "ellipse") return false;

  const parameters = states.map((state) => [
    finite(state.donut),
    finite(state.sweep, 1),
    normalizedStartAngle(state.startAngle),
  ]);
  return parameters.some(([donut, sweep, angle]) => donut !== 0 || sweep !== 1 || angle !== 0) ||
    parameters.some((value) => !sameJson(value, parameters[0]));
}

function parametricGeometryKey(type, state) {
  const size = [finite(state.width), finite(state.height)];
  if (type === "rectangle") {
    return JSON.stringify([
      type,
      ...size,
      state.cornerRadii ?? finite(state.radius),
    ]);
  }
  if (type === "ellipse") {
    const donut = finite(state.donut);
    const sweep = finite(state.sweep, 1);
    if (sweep === 0 || donut === 1) return JSON.stringify([type, "empty"]);
    return JSON.stringify([
      type,
      ...size,
      donut,
      sweep,
      normalizedStartAngle(state.startAngle),
    ]);
  }
  const spikes = Math.max(0, Math.min(1000, Math.round(finite(state.spikes, 5))));
  if (spikes === 0) return JSON.stringify([type, "empty"]);
  return JSON.stringify([
    type,
    ...size,
    spikes,
    Math.max(0, Math.min(1, finite(state.starThickness, 0.382))),
  ]);
}

function estimatedContourSegments(type, state) {
  if (type === "rectangle") return [8];
  if (type === "star") {
    const spikes = Math.max(0, Math.min(1000, Math.round(finite(state.spikes, 5))));
    return spikes === 0 ? [] : [spikes * 2];
  }

  const donut = Math.max(0, Math.min(1, finite(state.donut)));
  const sweep = Math.max(0, Math.min(1, finite(state.sweep, 1)));
  if (sweep === 0 || donut === 1) return [];
  const arcSegments = Math.max(1, Math.ceil((sweep * Math.PI * 2) / (Math.PI / 2)));
  if (sweep === 1 && donut === 0) return [arcSegments];
  if (sweep === 1) return [arcSegments, arcSegments];
  return [arcSegments + 1 + (donut > 0 ? arcSegments : 1) + 1];
}

function parametricSlotKey(type, state, contourIndex) {
  if (type === "rectangle" || type === "star") {
    return parametricGeometryKey(type, state);
  }

  const donut = Math.max(0, Math.min(1, finite(state.donut)));
  const sweep = Math.max(0, Math.min(1, finite(state.sweep, 1)));
  if (sweep === 0 || donut === 1) return JSON.stringify([type, "empty"]);

  const width = finite(state.width);
  const height = finite(state.height);
  const angle = normalizedStartAngle(state.startAngle);
  if (contourIndex === 1) {
    return sweep === 1 && donut > 0
      ? JSON.stringify([type, "inner", width, height, donut, angle])
      : JSON.stringify([type, "empty"]);
  }
  return JSON.stringify([
    type,
    sweep === 1 ? "outer" : "band",
    width,
    height,
    sweep,
    ...(sweep === 1 ? [] : [donut]),
    angle,
  ]);
}

function sampleParametricContours(type, states, label, geometryCopies) {
  const signatures = states.map((state) => parametricGeometryKey(type, state));
  const estimatedContours = states.map((state) => estimatedContourSegments(type, state));
  const contourCount = Math.max(0, ...estimatedContours.map((segments) => segments.length));
  const maximumSegments = Array.from({ length: contourCount }, (_, contourIndex) =>
    Math.max(...estimatedContours.map((segments) => segments[contourIndex] ?? 0)));
  let estimatedVertices = 0;
  for (let contourIndex = 0; contourIndex < contourCount; contourIndex += 1) {
    let previousSlotKey;
    for (let index = 0; index < states.length; index += 1) {
      const slotKey = parametricSlotKey(type, states[index], contourIndex);
      if (index > 0 && slotKey === previousSlotKey) continue;
      // Every held keyframe in this contour slot has the slot's final fixed topology.
      estimatedVertices += maximumSegments[contourIndex] + 1;
      previousSlotKey = slotKey;
    }
  }
  estimatedVertices *= geometryCopies;
  if (estimatedVertices > MAX_PARAMETRIC_VERTICES) {
    throw new RangeError(
      `${label} has too much per-frame parametric geometry for a safe Lottie export (limit ${MAX_PARAMETRIC_VERTICES.toLocaleString()} shape vertices). Reduce star points, duration, or changing shape samples.`,
    );
  }

  const cache = new Map();
  const sampled = states.map((state, index) => {
    const key = signatures[index];
    if (!cache.has(key)) {
      try {
        cache.set(key, shapeContours(type, state));
      } catch (error) {
        throw new Error(`${label} has invalid parametric geometry: ${error.message}`);
      }
    }
    return cache.get(key);
  });
  return matchParametricContours(sampled, label);
}

function matchParametricContours(sampledContours, label) {
  const contourCount = Math.max(0, ...sampledContours.map((contours) => contours.length));
  const matchedStates = sampledContours.map(() => new Array(contourCount));
  for (let contourIndex = 0; contourIndex < contourCount; contourIndex += 1) {
    const pathByContour = new Map();
    const pathIndexByValue = new Map();
    const paths = [];
    const pathIndices = sampledContours.map((contours) => {
      const contour = contours[contourIndex];
      if (!contour) return -1;
      let path = pathByContour.get(contour);
      if (path === undefined) {
        path = serializePath([explicitlyClosed(contour)]);
        pathByContour.set(contour, path);
      }
      let pathIndex = pathIndexByValue.get(path);
      if (pathIndex === undefined) {
        pathIndex = paths.length;
        pathIndexByValue.set(path, pathIndex);
        paths.push(path);
      }
      return pathIndex;
    });
    if (paths.length === 0) continue;

    let matched;
    try {
      matched = matchPathContours(paths);
    } catch (error) {
      throw new Error(`${label} parametric contour topology cannot be represented in Lottie: ${error.message}`);
    }
    const segmentCount = matched[0][0].segments.length;
    const empty = emptyContour(segmentCount);
    pathIndices.forEach((pathIndex, sampleIndex) => {
      matchedStates[sampleIndex][contourIndex] = pathIndex < 0 ? empty : matched[pathIndex][0];
    });
  }
  return matchedStates;
}

function parametricGeometry(sampledContours) {
  const contourCount = Math.max(0, ...sampledContours.map((contours) => contours.length));
  const shapeCache = new Map();
  const shapeItems = Array.from({ length: contourCount }, (_, contourIndex) => {
    const shapes = sampledContours.map((contours) => {
      const contour = contours[contourIndex] ?? EMPTY_CONTOUR;
      if (!shapeCache.has(contour)) {
        shapeCache.set(contour, contourShape(contour));
      }
      return shapeCache.get(contour);
    });
    return {
      ty: "sh",
      ks: heldShapeProperty(shapes),
      nm: `Path ${contourIndex + 1}`,
      hd: false,
    };
  });
  return {
    shapeItems,
    position: sampledContours.map(() => [0, 0]),
    scale: sampledContours.map(() => [100, 100]),
  };
}

function contourSets(states, label) {
  const paths = states.map((state) => String(state.path ?? ""));
  const parsed = paths.map((path) => parsePath(path));
  if (parsed.every((contours) => contours.length === 0)) return parsed;
  if (parsed.some((contours) => contours.length === 0)) {
    throw new Error(`${label} changes between empty and nonempty path geometry; Lottie cannot preserve that topology change.`);
  }
  try {
    return matchPathContours(paths);
  } catch (error) {
    throw new Error(`${label} path topology cannot be represented in Lottie: ${error.message}`);
  }
}

function pathGeometry(states, layer, label) {
  const contours = contourSets(states, label);
  const sizing = states.map((state) => pathSizing(state, layer));
  const shapeSets = Array.from({ length: contours[0].length }, (_, contourIndex) => {
    const shapes = contours.map((set, sample) => {
      const contour = set[contourIndex];
      return contourShape(scaledContour(contour, sizing[sample]));
    });
    return { ty: "sh", ks: shapeProperty(shapes), nm: `Path ${contourIndex + 1}`, hd: false };
  });
  const position = states.map(() => [0, 0]);
  const scale = states.map(() => [100, 100]);
  return { shapeItems: shapeSets, position, scale };
}

function pathSizing(state, layer) {
  const base = state.pathBounds ?? layer.pathBounds;
  return {
    x: finite(base?.width) > 0 ? finite(state.width) / finite(base.width) : 1,
    y: finite(base?.height) > 0 ? finite(state.height) / finite(base.height) : 1,
  };
}

function paintBounds(layer, state, label) {
  if (layer.type !== "path" || layer.convertedFrom) return { x: 0, y: 0, width: finite(state.width), height: finite(state.height) };
  const bounds = state.gradientBounds ?? layer.gradientBounds ?? pathBounds(String(state.path ?? ""));
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 0 || bounds.height < 0) {
    throw new Error(`${label} has invalid gradient bounds.`);
  }
  const scale = pathSizing(state, layer);
  return pathGradientBounds(
    { x: bounds.x * scale.x, y: bounds.y * scale.y, width: bounds.width * scale.x, height: bounds.height * scale.y },
    { x: 0, y: 0, width: finite(state.width), height: finite(state.height) },
  );
}

function scaledContour(contour, scale) {
  const point = ([x, y]) => [x * scale.x, y * scale.y];
  return {
    start: point(contour.start), closed: contour.closed,
    segments: contour.segments.map((segment) => ({
      c1: point(segment.c1), c2: point(segment.c2), end: point(segment.end),
    })),
  };
}

function primitiveShape(layer, states, helpers) {
  if (layer.type === "rectangle") {
    return {
      ty: "rc",
      d: 1,
      p: helpers.property(states.map((state) => [finite(state.width) / 2, finite(state.height) / 2]), 2),
      s: helpers.property(states.map((state) => [finite(state.width), finite(state.height)]), 2),
      r: helpers.property(states.map((state) => clamp(state.radius, 0, Math.min(finite(state.width), finite(state.height)) / 2))),
      nm: "Rectangle",
      hd: false,
    };
  }
  return {
    ty: "el",
    d: 1,
    p: helpers.property(states.map((state) => [finite(state.width) / 2, finite(state.height) / 2]), 2),
    s: helpers.property(states.map((state) => [finite(state.width), finite(state.height)]), 2),
    nm: "Ellipse",
    hd: false,
  };
}

function pathGroup(layer, states, label, helpers, fillKind, fillItems, strokes) {
  const groups = [];
  if (fillKind === "gradient") {
    const geometry = pathGeometry(states, layer, label);
    const transform = groupTransform(geometry.position, geometry.scale, helpers);
    groups.push(makeGroup([...geometry.shapeItems, ...fillItems, transform], `${layer.name ?? layer.type} Fill`));
  } else if (fillItems.length || strokes.length) {
    const geometry = pathGeometry(states, layer, label);
    const transform = groupTransform(geometry.position, geometry.scale, helpers);
    groups.push(makeGroup([...geometry.shapeItems, ...strokes, ...fillItems, transform], layer.name ?? layer.type));
  }
  if (fillKind === "gradient" && strokes.length) {
    const geometry = pathGeometry(states, layer, label);
    const transform = groupTransform(geometry.position, geometry.scale, helpers);
    groups.unshift(makeGroup([...geometry.shapeItems, ...strokes, transform], `${layer.name ?? layer.type} Stroke`));
  }
  if (fillKind === "none" && !strokes.length) {
    const geometry = pathGeometry(states, layer, label);
    groups.push(makeGroup([...geometry.shapeItems, groupTransform(geometry.position, geometry.scale, helpers)], layer.name ?? layer.type));
  }
  return groups.filter(Boolean);
}

// Shape modifiers (engine/shapeModifiers.js) are written as the outline kino draws,
// sampled per frame, so the player shows the same teeth and grown corners as the render.
function modifiedContours(layer, states, label, copies) {
  const cache = new Map();
  let vertices = 0;
  const sampled = states.map((state) => {
    const key = JSON.stringify([state.width, state.height, state.path, state.radius, state.cornerRadii, state.donut, state.sweep,
      state.startAngle, state.spikes, state.starThickness, state.zigzagSize, state.zigzagCount, state.zigzagPoints, state.offsetAmount, state.offsetJoin,
      state.roundCorners, state.bloatAmount, state.twistAngle, state.twistX, state.twistY,
      state.roughenSize, state.roughenDetail, state.roughenSeed, state.roughenStyle, state.roughenAngle]);
    if (!cache.has(key)) {
      const base = layer.type === "path" ? parsePath(String(state.path ?? "")).map((contour) => scaledContour(contour, pathSizing(state, layer)))
        : shapeContours(layer.type, state);
      const contours = modifyContours(base, { ...state, type: layer.type });
      vertices += contours.reduce((sum, contour) => sum + contour.segments.length + 1, 0) * copies;
      if (vertices > MAX_PARAMETRIC_VERTICES)
        throw new RangeError(`${label} has too much changing shape modifier geometry for a safe Lottie export (limit ${MAX_PARAMETRIC_VERTICES.toLocaleString()} shape vertices). Use fewer teeth, a smaller shape or hold the amounts still.`);
      cache.set(key, contours);
    }
    return cache.get(key);
  });
  return matchParametricContours(sampled, label);
}

function parametricGroup(layer, states, label, helpers, fillKind, fillItems, strokes, modified = false) {
  const type = layer.type;
  const copies = fillKind === "gradient" && strokes.length > 0 ? 2 : 1;
  const sampledContours = modified ? modifiedContours(layer, states, label, copies) : sampleParametricContours(type, states, label, copies);
  const groups = [];
  if (fillKind === "gradient") {
    const geometry = parametricGeometry(sampledContours);
    groups.push(makeGroup([
      ...geometry.shapeItems,
      ...fillItems,
      groupTransform(geometry.position, geometry.scale, helpers),
    ], `${layer.name ?? layer.type} Fill`));
  } else if (fillItems.length || strokes.length) {
    const geometry = parametricGeometry(sampledContours);
    groups.push(makeGroup([
      ...geometry.shapeItems,
      ...strokes,
      ...fillItems,
      groupTransform(geometry.position, geometry.scale, helpers),
    ], layer.name ?? layer.type));
  } else if (fillKind === "none" && !strokes.length) {
    const geometry = parametricGeometry(sampledContours);
    groups.push(makeGroup([
      ...geometry.shapeItems,
      groupTransform(geometry.position, geometry.scale, helpers),
    ], layer.name ?? layer.type));
  }
  if (fillKind === "gradient" && strokes.length) {
    const geometry = parametricGeometry(sampledContours);
    groups.unshift(makeGroup([
      ...geometry.shapeItems,
      ...strokes,
      groupTransform(geometry.position, geometry.scale, helpers),
    ], `${layer.name ?? layer.type} Stroke`));
  }
  return groups.filter(Boolean);
}

/** Build real vector shape groups for sampled layer states in Lottie coordinates. */
function basicShapeGroups(layer, states, label, helpers, splitTrim = true) {
  requireHelpers(helpers);
  if (!layer || !["rectangle", "ellipse", "path", "star"].includes(layer.type)) return [];
  if (!Array.isArray(states) || states.length === 0) throw new TypeError("Lottie shape export requires at least one sampled state.");
  const name = String(label ?? `Layer “${layer.name ?? layer.id ?? layer.type}”`);
  const fillRule = layer.type === "path" && layer.fillRule === "evenodd" ? 2 : 1;
  const paints = resolvePaints(states, name);
  const tracks = paints.kind === "gradient" ? validatedGradients(states, name, helpers) : null;
  const gradientOpacity = paints.kinds.map((kind) => kind === "none" ? 0 : 1);
  const fillItems = paints.kind === "solid"
    ? solidFillItems(states, name, helpers, fillRule)
    : tracks
      ? gradientTrackItems(tracks, name, helpers, gradientOpacity, states.map((state) => paintBounds(layer, state, name)), fillRule)
      : [];
  const strokes = strokeItems(layer, states, name, helpers, fillRule);
  // A trim cuts only the stroke: the stroke gets its own group with the trim, over the fill.
  if (splitTrim && strokes.length && states.some(isTrimmed)) {
    const stroke = basicShapeGroups(layer, states.map((state) => ({ ...state, fill: "none" })), label, helpers, false)
      .map((group) => withTrim(group, trimItem(states, helpers)));
    const fill = paints.kind === "none" ? [] : basicShapeGroups(layer, states.map((state) => ({ ...state, strokeWidth: 0 })), label, helpers, false);
    return [...stroke, ...fill];
  }

  if (states.some((state) => modifiersOf({ ...state, type: layer.type })))
    return parametricGroup(layer, states, name, helpers, paints.kind, fillItems, strokes, true);
  if (layer.type === "path") return pathGroup(layer, states, name, helpers, paints.kind, fillItems, strokes);

  if (needsParametricShape(layer, states)) {
    return parametricGroup(layer, states, name, helpers, paints.kind, fillItems, strokes);
  }

  if (paints.kind === "gradient") {
    const shape = primitiveShape(layer, states, helpers);
    const transform = groupTransform(
      states.map(() => [0, 0]),
      states.map(() => [100, 100]),
      helpers,
    );
    const groups = [makeGroup([shape, ...fillItems, transform], `${layer.name ?? layer.type} Fill`)];
    if (strokes.length) {
      const strokeShape = primitiveShape(layer, states, helpers);
      groups.unshift(makeGroup([strokeShape, ...strokes, groupTransform(states.map(() => [0, 0]), states.map(() => [100, 100]), helpers)], `${layer.name ?? layer.type} Stroke`));
    }
    return groups.filter(Boolean);
  }

  const shape = primitiveShape(layer, states, helpers);
  // Lottie paints shape items in reverse order; SVG paints the stroke over its fill.
  return [makeGroup([shape, ...strokes, ...fillItems, groupTransform(states.map(() => [0, 0]), states.map(() => [100, 100]), helpers)], layer.name ?? layer.type)].filter(Boolean);
}

/** Native shape groups for a centered stroke; alignment requires layer-level mattes. */
export function lottieShapes(layer, states, label, helpers) {
  // A layer whose Fill is turned off exports no fill item; its stored paint is not drawn.
  states = Array.isArray(states) ? states.map(withVisibleFill) : states;
  if (states?.some((state) => (state.strokeAlign ?? "center") !== "center" && finite(state.strokeWidth) > 0 && paintKind(state.stroke, label) !== "none")) {
    throw new Error(`${label ?? layer?.name ?? "Shape"} needs layer-level stroke alignment; use lottieShapeParts.`);
  }
  return basicShapeGroups(layer, states, label, helpers);
}

/** The native Lottie alpha mask for a rectangular box, with the layer's sampled corner radii. */
export function roundedBoxMask(states) {
  if (!Array.isArray(states) || states.length === 0) {
    throw new TypeError("Lottie rounded-box mask requires at least one sampled state.");
  }
  // Resize easing may overshoot a valid non-negative endpoint below zero; the renderer collapses
  // that box to zero size instead of refusing the frame.
  states = states.map((state) => ({
    ...state,
    width: Math.max(0, finite(state.width)),
    height: Math.max(0, finite(state.height)),
  }));
  const rounded = states.some((state) => resolvedCornerRadii(state).some((radius) => radius > 0));
  const shapes = rounded
    ? states.map((state) => contourShape(shapeContours("rectangle", state)[0]))
    : states.map((state) => ({
      c: true,
      v: [[0, 0], [finite(state.width), 0], [finite(state.width), finite(state.height)], [0, finite(state.height)]],
      i: [[0, 0], [0, 0], [0, 0], [0, 0]],
      o: [[0, 0], [0, 0], [0, 0], [0, 0]],
    }));
  const pt = shapeProperty(shapes, { compress: true });
  if (shapePropertyVertexCount(pt) > MAX_PARAMETRIC_VERTICES) {
    throw new RangeError(`Clip content has too much changing rounded-box geometry for a safe Lottie export (limit ${MAX_PARAMETRIC_VERTICES.toLocaleString()} shape vertices). Reduce the export duration or frame rate.`);
  }
  return {
    inv: false,
    mode: "a",
    nm: "Clip content",
    pt,
    o: { a: 0, k: 100 },
    x: { a: 0, k: 0 },
  };
}

function validatePaintGeometry(parts, label) {
  const stack = [parts.content, parts.stroke, parts.matte].flat().filter(Boolean);
  let vertices = 0;
  while (stack.length) {
    const item = stack.pop();
    if (item.ty === "gr") stack.push(...item.it);
    if (item.ty !== "sh") continue;
    vertices += shapePropertyVertexCount(item.ks);
    if (vertices > MAX_PARAMETRIC_VERTICES) {
      throw new RangeError(`${label} has too much changing stroke geometry for a safe Lottie export (limit ${MAX_PARAMETRIC_VERTICES.toLocaleString()} shape vertices). Reduce changing shape samples.`);
    }
  }
}

function strokeBoundsGroup(layer, states, helpers) {
  const cache = new Map();
  const bounds = states.map((state) => {
    let ink = { x: 0, y: 0, width: finite(state.width), height: finite(state.height) };
    if (layer.type === "path") {
      const path = String(state.path ?? "");
      if (!cache.has(path)) cache.set(path, pathBounds(path));
      const original = cache.get(path);
      const scale = pathSizing(state, layer);
      ink = {
        x: original.x * scale.x,
        y: original.y * scale.y,
        width: original.width * scale.x,
        height: original.height * scale.y,
      };
    }
    // A doubled miter stroke can extend ten times the entered weight. The
    // transparent path keeps SVG's default matte region from cropping that ink.
    const outset = Math.max(0, finite(state.strokeWidth)) * 10;
    return {
      center: [ink.x + ink.width / 2, ink.y + ink.height / 2],
      size: [ink.width + outset * 2, ink.height + outset * 2],
    };
  });
  return makeGroup([
    {
      ty: "rc", d: 1,
      p: helpers.property(bounds.map((item) => item.center), 2),
      s: helpers.property(bounds.map((item) => item.size), 2),
      r: { a: 0, k: 0 }, nm: "Stroke bounds", hd: false,
    },
    { ty: "fl", c: { a: 0, k: [0, 0, 0] }, o: { a: 0, k: 0 }, r: 1, bm: 0, nm: "Transparent bounds", hd: false },
    groupTransform(states.map(() => [0, 0]), states.map(() => [100, 100]), helpers),
  ], "Stroke matte bounds");
}

/** Keep original curves and native stroke paint, clipped by an opaque silhouette. */
export function lottieShapeParts(layer, states, label, helpers) {
  requireHelpers(helpers);
  if (!layer || !["rectangle", "ellipse", "path", "star"].includes(layer.type)) return { content: [] };
  if (!Array.isArray(states) || !states.length) throw new TypeError("Lottie shape export requires at least one sampled state.");
  // A layer (or text) whose Fill is turned off exports no fill item. The stroke matte below still
  // uses the shape's silhouette, which does not depend on the fill.
  states = states.map(withVisibleFill);
  const name = String(label ?? `Layer “${layer.name ?? layer.id ?? layer.type}”`);
  const position = states[0].strokeAlign ?? "center";
  if (!["center", "inside", "outside"].includes(position) || states.some((state) => (state.strokeAlign ?? "center") !== position)) {
    throw new Error(`${name} changes stroke position during the animation; native Lottie requires one stroke position per layer.`);
  }
  if (position === "center") return { content: basicShapeGroups(layer, states, name, helpers) };
  const content = basicShapeGroups(layer, states.map((state) => ({ ...state, strokeWidth: 0 })), name, helpers);
  if (!states.some((state) => finite(state.strokeWidth) > 0 && paintKind(state.stroke, name) !== "none")) return { content };
  const stroke = basicShapeGroups(layer, states.map((state) => ({
    ...state, fill: "none", strokeAlign: "center", strokeWidth: Math.max(0, finite(state.strokeWidth)) * 2,
  })), `${name} Stroke`, helpers);
  stroke.push(strokeBoundsGroup(layer, states, helpers));
  const matte = basicShapeGroups(layer, states.map((state) => ({ ...state, fill: "#ffffff", strokeWidth: 0 })), `${name} Silhouette`, helpers);
  const parts = { content, stroke, matte, matteType: position === "inside" ? 1 : 2 };
  validatePaintGeometry(parts, name);
  return parts;
}
