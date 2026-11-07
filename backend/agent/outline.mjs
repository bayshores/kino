// The outline: what `status` sends an agent. Plain text, one line per layer, defaults left
// out, numbers rounded, names and short codes instead of random IDs. One scene is shown
// layer by layer (40 lines per page); the others are folded to counts. Layers the agent
// already read and that have not changed since are counted instead of repeated.
//
// Pages are slices of the whole layer list (layers 1-40, 41-80, ...), so following each page's
// footer lists every layer once. They used to be slices of the layers not read yet: after page
// 1, the 40 just read dropped out and page 2 started at layer 81, so layers 41-80 were never
// shown. When the layers to show fit on one page they are shown together.
import { createHash } from "node:crypto";
import { animationShort, isRandomId, labelled, layerAnimations, layerLine, paintText, sec } from "./describe.mjs";

export const LAYERS_PER_PAGE = 40;
const ANIMATIONS_PER_LINE = 4;
const count = (number, word) => `${number} ${word}${number === 1 ? "" : "s"}`;

export function layerHash(layer) {
  return createHash("sha256").update(JSON.stringify(layer)).digest("hex").slice(0, 12);
}

function countAnimations(scene) {
  let count = (scene.backgroundAnimations ?? []).length;
  for (const layer of scene.layers ?? []) count += layerAnimations(layer).length;
  return count;
}

function sceneHeader(scene, codes) {
  const parts = [labelled(scene.id, codes)];
  if (scene.name && scene.name !== scene.id) parts.push(`'${String(scene.name).slice(0, 32)}'`);
  parts.push(`${scene.width}×${scene.height}`, `${sec(scene.duration)}s`);
  if (scene.backgroundEnabled !== false) parts.push(`bg ${paintText(scene.background)}`);
  else parts.push("no bg");
  if (scene.isComponent) parts.push("component");
  return parts.join(" ");
}

// Layers in drawing order with group children indented under their group.
function layerTree(scene) {
  const byParent = new Map();
  for (const layer of scene.layers) {
    const parent = layer.parentId && scene.layers.some((entry) => entry.id === layer.parentId) ? layer.parentId : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(layer);
  }
  const rows = [];
  const walk = (parent, depth) => {
    for (const layer of byParent.get(parent) ?? []) {
      rows.push({ layer, depth });
      walk(layer.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

function layerRow(layer, depth, codes) {
  const animations = layerAnimations(layer).filter((entry) => entry.depth === 0);
  const shown = animations.slice(0, ANIMATIONS_PER_LINE).map(({ animation, offset }) => animationShort(animation, codes, offset));
  const more = animations.length > ANIMATIONS_PER_LINE ? ` +${animations.length - ANIMATIONS_PER_LINE} more` : "";
  return `${"  ".repeat(depth + 1)}${layerLine(layer, codes)}${shown.length ? ` | ${shown.join(" · ")}${more}` : ""}`;
}

/**
 * The outline text.
 * - focus: the scene ID shown in full (default: the only scene, or the first).
 * - page: which 40 layer lines of the focus scene.
 * - seen: { [sceneId]: { [layerId]: hash } } the agent was last shown. Layers that have not
 *   changed since are counted, not repeated, so a second status after an edit shows only what
 *   changed.
 * - full: show every layer of the focus scene again.
 * - direction: the direction and next lines (brief.mjs directionLines), shown right after the
 *   header so a new chat or a compacted one starts from what is saved, not from memory.
 * Returns { text, shown } where shown is the new `seen` map to remember.
 */
export function projectOutline(record, { codes, focus, page = 1, seen = {}, full = false, plan, inbox = [], checks, pointing, direction } = {}) {
  const { document } = record;
  const layerTotal = document.scenes.reduce((sum, scene) => sum + scene.layers.length, 0);
  const animationTotal = document.scenes.reduce((sum, scene) => sum + countAnimations(scene), 0);
  const lines = [`${document.name} (${document.id}) rev ${record.revision} · ${count(document.scenes.length, "scene")} · ${count(layerTotal, "layer")} · ${count(animationTotal, "anim")}`];
  if (direction) lines.push(...direction);

  if (plan?.steps?.length) {
    const done = plan.steps.filter((step) => step.done).length;
    const current = plan.steps.find((step) => !step.done);
    lines.push(`plan ▸ ${current ? current.text : "all steps done"} (${done}/${plan.steps.length})`);
  }

  const focusScene = document.scenes.find((scene) => scene.id === focus) ?? document.scenes[0];
  const shown = {};
  for (const [id, value] of Object.entries(seen)) if (document.scenes.some((scene) => scene.id === id)) shown[id] = value;
  for (const scene of document.scenes) {
    const counts = `${count(scene.layers.length, "layer")} · ${count(countAnimations(scene), "anim")}`;
    lines.push(`${sceneHeader(scene, codes)} · ${counts}`);
    if (scene !== focusScene) continue;
    const background = (scene.backgroundAnimations ?? []).map((animation) => animationShort(animation, codes));
    if (background.length) lines.push(`  bg | ${background.join(" · ")}`);

    // full:true shows every row again, but what the agent read before is still read: each page
    // of a full listing adds its rows. It used to start from nothing, so a later status
    // re-printed earlier pages and listed only the last page's names as removed.
    const read = seen[scene.id] ?? {};
    const before = full ? {} : read;
    const hashes = Object.fromEntries(scene.layers.map((layer) => [layer.id, layerHash(layer)]));
    const tree = layerTree(scene);
    const unread = ({ layer }) => before[layer.id] !== hashes[layer.id];
    const paged = tree.filter(unread).length > LAYERS_PER_PAGE;
    const pages = paged ? Math.ceil(tree.length / LAYERS_PER_PAGE) : 1;
    const current = Math.min(Math.max(1, page), pages);
    const slice = paged ? tree.slice((current - 1) * LAYERS_PER_PAGE, current * LAYERS_PER_PAGE) : tree;
    const pageRows = slice.filter(unread);
    const unchanged = slice.length - pageRows.length;
    const removed = Object.keys(read).filter((id) => !(id in hashes));
    for (const { layer, depth } of pageRows) lines.push(layerRow(layer, depth, codes));
    if (unchanged) lines.push(`  [${unchanged} layer${unchanged === 1 ? "" : "s"}${paged ? " on this page" : ""} unchanged since you last read them; status {full:true} repeats them]`);
    if (removed.length) lines.push(`  removed since you last read: ${removed.map((id) => (isRandomId(id) ? codes?.byId?.[id] ?? codes?.gone?.[id] ?? id : id)).join(", ")}`);
    if (pages > 1) lines.push(`  page ${current}/${pages}${current < pages ? ` · status {${full ? "full:true, " : ""}page:${current + 1}} for more` : ""}`);
    const next = { ...read };
    for (const id of removed) delete next[id];
    for (const { layer } of pageRows) next[layer.id] = hashes[layer.id];
    shown[scene.id] = next;
  }

  if (document.scenes.length > 1) lines.push(`status {scene} lists another scene's layers`);
  if (inbox.length) {
    lines.push(`inbox ◆${inbox.length}`);
    for (const item of inbox) lines.push(`  ${item}`);
  }
  if (pointing) lines.push(`pointing ${pointing}`);
  if (checks) lines.push(`checks ${checks}`);
  return { text: lines.join("\n"), shown };
}
