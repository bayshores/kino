// The dashboard's playback clock (frontend/dashboard/playbackClock.js) with a made-up computer clock and
// a made-up sound card, so every time is exact: play, pause, seek, loop, the sound taking over the
// clock, a blocked sound, and a scene without sound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlaybackClock, createTimeStore, frameStart } from "./dashboard/playbackClock.js";
import { previewPick, readyRuns } from "./dashboard/previewPick.js";

// A sound card whose time moves only when the test says so. `latency` is how long a sample takes
// to reach the speakers.
function fakeAudio({ state = "running", latency = 0, allowResume = true } = {}) {
  const listeners = [];
  const sources = [];
  const context = {
    state, currentTime: 0, outputLatency: latency, destination: {},
    addEventListener: (name, listener) => listeners.push(listener),
    resume() {
      if (!allowResume) return new Promise(() => {});
      context.setState("running");
      return Promise.resolve();
    },
    setState(next) { context.state = next; for (const listener of listeners) listener(); },
    createBufferSource() {
      const source = { started: null, stopped: false, connect() {}, disconnect() {}, start(when, offset) { source.started = { when, offset }; }, stop() { source.stopped = true; } };
      sources.push(source);
      return source;
    },
    close: () => Promise.resolve(),
  };
  return { context, sources };
}

function setup(options) {
  let wall = 100;
  const audio = fakeAudio(options);
  const timers = [];
  const clock = createPlaybackClock({ now: () => wall, makeContext: () => audio.context, setTimer: (callback, ms) => timers.push({ callback, ms }) });
  const pass = (seconds) => { wall += seconds; audio.context.currentTime += seconds; };
  return { clock, audio, pass, timers, wallOnly: (seconds) => { wall += seconds; } };
}

const sound = { duration: 4, length: 4 * 48000, numberOfChannels: 2, sampleRate: 48000 };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("without sound the clock follows the computer's clock, pauses, seeks and loops", () => {
  const { clock, wallOnly } = setup();
  clock.setDuration(3);
  assert.equal(clock.soundState(), "none");
  clock.play(0.5);
  wallOnly(1.25);
  close(clock.time(), 1.75);
  wallOnly(1.5);
  close(clock.time(), 0.25); // 3.25 s goes round to 0.25 s
  close(clock.pause(), 0.25);
  wallOnly(2);
  close(clock.time(), 0.25);
  clock.seek(2.5);
  close(clock.time(), 2.5);
  clock.play();
  wallOnly(0.25);
  close(clock.time(), 2.75);
  clock.seek(1);
  wallOnly(0.5);
  close(clock.time(), 1.5);
});

test("with sound the time comes from the sound card, after the sound reaches the speakers", () => {
  const { clock, audio, pass, wallOnly } = setup({ latency: 0.02 });
  clock.setDuration(4);
  clock.setSound(sound);
  clock.play(1);
  assert.equal(clock.soundState(), "on");
  const [source] = audio.sources;
  assert.deepEqual(source.started, { when: 0, offset: 1 });
  assert.equal(source.loop, true);
  assert.equal(source.loopEnd, 4, "the sound loops at the scene's end, with the picture");
  // Until the first sound is heard, the picture waits at 1 s rather than run ahead of it.
  pass(0.01);
  close(clock.time(), 1);
  pass(0.51);
  close(clock.time(), 1.5);
  // The computer's clock running fast does not move the picture: the sound card leads.
  wallOnly(5);
  close(clock.time(), 1.5);
  pass(3);
  close(clock.time(), 0.5);
  close(clock.pause(), 0.5);
  assert.equal(source.stopped, true);
  assert.equal(clock.soundState(), "ready");
});

test("seeking while playing starts the sound again at the new time", () => {
  const { clock, audio, pass } = setup();
  clock.setDuration(4);
  clock.setSound(sound);
  clock.play(0);
  pass(1);
  clock.seek(3);
  assert.equal(audio.sources[0].stopped, true);
  assert.equal(audio.sources[1].started.offset, 3);
  pass(0.5);
  close(clock.time(), 3.5);
});

test("a new mix during playback takes over at the same moment, and the time never steps back", () => {
  const { clock, audio, pass } = setup({ latency: 0.05 });
  clock.setDuration(4);
  clock.play(0);
  // No sound yet: the computer's clock.
  pass(1);
  close(clock.time(), 1);
  clock.setSound(sound);
  assert.equal(audio.sources.length, 1);
  close(audio.sources[0].started.offset, 1);
  // The new sound is not heard for 50 ms: the picture holds at 1 s, then moves on with it.
  pass(0.03);
  close(clock.time(), 1);
  pass(0.07);
  close(clock.time(), 1.05);
  const edited = { ...sound };
  clock.setSound(edited);
  assert.equal(audio.sources[0].stopped, true);
  close(audio.sources[1].started.offset, 1.05);
  pass(0.02);
  close(clock.time(), 1.05);
  // The scene's sound is removed: back to the computer's clock from where it was.
  clock.setSound(null);
  pass(0.5);
  close(clock.time(), 1.55);
});

test("a blocked sound is reported, play goes on by the computer's clock, and the sound joins when allowed", async () => {
  const { clock, audio, pass, timers, wallOnly } = setup({ state: "suspended", allowResume: false });
  clock.setDuration(4);
  clock.setSound(sound);
  clock.play(0);
  assert.equal(clock.soundState(), "starting");
  for (const timer of timers) timer.callback();
  assert.equal(clock.soundState(), "blocked");
  wallOnly(1);
  close(clock.time(), 1);
  assert.equal(audio.sources.length, 0, "no sound was started on a stopped sound card");
  audio.context.setState("running");
  assert.equal(clock.soundState(), "on");
  close(audio.sources[0].started.offset, 1);
  pass(0.5);
  close(clock.time(), 1.5);
});

test("a shorter scene keeps the time when it can and the sound loops at the new end", () => {
  const { clock, audio, pass } = setup();
  clock.setDuration(4);
  clock.setSound(sound);
  clock.play(2.5);
  pass(0.5);
  clock.setDuration(3.5);
  close(clock.time(), 3);
  assert.equal(audio.sources.at(-1).loopEnd, 3.5);
  clock.setDuration(2);
  close(clock.time(), 0);
});

test("the time store tells only on a change, and frames start on the fps grid", () => {
  const store = createTimeStore(0);
  let calls = 0;
  const stop = store.subscribe(() => { calls += 1; });
  store.set(0);
  store.set(0.5);
  store.set(0.5);
  assert.equal(calls, 1);
  stop();
  store.set(1);
  assert.equal(calls, 1);
  assert.equal(frameStart(1.999, 30), 59 / 30);
  assert.equal(frameStart(2, 30), 2);
  assert.equal(frameStart(1 / 30, 30), 1 / 30, "a time on a frame is that frame, despite rounding");
});

test("the stage plays a ready preview segment, preloads the next and hands back to live at its end", () => {
  const segment = (index, ready) => ({ index, start: index * 2, end: index * 2 + 2, key: `k${index}`, ready, ...(ready ? { url: `/k${index}.mp4` } : {}) });
  const list = { on: true, rev: 7, fps: 30, projectId: "p", sceneId: "s", segments: [segment(0, true), segment(1, true), segment(2, false), segment(3, true)] };
  const at = (time, more = {}) => previewPick(list, { projectId: "p", sceneId: "s", rev: 7, time, ...more });
  const keys = (pick) => [pick.show?.key ?? null, pick.preload?.key ?? null, pick.liveAt];
  // The last frame of segment 0 is still segment 0; live takes over at the end of the ready run.
  assert.deepEqual(keys(at(59 / 30)), ["k0", "k1", 4]);
  assert.deepEqual(keys(at(60 / 30)), ["k1", null, 4]);
  assert.deepEqual(keys(at(4)), [null, "k3", null]);
  // The scene loops: after the last segment comes the first.
  assert.deepEqual(keys(at(7.5)), ["k3", "k0", 8]);
  // Never another revision, scene or project.
  for (const other of [{ rev: 8 }, { sceneId: "t" }, { projectId: "q" }]) assert.deepEqual(keys(at(1, other)), [null, null, null]);
  // The timeline's line: runs of ready segments joined, for this revision only.
  assert.deepEqual(readyRuns(list, { projectId: "p", sceneId: "s", rev: 7 }), [[0, 4], [6, 8]]);
  assert.deepEqual(readyRuns(list, { projectId: "p", sceneId: "s", rev: 8 }), []);
});

test("the play/pause key: a silent track plays while the stage plays, and the key calls play or pause", async () => {
  const { createMediaKeys, silentWav } = await import("./dashboard/mediaKeys.js");
  const wav = silentWav(6, 8000);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(wav.length, 44 + 48000);
  assert.ok(wav.slice(44).every((byte) => byte === 128), "every sample is silence");
  const handlers = {};
  const session = { setActionHandler: (action, run) => { handlers[action] = run; }, playbackState: "none" };
  const audio = { plays: 0, pauses: 0, play() { this.plays += 1; return Promise.resolve(); }, pause() { this.pauses += 1; } };
  const calls = [];
  const keys = createMediaKeys({ session, makeAudio: () => audio, onPlay: () => calls.push("play"), onPause: () => calls.push("pause") });
  keys.set(true, "Scene 1");
  assert.equal(session.playbackState, "playing");
  assert.equal(audio.plays, 1);
  assert.ok(audio.loop);
  handlers.pause();
  handlers.play();
  assert.deepEqual(calls, ["pause", "play"]);
  keys.set(false);
  assert.equal(session.playbackState, "paused");
  assert.equal(audio.pauses, 1);
  keys.close();
  assert.equal(handlers.play, null);
});
