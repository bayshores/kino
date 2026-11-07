import { Resvg } from "@resvg/resvg-js";

/** Normalize an uploaded static SVG into drawing-only SVG, preserving vector resolution. */
export function prepareSvgAsset(bytes, { fontFiles = [] } = {}) {
  const text = Buffer.from(bytes).toString("utf8");
  if (/<!\s*(?:doctype|entity)\b/i.test(text)) throw new Error("SVG image assets cannot contain DOCTYPE or entity declarations.");
  if (/<(?:[\w-]+:)?(?:script|foreignObject|animate|animateMotion|animateTransform|set)\b/i.test(text))
    throw new Error("SVG image assets must be static. Remove scripts, embedded HTML and SVG animations.");
  for (const match of text.matchAll(/\b(?:[\w-]+:)?href\s*=\s*(["'])(.*?)\1/gs)) {
    const href = match[2].trim();
    if (!href.startsWith("#") && !/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-zA-Z0-9+/=]+$/.test(href))
      throw new Error("Embed images inside the SVG instead of linking to external files.");
  }
  let svg;
  try { svg = new Resvg(text, { font: { loadSystemFonts: false, fontFiles, defaultFontFamily: "Inter" } }); }
  catch { throw new Error("This SVG image could not be decoded."); }
  if (svg.imagesToResolve().length) throw new Error("Embed images inside the SVG instead of linking to external files.");
  if (!Number.isFinite(svg.width) || !Number.isFinite(svg.height) || svg.width < 1 || svg.height < 1 || svg.width > 65_536 || svg.height > 65_536)
    throw new Error("SVG image dimensions must be between 1 and 65536 pixels.");
  // usvg serializes only its parsed drawing tree, with text outlined in the bundled fonts.
  // The original XML (event handlers, links and other non-drawing attributes) is not served.
  return { buffer: Buffer.from(svg.toString()), measurements: { width: svg.width, height: svg.height, duration: 0 } };
}

/** Export staging uses real PNG pixels; the saved asset and browser preview stay vector. */
export function rasterizeSvgAsset(bytes, { width, height }) {
  const font = { loadSystemFonts: false };
  const source = new Resvg(bytes, { font });
  const desired = Math.max(1, width / source.width, height / source.height);
  const zoom = Math.min(desired, 8192 / Math.max(source.width, source.height));
  return new Resvg(bytes, { font, fitTo: { mode: "zoom", value: zoom } }).render().asPng();
}
