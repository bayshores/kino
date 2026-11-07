// The low-pass filter of a sound clip whose layer has a lowpass cutoff or Lowpass animations
// (engine/lowpass.js). A steady cutoff is one FFmpeg lowpass filter. An animated one samples the
// cutoff (engine/animation.js lowpassSampler, the evaluator the preview uses too) every STEP seconds
// over the clip and writes FFmpeg commands that move the filter's frequency (asendcmd). The clip
// is cut into frames of FRAME_SAMPLES first, because asendcmd only acts at the start of a frame.
// Fully open (0) sets the filter's mix to 0, so the sound passes through untouched.
import { writeFile } from "node:fs/promises";
import { animatesLowpass, lowpassSampler } from "../engine/animation.js";

// Seconds between samples of the cutoff: 200 a second is smooth for a sweep.
const STEP = 0.005;
// Sound frames this long (5.3 ms at 48 kHz) let a command act close to its time.
const FRAME_SAMPLES = 256;
// A new command only when the cutoff moved more than this share (0.2 %, under a hundredth of an octave).
const CHANGE = 0.002;

const settings = (cutoff) => cutoff > 0 ? { f: Math.round(cutoff * 10) / 10, mix: 1 } : { f: 20_000, mix: 0 };

/**
 * The lowpass plan of `layer` for a clip that starts at scene time `start` and plays for `length`
 * seconds: null when the filter is off the whole time, { cutoff } for a steady cutoff, or
 * { cutoff, commands } when it moves (cutoff is the first value, 0 when open; commands is
 * asendcmd's text with times from the clip's start, for the filter named `lowpass@<name>`).
 * Each clip's filter needs its own `name`, as a command reaches every filter with its name.
 */
export function lowpassPlan(layer, start, length, name) {
  if (!animatesLowpass(layer)) return layer?.lowpass > 0 ? { name, cutoff: lowpassSampler(layer)(start) } : null;
  const at = lowpassSampler(layer);
  const count = Math.max(1, Math.ceil(length / STEP) + 1);
  const first = at(start);
  const lines = [];
  let last = first, heard = first > 0;
  for (let index = 1; index < count; index += 1) {
    const time = index * STEP;
    const cutoff = at(start + time);
    heard ||= cutoff > 0;
    const moved = (cutoff > 0) !== (last > 0) || (cutoff > 0 && Math.abs(cutoff - last) > CHANGE * last);
    if (!moved) continue;
    const { f, mix } = settings(cutoff);
    lines.push(`${time.toFixed(3)} lowpass@${name} f ${f}, lowpass@${name} mix ${mix};`);
    last = cutoff;
  }
  if (!heard) return null;
  return lines.length ? { name, cutoff: first, commands: `${lines.join("\n")}\n` } : { name, cutoff: first };
}

/** Writes an animated plan's commands to `path` and returns the plan with that path. */
export async function writeLowpassPlan(path, plan) {
  if (!plan?.commands) return plan;
  // The path goes into a filter graph inside single quotes.
  if (/['\\]/.test(path)) throw new Error("The lowpass command file's folder has a quote or backslash in its name.");
  await writeFile(path, plan.commands);
  return { ...plan, path };
}

/** The FFmpeg filters (to add after a clip's trim) that apply a lowpass plan, or "" for none. */
export function lowpassFilters(plan) {
  if (!plan) return "";
  const { f, mix } = settings(plan.cutoff);
  const filter = `lowpass@${plan.name}=f=${f}:mix=${mix}`;
  if (!plan.path) return `,${filter}`;
  return `,asetnsamples=n=${FRAME_SAMPLES}:p=0,asendcmd=f='${plan.path}',${filter}`;
}
