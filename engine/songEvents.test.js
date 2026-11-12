// Song events (engine/songEvents.js): cuts moved onto a generated click track's strong onsets, the
// hits named around the end with the call that ends on one, and the song's out and quiet time.
import test from "node:test";
import assert from "node:assert/strict";
import { cutsIn, endOnHitOps, hitsAround, hitsText, holdsText, moveCutsToEvents, ringingHit, snapText } from "./songEvents.js";
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
  // b's cut-out copy, a part of a made move, carries a noise warp whose own "speed" field is not a
  // clip Speed animation, and a second rise chained after its first.
  const copy = { ...shot("b", 1.1, 2.1), id: "b-cut", name: "b-cut", cutoutOf: "b", move: { name: "energy-aura", part: "tongue-1" },
    animations: [{ id: "warp", kind: "effect", effect: "noise-warp", start: 1.1, duration: 0.5, to: { amount: 40, speed: 2 } }, { id: "rise-2", kind: "custom", start: 1.4, duration: 0.3, to: { y: -10 } }] };
  const scene = { id: "s1", duration: 6, layers: [shot("a", 0, 1.1), shot("b", 1.1, 2.1), copy, shot("c", 2.1, 3.1, { volume: 1 }), shot("d", 3.1, 4.1), shot("e", 4.1, 6)] };
  scene.layers[3].animations.push(line, lineDown);
  assert.deepEqual(cutsIn(scene, 1, 4.2), [1.1, 2.1, 3.1, 4.1]);
  const result = moveCutsToEvents(scene, { from: 1, to: 4.2, grid: clicks(6) });
  assert.equal(result.reach, 0.5);
  assert.match(result.reachFrom, /half the median shot \(1 s\)/);
  // 1.1 has no strong onset within 0.5 s, so the beat at 1 (a bar line? no: beat 2 is soft) takes it.
  assert.deepEqual(result.moved.map((entry) => [entry.from, entry.to, entry.event]), [[1.1, 1, "beat"], [2.1, 2, "onset on the bar line 1"], [4.1, 4, "onset on the bar line 1"]]);
  assert.deepEqual(result.stayed.map((entry) => entry.at), [3.1]);
  assert.match(result.stayed[0].why, /kept line on c \(2\.5-3\.1 s\)/);
  // The shot after a cut starts at the new time from the matching file second; the shot before ends there.
  const [a, b, bCut, , d, e] = scene.layers;
  assert.deepEqual([a.mediaDuration, a.animations[1].start], [1, 1]);
  assert.deepEqual([b.mediaStart, b.mediaOffset, b.mediaDuration, b.animations[0].start], [1, 4.9, 1, 1]);
  // The copy keeps its clip's file time; its own motion moves whole (the chained rise too).
  assert.deepEqual([bCut.mediaStart, bCut.mediaOffset, bCut.mediaDuration, bCut.animations[0].start, bCut.animations[1].start], [1, 4.9, 1, 1, 1.3]);
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
  // A song ducked to 0.4 before the hit rings from 0.4 (no jump up at the ring).
  const ducked = { ...song, animations: [{ id: "duck", kind: "custom", easing: "linear", start: 10, duration: 0.5, from: { volume: 1 }, to: { volume: 0.4 } }, song.animations[0]] };
  assert.deepEqual(endOnHitOps({ scene: { id: "s1", duration: 13.6 }, song: ducked, hit: hits[1] }).ops[2].animation.from, { volume: 0.4 });
  // Once it rings from that hit to the end, there is nothing to send.
  const ringing = { ...song, animations: [{ id: "r", ...early.ops[2].animation }] };
  assert.deepEqual(endOnHitOps({ scene: { id: "s1", duration: 13.2 }, song: ringing, hit: hits[1] }).ops, []);
  // Ending on 14, after the end: the scene and the song's Play grow to 14.3 (the shortest ring).
  const late = endOnHitOps({ scene: { id: "s1", duration: 13.6 }, song, hit: hits[0] });
  assert.equal(late.end, 14.3);
  assert.deepEqual(late.ops.slice(0, 2), [{ op: "update_scene", sceneId: "s1", properties: { duration: 14.3 } }, { op: "update_layer", layer: "song", properties: { mediaDuration: 14.3 } }]);
  // The last shot plays on to the new end (its Play and Hide), so no bare frames follow it.
  const lastShot = endOnHitOps({ scene: { id: "s1", duration: 13.6, layers: [song, shot("last", 12, 13.6)] }, song, hit: hits[0] });
  assert.deepEqual(lastShot.ops.slice(2, 4), [{ op: "update_layer", layer: "last", properties: { mediaDuration: 2.3 } }, { op: "update_animation", animation: "last-hide", properties: { start: 14.3 } }]);
  assert.equal(holdsText(lastShot.holds), " (last plays on in its file 6.6-7.3 s, no shot change saved there)");
  // Its fade to silence at the old end goes (the song would be out before the hit).
  assert.ok(late.ops.some((op) => op.op === "delete_animation" && op.animation === "fade"));
  // With its file's next shot change 0.2 s on (file 6.8 s), it plays to just before it and holds that frame.
  const held = endOnHitOps({ scene: { id: "s1", duration: 13.6, layers: [song, shot("last", 12, 13.6, { mediaFreeze: "none" })] }, song, hit: hits[0], seams: new Map([["last", [2, 6.8]]]) });
  assert.deepEqual(held.ops[2].properties, { mediaDuration: 1.766, mediaFreeze: "both" });
  assert.equal(holdsText(held.holds), " (last plays to its file's next shot change (its saved shots) at 13.77 s, then holds that frame)");
  // Once the song rings from one of the hits to the end, ringingHit names it.
  const rung = { ...song, animations: [{ id: "r", ...late.ops.find((op) => op.op === "add_animation").animation }] };
  assert.equal(ringingHit(rung, hits, 14.3)?.at, 14);
  // Out 0-4 s (it starts at 4 s), under half 4-6 s, while a clip plays its own sound 1-5 s.
  const quietSong = { ...song, mediaStart: 4, mediaDuration: 6, animations: [{ id: "q", kind: "custom", easing: "linear", start: 4, duration: 0.01, from: { volume: 0.3 }, to: { volume: 0.3 } }, { id: "u", kind: "custom", easing: "linear", start: 6, duration: 0.01, from: { volume: 0.3 }, to: { volume: 1 } }] };
  const clip = shot("talk", 1, 5, { volume: 1 });
  const presence = songPresence(quietSong, { duration: 10, layers: [quietSong, clip] });
  assert.deepEqual([presence.out, presence.quiet, presence.others], [4, 2, ["talk"]]);
  assert.equal(presenceText("song", presence), "song: out 4 s (40%), heard under half its own volume 2 s (20%) of the 10 s runtime; own sound then: talk");
});
