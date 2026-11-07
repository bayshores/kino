// SRT and WebVTT reading and writing (subtitles.js).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatSrt, formatVtt, parseSrt, parseSubtitles, parseTimestamp, parseVtt, subtitleFormat } from "./subtitles.js";

const sintel = readFileSync(new URL("../tests/fixtures/captions/sintel_en.srt", import.meta.url), "utf8");

test("timestamps read with comma or dot, with or without hours", () => {
  assert.equal(parseTimestamp("01:02:03,450"), 3723.45);
  assert.equal(parseTimestamp("00:00:01.5"), 1.5);
  assert.equal(parseTimestamp("02:03.040"), 123.04);
  assert.equal(parseTimestamp("1:2:3"), null);
  assert.equal(parseTimestamp("words"), null);
});

test("a real SRT file (Sintel, CC BY 3.0) reads every block at its exact times", () => {
  const events = parseSrt(sintel);
  const blocks = sintel.trim().split(/\r?\n\r?\n/);
  assert.equal(events.length, blocks.length);
  assert.deepEqual(events[0], { start: 107.25, end: 110.5, text: "This blade has a dark past." });
  assert.equal(events[2].text, "You're a fool for traveling alone,\nso completely unprepared.");
  for (const event of events) assert.ok(event.end > event.start);
  assert.equal(subtitleFormat(sintel), "srt");
});

test("SRT markup, Windows line ends, a byte order mark and broken blocks are handled", () => {
  const text = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> {\\an8}there &amp; you\r\n\r\n2\r\nnot a time\r\nskip me\r\n\r\n3\r\n00:00:03,000 --> 00:00:04,000\r\n<font color=\"red\">Bye</font>\r\n";
  assert.deepEqual(parseSrt(text), [
    { start: 1, end: 2.5, text: "Hello there & you" },
    { start: 3, end: 4, text: "Bye" },
  ]);
  assert.throws(() => parseSrt("nothing timed here"), /No timed lines/);
});

test("WebVTT skips NOTE and STYLE blocks, keeps cue settings out of the text, and reads word times", () => {
  const text = [
    "WEBVTT - demo", "", "NOTE a comment", "", "STYLE", "::cue { color: red }", "",
    "intro", "00:01.000 --> 00:03.000 align:center line:80%", "<v Ana>Hello <b>world</b>", "",
    "00:00:04.000 --> 00:00:06.000", "<00:00:04.000>one <00:00:04.500>two <00:00:05.200>three", "",
  ].join("\n");
  const events = parseVtt(text);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { start: 1, end: 3, text: "Hello world" });
  assert.equal(events[1].text, "one two three");
  assert.deepEqual(events[1].words, [
    { text: "one", start: 4, end: 4.5 }, { text: "two", start: 4.5, end: 5.2 }, { text: "three", start: 5.2, end: 6 },
  ]);
  assert.equal(subtitleFormat(text), "vtt");
  assert.throws(() => parseVtt("00:01.000 --> 00:02.000\nhi"), /starts with WEBVTT/);
});

test("plain text is not a subtitle file", () => {
  assert.equal(subtitleFormat("Just a sentence."), "text");
  assert.throws(() => parseSubtitles("Just a sentence."), /not an SRT or WebVTT/);
});

test("written SRT and VTT read back to the same events", () => {
  const events = [{ start: 0.5, end: 2.25, text: "First line\nsecond line" }, { start: 3725.001, end: 3726, text: "Tom & Jerry" }];
  assert.deepEqual(parseSrt(formatSrt(events)), events);
  // WebVTT escapes markup characters, so text with < and > reads back whole.
  events[1].text = "Tom & <Jerry>";
  const vtt = formatVtt(events);
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.500 --> 00:00:02\.250\n/);
  assert.match(vtt, /Tom &amp; &lt;Jerry&gt;/);
  assert.deepEqual(parseVtt(vtt), events);
});

test("a blank line or \"-->\" in a caption does not end its cue in the written files", () => {
  const events = [
    { start: 1, end: 2, text: "para one\n\n  \npara two" },
    { start: 2, end: 3, text: "first line\n\n2 --> 3 ---> 00:00:05,000 --> 00:00:06,000" },
  ];
  const srt = formatSrt(events);
  assert.equal(srt.split("\n\n").length, 2, "the only blank line is between the two cues");
  assert.equal(srt.match(/-->/g).length, 2, "one --> per time line");
  assert.deepEqual(parseSrt(srt), [
    { start: 1, end: 2, text: "para one\npara two" },
    { start: 2, end: 3, text: "first line\n2 -> 3 -> 00:00:05,000 -> 00:00:06,000" },
  ]);
  // WebVTT escapes ">", so the arrows read back as written.
  const vtt = formatVtt(events);
  assert.equal(vtt.match(/-->/g).length, 2);
  assert.deepEqual(parseVtt(vtt), [
    { start: 1, end: 2, text: "para one\npara two" },
    { start: 2, end: 3, text: "first line\n2 --> 3 ---> 00:00:05,000 --> 00:00:06,000" },
  ]);
});
