import { point } from "../engine/geometry.js";

/** Clip the already transformed and filtered unit in its containing composition coordinates. */
export function clipTextLayer(content, states, parentMatrices, compose) {
  const count = Math.max(0, ...states.map((state) => state._textClips?.length ?? 0));
  if (!count) return content;
  if (typeof compose !== "function") throw new Error("Clipped text export requires a composition callback.");
  let result = content;
  for (let clip = 0; clip < count; clip++) {
    const shapes = states.map((state, index) => {
      const polygon = state._textClips?.[clip] ?? Array.from({ length: 4 }, () => ({ x: 0, y: 0 }));
      const v = polygon.map(({ x, y }) => { const mapped = point(parentMatrices[index], x, y); return [mapped.x, mapped.y]; });
      return { c: true, v, i: v.map(() => [0, 0]), o: v.map(() => [0, 0]) };
    });
    const same = shapes.every((shape) => JSON.stringify(shape) === JSON.stringify(shapes[0]));
    const pt = same ? { a: 0, k: shapes[0] } : { a: 1, k: shapes.map((shape, index) => ({
      t: index, s: [shape], ...(shapes[index + 1] ? { e: [shapes[index + 1]], i: { x: 1, y: 1 }, o: { x: 0, y: 0 } } : { h: 1 }),
    })) };
    result = compose([result], `${content.nm} clip ${clip + 1}`, { precompose: true });
    result.hasMask = true;
    result.masksProperties = [{ inv: false, mode: "a", nm: "Text unit clipping mask", pt, o: { a: 0, k: 100 }, x: { a: 0, k: 0 } }];
  }
  return result;
}
