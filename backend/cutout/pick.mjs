// cut_out points: keep only the objects an agent pointed at. The helper (kino-cutout --instances)
// gives each frame a label plane (0 = nothing, n = Vision's instance n). At the chosen frame the
// labels under `points` are kept and those under `exclude` dropped; every other frame keeps the
// instances that overlap most with what was kept in the nearest frame that had it, so the same
// object is followed forward and back in time.

// Labels are compared on a small grid: at most GRID cells on the long side.
const GRID = 160;
// A point on no object takes the nearest one within this share of the picture's long side.
const REACH = 0.05;

/** The grid step for a picture: every `step`-th pixel across and down. */
export function gridStep(width, height) {
  return Math.max(1, Math.ceil(Math.max(width, height) / GRID));
}

/** A label plane sampled on the grid. */
export function gridLabels(labels, width, height, step = gridStep(width, height)) {
  const gw = Math.ceil(width / step), gh = Math.ceil(height / step);
  const out = new Uint8Array(gw * gh);
  for (let y = 0, i = 0; y < gh; y += 1) for (let x = 0; x < gw; x += 1, i += 1) out[i] = labels[y * step * width + x * step];
  return out;
}

/** The label under [x%, y%], or the nearest one within REACH; 0 when none. */
export function labelAt(labels, width, height, [px, py]) {
  const cx = Math.min(width - 1, Math.max(0, Math.floor((px / 100) * width)));
  const cy = Math.min(height - 1, Math.max(0, Math.floor((py / 100) * height)));
  if (labels[cy * width + cx]) return labels[cy * width + cx];
  const reach = Math.ceil(REACH * Math.max(width, height));
  let best = 0, bestDistance = Infinity;
  for (let y = Math.max(0, cy - reach); y <= Math.min(height - 1, cy + reach); y += 1)
    for (let x = Math.max(0, cx - reach); x <= Math.min(width - 1, cx + reach); x += 1) {
      const label = labels[y * width + x];
      if (!label) continue;
      const distance = (x - cx) ** 2 + (y - cy) ** 2;
      if (distance < bestDistance && distance <= reach * reach) { best = label; bestDistance = distance; }
    }
  return best;
}

/** The labels to keep at the chosen frame: under points, not under exclude. */
export function pickedLabels(labels, width, height, { points, exclude = [] }) {
  const keep = new Set(points.map((point) => labelAt(labels, width, height, point)).filter(Boolean));
  for (const point of exclude) keep.delete(labelAt(labels, width, height, point));
  return keep;
}

// Which labels of `grid` follow the kept ones of `reference` ({grid, keep}): each instance goes to
// the reference instance it overlaps most (background does not count), kept if that one was kept.
function follow(grid, reference) {
  const votes = new Map();
  for (let i = 0; i < grid.length; i += 1) {
    const label = grid[i], before = reference.grid[i];
    if (!label || !before) continue;
    let row = votes.get(label);
    if (!row) votes.set(label, row = new Map());
    row.set(before, (row.get(before) ?? 0) + 1);
  }
  const keep = new Set();
  for (const [label, row] of votes) {
    let kept = 0, other = 0;
    for (const [before, count] of row) {
      if (reference.keep.has(before)) kept += count;
      else other = Math.max(other, count);
    }
    if (kept > 0 && kept >= other) keep.add(label);
  }
  return keep;
}

/**
 * The labels to keep in every frame: `grids` holds each frame's grid labels, `at` the chosen
 * frame and `keep` its labels. A frame where nothing follows keeps nothing, and the frames after
 * it are compared with the last frame that had the object.
 */
export function followPicked(grids, at, keep) {
  const out = new Array(grids.length);
  out[at] = keep;
  for (const direction of [1, -1]) {
    let reference = { grid: grids[at], keep };
    for (let n = at + direction; n >= 0 && n < grids.length; n += direction) {
      out[n] = follow(grids[n], reference);
      if (out[n].size) reference = { grid: grids[n], keep: out[n] };
    }
  }
  return out;
}

/** The matte with every pixel outside the kept labels cleared (a new array). */
export function keepLabels(matte, labels, keep) {
  const out = new Uint8Array(matte.length);
  for (let i = 0; i < matte.length; i += 1) if (keep.has(labels[i])) out[i] = matte[i];
  return out;
}
