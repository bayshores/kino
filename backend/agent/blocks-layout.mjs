// Layout ops (plan §3.4): place, align, distribute, stack and fit move layers by slot (the 6×6
// grid over the safe area: "B2:E5", "center", …) and by each other. Boxes are measured as drawn,
// text by its font, so a layer lands where the picture shows it. blocks.mjs runs these.
import { ALIGNMENTS, alignmentDistance, layerWorldBox, moveLayerByWorldDelta } from "../../engine/arrange.js";
import { typeFloor } from "../../engine/blocks/looks.js";
import { frameScale, parseSlot, safeArea, slotBox } from "../../engine/blocks/formats.js";
import { closest } from "./refs.mjs";
import { placeAroundSubject, roomLine } from "../../engine/subjectRoom.js";
import { isRecord } from "../../engine/numbers.js";

/** True for a slot ("B2:E5", "center", "slot:top-left"); false for anything else, such as a layer name. */
export const isSlot = (value) => { try { parseSlot(String(value).replace(/^slot:/i, "")); return true; } catch { return false; } };

/**
 * The five layout ops, each (document, operation, work). `fontsOf(document, work)` gives the
 * fonts that measure text; `problem` and `sceneOf` are blocks.mjs's error helpers; `faceTarget`
 * (blocks.mjs) finds the point place {on, of} puts the layers on.
 */
export function createLayoutOps({ fontsOf, problem, sceneOf, faceTarget = null, subjectTarget = null, splitCopy = null }) {
  // The layers an op names, all in one scene.
  function layoutTargets(document, operation, work) {
    const find = (ref) => {
      for (const scene of document.scenes) {
        const layer = scene.layers.find((item) => item.id === ref);
        if (layer) return { scene, layer };
      }
      if (work.resolver) {
        try { const id = work.resolver.resolve(ref, "layer"); if (id !== ref) return find(id); } catch { /* reported below */ }
      }
      const pool = (operation.sceneId ? [sceneOf(document, operation.sceneId)] : document.scenes).flatMap((scene) => scene.layers.map((layer) => layer.id));
      throw problem(`No layer "${ref}".`, closest(ref, pool));
    };
    const found = operation.layerIds.map(find);
    const scene = found[0].scene;
    if (found.some((entry) => entry.scene !== scene)) throw problem(`${operation.type}: every layer must be in one scene.`);
    if (new Set(found.map((entry) => entry.layer.id)).size !== found.length) throw problem(`${operation.type}: a layer is named twice.`);
    return { scene, layers: found.map((entry) => entry.layer), find };
  }
  const boxOf = (scene, layer, document, fonts) => layerWorldBox(layer, scene.layers, document.scenes, fonts);
  function union(boxes) {
    return { left: Math.min(...boxes.map((box) => box.left)), top: Math.min(...boxes.map((box) => box.top)), right: Math.max(...boxes.map((box) => box.right)), bottom: Math.max(...boxes.map((box) => box.bottom)) };
  }
  const fromRect = (rect) => ({ left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height });
  function move(scene, layer, dx, dy) {
    const moved = moveLayerByWorldDelta(layer, scene.layers, dx, dy);
    if (!moved) return;
    layer.x = moved.x;
    layer.y = moved.y;
    layer.animations = moved.animations;
  }
  function regionOf(document, scene, value, find, fonts) {
    const frame = { width: scene.width, height: scene.height };
    if (value === undefined || value === "safe") return fromRect(safeArea(frame));
    if (value === "frame") return { left: 0, top: 0, right: scene.width, bottom: scene.height };
    if (isRecord(value) || isSlot(value)) return fromRect(slotBox(frame, value));
    const { scene: other, layer } = find(value);
    if (other !== scene) throw problem(`${value} is in another scene.`);
    return boxOf(scene, layer, document, fonts);
  }
  const gapOf = (operation, scene) => operation.gap ?? Math.round(24 * frameScale({ width: scene.width, height: scene.height }));

  async function applyPlace(document, operation, work) {
    const fonts = await fontsOf(document, work);
    const { scene, layers, find } = layoutTargets(document, operation, work);
    const group = union(layers.map((layer) => boxOf(scene, layer, document, fonts)));
    const width = group.right - group.left;
    const height = group.bottom - group.top;
    let dx = 0, dy = 0, where;
    if (operation.around !== undefined) {
      const notText = layers.find((layer) => layer.type !== "text");
      if (notText) throw problem(`place {around} sets text; ${notText.name || notText.id} is ${/^[aeiou]/.test(notText.type) ? "an" : "a"} ${notText.type} layer (place it with a side or a slot).`);
      const target = await subjectTarget(document, scene, operation, work, layers);
      const frame = { width: scene.width, height: scene.height };
      const safe = safeArea(frame);
      const bounds = { x0: safe.x, y0: safe.y, x1: safe.x + safe.width, y1: safe.y + safe.height };
      let placed;
      try {
        placed = placeAroundSubject(scene, layers, target.box, { fonts, scenes: document.scenes, gap: gapOf(operation, scene), bounds, side: operation.side,
          least: typeFloor(frame).body, split: (layer) => splitCopy(document, scene, layer), time: target.time, moments: target.moments, follow: operation.follow === true });
      } catch (error) { throw problem(error.message); }
      const box = target.box, pct = (share) => `${Math.round(share * 100)}%`;
      const names = operation.layerIds.join(", ");
      const how = placed.side === "split"
        ? `split at the word gap: "${layers[0].text}" left, "${scene.layers.find((layer) => layer.id === placed.splitId).text}" right (new layer ${placed.splitId})`
        : placed.side;
      const sized = placed.scale < 1 ? ` · size ${layers.map((layer, index) => `${placed.sizes[index]} → ${layer.fontSize}`).join(", ")} px to fit the room` : "";
      // Over the hold: how far the subject's box moves, and the worst moment's covered share.
      const moments = target.moments ?? [];
      const spread = moments.length > 1 ? Math.round(Math.max(...["x0", "x1", "y0", "y1"].map((edge) => Math.max(...moments.map((moment) => moment.box[edge])) - Math.min(...moments.map((moment) => moment.box[edge]))))) : 0;
      const at = (worst) => (spread > 0 && worst.share > 0 ? ` at ${worst.t} s` : "");
      const held = spread > 0
        ? ` over the hold ${target.hold[0]}-${target.hold[1]} s (${moments.length} moments; the subject's box moves up to ${spread} px)${placed.follow ? (placed.keys ? `: follows it on a pin path of ${placed.keys} moments` : ": already clear of it at every moment, so no pin") : ""}${placed.whole === false ? `; no spot is clear of it for the whole hold, so the text is clear of its box at ${target.boxTime} s` : ""}`
        : "";
      work.notes.push(`place ${names} around ${target.line}${target.behind ? ", behind it" : ", over it"} (subject box${spread > 0 ? ` at ${target.boxTime} s` : ""} x ${Math.round(box.x0)}-${Math.round(box.x1)}, y ${Math.round(box.y0)}-${Math.round(box.y1)}${held}): ${how} · letters inside the subject box at the worst moment ${pct(placed.before.share)}${at(placed.before)} → ${pct(placed.after.share)}${at(placed.after)}${sized} · room ${roomLine(placed.room)}`);
      return;
    }
    if (operation.on !== undefined) {
      // On a face part: the group's center on the point, or its bottom a gap above the head.
      const target = await faceTarget(document, scene, operation, work, layers);
      dx = target.x - (group.left + group.right) / 2;
      dy = target.edge === "bottom" ? target.y - gapOf(operation, scene) - group.bottom : target.y - (group.top + group.bottom) / 2;
      for (const layer of layers) move(scene, layer, dx, dy);
      work.notes.push(`place ${operation.layerIds.join(", ")} ${target.line} · face ${target.faceWidth} px wide, the group ${Math.round(width)} px`);
      return;
    }
    if (operation.slot !== undefined) {
      const slot = fromRect(slotBox({ width: scene.width, height: scene.height }, operation.slot));
      const align = operation.align ?? "center";
      const valign = operation.valign ?? "middle";
      if (!["left", "center", "right"].includes(align) || !["top", "middle", "bottom"].includes(valign)) throw problem("In a slot, align is left, center or right and valign top, middle or bottom.");
      const x = align === "left" ? slot.left : align === "right" ? slot.right - width : (slot.left + slot.right - width) / 2;
      const y = valign === "top" ? slot.top : valign === "bottom" ? slot.bottom - height : (slot.top + slot.bottom - height) / 2;
      dx = x - group.left;
      dy = y - group.top;
      where = `into ${operation.slot}`;
      if (width > slot.right - slot.left + 1 || height > slot.bottom - slot.top + 1) work.notes.push(`place: the layers are larger than slot ${operation.slot}; fit {layers, into:"${operation.slot}"} shrinks them.`);
    } else {
      const side = ["below", "above", "left_of", "right_of"].find((key) => operation[key] !== undefined);
      const { scene: other, layer: anchor } = find(operation[side]);
      if (other !== scene) throw problem(`${operation[side]} is in another scene.`);
      if (operation.layerIds.includes(anchor.id)) throw problem("A layer cannot be placed next to itself.");
      const box = boxOf(scene, anchor, document, fonts);
      const gap = gapOf(operation, scene);
      const vertical = side === "below" || side === "above";
      if (side === "below") dy = box.bottom + gap - group.top;
      if (side === "above") dy = box.top - gap - group.bottom;
      if (side === "right_of") dx = box.right + gap - group.left;
      if (side === "left_of") dx = box.left - gap - group.right;
      if (operation.align !== undefined) {
        const edge = { start: "start", left: "start", top: "start", center: "center", middle: "center", end: "end", right: "end", bottom: "end" }[operation.align];
        if (!edge) throw problem("align is start, center or end.");
        const [low, high] = vertical ? ["left", "right"] : ["top", "bottom"];
        const shift = edge === "start" ? box[low] - group[low] : edge === "end" ? box[high] - group[high] : (box[low] + box[high]) / 2 - (group[low] + group[high]) / 2;
        if (vertical) dx = shift; else dy = shift;
      }
      where = `${side.replace("_", " ")} ${anchor.id}`;
    }
    for (const layer of layers) move(scene, layer, dx, dy);
    work.notes.push(`place ${operation.layerIds.join(", ")} ${where}`);
  }

  async function applyAlign(document, operation, work) {
    const fonts = await fontsOf(document, work);
    const { scene, layers, find } = layoutTargets(document, operation, work);
    const region = regionOf(document, scene, operation.within, find, fonts);
    for (const id of [].concat(operation.to)) {
      const alignment = ALIGNMENTS.find((item) => item.id === id);
      for (const layer of layers) {
        const distance = alignmentDistance(boxOf(scene, layer, document, fonts), region, alignment);
        move(scene, layer, alignment.axis === "x" ? distance : 0, alignment.axis === "y" ? distance : 0);
      }
    }
    work.notes.push(`align ${operation.layerIds.join(", ")} ${[].concat(operation.to).join(" ")} of ${typeof operation.within === "string" ? operation.within : "the safe area"}`);
  }

  async function applyDistribute(document, operation, work) {
    const fonts = await fontsOf(document, work);
    const { scene, layers, find } = layoutTargets(document, operation, work);
    const boxes = layers.map((layer) => ({ layer, box: boxOf(scene, layer, document, fonts) }));
    const spread = (low, high) => Math.max(...boxes.map(({ box }) => box[high])) - Math.min(...boxes.map(({ box }) => box[low]));
    const axis = operation.axis ?? (spread("left", "right") >= spread("top", "bottom") ? "x" : "y");
    const [low, high] = axis === "x" ? ["left", "right"] : ["top", "bottom"];
    boxes.sort((a, b) => a.box[low] - b.box[low]);
    const region = operation.within !== undefined ? regionOf(document, scene, operation.within, find, fonts) : null;
    const start = region ? region[low] : boxes[0].box[low];
    const end = region ? region[high] : boxes.at(-1).box[high];
    const sizes = boxes.reduce((sum, { box }) => sum + box[high] - box[low], 0);
    const gap = (end - start - sizes) / (boxes.length - 1);
    if (gap < 0) throw problem(`The layers are ${Math.round(sizes)} px long together, more than the ${Math.round(end - start)} px to spread them over; fit or stack them instead.`);
    let at = start;
    for (const { layer, box } of boxes) {
      const shift = at - box[low];
      move(scene, layer, axis === "x" ? shift : 0, axis === "y" ? shift : 0);
      at += box[high] - box[low] + gap;
    }
    work.notes.push(`distribute ${boxes.map(({ layer }) => layer.id).join(", ")} along ${axis}, ${Math.round(gap)} px apart`);
  }

  async function applyStack(document, operation, work) {
    const fonts = await fontsOf(document, work);
    const { scene, layers } = layoutTargets(document, operation, work);
    const down = (operation.direction ?? "down") === "down";
    const gap = gapOf(operation, scene);
    const first = boxOf(scene, layers[0], document, fonts);
    const area = operation.slot !== undefined ? fromRect(slotBox({ width: scene.width, height: scene.height }, operation.slot)) : null;
    const [low, high, crossLow, crossHigh] = down ? ["top", "bottom", "left", "right"] : ["left", "right", "top", "bottom"];
    let at = area ? area[low] : first[low];
    const cross = area ?? { [crossLow]: first[crossLow], [crossHigh]: first[crossHigh] };
    const align = operation.align ?? "start";
    for (const layer of layers) {
      const box = boxOf(scene, layer, document, fonts);
      const along = at - box[low];
      const size = box[crossHigh] - box[crossLow];
      const target = align === "start" ? cross[crossLow] : align === "end" ? cross[crossHigh] - size : (cross[crossLow] + cross[crossHigh] - size) / 2;
      const across = (area || align !== "start" || layer !== layers[0]) ? target - box[crossLow] : 0;
      move(scene, layer, down ? across : along, down ? along : across);
      at += box[high] - box[low] + gap;
    }
    const used = at - gap;
    if (area && used > area[high] + 1) work.notes.push(`stack: the layers run ${Math.round(used - area[high])} px past slot ${operation.slot}; fit or a larger slot fixes it.`);
    work.notes.push(`stack ${operation.layerIds.join(", ")} ${down ? "down" : "right"}, ${gap} px apart`);
  }

  async function applyFit(document, operation, work) {
    const fonts = await fontsOf(document, work);
    const { scene, layers, find } = layoutTargets(document, operation, work);
    const region = regionOf(document, scene, operation.into, find, fonts);
    const room = { width: region.right - region.left, height: region.bottom - region.top };
    const floor = typeFloor({ width: scene.width, height: scene.height });
    const changed = [];
    for (const layer of layers) {
      let box = boxOf(scene, layer, document, fonts);
      const fits = () => box.right - box.left <= room.width + 0.5 && box.bottom - box.top <= room.height + 0.5;
      if (!fits()) {
        if (layer.type === "text") {
          const least = ["headline", "title", "cta"].includes(layer.role) || (layer.fontSize ?? 0) >= floor.headline * 1.2 ? Math.min(layer.fontSize, floor.headline) : Math.min(layer.fontSize, floor.body);
          if (layer.textResize !== "width-height" && box.right - box.left > room.width) {
            layer.width = Math.floor(room.width / Math.max(1e-6, (box.right - box.left) / Math.max(1, layer.width ?? 1)));
            box = boxOf(scene, layer, document, fonts);
          }
          while (!fits() && layer.fontSize > least) {
            layer.fontSize = Math.max(least, Math.floor(layer.fontSize * 0.94));
            box = boxOf(scene, layer, document, fonts);
          }
          if (!fits()) throw problem(`${layer.id} does not fit in ${room.width}×${room.height} px even at ${layer.fontSize} px, the smallest readable size here. Give it a larger area or shorter text.`);
        } else {
          const scale = Math.min(room.width / (box.right - box.left), room.height / (box.bottom - box.top));
          layer.width = Math.max(1, Math.floor((layer.width ?? 1) * scale));
          layer.height = Math.max(1, Math.floor((layer.height ?? 1) * scale));
          box = boxOf(scene, layer, document, fonts);
        }
        changed.push(layer.id);
      }
      const dx = box.left < region.left ? region.left - box.left : box.right > region.right ? region.right - box.right : 0;
      const dy = box.top < region.top ? region.top - box.top : box.bottom > region.bottom ? region.bottom - box.bottom : 0;
      move(scene, layer, dx, dy);
    }
    work.notes.push(`fit ${operation.layerIds.join(", ")} into ${typeof operation.into === "string" ? operation.into : "the safe area"}${changed.length ? `; resized ${changed.join(", ")}` : ""}`);
  }

  return { place: applyPlace, align: applyAlign, distribute: applyDistribute, stack: applyStack, fit: applyFit };
}
