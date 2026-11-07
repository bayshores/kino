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

/**
 * Build an isolated registry for a project. Shared projects pass their allowed
 * media IDs here so foreign uploaded fonts are never opened or registered.
 * Upload parse/read failures are returned in `registry.errors` for the API/UI.
 */
export async function loadProjectFonts({
  mediaRoot,
  allowedIds = null,
  bundled = true,
  catalog = null,
} = {}) {
  if (!mediaRoot) throw new TypeError("mediaRoot is required to load project fonts.");
  const registry = bundled ? await loadBundledFonts() : new FontRegistry();
  const errors = [];
  const names = (await readdir(mediaRoot)).filter((name) => name.endsWith(".json")).sort();

  for (const metadataFile of names) {
    const idFromFile = metadataFile.slice(0, -".json".length);
    const extension = path.extname(idFromFile).toLowerCase();
    if (!fontExtensions.has(extension) || !uploadedFontId.test(idFromFile)) continue;
    if (!allowed(idFromFile, allowedIds)) continue;

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

  if (catalog) await catalog.loadInto(registry);
  return addErrors(registry, errors);
}
