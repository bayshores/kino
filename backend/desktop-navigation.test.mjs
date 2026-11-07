import test from "node:test";
import assert from "node:assert/strict";
import { isEditorUrl, serviceRequestAllowed } from "../desktop/navigation.mjs";

const origin = "http://127.0.0.1:4781";

test("the Mac app window stays on the editor when a file is dropped outside a drop target", () => {
  assert.equal(isEditorUrl("file:///Users/someone/Desktop/photo.png", origin), false);
  assert.equal(isEditorUrl("file:///Users/someone/Desktop/Brand%20Font.woff2", origin), false);
  assert.equal(isEditorUrl("https://example.com/", origin), false);
  assert.equal(isEditorUrl("http://127.0.0.1:4782/", origin), false, "another local port is another origin");
  assert.equal(isEditorUrl("not a url", origin), false, "an unreadable address is refused instead of throwing");
});

test("the editor's own pages and the export flow's blank page stay allowed", () => {
  assert.equal(isEditorUrl(`${origin}/?project=abc&export=scene`, origin), true);
  assert.equal(isEditorUrl("about:blank", origin), true);
});

test("renderer requests cannot reach a vacated loopback port during or after restart", () => {
  assert.equal(serviceRequestAllowed(`${origin}/api/projects`, null), false);
  assert.equal(serviceRequestAllowed(`${origin}/api/media/example.png?share=test-only`, origin), true);
  assert.equal(serviceRequestAllowed("ws://127.0.0.1:4781/collaboration", origin), true);
  const replacement = "http://127.0.0.1:4782";
  assert.equal(serviceRequestAllowed(`${origin}/api/media`, replacement), false, "old-port uploads are blocked before leaving the app");
  assert.equal(serviceRequestAllowed(`${replacement}/api/media`, replacement), true);
  assert.equal(serviceRequestAllowed("http://localhost:4782/", replacement), false);
  assert.equal(serviceRequestAllowed("http://[::1]:4782/", replacement), false);
  assert.equal(serviceRequestAllowed("data:image/png;base64,test", null), true);
  assert.equal(serviceRequestAllowed("https://example.com/image.png", null), true, "non-loopback requests still use the existing CSP");
});
