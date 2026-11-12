// The receipt line for a footage layer an edit made or re-timed so that its span of the file runs
// across the file's own cut (engine/spanCuts.js): frames of the next shot show for a moment. A fact
// only: the file second of each cut, the scene second it lands on, and the trim that ends the span
// on the near side. Cuts are the shots saved in the media record; a file whose cuts are not found
// yet says nothing here (look sheet or library media finds them).
import { layerSpanCuts, spanCutLine } from "../../engine/spanCuts.js";
import { speedAnimations } from "../../engine/animation.js";

const TIMING = ["src", "mediaStart", "mediaOffset", "mediaDuration", "mediaSpeed", "mediaReverse", "playbackWindows", "mediaSourceDuration"];
const SHOWN = 4;
const timing = (layer) => JSON.stringify([TIMING.map((key) => layer[key] ?? null), speedAnimations(layer)]);

/**
 * The receipt notes: for each video layer in `ids` (created or changed) that is new, or whose
 * timing changed, with a span across file cuts, one line. `fileShots(src)` resolves to the saved
 * shots or null. At most SHOWN lines, then a count.
 */
export async function spanCutNotes({ before, after, ids, fileShots, nameOf }) {
  const touched = new Set(ids);
  const was = new Map((before?.scenes ?? []).flatMap((scene) => (scene.layers ?? []).map((layer) => [layer.id, layer])));
  const notes = [];
  const shotsOf = new Map();
  for (const scene of after?.scenes ?? []) {
    for (const layer of scene.layers ?? []) {
      if (layer.type !== "video" || !layer.src || !touched.has(layer.id)) continue;
      const old = was.get(layer.id);
      if (old && timing(old) === timing(layer)) continue;
      if (!shotsOf.has(layer.src)) shotsOf.set(layer.src, await fileShots(layer.src).catch(() => null));
      const cuts = layerSpanCuts(layer, shotsOf.get(layer.src), scene.duration);
      if (cuts.length) notes.push(spanCutLine(nameOf(layer.id), cuts));
    }
  }
  return notes.length > SHOWN ? [...notes.slice(0, SHOWN), `${notes.length - SHOWN} more footage layers play across a cut of their file`] : notes;
}
