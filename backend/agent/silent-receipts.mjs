// Receipt notes for things an edit does that show nothing, or cover something, without a word
// (GAPS Friction 4 and 5, benchmark rebuilds): a preset that cannot show on its target, and a
// full-frame clip added over text or a graphic that is on screen at the same time (not a file with
// an alpha channel, which lets them show).
// Both only read the saved documents and the ops of the edit; nothing here changes a document.

// Presets that pixelate or dissolve the layer's one picture. On a layer drawn as repeated copies
// (repeatCopies) the rebuild saw no visible state (GAPS Friction 4: preset-pixel and
// preset-dissolve on a repeater group "showed nothing"). Not re-measured here: the note says
// what the rebuild saw and names the presets that are plain property or repeat animations.
const PICTURE_PRESETS = new Set(["preset-pixel", "preset-dissolve"]);

const layersOf = (document) => (document.scenes ?? []).flatMap((scene) => scene.layers ?? []);
const repeats = (layer) => Number(layer?.repeatCopies) > 1;

// True for a layer drawn as copies, or a group with such a layer inside it (at any depth).
function drawsRepeats(layer, layers) {
  if (repeats(layer)) return true;
  if (layer.type !== "group") return false;
  return layers.some((entry) => entry.parentId === layer.id && drawsRepeats(entry, layers));
}

/** Notes for presets in this edit that cannot show on their target. */
export function unseenPresetNotes(after, operations, refName) {
  const layers = layersOf(after);
  const notes = [];
  for (const operation of operations) {
    if (operation?.type !== "add_animation" || !PICTURE_PRESETS.has(operation.preset)) continue;
    const layer = layers.find((entry) => entry.id === operation.layerId);
    if (!layer || !drawsRepeats(layer, layers)) continue;
    const name = refName(layer.id);
    notes.push(`${operation.preset} on ${name} showed no visible state on a repeater in the benchmark rebuild (${name} is drawn as repeated copies). What works there: preset-fade or preset-scale on ${name}, or add_animation {layer:"${name}", preset:"repeat", start, duration} to grow the copies one after another.`);
  }
  return [...new Set(notes)];
}

/** A note naming the top-level layers an import_svg made, so the agent knows what to call them. */
export function importedNames(after, operations, createdIds, refName) {
  if (!operations.some((operation) => operation?.type === "import_svg")) return null;
  const made = new Set(createdIds);
  const roots = layersOf(after).filter((layer) => made.has(layer.id) && layer.parentId === null);
  if (!roots.length) return null;
  const shown = roots.slice(0, 6).map((layer) => `"${layer.name}" (${refName(layer.id)})`);
  return `import_svg made ${shown.join(", ")}${roots.length > 6 ? ` and ${roots.length - 6} more` : ""}: use these names in later ops.`;
}

// When a layer is on screen: the whole scene unless a show animation starts later or a hide
// animation starts earlier. GUESS: a rough window, the check's covered_layer measures it exactly.
function windowOf(layer, scene) {
  const animations = layer.animations ?? [];
  const show = animations.find((entry) => entry.kind === "show");
  const hide = animations.find((entry) => entry.kind === "hide");
  return [Number(show?.start) || 0, Number.isFinite(Number(hide?.start)) && hide ? Number(hide.start) : scene.duration];
}

const FULL_SHARE = 0.9; // GUESS: a clip over 90% of the frame hides what is under it
const COVERABLE = new Set(["text", "rectangle", "ellipse", "path", "polygon", "star", "line", "image"]);

function fullFrame(layer, scene) {
  // A clip blended (screen, multiply, ...) mixes with what is under it instead of hiding it.
  if (!["video", "image"].includes(layer.type) || layer.parentId || layer.visible === false || Number(layer.opacity) < 0.98
    || (layer.blendMode ?? "normal") !== "normal") return false;
  const width = Math.abs(layer.width * (layer.scaleX ?? 1)), height = Math.abs(layer.height * (layer.scaleY ?? 1));
  const overlapX = Math.max(0, Math.min(layer.x + width, scene.width) - Math.max(layer.x, 0));
  const overlapY = Math.max(0, Math.min(layer.y + height, scene.height) - Math.max(layer.y, 0));
  return overlapX * overlapY >= FULL_SHARE * scene.width * scene.height;
}

/**
 * For each full-frame video or image this edit made on top of text or graphics that are on screen
 * at the same time, a note with the one reorder call that puts the clip under the lowest of them.
 * Returns [{ note, call }]: `call` is {tool, input}. `seeThrough` holds the files with an alpha
 * channel (an alpha WebM, a picture with a clear part): what is under them still shows, so they
 * get no note.
 */
export function coverNotes(before, after, createdIds, refName, { seeThrough = new Set() } = {}) {
  const made = new Set(createdIds);
  const notes = [];
  for (const scene of after.scenes ?? []) {
    const layers = scene.layers ?? [];
    for (const [index, cover] of layers.entries()) {
      if (!made.has(cover.id) || !fullFrame(cover, scene) || seeThrough.has(cover.src)) continue;
      const [from, to] = windowOf(cover, scene);
      const under = layers.slice(0, index).filter((layer) => layer.parentId === null && layer.visible !== false && Number(layer.opacity) > 0
        && layer.role !== "background" && COVERABLE.has(layer.type) && !fullFrame(layer, scene)
        && windowOf(layer, scene)[0] < to && windowOf(layer, scene)[1] > from);
      if (!under.length) continue;
      const lowest = refName(under[0].id);
      const names = under.slice(0, 4).map((layer) => refName(layer.id));
      const call = { tool: "edit", input: { ops: [{ op: "move_layers", layers: [refName(cover.id)], position: "below", referenceId: lowest }] } };
      notes.push({ call, note: `${refName(cover.id)} is full-frame and now draws over ${names.join(", ")}${under.length > 4 ? ` and ${under.length - 4} more` : ""} (${under.length === 1 ? "it is" : "they are"} on screen at the same time, so you cannot see ${under.length === 1 ? "it" : "them"}). Nothing was reordered. To put the clip underneath: move_layers {layers:["${refName(cover.id)}"], position:"below", referenceId:"${lowest}"}.` });
    }
  }
  return notes;
}

const sec2 = (value) => Number(value.toFixed(2));

/**
 * For each text this edit made or gave a new span on screen (a longer hide, an earlier show), the
 * full-frame footage that is above it in layer order and on screen at the same time, as a fact: which
 * layer covers which text from which second, with the one reorder call that puts the text above
 * the topmost of them. Footage this edit made is left to coverNotes (it names the same pair).
 * Returns [{ note, call }]; nothing is reordered.
 */
export function textUnderNotes(before, after, createdIds, refName, { seeThrough = new Set() } = {}) {
  const made = new Set(createdIds);
  const notes = [];
  for (const scene of after.scenes ?? []) {
    const earlier = (before?.scenes ?? []).find((entry) => entry.id === scene.id);
    const layers = scene.layers ?? [];
    for (const [index, text] of layers.entries()) {
      if (text.type !== "text" || text.parentId || text.visible === false || Number(text.opacity ?? 1) <= 0) continue;
      const prior = earlier?.layers?.find((entry) => entry.id === text.id);
      const [start, end] = windowOf(text, scene);
      if (prior) {
        const [priorStart, priorEnd] = windowOf(prior, earlier);
        if (priorStart === start && priorEnd === end) continue;
      }
      const covers = layers.slice(index + 1)
        .filter((layer) => !made.has(layer.id) && fullFrame(layer, scene) && !seeThrough.has(layer.src) && windowOf(layer, scene)[0] < end && windowOf(layer, scene)[1] > start)
        .map((layer) => ({ layer, from: Math.max(start, windowOf(layer, scene)[0]), to: Math.min(end, windowOf(layer, scene)[1]) }));
      if (!covers.length) continue;
      const name = refName(text.id);
      const top = refName(covers.at(-1).layer.id);
      const told = covers.slice(0, 3).map((entry) => `${refName(entry.layer.id)} from ${sec2(entry.from)} s to ${sec2(entry.to)} s`);
      const call = { tool: "edit", input: { ops: [{ op: "move_layers", layers: [name], position: "above", referenceId: top }] } };
      notes.push({ call, sources: covers.map((entry) => entry.layer.src), note: `${name} (on screen ${sec2(start)}-${sec2(end)} s) is under full-frame footage in layer order: ${told.join("; ")}${covers.length > 3 ? ` and ${covers.length - 3} more` : ""}, so the words do not show there. Nothing was reordered. To keep them on top: move_layers {layers:["${name}"], position:"above", referenceId:"${top}"}.` });
    }
  }
  return notes;
}
