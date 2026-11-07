// Geometry shared by box hit testing and selection. The renderer draws rounded corners with
// cubic Beziers; point checks use ideal circles, and marquee checks flatten those arcs. Their
// small local-coordinate differences scale with the group's transforms.
import { effectiveBoxStyle } from "./boxStyles.js";
import { isFillEnabled } from "./paints.js";
import { resolvedCornerRadii } from "./shapes.js";

const keepValue = (layer) => layer;
const EPSILON = 1e-9;

function evaluatedBox(layer, evaluate) {
  return evaluate(effectiveBoxStyle(layer));
}

function paintIsVisible(paint) {
  if (typeof paint === "string") {
    const value = paint.toLowerCase();
    if (/^#[\da-f]{4}$/.test(value)) return value[4] !== "0";
    if (/^#[\da-f]{8}$/.test(value)) return Number.parseInt(value.slice(7), 16) > 0;
    return value !== "none";
  }
  if (paint && typeof paint === "object" && Array.isArray(paint.stops))
    return paint.stops.some((stop) => paintIsVisible(stop?.color));
  return false;
}

/** A concise reason a group has visible box paint that reparenting or ungrouping would lose. */
export function visibleBoxStyleEffect(layer) {
  const style = effectiveBoxStyle(layer);
  if (isFillEnabled(style) && paintIsVisible(style.fill)) return "has a fill";
  if (Number.isFinite(style.strokeWidth) && style.strokeWidth > 0 && paintIsVisible(style.stroke)) return "has a stroke";
  return null;
}

function pointInRoundedRect(state, at) {
  const width = state.width,
    height = state.height;
  if (!(width > 0) || !(height > 0) || at.x < -EPSILON || at.y < -EPSILON || at.x > width + EPSILON || at.y > height + EPSILON)
    return false;
  const [topLeft, topRight, bottomRight, bottomLeft] = resolvedCornerRadii(state);
  const inCorner = (x, y, radius, centerX, centerY) =>
    radius <= 0 || (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2 + EPSILON * Math.max(1, radius ** 2);
  if (at.x < topLeft && at.y < topLeft) return inCorner(at.x, at.y, topLeft, topLeft, topLeft);
  if (at.x > width - topRight && at.y < topRight) return inCorner(at.x, at.y, topRight, width - topRight, topRight);
  if (at.x > width - bottomRight && at.y > height - bottomRight)
    return inCorner(at.x, at.y, bottomRight, width - bottomRight, height - bottomRight);
  if (at.x < bottomLeft && at.y > height - bottomLeft)
    return inCorner(at.x, at.y, bottomLeft, bottomLeft, height - bottomLeft);
  return true;
}

/** Point containment in an evaluated box's ideal circular corners, in that box's local space. */
export function roundedBoxContainsLocalPoint(layer, at, evaluate = keepValue) {
  return pointInRoundedRect(evaluatedBox(layer, evaluate), at);
}
