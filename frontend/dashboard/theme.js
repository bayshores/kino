// The dashboard's theme: dark or light. The person's choice is kept on this machine; without
// one the system's setting decides. The page carries it as <html data-theme="dark|light">
// (dashboard.css and base.css read it).
import { getSetting, setSetting } from "../browserStorage.js";

const KEY = "dashboard.theme";
export const THEMES = ["dark", "light"];

/** The theme to start with: the kept choice, else the system's ("dark" when it does not say). */
export function startTheme({ stored = getSetting(KEY), systemLight = globalThis.matchMedia?.("(prefers-color-scheme: light)").matches } = {}) {
  if (THEMES.includes(stored)) return stored;
  return systemLight ? "light" : "dark";
}

/** The other theme. */
export function otherTheme(theme) {
  return theme === "light" ? "dark" : "light";
}

/** Puts `theme` on the page, with no animation. */
export function showTheme(theme, root = globalThis.document?.documentElement) {
  if (root) root.dataset.theme = theme;
}

/**
 * The circle that opens from `origin` and covers a `width` by `height` window, as percentages of the
 * window (circle() measures a radius against the diagonal divided by the square root of 2).
 * Percentages, not pixels: on a 2x screen the picture of the new theme took pixel lengths at half
 * size, so the circle opened from the wrong place, never reached the far corner, and the rest of
 * the window changed at once when the half second ended.
 */
export function themeCircle(origin, width, height) {
  const reach = Math.hypot(Math.max(origin.x, width - origin.x), Math.max(origin.y, height - origin.y));
  const percent = (value) => `${Math.round(value * 1000) / 10}%`;
  return { x: percent(origin.x / width), y: percent(origin.y / height), r: percent(reach / (Math.hypot(width, height) / Math.SQRT2) + 0.01) };
}

/**
 * Switches to `theme` and keeps the choice. The new theme opens as a circle from `origin`
 * ({x, y} in the window, the button pressed) over 0.6 s; with `still` (reduced motion),
 * or where the browser has no view transitions, it changes at once.
 */
export function switchTheme(theme, { origin = null, still = false, doc = globalThis.document, storage } = {}) {
  setSetting(KEY, theme, storage);
  const root = doc?.documentElement;
  if (!root) return;
  if (still || !origin || typeof doc.startViewTransition !== "function") { showTheme(theme, root); return; }
  const circle = themeCircle(origin, doc.defaultView.innerWidth, doc.defaultView.innerHeight);
  root.style.setProperty("--theme-x", circle.x);
  root.style.setProperty("--theme-y", circle.y);
  root.style.setProperty("--theme-r", circle.r);
  root.dataset.themeSwitch = "on";
  const transition = doc.startViewTransition(() => showTheme(theme, root));
  transition.finished.finally(() => { delete root.dataset.themeSwitch; });
}
