// Short text descriptions of layers and animations, shared by the outline (status) and
// inspect. Numbers are rounded (whole pixels, times to 2 decimals) and random IDs are replaced
// by short codes, so an agent reads about 30 tokens per line instead of a whole JSON object.
import { animationTreeEntries } from "../../engine/animationTree.js";

const RANDOM_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{6,}-[0-9a-z]{6,}-[0-9a-z]{6,})$/i;

export const isRandomId = (id) => RANDOM_ID.test(String(id));

export const px = (value) => (Number.isFinite(value) ? Math.round(value) : value);
export const sec = (value) => (Number.isFinite(value) ? Number(value.toFixed(2)) : value);
const num = (value) => (Number.isFinite(value) ? Number(value.toFixed(Math.abs(value) >= 10 ? 0 : 2)) : value);

// The name an agent sees: the ID when it is readable, otherwise the short code.
export function refName(id, codes) {
  if (!isRandomId(id)) return id;
  return codes?.byId?.[id] ?? id;
}

// "L7 hero-title" for a readable ID, "L7" alone for a random one.
export function labelled(id, codes) {
  const code = codes?.byId?.[id];
  if (!code) return refName(id, codes);
  return isRandomId(id) ? code : `${code} ${id}`;
}

export function paintText(paint) {
  if (paint == null) return "none";
  if (typeof paint === "string") return paint;
  if (paint.type && Array.isArray(paint.stops))
    return `${paint.type}(${paint.stops.map((stop) => stop.color).join(",")})`;
  return JSON.stringify(paint);
}

function valueText(key, value) {
  if (value == null) return "none";
  if (typeof value === "number") return String(["x", "y", "width", "height", "blur"].includes(key) ? px(value) : num(value));
  if (key === "fill" || key === "stroke") return paintText(value);
  if (typeof value === "string") return value.length > 24 ? `"${value.slice(0, 24)}…"` : JSON.stringify(value);
  if (key === "shadow") return `${value.color} ${px(value.x)},${px(value.y)} blur ${px(value.blur)}`;
  if (key === "reveal") return `reveal ${num(value.progress)} ${value.direction}`;
  return JSON.stringify(value);
}

// What an animation does, in a few words: a preset name, or the properties it moves.
export function animationWhat(animation) {
  if (animation.kind === "composed") return `group(${animation.animations?.length ?? 0})`;
  if (animation.preset?.id) return `${animation.preset.id}${animation.preset.mode && animation.preset.mode !== animation.kind ? ` ${animation.preset.mode}` : ""}`;
  const keys = [...new Set([...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})])];
  if (["hide", "show"].includes(animation.kind)) return animation.kind;
  return keys.join(",") || animation.kind || "animation";
}

// How long an animation runs. An animation group has no duration of its own: it lasts until
// its last member ends.
export function animationLength(animation) {
  if (animation?.kind !== "composed") return animation?.duration ?? 0;
  return Math.max(0, ...(animation.animations ?? []).map((member) => (member?.start ?? 0) + animationLength(member)));
}

export function animationSpan(animation, offset = 0) {
  const start = (animation.start ?? 0) + offset;
  const end = start + animationLength(animation);
  return [sec(start), sec(end)];
}

// How an agent names an animation: its ID when readable ("hero-title.in"), otherwise its code.
export function animationRef(animation, codes) {
  return refName(animation.id, codes);
}

const INSTANT = new Set(["hide", "show"]);

// One animation in a few tokens: "hero-title.in in opacity 0.4–0.9".
export function animationShort(animation, codes, offset = 0) {
  const [start, end] = animationSpan(animation, offset);
  const timing = INSTANT.has(animation.kind) ? `@${start}` : `${start}–${end}`;
  const kind = animation.kind === "composed" || INSTANT.has(animation.kind) ? "" : `${animation.kind ?? ""} `;
  return `${animationRef(animation, codes)} ${kind}${animationWhat(animation)} ${timing}${animation.enabled === false ? " off" : ""}`.replace(/\s+/g, " ");
}

// The full motion of one animation in numbers, about 30 tokens:
// "hero-title.in in opacity 0→1, y 120→100 0.4s+0.5s smooth(70) by letters stagger 0.03".
export function animationLong(animation, codes, offset = 0) {
  const [start] = animationSpan(animation, offset);
  const parts = [animationRef(animation, codes)];
  if (animation.name) parts.push(`'${String(animation.name).slice(0, 24)}'`);
  if (animation.kind) parts.push(animation.kind);
  if (animation.preset?.id) {
    const parameters = Object.entries(animation.preset.parameters ?? {}).map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(", ");
    parts.push(`preset ${animation.preset.id}${parameters ? ` (${parameters})` : ""}`);
  }
  const keys = [...new Set([...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})])];
  if (keys.length) parts.push(keys.map((key) => `${key} ${valueText(key, animation.from?.[key])}→${valueText(key, animation.to?.[key])}`).join(", "));
  if (animation.kind === "composed") parts.push(`${animation.animations?.length ?? 0} inside`);
  parts.push(INSTANT.has(animation.kind) ? `at ${start}s` : `${start}s+${sec(animationLength(animation))}s`);
  if (animation.easing) parts.push(`${typeof animation.easing === "string" ? animation.easing : JSON.stringify(animation.easing)}${animation.intensity != null && animation.intensity !== 50 ? `(${animation.intensity})` : ""}`);
  if (animation.unit && animation.unit !== "layer") parts.push(`by ${animation.unit}${Array.isArray(animation.delays) && animation.delays.length
    ? ` delays ${sec(Math.min(...animation.delays))}..${sec(Math.max(...animation.delays))}` : animation.stagger ? ` stagger ${sec(animation.stagger)}` : ""}${animation.order && animation.order !== "forward" ? ` ${animation.order}` : ""}`);
  if (animation.anchor) parts.push(`anchor ${animation.anchor}`);
  if (animation.motionPath?.points?.length) parts.push(`curved path ${animation.motionPath.points.length} points`);
  if (animation.enabled === false) parts.push("off");
  return parts.join(" ");
}

// Every animation on a layer (group members included), with its absolute start offset.
export function layerAnimations(layer) {
  return animationTreeEntries(layer.animations ?? []).map(({ stored, offset, parents }) => ({ animation: stored, offset, depth: parents.length }));
}

// One layer in one line: "L1 hero-title text "Ship faster" 160,68 300×50 #f4f6fb".
export function layerLine(layer, codes) {
  const parts = [labelled(layer.id, codes), layer.type];
  if (layer.name && layer.name !== layer.id) parts.push(`'${String(layer.name).slice(0, 24)}'`);
  if (layer.type === "text") parts.push(JSON.stringify(String(layer.text ?? "").slice(0, 40)));
  if (layer.type === "component") parts.push(`of ${refName(layer.componentSceneId, codes)}`);
  parts.push(`${px(layer.x)},${px(layer.y)} ${px(layer.width)}×${px(layer.height)}`);
  // Image, video, audio, group and component layers draw no fill of their own.
  if (!["image", "video", "audio", "group", "component"].includes(layer.type) && layer.fillEnabled !== false && layer.fill)
    parts.push(paintText(layer.fill));
  if (layer.type === "text") {
    // Variable font axes (fontAxes.js): axes.wght is the weight drawn, the others follow as tag=value.
    const { wght, ...axes } = layer.axes ?? {};
    const more = Object.entries(axes).map(([tag, value]) => ` ${tag}=${value}`).join("");
    parts.push(`${layer.fontFamily} ${wght ?? layer.fontWeight}${more} ${px(layer.fontSize)}px`);
  }
  if (layer.opacity != null && layer.opacity !== 1) parts.push(`opacity ${num(layer.opacity)}`);
  if (layer.rotation) parts.push(`rot ${num(layer.rotation)}`);
  if (layer.visible === false) parts.push("hidden");
  if (layer.locked) parts.push("locked");
  if (layer.isMask) parts.push("mask");
  return parts.join(" ");
}
