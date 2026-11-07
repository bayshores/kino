import { api, accessHeaders } from "./client.js";
import { FontRegistry, defaultFonts } from "../engine/fonts.js";
import { documentFontReferences } from "../engine/fontDocuments.js";
import { fontGlyphReferences } from "../engine/fontGlyphReferences.js";
const pendingLoads = new Map();

async function readCatalog(extraErrors = [], endpoint = "/fonts") {
  const catalog = await api(endpoint);
  const registry = new FontRegistry();
  registry.errors = [...(catalog.errors || []), ...extraErrors];
  const headers = accessHeaders();
  const bytes = await Promise.all(catalog.fonts.map(async (entry) => {
    try {
      const response = await fetch(entry.url || entry.src, { headers });
      if (!response.ok) throw new Error(`Font “${entry.family}” could not be loaded (${response.status}). Try again.`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      registry.errors.push({ id: entry.id, name: entry.family, error: error.message });
      return null;
    }
  }));
  for (let index = 0; index < catalog.fonts.length; index++) {
    if (!bytes[index]) continue;
    try { registry.register(bytes[index], catalog.fonts[index]); }
    catch (error) { registry.errors.push({ id: catalog.fonts[index].id, name: catalog.fonts[index].family, error: error.message }); }
  }
  defaultFonts.replace(registry);
  return registry;
}

export function loadBrowserFonts(document = null) {
  const key = JSON.stringify([accessHeaders(), document?.id, document && documentFontReferences(document), document && fontGlyphReferences(document)]);
  if (pendingLoads.has(key)) return pendingLoads.get(key);
  const task = (async () => {
    const ensured = document ? await api("/fonts/ensure", { method: "POST", body: { document, allowMissing: true } }) : null;
    return readCatalog(ensured?.errors ?? []);
  })().finally(() => pendingLoads.delete(key));
  pendingLoads.set(key, task);
  return task;
}

let viewerLoadedKey = "";
export async function loadViewerFonts(document) {
  const key = JSON.stringify([accessHeaders(), document.id, documentFontReferences(document), fontGlyphReferences(document)]);
  if (key === viewerLoadedKey) return defaultFonts;
  const pendingKey = `viewer:${key}`;
  if (pendingLoads.has(pendingKey)) return pendingLoads.get(pendingKey);
  const task = readCatalog([], "/shared-fonts").then((registry) => {
    viewerLoadedKey = key;
    return registry;
  }).finally(() => pendingLoads.delete(pendingKey));
  pendingLoads.set(pendingKey, task);
  return task;
}
