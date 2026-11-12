// Song events (engine/songEvents.js): cuts moved onto a generated click track's strong onsets, the
// hits named around the end with the call that ends on one, and the song's out and quiet time.
import test from "node:test";
import assert from "node:assert/strict";
import { cutsIn, endOnHitOps, hitsAround, hitsText, moveCutsToEvents, snapText } from "./songEvents.js";
import { presenceText, songPresence } from "./mixReadout.js";

// A click track at 120 bpm: a beat every 0.5 s, every 4th click (a bar line) hard, the rest soft.
const clicks = (seconds) => {
  const beats = Array.from({ length: seconds * 2 }, (_, index) => index / 2);
  return { onsets: beats.map((at, index) => ({ at, weight: index % 4 === 0 ? 1 : 0.2 })).concat([{ at: 2.3, weight: 0.8 }]).sort((a, b) => a.at - b.at),
    beats, bars: beats.filter((_, index) => index % 4 === 0).map((at) => ({ at, kind: "bar" })) };
};
const shot = (id, start, end, props = {}) => ({ id, name: id, type: "video", src: `/api/media/${id}.mp4`, mediaStart: start, mediaDuration: end - start, mediaOffset: 5, mediaSourceDuration: 20, volume: 0,
  animations: [{ id: `${id}-show`, name: "Show", kind: "show", start }, { id: `${id}-hide`, name: "Hide", kind: "hide", start: end }], ...props });

test("retime snap: each cut moves to the nearest strong onset in reach, the file time kept, a kept line's cut stays", () => {
  // Cuts at 1.1, 2.1, 3.1 and 4.1 (1 s shots); strong onsets at 0, 2, 2.3, 4 (bar lines and one hit).
  // c keeps a spoken line from 2.5 s to its end at 3.1 s (keep_line's Line up and Line down marks).
  const line = { id: "c-line", name: "Line up", kind: "custom", easing: "linear", start: 2.4, duration: 0.1, from: { volume: 0.2 }, to: { volume: 1 } };
  const lineDown = { id: "c-down", name: "Line down", kind: "custom", easing: "linear", start: 3.1, duration: 0.1, from: { volume: 1 }, to: { volume: 0.2 } };
  const scene = { id: "s1", duration: 6, layers: [shot("a", 0, 1.1), shot("b", 1.1, 2.1), shot("c", 2.1, 3.1, { volume: 1 }), shot("d", 3.1, 4.1), shot("e", 4.1, 6)] };
  scene.layers[2].animations.push(line, lineDown);
  assert.deepEqual(cutsIn(scene, 1, 4.2), [1.1, 2.1, 3.1, 4.1]);
  const result = moveCutsToEvents(scene, { from: 1, to: 4.2, grid: clicks(6) });
  assert.equal(result.reach, 0.5);
  assert.match(result.reachFrom, /half the median shot \(1 s\)/);
  // 1.1 has no strong onset within 0.5 s, so the beat at 1 (a bar line? no: beat 2 is soft) takes it.
  assert.deepEqual(result.moved.map((entry) => [entry.from, entry.to, entry.event]), [[1.1, 1, "beat"], [2.1, 2, "onset on the bar line 1"], [4.1, 4, "onset on the bar line 1"]]);
  assert.deepEqual(result.stayed.map((entry) => entry.at), [3.1]);
  assert.match(result.stayed[0].why, /kept line on c \(2\.5-3\.1 s\)/);
  // The shot after a cut starts at the new time from the matching file second; the shot before ends there.
  const [a, b, , d, e] = scene.layers;
  assert.deepEqual([a.mediaDuration, a.animations[1].start], [1, 1]);
  assert.deepEqual([b.mediaStart, b.mediaOffset, b.mediaDuration, b.animations[0].start], [1, 4.9, 1, 1]);
  assert.deepEqual([d.mediaDuration, e.mediaStart, e.mediaOffset, e.animations[0].start], [0.9, 4, 4.9, 4]);
  assert.match(snapText(result), /^snap to song: 3 cuts moved, reach 0\.5 s .*1\.1→1 \(beat\), 2\.1→2 .* stayed: 3\.1 s \(it would cut the kept line on c/);
  // A clip that would play past its file's end keeps its cut.
  const short = { id: "s2", duration: 4, layers: [shot("x", 0, 1.8, { mediaSourceDuration: 6.8 }), shot("y", 1.8, 4)] };
  const kept = moveCutsToEvents(short, { from: 1, to: 3, reach: 0.3, grid: clicks(4) });
  assert.deepEqual(kept.moved, []);
  assert.match(kept.stayed[0].why, /x would play past its file's end/);
});

test("hits around the end: bar lines first with the call that rings the song out on one; the song's out and quiet time", () => {
  const grid = clicks(16);
  // Within 2 s of 13.6: the bar lines at 12 and 14 (equal weight: the nearer first); 15.7 is past what the song plays.
  const hits = hitsAround(grid, 13.6, { playsTo: 15.7 });
  assert.deepEqual(hits.map((hit) => [hit.at, hit.line]), [[14, "bar line"], [12, "bar line"]]);
  assert.equal(hitsText(hits), "nearest hits (onsets of weight 0.5+, a starting guess, within 2 s): 14 (bar line, 1, strongest in 2 s), 12 (bar line, 1, strongest in 2 s)");
  const song = { id: "song", name: "song", type: "audio", src: "/api/media/song.wav", mediaStart: 0, mediaDuration: 13.6, mediaOffset: 0, volume: 1,
    animations: [{ id: "fade", kind: "out", start: 13.35, duration: 0.25, from: { volume: 1 }, to: { volume: 0 } }] };
  // Ending on 12 inside a 13.6 s video: the hit rings to the end (1.2 s at most), the old fade goes.
  const early = endOnHitOps({ scene: { id: "s1", duration: 13.6 }, song, hit: hits[1] });
  assert.equal(early.end, 13.2);
  assert.deepEqual(early.ops.map((op) => op.op), ["update_scene", "delete_animation", "add_animation", "set_cues"]);
  assert.deepEqual(early.ops[3].cues, [{ name: "song-ring-1", time: 12 }]);
  assert.deepEqual(early.ops[2].animation, { kind: "out", name: "Ring", start: 12.04, duration: 1.16, easing: "quart-out", from: { volume: 1 }, to: { volume: 0 } });
  // Once it rings from that hit to the end, there is nothing to send.
  const ringing = { ...song, animations: [{ id: "r", ...early.ops[2].animation }] };
  assert.deepEqual(endOnHitOps({ scene: { id: "s1", duration: 13.2 }, song: ringing, hit: hits[1] }).ops, []);
  // Ending on 14, after the end: the scene and the song's Play grow to 14.3 (the shortest ring).
  const late = endOnHitOps({ scene: { id: "s1", duration: 13.6 }, song, hit: hits[0] });
  assert.equal(late.end, 14.3);
  assert.deepEqual(late.ops.slice(0, 2), [{ op: "update_scene", sceneId: "s1", properties: { duration: 14.3 } }, { op: "update_layer", layer: "song", properties: { mediaDuration: 14.3 } }]);
  // Out 0-4 s (it starts at 4 s), under half 4-6 s, while a clip plays its own sound 1-5 s.
  const quietSong = { ...song, mediaStart: 4, mediaDuration: 6, animations: [{ id: "q", kind: "custom", easing: "linear", start: 4, duration: 0.01, from: { volume: 0.3 }, to: { volume: 0.3 } }, { id: "u", kind: "custom", easing: "linear", start: 6, duration: 0.01, from: { volume: 0.3 }, to: { volume: 1 } }] };
  const clip = shot("talk", 1, 5, { volume: 1 });
  const presence = songPresence(quietSong, { duration: 10, layers: [quietSong, clip] });
  assert.deepEqual([presence.out, presence.quiet, presence.others], [4, 2, ["talk"]]);
  assert.equal(presenceText("song", presence), "song: out 4 s (40%), heard under half its own volume 2 s (20%) of the 10 s runtime; own sound then: talk");
});
