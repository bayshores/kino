import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex } from "./sha256.js";

const nodeSha256 = (text) => createHash("sha256").update(text).digest("hex");

test("sha256Hex matches the published test vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("sha256Hex matches Node's SHA-256 for every length across several blocks and for UTF-8 text", () => {
  // Lengths 0 to 200 cross the 55/56/64-byte padding edges and fill several blocks.
  for (let length = 0; length <= 200; length += 1) {
    const text = Array.from({ length }, (_, index) => String.fromCharCode(33 + ((index * 7) % 90))).join("");
    assert.equal(sha256Hex(text), nodeSha256(text), `length ${length}`);
  }
  for (const text of ["Émile’s comment", "\u{1F600} smile", "kino-comment-author\nproject\n" + "a".repeat(64), "x".repeat(10_000)])
    assert.equal(sha256Hex(text), nodeSha256(text), text.slice(0, 20));
});
