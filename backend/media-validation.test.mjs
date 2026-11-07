import test from "node:test";
import assert from "node:assert/strict";
import { mediaSignatureMatches, mediaStreamsMatch } from "./media-validation.mjs";

test("media signatures distinguish supported image, video, and audio containers", () => {
  const headers = [
    ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["image/webp", Buffer.from("RIFF0000WEBP")],
    ["image/gif", Buffer.from("GIF89a")],
    ["video/mp4", Buffer.from("0000ftypisom")],
    ["video/webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
    ["audio/mpeg", Buffer.from("ID3")],
    ["audio/wav", Buffer.from("RIFF0000WAVE")],
    ["audio/ogg", Buffer.from("OggS")],
  ];
  for (const [mime, header] of headers) assert.equal(mediaSignatureMatches(mime, header), true, mime);

  assert.equal(mediaSignatureMatches("video/mp4", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false,
    "still image bytes cannot pass as an MP4 container");
  assert.equal(mediaSignatureMatches("image/png", Buffer.from("RIFF0000WAVE")), false,
    "audio bytes cannot pass as PNG");
  assert.equal(mediaSignatureMatches("image/png", Buffer.alloc(0)), false, "empty files do not match a media container");
});

test("probed streams must match the declared media kind", () => {
  const still = { hasVideo: true, hasAudio: false, width: 40, height: 20 };
  const video = { hasVideo: true, hasAudio: true, width: 1920, height: 1080 };
  const audio = { hasVideo: false, hasAudio: true, width: 0, height: 0 };
  assert.equal(mediaStreamsMatch("image/png", still), true);
  assert.equal(mediaStreamsMatch("image/gif", still), true);
  assert.equal(mediaStreamsMatch("video/mp4", video), true);
  assert.equal(mediaStreamsMatch("audio/wav", audio), true);
  assert.equal(mediaStreamsMatch("image/png", audio), false);
  assert.equal(mediaStreamsMatch("video/mp4", audio), false);
  assert.equal(mediaStreamsMatch("audio/mpeg", video), false);
  assert.equal(mediaStreamsMatch("image/png", { ...still, width: 0 }), false);
});
