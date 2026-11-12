// match_references (edit op, compose {footage} by default, check {fix:"auto"} on reference_range
// brightness): renders a few frames of each shot, works out a per-shot exposure grade toward the
// saved references' brightness (engine/quality/exposureMatch.js) and adds it as an ordinary
// color-grade animation <layer>.match-ref. Per shot, because one dark shot among bright ones is
// the common case; shots inside the range are left alone. Calling it again replaces its grades.
import { kinoTimeline } from "../../engine/quality/kinoTimeline.js";
import { expandComponents } from "../../engine/linkedComponents.js";
import { plates } from "../../engine/quality/techniques.js";
import { mainScene } from "../../engine/board.js";
import { MATCH_SUFFIX, correctStops, matchId, matchParameters, matchShot, referenceLevels, shotLevel } from "../../engine/quality/exposureMatch.js";

// Frames per shot and their width: 3 spread over the shot (a guess: enough to see a fade or a flash
// without one frame deciding), 160 px wide (the check reads brightness at 64; more pixels steady the
// highlight percentile).
const PER_SHOT = 3;
const MEASURE_WIDTH = 160;
const LISTED = 8;

const levels255 = (value) => Math.round(value * 255);
const isPicture = (item) => item.kind === "video" || item.kind === "image";

/** The match grades in a scene (optionally only on `layerIds`): [{layerId, id}]. */
export function matchGrades(scene, layerIds = null) {
  return (scene?.layers ?? []).filter((layer) => !layerIds || layerIds.includes(layer.id))
    .flatMap((layer) => (layer.animations ?? []).filter((animation) => String(animation.id ?? "").endsWith(MATCH_SUFFIX)).map((animation) => ({ layerId: layer.id, id: animation.id })));
}

/**
 * The shots of a scene as the viewer sees them: for each picture layer that is the top full-frame
 * picture somewhere, PER_SHOT scene times spread over where it is ([{layerId, name, times}]).
 */
export function sceneShots(model, layerIds = null) {
  const pictures = plates(model).filter((item) => isPicture(item) && item.source?.layerId && !item.source.componentPath);
  const shown = new Map();
  for (let index = 0; index < model.times.length; index += 1) {
    let top = null;
    for (const item of pictures) if (item.samples.opacity[index] >= 0.9 && (!top || item.z > top.z)) top = item;
    if (!top) continue;
    if (!shown.has(top)) shown.set(top, []);
    shown.get(top).push(model.times[index]);
  }
  const shots = [];
  for (const [item, times] of shown) {
    const layerId = item.source.layerId;
    if (layerIds && !layerIds.includes(layerId)) continue;
    const picked = [...new Set(Array.from({ length: PER_SHOT }, (_, step) => times[Math.min(times.length - 1, Math.floor(((step + 0.5) / PER_SHOT) * times.length))]))];
    shots.push({ layerId, name: item.name ?? layerId, times: picked, first: times[0] });
  }
  return shots.sort((a, b) => a.first - b.first);
}

/**
 * Runs the match on `document`: {document, lines, matched}. `refs` the saved references with
 * fingerprints (inspire savedFingerprints), `render(scene, times, {width})` renders an expanded
 * scene, `runOps(document, ops)` applies ops as an edit would, `name(id)` the agent's name for an id.
 * remove:true only takes the grades off.
 */
export async function matchReferences(document, { sceneId = null, layerIds = null, remove = false, lower = false, refs = [], fonts, render, runOps, name = (id) => id }) {
  const scene = sceneId ? document.scenes.find((entry) => entry.id === sceneId) : mainScene(document);
  if (!scene) return { document, lines: [], matched: [] };
  const label = name(scene.id);
  const old = matchGrades(scene, layerIds);
  const base = old.length ? await runOps(document, old.map((grade) => ({ op: "delete_animation", animationId: grade.id }))) : document;
  if (remove) return { document: base, lines: [`match_references ${label}: took off ${old.length} match grade${old.length === 1 ? "" : "s"}`], matched: [] };
  const levels = referenceLevels(refs);
  if (!levels.brightness) {
    const measured = (refs ?? []).filter((ref) => Number.isFinite(ref?.fingerprint?.look?.brightness)).length;
    return { document, lines: [`match_references ${label}: needs 2 saved references with a measured brightness (${measured} now): save them with library {topic:"inspire"}`], matched: [], skipped: true };
  }
  const model = kinoTimeline(base, scene.id, { fonts });
  const shots = sceneShots(model, layerIds);
  const times = shots.flatMap((shot) => shot.times);
  const frames = times.length ? await render(expandComponents(base, scene.id, { fonts }), times, { width: Math.min(MEASURE_WIDTH, model.width) }) : [];
  const matched = [];
  let offset = 0;
  const brighter = [];
  for (const shot of shots) {
    const shotFrames = shot.times.map((_, index) => frames?.[offset + index]).filter(Boolean);
    offset += shot.times.length;
    const match = matchShot(shotFrames, levels, { lower });
    if (!match) {
      if (!lower && shotFrames.length && matchShot(shotFrames, levels, { lower: true })) brighter.push(shot);
      continue;
    }
    matched.push({ ...shot, ...match, at: offset - shot.times.length });
  }
  const gradeOps = () => matched.map((entry) => ({ op: "add_animation", layerId: entry.layerId, id: matchId(entry.layerId), effect: "color-grade", start: 0, duration: scene.duration, parameters: matchParameters(entry) }));
  // The real render: each matched shot's level as drawn with its grade (correctStops says why), one
  // correction where it misses its aim by more than 2 levels of 255 (a guess: under luma_jump's step
  // of 8), and the receipt's "after" is what the render shows, not the model.
  const rendered = async (doc) => {
    const drawn = await render(expandComponents(doc, scene.id, { fonts }), times, { width: Math.min(MEASURE_WIDTH, model.width) });
    for (const entry of matched) entry.after = shotLevel(entry.times.map((_, index) => drawn?.[entry.at + index]).filter(Boolean)) ?? entry.after;
  };
  let after = base;
  if (matched.length) {
    after = await runOps(base, gradeOps());
    await rendered(after);
    let changed = false;
    for (const entry of matched) {
      if (Math.abs(entry.after - entry.target) * 255 <= 2) continue;
      const stops = correctStops({ before: entry.before, after: entry.after, stops: entry.stops, target: entry.target });
      if (stops !== entry.stops) { entry.stops = stops; changed = true; }
    }
    if (changed) {
      after = await runOps(base, gradeOps());
      await rendered(after);
    }
  }
  const range = levels.brightness;
  const refsLine = `your ${range.n} references ${levels255(range.low)} to ${levels255(range.high)} (median ${levels255(range.median)})`;
  const shotLine = (entry) => `${name(entry.layerId)} ${levels255(entry.before)} to ${levels255(entry.after)} (${entry.stops > 0 ? "+" : ""}${entry.stops} stops${entry.contrast !== 1 ? `, contrast ${entry.contrast}` : ""})`;
  const inside = shots.length - matched.length - brighter.length;
  const kept = brighter.length ? `; ${brighter.length} brighter than every reference kept (${brighter.slice(0, 4).map((shot) => name(shot.layerId)).join(", ")}${brighter.length > 4 ? ", ..." : ""}: lower:true brings them down)` : "";
  const lines = [matched.length
    ? `match_references ${label}: mean brightness of 255, ${refsLine}: ${matched.slice(0, LISTED).map(shotLine).join(", ")}${matched.length > LISTED ? `, and ${matched.length - LISTED} more` : ""}${inside ? `; ${inside} shot${inside === 1 ? "" : "s"} already inside, left alone` : ""}${kept}. Exposure only (no color); each grade is <layer>${MATCH_SUFFIX}: match_references {remove:true} or delete_animation takes it off.`
    : `match_references ${label}: no shot is ${lower ? "outside" : "darker than"} ${refsLine}; nothing changed (${inside} inside${kept}).`];
  return { document: after, lines, matched };
}
