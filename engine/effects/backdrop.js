import { copyContent, copySource, filterEffect } from "./svg.js";
import { effectMapImage } from "./mapImage.js";
import { vectorDisplacementMap } from "./periodicDisplacement.js";
import { silhouetteField } from "./silhouetteField.js";

const fmt = (value) => String(Math.round(value * 1e6) / 1e6);
const extent = ({ x, y, width, height }) => `x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}"`;

/** Clip decorative backdrop paint without adding selectable or accessible copies. */
export function clipBackdrop(frame, markup, silhouette) {
  if (!silhouette || typeof silhouette.markup !== "string") throw new TypeError("A backdrop silhouette is required.");
  const id = frame.helpers.id("backdrop-mask");
  frame.helpers.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" ${extent(frame.bounds)} style="mask-type:alpha">${silhouette.markup}</mask>`);
  return `<g aria-hidden="true" pointer-events="none" mask="url(#${id})">${frame.helpers.clipSentinel?.() ?? ""}${markup}</g>`;
}

/**
 * Crop before blurring, then extend only the crop's edge pixels. Filter results
 * cache the cropped center, edge strips and corner samples, so the lower DOM is
 * painted once for this input. Repeating nine copies of the DOM would multiply
 * the paint work for every nested backdrop. Native rotated/sheared subregions
 * lose their local axes in resvg; that path retains geometric SVG viewports.
 * No BackgroundImage or local feImage is involved.
 */
export function edgeExtendedBackdrop(frame, padding) {
  const { x, y, width, height } = frame.bounds;
  if (![x, y, width, height, padding].every(Number.isFinite) || width <= 0 || height <= 0 || padding < 0 || padding > 512)
    throw new RangeError("Backdrop bounds and padding must be finite and bounded.");
  const sliceX = Math.min(1, width), sliceY = Math.min(1, height);
  const xs = padding > 0 ? [
    { at: x - padding, size: padding, from: x, sample: sliceX },
    { at: x, size: width, from: x, sample: width },
    { at: x + width, size: padding, from: x + width - sliceX, sample: sliceX },
  ] : [{ at: x, size: width, from: x, sample: width }];
  const ys = padding > 0 ? [
    { at: y - padding, size: padding, from: y, sample: sliceY },
    { at: y, size: height, from: y, sample: height },
    { at: y + height, size: padding, from: y + height - sliceY, sample: sliceY },
  ] : [{ at: y, size: height, from: y, sample: height }];
  const matrix = frame.helpers.transform;
  const nativeAxes = !Array.isArray(matrix) || Math.abs(matrix[1]) + Math.abs(matrix[2]) < 1e-9;
  if (padding > 0 && (!frame.helpers.raster || nativeAxes)) {
    // feComposite's explicit subregion crops without changing source alpha.
    // feTile uses that subregion as its tile and clips to its own destination
    // region. A one-pixel strip repeats its edge color outwards; no outside
    // artwork can enter the sample. The center and eight extensions meet only
    // at their boundaries and merge without multiplying translucent alpha.
    const primitives = ['<feFlood flood-color="#FFFFFF" result="backdropOpaque"/>'];
    const results = [];
    let index = 0;
    for (const column of xs) for (const row of ys) {
      const sourceRegion = { x: column.from, y: row.from, width: column.sample, height: row.sample };
      const destination = { x: column.at, y: row.at, width: column.size, height: row.size };
      const tile = `backdropCrop${index}`, result = `backdropEdge${index++}`;
      primitives.push(`<feComposite in="SourceGraphic" in2="backdropOpaque" operator="in" ${extent(sourceRegion)} result="${tile}"/>`);
      const center = column.at === x && column.size === width && row.at === y && row.size === height;
      if (center) results.push(tile);
      else {
        primitives.push(`<feTile in="${tile}" ${extent(destination)} result="${result}"/>`);
        results.push(result);
      }
    }
    primitives.push(`<feMerge>${results.map((result) => `<feMergeNode in="${result}"/>`).join("")}</feMerge>`);
    const cropped = `<svg ${extent(frame.bounds)} viewBox="${fmt(x)} ${fmt(y)} ${fmt(width)} ${fmt(height)}" preserveAspectRatio="none" overflow="hidden">${copyContent(frame.content)}</svg>`;
    return filterEffect({ ...frame, content: cropped }, primitives, { padding });
  }
  const source = copySource(frame);
  return xs.flatMap((column) => ys.map((row) =>
    `<svg ${extent({ x: column.at, y: row.at, width: column.size, height: row.size })} viewBox="${fmt(column.from)} ${fmt(row.from)} ${fmt(column.sample)} ${fmt(row.sample)}" preserveAspectRatio="none" overflow="hidden">${source}</svg>`)).join("");
}

export function renderBackdropBlur(frame, radius, silhouette) {
  const safeRadius = Math.max(0, Math.min(100, Number.isFinite(radius) ? radius : 4));
  const padding = Math.ceil(safeRadius * 3 + 1);
  const content = edgeExtendedBackdrop(frame, safeRadius ? padding : 0);
  const blurred = safeRadius ? filterEffect({ ...frame, content },
    `<feGaussianBlur in="SourceGraphic" stdDeviation="${fmt(safeRadius)}"/>`, { padding }) : content;
  return clipBackdrop(frame, blurred, silhouette);
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const number = (parameters, key, fallback, high = 100, low = 0) => clamp(Number.isFinite(parameters?.[key]) ? parameters[key] : fallback, low, high);

// Add isolated channels in premultiplied space, then remove excess alpha without
// multiplying RGB a second time. This retains translucent backdrop edges.
function combineDispersedChannels(primitives, inputs) {
  const alphaGray = "0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 1";
  inputs.forEach((input, channel) => {
    const rows = [0, 1, 2].map((row) => row === channel
      ? [0, 0, 0, 0, 0].map((value, column) => column === channel ? 1 : value).join(" ")
      : "0 0 0 0 0");
    primitives.push(`<feColorMatrix in="${input}" values="${rows.join(" ")} 0 0 0 1 0" result="glassChannel${channel}"/>`);
    primitives.push(`<feColorMatrix in="${input}" values="${alphaGray}" result="glassAlpha${channel}"/>`);
  });
  primitives.push(
    '<feComposite in="glassChannel0" in2="glassChannel1" operator="arithmetic" k2="1" k3="1" result="glassSum01"/>',
    '<feComposite in="glassSum01" in2="glassChannel2" operator="arithmetic" k2="1" k3="1" result="glassSum"/>',
    '<feBlend in="glassAlpha0" in2="glassAlpha1" mode="lighten" result="glassMax01"/>',
    '<feBlend in="glassMax01" in2="glassAlpha2" mode="lighten" result="glassMaxAlpha"/>',
    '<feColorMatrix in="glassMaxAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0" result="glassDesiredAlpha"/>',
    '<feColorMatrix in="glassSum" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="glassSumAlpha"/>',
    '<feComposite in="glassSumAlpha" in2="glassDesiredAlpha" operator="arithmetic" k2="1" k3="-1" result="glassExcessAlpha"/>',
    '<feComposite in="glassSum" in2="glassExcessAlpha" operator="arithmetic" k2="1" k3="-1" result="glassRefracted"/>',
  );
  return "glassRefracted";
}

/**
 * Original bevel glass. The bounded
 * silhouette SDF supplies inward normals. Only a Depth-wide edge band bends the
 * cropped backdrop, leaving its flat interior unchanged. Dispersion samples
 * RGB at nearby scales; Frost blurs/lightens, and directional edge light adds a
 * white highlight. Shape geometry and available glyph outlines drive the field;
 * raster/color glyphs use their box for the field and their alpha for clipping.
 */
export function renderGlassBackdrop(frame, parameters, silhouette) {
  const refraction = number(parameters, "refraction", 50) / 100;
  const depth = number(parameters, "depth", 50) / 100;
  const dispersion = number(parameters, "dispersion", 50) / 100;
  const frost = number(parameters, "frost", 0);
  const light = number(parameters, "lightIntensity", 100, 200) / 100;
  const angle = number(parameters, "lightAngle", 0, 360, -360) * Math.PI / 180;
  const shortSide = Math.min(frame.bounds.width, frame.bounds.height);
  const band = shortSide * 0.25 * depth;
  const displacement = Math.min(128, shortSide * 0.25 * refraction);
  const sigma = Math.min(60, shortSide / 2, frost * 0.6);
  const padding = Math.ceil(displacement * 1.1 + sigma * 3 + 1);
  const content = edgeExtendedBackdrop(frame, padding);
  const source = { ...frame, content };
  const primitives = [];
  let output = "SourceGraphic";
  let field = null;
  const geometryKey = JSON.stringify([silhouette.path, silhouette.fillRule, frame.bounds]);
  if (band > 0 && displacement > 0 && silhouette.path) {
    field = silhouetteField({ path: silhouette.path, fillRule: silhouette.fillRule, bounds: frame.bounds });
    const vectorAt = (u, v) => {
      const sample = field.sample(u, v);
      const profile = sample.distance > 0 && sample.distance < band ? Math.sin(Math.PI * sample.distance / band) : 0;
      return { x: sample.nx * profile, y: sample.ny * profile };
    };
    const map = vectorDisplacementMap(source, [{ key: `glass-bevel-v1|${geometryKey}|${depth}`, vectorAt, weight: 1 }], 2 * displacement, { padding });
    primitives.push(...map.primitives);
    const scales = dispersion ? [1 + dispersion * 0.1, 1, 1 - dispersion * 0.1] : [1];
    const inputs = scales.map((scale, index) => {
      const result = `glassDisplaced${index}`;
      primitives.push(`<feDisplacementMap in="SourceGraphic" in2="${map.input}" scale="${fmt(map.scale * scale)}" xChannelSelector="${map.xChannel}" yChannelSelector="${map.yChannel}" result="${result}"/>`);
      return result;
    });
    output = dispersion ? combineDispersedChannels(primitives, inputs) : inputs[0];
  }
  if (sigma > 0) {
    primitives.push(`<feGaussianBlur in="${output}" stdDeviation="${fmt(sigma)}" result="glassFrost"/>`);
    const lift = Math.min(0.2, frost * 0.002);
    primitives.push(`<feComponentTransfer in="glassFrost" result="glassFrostLight"><feFuncR type="linear" slope="${fmt(1 - lift)}" intercept="${fmt(lift)}"/><feFuncG type="linear" slope="${fmt(1 - lift)}" intercept="${fmt(lift)}"/><feFuncB type="linear" slope="${fmt(1 - lift)}" intercept="${fmt(lift)}"/></feComponentTransfer>`);
    output = "glassFrostLight";
  }
  let painted = primitives.length ? filterEffect(source, primitives, { padding }) : content;
  if (field && light > 0) {
    const key = `glass-light-v1|${geometryKey}|${depth}|${refraction}|${light}|${fmt(Math.cos(angle))},${fmt(Math.sin(angle))}`;
    const uri = effectMapImage(frame, key, (x, y, width, height) => {
      const sample = field.sample((x + 0.5) / width, (y + 0.5) / height);
      const profile = sample.distance > 0 && sample.distance < band ? Math.sin(Math.PI * sample.distance / band) : 0;
      const facing = Math.max(0, -sample.nx * Math.cos(angle) - sample.ny * Math.sin(angle));
      return [255, 255, 255, Math.round(clamp(profile * facing * light * refraction * 0.22, 0, 1) * 255)];
    });
    painted += `<image ${extent(frame.bounds)} href="${uri}" preserveAspectRatio="none"/>`;
  }
  return clipBackdrop(frame, painted, silhouette);
}
