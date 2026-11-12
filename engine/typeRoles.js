// Type by job: a new text layer that names no face and no fill gets a treatment for the job its
// words do in the edit (a spoken-line subtitle, a payoff or title word, a label), so words with
// different jobs in one edit do not all share one look. The values come from the project's saved
// references' measured lettering (type labels: face, size share, fill) when there are any, else
// from the scene's own colors. Each value is an ordinary layer field the agent can change; the
// receipt names where each came from. A payoff word with no entrance gets a letter-level entrance
// picked by the song cue it lands on.

const JOBS_BY_ROLE = { caption: "subtitle", body: "subtitle", subhead: "subtitle", headline: "payoff", hero: "payoff", label: "label", cta: "label", ui: "label" };
// GUESS: size shares of the frame height when no reference was measured (subtitle lines about 4.5%,
// a payoff word about 14%, a label 3%); a measured label's own share replaces them.
const SHARE = { subtitle: 0.045, payoff: 0.14, label: 0.03 };
// Letter (ink) height to font size: capitals and x-height sit near 0.72 of the em in most faces.
const INK_TO_SIZE = 0.72;
const NEAR_CUE = 0.1;

/** The job of a text layer: its role when it names one, else its words (4 or more, or a sentence, read as a line). */
export function textJob(text, role) {
  if (role && JOBS_BY_ROLE[role]) return JOBS_BY_ROLE[role];
  if (role) return null;
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  return words.length >= 4 || /[.?!,;]/.test(String(text ?? "")) ? "subtitle" : "payoff";
}

const hex = (value) => /^#[0-9a-f]{6}$/i.test(String(value ?? "")) ? String(value).toLowerCase() : null;
const channels = (color) => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
const luma = (color) => { const [r, g, b] = channels(color); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const saturation = (color) => { const values = channels(color); const top = Math.max(...values), low = Math.min(...values); return top ? (top - low) / top : 0; };

// The scene's own colors: its background and the fills of its shapes (not text, not media).
function sceneColors(scene) {
  const colors = [hex(scene?.background)].filter(Boolean);
  for (const layer of scene?.layers ?? []) if (!["text", "video", "image", "audio", "group"].includes(layer.type) && hex(layer.fill)) colors.push(hex(layer.fill));
  return colors;
}

/**
 * Which measured label each job takes: [{ref, at, family, weight, share, fill}] (share: the letters'
 * ink height over the frame height). The largest letters go to the payoff, the smallest to the
 * subtitle and the label; one label serves the job it fits by size (over 8% of the height: payoff).
 */
export function labelsByJob(labels) {
  const usable = (labels ?? []).filter((label) => label?.family && label.share > 0).sort((a, b) => b.share - a.share);
  if (!usable.length) return {};
  if (usable.length === 1) return usable[0].share > 0.08 ? { payoff: usable[0] } : { subtitle: usable[0], label: usable[0] };
  return { payoff: usable[0], subtitle: usable.at(-1), label: usable.at(-1) };
}

/**
 * The fields a text layer of `job` gets on `scene` ({width, height, background, layers}) and where
 * they came from: { properties, from }. `labels` are the project's measured type labels.
 */
export function jobTreatment(job, { scene, labels = [] } = {}) {
  const height = scene?.height ?? 1080;
  const width = scene?.width ?? 1920;
  const label = labelsByJob(labels)[job];
  const share = label ? label.share / INK_TO_SIZE : SHARE[job];
  const size = Math.max(12, Math.round(share * height));
  const colors = sceneColors(scene);
  const background = colors[0] ?? "#000000";
  const light = luma(background) < 0.5;
  const plain = light ? "#ffffff" : "#111111";
  const accent = colors.slice(1).filter((color) => saturation(color) > 0.35).sort((a, b) => saturation(b) - saturation(a))[0] ?? null;
  const properties = { fontSize: size, textAlign: "center" };
  if (label) Object.assign(properties, { fontFamily: label.family, fontWeight: label.weight });
  if (job === "subtitle") {
    // A line read over footage: the reference's fill (else the plain color for the background) with a thin dark edge.
    Object.assign(properties, { fill: label?.fill ?? plain, stroke: light ? "#000000" : "#ffffff", strokeWidth: Math.max(2, Math.round(size * 0.06)), strokeAlign: "outside", lineHeight: 1.15, x: Math.round(width * 0.08), width: Math.round(width * 0.84), height: Math.round(size * 2.6), y: Math.round(height * 0.86 - size * 1.3) });
    if (!label) properties.fontWeight = 600;
  } else if (job === "payoff") {
    Object.assign(properties, { fill: label?.fill ?? accent ?? plain, lineHeight: 1, x: Math.round(width * 0.05), width: Math.round(width * 0.9), height: Math.round(size * 1.3), y: Math.round(height * 0.5 - size * 0.65) });
    if (!label) properties.fontWeight = 900;
  } else {
    Object.assign(properties, { fill: label?.fill ?? plain, letterSpacing: Math.round(size * 0.08), textCase: "upper", width: Math.round(width * 0.4), height: Math.round(size * 1.4) });
    if (!label) properties.fontWeight = 500;
  }
  const from = label ? `label ${label.ref} @${label.at} (${label.family} ${label.weight}, letters ${Math.round(label.share * 1000) / 10}% of the height${label.fill ? `, fill ${label.fill}` : ""})`
    : `scene colors (background ${background}${job === "payoff" && accent ? `, accent ${accent}` : ""}; no measured type label)`;
  return { properties, from };
}

/**
 * The letter entrance a payoff word gets when it lands at `start` with no entrance named: picked by
 * the cue within 3 frames (a song drop or seam: a hard scale-in; a build: a rise; a beat or accent:
 * a quick pop; none: a short rise). Returns { animation (add_animation fields), why }.
 */
export function payoffEntrance(start, cues = []) {
  const near = cues.filter((cue) => Number.isFinite(cue.time) && Math.abs(cue.time - start) <= NEAR_CUE).sort((a, b) => Math.abs(a.time - start) - Math.abs(b.time - start))[0];
  const name = near?.name ?? "";
  const custom = (parameters, duration, stagger) => ({ preset: { id: "preset-custom-text", mode: "in", parameters }, start, duration, unit: "letters", stagger });
  if (/^song-(drop|stop)/.test(name) || near?.kind === "accent")
    return { animation: custom({ moveX: null, moveY: null, angle: null, scale: 180, opacity: 0, color: null, blur: 12 }, 0.24, 0.03), why: `letters slam in on cue:${name} (${near.time} s)` };
  if (/^song-build/.test(name))
    return { animation: custom({ moveX: null, moveY: 100, angle: null, scale: null, opacity: 0, color: null, blur: null }, 0.5, 0.07), why: `letters rise in on cue:${name} (${near.time} s)` };
  if (near)
    return { animation: custom({ moveX: null, moveY: null, angle: null, scale: 60, opacity: 0, color: null, blur: null }, 0.2, 0.04), why: `letters pop in on cue:${name} (${near.time} s)` };
  return { animation: custom({ moveX: null, moveY: 60, angle: null, scale: null, opacity: 0, color: null, blur: null }, 0.4, 0.05), why: `letters rise in at ${start} s (no cue within 3 frames)` };
}
