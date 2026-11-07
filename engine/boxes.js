// Shared axis-aligned bounds, in scene pixels. Empty input has no box.
export function boxAround(points) {
  if (!points.length) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

export function unionBox(boxes) {
  return boxAround(boxes.flatMap((box) => [{ x: box.left, y: box.top }, { x: box.right, y: box.bottom }]));
}

export function sizedBox(box) {
  return box ? { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top } : null;
}
