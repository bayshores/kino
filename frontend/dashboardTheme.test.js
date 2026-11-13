// The dashboard's theme (frontend/dashboard/theme.js): the kept choice wins over the system's
// setting, and a switch is kept and put on the page.
import test from "node:test";
import assert from "node:assert/strict";
import { otherTheme, startTheme, switchTheme } from "./dashboard/theme.js";

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
});
