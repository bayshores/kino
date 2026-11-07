import { boxScaleMatrix, scaleSelection } from "./multiTransform.js";
import { UnevenStretchError } from "./groupResize.js";
import { fixedPoint, placeResized, resizeBox } from "./transformMath.js";

/** Calculate a whole resize before opening an undo step or writing the document. */
export function selectionResizeAt(start, ids, box, dx, dy, h, v, options = {}) {
  const calculate = (keepAspect) => {
    const modifiers = { keepAspect, fromCenter: options.fromCenter };
    // This is a world-space selection union, so it may be larger than a single layer.
    // scaleSelection still validates the resulting values for each target.
    const size = resizeBox(box, { dx, dy, h, v, ...modifiers, max: Infinity });
    // Numeric controls may choose the same fixed point explicitly instead of a pointer handle.
    const destination = { ...size, ...placeResized(box, { ...box, ...size }, options.pivot ?? fixedPoint(h, v, modifiers)) };
    const transform = boxScaleMatrix(box, destination);
    return { size, transform, changes: scaleSelection(start, ids, transform, options) };
  };
  try {
    return calculate(Boolean(options.keepAspect));
  } catch (error) {
    if (!(error instanceof UnevenStretchError) || options.keepAspect) throw error;
    return { ...calculate(true), reason: error.reason };
  }
}
