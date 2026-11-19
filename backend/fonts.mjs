import * as fontkit from "fontkit";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { uploadedFontMetadata } from "../engine/fontMetadata.js";
import { FontRegistry } from "../engine/fonts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledFontsRoot = path.join(root, "assets", "fonts");
const fontExtensions = new Set([".ttf", ".otf", ".woff", ".woff2"]);
const fontMimes = new Set([
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
]);
const extensionForMime = new Map([
  ["font/ttf", ".ttf"],
  ["font/otf", ".otf"],
  ["font/woff", ".woff"],
  ["font/woff2", ".woff2"],
]);
const uploadedFontId = /^[a-f0-9-]{36}\.(?:ttf|otf|woff|woff2)$/iu;

function parsedFont(bytes, label) {
  try {
    const font = fontkit.create(bytes);
    const weight = Number(font["OS/2"]?.usWeightClass);
    const subfamily = String(font.subfamilyName ?? "");
    const style = /italic|oblique/iu.test(subfamily) ? "italic" : "normal";
    return {
      font,
      weight: Number.isFinite(weight) && weight > 0 ? weight : 400,
      style,
    };
  } catch (error) {
    const message = String(error?.message ?? "Font data could not be parsed.")
      .replace(/\s+/gu, " ")
      .slice(0, 200);
    const parseError = new Error(`${label} could not be parsed: ${message}`);
    parseError.code = "ERR_FONT_PARSE";
    throw parseError;
  }
}

function bundledFilename(name) {
  const families = { inter: "Inter", montserrat: "Montserrat", notoserif: "Noto Serif" };
  const match = name.match(/^(Inter|Montserrat|NotoSerif)-(\d+)(-italic)?\.(?:ttf|otf|woff|woff2)$/iu);
  return match
    ? {
        family: families[match[1].toLowerCase()],
        weight: Number(match[2]),
        style: match[3] ? "italic" : "normal",
      }
    : null;
}

function fontFamilyAlias(name) {
  const base = path.basename(String(name ?? ""));
  const family = base.slice(0, base.length - path.extname(base).length).trim();
  return family.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 200);
}

function allowed(id, allowedIds) {
  if (allowedIds == null) return true;
  if (allowedIds instanceof Set || Array.isArray(allowedIds)) {
    return allowedIds.has ? allowedIds.has(id) : allowedIds.includes(id);
  }
  return typeof allowedIds.has === "function" && allowedIds.has(id);
}

function addErrors(registry, errors) {
  registry.errors = errors;
  return registry;
}

function errorRecord(id, name, error) {
  return {
    id,
    name,
    error: String(error?.message ?? error ?? "Font could not be loaded.")
      .replace(/\s+/gu, " ")
      .slice(0, 240),
  };
}

/** Load and validate every font shipped with kino into an isolated registry. */
export async function loadBundledFonts() {
  const registry = new FontRegistry();
  const names = (await readdir(bundledFontsRoot))
    .filter((name) => fontExtensions.has(path.extname(name).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));

  for (const name of names) {
    const filePath = path.join(bundledFontsRoot, name);
    const bytes = await readFile(filePath);
    const parsed = parsedFont(bytes, `Bundled font ${name}`);
    const alias = bundledFilename(name);
    const options = alias ?? {
      family: parsed.font.familyName || fontFamilyAlias(name),
      weight: parsed.weight,
      style: parsed.style,
    };
    registry.register(bytes, {
      id: `bundled:${name}`,
      ...options,
      src: `/api/fonts/${encodeURIComponent(path.basename(name))}`,
    });
  }

  return addErrors(registry, []);
}

// Registries already built, kept while the font files they came from are unchanged (AGENTS.md,
// Efficiency rules). Every agent call asks for the project's fonts: parsing the 24 bundled faces
// again took about a third of a call, and a new registry starts with no saved text layouts
// (engine/textLayout.js keeps them per registry). One entry per set of uploaded fonts a caller
// may use, so a share's registry never holds another file's fonts.
const loadedRegistries = new Map();
const REGISTRY_LIMIT = 4;
/** How many registries were built from font files (tests/perf-budget.json counts them). */
export const fontCounters = { registriesBuilt: 0 };

const stamp = async (filePath) => {
  try { const info = await stat(filePath); return `${info.size}:${info.mtimeMs}`; }
  catch { return "missing"; }
};

/**
 * The registry for a project's fonts. Shared projects pass their allowed
 * media IDs here so foreign uploaded fonts are never opened or registered.
 * Upload parse/read failures are returned in `registry.errors` for the API/UI.
 * The same registry is returned again while no bundled or uploaded font file changed.
 */
export async function loadProjectFonts({
  mediaRoot,
  allowedIds = null,
  bundled = true,
  catalog = null,
} = {}) {
  if (!mediaRoot) throw new TypeError("mediaRoot is required to load project fonts.");
  const metadataFiles = (await readdir(mediaRoot)).filter((name) => {
    if (!name.endsWith(".json")) return false;
    const id = name.slice(0, -".json".length);
    return fontExtensions.has(path.extname(id).toLowerCase()) && uploadedFontId.test(id) && allowed(id, allowedIds);
  }).sort();
  const bundledFiles = bundled ? (await readdir(bundledFontsRoot)).sort() : [];
  const signature = JSON.stringify([
    await Promise.all(bundledFiles.map(async (name) => [name, await stamp(path.join(bundledFontsRoot, name))])),
    await Promise.all(metadataFiles.map(async (name) => [await stamp(path.join(mediaRoot, name)), await stamp(path.join(mediaRoot, name.slice(0, -".json".length)))])),
  ]);
  const key = JSON.stringify([path.resolve(mediaRoot), bundled, Boolean(catalog), metadataFiles]);
  let entry = loadedRegistries.get(key);
  if (entry?.signature !== signature) {
    entry = { signature, registry: await buildProjectFonts({ mediaRoot, metadataFiles, bundled }) };
    fontCounters.registriesBuilt += 1;
  }
  loadedRegistries.delete(key);
  loadedRegistries.set(key, entry);
  if (loadedRegistries.size > REGISTRY_LIMIT) loadedRegistries.delete(loadedRegistries.keys().next().value);
  // Catalog faces downloaded since are added; the ones it holds are left alone (font-catalog.mjs).
  if (catalog) await catalog.loadInto(entry.registry);
  return entry.registry;
}

async function buildProjectFonts({ mediaRoot, metadataFiles, bundled }) {
  const registry = bundled ? await loadBundledFonts() : new FontRegistry();
  const errors = [];

  for (const metadataFile of metadataFiles) {
    const idFromFile = metadataFile.slice(0, -".json".length);
    const extension = path.extname(idFromFile).toLowerCase();

    let metadata;
    try {
      metadata = JSON.parse(await readFile(path.join(mediaRoot, metadataFile), "utf8"));
    } catch (error) {
      errors.push(errorRecord(idFromFile, idFromFile, "Font metadata could not be read."));
      continue;
    }

    const mime = String(metadata?.mime ?? "").toLowerCase();
    if (
      !metadata ||
      typeof metadata !== "object" ||
      metadata.id !== idFromFile ||
      !fontMimes.has(mime) ||
      extensionForMime.get(mime) !== extension
    ) {
      errors.push(errorRecord(idFromFile, idFromFile, "Font metadata does not match its uploaded file."));
      continue;
    }

    const name = String(metadata.name ?? idFromFile).slice(0, 200);
    try {
      const filePath = path.join(mediaRoot, idFromFile);
      const fileInfo = await stat(filePath);
      if (!fileInfo.isFile()) throw new Error("Uploaded font is not a regular file.");
      const bytes = await readFile(filePath);
      const parsed = parsedFont(bytes, "Uploaded font");
      const fontMetadata = uploadedFontMetadata(parsed.font, name);
      if (!fontMetadata.family) throw new Error("Font metadata has no usable family name.");
      registry.register(bytes, {
        id: idFromFile,
        ...fontMetadata,
        src: `/api/media/${encodeURIComponent(idFromFile)}`,
      });
    } catch (error) {
      const message = error?.code === "ERR_FONT_PARSE" || /supported font face|family name/iu.test(String(error?.message))
        ? error
        : "Uploaded font could not be read.";
      errors.push(errorRecord(idFromFile, name, message));
    }
  }

  return addErrors(registry, errors);
}
