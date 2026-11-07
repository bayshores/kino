// The A4 gate (plan §8), a sample: recipes, composed promos and transitions pass every quality
// check with no errors (pixel checks on). Each recipe, transition and look shows up, in every
// format and seed between them. The full sweep (every recipe and transition in every look and
// format at 5 seeds) is run by hand: node --import ./scripts/test-fonts.mjs tests/blocks-gate.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { defaultFonts } from "../engine/fonts.js";
import { composeScene } from "../engine/blocks/compose.js";
import {
  media, promoFailures, recipeFailures, samplePromoCases, sampleRecipeCases, sampleTransitionCases, transitionFailures,
} from "../tests/blocks-gate.mjs";

test("each recipe passes all gates (looks, formats and seeds taken in turn)", { timeout: 120_000 }, async () => {
  assert.deepEqual(await recipeFailures(sampleRecipeCases()), []);
});

test("a composed 15 s promo passes all gates in each look, with and without a product picture and with reduced motion", { timeout: 120_000 }, async () => {
  assert.deepEqual(await promoFailures(samplePromoCases()), []);
  // A plan that cannot pass promo_basics is refused before anything is built.
  assert.throws(() => composeScene({ type: "promo", beats: [{ recipe: "headline-reveal", text: "Hello" }, { recipe: "cta-end", text: "Try it" }] }, { fonts: defaultFonts, media, logo: { text: "Orbit" } }), /hero covering 30%/);
  assert.throws(() => composeScene({ type: "promo", beats: [{ recipe: "feature-callout", text: "Hello" }, { recipe: "cta-end", text: "Try it" }] }, { fonts: defaultFonts, media, logo: { text: "Orbit" } }), /logo by 5 s/);
});

test("every transition passes all gates in every look (formats and seeds taken in turn)", { timeout: 120_000 }, async () => {
  assert.deepEqual(await transitionFailures(sampleTransitionCases()), []);
});
