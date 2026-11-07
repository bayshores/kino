/**
 * Whether a kino window may show `url`: pages from the local editor server (`origin`)
 * and about:blank, which the export flow opens before it knows the export page address.
 * Everything else is refused. That includes the file:// address a browser window loads
 * when a file is dropped on a part of the page that does not take drops, so a dropped
 * file can never replace the editor.
 */
export function isEditorUrl(url, origin) {
  if (url === "about:blank") return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

// During a restart the old port can be claimed by another local process. Keep
// renderer requests (including media and uploads) away from it until the app has
// authenticated its new service. Non-loopback traffic keeps the existing CSP policy.
export function serviceRequestAllowed(value, readyOrigin) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return true;
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return url.origin === readyOrigin;
  } catch { return false; }
}
