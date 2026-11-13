// The dashboard's theme (frontend/dashboard/theme.js): the kept choice wins over the system's
// setting, and a switch is kept and put on the page.
import test from "node:test";
import assert from "node:assert/strict";
import { otherTheme, startTheme, switchTheme, themeCircle } from "./dashboard/theme.js";

test("the theme starts from the kept choice, else the system; a switch is kept and shown", () => {
  assert.equal(startTheme({ stored: null, systemLight: true }), "light");
  assert.equal(startTheme({ stored: null, systemLight: false }), "dark");
  assert.equal(startTheme({ stored: "dark", systemLight: true }), "dark");
  assert.equal(startTheme({ stored: "pink", systemLight: false }), "dark", "an unknown kept value is not used");
  assert.equal(otherTheme("dark"), "light");
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const doc = { documentElement: { dataset: {} } };
  switchTheme("light", { doc, storage, still: true });
  assert.equal(doc.documentElement.dataset.theme, "light");
  assert.equal(values.get("kino-dashboard.theme"), "light");
  // The opening circle is in percentages of the window (right at any pixel scale), and its radius
  // reaches the corner farthest from the button: 1550 px of a 1440 by 900 window.
  assert.deepEqual(themeCircle({ x: 1280, y: 26 }, 1440, 900), { x: "88.9%", y: "2.9%", r: "130.1%" });
});
