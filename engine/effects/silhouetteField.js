import { parsePath } from "../vectorPath.js";

const MAX_GRID_SIDE = 256;
const MAX_CACHE_ENTRIES = 16;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_FLATTEN_WORK = 250_000;
const MAX_FLATTENED_EDGES = 65_536;
const MAX_DISTANCE_TESTS = 48_000_000;
const MAX_FILL_TESTS = 16_000_000;
const MAX_TOPOLOGY_TESTS = 16_000_000;
const MAX_SAFE_COORDINATE = 1e150;
const MAX_FLOAT32 = 3.4028234663852886e38;
const cache = new Map();
let cacheBytes = 0;

function validateInput(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("silhouetteField expects an options object.");
  }
  const { path, fillRule = "nonzero", bounds } = options;
  if (typeof path !== "string") throw new TypeError("Silhouette path must be a string.");
  if (fillRule !== "nonzero" && fillRule !== "evenodd") {
    throw new TypeError('fillRule must be "nonzero" or "evenodd".');
  }
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
    throw new TypeError("Silhouette bounds must be an object.");
  }
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new RangeError("Silhouette bounds must have finite x/y and positive finite width/height.");
  }
  const right = x + width;
  const bottom = y + height;
  if (
    !Number.isFinite(right) || !Number.isFinite(bottom) || right <= x || bottom <= y ||
    [x, y, right, bottom, width, height].some((value) => Math.abs(value) > MAX_SAFE_COORDINATE)
  ) {
    throw new RangeError("Silhouette bounds exceed the finite-distance coordinate range.");
  }
  return { path, fillRule, bounds: { x, y, width, height } };
}

function cacheKey({ path, fillRule, bounds }) {
  return JSON.stringify([path, fillRule, bounds.x, bounds.y, bounds.width, bounds.height]);
}

function gridDimensions(bounds) {
  const scale = Math.min(1, MAX_GRID_SIDE / Math.max(bounds.width, bounds.height));
  return {
    width: Math.max(2, Math.floor(bounds.width * scale)),
    height: Math.max(2, Math.floor(bounds.height * scale)),
  };
}

function pointSegmentDistance(x, y, edge) {
  const vx = edge.bx - edge.ax;
  const vy = edge.by - edge.ay;
  const lengthSquared = vx * vx + vy * vy;
  let amount = 0;
  if (lengthSquared > 0) {
    amount = Math.max(0, Math.min(1, ((x - edge.ax) * vx + (y - edge.ay) * vy) / lengthSquared));
  }
  return Math.hypot(x - (edge.ax + amount * vx), y - (edge.ay + amount * vy));
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function splitCubic(curve) {
  const a = midpoint(curve.p0, curve.p1);
  const b = midpoint(curve.p1, curve.p2);
  const c = midpoint(curve.p2, curve.p3);
  const d = midpoint(a, b);
  const e = midpoint(b, c);
  const middle = midpoint(d, e);
  return [
    { p0: curve.p0, p1: a, p2: d, p3: middle, depth: curve.depth + 1 },
    { p0: middle, p1: e, p2: c, p3: curve.p3, depth: curve.depth + 1 },
  ];
}

function flattenContours(contours, tolerance, bounds) {
  const edges = [];
  let work = 0;
  const addEdge = (from, to) => {
    if (edges.length >= MAX_FLATTENED_EDGES) {
      throw new RangeError(`Silhouette field refused path: curve flattening exceeded ${MAX_FLATTENED_EDGES} edges.`);
    }
    const ax = from[0];
    const ay = from[1];
    const bx = to[0];
    const by = to[1];
    if (![ax, ay, bx, by].every(Number.isFinite) || [ax, ay, bx, by].some((value) => Math.abs(value) > MAX_SAFE_COORDINATE)) {
      throw new RangeError("Silhouette path coordinates exceed the finite-distance range.");
    }
    edges.push({
      ax,
      ay,
      bx,
      by,
      minX: Math.min(ax, bx),
      maxX: Math.max(ax, bx),
      minY: Math.min(ay, by),
      maxY: Math.max(ay, by),
    });
  };
  const localPoint = (point) => [point[0] - bounds.x, point[1] - bounds.y];

  for (const contour of contours) {
    let current = localPoint(contour.start);
    for (const segment of contour.segments) {
      const stack = [{
        p0: current,
        p1: localPoint(segment.c1),
        p2: localPoint(segment.c2),
        p3: localPoint(segment.end),
        depth: 0,
      }];
      while (stack.length) {
        work += 1;
        if (work > MAX_FLATTEN_WORK) {
          throw new RangeError(`Silhouette field refused path: curve flattening exceeded ${MAX_FLATTEN_WORK} work steps.`);
        }
        const curve = stack.pop();
        const flatness = Math.max(
          pointSegmentDistance(curve.p1[0], curve.p1[1], {
            ax: curve.p0[0], ay: curve.p0[1], bx: curve.p3[0], by: curve.p3[1],
          }),
          pointSegmentDistance(curve.p2[0], curve.p2[1], {
            ax: curve.p0[0], ay: curve.p0[1], bx: curve.p3[0], by: curve.p3[1],
          }),
        );
        if (flatness <= tolerance) {
          addEdge(curve.p0, curve.p3);
          continue;
        }
        if (curve.depth >= 24) {
          throw new RangeError("Silhouette field refused path: curve flattening could not meet the grid tolerance.");
        }
        const [left, right] = splitCubic(curve);
        stack.push(right, left);
      }
      current = localPoint(segment.end);
    }
    // SVG fill implicitly closes open subpaths as well as those ending in Z.
    if (contour.segments.length > 0) addEdge(current, localPoint(contour.start));
  }
  return edges;
}

function isFilledAt(edges, fillRule, x, y) {
  let winding = 0;
  let crossings = 0;
  for (const edge of edges) {
    const crosses = (edge.ay <= y && edge.by > y) || (edge.by <= y && edge.ay > y);
    if (!crosses) continue;
    const crossX = edge.ax + ((y - edge.ay) / (edge.by - edge.ay)) * (edge.bx - edge.ax);
    if (crossX <= x) {
      winding += edge.by > edge.ay ? 1 : -1;
      crossings += 1;
    }
  }
  return fillRule === "evenodd" ? crossings % 2 === 1 : winding !== 0;
}

function silhouetteBoundaryEdges(edges, fillRule, tolerance, cellWidth, cellHeight) {
  const topologyTests = edges.length * edges.length * 2;
  if (topologyTests > MAX_TOPOLOGY_TESTS) {
    throw new RangeError(
      `Silhouette field refused path: ${topologyTests.toLocaleString("en-US")} contour tests exceed the ${MAX_TOPOLOGY_TESTS.toLocaleString("en-US")} topology work limit.`,
    );
  }
  const probeOffset = Math.min(cellWidth, cellHeight) * 1e-5;
  const boundary = [];
  for (const edge of edges) {
    const dx = edge.bx - edge.ax;
    const dy = edge.by - edge.ay;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const middleX = (edge.ax + edge.bx) / 2;
    const middleY = (edge.ay + edge.by) / 2;
    const offset = Math.max(Number.MIN_VALUE, Math.min(probeOffset, tolerance * 0.25, length * 1e-4));
    const nx = -dy / length;
    const ny = dx / length;
    const leftFilled = isFilledAt(edges, fillRule, middleX + nx * offset, middleY + ny * offset);
    const rightFilled = isFilledAt(edges, fillRule, middleX - nx * offset, middleY - ny * offset);
    if (leftFilled !== rightFilled) boundary.push(edge);
  }
  return boundary;
}

function fillScanlines(edges, fillRule, width, height, cellWidth, cellHeight) {
  const inside = new Uint8Array(width * height);
  const events = [];
  for (let row = 0; row < height; row += 1) {
    const y = (row + 0.5) * cellHeight;
    events.length = 0;
    for (const edge of edges) {
      const crosses = (edge.ay <= y && edge.by > y) || (edge.by <= y && edge.ay > y);
      if (!crosses) continue;
      const amount = (y - edge.ay) / (edge.by - edge.ay);
      events.push({
        x: edge.ax + amount * (edge.bx - edge.ax),
        direction: edge.by > edge.ay ? 1 : -1,
      });
    }
    events.sort((left, right) => left.x - right.x);

    let eventIndex = 0;
    let winding = 0;
    let crossings = 0;
    for (let column = 0; column < width; column += 1) {
      const x = (column + 0.5) * cellWidth;
      while (eventIndex < events.length && events[eventIndex].x <= x) {
        const eventX = events[eventIndex].x;
        let groupDirection = 0;
        let groupCount = 0;
        while (eventIndex < events.length && events[eventIndex].x === eventX) {
          groupDirection += events[eventIndex].direction;
          groupCount += 1;
          eventIndex += 1;
        }
        winding += groupDirection;
        crossings += groupCount;
      }
      const filled = fillRule === "evenodd" ? crossings % 2 === 1 : winding !== 0;
      if (filled) inside[row * width + column] = 1;
    }
  }
  return inside;
}

function buildField({ path, fillRule, bounds }) {
  const { width, height } = gridDimensions(bounds);
  const cellWidth = bounds.width / width;
  const cellHeight = bounds.height / height;
  if (!(cellWidth > 0) || !(cellHeight > 0)) {
    throw new RangeError("Silhouette bounds are too small for a Float32 field.");
  }

  const contours = parsePath(path);
  const tolerance = Math.max(Number.MIN_VALUE, Math.min(cellWidth, cellHeight) * 0.2);
  const edges = flattenContours(contours, tolerance, bounds);
  const boundaryEdges = silhouetteBoundaryEdges(edges, fillRule, tolerance, cellWidth, cellHeight);
  const sampleCount = width * height;
  const fillTests = height * edges.length;
  if (fillTests > MAX_FILL_TESTS) {
    throw new RangeError(
      `Silhouette field refused path: ${fillTests.toLocaleString("en-US")} scanline tests exceed the ${MAX_FILL_TESTS.toLocaleString("en-US")} fill work limit.`,
    );
  }
  const distanceTests = sampleCount * boundaryEdges.length;
  if (distanceTests > MAX_DISTANCE_TESTS) {
    throw new RangeError(
      `Silhouette field refused path: ${distanceTests.toLocaleString("en-US")} distance tests exceed the ${MAX_DISTANCE_TESTS.toLocaleString("en-US")} work limit.`,
    );
  }

  const distances = new Float32Array(sampleCount);
  const normalX = new Float32Array(sampleCount);
  const normalY = new Float32Array(sampleCount);
  const boundsDiagonal = Math.min(MAX_FLOAT32, Math.hypot(bounds.width, bounds.height));
  if (edges.length === 0) {
    distances.fill(-boundsDiagonal);
  } else {
    const inside = fillScanlines(edges, fillRule, width, height, cellWidth, cellHeight);
    if (boundaryEdges.length === 0) {
      for (let index = 0; index < sampleCount; index += 1) {
        distances[index] = inside[index] ? boundsDiagonal : -boundsDiagonal;
      }
    } else {
      for (let row = 0; row < height; row += 1) {
        const y = (row + 0.5) * cellHeight;
        for (let column = 0; column < width; column += 1) {
          const index = row * width + column;
          const x = (column + 0.5) * cellWidth;
          let nearest = Infinity;
          for (const edge of boundaryEdges) {
            if (nearest !== Infinity) {
              const dx = Math.max(edge.minX - x, 0, x - edge.maxX);
              const dy = Math.max(edge.minY - y, 0, y - edge.maxY);
              if (Math.hypot(dx, dy) >= nearest) continue;
            }
            const distance = pointSegmentDistance(x, y, edge);
            if (distance < nearest) nearest = distance;
          }
          const safeDistance = Math.min(MAX_FLOAT32, Number.isFinite(nearest) ? nearest : boundsDiagonal);
          distances[index] = inside[index] ? safeDistance : -safeDistance;
        }
      }
    }

    if (boundaryEdges.length > 0) {
      for (let row = 0; row < height; row += 1) {
        const previousRow = Math.max(0, row - 1);
        const nextRow = Math.min(height - 1, row + 1);
        for (let column = 0; column < width; column += 1) {
          const previousColumn = Math.max(0, column - 1);
          const nextColumn = Math.min(width - 1, column + 1);
          const dx = (distances[row * width + nextColumn] - distances[row * width + previousColumn]) /
            ((nextColumn - previousColumn) * cellWidth || 1);
          const dy = (distances[nextRow * width + column] - distances[previousRow * width + column]) /
            ((nextRow - previousRow) * cellHeight || 1);
          const length = Math.hypot(dx, dy);
          const index = row * width + column;
          if (length > 1e-8 && Number.isFinite(length)) {
            normalX[index] = dx / length;
            normalY[index] = dy / length;
          }
        }
      }
    }
  }

  const sample = (u, v) => {
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      throw new TypeError("Silhouette sample coordinates must be finite normalized numbers.");
    }
    const gridX = Math.max(0, Math.min(width - 1, Math.max(0, Math.min(1, u)) * width - 0.5));
    const gridY = Math.max(0, Math.min(height - 1, Math.max(0, Math.min(1, v)) * height - 0.5));
    const x0 = Math.floor(gridX);
    const y0 = Math.floor(gridY);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = gridX - x0;
    const ty = gridY - y0;
    const interpolate = (values) => {
      const topLeft = values[y0 * width + x0];
      const topRight = values[y0 * width + x1];
      const bottomLeft = values[y1 * width + x0];
      const bottomRight = values[y1 * width + x1];
      const top = topLeft + (topRight - topLeft) * tx;
      const bottom = bottomLeft + (bottomRight - bottomLeft) * tx;
      return top + (bottom - top) * ty;
    };
    const distance = interpolate(distances);
    const rawX = interpolate(normalX);
    const rawY = interpolate(normalY);
    const normalLength = Math.hypot(rawX, rawY);
    return normalLength > 1e-8
      ? { distance, nx: rawX / normalLength, ny: rawY / normalLength }
      : { distance, nx: 0, ny: 0 };
  };

  return {
    width,
    height,
    bounds: { ...bounds },
    distances,
    normalX,
    normalY,
    sample,
  };
}

function fieldBytes(field) {
  return field.distances.byteLength + field.normalX.byteLength + field.normalY.byteLength;
}

function removeOldestCacheEntry() {
  const oldestKey = cache.keys().next().value;
  const oldest = cache.get(oldestKey);
  cache.delete(oldestKey);
  cacheBytes -= fieldBytes(oldest);
}

export function silhouetteField(options) {
  const input = validateInput(options);
  const key = cacheKey(input);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const field = buildField(input);
  const bytes = fieldBytes(field);
  if (bytes <= MAX_CACHE_BYTES) {
    while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) {
      removeOldestCacheEntry();
    }
    cache.set(key, field);
    cacheBytes += bytes;
  }
  return field;
}

export function clearSilhouetteFieldCache() {
  cache.clear();
  cacheBytes = 0;
}

export function silhouetteFieldCacheStats() {
  return {
    entries: cache.size,
    bytes: cacheBytes,
    maxEntries: MAX_CACHE_ENTRIES,
    maxBytes: MAX_CACHE_BYTES,
  };
}
