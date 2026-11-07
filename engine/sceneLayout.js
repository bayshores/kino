/** Artboard positions are presentation coordinates, never part of scene rendering/export. */
export const SCENE_GAP = 120;
export const MAX_CANVAS_COORDINATE = 100_000_000;

/** Legacy files retain their horizontal row and shared vertical center. Missing positions
 * after already-positioned scenes are placed beyond the rightmost existing artboard. */
export function sceneRectangles(scenes = []) {
  let right = 0;
  const centerY = (scenes[0]?.canvasY ?? 0) + (scenes[0]?.height ?? 360) / 2;
  return scenes.map((scene) => {
    const left = scene.canvasX ?? right;
    const top = scene.canvasY ?? centerY - scene.height / 2;
    right = Math.max(right, left + scene.width + SCENE_GAP);
    return { id: scene.id, left, top, width: scene.width, height: scene.height };
  });
}

export function nextScenePosition(scenes) {
  const rectangles = sceneRectangles(scenes);
  if (!rectangles.length) return { canvasX: 0, canvasY: 0 };
  const rightmost = rectangles.reduce((a, b) => a.left + a.width >= b.left + b.width ? a : b);
  return { canvasX: rightmost.left + rightmost.width + SCENE_GAP, canvasY: rightmost.top };
}
