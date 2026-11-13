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
 * Switches to `theme` and keeps the choice. The new theme opens as a circle from `origin`
 * ({x, y} in the window, the button pressed) over half a second; with `still` (reduced motion),
 * or where the browser has no view transitions, it changes at once.
 */
export function switchTheme(theme, { origin = null, still = false, doc = globalThis.document, storage } = {}) {
  setSetting(KEY, theme, storage);
  const root = doc?.documentElement;
  if (!root) return;
  if (still || !origin || typeof doc.startViewTransition !== "function") { showTheme(theme, root); return; }
  const view = doc.defaultView;
  const radius = Math.hypot(Math.max(origin.x, view.innerWidth - origin.x), Math.max(origin.y, view.innerHeight - origin.y));
  root.style.setProperty("--theme-x", `${origin.x}px`);
  root.style.setProperty("--theme-y", `${origin.y}px`);
  root.style.setProperty("--theme-r", `${Math.ceil(radius)}px`);
  root.dataset.themeSwitch = "on";
  const transition = doc.startViewTransition(() => showTheme(theme, root));
  transition.finished.finally(() => { delete root.dataset.themeSwitch; });
}
