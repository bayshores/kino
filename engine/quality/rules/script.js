// Script layers (a picture drawn by the agent's own module, engine/scriptLayer.js): one rule for a
// module that fails and one for a module that draws nothing. Both read what the renderer reported
// for three frames of each layer: the first, middle and last time it shows. The frames come back
// from ctx.renderFrames with `scriptIssues` ([{layerId, kind: "error"|"empty", message?}]),
// which backend/script-layer-frames.mjs fills as the frames are drawn.
import { sec } from "../analysis.js";

const SCRIPT_WIDTH = 320;
const MAX_LAYERS = 8;

// The times (up to three) a script item is drawn at: its first, middle and last visible sample.
function timesOf(model, item) {
  const seen = [];
  item.samples.opacity.forEach((opacity, index) => { if (opacity > 0) seen.push(index); });
  if (!seen.length) return [];
  const picks = new Set([seen[0], seen[Math.floor((seen.length - 1) / 2)], seen.at(-1)]);
  return [...picks].map((index) => model.times[index]).filter(Number.isFinite);
}

// One render for both rules: the issues by item id and time. Remembered on ctx, so the second
// rule reads the first one's frames.
const drawn = new WeakMap();
function issuesOf(model, ctx) {
  if (!ctx.renderFrames) return Promise.resolve([]);
  if (!drawn.has(ctx)) {
    drawn.set(ctx, (async () => {
      const items = model.items.filter((item) => item.kind === "script").slice(0, MAX_LAYERS);
      const plan = items.map((item) => ({ item, times: timesOf(model, item) })).filter((entry) => entry.times.length);
      if (!plan.length) return [];
      const times = [...new Set(plan.flatMap((entry) => entry.times))].sort((a, b) => a - b);
      const frames = await ctx.renderFrames(times, { width: Math.min(SCRIPT_WIDTH, model.width), hide: [] });
      return plan.map(({ item, times: own }) => ({
        item,
        found: own.map((time) => ({ time, issues: (frames[times.indexOf(time)]?.scriptIssues ?? []).filter((issue) => issue.layerId === item.id || issue.layerId === item.source?.layerId) })),
      }));
    })());
  }
  return drawn.get(ctx);
}

const listOf = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** A script layer whose module fails (throws, takes too long, will not load) at a checked frame. */
export async function scriptLayerError(model, ctx) {
  const findings = [];
  for (const { item, found } of await issuesOf(model, ctx)) {
    const failed = found.map(({ time, issues }) => ({ time, issue: issues.find((issue) => issue.kind === "error") })).find((entry) => entry.issue);
    if (!failed) continue;
    const layerId = item.source?.layerId ?? item.id;
    findings.push({
      rule: "script_layer_error", severity: "error", itemId: item.id, at: sec(failed.time),
      measured: failed.issue.message, required: "the module draws every checked frame without an error",
      message: `${failed.issue.message}: the layer draws nothing there, and a final render is refused until it is fixed.`,
      fix: { kind: "layer", layerId, properties: { script: "<fixed module>" }, auto: false, why: `rewrite the module so ${ctx.name(item)} draws at ${sec(failed.time)} s (look mode:"frame" t:${sec(failed.time)} shows it)` },
    });
  }
  return findings;
}

/** A script layer that shows (opacity above 0) but draws no pixel at a checked frame. */
export async function scriptLayerEmpty(model, ctx) {
  const findings = [];
  for (const { item, found } of await issuesOf(model, ctx)) {
    const empty = found.filter(({ issues }) => issues.some((issue) => issue.kind === "empty") && !issues.some((issue) => issue.kind === "error")).map(({ time }) => time);
    if (!empty.length) continue;
    const layerId = item.source?.layerId ?? item.id;
    const at = listOf(empty.map((time) => `${sec(time)} s`));
    findings.push({
      rule: "script_layer_empty", severity: "warn", itemId: item.id, at: sec(empty[0]),
      measured: `drew nothing at ${at}`, required: "a visible script layer draws something at every checked frame",
      message: `${ctx.name(item)} is shown but its module drew nothing at ${at}. If that is the design (a reveal that starts empty), waive this; if not, the draw may be missing a fill, a size or a value.`,
      fix: { kind: "layer", layerId, properties: { script: "<fixed module>" }, auto: false, why: `make the module draw something at ${sec(empty[0])} s` },
    });
  }
  return findings;
}
