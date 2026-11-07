// Reads and writes the 32-bit float WAV files that voice isolation passes between FFmpeg, the
// isolation engines and kino. Only that one format is needed: 48 kHz, mono, IEEE float samples.
import { closeSync, openSync, readSync, writeSync } from "node:fs";

const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Finds the sample data in a WAV file. Returns { sampleRate, channels, frames, dataOffset }.
 * Throws unless the samples are 32-bit floats.
 */
export function readWavInfo(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, 12, 0) < 12 || header.toString("latin1", 0, 4) !== "RIFF" ||
        header.toString("latin1", 8, 12) !== "WAVE") throw new Error(`${path} is not a WAV file.`);
    let offset = 12;
    let format = null;
    const chunk = Buffer.alloc(8);
    for (;;) {
      if (readSync(fd, chunk, 0, 8, offset) < 8) throw new Error(`${path} has no sound data.`);
      const id = chunk.toString("latin1", 0, 4);
      const size = chunk.readUInt32LE(4);
      if (id === "fmt ") {
        const body = Buffer.alloc(Math.min(size, 40));
        readSync(fd, body, 0, body.length, offset + 8);
        let tag = body.readUInt16LE(0);
        if (tag === WAVE_FORMAT_EXTENSIBLE && body.length >= 26) tag = body.readUInt16LE(24);
        format = { tag, channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
      } else if (id === "data") {
        if (!format) throw new Error(`${path} has sound data before its format.`);
        if (format.tag !== WAVE_FORMAT_IEEE_FLOAT || format.bits !== 32)
          throw new Error(`${path} must hold 32-bit float samples (format ${format.tag}, ${format.bits} bits).`);
        // A data size of 0 or 0xFFFFFFFF means the writer could not go back and fill it in.
        return { sampleRate: format.sampleRate, channels: format.channels, dataOffset: offset + 8,
          frames: Math.floor(size / (4 * format.channels)) };
      }
      offset += 8 + size + (size % 2);
    }
  } finally {
    closeSync(fd);
  }
}

/** Reads `count` mono samples starting at sample `from` (fewer at the end of the file). */
export function readSamples(fd, info, from, count) {
  const available = Math.max(0, Math.min(count, info.frames - from));
  const bytes = Buffer.alloc(available * 4);
  let done = 0;
  while (done < bytes.length) {
    const read = readSync(fd, bytes, done, bytes.length - done, info.dataOffset + from * 4 + done);
    if (read === 0) break;
    done += read;
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(done / 4));
}

/** The 44-byte header of a mono 32-bit float WAV holding `frames` samples. */
export function floatWavHeader(frames, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + frames * 4, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(WAVE_FORMAT_IEEE_FLOAT, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(frames * 4, 40);
  return header;
}

/** Appends samples to an open file. */
export function writeSamples(fd, samples) {
  const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  let done = 0;
  while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
}
