import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { create as createFont } from "fontkit";
import { catalogFontSource, fontSubsetsForText, parseCatalogFontSource, parseUnicodeRange } from "../engine/fontCatalogSource.js";
import { FontRegistry } from "../engine/fonts.js";

const DAY = 24 * 60 * 60 * 1000;
const MAX_CATALOG = 12 * 1024 * 1024;
const MAX_METADATA = 8 * 1024 * 1024;
const MAX_FONT = 30 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const SUBSET = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|\[\d+\])$/;
const CACHE_FONT = /^fs-cache-([a-f0-9]{64})\.ttf$/;
const LICENSES = /^[A-Za-z0-9.+-]{1,80}$/;
const inFlight = new Map();

const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const safeText = (value, max = 200) => typeof value === "string" ? value.trim().slice(0, max) : "";
const canonicalSubset = (value) => /^\[(\d+)\]$/.exec(value)?.[1] ?? value;
const licenseId = (value) => typeof value === "string" ? safeText(value, 80) : plain(value) ? safeText(value.type, 80) : "";
function licenseDetails(value, fallback = null) {
  const source = plain(value) ? value : plain(fallback) ? fallback : null;
  if (!source) return null;
  const details = {};
  for (const key of ["type", "url", "attribution", "text", "source"]) {
    const text = safeText(source[key], key === "attribution" || key === "text" ? 12_000 : 1_000);
    if (text) details[key] = text;
  }
  return Object.keys(details).length ? details : null;
}
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableKey = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sortedUnique = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b));

function validId(id) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("The font catalog family ID is invalid.");
  return id;
}

function validVersion(version) {
  if (typeof version !== "string" || !VERSION.test(version) || version.includes(".."))
    throw new Error("The font catalog version is invalid.");
  return version;
}

function familyRecord(raw) {
  if (!plain(raw) || !ID.test(raw.id) || typeof raw.family !== "string") return null;
  const subsets = Array.isArray(raw.subsets) ? sortedUnique(raw.subsets.filter((item) => typeof item === "string" && SUBSET.test(item))) : [];
  const weights = Array.isArray(raw.weights)
    ? [...new Set(raw.weights.map(Number).filter((weight) => Number.isInteger(weight) && weight >= 1 && weight <= 1000))].sort((a, b) => a - b)
    : [];
  const styles = Array.isArray(raw.styles) ? sortedUnique(raw.styles.filter((style) => style === "normal" || style === "italic")) : [];
  const license = licenseId(raw.license) || safeText(raw.licenseId, 80);
  const details = licenseDetails(raw.licenseDetails ?? raw.license);
  if (!safeText(raw.family) || !subsets.length || !weights.length || !styles.length) return null;
  return {
    id: raw.id,
    family: safeText(raw.family),
    subsets,
    weights,
    styles,
    defSubset: SUBSET.test(raw.defSubset ?? "") && subsets.includes(raw.defSubset) ? raw.defSubset : subsets[0],
    ...(license && LICENSES.test(license) ? { license, ...(details ? { licenseDetails: details } : {}) } : {}),
    ...(safeText(raw.category, 50) ? { category: safeText(raw.category, 50) } : {}),
    variable: raw.variable === true,
  };
}

function unicodeRanges(raw, subsets, { required = true } = {}) {
  const source = plain(raw?.unicodeRange) ? raw.unicodeRange : raw;
  const result = {};
  for (const subset of subsets) {
    const numeric = /^\d+$/.test(subset);
    const bracketed = /^\[(\d+)\]$/.exec(subset);
    const range = safeText(source?.[subset] ?? (numeric ? source?.[`[${subset}]`] : bracketed ? source?.[bracketed[1]] : undefined), 100_000);
    if (range) result[subset] = range;
  }
  if (required && subsets.some((subset) => !result[subset])) throw new Error("Font catalog metadata is missing Unicode ranges.");
  return result;
}

function addVariant(variants, weight, style, subset) {
  const weightKey = String(weight);
  variants[weightKey] ??= {};
  variants[weightKey][style] ??= [];
  if (!variants[weightKey][style].includes(subset)) variants[weightKey][style].push(subset);
}

function normalizeApiDetail(raw, catalogFamily = null) {
  if (!plain(raw) || !ID.test(raw.id) || raw.type && raw.type !== "google")
    throw new Error("Fontsource returned invalid family metadata.");
  const resolvedLicense = licenseId(raw.license) || catalogFamily?.license;
  const base = familyRecord({
    ...raw,
    license: resolvedLicense,
    licenseDetails: licenseDetails(raw.license, catalogFamily?.licenseDetails),
  });
  if (!base) throw new Error("Fontsource returned incomplete family metadata.");
  if (!plain(raw.variants)) throw new Error("Fontsource returned no face metadata.");
  const variants = {};
  const variantSubsets = new Set();
  for (const [weightText, styles] of Object.entries(raw.variants)) {
    const weight = Number(weightText);
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000 || !plain(styles)) continue;
    for (const style of ["normal", "italic"]) {
      const subsets = styles[style];
      if (!plain(subsets)) continue;
      for (const rawSubset of Object.keys(subsets)) {
        const subset = canonicalSubset(rawSubset);
        if (!SUBSET.test(subset)) continue;
        variantSubsets.add(subset);
        addVariant(variants, weight, style, subset);
      }
    }
  }
  const ranges = unicodeRanges(raw, [...variantSubsets], { required: false });
  for (const [weight, styles] of Object.entries(variants)) {
    for (const [style, subsets] of Object.entries(styles)) styles[style] = subsets.filter((subset) => ranges[subset]);
    for (const style of Object.keys(styles)) if (!styles[style].length) delete styles[style];
    if (!Object.keys(styles).length) delete variants[weight];
  }
  for (const faces of Object.values(variants)) for (const subsets of Object.values(faces)) subsets.sort((a, b) => a.localeCompare(b));
  if (!Object.keys(variants).length) throw new Error("Fontsource returned no usable font faces.");
  const version = safeText(raw.npmVersion, 80);
  if (!VERSION.test(version)) throw new Error("Fontsource returned an invalid package version.");
  const license = resolvedLicense;
  if (!license || !LICENSES.test(license)) throw new Error("Fontsource did not provide a usable font license.");
  const availableSubsets = [...new Set(Object.values(variants).flatMap((styles) => Object.values(styles).flat()))];
  const availableRanges = Object.fromEntries(availableSubsets.map((subset) => [subset, ranges[subset]]));
  const defSubset = ranges[base.defSubset] ? base.defSubset : availableSubsets[0];
  return {
    ...base,
    subsets: availableSubsets,
    defSubset,
    unicodeRange: availableRanges,
    variants,
    version,
    sourceVersion: safeText(raw.version, 80) || version,
    license,
    ...(safeText(raw.lastModified, 40) ? { lastModified: safeText(raw.lastModified, 40) } : {}),
  };
}

function flattenTree(node, prefix = "", output = []) {
  if (Array.isArray(node)) {
    for (const entry of node) flattenTree(entry, prefix, output);
    return output;
  }
  if (!plain(node)) return output;
  const name = typeof node.name === "string" ? node.name.replace(/^\/+/, "") : "";
  const joined = name ? (prefix ? `${prefix}/${name}` : name) : prefix;
  if (node.type === "file" || (!Array.isArray(node.files) && !node.type && name.includes("."))) output.push(joined);
  if (Array.isArray(node.files)) flattenTree(node.files, joined, output);
  return output;
}

function packageFileVariants(tree, id) {
  const variants = {};
  const marker = `files/${id}-`;
  for (const file of flattenTree(tree)) {
    const normalized = file.replace(/^\/+/, "");
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex < 0 || !normalized.endsWith(".woff2")) continue;
    const leaf = normalized.slice(markerIndex + marker.length);
    const match = /^(.+)-(\d{1,4})-(normal|italic)\.woff2$/.exec(leaf);
    if (!match) continue;
    const [, rawSubset, weightText, style] = match;
    const subset = canonicalSubset(rawSubset);
    const weight = Number(weightText);
    if (SUBSET.test(subset) && weight >= 1 && weight <= 1000)
      addVariant(variants, weight, style, subset);
  }
  for (const faces of Object.values(variants)) for (const subsets of Object.values(faces)) subsets.sort((a, b) => a.localeCompare(b));
  return variants;
}

function normalizePinnedMetadata(id, version, metadata, unicode, tree, catalogFamily = null) {
  if (!plain(metadata)) throw new Error("The pinned Fontsource package metadata is invalid.");
  const packageName = safeText(metadata.name, 200);
  if (packageName && packageName !== `@fontsource/${id}`) throw new Error("The pinned Fontsource package did not match the requested family.");
  if (metadata.id && metadata.id !== id) throw new Error("The pinned Fontsource metadata did not match the requested family.");
  const resolvedLicense = licenseId(metadata.license) || catalogFamily?.license;
  const base = familyRecord({
    ...metadata,
    id,
    license: resolvedLicense,
    licenseDetails: licenseDetails(metadata.license, catalogFamily?.licenseDetails),
  });
  if (!base) throw new Error("The pinned Fontsource package metadata is incomplete.");
  const variants = packageFileVariants(tree, id);
  if (!Object.keys(variants).length) throw new Error("The pinned Fontsource package contains no supported font faces.");
  const variantSubsets = [...new Set(Object.values(variants).flatMap((styles) => Object.values(styles).flat()))];
  const ranges = unicodeRanges({ unicodeRange: unicode?.unicodeRange ?? unicode?.subsets ?? unicode }, variantSubsets, { required: false });
  for (const styles of Object.values(variants)) for (const [style, subsetsForStyle] of Object.entries(styles))
    styles[style] = subsetsForStyle.filter((subset) => ranges[subset]);
  for (const [weight, styles] of Object.entries(variants)) {
    for (const style of Object.keys(styles)) if (!styles[style].length) delete styles[style];
    if (!Object.keys(styles).length) delete variants[weight];
  }
  if (!Object.keys(variants).length) throw new Error("The pinned Fontsource package contains no faces with Unicode ranges.");
  const subsets = [...new Set(Object.values(variants).flatMap((styles) => Object.values(styles).flat()))];
  const license = resolvedLicense;
  if (!license || !LICENSES.test(license)) throw new Error("The pinned Fontsource package has no usable license metadata.");
  return {
    ...base,
    subsets,
    defSubset: subsets.includes(base.defSubset) ? base.defSubset : subsets[0],
    unicodeRange: Object.fromEntries(subsets.map((subset) => [subset, ranges[subset]])),
    variants,
    version,
    sourceVersion: safeText(metadata.version, 80) || version,
    license,
    ...(safeText(metadata.lastModified, 40) ? { lastModified: safeText(metadata.lastModified, 40) } : {}),
  };
}

function faceKey({ id, version, weight, style, subset }) {
  return stableKey({ id, version, weight, style, subset });
}

function normalizedSource(face) {
  return catalogFontSource({ id: face.catalogId ?? face.id, version: face.version, weight: face.weight, style: face.style });
}

function errorMessage(error) {
  return String(error?.message ?? error ?? "Font catalog request failed.").replace(/\s+/gu, " ").slice(0, 240);
}

async function responseBytes(response, maxBytes, label) {
  if (!response || !response.ok) throw new Error(`${label} request failed${response?.status ? ` (${response.status})` : ""}.`);
  if (response.redirected) throw new Error(`${label} request redirected unexpectedly.`);
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`${label} response exceeded the size limit.`);
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`${label} response exceeded the size limit.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeded the size limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function responseUrlIsAllowed(response, url) {
  if (!response?.url) return true;
  try {
    const actual = new URL(response.url);
    const expected = new URL(url);
    return actual.protocol === "https:" && actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === expected.search;
  } catch { return false; }
}

function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} response was not valid JSON.`); }
}

function fontInternalMetadata(bytes) {
  const font = createFont(bytes);
  if (!font || !Number.isFinite(font.unitsPerEm) || font.unitsPerEm <= 0 || typeof font.layout !== "function")
    throw new Error("Downloaded data is not a supported font face.");
  return font;
}

function verifyFont(bytes, expected) {
  const registry = new FontRegistry();
  registry.register(bytes, { id: "catalog-validation", family: expected.family, weight: expected.weight, style: expected.style });
  const font = registry.faces[0].font;
  // The weight class written inside the file is not checked: the catalog serves this file as the
  // family's face at expected.weight, and some families label their only face 300 or 500 inside
  // (a handwriting face listed at 400 refused a whole 25-op edit). The catalog's weight is used.
  const actualStyle = /italic|oblique/i.test(String(font.subfamilyName ?? "")) ? "italic" : "normal";
  if (actualStyle !== expected.style) throw new Error("Downloaded font style did not match the requested face.");
}

/**
 * Local, disk-backed Fontsource catalog. It only constructs requests for the
 * public Fontsource APIs and pinned jsDelivr package/font paths.
 */
export async function createFontCatalog({
  dataRoot,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  enabled = process.env.MOTION_FONT_DOWNLOADS !== "off",
} = {}) {
  if (!dataRoot) throw new TypeError("dataRoot is required to create a font catalog.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  const root = path.resolve(dataRoot, "fonts");
  const catalogFile = path.join(root, "catalog.json");
  const detailsRoot = path.join(root, "details");
  const facesRoot = path.join(root, "faces");
  const downloadsEnabled = enabled === true;
  const activeRequests = new Map();
  let catalogRefreshPromise = null;
  let catalogLastAttemptAt = Number.NEGATIVE_INFINITY;

  const cachePathForDetails = (id, version) => path.join(detailsRoot, `${id}--${version || "latest"}.json`);
  const cachePathForFaceMeta = (key) => path.join(facesRoot, `${key}.json`);
  const cachePathForFont = (hash) => path.join(facesRoot, `${hash}.ttf`);

  async function ensureDirectories() {
    await Promise.all([mkdir(root, { recursive: true, mode: 0o700 }), mkdir(detailsRoot, { recursive: true, mode: 0o700 }), mkdir(facesRoot, { recursive: true, mode: 0o700 })]);
  }

  async function atomicJson(filePath, value) {
    await ensureDirectories();
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function atomicBytes(filePath, bytes) {
    await ensureDirectories();
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function readJson(filePath) {
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_METADATA) return null;
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch { return null; }
  }

  async function request(url, maxBytes, label) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["api.fontsource.org", "cdn.jsdelivr.net", "data.jsdelivr.com"].includes(parsed.hostname))
      throw new Error("The font catalog request target is not allowed.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json, font/ttf, application/octet-stream" } });
      if (!responseUrlIsAllowed(response, url)) throw new Error(`${label} request reached an unexpected URL.`);
      const bytes = await responseBytes(response, maxBytes, label);
      return bytes;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`${label} request timed out.`);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function readCatalogCache() {
    const value = await readJson(catalogFile);
    if (!plain(value) || !Number.isFinite(value.fetchedAt) || !Array.isArray(value.families)) return null;
    const families = value.families.map(familyRecord).filter(Boolean);
    if (families.length !== value.families.length) return null;
    return {
      fetchedAt: value.fetchedAt,
      ...(Number.isFinite(value.lastAttemptAt) ? { lastAttemptAt: value.lastAttemptAt } : {}),
      ...(safeText(value.lastError, 240) ? { lastError: safeText(value.lastError, 240) } : {}),
      families,
    };
  }

  async function readCatalogFamily(id) {
    const cached = await readCatalogCache();
    return cached?.families.find((family) => family.id === id) ?? null;
  }

  async function readDetailsCache(id, version) {
    const value = await readJson(cachePathForDetails(id, version));
    if (!plain(value) || value.id !== id || !VERSION.test(value.version) || !plain(value.variants) || !plain(value.unicodeRange)) return null;
    if (version && value.version !== version) return null;
    return value;
  }

  async function fetchCatalog(lastAttemptAt = Number(now())) {
    const url = "https://api.fontsource.org/v1/fonts?type=google";
    const bytes = await request(url, MAX_CATALOG, "Font catalog");
    const raw = parseJson(bytes, "Font catalog");
    if (!Array.isArray(raw)) throw new Error("Fontsource returned an invalid catalog.");
    const families = raw.filter((record) => record?.type === "google").map(familyRecord).filter(Boolean);
    if (!families.length) throw new Error("Fontsource returned an empty Google Fonts catalog.");
    const unique = [...new Map(families.map((family) => [family.id, family])).values()];
    unique.sort((a, b) => a.family.localeCompare(b.family));
    const value = { fetchedAt: Number(now()), lastAttemptAt, families: unique };
    await atomicJson(catalogFile, value);
    return value;
  }

  async function refreshCatalog(cached) {
    if (catalogRefreshPromise) return catalogRefreshPromise;
    const lastAttemptAt = Number(now());
    catalogLastAttemptAt = lastAttemptAt;
    const promise = (async () => {
      try { return await fetchCatalog(lastAttemptAt); }
      catch (error) {
        const fallback = {
          fetchedAt: cached?.fetchedAt ?? 0,
          lastAttemptAt,
          lastError: errorMessage(error),
          families: cached?.families ?? [],
        };
        await atomicJson(catalogFile, fallback).catch(() => {});
        throw error;
      }
    })().finally(() => { catalogRefreshPromise = null; });
    catalogRefreshPromise = promise;
    return promise;
  }

  async function familiesFromCache() {
    const entries = await cachedEntries();
    const byFamily = new Map();
    for (const entry of entries) {
      if (!byFamily.has(entry.catalogId)) byFamily.set(entry.catalogId, {
        id: entry.catalogId,
        family: entry.family,
        weights: [],
        styles: [],
        subsets: [],
        defSubset: entry.defaultSubset,
        license: entry.license,
        ...(entry.licenseDetails ? { licenseDetails: entry.licenseDetails } : {}),
        // The family's catalog category ("serif", "display"…), kept with each face downloaded
        // since it was added, so font help can offer a font of the same kind offline too.
        ...(safeText(entry.category, 50) ? { category: safeText(entry.category, 50) } : {}),
        variable: false,
      });
      const family = byFamily.get(entry.catalogId);
      if (!family.weights.includes(entry.weight)) family.weights.push(entry.weight);
      if (!family.styles.includes(entry.style)) family.styles.push(entry.style);
      if (!family.subsets.includes(entry.subset)) family.subsets.push(entry.subset);
    }
    return [...byFamily.values()].map((family) => ({
      ...family,
      weights: family.weights.sort((a, b) => a - b),
      styles: family.styles.sort((a, b) => a.localeCompare(b)),
      subsets: family.subsets.sort((a, b) => a.localeCompare(b)),
    }));
  }

  async function list({ search = "", limit = 2500 } = {}) {
    const count = Number.isFinite(Number(limit)) ? Math.max(0, Math.min(2500, Math.trunc(Number(limit)))) : 2500;
    const term = safeText(String(search ?? ""), 200).toLocaleLowerCase();
    let cached = downloadsEnabled ? await readCatalogCache() : null;
    let offline = false;
    let error;
    const currentTime = Number(now());
    const stale = !cached || currentTime - cached.fetchedAt >= DAY;
    const latestAttempt = Math.max(cached?.lastAttemptAt ?? Number.NEGATIVE_INFINITY, catalogLastAttemptAt);
    const coolingDown = Number.isFinite(latestAttempt) && currentTime - latestAttempt < DAY;
    if (downloadsEnabled && stale && (!coolingDown || catalogRefreshPromise)) {
      try { cached = await refreshCatalog(cached); }
      catch (reason) { offline = true; error = errorMessage(reason); }
    } else if (downloadsEnabled && stale && coolingDown && cached?.lastError) {
      offline = true;
      error = cached.lastError;
    }
    let families = downloadsEnabled ? cached?.families ?? [] : [];
    if (!families.length) families = await familiesFromCache();
    const matches = families.filter((family) => !term || family.family.toLocaleLowerCase().includes(term) || family.id.toLocaleLowerCase().includes(term));
    return { families: matches.slice(0, count), total: matches.length, downloadsEnabled, offline, ...(error ? { error } : {}) };
  }

  async function fetchApiDetail(id, family) {
    const bytes = await request(`https://api.fontsource.org/v1/fonts/${id}`, MAX_METADATA, "Font family metadata");
    const raw = parseJson(bytes, "Font family metadata");
    if (raw?.id !== id) throw new Error("Fontsource returned a different family than requested.");
    const value = { ...normalizeApiDetail(raw, family), cachedAt: Number(now()) };
    await atomicJson(cachePathForDetails(id, "latest"), value);
    await atomicJson(cachePathForDetails(id, value.version), value);
    return value;
  }

  async function fetchPinnedDetail(id, version, family) {
    const base = `https://cdn.jsdelivr.net/npm/@fontsource/${id}@${version}`;
    const treeUrl = `https://data.jsdelivr.com/v1/packages/npm/@fontsource/${id}@${version}?structure=tree`;
    const [metadataBytes, unicodeBytes, treeBytes] = await Promise.all([
      request(`${base}/metadata.json`, MAX_METADATA, "Pinned font metadata"),
      request(`${base}/unicode.json`, MAX_METADATA, "Pinned Unicode metadata"),
      request(treeUrl, MAX_METADATA, "Pinned package tree"),
    ]);
    const metadata = parseJson(metadataBytes, "Pinned font metadata");
    const unicode = parseJson(unicodeBytes, "Pinned Unicode metadata");
    const tree = parseJson(treeBytes, "Pinned package tree");
    const value = normalizePinnedMetadata(id, version, metadata, unicode, tree, family);
    await atomicJson(cachePathForDetails(id, version), value);
    return value;
  }

  async function detail(id, { version } = {}) {
    validId(id);
    const pinnedVersion = version == null || version === "" ? null : validVersion(version);
    const family = await readCatalogFamily(id);
    const cachedLatest = await readDetailsCache(id, null);
    if (!pinnedVersion && cachedLatest && Number(now()) - Number(cachedLatest.cachedAt ?? 0) < DAY) return cachedLatest;
    if (pinnedVersion) {
      const cached = await readDetailsCache(id, pinnedVersion);
      if (cached) return cached;
      if (cachedLatest?.version === pinnedVersion) return cachedLatest;
    }
    if (!downloadsEnabled) {
      if (pinnedVersion) throw new Error(`Font ${id} version ${pinnedVersion} is not cached and downloads are disabled.`);
      if (cachedLatest) return cachedLatest;
      throw new Error(`Font ${id} is not cached and downloads are disabled.`);
    }
    const requestKey = `detail:${id}:${pinnedVersion ?? "latest"}`;
    if (activeRequests.has(requestKey)) return activeRequests.get(requestKey);
    const promise = (async () => {
      try {
        if (!pinnedVersion) return await fetchApiDetail(id, family);
        if (cachedLatest?.version === pinnedVersion) {
          await atomicJson(cachePathForDetails(id, pinnedVersion), cachedLatest);
          return cachedLatest;
        }
        return await fetchPinnedDetail(id, pinnedVersion, family);
      } catch (error) {
        if (!pinnedVersion && cachedLatest) return cachedLatest;
        throw error;
      } finally { activeRequests.delete(requestKey); }
    })();
    activeRequests.set(requestKey, promise);
    return promise;
  }

  async function verifyCachedRecord(record) {
    if (!plain(record) || !ID.test(record.catalogId) || !VERSION.test(record.version) || !Number.isInteger(record.weight) ||
        !["normal", "italic"].includes(record.style) || !SUBSET.test(record.subset) || !SUBSET.test(record.defaultSubset) ||
        typeof record.family !== "string" || !safeText(record.family) || !Number.isFinite(record.weight) || record.weight < 1 || record.weight > 1000 ||
        typeof record.license !== "string" || !LICENSES.test(record.license) || typeof record.unicodeRange !== "string" ||
        typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash) ||
        record.id !== `${record.catalogId}/${record.version}/${record.weight}/${record.style}/${record.subset}`) return null;
    try { parseUnicodeRange(record.unicodeRange); }
    catch { return null; }
    const filePath = cachePathForFont(record.hash);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_FONT) return null;
      const bytes = await readFile(filePath);
      if (hashBytes(bytes) !== record.hash) return null;
      verifyFont(bytes, record);
      return { record: { ...record, url: `/api/fonts/fs-cache-${record.hash}.ttf`, src: normalizedSource(record) }, bytes, filePath };
    } catch { return null; }
  }

  async function cachedEntries() {
    let names;
    try { names = await readdir(facesRoot); }
    catch { return []; }
    const entries = [];
    for (const name of names.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).sort()) {
      const metadata = await readJson(path.join(facesRoot, name));
      const verified = await verifyCachedRecord(metadata);
      if (verified) entries.push(verified.record);
    }
    return entries.sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || a.style.localeCompare(b.style) || a.subset.localeCompare(b.subset));
  }

  async function writeFace(bytes, expected, subset) {
    const hash = hashBytes(bytes);
    const record = {
      id: `${expected.catalogId}/${expected.version}/${expected.weight}/${expected.style}/${subset}`,
      catalogId: expected.catalogId,
      family: expected.family,
      weight: expected.weight,
      style: expected.style,
      src: expected.src,
      url: `/api/fonts/fs-cache-${hash}.ttf`,
      subset,
      defaultSubset: expected.defaultSubset,
      unicodeRange: expected.unicodeRange[subset],
      license: expected.license,
      ...(expected.licenseDetails ? { licenseDetails: expected.licenseDetails } : {}),
      ...(expected.category ? { category: expected.category } : {}),
      version: expected.version,
      hash,
    };
    const filePath = cachePathForFont(hash);
    try {
      const existing = await readFile(filePath);
      if (hashBytes(existing) !== hash) await atomicBytes(filePath, bytes);
    } catch { await atomicBytes(filePath, bytes); }
    await atomicJson(cachePathForFaceMeta(faceKey({ id: expected.catalogId, version: expected.version, weight: expected.weight, style: expected.style, subset })), record);
    return record;
  }

  async function fetchSubset(expected, subset) {
    const key = `${root}:${expected.catalogId}:${expected.version}:${expected.weight}:${expected.style}:${subset}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      const pathSubset = encodeURIComponent(subset);
      const url = `https://cdn.jsdelivr.net/fontsource/fonts/${expected.catalogId}@${expected.version}/${pathSubset}-${expected.weight}-${expected.style}.ttf`;
      const bytes = await request(url, MAX_FONT, "Font download");
      verifyFont(bytes, expected);
      const record = await writeFace(bytes, expected, subset);
      return record;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  async function ensureFace({ id, version, weight = 400, style = "normal", text = "" } = {}) {
    validId(id);
    const pinnedVersion = version == null || version === "" ? null : validVersion(version);
    if (typeof text !== "string" || text.length > 65_536) throw new Error("Font text must be a string of at most 65,536 characters.");
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000 || !["normal", "italic"].includes(style))
      throw new Error("The requested font face is invalid.");
    let familyMetadata;
    if (downloadsEnabled) familyMetadata = await detail(id, { ...(pinnedVersion ? { version: pinnedVersion } : {}) });
    else {
      try { familyMetadata = await detail(id, { ...(pinnedVersion ? { version: pinnedVersion } : {}) }); }
      catch {
        const entries = await cachedEntries();
        const faceEntries = entries.filter((entry) => entry.catalogId === id && entry.weight === weight && entry.style === style && (!pinnedVersion || entry.version === pinnedVersion));
        if (!faceEntries.length) throw new Error(`Font ${id} is not cached and downloads are disabled.`);
        familyMetadata = null;
      }
    }
    const entries = await cachedEntries();
    const faceEntries = entries.filter((entry) => entry.catalogId === id && entry.weight === weight && entry.style === style && (!pinnedVersion || entry.version === pinnedVersion));
    if (!familyMetadata) {
      const base = faceEntries[0];
      if (!base) throw new Error(`Font ${id} is not cached and downloads are disabled.`);
      const subsetNames = sortedUnique(faceEntries.map((entry) => entry.subset));
      const metadata = { subsets: subsetNames, defSubset: base.defaultSubset, unicodeRange: Object.fromEntries(faceEntries.map((entry) => [entry.subset, entry.unicodeRange])) };
      const needed = fontSubsetsForText(metadata, text);
      if (needed.some((subset) => !subsetNames.includes(subset))) throw new Error(`Font ${id} needs a missing subset and downloads are disabled.`);
      return { family: base.family, weight, style, src: base.src, faces: faceEntries.filter((entry) => needed.includes(entry.subset)) };
    }
    const availableSubsets = familyMetadata.variants?.[String(weight)]?.[style];
    if (!Array.isArray(availableSubsets) || !availableSubsets.length)
      throw new Error(`Font ${familyMetadata.family} does not have weight ${weight} ${style}.`);
    const src = normalizedSource({ id, version: familyMetadata.version, weight, style });
    const defaultSubset = availableSubsets.includes(familyMetadata.defSubset) ? familyMetadata.defSubset : availableSubsets[0];
    const unicodeRange = Object.fromEntries(availableSubsets.map((subset) => [subset, familyMetadata.unicodeRange[subset]]));
    const requiredSubsets = fontSubsetsForText({ subsets: availableSubsets, defSubset: defaultSubset, unicodeRange }, text);
    const expected = {
      catalogId: id,
      family: familyMetadata.family,
      version: familyMetadata.version,
      weight,
      style,
      src,
      defaultSubset,
      unicodeRange,
      license: familyMetadata.license,
      licenseDetails: familyMetadata.licenseDetails,
      category: familyMetadata.category,
    };
    const already = new Map(faceEntries.filter((entry) => entry.src === src).map((entry) => [entry.subset, entry]));
    for (const subset of requiredSubsets) {
      if (already.has(subset)) continue;
      if (!downloadsEnabled) throw new Error(`Font ${familyMetadata.family} needs an uncached subset and downloads are disabled.`);
      already.set(subset, await fetchSubset(expected, subset));
    }
    return { family: familyMetadata.family, weight, style, src, faces: requiredSubsets.map((subset) => already.get(subset)) };
  }

  async function loadInto(registry) {
    if (!registry || typeof registry.register !== "function") throw new TypeError("A FontRegistry is required.");
    for (const entry of await cachedEntries()) {
      const verified = await verifyCachedRecord(entry);
      if (!verified) continue;
      registry.register(verified.bytes, {
        id: entry.id,
        family: entry.family,
        weight: entry.weight,
        style: entry.style,
        src: entry.src,
        url: entry.url,
        subset: entry.subset,
        defaultSubset: entry.defaultSubset,
        unicodeRange: entry.unicodeRange,
        license: entry.license,
        version: entry.version,
      });
    }
    return registry;
  }

  async function file(name) {
    const value = String(name ?? "");
    const cachedMatch = CACHE_FONT.exec(path.basename(value));
    if (cachedMatch && (value === path.basename(value) || value === `/api/fonts/${path.basename(value)}`)) {
      const hash = cachedMatch[1];
      try {
        const filePath = cachePathForFont(hash);
        const bytes = await readFile(filePath);
        if (bytes.length > MAX_FONT || hashBytes(bytes) !== hash) return null;
        fontInternalMetadata(bytes);
        return { path: filePath, mime: "font/ttf" };
      } catch { return null; }
    }
    const logicalSource = value.startsWith("/") ? value : `/api/fonts/${value}`;
    const parsed = parseCatalogFontSource(logicalSource);
    if (!parsed) return null;
    const entries = await cachedEntries();
    const entry = entries.find((item) => item.catalogId === parsed.id && item.version === parsed.version && item.weight === parsed.weight && item.style === parsed.style && item.subset === item.defaultSubset);
    if (!entry) return null;
    const verified = await verifyCachedRecord(entry);
    return verified ? { path: verified.filePath, mime: "font/ttf" } : null;
  }

  // measuresFile: library {topic:"fonts", like} keeps each face's measured glyphs there (font-like.mjs).
  return { list, detail, ensureFace, cachedEntries, loadInto, file, downloadsEnabled, measuresFile: path.join(root, "like-measures.json") };
}
