// Voice stems as library media (backend/voice/media.mjs), without a server: a video whose sound
// starts 0.25 s after its picture keeps its picture packet for packet, its sound stays on the
// file's clock (silence in front), voice + background add up to the original, and a second run
// reuses the same library files until one is deleted.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMedia } from "./media-probe.mjs";
import { createVoiceMedia, mediaBaseName, soundLead } from "./voice/media.mjs";
import { ffmpeg, ffprobe, run, skipWithoutMediaTools } from "./media.test.support.mjs";
import { SAMPLE_RATE, SPEECH_CLIP, buildMixture, decodeSamples, writeWav } from "../tests/voice-mix.mjs";

const LEAD = 0.25;

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-voice-media-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// A stand-in for backend/index.mjs addGeneratedMedia: moves the file into the library folder.
function library(mediaRoot) {
  const added = [];
  async function addMedia(file, { name, mime }) {
    const id = `${randomUUID()}.${{ "audio/mp4": "m4a", "video/mp4": "mp4", "video/webm": "webm" }[mime]}`;
    await rename(file, join(mediaRoot, id));
    const probe = await probeMedia(join(mediaRoot, id));
    const record = { id, src: `/api/media/${id}`, name, mime, duration: probe.duration, hasAudio: probe.hasAudio, hasVideo: probe.hasVideo };
    await writeFile(join(mediaRoot, `${id}.json`), JSON.stringify(record));
    added.push(record);
    return record;
  }
  return { addMedia, added };
}

// The video packets of a file, one checksum each: equal lists mean the same picture, unencoded.
async function videoPackets(file) {
  const text = String(await run(ffmpeg, ["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "framemd5", "-"]));
  return text.split("\n").filter((line) => line && !line.startsWith("#"));
}

async function streams(file) {
  return JSON.parse(String(await run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,start_time", "-of", "json", file]))).streams;
}

test("names drop the file extension", () => {
  assert.equal(mediaBaseName("Interview.mp4"), "Interview");
  assert.equal(mediaBaseName("take two"), "take two");
  assert.equal(mediaBaseName(""), "sound");
});

test("a video's voice keeps its picture and its sound's place on the file's clock, and is made once", { skip: skipWithoutMediaTools }, async (t) => {
  const root = await folder(t);
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
  const { mixture } = buildMixture((await decodeSamples(SPEECH_CLIP)).subarray(0, 2 * SAMPLE_RATE));
  const wav = join(root, "mix.wav");
  await writeWav(wav, mixture);
  // The sound starts 0.25 s after the picture, as in many camera files.
  const video = join(root, "clip.mp4");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=15:duration=3", "-itsoffset", String(LEAD), "-i", wav,
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", video]);
  const lead = await soundLead(video);
  assert.ok(Math.abs(lead - LEAD) < 0.03, `the sound starts ${lead} s in`);

  const { addMedia, added } = library(mediaRoot);
  const voiceMedia = createVoiceMedia({ mediaRoot, cacheDir: join(root, "voice"), modelDir: join(root, "models"), addMedia, download: false });
  const first = await voiceMedia.make({ file: video, name: "clip.mp4", mime: "video/mp4", keep: "both", engine: "rnnoise" });
  assert.equal(first.engine, "rnnoise");
  assert.equal(first.cached, false);
  assert.deepEqual([first.voice.name, first.voice.mime, first.background.name, first.background.mime],
    ["clip (voice).mp4", "video/mp4", "clip (background).m4a", "audio/mp4"]);

  const voiceFile = join(mediaRoot, first.voice.id), backgroundFile = join(mediaRoot, first.background.id);
  assert.deepEqual(await videoPackets(voiceFile), await videoPackets(video), "the picture is copied packet for packet");
  assert.deepEqual((await streams(voiceFile)).map((stream) => [stream.codec_type, stream.codec_name]), [["video", "h264"], ["audio", "flac"]]);
  assert.deepEqual((await streams(backgroundFile)).map((stream) => [stream.codec_type, stream.codec_name]), [["audio", "flac"]]);

  // Voice + background = the original sound, 0.25 s in, with silence before it.
  const original = await decodeSamples(video);
  const voice = await decodeSamples(voiceFile);
  const background = await decodeSamples(backgroundFile);
  const shift = Math.round(lead * SAMPLE_RATE);
  let before = 0, largest = 0;
  for (let i = 0; i < shift; i += 1) before = Math.max(before, Math.abs(voice[i]), Math.abs(background[i]));
  for (let i = 0; i < original.length; i += 1) largest = Math.max(largest, Math.abs(voice[i + shift] + background[i + shift] - original[i]));
  assert.ok(before < 1e-6, `silence before the sound (largest ${before})`);
  assert.ok(largest < 1e-4, `voice + background = original (largest difference ${largest})`);

  // Again: the same library files, nothing new made.
  const again = await voiceMedia.make({ file: video, name: "clip.mp4", mime: "video/mp4", keep: "both", engine: "rnnoise" });
  assert.equal(again.cached, true);
  assert.deepEqual([again.voice.id, again.background.id], [first.voice.id, first.background.id]);
  assert.equal(added.length, 2);
  // keep "background" on a video gives the background with the picture: a new file, same stems.
  const backgroundVideo = await voiceMedia.make({ file: video, name: "clip.mp4", mime: "video/mp4", keep: "background", engine: "rnnoise" });
  assert.equal(backgroundVideo.background.name, "clip (background).mp4");
  assert.equal(backgroundVideo.cached, false);
  // A library file deleted since is made again.
  await rm(voiceFile);
  const remade = await voiceMedia.make({ file: video, name: "clip.mp4", mime: "video/mp4", keep: "voice", engine: "rnnoise" });
  assert.notEqual(remade.voice.id, first.voice.id);
  assert.equal(remade.cached, false);
});
