import assert from "node:assert/strict";
import { test } from "node:test";
import { cueListText, isCueTarget } from "./agent/cue-list.mjs";
import { CUT_LINES, cutListText, isCutTarget } from "./agent/cut-list.mjs";
import { estimateTextTokens } from "./meter.mjs";
import { soundLevels } from "../engine/quality/loudness.js";

// A ten-minute song at 120 bpm: 1,200 beats, and 1,000 onsets (detect_beats keeps at most that many).
function tenMinuteSong() {
  const beats = Array.from({ length: 1200 }, (_, index) => ({ name: `beat-${index + 1}`, time: Math.round((0.437 + index * 0.5) * 1000) / 1000, kind: "beat" }));
  const onsets = Array.from({ length: 1000 }, (_, index) => ({ name: `onset-${index + 1}`, time: Math.round((0.2 + index * 0.6) * 1000) / 1000, kind: "onset" }));
  const cues = [...beats, ...onsets].sort((a, b) => a.time - b.time);
  return { cues, rhythm: { bpm: 120, offset: 0.437 } };
}

test("a short cue list is listed whole, as before", () => {
  const document = { cues: [{ name: "intro", time: 0, kind: "marker" }, { name: "beat-1", time: 0.5, kind: "beat" }] };
  const { text, count, shown } = cueListText(document, ["cues"]);
  assert.equal(text, "marker 1: intro 0\nbeat 1: beat-1 0.5");
  assert.equal(count, 2);
  assert.equal(shown, 2);
});

test("a ten-minute song's cues come a page at a time, each small, until every cue is seen", () => {
  const document = tenMinuteSong();
  let target = "cues";
  const seen = new Set();
  let pages = 0;
  while (target) {
    const { text, count, shown } = cueListText(document, [target]);
    pages += 1;
    assert.ok(estimateTextTokens(text) < 5000, `page ${pages} is ${estimateTextTokens(text)} tokens`);
    if (pages === 1) {
      assert.equal(count, 2200);
      assert.match(text, /^rhythm 120 bpm, first beat at 0.437s\nbeat 1200, \d+ shown: beat-1 0.437, /);
    }
    for (const [, name] of text.matchAll(/(?:: |, )((?:beat|onset)-\d+) /g)) seen.add(name);
    const more = /more from ([\d.]+)s: inspect "(cues\[[^\]]+\])" for the next ones$/.exec(text);
    if (more) assert.ok(shown < count);
    target = more?.[2];
  }
  assert.equal(seen.size, 2200);
  assert.ok(pages >= 3 && pages <= 6, `${pages} pages`);
});

test("cues[kind=…,from=…,to=…] lists one kind in one stretch of time and keeps them in the next page's target", () => {
  const document = tenMinuteSong();
  const window = cueListText(document, ["cues[kind=beat,from=60,to=90]"]);
  assert.equal(window.count, 60);
  assert.match(window.text, /\nbeat 60: beat-121 60.437, .*, beat-180 89.937$/);
  const beats = cueListText(document, ["cues[kind=beat]"]);
  assert.match(beats.text, /more from [\d.]+s: inspect "cues\[kind=beat,from=[\d.]+\]" for the next ones$/);
  const ended = cueListText(document, ["cues[kind=onset,to=599]"]);
  assert.match(ended.text, /inspect "cues\[kind=onset,from=[\d.]+,to=599\]"/);
  assert.match(cueListText(document, ["cues[from=700]"]).text, /no cues in that time$/);
});

test("a bad cue target says how to write one", () => {
  assert.equal(isCueTarget("cues[from=1]"), true);
  assert.equal(isCueTarget("text[fontSize>40]"), false);
  const document = tenMinuteSong();
  assert.throws(() => cueListText(document, ["cues[kind=drums]"]), /kind is one of marker, beat, onset, word, line/);
  assert.throws(() => cueListText(document, ["cues[start=4]"]), /write cues\[kind=beat\], cues\[from=60,to=90\] or both/);
  assert.throws(() => cueListText(document, ["cues[from=-1]"]), /from is a time in seconds, 0 or more/);
  assert.throws(() => cueListText(document, ["cues[from=9,to=3]"]), /to must not be before from/);
});

test("cuts: each cut with its clips, the 3 words around it from whisper, mid-sentence marks and the loudness jump", () => {
  assert.equal(isCutTarget("cuts"), true);
  assert.equal(isCutTarget("cues"), false);
  // Two interview clips of one file: the first stops after "we built this" while the file goes
  // on "for you." 0.3 s later; the second starts on a new sentence.
  const words = [["So", 0], ["we", 0.4], ["built", 0.8], ["this", 1.2], ["for", 1.8], ["you.", 2.1], ["Next", 3], ["we", 3.4], ["ship.", 3.8]]
    .map(([text, start]) => ({ text, start, end: start + 0.3 }));
  const clip = (id, mediaStart, mediaOffset, mediaDuration) => ({ id, name: id, type: "video", src: "/api/media/a.mp4", mediaStart, mediaOffset, mediaDuration });
  const scene = { id: "s1", duration: 4, layers: [clip("talk-1", 0, 0, 1.5), clip("talk-2", 1.5, 2.9, 1.3), { ...clip("song", 2.8, 0, 1.2), type: "audio" }] };
  // Peaks: 100 a second; the file is loud (0 dB) until 1.6 s and quiet (-40 dB) after.
  const sound = soundLevels({ available: true, duration: 5, secondsPerPeak: 0.01, peaks: Array.from({ length: 500 }, (_, index) => (index < 160 ? 1 : 0.01)) });
  const heard = new Map([["talk-1", { words, sound }], ["talk-2", { words, sound }], ["song", { words: null, missing: "music", sound: null }]]);
  const { text, count } = cutListText(scene, heard);
  assert.equal(count, 2);
  const lines = text.split("\n");
  assert.match(lines[0], /^cuts in s1 \(4 s\): 2 · words from whisper/);
  assert.equal(lines[1], '1.5s talk-1 > talk-2 · before "…we built this" MID-SENTENCE · after "Next we ship.…" · -40 dB');
  assert.equal(lines[2], '2.8s talk-2 > song · before "…Next we ship." · after music · dB unknown');
  // Muted B-roll over a voice that keeps playing: the voice is named and its words count on both
  // sides; its loudness is not known (no saved peaks), so neither is the jump.
  const over = { id: "s3", duration: 3, layers: [clip("talk", 0, 0, 3), { ...clip("broll", 1, 0, 1), src: "/api/media/b.mp4" }] };
  const [, overIn, overOut] = cutListText(over, new Map([["talk", { words, sound: null }]])).text.split("\n");
  assert.equal(overIn, '1s nothing > broll (talk plays on) · before "…So we built" · after "this for you.…" · dB unknown');
  assert.equal(overOut, '2s broll > nothing (talk plays on) · before "…built this for" · after "you.…" · dB unknown');
  // A long video's list stops at CUT_LINES cuts and says how to ask for the rest.
  const many = { id: "s2", duration: 100, layers: Array.from({ length: 50 }, (_, index) => clip(`c${index}`, index * 2, 0, 2)) };
  const page = cutListText(many, new Map());
  assert.equal(page.shown, CUT_LINES);
  assert.match(page.text, /\n9 more from 82s: inspect "cuts\[from=82\]" for the next ones$/);
  assert.equal(cutListText(many, new Map(), { from: 82 }).shown, 9);
});
