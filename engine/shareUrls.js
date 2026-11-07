// Only these document identifiers and a file capability may leave the editor.
// This module also runs in Electron's main process, without renderer imports.
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NODE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN = /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/;
const QUERY_KEYS = new Set(["project", "scene", "layer", "componentPath", "nodeId"]);

export function validShareToken(value) { return typeof value === "string" && TOKEN.test(value); }
export function validShareProject(value) { return typeof value === "string" && PROJECT_ID.test(value); }
function nodeId(value) { return typeof value === "string" && NODE_ID.test(value) && ![".", ".."].includes(value); }
function componentPath(value) {
  return typeof value === "string" && value.split("/").length <= 17 && value.split("/").every(nodeId);
}

export function shareTokenFromUrl(href) {
  try {
    const url = new URL(href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const token = fragment.has("share") ? fragment.get("share") : url.searchParams.get("share");
    return validShareToken(token) ? token : "";
  } catch { return ""; }
}

/** Start with an empty URL, never a deletion list of potentially private fields. */
export function shareUrl(href, projectId, selection = {}, { desktop = false, token } = {}) {
  if (!validShareProject(projectId)) return null;
  const { sceneId, layerId, componentPath: inheritedPath } = selection ?? {};
  if ((sceneId && !nodeId(sceneId)) || (layerId && (!sceneId || !nodeId(layerId))) ||
      (inheritedPath && (!layerId || !componentPath(inheritedPath)))) return null;
  let source;
  try { source = new URL(href); } catch { return null; }
  if (!["http:", "https:", "kino:"].includes(source.protocol)) return null;
  const capability = token === undefined ? shareTokenFromUrl(href) : token;
  if (capability && !validShareToken(capability)) return null;
  if (desktop && !capability) return null;
  if (!desktop && !["http:", "https:"].includes(source.protocol)) return null;
  const url = desktop ? new URL("kino://open") : new URL(source.origin);
  if (!desktop) url.pathname = source.pathname;
  url.searchParams.set("project", projectId);
  if (sceneId) url.searchParams.set("scene", sceneId);
  if (layerId) url.searchParams.set("layer", layerId);
  if (inheritedPath) url.searchParams.set("componentPath", inheritedPath);
  if (capability) url.hash = new URLSearchParams({ share: capability }).toString();
  return url.href;
}

/** An external launch must carry its own file capability, never ambient owner access. */
export function parseDesktopLink(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "kino:" || url.hostname !== "open" || url.port || url.username || url.password ||
      !["", "/"].includes(url.pathname)) return null;
  for (const key of url.searchParams.keys())
    if (!QUERY_KEYS.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if ([...fragment.keys()].some((key) => key !== "share") || fragment.getAll("share").length !== 1) return null;
  const projectId = url.searchParams.get("project"), token = fragment.get("share");
  if (!validShareProject(projectId) || !validShareToken(token)) return null;
  const result = { projectId, token };
  for (const [query, field] of [["scene", "sceneId"], ["layer", "layerId"], ["nodeId", "nodeId"]]) {
    if (!url.searchParams.has(query)) continue;
    const id = url.searchParams.get(query);
    if (!nodeId(id)) return null;
    result[field] = id;
  }
  if (result.layerId && !result.sceneId) return null;
  if (url.searchParams.has("componentPath")) {
    const path = url.searchParams.get("componentPath");
    if (!(result.layerId || result.nodeId) || !componentPath(path)) return null;
    result.componentPath = path;
  }
  return result;
}

export function desktopLinkUrl(value, origin) {
  const target = parseDesktopLink(value);
  let service;
  try { service = new URL(origin); } catch { return null; }
  if (!target || service.protocol !== "http:" || service.hostname !== "127.0.0.1" || service.username || service.password) return null;
  const url = new URL("/", service.origin);
  url.searchParams.set("project", target.projectId);
  for (const [field, query] of [["sceneId", "scene"], ["layerId", "layer"], ["componentPath", "componentPath"], ["nodeId", "nodeId"]])
    if (target[field]) url.searchParams.set(query, target[field]);
  url.hash = new URLSearchParams({ share: target.token }).toString();
  return url.href;
}
