// All recipes by name: 8 promo (callout among them), 5 vertical, 6 explainer, 5 logo/kinetic and the 3
// transitions (transitions.js).
import { PROMO_RECIPES } from "./promo.js";
import { VERTICAL_RECIPES } from "./vertical.js";
import { EXPLAINER_RECIPES } from "./explainer.js";
import { KINETIC_RECIPES } from "./kinetic.js";
import { TRANSITIONS, TRANSITION_NAMES } from "./transitions.js";

export const RECIPES = Object.freeze(Object.fromEntries([...PROMO_RECIPES, ...VERTICAL_RECIPES, ...EXPLAINER_RECIPES, ...KINETIC_RECIPES].map((recipe) => [recipe.name, recipe])));
export const RECIPE_NAMES = Object.freeze(Object.keys(RECIPES));
export const ALL_RECIPE_NAMES = Object.freeze([...RECIPE_NAMES, ...TRANSITION_NAMES]);
export { TRANSITIONS, TRANSITION_NAMES };

function closest(name, names) {
  const text = String(name ?? "").toLowerCase();
  return names.filter((candidate) => candidate.includes(text) || text.includes(candidate) || candidate.split("-")[0] === text.split("-")[0]).slice(0, 3);
}

/** The recipe called `name`; throws a message listing near names and the groups. */
export function recipeOf(name) {
  const found = RECIPES[name];
  if (found) return found;
  const near = closest(name, ALL_RECIPE_NAMES);
  throw Object.assign(new Error(`Unknown recipe "${name}".${near.length ? ` Did you mean ${near.join(", ")}?` : ""} library {topic:"blocks"} lists all ${ALL_RECIPE_NAMES.length}.`), { suggestions: near });
}

/** A short description of every recipe and transition, for library answers. */
export function describeRecipes() {
  const recipes = RECIPE_NAMES.map((name) => {
    const recipe = RECIPES[name];
    return {
      name, group: recipe.group, about: recipe.about,
      copy: Object.fromEntries((recipe.copy ?? []).map((field) => [field.key, `${field.required ? "required; " : ""}${field.about}${field.max && !field.list ? ` (≤${field.max} chars)` : ""}`])),
      ...(recipe.media ? { media: recipe.media } : {}),
      ...(Object.keys(recipe.slots ?? {}).length ? { slots: recipe.slots } : {}),
    };
  });
  const transitions = TRANSITION_NAMES.map((name) => ({ name, group: "transition", about: TRANSITIONS[name].about }));
  return [...recipes, ...transitions];
}
