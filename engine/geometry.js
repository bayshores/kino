export const IDENTITY = [1, 0, 0, 1, 0, 0];

// The box a component instance is drawn in: as large as its source scene (see linkedComponents.js).
// Other layers keep their own box; arrange.js geometryOf also measures auto-sized text.
export function componentGeometry(layer, scenes) {
  if (layer.type !== "component") return layer;
  const source = scenes.find((scene) => scene.id === layer.componentSceneId);
  return source ? { ...layer, width: source.width, height: source.height } : layer;
}

export function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function inverse(matrix) {
  const [a, b, c, d, e, f] = matrix,
    determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-9) return null;
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

export function point(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

export function layerMatrix(layer) {
  const angle = ((layer.rotation || 0) * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const a = c * (layer.scaleX ?? 1),
    b = s * (layer.scaleX ?? 1),
    shear = Math.tan(((layer.skewX || 0) * Math.PI) / 180);
  const d = c * (layer.scaleY ?? 1) + b * shear,
    e = -s * (layer.scaleY ?? 1) + a * shear;
  const cx = layer.width / 2,
    cy = layer.height / 2;
  return [
    a,
    b,
    e,
    d,
    layer.x + cx - a * cx - e * cy,
    layer.y + cy - b * cx - d * cy,
  ];
}

export function transformProperties(matrix, width, height) {
  const [a, b, c, d, e, f] = matrix,
    scaleX = Math.hypot(a, b);
  if (scaleX < 1e-9) throw new Error("Reset zero scale before ungrouping.");
  return {
    x: e - width / 2 + (a * width) / 2 + (c * height) / 2,
    y: f - height / 2 + (b * width) / 2 + (d * height) / 2,
    rotation: (Math.atan2(b, a) * 180) / Math.PI,
    scaleX,
    scaleY: (a * d - b * c) / scaleX,
    skewX: (Math.atan((a * c + b * d) / (scaleX * scaleX)) * 180) / Math.PI,
  };
}

export function parentMatrix(layer, layers, evaluate = (value) => value) {
  const ancestors = [],
    visited = new Set([layer.id]);
  let parent = layers.find((item) => item.id === layer.parentId);
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    ancestors.unshift(evaluate(parent));
    parent = layers.find((item) => item.id === parent.parentId);
  }
  return ancestors.reduce(
    (matrix, item) => multiply(matrix, layerMatrix(item)),
    IDENTITY,
  );
}

/**
 * The x and y a layer gets when it moves by (dx, dy) on the canvas (in scene units), whatever
 * its groups and instances are rotated or scaled by: the canvas move is turned into its
 * parent's units. Keep local precision: a one-pixel move under nested 100× scales is only
 * 0.0001 local units. Transform the delta with the linear part so large parent translations
 * do not cancel away that small movement.
 */
export function moveLayerByWorldDelta(layer, layers, dx, dy, evaluate = (value) => value) {
  const toParent = inverse(parentMatrix(layer, layers, evaluate));
  const localX = toParent ? toParent[0] * dx + toParent[2] * dy : dx;
  const localY = toParent ? toParent[1] * dx + toParent[3] * dy : dy;
  const current = evaluate(layer);
  return { x: (current.x ?? 0) + localX, y: (current.y ?? 0) + localY };
}

export function worldMatrix(layer, layers, evaluate = (value) => value) {
  return multiply(
    parentMatrix(layer, layers, evaluate),
    layerMatrix(evaluate(layer)),
  );
}
