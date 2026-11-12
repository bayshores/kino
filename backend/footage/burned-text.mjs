// Burned-in text on any video clip (a site name in a corner, a source's own subtitles): its frames
// are read with Apple Vision's text reader (backend/measure/kino-measure.swift, a Mac only) and
// sorted by engine/footage/burned.js burnedTextFacts. The answer is kept on the clip's media record
// as burnedText (backend/index.mjs videoFactsOf), read by check (burned_text) and look source.
//
// Size: a 1080p clip read at 480 px wide (the footage measure's size) gave no line where Vision
// read the same frame's site name at 960 and 1280 px (measured 2026-11-12 on a found clip, the
// name 1 to 4% down): frames are read READ_WIDTH wide.
import { spawn } from "node:child_process";
import { burnedTextFacts } from "../../engine/footage/burned.js";
import { ffmpegCommand } from "../media-probe.mjs";
import { helperSession, measureAbilities } from "../measure/measure.mjs";
import { heavyDecodeSlot } from "../process-slots.mjs";
import { endWithService } from "../child-exit.mjs";

export const BURNED_TEXT_VERSION = 1;
/** The width frames are read at (pixels): see the note above. */
export const READ_WIDTH = 960;
/** Seconds between frames read (a guess: a subtitle shown for 0.3 s is still read), ... */
export const READ_STEP = 0.25;
/** ... and at most this many frames a clip (a long clip is read at an even step instead). */
export const READ_MOST = 48;
/** What the record keeps on a computer with no text reader. */
export const NOT_READ = "not read on this system (Apple Vision's text reader is on a Mac only)";
const TEXT_JOB = 2;

/** The step (seconds) a clip of `duration` seconds is read at. */
export function readStep(duration) {
  return Math.max(READ_STEP, (Number(duration) || 0) / READ_MOST);
}

// The BGRA frames one FFmpeg run gives (`input` then the filter), each sent to the helper session;
// with lastOnly, only the run's last frame is sent.
async function decodeInto(session, input, filter, size, most, lastOnly = false) {
  const frameBytes = size.width * size.height * 4;
  const decode = spawn(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-threads", "2", ...input, "-map", "0:V:0", "-an", "-sn", "-dn",
    "-vf", `${filter}scale=${size.width}:${size.height}:flags=area,format=bgra`, "-frames:v", String(most), "-f", "rawvideo", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  endWithService(decode);
  let count = 0, current = Buffer.alloc(frameBytes), filled = 0, last = null;
  for await (const chunk of decode.stdout) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(frameBytes - filled, chunk.length - offset);
      chunk.copy(current, filled, offset, offset + take);
      filled += take; offset += take;
      if (filled < frameBytes) continue;
      if (lastOnly) last = current;
      else { await session.send(TEXT_JOB, current); count += 1; }
      current = Buffer.alloc(frameBytes); filled = 0;
    }
  }
  if (last) { await session.send(TEXT_JOB, last); count = 1; }
  return count;
}

/**
 * Reads the frames of a video every `step` seconds at READ_WIDTH, and its last frame (a found clip
 * cut as the next line starts shows that line's subtitle only there: measured on a 1.19 s clip whose
 * burned-in subtitle came on after 1.1 s): [{t, lines: [{box, s, c}]}], or null when this computer
 * has no text reader.
 */
async function visionFrames(file, { width, height, duration, step, signal }) {
  const abilities = await measureAbilities();
  if (abilities.text !== true) return null;
  const wide = Math.min(READ_WIDTH, width);
  const size = { width: 2 * Math.round(wide / 2), height: Math.max(16, 2 * Math.round((wide * height) / width / 2)) };
  return heavyDecodeSlot(async () => {
    const session = helperSession(abilities.helper, { ...size, signal });
    const count = await decodeInto(session, ["-i", file], `fps=1/${step},`, size, READ_MOST + 1);
    const last = duration > step ? await decodeInto(session, ["-sseof", "-0.25", "-i", file], "", size, 30, true) : 0;
    const { answers, error } = await session.finish();
    if (error) throw new Error(error);
    const linesOf = (index) => (Array.isArray(answers[index]?.text) ? answers[index].text.filter((line) => !(line.c < 0.3)) : []);
    const frames = Array.from({ length: count }, (_, index) => ({ t: index * step, lines: linesOf(index) }));
    if (last) frames.push({ t: Math.max(0, duration - 0.05), lines: linesOf(count) });
    return frames;
  });
}

/**
 * The burned-in text of a video file: {version, read, step, marks, subtitles} (burnedTextFacts),
 * or {version, unread} on a computer with no text reader. info: {width, height, duration} from the
 * media record. readFrames(file, {width, height, duration, step, signal}) is injected in tests (the
 * reader stubbed): it answers [{t, lines}] (file seconds), or null when nothing can read text here.
 */
export async function readBurnedText(file, { width, height, duration, signal } = {}, { readFrames = visionFrames } = {}) {
  if (!(width > 0 && height > 0)) return { version: BURNED_TEXT_VERSION, unread: "no picture size" };
  const step = readStep(duration);
  const frames = await readFrames(file, { width, height, duration, step, signal });
  if (!Array.isArray(frames)) return { version: BURNED_TEXT_VERSION, unread: NOT_READ };
  const facts = burnedTextFacts(frames.map((frame) => ({ t: Math.round(frame.t * 1000) / 1000, lines: frame.lines })));
  return { version: BURNED_TEXT_VERSION, step: Math.round(step * 1000) / 1000, ...facts };
}

const percent = (value) => Math.round(value * 100);
const spanOf = ([x, y, w, h]) => `${percent(x)}-${percent(x + w)}% across, ${percent(y)}-${percent(y + h)}% down`;

/**
 * One line for the import answer and look source: "burned-in text (read at 960 px, 5 frames): a mark
 * top-left "site" (1-9% across, 1-4% down) on 4 of 5 frames · a subtitle 1.0-1.15 s "words" (40-60%
 * across, 88-93% down)", "burned-in text: none (5 frames read)", or the unread reason once.
 */
export function burnedTextLine(burned) {
  if (!burned) return null;
  if (burned.unread) return `burned-in text: ${burned.unread}.`;
  const marks = (burned.marks ?? []).map((mark) => `a mark ${mark.where} "${mark.words}" (${spanOf(mark.box)}) on ${mark.frames} of ${burned.read} frames`);
  const subs = (burned.subtitles ?? []).slice(0, 4).map((sub) => `a subtitle ${sub.from === sub.to ? sub.from : `${sub.from}-${sub.to}`} s "${sub.words}" (${spanOf(sub.box)})`);
  const more = (burned.subtitles?.length ?? 0) > 4 ? ` (+${burned.subtitles.length - 4} more subtitles)` : "";
  const found = [...marks, ...subs];
  return found.length ? `burned-in text (file s, read every ${burned.step} s at ${READ_WIDTH} px): ${found.join(" · ")}${more}.` : `burned-in text: none (${burned.read} frames read).`;
}
