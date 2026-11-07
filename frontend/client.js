import { requestJson } from "./request.js";

export function shareToken() {
  // Legacy query capabilities retain their access instead of falling through to
  // a browser's ambient owner session. Newly copied links always use #share.
  const fragment = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const params = fragment.has("share") ? fragment : query;
  return params.has("share") ? params.get("share") || "invalid" : "";
}
function ownerKey() {
  const key = new URLSearchParams(location.hash.slice(1)).get("owner");
  try {
    if (key) sessionStorage.setItem("kino-host-key", key);
    return key || sessionStorage.getItem("kino-host-key") || "";
  } catch { return key || ""; }
}
export function accessHeaders() {
  const token = shareToken();
  if (token) return { "X-Kino-Share": token };
  const key = ownerKey();
  return key ? { "X-Kino-Owner": key } : {};
}
export function authorizedMediaUrl(src) {
  const token = shareToken();
  if (!token || !src?.startsWith("/api/media/")) return src;
  return `${src}${src.includes("?") ? "&" : "?"}share=${encodeURIComponent(token)}`;
}

export async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  // Document writes and reads have a deadline. Exports, downloads, and other
  // long operations keep their own cancellation and completion policies.
  const timeoutMs = options.timeoutMs ?? (method === "GET" || (method === "PUT" && /^\/projects\/[^/]+$/.test(path)) ? 15000 : 0);
  return requestJson(`/api${path}`, {
    ...options,
    timeoutMs,
    headers: {
      ...accessHeaders(),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    body:
      options.body && typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body,
  });
}
