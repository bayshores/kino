import { effectMapImage } from "./mapImage.js";
import { filterEffect } from "./svg.js";
import { numberParameter, renderVectorDisplacement } from "./periodicDisplacement.js";

const byte = (value) => Math.max(0, Math.min(255, Math.round(value)));
const smoothStep = (edge0, edge1, value) => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Original fluted-glass approximation: a horizontal sinusoidal refraction
 * map plus soft white flute bands clipped to the refracted source alpha.
 * Columns are flute cycles across the layer width; Strength is a fraction of
 * one pitch; Glow Width is a band-width fraction of a pitch; Glow Strength is
 * highlight opacity. The reference's proprietary shader math is unverified.
 */
export function renderFlutedGlass(frame) {
  const columns = numberParameter(frame, "columns", 12, 1, 128, { integer: true });
  const strength = numberParameter(frame, "strength", 0.45, 0, 1);
  const glowStrength = numberParameter(frame, "glowStrength", 0.01, 0, 1);
  const glowWidth = numberParameter(frame, "glowWidth", 0.4, 0.01, 2);
  const pitch = frame.bounds.width / columns;
  const maxShift = Math.min(128, pitch * strength);
  const displacementKey = JSON.stringify(["fluted-glass-v2", columns, frame.bounds.width, frame.bounds.height]);
  const refracted = renderVectorDisplacement(frame, displacementKey, maxShift, (u) => ({
    x: Math.sin(2 * Math.PI * columns * u),
    y: 0,
  }), { padding: maxShift + 1 });
  if (glowStrength === 0) return refracted;

  const { x, y, width, height } = frame.bounds;
  const bandKey = JSON.stringify(["fluted-bands-v1", columns, glowWidth, width, height]);
  const bands = effectMapImage(frame, bandKey, (pixelX, _pixelY, mapWidth) => {
    const u = (pixelX + 0.5) / mapWidth;
    const position = columns * u;
    const fraction = position - Math.floor(position);
    const distance = Math.min(fraction, 1 - fraction);
    const halfWidth = Math.min(0.49, glowWidth * 0.25);
    const softness = Math.max(0.002, halfWidth * 0.4);
    const alpha = 1 - smoothStep(Math.max(0, halfWidth - softness), halfWidth + softness, distance);
    return [255, 255, 255, byte(alpha * 255)];
  });

  // The first filter can extend the warped paint beyond the fixed layer box.
  // Carry that exact extent into the band filter so it cannot clip the warp.
  const priorPaint = frame.paintBounds ?? frame.bounds;
  const displacementPadding = maxShift === 0 ? 0 : maxShift + 1;
  const priorRegion = {
    x: priorPaint.x - displacementPadding,
    y: priorPaint.y - displacementPadding,
    width: priorPaint.width + 2 * displacementPadding,
    height: priorPaint.height + 2 * displacementPadding,
  };
  return filterEffect({ ...frame, content: refracted, paintBounds: priorRegion }, [
    `<feImage href="${bands}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" result="fluteBands"/>`,
    '<feComposite in="fluteBands" in2="SourceAlpha" operator="in" result="fluteBandsInSource"/>',
    `<feComponentTransfer in="fluteBandsInSource" result="fluteHighlights"><feFuncA type="linear" slope="${glowStrength}"/></feComponentTransfer>`,
    '<feBlend in="SourceGraphic" in2="fluteHighlights" mode="screen"/>',
  ], { padding: 0 });
}
