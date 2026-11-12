// A text layer's material: designed lettering beyond a font's flat fill. Three parts, each one
// optional and each with its own seed and amount, drawn on the letters' own outlines so they move,
// scale and turn with the letters (the stroke and the print stay locked to the fill):
// - wear: the outline eroded by seeded noise, most at the very edge and less deeper in (worn,
//   stamped or cracked paint). It cuts the fill, its strokes and the print alike.
// - texture: a seeded tile inside the letters only (brush drag, crackle, halftone or grain), in
//   one color over the fill.
// - print: a second, misregistered copy of the letters under them (offset, color, opacity).
// Amount 0 (opacity 0 for the print) leaves that part out: the drawing is then exactly the
// letters with no material. The material has no motion of its own, so reduced motion changes
// nothing. Drawn as plain SVG (patterns, a clip and a mask with PNG tiles kino makes itself), so
// the preview, look, check and export draw the same.
import { cachedMap, fractalNoise, noise2d } from "./effects/maps.js";

export const MATERIAL_TEXTURES = Object.freeze(["grain", "brush", "crackle", "halftone"]);
const PARTS = { wear: ["amount", "seed", "size"], texture: ["kind", "amount", "seed", "size", "color"], print: ["x", "y", "color", "opacity"] };
// Starting guesses, in parts of the font size, for a size the agent leaves out (printed as such).
// printX/printY: the print's offset when x and y are both left out, so a print given only a color
// still shows (12 px across and 7 px down on a 240 px word, 6 and 4 px in a 960 px draft of it).
export const MATERIAL_GUESSES = Object.freeze({ wearSize: 0.05, textureSize: 0.03, printX: 0.05, printY: 0.03 });

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const fail = (path, message) => { throw new TypeError(`${path}: ${message}`); };
const fmt = (value) => String(Math.round(value * 1000) / 1000);

function hex(value, path) {
  if (typeof value !== "string" || !HEX.test(value)) fail(path, "must be a 3 or 6 digit hex color");
  return (value.length === 4 ? `#${[...value.slice(1)].map((digit) => digit + digit).join("")}` : value).toUpperCase();
}

function number(value, path, min, max, { integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    fail(path, `must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}`);
  return value;
}

/** The checked material, or null when it is empty. Throws a TypeError naming the bad field. */
export function normalizeMaterial(value, path = "material") {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object {wear, texture, print}");
  const output = {};
  for (const [part, raw] of Object.entries(value)) {
    const at = `${path}.${part}`;
    if (!Object.hasOwn(PARTS, part)) fail(at, "is not a material part: use wear, texture or print");
    if (raw === null || raw === undefined) continue;
    // Shorthands: wear:0.6 is {amount:0.6}, texture:"crackle" is {kind:"crackle"}, print:"#FF3FA4" is {color}.
    const given = part === "wear" && typeof raw === "number" ? { amount: raw }
      : part === "texture" && typeof raw === "string" ? { kind: raw }
        : part === "print" && typeof raw === "string" ? { color: raw } : raw;
    if (typeof given !== "object" || Array.isArray(given)) fail(at, part === "wear" ? "must be an object or an amount 0..1" : part === "texture" ? "must be an object or a kind" : "must be an object or a hex color");
    for (const field of Object.keys(given)) if (!PARTS[part].includes(field)) fail(`${at}.${field}`, `is not a field of ${part}: use ${PARTS[part].join(", ")}`);
    const entry = {};
    if (part !== "print") {
      entry.amount = number(given.amount ?? 0.5, `${at}.amount`, 0, 1);
      entry.seed = number(given.seed ?? 1, `${at}.seed`, 0, 1_000_000, { integer: true });
      if (given.size !== undefined) entry.size = number(given.size, `${at}.size`, 0.5, 2000);
    }
    if (part === "texture") {
      if (!MATERIAL_TEXTURES.includes(given.kind)) fail(`${at}.kind`, `must be ${MATERIAL_TEXTURES.join(", ")}`);
      entry.kind = given.kind;
      entry.color = hex(given.color ?? "#000000", `${at}.color`);
    }
    if (part === "print") {
      // Both left out: the offset follows the font size when drawn (MATERIAL_GUESSES); one given: the other is 0.
      if (given.x !== undefined || given.y !== undefined) {
        entry.x = number(given.x ?? 0, `${at}.x`, -2000, 2000);
        entry.y = number(given.y ?? 0, `${at}.y`, -2000, 2000);
      }
      entry.color = hex(given.color ?? "#000000", `${at}.color`);
      entry.opacity = number(given.opacity ?? 1, `${at}.opacity`, 0, 1);
    }
    output[part] = entry;
  }
  return Object.keys(output).length ? output : null;
}

// The parts that draw something: amount (or the print's opacity) above 0. A part left without a
// field (a layer not yet checked by normalizeMaterial) takes the same defaults the check gives.
// A print with neither x nor y takes the offset that follows the font size (`guessed` marks it).
function activeParts(material, fontSize = 100) {
  if (!material || typeof material !== "object") return null;
  const filled = (part, defaults) => (part && typeof part === "object" ? { ...defaults, ...part } : null);
  const wear = filled(material.wear, { amount: 0.5, seed: 1 });
  const texture = filled(material.texture, { amount: 0.5, seed: 1, color: "#000000" });
  const offsetLeftOut = material.print && typeof material.print === "object" && material.print.x === undefined && material.print.y === undefined;
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 100;
  const print = filled(material.print, { color: "#000000", opacity: 1,
    ...(offsetLeftOut ? { x: Math.max(1, Math.round(size * MATERIAL_GUESSES.printX)), y: Math.max(1, Math.round(size * MATERIAL_GUESSES.printY)), guessed: true } : { x: 0, y: 0 }) });
  const parts = {
    wear: wear?.amount > 0 ? wear : null,
    texture: texture?.amount > 0 && MATERIAL_TEXTURES.includes(texture.kind) ? texture : null,
    print: print?.opacity > 0 && (print.x || print.y) ? print : null,
  };
  return parts.wear || parts.texture || parts.print ? parts : null;
}

export const hasMaterial = (state) => activeParts(state?.material, state?.fontSize) !== null;

/** `bounds` (the letters' paint box) grown to hold the second print, so a blur or shadow keeps it. */
export function withPrintBounds(bounds, state) {
  const print = bounds && activeParts(state?.material, state?.fontSize)?.print;
  if (!print) return bounds;
  return { x: bounds.x + Math.min(0, print.x), y: bounds.y + Math.min(0, print.y),
    width: bounds.width + Math.abs(print.x), height: bounds.height + Math.abs(print.y) };
}

// ---- tiles: seamless PNGs, alpha only matters (kino draws them once per seed and setting) ----

const TILE_CELLS = 32;
const TILE_SIDE = 128;
const smooth = (edge0, edge1, value) => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const rgb = (color) => [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16));

// The wear field: seamless fractal noise 0..1 on the tile, and the value above which a given share
// of the tile lies (its own quantile, so amount 0.5 removes half of the band's area, whatever the
// noise's spread).
const wearValues = new Map();
function wearField(seed) {
  if (wearValues.has(seed)) return wearValues.get(seed);
  const values = new Float32Array(TILE_SIDE * TILE_SIDE);
  for (let y = 0; y < TILE_SIDE; y += 1) for (let x = 0; x < TILE_SIDE; x += 1)
    values[y * TILE_SIDE + x] = (fractalNoise(x * TILE_CELLS / TILE_SIDE, y * TILE_CELLS / TILE_SIDE, 3, seed, TILE_CELLS) + 1) / 2;
  const sorted = Float32Array.from(values).sort();
  const field = { values, quantile: (share) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - share) * sorted.length)))] };
  if (wearValues.size > 16) wearValues.clear();
  wearValues.set(seed, field);
  return field;
}

// Black where the wear removes paint (a share `removed` of the tile), clear elsewhere: a mask band.
function wearTile(seed, removed) {
  const share = Math.round(removed * 1000) / 1000;
  let field = null, cut = 0;
  return cachedMap(JSON.stringify(["type-wear-v1", seed, share]), TILE_SIDE, TILE_SIDE, (x, y) => {
    if (!field) { field = wearField(seed); cut = field.quantile(share); }
    return [0, 0, 0, share > 0 && field.values[y * TILE_SIDE + x] >= cut ? 255 : 0];
  });
}

// Wrapped distance on a unit tile.
const wrap = (delta) => delta - Math.round(delta);

// The texture tile: [width, height] in map pixels and the alpha (0..1) of each pixel.
function textureAlpha(kind, seed) {
  if (kind === "brush") {
    // Streaks: the same seamless noise, eight times longer across than down.
    return { width: 256, height: 32, at: (x, y) => smooth(0.52, 0.68, (fractalNoise(x * 16 / 256, y * 16 / 32, 3, seed, 16) + 1) / 2) };
  }
  if (kind === "crackle") {
    // Cracks: the borders between seeded cells (the distance to the nearest point against the second).
    const count = 6, points = [];
    for (let i = 0; i < count; i += 1) for (let j = 0; j < count; j += 1)
      points.push([(i + 0.5 + 0.8 * noise2d(i * 7.1, j * 3.3, seed)) / count, (j + 0.5 + 0.8 * noise2d(i * 2.9, j * 5.7, seed + 17)) / count]);
    return { width: TILE_SIDE, height: TILE_SIDE, at: (x, y) => {
      const u = (x + 0.5) / TILE_SIDE, v = (y + 0.5) / TILE_SIDE;
      let first = Infinity, second = Infinity;
      for (const [px, py] of points) {
        const distance = Math.hypot(wrap(u - px), wrap(v - py));
        if (distance < first) { second = first; first = distance; } else if (distance < second) second = distance;
      }
      return 1 - smooth(0.004, 0.018, second - first);
    } };
  }
  if (kind === "halftone") {
    // Dots on a 16 x 16 screen, their size following a slow seeded noise (a printed tone).
    const cells = 16;
    return { width: TILE_SIDE, height: TILE_SIDE, at: (x, y) => {
      const u = (x + 0.5) * cells / TILE_SIDE, v = (y + 0.5) * cells / TILE_SIDE;
      const tone = (fractalNoise(u / 4, v / 4, 2, seed, cells / 4) + 1) / 2;
      const radius = 0.15 + 0.35 * tone;
      return 1 - smooth(radius - 0.06, radius + 0.06, Math.hypot(u - Math.floor(u) - 0.5, v - Math.floor(v) - 0.5));
    } };
  }
  // Grain: fine seeded specks.
  return { width: TILE_SIDE, height: TILE_SIDE, at: (x, y) => smooth(0.6, 0.75, (noise2d(x * 0.5, y * 0.5, seed, TILE_SIDE / 2) + 1) / 2) };
}

function textureTile(kind, seed, color) {
  const tile = textureAlpha(kind, seed);
  const [r, g, b] = rgb(color);
  return { ...tile, uri: cachedMap(JSON.stringify(["type-texture-v1", kind, seed, color]), tile.width, tile.height, (x, y) => [r, g, b, Math.round(tile.at(x, y) * 255)]) };
}

/**
 * `content` (the letters as drawn: fill and strokes) with the material of `state` on it, or
 * `content` itself when no part draws anything. `outline` is the letters' outline path data,
 * `bounds` their box, `reach` how far strokes reach past the outline, all in the content's own
 * units; `defs` and `id(kind)` add definitions. `only` names the parts drawn in this pass
 * (letters drawn in two passes, outside strokes first: render.js unitsSvg).
 */
export function drawMaterial(content, { material, outline, bounds, fontSize = 100, reach = 0, defs, id, only = null }) {
  const active = activeParts(material, fontSize);
  if (!active || !outline || !bounds) return content;
  const pick = (part) => (!only || only.includes(part) ? active[part] : null);
  const wear = pick("wear"), texture = pick("texture"), print = pick("print");
  if (!wear && !texture && !print) return content;
  let over = "";
  if (texture) {
    const tile = textureTile(texture.kind, texture.seed, texture.color);
    // The tile's cell is `size` layer units (a starting guess of the font size when left out).
    const cell = texture.size ?? Math.max(0.5, fontSize * MATERIAL_GUESSES.textureSize);
    const scale = cell * (texture.kind === "halftone" ? 16 : TILE_CELLS) / tile.height;
    const width = tile.width * scale, height = tile.height * scale;
    const patternId = id("material-texture"), clipId = id("material-clip");
    defs.push(`<pattern id="${patternId}" patternUnits="userSpaceOnUse" x="0" y="0" width="${fmt(width)}" height="${fmt(height)}"><image href="${tile.uri}" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none"/></pattern>`,
      `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="${outline}"/></clipPath>`);
    over = `<g clip-path="url(#${clipId})"><rect x="${fmt(bounds.x)}" y="${fmt(bounds.y)}" width="${fmt(bounds.width)}" height="${fmt(bounds.height)}" fill="url(#${patternId})"${texture.amount < 1 ? ` opacity="${fmt(texture.amount)}"` : ""}/></g>`;
  }
  let maskId = null;
  if (wear) {
    // Three bands along the outline, the narrowest removing the most: at the very edge a share
    // `amount` of the paint goes, a third of the depth in two thirds of that, at the full depth a
    // third. The same noise for all three, so the removed areas nest into one worn edge.
    const depth = wear.size ?? Math.max(0.5, fontSize * MATERIAL_GUESSES.wearSize);
    const side = Math.max(1, depth * 0.6) * TILE_CELLS;
    const offset = (wear.seed % 97) * side / 97;
    const bands = [1, 2, 3].map((step) => {
      const patternId = id("material-wear");
      defs.push(`<pattern id="${patternId}" patternUnits="userSpaceOnUse" x="${fmt(offset)}" y="${fmt(offset)}" width="${fmt(side)}" height="${fmt(side)}"><image href="${wearTile(wear.seed, wear.amount * (4 - step) / 3)}" width="${fmt(side)}" height="${fmt(side)}" preserveAspectRatio="none"/></pattern>`);
      return `<path d="${outline}" fill="none" stroke="url(#${patternId})" stroke-width="${fmt(2 * (reach + depth * step / 3))}" stroke-linejoin="round"/>`;
    }).reverse();
    const margin = reach + depth + 2;
    const area = `x="${fmt(bounds.x - margin)}" y="${fmt(bounds.y - margin)}" width="${fmt(bounds.width + margin * 2)}" height="${fmt(bounds.height + margin * 2)}"`;
    maskId = id("material-wear-mask");
    defs.push(`<mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" ${area}><rect ${area} fill="white"/>${bands.join("")}</mask>`);
  }
  const worn = (markup) => (maskId ? `<g mask="url(#${maskId})">${markup}</g>` : markup);
  // The print is the same worn letters moved by its offset: the mask moves with it, so its own
  // edges wear the same way and the letters' worn band never cuts holes in it.
  const under = print ? `<g transform="translate(${fmt(print.x)} ${fmt(print.y)})">${worn(`<path d="${outline}" fill="${print.color}"${print.opacity < 1 ? ` fill-opacity="${fmt(print.opacity)}"` : ""}/>`)}</g>` : "";
  const letters = content || over ? worn(`${content}${over}`) : "";
  return `<g>${under}${letters}</g>`;
}

/** One line for a receipt: what the material draws, with sizes left out marked as starting guesses. */
export function materialWords(material, fontSize = 100) {
  const parts = activeParts(material, fontSize);
  if (!parts) return "no material (every amount 0, or a print offset 0,0)";
  const words = [];
  const px = (value) => `${fmt(value)} px`;
  if (parts.wear) words.push(`wear ${parts.wear.amount} seed ${parts.wear.seed}, ${parts.wear.size != null ? `${px(parts.wear.size)} deep` : `${px(Math.max(0.5, fontSize * MATERIAL_GUESSES.wearSize))} deep (a starting guess: ${MATERIAL_GUESSES.wearSize} of the ${fmt(fontSize)} px size)`}`);
  if (parts.texture) words.push(`${parts.texture.kind} ${parts.texture.color} at ${parts.texture.amount} seed ${parts.texture.seed}, ${parts.texture.size != null ? `${px(parts.texture.size)} cells` : `${px(Math.max(0.5, fontSize * MATERIAL_GUESSES.textureSize))} cells (a starting guess: ${MATERIAL_GUESSES.textureSize} of the size)`}`);
  if (parts.print) words.push(`print ${parts.print.color} offset ${fmt(parts.print.x)},${fmt(parts.print.y)} px${parts.print.guessed ? ` (a starting guess: ${MATERIAL_GUESSES.printX},${MATERIAL_GUESSES.printY} of the size)` : ""} at ${parts.print.opacity}`);
  return words.join("; ");
}
