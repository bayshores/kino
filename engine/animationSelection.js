// Selecting animations in the Timeline: what a click, a Shift-click, a ⌘-click (Ctrl on Windows
// and Linux) and a selection rectangle drawn on the tracks select.
//
// The behavior:
// - Shift selects consecutive animations, ⌘ selects animations that are not next to each other.
// - Click on the timeline and drag to draw a rectangle; the animations
//   it touches are selected. With Shift, the rectangle adds the animations it touches and
//   removes the ones it touches that were already selected.
//
// Words used here:
// - The selection is a list of animation IDs. An animation ID is unique in the whole document
//   (model.js), so the ID alone names one animation, on any layer.
// - `order` lists the scene's animation IDs in the Timeline's row order (top row first). The
//   Timeline shows the scene's layers in list order and each layer's animations in its own order.
// - The "anchor" is the animation clicked last without Shift. A Shift-click selects every
//   animation from the anchor to the clicked one, the way Shift-click works in the layer list.
//
// The selection is this person's view, not part of the document: undo, redo and other people's
// changes can remove animations, and existingAnimationSelection drops those from it.
//
// Everything here is a plain function of its inputs (no React, no DOM), so it can be tested.

import { animationTreeEntries } from "./animationTree.js";

/** The scene's animation IDs in the Timeline's row order. */
export function animationOrder(layers = []) {
  return layers.flatMap((layer) =>
    animationTreeEntries(layer?.animations).map(({ animation }) => animation.id),
  );
}

/** The selected animations as { layer, animation }, in the Timeline's row order. */
export function selectedAnimationEntries(layers = [], ids = []) {
  const wanted = new Set(ids);
  return layers.flatMap((layer) =>
    animationTreeEntries(layer?.animations)
      .filter(({ animation, parents }) => wanted.has(animation.id) && !parents.some((id) => wanted.has(id)))
      .map(({ animation, parents }) => ({ layer, animation, ...(parents.length ? { parents } : {}) })),
  );
}
