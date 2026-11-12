const MAX_PATH_LENGTH = 1_000_000;
const MAX_SEGMENTS = 10_000;
const MAX_CONTOURS = 512;
const NUMBER = /[A-Za-z]|[-+]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][-+]?\d+)?/y;
const ARGUMENTS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };

function finitePoint(value, label = "point") {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  ) {
    throw new Error(`Invalid ${label}: expected two finite coordinates.`);
  }
  return [value[0], value[1]];
}

function tokenizePath(d) {
  if (typeof d !== "string") throw new TypeError("Path data must be a string.");
  if (d.length > MAX_PATH_LENGTH) throw new Error("Path data is too long.");

  const tokens = [];
  let index = 0;
  let previousWasNumber = false;
  while (index < d.length) {
    while (/\s/.test(d[index] ?? "")) index += 1;
    if (index >= d.length) break;

    let comma = false;
    if (d[index] === ",") {
      if (!previousWasNumber) throw new Error("Unexpected comma in path data.");
      comma = true;
      index += 1;
      while (/\s/.test(d[index] ?? "")) index += 1;
      if (index >= d.length || d[index] === ",") {
        throw new Error("Unexpected comma in path data.");
      }
    }

    NUMBER.lastIndex = index;
    const match = NUMBER.exec(d);
    if (!match) throw new Error(`Invalid path data near character ${index}.`);

    const raw = match[0];
    const isCommand = /^[A-Za-z]$/.test(raw);
    if (comma && isCommand) throw new Error("A comma must separate path numbers.");
    if (isCommand) {
      tokens.push({ type: "command", value: raw, raw, start: index, end: NUMBER.lastIndex });
      previousWasNumber = false;
    } else {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error("Path coordinates must be finite.");
      tokens.push({ type: "number", value, raw, start: index, end: NUMBER.lastIndex });
      previousWasNumber = true;
    }
    index = NUMBER.lastIndex;
  }
  return tokens;
}

function readArcGroup(tokens, startIndex) {
  let index = startIndex;
  const readNumber = () => {
    const token = tokens[index];
    if (!token || token.type !== "number") throw new Error("Incomplete A command.");
    index += 1;
    return token;
  };
  const rx = readNumber().value;
  const ry = readNumber().value;
  const rotation = readNumber().value;
  const firstFlagToken = readNumber();
  let raw = firstFlagToken.raw;
  const flags = [];

  const takeFlag = () => {
    if (!/^[01]/.test(raw)) throw new Error("Arc flags must be 0 or 1.");
    flags.push(Number(raw[0]));
    raw = raw.slice(1);
  };
  takeFlag();
  if (/^[01]/.test(raw)) {
    takeFlag();
  } else {
    if (raw) throw new Error("Arc flags must be 0 or 1.");
    const secondFlagToken = readNumber();
    raw = secondFlagToken.raw;
    takeFlag();
  }

  let x;
  if (raw) {
    NUMBER.lastIndex = 0;
    const match = NUMBER.exec(raw);
    if (!match || match[0] !== raw || /^[A-Za-z]$/.test(raw)) {
      throw new Error("Incomplete A command.");
    }
    x = Number(raw);
    if (!Number.isFinite(x)) throw new Error("Path coordinates must be finite.");
  } else {
    x = readNumber().value;
  }
  const y = readNumber().value;
  return { values: [rx, ry, rotation, flags[0], flags[1], x, y], nextIndex: index };
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function scale(a, amount) {
  return [a[0] * amount, a[1] * amount];
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function assertFiniteCoordinates(points) {
  if (!points.flat().every(Number.isFinite)) {
    throw new Error("Path coordinates are outside the supported numeric range.");
  }
}

function lineSegment(from, to) {
  const delta = subtract(to, from);
  return {
    c1: add(from, scale(delta, 1 / 3)),
    c2: add(from, scale(delta, 2 / 3)),
    end: [...to],
  };
}

function cubicFromQuadratic(from, control, end) {
  return {
    c1: add(from, scale(subtract(control, from), 2 / 3)),
    c2: add(end, scale(subtract(control, end), 2 / 3)),
    end: [...end],
  };
}

function ellipsePoint(center, rx, ry, cosPhi, sinPhi, angle) {
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  return [
    center[0] + rx * cosPhi * cosAngle - ry * sinPhi * sinAngle,
    center[1] + rx * sinPhi * cosAngle + ry * cosPhi * sinAngle,
  ];
}

function ellipseDerivative(rx, ry, cosPhi, sinPhi, angle) {
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  return [
    -rx * cosPhi * sinAngle - ry * sinPhi * cosAngle,
    -rx * sinPhi * sinAngle + ry * cosPhi * cosAngle,
  ];
}

function arcSegments(from, rxValue, ryValue, rotation, largeArc, sweep, to) {
  let rx = Math.abs(rxValue);
  let ry = Math.abs(ryValue);
  if (rx === 0 || ry === 0) return [lineSegment(from, to)];
  if (samePoint(from, to)) return [];

  const phi = ((rotation % 360) * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const half = [(from[0] - to[0]) / 2, (from[1] - to[1]) / 2];
  const x1 = cosPhi * half[0] + sinPhi * half[1];
  const y1 = -sinPhi * half[0] + cosPhi * half[1];
  let rx2 = rx * rx;
  let ry2 = ry * ry;
  const x12 = x1 * x1;
  const y12 = y1 * y1;
  const radiusCheck = x12 / rx2 + y12 / ry2;
  if (!Number.isFinite(radiusCheck)) {
    throw new Error("Arc coordinates are too large to convert safely.");
  }
  if (radiusCheck > 1) {
    const multiplier = Math.sqrt(radiusCheck);
    rx *= multiplier;
    ry *= multiplier;
    rx2 = rx * rx;
    ry2 = ry * ry;
  }

  const denominator = rx2 * y12 + ry2 * x12;
  const numerator = Math.max(0, rx2 * ry2 - rx2 * y12 - ry2 * x12);
  const sign = largeArc === sweep ? -1 : 1;
  const factor = denominator === 0 ? 0 : sign * Math.sqrt(numerator / denominator);
  const cxPrime = (factor * rx * y1) / ry;
  const cyPrime = (-factor * ry * x1) / rx;
  const center = [
    cosPhi * cxPrime - sinPhi * cyPrime + (from[0] + to[0]) / 2,
    sinPhi * cxPrime + cosPhi * cyPrime + (from[1] + to[1]) / 2,
  ];
  const unitStart = [(x1 - cxPrime) / rx, (y1 - cyPrime) / ry];
  const unitEnd = [(-x1 - cxPrime) / rx, (-y1 - cyPrime) / ry];
  const startAngle = Math.atan2(unitStart[1], unitStart[0]);
  let delta = Math.atan2(
    unitStart[0] * unitEnd[1] - unitStart[1] * unitEnd[0],
    unitStart[0] * unitEnd[0] + unitStart[1] * unitEnd[1],
  );
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;

  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / count;
  const result = [];
  for (let i = 0; i < count; i += 1) {
    const a0 = startAngle + step * i;
    const a1 = a0 + step;
    const alpha = (4 / 3) * Math.tan((a1 - a0) / 4);
    const p0 = ellipsePoint(center, rx, ry, cosPhi, sinPhi, a0);
    const p1 = ellipsePoint(center, rx, ry, cosPhi, sinPhi, a1);
    result.push({
      c1: add(p0, scale(ellipseDerivative(rx, ry, cosPhi, sinPhi, a0), alpha)),
      c2: subtract(p1, scale(ellipseDerivative(rx, ry, cosPhi, sinPhi, a1), alpha)),
      end: i === count - 1 ? [...to] : p1,
    });
  }
  for (const segment of result) {
    if (![...segment.c1, ...segment.c2, ...segment.end].every(Number.isFinite)) {
      throw new Error("Arc coordinates are too large to convert safely.");
    }
  }
  return result;
}

/** Parse SVG path data and convert every drawable command to cubic Bezier segments. */
export function parsePath(d) {
  const tokens = tokenizePath(d);
  if (tokens.length === 0) return [];

  const contours = [];
  let contour = null;
  let current = [0, 0];
  let previousCubicControl = null;
  let previousQuadraticControl = null;
  let previousCommand = null;
  let activeCommand = null;
  let segmentCount = 0;
  let tokenIndex = 0;

  const append = (segment) => {
    if (!contour) throw new Error("A move command must start each path contour.");
    assertFiniteCoordinates([segment.c1, segment.c2, segment.end]);
    contour.segments.push(segment);
    current = [...segment.end];
    segmentCount += 1;
    if (segmentCount > MAX_SEGMENTS) throw new Error("Path has too many segments.");
  };

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    if (token.type === "command") {
      activeCommand = token.value;
      tokenIndex += 1;
    } else if (!activeCommand) {
      throw new Error("Path data must begin with a move command.");
    }

    if (!activeCommand) throw new Error("Missing path command.");
    const upper = activeCommand.toUpperCase();
    const relative = activeCommand !== upper;
    if (upper === "Z") {
      if (!contour && contours.length === 0) {
        throw new Error("Close command requires a preceding move command.");
      }
      if (contour) {
        current = [...contour.start];
        contour.closed = true;
        contour = null;
      }
      previousCubicControl = null;
      previousQuadraticControl = null;
      previousCommand = "Z";
      activeCommand = null;
      continue;
    }

    const argumentCount = ARGUMENTS[upper];
    if (!argumentCount) throw new Error(`Unsupported path command: ${activeCommand}.`);
    let groups = 0;
    let repeatedCommand = activeCommand;

    while (tokenIndex < tokens.length && tokens[tokenIndex].type === "number") {
      let values;
      if (upper === "A") {
        const group = readArcGroup(tokens, tokenIndex);
        values = group.values;
        tokenIndex = group.nextIndex;
      } else {
        if (tokenIndex + argumentCount > tokens.length) {
          throw new Error(`Incomplete ${activeCommand} command.`);
        }
        const group = tokens.slice(tokenIndex, tokenIndex + argumentCount);
        if (group.some((item) => item.type !== "number")) {
          throw new Error(`Incomplete ${activeCommand} command.`);
        }
        values = group.map((item) => item.value);
        tokenIndex += argumentCount;
      }
      groups += 1;

      const absolutePoint = (x, y) => {
        const point = relative ? [current[0] + x, current[1] + y] : [x, y];
        assertFiniteCoordinates([point]);
        return point;
      };

      if (upper === "M") {
        const point = absolutePoint(values[0], values[1]);
        if (groups === 1) {
          if (contours.length >= MAX_CONTOURS) throw new Error("Path has too many contours.");
          contour = { start: [...point], segments: [], closed: false };
          contours.push(contour);
          current = [...point];
          repeatedCommand = relative ? "l" : "L";
        } else {
          append(lineSegment(current, point));
        }
        previousCubicControl = null;
        previousQuadraticControl = null;
        previousCommand = groups === 1 ? "M" : "L";
        continue;
      }

      if (!contour) {
        if (previousCommand !== "Z") {
          throw new Error("A move command must start each path contour.");
        }
        if (contours.length >= MAX_CONTOURS) throw new Error("Path has too many contours.");
        contour = { start: [...current], segments: [], closed: false };
        contours.push(contour);
      }
      let end;
      switch (upper) {
        case "L":
          end = absolutePoint(values[0], values[1]);
          append(lineSegment(current, end));
          previousCubicControl = null;
          previousQuadraticControl = null;
          previousCommand = "L";
          break;
        case "H":
          end = [relative ? current[0] + values[0] : values[0], current[1]];
          append(lineSegment(current, end));
          previousCubicControl = null;
          previousQuadraticControl = null;
          previousCommand = "H";
          break;
        case "V":
          end = [current[0], relative ? current[1] + values[0] : values[0]];
          append(lineSegment(current, end));
          previousCubicControl = null;
          previousQuadraticControl = null;
          previousCommand = "V";
          break;
        case "C": {
          const c1 = absolutePoint(values[0], values[1]);
          const c2 = absolutePoint(values[2], values[3]);
          end = absolutePoint(values[4], values[5]);
          append({ c1, c2, end });
          previousCubicControl = c2;
          previousQuadraticControl = null;
          previousCommand = "C";
          break;
        }
        case "S": {
          const c1 = ["C", "S"].includes(previousCommand)
            ? [2 * current[0] - previousCubicControl[0], 2 * current[1] - previousCubicControl[1]]
            : [...current];
          const c2 = absolutePoint(values[0], values[1]);
          end = absolutePoint(values[2], values[3]);
          append({ c1, c2, end });
          previousCubicControl = c2;
          previousQuadraticControl = null;
          previousCommand = "S";
          break;
        }
        case "Q": {
          const control = absolutePoint(values[0], values[1]);
          end = absolutePoint(values[2], values[3]);
          append(cubicFromQuadratic(current, control, end));
          previousCubicControl = null;
          previousQuadraticControl = control;
          previousCommand = "Q";
          break;
        }
        case "T": {
          const control = ["Q", "T"].includes(previousCommand)
            ? [2 * current[0] - previousQuadraticControl[0], 2 * current[1] - previousQuadraticControl[1]]
            : [...current];
          end = absolutePoint(values[0], values[1]);
          append(cubicFromQuadratic(current, control, end));
          previousCubicControl = null;
          previousQuadraticControl = control;
          previousCommand = "T";
          break;
        }
        case "A": {
          const largeArc = values[3];
          const sweep = values[4];
          if (![largeArc, sweep].every((flag) => flag === 0 || flag === 1)) {
            throw new Error("Arc flags must be 0 or 1.");
          }
          end = absolutePoint(values[5], values[6]);
          const segments = arcSegments(current, values[0], values[1], values[2], largeArc === 1, sweep === 1, end);
          for (const segment of segments) append(segment);
          previousCubicControl = null;
          previousQuadraticControl = null;
          previousCommand = "A";
          break;
        }
        default:
          throw new Error(`Unsupported path command: ${activeCommand}.`);
      }
    }

    if (groups === 0) throw new Error(`Command ${activeCommand} needs coordinates.`);
    activeCommand = repeatedCommand;
  }

  return contours;
}

function cleanNumber(value) {
  if (!Number.isFinite(value)) throw new Error("Path coordinates must be finite.");
  return Object.is(value, -0) ? "0" : String(value);
}

/** Serialize cubic contours into canonical M/C/Z path data. */
export function serializePath(contours) {
  if (!Array.isArray(contours)) throw new TypeError("Contours must be an array.");
  if (contours.length > MAX_CONTOURS) throw new Error("Path has too many contours.");
  let totalSegments = 0;
  const commands = [];
  for (const contour of contours) {
    const start = finitePoint(contour?.start, "contour start");
    if (!Array.isArray(contour.segments)) throw new Error("Contour segments must be an array.");
    if (typeof contour.closed !== "boolean") throw new Error("Contour closed state must be boolean.");
    totalSegments += contour.segments.length;
    if (totalSegments > MAX_SEGMENTS) throw new Error("Path has too many segments.");
    const pieces = [`M${cleanNumber(start[0])} ${cleanNumber(start[1])}`];
    for (const segment of contour.segments) {
      const c1 = finitePoint(segment?.c1, "first control point");
      const c2 = finitePoint(segment?.c2, "second control point");
      const end = finitePoint(segment?.end, "segment endpoint");
      pieces.push(
        `C${cleanNumber(c1[0])} ${cleanNumber(c1[1])} ${cleanNumber(c2[0])} ${cleanNumber(c2[1])} ${cleanNumber(end[0])} ${cleanNumber(end[1])}`,
      );
    }
    if (contour.closed) pieces.push("Z");
    commands.push(pieces.join(" "));
  }
  const output = commands.join(" ");
  if (output.length > MAX_PATH_LENGTH) throw new Error("Serialized path is too long.");
  return output;
}

function cubicValue(p0, p1, p2, p3, t) {
  const inverse = 1 - t;
  return (
    inverse * inverse * inverse * p0 +
    3 * inverse * inverse * t * p1 +
    3 * inverse * t * t * p2 +
    t * t * t * p3
  );
}

function cubicExtrema(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  if (a === 0) return b === 0 ? [] : [-c / b].filter((t) => t > 0 && t < 1);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  const values = [(-b + root) / (2 * a), (-b - root) / (2 * a)];
  return values.filter((t) => Number.isFinite(t) && t > 0 && t < 1);
}

/** Return the exact axis-aligned bounds of a path's cubic contours. */
export function pathBounds(d) {
  return contourBounds(parsePath(d));
}

/** The exact axis-aligned bounds of cubic contours, as parsePath returns them. */
export function contourBounds(contours) {
  if (contours.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const contour of contours) {
    let start = contour.start;
    include(start[0], start[1]);
    for (const segment of contour.segments) {
      include(segment.end[0], segment.end[1]);
      for (const t of cubicExtrema(start[0], segment.c1[0], segment.c2[0], segment.end[0])) {
        include(cubicValue(start[0], segment.c1[0], segment.c2[0], segment.end[0], t), cubicValue(start[1], segment.c1[1], segment.c2[1], segment.end[1], t));
      }
      for (const t of cubicExtrema(start[1], segment.c1[1], segment.c2[1], segment.end[1])) {
        include(cubicValue(start[0], segment.c1[0], segment.c2[0], segment.end[0], t), cubicValue(start[1], segment.c1[1], segment.c2[1], segment.end[1], t));
      }
      start = segment.end;
    }
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new Error("Path bounds are outside the supported numeric range.");
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Path bounds are outside the supported numeric range.");
  }
  return { x: minX, y: minY, width, height };
}

function midpoint(a, b) {
  return [a[0] / 2 + b[0] / 2, a[1] / 2 + b[1] / 2];
}

function splitSegment(start, segment) {
  const a = midpoint(start, segment.c1);
  const b = midpoint(segment.c1, segment.c2);
  const c = midpoint(segment.c2, segment.end);
  const d = midpoint(a, b);
  const e = midpoint(b, c);
  const center = midpoint(d, e);
  return [
    { c1: a, c2: d, end: center },
    { c1: e, c2: c, end: [...segment.end] },
  ];
}

function segmentLengthEstimate(start, segment) {
  const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  return (
    distance(start, segment.c1) +
    distance(segment.c1, segment.c2) +
    distance(segment.c2, segment.end)
  );
}

function heapBefore(a, b) {
  return a.length > b.length || (a.length === b.length && a.order < b.order);
}

function heapPush(heap, node) {
  let index = heap.length;
  heap.push(node);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!heapBefore(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function heapPop(heap) {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < heap.length && heapBefore(heap[left], heap[largest])) largest = left;
      if (right < heap.length && heapBefore(heap[right], heap[largest])) largest = right;
      if (largest === index) break;
      [heap[index], heap[largest]] = [heap[largest], heap[index]];
      index = largest;
    }
  }
  return first;
}

function equalizeSegments(contour, targetCount) {
  if (contour.segments.length === 0 && targetCount > 0) {
    contour.segments.push({ c1: [...contour.start], c2: [...contour.start], end: [...contour.start] });
  }
  let segmentCount = contour.segments.length;
  const heap = [];
  let head = null;
  let tail = null;
  let order = 0;
  let cursor = contour.start;
  for (const segment of contour.segments) {
    const node = {
      segment,
      start: cursor,
      prev: tail,
      next: null,
      length: segmentLengthEstimate(cursor, segment),
      order: order++,
    };
    if (tail) tail.next = node;
    else head = node;
    tail = node;
    cursor = segment.end;
    heapPush(heap, node);
  }

  while (segmentCount < targetCount) {
    const longest = heapPop(heap);
    if (!longest) throw new Error("Could not match path segment counts.");
    const [left, right] = splitSegment(longest.start, longest.segment);
    const makeNode = (segment, start) => ({
      segment,
      start,
      prev: null,
      next: null,
      length: segmentLengthEstimate(start, segment),
      order: order++,
    });
    const leftNode = makeNode(left, longest.start);
    const rightNode = makeNode(right, left.end);
    leftNode.prev = longest.prev;
    leftNode.next = rightNode;
    rightNode.prev = leftNode;
    rightNode.next = longest.next;
    if (longest.prev) longest.prev.next = leftNode;
    else head = leftNode;
    if (longest.next) longest.next.prev = rightNode;
    else tail = rightNode;
    heapPush(heap, leftNode);
    heapPush(heap, rightNode);
    segmentCount += 1;
  }

  if (contour.segments.length > 0) {
    const ordered = [];
    for (let node = head; node; node = node.next) ordered.push(node.segment);
    contour.segments = ordered;
  }
}

function interpolatePoint(a, b, progress) {
  return [a[0] + (b[0] - a[0]) * progress, a[1] + (b[1] - a[1]) * progress];
}

/** Subdivide corresponding contours without changing their curve geometry. */
function matchContourSets(sets) {
  const reference = sets[0];
  if (!reference) return sets;
  for (const contours of sets) {
    if (contours.length !== reference.length) {
      throw new Error("Paths must have the same number of corresponding contours.");
    }
    for (let index = 0; index < contours.length; index += 1) {
      if (contours[index].closed !== reference[index].closed) {
        throw new Error(`Path contour ${index + 1} must be open in both paths or closed in both paths.`);
      }
    }
  }
  for (let index = 0; index < reference.length; index += 1) {
    const count = Math.max(...sets.map((contours) => contours[index].segments.length));
    for (const contours of sets) equalizeSegments(contours[index], count);
  }
  return sets;
}

export function matchPathContours(paths) {
  if (!Array.isArray(paths)) throw new TypeError("Paths must be an array.");
  return matchContourSets(paths.map(parsePath));
}

/** Interpolate corresponding cubic paths, splitting long curves to match topology. */
export function interpolatePath(from, to, progress) {
  if (!Number.isFinite(progress)) throw new TypeError("Path progress must be finite.");
  if (typeof from !== "string" || typeof to !== "string") {
    throw new TypeError("Both paths must be strings.");
  }
  const left = parsePath(from);
  const right = parsePath(to);
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  matchContourSets([left, right]);

  const mixed = left.map((a, index) => {
    const b = right[index];
    return {
      start: interpolatePoint(a.start, b.start, progress),
      closed: a.closed,
      segments: a.segments.map((segment, segmentIndex) => ({
        c1: interpolatePoint(segment.c1, b.segments[segmentIndex].c1, progress),
        c2: interpolatePoint(segment.c2, b.segments[segmentIndex].c2, progress),
        end: interpolatePoint(segment.end, b.segments[segmentIndex].end, progress),
      })),
    };
  });
  return serializePath(mixed);
}
