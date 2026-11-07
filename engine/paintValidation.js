// Shared paint validation for whole layers, animations and text style ranges.
const COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;
const fail = (path, message) => { throw new Error(`${path}: ${message}`); };
function requireRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, "must be an object");
  return value;
}
function requireNumber(value, path, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    fail(path, `must be a finite number from ${min} to ${max}`);
  return value;
}
function requireString(value, path, maxLength) {
  if (typeof value !== "string") fail(path, "must be text");
  if (value.length > maxLength) fail(path, `cannot exceed ${maxLength} characters`);
  return value;
}
function requireArray(value, path, maxLength) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > maxLength) fail(path, `cannot contain more than ${maxLength} items`);
  return value;
}
function requireColor(value, path) {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value))
    fail(path, "must be a hex color such as #336699 or #336699cc");
  return value;
}

function normalizeGradient(value, path) {
  const gradient = requireRecord(value, path);
  if (gradient.type !== "linear" && gradient.type !== "radial")
    fail(`${path}.type`, "must be linear or radial");
  // A radial gradient has no direction, so its angle may be left out.
  const angle = gradient.type === "radial" && gradient.angle === undefined ? 0
    : requireNumber(gradient.angle, `${path}.angle`, -36_000, 36_000);
  const stops = requireArray(gradient.stops, `${path}.stops`, 64);
  if (stops.length < 2)
    fail(`${path}.stops`, "must contain at least two color stops");
  let priorOffset = -1;
  const stopIds = new Set();
  const normalizedStops = stops.map((stop, index) => {
    const stopPath = `${path}.stops[${index}]`;
    requireRecord(stop, stopPath);
    if (stop.id !== undefined) {
      const id = requireString(stop.id, `${stopPath}.id`, 256);
      if (!id || stopIds.has(id)) fail(`${stopPath}.id`, "must be a unique non-empty stop identity");
      stopIds.add(id);
    }
    const offset = requireNumber(stop.offset, `${stopPath}.offset`, 0, 1);
    if (offset < priorOffset)
      fail(`${stopPath}.offset`, "stops must be ordered by offset");
    priorOffset = offset;
    return {
      ...stop,
      offset,
      color: requireColor(stop.color, `${stopPath}.color`),
    };
  });
  return { ...gradient, type: gradient.type, angle, stops: normalizedStops };
}

export function normalizeFill(value, path) {
  if (typeof value === "string") return requireColor(value, path);
  return normalizeGradient(value, path);
}
