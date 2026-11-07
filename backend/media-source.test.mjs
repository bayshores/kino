import test from "node:test";
import assert from "node:assert/strict";
import { parseMediaSource } from "./media-source.mjs";
import { normalizeMediaHref } from "../engine/render.js";

const id = "11111111-1111-4111-8111-111111111111.gif";
const source = `/api/media/${id}`;

test("uploaded sources and decoded frame URLs identify the underlying upload, with supported query parameters", () => {
  for (const query of ["", "?share=link.token_~-123"]) {
    assert.deepEqual(parseMediaSource(`${source}${query}`), { id, frame: null });
    normalizeMediaHref(`${source}${query}`);
  }
  for (const query of ["", "?decoder=1", "?share=link.token_~-123", "?decoder=1&share=link.token_~-123"]) {
    const frame = `${source}/frames/23.png${query}`;
    assert.deepEqual(parseMediaSource(frame), { id, frame: 23 });
    normalizeMediaHref(frame);
  }
  assert.deepEqual(parseMediaSource(`${source}/frames/0.png`), { id, frame: 0 });
});

test("media dependency parsing refuses external URLs, path escapes and unsupported frame/query forms", () => {
  for (const value of [null, {}, 3, "", "data:image/png;base64,AAAA", `https://example.com${source}`,
    `${source}/frames`, `${source}/frames/01.png`, `${source}/frames/-1.png`, `${source}/frames/1000000.png`,
    `${source}/frames/0.png?decoder=x`, `${source}/frames/0.png?decoder=1&other=1`,
    `${source}/frames/0.png?decoder=1&share=../secret`, `${source}?other=1`, `${source}?decoder=1`,
    "/api/media/../secret.gif", "/api/media/%2e%2e.gif/frames/0.png", "/api/media/abc.png/frames/0.png",
  ]) assert.equal(parseMediaSource(value), null, String(value));
});
