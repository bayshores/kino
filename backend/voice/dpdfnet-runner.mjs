// Runs the DPDFNet speech enhancement model (through sherpa-onnx) over a 48 kHz mono float WAV and
// writes the cleaned voice to another WAV of the same length. backend/voice/isolate.mjs starts this
// as its own process, because the model call blocks until it finishes and only killing the
// process stops it at once; a crash in the native code also stays out of the kino service.
//
// Usage: node dpdfnet-runner.mjs <input.wav> <output.wav> <model.onnx> <threads>
// Standard output gets "progress <0..1>" lines and "done" at the end.
//
// The sound is cleaned 30 seconds at a time so memory stays small and progress can be shown.
// Each piece also gets 1 s of the sound before it, so the model's memory has settled when the
// piece starts, and 0.2 s after it, because the model looks a few frames ahead and the last
// frames of a run are cleaned with silence as their future. Neighbouring pieces overlap by 5 ms
// and are cross-faded there, so the joins are inaudible.
import { closeSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { floatWavHeader, readSamples, readWavInfo, writeSamples } from "./wav.mjs";

const SAMPLE_RATE = 48000;
const PIECE = 30 * SAMPLE_RATE;
const BEFORE = SAMPLE_RATE;
const AFTER = Math.round(0.2 * SAMPLE_RATE);
const FADE = Math.round(0.005 * SAMPLE_RATE);

const [input, output, model, threads] = process.argv.slice(2);
try {
  const require = createRequire(import.meta.url);
  const { OfflineSpeechDenoiser } = require("sherpa-onnx-node");
  const info = readWavInfo(input);
  if (info.sampleRate !== SAMPLE_RATE || info.channels !== 1) throw new Error("DPDFNet needs 48 kHz mono sound.");
  const denoiser = new OfflineSpeechDenoiser({
    model: { dpdfnet: { model }, numThreads: Math.max(1, Number(threads) || 1), debug: false },
  });
  const inFile = openSync(input, "r");
  const outFile = openSync(output, "w");
  try {
    writeSamples(outFile, new Uint8Array(floatWavHeader(info.frames, SAMPLE_RATE)));
    let held = null; // the last FADE samples of the previous piece, waiting to be cross-faded
    for (let start = 0; start < info.frames; start += PIECE) {
      const end = Math.min(info.frames, start + PIECE);
      const from = Math.max(0, start - BEFORE);
      const to = Math.min(info.frames, end + AFTER);
      const cleaned = denoiser.run({ samples: readSamples(inFile, info, from, to - from), sampleRate: SAMPLE_RATE,
        enableExternalBuffer: false }).samples;
      // This piece's share starts FADE samples early (except the first) to overlap the last one.
      const keepFrom = held ? start - FADE : start;
      const piece = Float32Array.from(cleaned.subarray(keepFrom - from, end - from));
      if (held) {
        for (let i = 0; i < FADE; i += 1) {
          const fadeIn = (i + 0.5) / FADE;
          piece[i] = held[i] * (1 - fadeIn) + piece[i] * fadeIn;
        }
      }
      const last = end === info.frames;
      writeSamples(outFile, last ? piece : piece.subarray(0, piece.length - FADE));
      held = last ? null : piece.slice(piece.length - FADE);
      process.stdout.write(`progress ${(end / info.frames).toFixed(4)}\n`);
    }
  } finally {
    closeSync(inFile);
    closeSync(outFile);
  }
  process.stdout.write("done\n");
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
}
