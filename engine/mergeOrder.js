function checkedIds(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of string IDs.`);
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string") throw new TypeError(`${name} must contain only string IDs.`);
    if (seen.has(id)) throw new TypeError(`${name} must not contain duplicate IDs.`);
    seen.add(id);
  }
  return value;
}

function checkedPresentIds(value) {
  if (value instanceof Set) {
    for (const id of value) if (typeof id !== "string") throw new TypeError("presentIds must contain only string IDs.");
    return value;
  }
  return new Set(checkedIds(value, "presentIds"));
}

/**
 * Return side IDs that are outside a deterministic longest increasing
 * subsequence of their base positions. Patience sorting is O(n log n); when
 * several LIS choices exist, the lower-bound replacement rule keeps the
 * latest side entry with the smallest available base index.
 */
function movedBaseIds(basePositions, sideOrder) {
  const ids = [], positions = [];
  for (const id of sideOrder) {
    const position = basePositions.get(id);
    if (position !== undefined) {
      ids.push(id);
      positions.push(position);
    }
  }

  const tails = [], tailEntries = [], previous = Array(ids.length).fill(-1);
  for (let index = 0; index < positions.length; index += 1) {
    const value = positions[index];
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tails[middle] < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tailEntries[low - 1];
    tails[low] = value;
    tailEntries[low] = index;
  }

  const inSequence = new Set();
  let entry = tailEntries[tails.length - 1] ?? -1;
  while (entry >= 0) {
    inSequence.add(ids[entry]);
    entry = previous[entry];
  }
  return new Set(ids.filter((id) => !inSequence.has(id)));
}

function baseNeighborPlacements(baseIds, sideOrder) {
  const baseSet = new Set(baseIds);
  const previous = new Map(), next = new Map();
  let neighbor = null;
  for (const id of sideOrder) {
    if (!baseSet.has(id)) continue;
    previous.set(id, neighbor);
    neighbor = id;
  }
  neighbor = null;
  for (let index = sideOrder.length - 1; index >= 0; index -= 1) {
    const id = sideOrder[index];
    if (!baseSet.has(id)) continue;
    next.set(id, neighbor);
    neighbor = id;
  }
  return new Map(baseIds.map((id) => [id, [previous.get(id) ?? null, next.get(id) ?? null]]));
}

function applySideMoves(result, sideOrder, baseSet, movedIds) {
  for (let sideIndex = 0; sideIndex < sideOrder.length; sideIndex += 1) {
    const id = sideOrder[sideIndex];
    if (baseSet.has(id) && !movedIds.has(id)) continue;

    const existing = result.indexOf(id);
    if (existing >= 0) result.splice(existing, 1);

    let inserted = false;
    for (let index = sideIndex - 1; index >= 0; index -= 1) {
      const anchor = result.indexOf(sideOrder[index]);
      if (anchor < 0) continue;
      result.splice(anchor + 1, 0, id);
      inserted = true;
      break;
    }
    if (inserted) continue;

    for (let index = sideIndex + 1; index < sideOrder.length; index += 1) {
      const anchor = result.indexOf(sideOrder[index]);
      if (anchor < 0) continue;
      result.splice(anchor, 0, id);
      inserted = true;
      break;
    }
    if (!inserted) result.push(id);
  }
}

/**
 * Merge collection ordering from a saved base, local edits, and remote edits.
 * Remote moves apply first; local moves apply second. Only IDs classified as
 * moved by an LIS pass are repositioned, so an unchanged local order cannot
 * undo an independent remote move. Ambiguous insertions into the same gap are
 * deterministic: local insertions are placed immediately after their nearest
 * preceding local anchor, before remote-only insertions in that gap.
 */
export function mergeIdOrder(base, ours, theirs, presentIds) {
  checkedIds(base, "base");
  checkedIds(ours, "ours");
  checkedIds(theirs, "theirs");
  const present = checkedPresentIds(presentIds);
  const baseOrder = base.filter((id) => present.has(id));
  const baseSet = new Set(baseOrder);
  const basePositions = new Map(baseOrder.map((id, index) => [id, index]));
  const localOrder = ours.filter((id) => present.has(id));
  const remoteOrder = theirs.filter((id) => present.has(id));
  const localMoves = movedBaseIds(basePositions, localOrder);
  const remoteMoves = movedBaseIds(basePositions, remoteOrder);
  const localPlacements = baseNeighborPlacements(baseOrder, localOrder);
  const remotePlacements = baseNeighborPlacements(baseOrder, remoteOrder);

  const result = [...baseOrder];
  applySideMoves(result, remoteOrder, baseSet, remoteMoves);
  applySideMoves(result, localOrder, baseSet, localMoves);

  // Entities missing from every side's order still belong to the merged
  // collection; append them in code-point lexical order for stable output.
  const placed = new Set(result);
  const remaining = [...present].filter((id) => !placed.has(id)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  result.push(...remaining);

  const conflicts = new Set();
  for (const id of localMoves) {
    if (!remoteMoves.has(id)) continue;
    const local = localPlacements.get(id);
    const remote = remotePlacements.get(id);
    if (local && remote && (local[0] !== remote[0] || local[1] !== remote[1])) conflicts.add(id);
  }
  return { ids: result, conflictIds: baseOrder.filter((id) => conflicts.has(id)) };
}
