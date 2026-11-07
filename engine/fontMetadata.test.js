import assert from "node:assert/strict";
import test from "node:test";
import { uploadedFontMetadata } from "./fontMetadata.js";

function namedFont(names = {}, values = {}) {
  return {
    getName: (key) => names[key] ?? null,
    familyName: values.familyName,
    subfamilyName: values.subfamilyName,
    "OS/2": { usWeightClass: values.weight ?? 400 },
  };
}

test("uploaded font metadata prefers typographic family and retains the filename alias", () => {
  const font = namedFont(
    {
      preferredFamily: "Inter",
      fontFamily: "Inter Medium",
      preferredSubfamily: "Medium Italic",
      fontSubfamily: "Italic",
    },
    { familyName: "Inter Medium", subfamilyName: "Italic", weight: 500 },
  );

  assert.deepEqual(uploadedFontMetadata(font, "Project Sans Medium Italic.woff2"), {
    family: "Inter",
    aliases: ["Project Sans Medium Italic"],
    weight: 500,
    style: "italic",
  });
});

test("uploaded font metadata falls back through family names and then the filename", () => {
  assert.deepEqual(
    uploadedFontMetadata(
      namedFont({ fontFamily: "Legacy Family" }, { familyName: "Property Family", weight: 700 }),
      "Legacy Family.ttf",
    ),
    { family: "Legacy Family", aliases: [], weight: 700, style: "normal" },
  );
  assert.deepEqual(
    uploadedFontMetadata(namedFont({}, { weight: 300 }), "C:\\fonts\\Fallback Face.otf"),
    { family: "Fallback Face", aliases: ["C:\\fonts\\Fallback Face"], weight: 300, style: "normal" },
  );
});

test("uploaded font metadata uses the font family property when named records are unavailable", () => {
  assert.deepEqual(
    uploadedFontMetadata(namedFont({}, { familyName: "Property Family", weight: 600 }), "Old Name.ttf"),
    { family: "Property Family", aliases: ["Old Name"], weight: 600, style: "normal" },
  );
});

test("uploaded font metadata sanitizes and bounds names and aliases", () => {
  const family = `${"F".repeat(205)}\n\u0000amily`;
  const filename = `${"A".repeat(205)}\u007flias.ttf`;
  const result = uploadedFontMetadata(
    namedFont({ preferredFamily: family }, { weight: Number.NaN }),
    filename,
  );

  assert.equal(result.family.length, 200);
  assert.equal(result.aliases[0].length, 200);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(result.family), false);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(result.aliases[0]), false);
  assert.equal(result.weight, 400);
});

test("uploaded font metadata omits case-insensitive duplicate filename aliases", () => {
  assert.deepEqual(
    uploadedFontMetadata(namedFont({ preferredFamily: "Inter" }), "inter.ttf"),
    { family: "Inter", aliases: [], weight: 400, style: "normal" },
  );
});

test("legacy aliases preserve filename spacing and the original control removal", () => {
  const result = uploadedFontMetadata(namedFont({ preferredFamily: "Inter" }), " Brand   Reg\nular.ttf");
  assert.deepEqual(result.aliases, ["Brand   Regular"]);
  const fallback = uploadedFontMetadata(namedFont(), " Brand   Reg\nular.ttf");
  assert.equal(fallback.family, "Brand Reg ular");
  assert.deepEqual(fallback.aliases, ["Brand   Regular"]);
});
