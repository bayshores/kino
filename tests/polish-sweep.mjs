// The polish sweep: every recipe in every look and format, made into a scene the way the A4 gate
// makes it (tests/blocks-gate.mjs), and three whole compositions (promo, explainer, clip), checked with every rule and real frames. It returns each
// scene's findings so a test (backend/blocks-polish.test.mjs) can say the building blocks come out
// clean by default: no errors and none of the polish warnings in BANNED.
//
// Run it by hand to see the counts: node --import ./scripts/test-fonts.mjs tests/polish-sweep.mjs
// [recipe or composition names, comma separated]; SEED=n picks the seed, SHOW=rule,rule prints those warnings.
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createScene } from "../engine/model.js";
import { RECIPES, RECIPE_NAMES } from "../engine/blocks/recipes/index.js";
import { runRecipe } from "../engine/blocks/recipe.js";
import { composeScene } from "../engine/blocks/compose.js";
import { LOOK_NAMES, styleFor, typeFloor } from "../engine/blocks/looks.js";
import { parseFormat } from "../engine/blocks/formats.js";
import { EXAMPLES } from "../engine/blocks/examples.js";
import { defaultFonts } from "../engine/fonts.js";
import { createDocument, parseDocument } from "../engine/model.js";
import { PICTURES, media, withPictures } from "./blocks-gate.mjs";

export const SWEEP_FORMATS = ["16:9", "9:16", "1:1"];
// The warnings a building block must never leave behind on its own.
export const BANNED = ["held_static", "text_wrap", "small_on_empty"];

/** The scene the gate makes for one recipe, look, format and seed. */
export function recipeScene(name, look, format, seed = 1) {
  const frame = parseFormat(format);
  const style = styleFor({ look, frame });
  const example = EXAMPLES[name];
  const settings = { copy: example.copy, seed, ...(example.media ? { media: "product" } : {}) };
  const options = { id: "r", settings, style, frame, fonts: defaultFonts, start: 0.2, media, logo: { media: PICTURES.logo } };
  const probe = runRecipe(RECIPES[name], { ...options, end: null });
  const end = Math.round((0.2 + probe.needs + 0.6) * 10) / 10;
  const made = runRecipe(RECIPES[name], { ...options, end });
  return createScene({ id: "s", name: "Scene", width: frame.width, height: frame.height, duration: Math.ceil((end + 0.4) * 10) / 10, background: style.colors.bg, layers: made.layers, assertions: made.assertions });
}

// Whole compositions, the way an agent's first compose call makes them (beats as long as they need).
export const COMPOSITIONS = {
  promo: { type: "promo", beats: [
    { recipe: "logo-sting", tagline: "Plan the week in one view" },
    { recipe: "device-slide", media: "product", text: "Everything in one place", sub: "Calendars, tasks and notes", transition: "push" },
    { recipe: "feature-callout", text: "Smart scheduling", sub: "Finds the time that works for everyone" },
    { recipe: "price-pop", price: "$29", text: "per month, billed yearly" },
    { recipe: "cta-end", text: "Try Orbit free", sub: "orbit.app", transition: "mask-wipe" },
  ] },
  explainer: { type: "explainer", beats: [
    { recipe: "headline-reveal", text: "How Orbit plans your week" },
    { recipe: "step-list", title: "How it works", items: ["Connect your calendars", "Pick your focus hours", "Share one link"] },
    { recipe: "bar-chart-grow", title: "Meetings per week", bars: [{ label: "Jan", value: 14 }, { label: "Feb", value: 11 }, { label: "Mar", value: 7 }] },
    { recipe: "number-counter", value: 1200, suffix: "+", label: "teams plan with Orbit" },
  ] },
  clip: { type: "clip", beats: [
    { recipe: "hook-slam", text: "Stop double-booking" },
    { recipe: "caption-pop", text: "This one change saved me two hours a week" },
    { recipe: "tip-card", title: "Tip 1", text: "Colour-code calendars so you see your week at a glance" },
    { recipe: "follow-cta", text: "Follow for daily tips", handle: "@orbit" },
  ] },
};

/** The scene compose makes for one of COMPOSITIONS in a look and format. */
export function composedScene(kind, look, format, seed = 1) {
  const made = composeScene({ ...COMPOSITIONS[kind], format, look, seed }, { fonts: defaultFonts, media, logo: { media: PICTURES.logo }, sceneId: "s" });
  return createScene({ id: "s", name: "Scene", width: made.frame.width, height: made.frame.height, duration: made.duration, background: made.background, layers: made.layers, assertions: made.assertions });
}

/** Checks one scene with every rule and real frames; returns its findings (errors and warnings). */
export async function sceneFindings(quality, scene) {
  const document = parseDocument(createDocument({ id: "d", name: "sweep", scenes: [scene] }));
  const checked = await quality.check(document, { fonts: defaultFonts, codes: null, sceneId: scene.id, pixels: true });
  return checked.findings.filter((finding) => !finding.waived);
}

/**
 * Runs the sweep. `filter(name, look, format)` limits it. Returns [{label, errors, banned}] for
 * every scene with an error or a banned warning, and the number of scenes checked.
 */
export async function polishSweep({ formats = SWEEP_FORMATS, looks = LOOK_NAMES, names = RECIPE_NAMES, compositions = Object.keys(COMPOSITIONS), seed = 1 } = {}) {
  const problems = [];
  // Every warning by rule, to compare before and after a change.
  const warnings = {};
  const show = (process.env.SHOW ?? "").split(",");
  let scenes = 0;
  await withPictures(async (_mediaRoot, quality) => {
    const cases = [];
    for (const format of formats) for (const look of looks) {
      for (const name of names) cases.push({ label: `${name} ${look} ${format}`, make: () => recipeScene(name, look, format, seed) });
      for (const kind of compositions) cases.push({ label: `compose ${kind} ${look} ${format}`, make: () => composedScene(kind, look, format, seed) });
    }
    for (const { label, make } of cases) {
      scenes += 1;
      let findings;
      let scene;
      try { scene = make(); findings = await sceneFindings(quality, scene); }
      catch (error) { problems.push({ label, errors: [`build: ${error.message}`], banned: [] }); continue; }
      for (const finding of findings) if (finding.severity === "warn") warnings[finding.rule] = (warnings[finding.rule] ?? 0) + 1;
      // SHOW=rule,rule prints those warnings too (by hand only).
      for (const finding of findings) if (show.includes(finding.rule) && finding.severity !== "info") console.log(`${label} ${finding.rule}: ${finding.message}`);
      const errors = findings.filter((finding) => finding.severity === "error").map((finding) => `${finding.rule}: ${finding.message}`);
      // The body minimum (36 px at 1080p in 16:9 and square frames, type_min) for every text.
      const floor = typeFloor(scene).body;
      for (const layer of scene.layers) if (layer.type === "text" && layer.fontSize < floor) errors.push(`type_floor: ${layer.id} is ${layer.fontSize}px, under ${floor}px`);
      const banned = findings.filter((finding) => BANNED.includes(finding.rule) && finding.severity !== "info").map((finding) => `${finding.rule}: ${finding.message}`);
      if (errors.length || banned.length) problems.push({ label, errors, banned });
    }
  });
  return { scenes, problems, warnings };
}

// By hand: print the counts per rule and every problem.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const only = process.argv[2] ? process.argv[2].split(",") : null;
  const seed = Number(process.env.SEED ?? 1);
  const { scenes, problems, warnings } = await polishSweep(only ? { seed, names: only.filter((name) => RECIPES[name]), compositions: only.filter((name) => COMPOSITIONS[name]) } : { seed });
  const counts = {};
  for (const problem of problems) for (const line of [...problem.errors, ...problem.banned]) {
    const rule = line.split(":")[0];
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  for (const problem of problems) console.log(`${problem.label}\n  ${[...problem.errors, ...problem.banned].join("\n  ")}`);
  console.log(`${scenes} scenes, ${problems.length} with problems`, counts);
  console.log("all warnings", warnings);
}

/**
 * The test (backend/blocks-polish.test.mjs): each whole composition in its own format and a
 * different look comes out with no errors and none of BANNED. A small sample on purpose; run this
 * file by hand for every recipe, look and format.
 */
export function polishGate() {
  const sample = [["promo", "16:9", LOOK_NAMES[0]], ["clip", "9:16", LOOK_NAMES[1]], ["explainer", "1:1", LOOK_NAMES[2]]];
  test(`compositions (${sample.map((entry) => entry.join(" ")).join(", ")}) come out with no errors and no ${BANNED.join(", ")}`, { timeout: 120_000 }, async () => {
    const problems = [];
    for (const [kind, format, look] of sample) {
      const found = await polishSweep({ formats: [format], looks: [look], names: [], compositions: [kind] });
      problems.push(...found.problems);
    }
    assert.deepEqual(problems.map((problem) => `${problem.label}: ${[...problem.errors, ...problem.banned].join("; ")}`), []);
  });
}
