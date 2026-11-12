// Show and hide steps a move put on your layers outlive the layers it made unless they leave
// together: deleting a move's last made layer (its word-panel group) also takes away the move's
// show and hide steps on your layers, so your word is not left hidden or shown by a move that is
// gone. A word-panel saved before its source text was hidden from 0 s is settled the same way when
// the document is read (normalizeScene): its leftover show at the end is replaced by a hide at 0 s.

const prefixOf = (id) => `${id}.`;
const isStep = (animation) => animation?.kind === "show" || animation?.kind === "hide";

/** Removes the show and hide steps of move `id` from every layer of `scene` (in place). */
export function dropMoveSteps(scene, id) {
  const prefix = prefixOf(id);
  for (const layer of scene.layers) {
    if (!(layer.animations ?? []).some((animation) => isStep(animation) && String(animation.id ?? "").startsWith(prefix))) continue;
    layer.animations = layer.animations.filter((animation) => !(isStep(animation) && String(animation.id ?? "").startsWith(prefix)));
  }
}

/**
 * After layers `gone` left `scene`: each move that made one of them and has no made layer left
 * loses its show and hide steps on your layers, and its record when nothing of it remains.
 */
export function settleDeletedMoves(scene, gone) {
  const ids = new Set(gone.map((layer) => layer.move?.instance).filter(Boolean));
  for (const id of ids) {
    if (scene.layers.some((layer) => layer.move?.instance === id)) continue;
    dropMoveSteps(scene, id);
    const prefix = prefixOf(id);
    if (!scene.layers.some((layer) => (layer.animations ?? []).some((animation) => String(animation.id ?? "").startsWith(prefix))) && scene.moves)
      scene.moves = scene.moves.filter((entry) => entry.id !== id);
  }
}

/**
 * A saved scene's word-panel records as the current move leaves them (in place): a record whose
 * group is gone loses its steps and record; a source text with no steps of its own besides the
 * move's hide at its start and show at its end is hidden from 0 s instead.
 */
export function settleWordPanels(scene) {
  for (const record of [...(scene.moves ?? [])]) {
    if (record?.name !== "word-panel") continue;
    if (!scene.layers.some((layer) => layer.move?.instance === record.id)) {
      dropMoveSteps(scene, record.id);
      const prefix = prefixOf(record.id);
      if (!scene.layers.some((layer) => (layer.animations ?? []).some((animation) => String(animation.id ?? "").startsWith(prefix))))
        scene.moves = scene.moves.filter((entry) => entry !== record);
      continue;
    }
    const source = scene.layers.find((layer) => layer.id === record.settings?.textLayer);
    const showId = `${record.id}.textLayer-show`, hideId = `${record.id}.textLayer-hide`;
    if (!source || !(source.animations ?? []).some((animation) => animation?.id === showId)) continue;
    const others = source.animations.filter((animation) => isStep(animation) && animation.id !== showId && animation.id !== hideId);
    if (others.length) continue;
    source.animations = source.animations
      .filter((animation) => animation?.id !== showId)
      .map((animation) => (animation?.id === hideId ? { ...animation, start: 0 } : animation));
  }
}
