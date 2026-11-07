// The A4 gate (plan §8): recipes, composed promos and transitions pass every quality check with
// no errors (pixel checks on). backend/blocks-gate.test.mjs runs a small sample of each part; the
// full sweep (every recipe and transition in every look and format at 5 seeds, every promo in
// every look and format) is run by hand:
//
//   node --import ./scripts/test-fonts.mjs tests/blocks-gate.mjs [recipes,transitions,promos]
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { defaultFonts } from "../engine/fonts.js";
import { createDocument, createScene, parseDocument } from "../engine/model.js";
import { createQualityChecker } from "../backend/agent/quality.mjs";
import { checkDocument } from "../backend/agent/checks.mjs";
import { renderSceneFrames } from "../backend/export.mjs";
import { RECIPES, RECIPE_NAMES } from "../engine/blocks/recipes/index.js";
import { TRANSITION_NAMES } from "../engine/blocks/recipes/transitions.js";
import { runRecipe } from "../engine/blocks/recipe.js";
import { composeScene } from "../engine/blocks/compose.js";
import { LOOK_NAMES, styleFor } from "../engine/blocks/looks.js";
import { parseFormat } from "../engine/blocks/formats.js";
import { EXAMPLES } from "../engine/blocks/examples.js";

export const FORMATS = ["16:9", "9:16", "1:1"];
export const SEEDS = [1, 2, 3, 4, 5];
const PRODUCT = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
<rect x="180" y="40" width="1240" height="800" rx="36" fill="#2A2D33"/><rect x="216" y="76" width="1168" height="728" rx="12" fill="#F4F2EE"/>
<rect x="216" y="76" width="1168" height="70" fill="#FF6B4A"/><rect x="256" y="190" width="420" height="40" rx="8" fill="#1B1D21"/>
<rect x="256" y="330" width="500" height="380" rx="16" fill="#E2E0DB"/><rect x="800" y="330" width="540" height="170" rx="16" fill="#3CC8B4"/>
<path d="M60 860 H1540 L1480 940 H120 Z" fill="#3A3E45"/></svg>`;
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<circle cx="256" cy="256" r="220" fill="#FF6B4A"/><path d="M170 330 L256 150 L342 330 Z" fill="#0E0F11"/></svg>`;
export const PICTURES = {
  product: { id: "product.png", src: "/api/media/product.png", width: 1600, height: 1000, name: "Product" },
  logo: { id: "logo.png", src: "/api/media/logo.png", width: 512, height: 512, name: "Logo" },
};
export const media = (ref) => {
  if (!PICTURES[ref]) throw new Error(`No picture ${ref}.`);
  return PICTURES[ref];
};

export async function withPictures(run) {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-blocks-"));
  try {
    await writeFile(path.join(folder, "product.png"), new Resvg(PRODUCT).render().asPng());
    await writeFile(path.join(folder, "logo.png"), new Resvg(LOGO).render().asPng());
    await run(folder, createQualityChecker({ mediaRoot: folder, renderFrames: renderSceneFrames }));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export async function errorsOf(quality, mediaRoot, scene, extra = {}) {
  const document = parseDocument(createDocument({ id: "d", name: "gate", scenes: [scene], ...extra }));
  const basic = checkDocument(document, { fonts: defaultFonts, mediaRoot, codes: null, sceneId: scene.id });
  const checked = await quality.check(document, { fonts: defaultFonts, codes: null, sceneId: scene.id, pixels: true });
  return [...basic, ...checked.findings].filter((finding) => finding.severity === "error");
}

const message = (errors) => errors.map((finding) => `${finding.rule} ${finding.message}`).join("; ");

/** Every [recipe, look, format, seed]: 21 × 5 × 3 × 5 cases (by hand). */
export function allRecipeCases() {
  const cases = [];
  for (const format of FORMATS) for (const name of RECIPE_NAMES) for (const look of LOOK_NAMES) for (const seed of SEEDS) cases.push([name, look, format, seed]);
  return cases;
}

/** Each recipe once, turning through the looks, formats and seeds, so each of those shows up too. */
export function sampleRecipeCases() {
  return RECIPE_NAMES.map((name, index) => [name, LOOK_NAMES[index % LOOK_NAMES.length], FORMATS[index % FORMATS.length], SEEDS[index % SEEDS.length]]);
}

/** Makes each [recipe, look, format, seed] the way the recipe op does and checks it; returns the failures. */
export async function recipeFailures(cases) {
  const failures = [];
  await withPictures(async (mediaRoot, quality) => {
    for (const [name, look, format, seed] of cases) {
      const frame = parseFormat(format);
      const style = styleFor({ look, frame });
      const example = EXAMPLES[name];
      const settings = { copy: example.copy, seed, ...(example.media ? { media: "product" } : {}) };
      const options = { id: "r", settings, style, frame, fonts: defaultFonts, start: 0.2, media, logo: { media: PICTURES.logo } };
      const label = `${name} ${look} ${format} seed ${seed}`;
      try {
        const probe = runRecipe(RECIPES[name], { ...options, end: null });
        const end = Math.round((0.2 + probe.needs + 0.6) * 10) / 10;
        const made = runRecipe(RECIPES[name], { ...options, end });
        const scene = createScene({ id: "s", name: "Scene", width: frame.width, height: frame.height, duration: Math.ceil((end + 0.4) * 10) / 10, background: style.colors.bg, layers: made.layers, assertions: made.assertions });
        const errors = await errorsOf(quality, mediaRoot, scene);
        if (errors.length) failures.push(`${label}: ${message(errors)}`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
    }
  });
  return failures;
}

const PROMO_BEATS = [
  { recipe: "logo-sting", tagline: "Plan the week in one view" },
  { recipe: "device-slide", media: "product", text: "Everything in one view", transition: "push" },
  { recipe: "price-pop", price: "$29", text: "per month" },
  { recipe: "cta-end", text: "Try Orbit free", sub: "orbit.app", transition: "mask-wipe" },
];
// No product picture: a feature card has to be the hero.
const NO_PICTURE_BEATS = [
  { recipe: "logo-sting", tagline: "Plan the week in one view" },
  { recipe: "headline-reveal", text: "Your team's week, in one view" },
  { recipe: "feature-callout", text: "Shared calendars", sub: "Everyone sees the same week" },
  { recipe: "cta-end", text: "Try Orbit free", sub: "orbit.app" },
];

/** Every promo case [look, format, seed, reduced, picture] (by hand). */
export function allPromoCases() {
  const cases = [];
  for (const look of LOOK_NAMES) for (const format of FORMATS) {
    for (const [reduced, seed] of [[false, 1], [false, 2], [true, 1]]) cases.push([look, format, seed, reduced, true]);
    cases.push([look, format, 1, false, false]);
  }
  return cases;
}

/**
 * Each look once, turning through the formats; the even ones with the product picture (the first
 * with reduced motion, the next at seed 2), the odd ones without it.
 */
export function samplePromoCases() {
  return LOOK_NAMES.map((look, index) => [look, FORMATS[index % FORMATS.length], index === 2 ? 2 : 1, index === 0, index % 2 === 0]);
}

/** Composes the 15 s promo for each case and checks it; returns the failures. */
export async function promoFailures(cases) {
  const failures = [];
  await withPictures(async (mediaRoot, quality) => {
    for (const [look, format, seed, reduced, picture] of cases) {
      const label = `${look} ${format} seed ${seed}${reduced ? " reduced" : ""}${picture ? "" : " no picture"}`;
      try {
        const made = picture
          ? composeScene({ format, look, duration: 15, type: "promo", seed, beats: PROMO_BEATS }, { fonts: defaultFonts, media, logo: { media: PICTURES.logo }, sceneId: "s", reduced })
          : composeScene({ format, look, duration: 15, type: "promo", beats: NO_PICTURE_BEATS }, { fonts: defaultFonts, media, logo: { text: "Orbit" }, sceneId: "s" });
        assert.equal(made.duration, 15);
        if (!picture) {
          assert.match(made.notes.join(" "), /feature-callout\) is the hero/);
          assert.ok(made.layers.some((layer) => layer.role === "hero"));
        }
        const scene = createScene({ id: "s", name: "Promo", width: made.frame.width, height: made.frame.height, duration: made.duration, background: made.background, layers: made.layers, assertions: made.assertions, composition: made.composition });
        const errors = await errorsOf(quality, mediaRoot, scene, { videoType: "promo" });
        if (errors.length) failures.push(`${label}: ${message(errors)}`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
    }
  });
  return failures;
}

/** Every [transition, look, format, seed] (by hand). */
export function allTransitionCases() {
  const cases = [];
  for (const transition of TRANSITION_NAMES) for (const look of LOOK_NAMES) for (const format of FORMATS) for (const seed of SEEDS) cases.push([transition, look, format, seed]);
  return cases;
}

/** Each transition in each look, turning through the formats and seeds. */
export function sampleTransitionCases() {
  const cases = [];
  TRANSITION_NAMES.forEach((transition, t) => LOOK_NAMES.forEach((look, l) => {
    const index = t * LOOK_NAMES.length + l;
    cases.push([transition, look, FORMATS[index % FORMATS.length], SEEDS[index % SEEDS.length]]);
  }));
  return cases;
}

/** Two beats that meet with each case's transition, checked; returns the failures. */
export async function transitionFailures(cases) {
  const failures = [];
  await withPictures(async (mediaRoot, quality) => {
    for (const [transition, look, format, seed] of cases) {
      const label = `${transition} ${look} ${format} seed ${seed}`;
      const beats = [
        { recipe: "headline-reveal", text: "Your team's week, in one view" },
        { recipe: "feature-callout", text: "Shared calendars", sub: "Everyone sees the same week", transition },
      ];
      try {
        const env = { fonts: defaultFonts, media, logo: { text: "Orbit" }, sceneId: "s" };
        const made = composeScene({ format, look, duration: 8, seed, beats }, env);
        // The transition must change how the beats meet, or this check would prove nothing.
        const plain = composeScene({ format, look, duration: 8, seed, beats: [beats[0], { ...beats[1], transition: undefined }] }, env);
        assert.notDeepEqual(made.layers.map((layer) => layer.animations), plain.layers.map((layer) => layer.animations), `${label} changes nothing`);
        const scene = createScene({ id: "s", name: "Clip", width: made.frame.width, height: made.frame.height, duration: made.duration, background: made.background, layers: made.layers, assertions: made.assertions, composition: made.composition });
        const errors = await errorsOf(quality, mediaRoot, scene);
        if (errors.length) failures.push(`${label}: ${message(errors)}`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
    }
  });
  return failures;
}

// By hand: the full sweep (or the parts named), printing every failure.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const parts = process.argv[2] ? process.argv[2].split(",") : ["recipes", "transitions", "promos"];
  const sweeps = {
    recipes: () => recipeFailures(allRecipeCases()),
    transitions: () => transitionFailures(allTransitionCases()),
    promos: () => promoFailures(allPromoCases()),
  };
  let failed = 0;
  for (const part of parts) {
    const failures = await sweeps[part]();
    for (const failure of failures) console.log(`${part}: ${failure}`);
    console.log(`${part}: ${failures.length} failures`);
    failed += failures.length;
  }
  process.exitCode = failed ? 1 : 0;
}
