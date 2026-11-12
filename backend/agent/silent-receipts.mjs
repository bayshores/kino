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
 * get no note. `lifted` holds the clips liftFootage already moved under the words this edit.
 */
export function coverNotes(before, after, createdIds, refName, { seeThrough = new Set(), lifted = new Set() } = {}) {
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
      notes.push({ call, note: `${refName(cover.id)} is full-frame and now draws over ${names.join(", ")}${under.length > 4 ? ` and ${under.length - 4} more` : ""} (${under.length === 1 ? "it is" : "they are"} on screen at the same time, so you cannot see ${under.length === 1 ? "it" : "them"}). ${lifted.has(cover.id) ? "kino moved it under the words only." : "Nothing was reordered."} To put the clip underneath: move_layers {layers:["${refName(cover.id)}"], position:"below", referenceId:"${lowest}"}.` });
    }
  }
  return notes;
}

const sec2 = (value) => Number(value.toFixed(2));

const overlaps = (one, other, scene) => {
  const [a, b] = windowOf(one, scene), [c, d] = windowOf(other, scene);
  return a < d && c < b;
};

/**
 * A scene that is new in an edit (a duplicate) has fresh layer IDs. Its layers are matched, by type,
 * name, file and words, to those of the earlier scene they match most, and take that layer's place
 * in its order, so footage that was above words there is not counted as added. Returns Map(id, place).
 */
function orderInSource(before, scene) {
  const sign = (layer) => `${layer.type}|${layer.name}|${layer.src ?? ""}|${layer.text ?? ""}`;
  let best = new Map();
  for (const source of before?.scenes ?? []) {
    const left = (source.layers ?? []).map((layer, index) => [sign(layer), index]);
    const found = new Map();
    for (const layer of scene.layers ?? []) {
      const at = left.findIndex(([key]) => key === sign(layer));
      if (at >= 0) found.set(layer.id, left.splice(at, 1)[0][1]);
    }
    if (found.size > best.size) best = found;
  }
  return best;
}

/**
 * The default for words and footage: opaque full-frame footage that an edit added (or moved to
 * above words it was under) goes under any text that is on screen at the same time, because the
 * words would not show otherwise. Returns { ops, moves, sources }: `ops` are engine move_layers
 * ops (footage below the lowest such text) for the caller to apply, `moves` are what liftNotes
 * words, `sources` are the files of the footage in question (the caller reads their alpha and calls again
 * with `seeThrough`).
 * Left where they are: footage with an alpha channel, a blend mode or opacity under 1 (the clip
 * mixes with the words), footage that is a mask or sits just above one (it plays through that
 * mask, as masked-type's fill does), text that is a mask, text with a cut-out layer above it (the
 * title sits between a clip and its cut-out on purpose), footage or text whose order an op of this
 * edit named (`kept`: ids), and text with other opaque full-frame footage between it and the clip
 * at the same time.
 */
export function liftFootage(before, after, { seeThrough = new Set(), kept = new Set() } = {}) {
  const ops = [], moves = [], sources = new Set();
  for (const scene of after.scenes ?? []) {
    const earlier = (before?.scenes ?? []).find((entry) => entry.id === scene.id);
    const was = earlier ? new Map((earlier.layers ?? []).map((layer, index) => [layer.id, index])) : orderInSource(before, scene);
    const work = [...(scene.layers ?? [])];
    for (const footage of [...work]) {
      if (!fullFrame(footage, scene) || footage.cutoutOf || footage.isMask || kept.has(footage.id)) continue;
      const at = work.indexOf(footage);
      // A layer just above a mask is what that mask cuts (footage playing through a word): it stays
      // on it, and nothing goes in between.
      const onMask = (index) => work.slice(0, index).filter((layer) => !layer.parentId).at(-1)?.isMask === true;
      if (onMask(at)) continue;
      // A layer above the text that is the cut-out of a clip below it: the text sits between them.
      const behindSubject = (textAt) => work.some((layer, index) => {
        const clipAt = layer.cutoutOf ? work.findIndex((entry) => entry.id === layer.cutoutOf) : -1;
        return index > textAt && clipAt >= 0 && clipAt < textAt;
      });
      const texts = work.slice(0, at).filter((text, textAt) => text.type === "text" && !text.parentId && !text.isMask && !onMask(textAt) && text.visible !== false && Number(text.opacity ?? 1) > 0
        && !kept.has(text.id) && overlaps(text, footage, scene)
        && (!was.has(footage.id) || (was.has(text.id) && was.get(text.id) > was.get(footage.id)))
        && !behindSubject(textAt)
        && !work.slice(textAt + 1, at).some((other) => fullFrame(other, scene) && !other.cutoutOf && overlaps(other, footage, scene)));
      if (!texts.length) continue;
      if (footage.src) sources.add(footage.src);
      if (seeThrough.has(footage.src)) continue;
      work.splice(at, 1);
      work.splice(work.indexOf(texts[0]), 0, footage);
      ops.push({ type: "move_layers", sceneId: scene.id, layerIds: [footage.id], position: "below", referenceId: texts[0].id });
      moves.push({ footage: footage.id, texts: texts.map((text) => text.id), window: windowOf(footage, scene) });
    }
  }
  return { ops, moves, sources: [...sources] };
}

/** The receipt note for each move liftFootage made, named with `refName`. */
export function liftNotes(moves, refName) {
  return moves.map(({ footage, texts, window }) => {
    const name = refName(footage);
    const told = texts.slice(0, 3).map(refName);
    return `${name} (full-frame footage, ${sec2(window[0])}-${sec2(window[1])} s) covers ${told.join(", ")}${texts.length > 3 ? ` and ${texts.length - 3} more` : ""} at the same time, so kino moved ${name} below ${refName(texts[0])} (the only layer moved) and the words show. To put it back: move_layers {layers:["${name}"], position:"above", referenceId:"${refName(texts.at(-1))}"}.`;
  });
}

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
