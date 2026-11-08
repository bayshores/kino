// Stored Composed operations contain members whose starts are relative to the group.
// Evaluation receives ordinary operations at absolute scene times. Editor rows keep the
// containers so grouping never changes the properties or easing of their members.
import { retimeBehavior } from "./behavior.js";

export const MAX_ANIMATION_GROUP_DEPTH = 8;
export const isComposedAnimation = (animation) => animation?.kind === "composed";

export function animationTreeEntries(animations, { enabledOnly = false, groups = true } = {}) {
  const entries = [];
  function visit(list, offset, parents, enabled) {
    if (parents.length > MAX_ANIMATION_GROUP_DEPTH) throw new RangeError("Animation group nesting exceeds 8 levels.");
    for (const stored of Array.isArray(list) ? list : []) {
      if (!stored || typeof stored !== "object") { entries.push({ animation: stored, stored, offset, parents }); continue; }
      const on = enabled && stored.enabled !== false;
      if (enabledOnly && !on) continue;
      const animation = offset === 0 && on === (stored.enabled !== false)
        ? stored : { ...stored, start: stored.start + offset, ...(!on ? { enabled: false } : {}) };
      if (groups || !isComposedAnimation(stored)) entries.push({ animation, stored, offset, parents });
      if (isComposedAnimation(stored)) visit(stored.animations, offset + stored.start, [...parents, stored.id], on);
    }
  }
  visit(animations, 0, [], true);
  return entries;
}

export function flattenAnimations(animations, { enabledOnly = false } = {}) {
  return animationTreeEntries(animations, { enabledOnly, groups: false }).map(({ animation }) => animation);
}

/** Map every stored operation, preserving its relative clock and group hierarchy. */
export function mapAnimationTree(animations, map) {
  return (animations ?? []).map((animation) => map(isComposedAnimation(animation)
    ? { ...animation, animations: mapAnimationTree(animation.animations, map) } : animation));
}

export function freshAnimationIds(animation, makeId) {
  return mapAnimationTree([structuredClone(animation)], (item) => ({ ...item, id: makeId() }))[0];
}

/** Update an operation by ID. The callback reads and returns absolute scene time. */
export function editAnimationTree(animations, id, edit, offset = 0) {
  return animations.flatMap((stored) => {
    if (stored.id === id) {
      const edited = edit({ ...stored, start: stored.start + offset });
      const items = edited == null ? [] : Array.isArray(edited) ? edited : [edited];
      return items.map((item) => ({ ...item, start: item.start - offset }));
    }
    if (!isComposedAnimation(stored)) return [stored];
    const children = editAnimationTree(stored.animations, id, edit, offset + stored.start);
    // Pull the container's origin left when a member is moved before it. Other members
    // retain their absolute clocks, and stored member times stay nonnegative.
    const leading = Math.min(0, ...children.map((item) => item.start));
    return children.length ? [{ ...stored, start: stored.start + leading,
      animations: leading ? children.map((item) => ({ ...item, start: item.start - leading })) : children }] : [];
  });
}

/** Proportional time stretching includes per-unit delays and nested text effects. */
export function scaleAnimationTimes(animation, factor, { start = true } = {}) {
  const scaled = { ...animation, ...(start ? { start: animation.start * factor } : {}) };
  if (isComposedAnimation(animation)) scaled.animations = animation.animations.map((item) => scaleAnimationTimes(item, factor));
  else {
    if (Number.isFinite(animation.duration)) {
      scaled.duration = animation.duration * factor;
      if (animation.behavior) scaled.behavior = retimeBehavior(animation.behavior, animation.duration, scaled.duration);
    }
    if (Number.isFinite(animation.stagger)) scaled.stagger = animation.stagger * factor;
    if (Array.isArray(animation.delays)) scaled.delays = animation.delays.map((delay) => delay * factor);
    for (const side of ["in", "out"]) if (animation[side]) scaled[side] = {
      ...animation[side], duration: animation[side].duration * factor,
      ...(Number.isFinite(animation[side].stagger) ? { stagger: animation[side].stagger * factor } : {}),
    };
  }
  return scaled;
}

export function minimumAnimationScale(animation, minimum = 0.001) {
  const durations = flattenAnimations([animation]).flatMap((item) =>
    [item.duration, item.in?.duration, item.out?.duration].filter((value) => value > 0));
  return durations.length ? Math.max(...durations.map((duration) => Math.min(1, minimum / duration))) : 0;
}
