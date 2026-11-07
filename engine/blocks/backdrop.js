// A look's background treatment, drawn under everything a composition adds:
//   solid  the scene's background colour only
//   rule   a short accent rule in the top margin (editorial)
//   block  a surface-coloured block along one side (bold)
//   glow   a soft accent glow that drifts slowly the whole time (calm); marked perpetual
//   band   a surface band across the lower part of the frame (data)
// Every layer is decor, so the checker's text, overlap and pacing rules skip it.
import { createLayer } from "../model.js";
import { isPortraitFrame, safeArea } from "./formats.js";
import { paint, withAlpha } from "./build.js";
import { round } from "../numbers.js";

/**
 * The background layers for `style` in a scene `duration` seconds long. Reduced motion keeps
 * the glow still. IDs start with `id` (such as "promo-bg").
 */
export function backdropLayers(style, { frame, duration, id, reduced = false }) {
  const { width, height } = frame;
  const scale = style.scale;
  const safe = safeArea(frame);
  const portrait = isPortraitFrame(frame);
  const decor = (type, overrides) => createLayer(type, { role: "decor", allowOverlap: true, ...overrides });
  switch (style.background) {
    case "rule": {
      const thick = Math.max(3, Math.round(4 * scale));
      return [decor("rectangle", {
        id: `${id}-rule`, name: "Accent rule", x: safe.x, y: Math.max(8, Math.round(safe.y / 2 - thick / 2)),
        width: Math.round(width * (portrait ? 0.22 : 0.12)), height: thick, fill: paint(style, "accent"), radius: 0,
      })];
    }
    case "block": {
      if (portrait) {
        const blockHeight = Math.round(height * 0.3);
        return [decor("rectangle", { id: `${id}-block`, name: "Side block", x: 0, y: height - blockHeight, width, height: blockHeight, fill: paint(style, "surface"), radius: 0 })];
      }
      const blockWidth = Math.round(width * 0.34);
      return [decor("rectangle", { id: `${id}-block`, name: "Side block", x: width - blockWidth, y: 0, width: blockWidth, height, fill: paint(style, "surface"), radius: 0 })];
    }
    case "glow": {
      const size = Math.round(Math.max(width, height) * 0.75);
      const x = Math.round(width * (portrait ? 0.1 : 0.42) - size / 2 + width * 0.08);
      const y = Math.round(height * (portrait ? 0.32 : 0.36) - size / 2);
      const accent = paint(style, "accent");
      const drift = Math.round(width * 0.06);
      const glow = decor("ellipse", {
        id: `${id}-glow`, name: "Glow", x, y, width: size, height: size, perpetual: true,
        fill: { type: "radial", angle: 0, stops: [{ offset: 0, color: withAlpha(accent, 0.2) }, { offset: 1, color: withAlpha(accent, 0) }] },
        animations: reduced || duration <= 0 ? [] : [{
          id: `${id}-glow.drift`, name: "Drift", kind: "custom", start: 0, duration: round(duration), easing: "smooth",
          unit: "layer", stagger: 0, order: "forward", from: { x }, to: { x: x + drift },
        }],
      });
      return [glow];
    }
    case "band": {
      const bandHeight = Math.round(height * (portrait ? 0.16 : 0.22));
      return [decor("rectangle", { id: `${id}-band`, name: "Band", x: 0, y: Math.round(height * 0.7), width, height: bandHeight, fill: paint(style, "surface"), radius: 0 })];
    }
    default:
      return [];
  }
}
