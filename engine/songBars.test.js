// Bar lines from measured beats (songBars.js): they follow a drifting tempo, reach time 0 and the
// song's end, and the downbeat is voted by the drops. Made-up beat analyses, no sound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { barGrid } from "./fitMusic.js";
import { barIndexAt, barLines, barOf, downbeatPhase } from "./songBars.js";

// 100 beats whose gap grows 0.4 ms each beat (a tempo that drifts), the first at 0.2 s.
const beats = Array.from({ length: 100 }, (_, i) => 0.2 + 0.5 * i + 0.0002 * i * i);
const analysis = { beats, period: 0.5, bpm: 120, duration: 60 };

test("bar lines: every 4th measured beat (a drifting tempo is followed), carried back to 0 and on to the end", () => {
  const { lines, bar, beat } = barLines(analysis);
  assert.deepEqual(lines.slice(0, 3), [0.2, beats[4], beats[8]].map((time) => Math.round(time * 1000) / 1000), "the measured beats, not a constant grid");
  assert.ok(lines[20] - (0.2 + 20 * 4 * 0.5) > 0.1, "the drift is in the lines: a constant grid would be 0.1 s early");
  assert.ok(bar > 2 && bar < 2.1 && beat > 0.5 && beat < 0.55);
  assert.ok(lines.at(-1) < 60 && lines.at(-1) + 2 >= 60, "a line in the last bar of the song");
  // A first measured line 1.6 s in is carried back one bar, to before 0; one within half a beat of 0 is not.
  const late = barLines({ ...analysis, beats: beats.map((time) => time + 1.4) });
  assert.ok(late.lines[0] < 0 && late.lines[1] === 1.6, JSON.stringify(late.lines.slice(0, 3)));
  assert.equal(lines[0], 0.2);
  assert.equal(barLines({ beats: [1, 2] }), null);
});

test("bar index: the nearest line, and the bar that holds a time", () => {
  const lines = [0, 2, 4, 6];
  assert.deepEqual([barIndexAt(lines, 2.9), barIndexAt(lines, 3.1), barIndexAt(lines, -5), barIndexAt(lines, 99)], [1, 2, 0, 3]);
  assert.deepEqual([barOf(lines, 2.9), barOf(lines, 4), barOf(lines, -1), barOf(lines, 99)], [1, 2, 0, 3]);
});

test("downbeat: the drops vote on the beat of 4, one drop off its bar line is outvoted, and barGrid agrees", () => {
  // Drops on beat 0 of 4 (three times, 0.9 weight) and one on beat 1 (0.3): phase 0.
  const drops = [beats[8], beats[40], beats[64], beats[81]].map((at, index) => ({ at, kind: "drop", weight: index === 3 ? 0.3 : 0.9 }));
  assert.equal(downbeatPhase(analysis, drops), 0);
  assert.equal(downbeatPhase(analysis, [{ at: beats[41], kind: "drop", weight: 1 }]), 1);
  assert.equal(barLines(analysis, [{ at: beats[41], kind: "drop", weight: 1 }]).downbeat, Math.round(beats[1] * 1000) / 1000);
  assert.equal(barGrid(analysis, [{ at: beats[41], kind: "drop" }]).downbeat, beats[41], "the beat of that phase nearest the drop");
  assert.equal(barGrid(analysis).downbeat, beats[0], "no drop and no onsets: the first beat");
});
