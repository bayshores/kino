// The mix readout (engine/mixReadout.js): the mix around a song cue, the song's ending and its
// time under half volume, from generated 0.1 s readings and a generated beat grid.
import test from "node:test";
import assert from "node:assert/strict";
import { cueRise, cueRiseText, endingText, keptLinesOf, quietShare, quietText, songEnding, volumeFall } from "./mixReadout.js";

// 0.1 s readings: momentary `m` from level(t), peak -20 dBFS while the mix is heard, then silent.
const readings = (seconds, level, heardUntil = seconds) => Array.from({ length: Math.round(seconds * 10) }, (_, index) => {
  const t = Math.round(index) / 10;
  return { t, m: level(t), peak: t < heardUntil - 1e-6 ? -20 : -Infinity };
});
const song = (animations = [], props = {}) => ({ type: "audio", id: "song", name: "song", src: "/api/media/song.wav", mediaStart: 0, mediaOffset: 0, mediaDuration: 6, volume: 1,
  animations: animations.map((animation, index) => ({ id: `a${index}`, kind: "custom", easing: "linear", ...animation })), ...props });

test("a cue's rise: the mix over the 1 s before and after, and the loudest kept line before it", () => {
  // -18 LUFS before the drop at 3 s, -10 after; a line 1.5-2.8 s reads -12 over its part.
  const windows = readings(6, (t) => (t >= 3 ? -10 : t >= 1.5 && t < 2.8 ? -12 : -18));
  const rise = cueRise(windows, { at: 3, kind: "drop" }, [{ name: "vo", start: 1.5, end: 2.8 }, { name: "old", start: 0, end: 0.5 }]);
  assert.equal(rise.after, -10);
  assert.ok(rise.before > -18 && rise.before < -12, `before ${rise.before}`);
  assert.equal(rise.line.name, "vo");
  assert.equal(rise.line.lufs, -12);
  assert.equal(rise.line.over, 2);
  assert.match(cueRiseText(rise), /^drop at 3 s: the mix -13 LUFS in the 1 s before, -10 LUFS in the 1 s after \(\+3 LU\); loudest kept line in the 2 s before: vo 1\.5-2\.8 s at -12 LUFS, the 1 s after sits \+2 LU over it$/);
  // A near-silent hole before the drop reads silent, with no rise.
  const hole = cueRise(readings(6, (t) => (t >= 3 ? -10 : t >= 2 ? -70 : -18)), { at: 3, kind: "drop" });
  assert.deepEqual([hole.before, hole.rise, hole.line], [null, null, null]);
  // Kept lines are read off keep_line's Line up/Line down marks, inside the layer's Play range.
  const clip = song([{ name: "Line up", start: 1.4, duration: 0.1, from: { volume: 0.2 }, to: { volume: 1 } }, { name: "Line down", start: 2.8, duration: 0.1, from: { volume: 1 }, to: { volume: 0.2 } }], { id: "vo", name: "vo" });
  assert.deepEqual(keptLinesOf({ duration: 6, layers: [clip] }), [{ name: "vo", start: 1.5, end: 2.8 }]);
});

test("a rise that comes from a dip names the dip and reads small against the loudest reading before", () => {
  // Shaped like dm5-a: the mix -10 most of the second before the drop at 8.5 s, one 0.3 s hole at
  // -18 just before it, -9.5 after; the song dips to 0 under a kept line 5.3-7.9 and comes up at 8.7.
  const windows = readings(10, (t) => (t >= 8.5 ? -9.5 : t >= 8.0 && t < 8.3 ? -18 : -10));
  const layer = song([{ start: 5.25, duration: 0.05, from: { volume: 1 }, to: { volume: 0 } }, { start: 8.65, duration: 0.05, from: { volume: 0 }, to: { volume: 1 } }], { mediaDuration: 10 });
  const rise = cueRise(windows, { at: 8.5, kind: "drop" }, [{ name: "line3", start: 5.3, end: 7.9 }], { song: layer });
  assert.ok(rise.rise > 1.5, `the energy mean holds the hole: ${rise.rise}`);
  assert.deepEqual(rise.peak, { end: 7.9, lufs: -10, over: 0.5 });
  assert.deepEqual(rise.dips.map((dip) => [dip.from, dip.to, dip.low, dip.line.name]), [[5.29, 8.67, 0, "line3"]]);
  assert.match(cueRiseText(rise), /its loudest 0\.4 s reading in the 1 s before: -10 LUFS ending 7\.9 s, the 1 s after sits \+0\.5 LU over it; the 1 s before holds song's dip 5\.29-8\.67 s \(x0 of its level after, under line3 5\.3-7\.9 s\)$/);
  // A song that plays on through the second before holds no dip.
  assert.deepEqual(cueRise(windows, { at: 8.5, kind: "drop" }, [], { song: song([], { mediaDuration: 10 }) }).dips, []);
});

test("the ending: a hard stop on an onset, a fade across a bar line, a tail, and the picture after the sound", () => {
  const grid = { onsets: [5.45], beats: Array.from({ length: 25 }, (_, index) => index * 0.25) };
  // A 0.03 s stop at 5.5 s, 0.05 s after the onset; the mix is heard to 5.6 s, the picture runs to 6.5 s.
  const stop = songEnding({ layer: song([{ start: 5.5, duration: 0.03, from: { volume: 1 }, to: { volume: 0 } }]), duration: 6.5, windows: readings(6.5, () => -14, 5.6), grid, fileSeconds: 30 });
  assert.deepEqual([stop.kind, stop.at, stop.length, stop.onset, stop.soundEnd, stop.after], ["stop", 5.5, 0.03, 5.45, 5.6, 0.9]);
  assert.equal(endingText("song", stop), "ending: song stops hard at 5.5 s (0.03 s), 0.05 s after its onset at 5.45 s; the mix's sound ends at 5.6 s, the picture runs 0.9 s past it");
  // The same stop with no onset near it names the last one before.
  const off = songEnding({ layer: song([{ start: 5.5, duration: 0.03, from: { volume: 1 }, to: { volume: 0 } }]), duration: 6, grid: { onsets: [5.1], beats: [] }, fileSeconds: 30 });
  assert.match(endingText("song", off), /stops hard at 5\.5 s \(0\.03 s\), not on an onset \(the last before it at 5\.1 s\)/);
  // A 0.8 s fade 4.8-5.6 s crosses the bar line at 5 s (every 4 beats of 0.25 s); with no grid it says so.
  const fade = songEnding({ layer: song([{ start: 4.8, duration: 0.8, from: { volume: 1 }, to: { volume: 0 } }]), duration: 6, grid, fileSeconds: 30 });
  assert.deepEqual([fade.kind, fade.at, fade.to, fade.length, fade.crosses], ["fade", 4.8, 5.6, 0.8, [{ at: 5, kind: "bar" }]]);
  assert.match(endingText("song", songEnding({ layer: song([{ start: 4.8, duration: 0.8, from: { volume: 1 }, to: { volume: 0 } }]), duration: 6 })), /fades 0\.8 s from 4\.8 to 5\.6 s \(no beat grid saved\)/);
  assert.match(endingText("song", fade), /crossing the bar line at 5 s \(a guess: every 4 beats from the first tracked beat/);
  // The song's measured bar lines win over the beat guess, and say so.
  const measured = songEnding({ layer: song([{ start: 4.8, duration: 0.8, from: { volume: 1 }, to: { volume: 0 } }]), duration: 6, grid: { ...grid, bars: [{ at: 4.4, kind: "bar" }, { at: 5.3, kind: "phrase" }] }, fileSeconds: 30 });
  assert.match(endingText("song", measured), /crossing the phrase line at 5\.3 s \(the song's measured bar lines\)/);
  // Played to the file's own end: a tail. Still up when the picture ends: up.
  assert.equal(songEnding({ layer: song([], { mediaDuration: 4, mediaOffset: 26 }), duration: 6, fileSeconds: 30 }).kind, "tail");
  assert.equal(songEnding({ layer: song(), duration: 6, fileSeconds: 30 }).kind, "up");
  assert.equal(volumeFall(song(), 6), null);
});

test("the song's time under half its own volume is printed over 40% with the call that shows the ways", () => {
  // Ducked to 0.3 from 1 s to 4.5 s of 6 s: under 0.5 from 1.036 to 4.464 s (linear ramps).
  const ducked = song([{ start: 1, duration: 0.05, from: { volume: 1 }, to: { volume: 0.3 } }, { start: 4.45, duration: 0.05, from: { volume: 0.3 }, to: { volume: 1 } }]);
  const quiet = quietShare(ducked, 6);
  assert.deepEqual([quiet.heard, quiet.quiet], [6, 3.4]);
  assert.equal(quietText("song", quiet, "edit {dry_run:true, ...}"), "song plays under half its own volume for 3.4 of its 6 s heard (57%); edit {dry_run:true, ...} prints the ways to keep it up under a line");
  assert.equal(quietText("song", quietShare(song(), 6), "x"), "");
});
