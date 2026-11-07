// The dashboard's plain-data modules: the key map (plan §5.8), the command line, the text
// helpers, and how the snapshot plus stream events become the rows each pane shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callSummary, clock, cut, fixWords, noteState, progressBar, tokens, bytes, ago } from "./dashboard/format.js";
import { isTyping, keyAction, parseCommand } from "./dashboard/keys.js";
import { editCommandTarget } from "./desktopEdit.js";
import { windowTitle } from "./dashboard/notify.js";
import { desktopServiceLine } from "./dashboard/stream.js";
import { tickWhileShown } from "./dashboard/visibleClock.js";
import { agentChips, idleLine, nowBlock, renderAgent, runningRender } from "./dashboard/topbar.js";
import { projectGroups } from "./dashboard/projectRows.js";
import { agentRows, applyEvent, attention, backgroundCheckInput, briefRows, commentRows, fromSnapshot, planRows, seenImages, turnChips, turnRows, variantChoices, videoLayers, WORKING_MS, withRecord } from "./dashboard/state.js";

const press = (key, extra = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

test("the main keys map to the §5.8 actions", () => {
  const expected = {
    "?": "help", ":": "command", "/": "filter", " ": "play", ",": "frame-back", ".": "frame-forward", "[": "turn-back", "]": "turn-forward",
    "{": "scene-back", "}": "scene-forward", c: "note", a: "allow", A: "allow-always", d: "deny", D: "deny-always", u: "undo", H: "hold",
    o: "full-frame", e: "export", t: "transcript", x: "cancel-render", f: "follow", "+": "zoom", _: "unzoom", j: "down", k: "up",
    ArrowLeft: "left", ArrowRight: "right", Enter: "open", Escape: "back", 1: "pane-1", 3: "pane-3",
    // The F1 layout's keys: n note, h hold, r render, s safe, g grid, b boxes, F3 inspire.
    n: "note", h: "hold", r: "export", s: "safe", g: "grid", b: "boxes", F1: "stage", F2: "crew", F3: "inspire",
  };
  for (const [key, action] of Object.entries(expected)) assert.equal(keyAction(press(key)), action, key);
  // Tab is the browser's: from a pane it moves into that pane's buttons and fields.
  for (const idle of [false, true]) {
    assert.equal(keyAction(press("Tab"), { idle }), null, `Tab, idle ${idle}`);
    assert.equal(keyAction(press("Tab", { shiftKey: true }), { idle }), null, `Shift+Tab, idle ${idle}`);
  }
  // Three panes now (stage, agent, timeline): 4 and 5 do nothing.
  assert.equal(keyAction(press("4")), null);
  assert.equal(keyAction(press("5")), null);
});

test("keys depend on the screen, and typing turns letters off", () => {
  assert.equal(keyAction(press("2"), { screen: "variants" }), "pick-2");
  assert.equal(keyAction(press("r"), { screen: "variants" }), "reject");
  assert.equal(keyAction(press("Tab"), { screen: "approval", idle: true }), "approval-note", "Tab with nothing focused goes to the note");
  assert.equal(keyAction(press("Tab"), { screen: "approval" }), null, "Tab from an answer button goes on to the next one");
  assert.equal(keyAction(press("Tab", { shiftKey: true }), { screen: "approval", idle: true }), null);
  assert.equal(keyAction(press("D"), { screen: "approval" }), "deny-always");
  assert.equal(keyAction(press("y"), { screen: "projects" }), "duplicate");
  assert.equal(keyAction(press("Delete"), { screen: "projects" }), "archive");
  assert.equal(keyAction(press("u"), { screen: "turn" }), "undo");
  assert.equal(keyAction(press("1"), { screen: "settings" }), null, "pane keys only on the main screen");
  assert.equal(keyAction(press("j"), { screen: "projects" }), "down");
  assert.equal(keyAction(press("a"), { typing: true }), null);
  assert.equal(keyAction(press("Escape"), { typing: true }), "back");
  assert.equal(keyAction(press("F3"), { typing: true }), "inspire", "F1 to F3 switch views from a text field too");
  assert.equal(keyAction(press("k", { metaKey: true })), "command-toggle", "⌘K opens the command line, and closes it");
  assert.equal(keyAction(press("b", { ctrlKey: true })), null, "Ctrl+B is never bound");
  assert.equal(keyAction(press("c", { ctrlKey: true })), null, "Ctrl+C is never bound");
});

test("isTyping is true for text fields and selects, false for buttons and checkboxes", () => {
  assert.equal(isTyping({ tagName: "TEXTAREA" }), true);
  assert.equal(isTyping({ tagName: "SELECT" }), true);
  assert.equal(isTyping({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTyping({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTyping({ tagName: "BUTTON" }), false);
  assert.equal(isTyping({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTyping(null), false);
});

test("the command line understands its commands and explains mistakes", () => {
  assert.deepEqual(parseCommand("projects"), { action: "projects" });
  assert.deepEqual(parseCommand("shares"), { action: "shares" });
  assert.deepEqual(parseCommand(":turn t3"), { action: "turn", value: "T3" });
  assert.deepEqual(parseCommand("note make the title larger"), { action: "note", value: "make the title larger" });
  assert.deepEqual(parseCommand("hold wait for legal"), { action: "hold", value: true, note: "wait for legal" });
  assert.deepEqual(parseCommand("release"), { action: "hold", value: false });
  assert.deepEqual(parseCommand("export draft webm"), { action: "export", value: { quality: "draft", format: "webm" } });
  assert.deepEqual(parseCommand("export"), { action: "export", value: { quality: "final" } });
  assert.deepEqual(parseCommand("grid"), { action: "overlay", value: "grid" });
  assert.deepEqual(parseCommand("marks"), { action: "overlay", value: "marks" });
  assert.match(parseCommand("export 9x16").error, /not 9x16/);
  assert.match(parseCommand("turn").error, /turn id/);
  assert.match(parseCommand("fly").error, /Unknown command "fly"/);
  assert.match(parseCommand("").error, /Type a command/);
});

test("text helpers keep the character grid", () => {
  assert.equal(clock(2.4), "00:02.40");
  assert.equal(clock(61.5), "01:01.50");
  assert.equal(clock(-3), "00:00.00");
  assert.equal(tokens(640), "640");
  assert.equal(tokens(3120), "3.1k");
  assert.equal(tokens(48_200), "48k");
  assert.equal(bytes(1536), "1.5 KB");
  assert.equal(progressBar(0), "⣀⣀⣀⣀⣀");
  assert.equal(progressBar(1), "⣿⣿⣿⣿⣿");
  assert.equal([...progressBar(0.5)].length, 5);
  assert.equal(cut("headline", 5), "head…");
  assert.equal(ago("2026-10-18T10:00:00Z", Date.parse("2026-10-18T10:03:10Z")), "3m");
  assert.equal(windowTitle(2, "Orbit"), "2 awaiting · kino");
  assert.equal(windowTitle(0, "Orbit"), "kino - Orbit");
});

test("a check's fix reads as plain words: the op, what it changes and its values, with no braces or quotes", () => {
  assert.equal(fixWords({ op: "update_animation", animationId: "A1", properties: { duration: 0.8 } }), "update_animation A1 · duration 0.8");
  assert.equal(fixWords({ op: "move_layer", layerId: "L1", index: 0 }), "move_layer L1 · index 0");
  assert.equal(fixWords("Put a solid plate behind the text."), "Put a solid plate behind the text.");
  assert.equal(fixWords(null), "");
  // A list of edits, a value that is an object or a list, and more than four values.
  const words = fixWords([
    { op: "update_layer", layer: "title", properties: { shadow: { x: 1, y: 2 }, points: [[1, 2], [3, 4]] } },
    { op: "add_animation", layer: "card", effect: "fade", start: 0, duration: 0.5, easing: "ease-out", kind: "in" },
  ]);
  assert.equal(words, "update_layer title · shadow x 1, y 2, points …, …; add_animation card · effect fade, start 0, duration 0.5, easing ease-out, …");
  assert.doesNotMatch(words, /[{}"[\]]/);
  // A long value is cut with "…".
  assert.equal(fixWords({ op: "update_layer", layerId: "L2", properties: { text: "x".repeat(40) } }), `update_layer L2 · text ${"x".repeat(31)}…`);
});

test("notes show queued, delivered and addressed", () => {
  assert.equal(noteState({ status: "new" }).word, "queued");
  assert.equal(noteState({ status: "seen" }).word, "delivered");
  assert.equal(noteState({ status: "addressed" }).word, "delivered");
  assert.equal(noteState({ status: "resolved" }).word, "addressed");
});

test("an edit receipt becomes a short line with layer names and the new revision", () => {
  const call = { verb: "edit", summary: '{"rev":3,"changed":["L1"]}', input: '{"ops":[{"op":"update_layer","layer":"headline","properties":{"fontSize":150}}]}' };
  assert.equal(callSummary(call), "headline → rev 3");
  assert.equal(callSummary({ verb: "look", summary: "frame at 0.5s" }), "frame at 0.5s");
  assert.equal(callSummary({ verb: "edit", summary: '{"rev":4}', input: '{"retry":"E2"}' }), "retry E2 → rev 4");
});

const snapshot = {
  boot: "b1", seq: 10, projectId: "orbit", current: "orbit", projects: [{ id: "orbit", name: "Orbit" }],
  record: { revision: 2, document: { id: "orbit", scenes: [] } },
  agent: { plan: null, notes: [], turns: [], codes: {} },
  events: [], approvals: [], renders: [], agents: [],
};

test("stream events apply in order, once, to the snapshot", () => {
  const state = fromSnapshot(snapshot);
  assert.equal(applyEvent(state, { seq: 10, type: "hold", hold: { on: true } }), state, "an event already in the snapshot is skipped");
  const held = applyEvent(state, { seq: 11, type: "hold", hold: { on: true, note: "wait" } });
  assert.equal(held.hold.on, true);
  assert.equal(held.seq, 11);

  const asked = applyEvent(held, { seq: 12, type: "approval", approval: { id: "A1", status: "pending", client: "claude" } });
  assert.equal(attention(asked).count, 1);
  const answered = applyEvent(asked, { seq: 13, type: "approval", approval: { id: "A1", status: "allowed", client: "claude" } });
  assert.equal(attention(answered).count, 0);
  assert.equal(answered.approvals.length, 1, "the same approval is updated, not added");

  const edited = applyEvent(answered, { seq: 14, type: "document", projectId: "orbit", rev: 3, actor: "agent", focus: { sceneId: "S1", time: 1 }, at: "x" });
  assert.equal(edited.behind, true);
  assert.equal(edited.wantRev, 3);
  assert.deepEqual(edited.focus, { sceneId: "S1", time: 1, rev: 3, at: "x" });
  const yours = applyEvent(edited, { seq: 15, type: "document", projectId: "orbit", rev: 4, actor: "you", focus: { sceneId: "S2", time: 0 } });
  assert.equal(yours.focus.sceneId, "S1", "your own edits do not move the stage");
  const caughtUp = withRecord(yours, { revision: 4, document: { id: "orbit", scenes: [] } });
  assert.equal(caughtUp.behind, false);
  assert.equal(withRecord(caughtUp, { revision: 1, document: { id: "orbit", scenes: [] } }), caughtUp, "an older record is ignored");

  const other = applyEvent(caughtUp, { seq: 16, type: "note", projectId: "other", note: { id: "N1" } });
  assert.equal(other.agent.notes.length, 0, "another project's note is not shown here");
  const noted = applyEvent(other, { seq: 17, type: "note", projectId: "orbit", note: { id: "N1", status: "new", text: "bigger" } });
  assert.equal(noted.agent.notes[0].text, "bigger");
  // The stopped edits come as the whole list: an answered one goes.
  const stopped = applyEvent(noted, { seq: 18, type: "stopped", projectId: "orbit", stopped: [{ id: "S1" }, { id: "S2" }] });
  assert.deepEqual(applyEvent(stopped, { seq: 19, type: "stopped", projectId: "orbit", stopped: [{ id: "S2" }] }).agent.stopped, [{ id: "S2" }]);
});

test("comments from share links show read only, newest thread first, and follow the stream", () => {
  const scenes = [{ id: "S1", name: "Intro" }];
  const first = { id: "c1", text: "logo is late", author: "Ana", createdAt: "2026-10-18T10:00:00Z", resolved: false, sceneId: "S1", time: 1.5 };
  const state = fromSnapshot({ ...snapshot, record: { revision: 2, document: { id: "orbit", scenes } }, comments: [first] });
  assert.equal(fromSnapshot(snapshot).comments.length, 0, "a snapshot without comments has none");
  assert.deepEqual(commentRows(state).map((row) => [row.comment.id, row.scene]), [["c1", "Intro"]]);
  const reply = { id: "c2", parentId: "c1", text: "agreed", author: "Bo", createdAt: "2026-10-18T10:01:00Z", resolved: false };
  const second = { id: "c3", text: "nice end", author: "Bo", createdAt: "2026-10-18T10:02:00Z", resolved: true };
  const elsewhere = applyEvent(state, { seq: 11, type: "comments", projectId: "other", comments: [] });
  assert.equal(elsewhere.comments.length, 1, "another project's comments are not shown here");
  const updated = applyEvent(elsewhere, { seq: 12, type: "comments", projectId: "orbit", comments: [first, reply, second] });
  const rows = commentRows(updated);
  assert.deepEqual(rows.map((row) => row.comment.id), ["c3", "c1"]);
  assert.deepEqual(rows[1].replies.map((entry) => entry.id), ["c2"]);
  assert.equal(rows[0].scene, null, "a comment without a scene has no scene name");
});

test("calls name the agents and fill the log, one row per turn", () => {
  const now = Date.parse("2026-10-18T10:00:30Z");
  let state = fromSnapshot(snapshot);
  const turns = [
    { id: "T1", calls: 2, edits: [{ before: 1, after: 2, ops: 3 }], reverted: null },
    { id: "T2", calls: 1, edits: [{ before: 2, after: 3, ops: 1 }], reverted: { rev: 4 } },
    { id: "T3", calls: 1, edits: [], reverted: null },
    { id: "T4", calls: 1, edits: [], reverted: null },
    { id: "T5", calls: 1, edits: [], reverted: null },
  ];
  state = applyEvent(state, { seq: 11, type: "call", projectId: "orbit", agent: { ...snapshot.agent, turns }, event: { verb: "edit", client: "claude", turn: "T2", at: "2026-10-18T09:00:00Z", summary: '{"rev":3}', input: "{}" } });
  state = applyEvent(state, { seq: 12, type: "call", projectId: "orbit", event: { verb: "edit", client: "claude", turn: "T1", at: "2026-10-18T09:59:00Z", summary: '{"rev":2}', input: '{"ops":[{"op":"add_layer","name":"card"}]}', images: [] } });
  state = applyEvent(state, { seq: 13, type: "call", projectId: "orbit", event: { verb: "look", client: "claude", turn: "T1", at: "2026-10-18T10:00:20Z", summary: "frame", images: ["frame-1.png"] } });
  state = applyEvent(state, { seq: 14, type: "call", projectId: "orbit", event: { verb: "notes", by: "you", at: "2026-10-18T10:00:25Z", summary: "N1" } });
  assert.deepEqual(state.agents.map((agent) => agent.name), ["claude"], "your own calls are not an agent");
  assert.equal(agentRows(state, now)[0].status, "working");
  assert.equal(agentRows(state, now + WORKING_MS)[0].status, "idle");
  state = applyEvent(state, { seq: 15, type: "approval", approval: { id: "A1", status: "pending", client: "claude" } });
  assert.equal(agentRows(state, now)[0].status, "needs-you");

  // T3 put the project back with a history restore, T4 reverted T2, and T5's restore failed.
  state = applyEvent(state, { seq: 16, type: "call", projectId: "orbit", event: { verb: "history", client: "claude", turn: "T3", at: "2026-10-18T09:01:00Z", summary: '{"restored":1,"rev":5,"changed":["card"]}' } });
  state = applyEvent(state, { seq: 17, type: "call", projectId: "orbit", event: { verb: "history", client: "claude", turn: "T4", at: "2026-10-18T09:02:00Z", summary: '{"reverted":"T2","rev":4,"changed":["card"]}' } });
  state = applyEvent(state, { seq: 18, type: "call", projectId: "orbit", event: { verb: "history", client: "claude", turn: "T5", at: "2026-10-18T09:03:00Z", summary: "no rev 99", isError: true } });
  const rows = turnRows(state, now);
  // The ring (↻) goes on the turns that put the project back; the turn they undid is "undone".
  assert.deepEqual(rows.map((row) => [row.id, row.symbol, row.ops]), [["T1", "spinner", 3], ["T2", "undone", 1], ["T3", "↻", 0], ["T4", "↻", 0], ["T5", "✕", 0]]);
  assert.equal(rows[0].summary, "card → rev 2");
  assert.equal(rows[1].summary, "reverted at rev 4");
  assert.equal(rows[2].summary, '{"restored":1,"rev":5,"changed":["card"]}');
  assert.equal(turnRows(state, now + WORKING_MS)[0].symbol, "✓");
  assert.deepEqual(turnChips(state).map((chip) => [chip.id, chip.rev, chip.reverted]), [["T1", 2, false], ["T2", 3, true], ["T3", null, false], ["T4", null, false], ["T5", null, false]]);
  assert.deepEqual(seenImages(state).map((image) => image.file), ["frame-1.png"]);
});

test("the same picture from two looks gets two keys, so the film strip can show both", () => {
  const look = (at) => ({ at, verb: "look", by: "agent", images: ["zoom-1.png"], summary: "zoom L1 @2s crop" });
  const images = seenImages({ calls: [look("2026-10-18T09:00:00.000Z"), look("2026-10-18T09:00:05.000Z")] });
  assert.deepEqual(images.map((image) => image.file), ["zoom-1.png", "zoom-1.png"]);
  assert.equal(new Set(images.map((image) => image.key)).size, 2);
});

test("a turn is marked failed only while a failed call has not been retried successfully", () => {
  const at = "2026-10-18T09:00:00Z";
  const later = Date.parse(at) + WORKING_MS + 1000;
  const turns = [
    { id: "T1", calls: 2, edits: [{ before: 1, after: 2, ops: 5 }], reverted: null },
    { id: "T2", calls: 2, edits: [], reverted: null },
    { id: "T3", calls: 2, edits: [], reverted: null },
  ];
  const calls = [
    { verb: "edit", turn: "T1", at, isError: true, summary: "E2" },
    { verb: "edit", turn: "T1", at, summary: '{"rev":2}', input: "{}" },
    { verb: "edit", turn: "T2", at, isError: true, summary: "E2" },
    { verb: "look", turn: "T2", at, summary: "frame" },
    { verb: "edit", turn: "T3", at, summary: '{"rev":2}', input: "{}" },
    { verb: "edit", turn: "T3", at, isError: true, summary: "E2" },
  ];
  const rows = turnRows({ calls, agent: { turns } }, later);
  assert.deepEqual(rows.map((row) => [row.id, row.symbol]), [["T1", "✓"], ["T2", "✕"], ["T3", "✕"]]);
});

test("the plan shows at most five steps and keeps the current one in view", () => {
  const steps = Array.from({ length: 9 }, (_, index) => ({ text: `step ${index + 1}`, done: index < 6 }));
  const rows = planRows({ steps });
  assert.equal(rows.length, 5);
  assert.ok(rows.some((row) => row.text === "step 7" && row.mark === "▸"));
  assert.deepEqual(planRows({ steps: ["brief", "render"] }).map((row) => row.mark), ["▸", "·"]);
});

test("the brief shows read only: you said with the recorded quote, guessed, what is missing, and the reply count", () => {
  // No brief yet (and an older server's snapshot with no brief at all), before the document loads.
  const none = briefRows(fromSnapshot({ boot: "b" }).agent);
  assert.equal(none.empty, "no brief yet");
  assert.deepEqual([none.status, none.replies, none.lines, none.footnote, none.fix, none.short, none.startedWithout], [null, null, [], "", "", "", false]);
  assert.deepEqual(briefRows({ brief: null }), none);
  // Review round 2: the empty text says what kino tells the agent (backend/agent/brief.mjs
  // nextStep). An empty video gets a brief first; one with layers was started without one and
  // is told it needs none, so the panel promises no questions there (and the phone shows no card).
  assert.equal(briefRows({ brief: null }, { layers: 0 }).empty, "no brief yet: kino tells your agent to ask you in the chat before it builds");
  const started = briefRows({ brief: null, plan: { steps: [{ text: "Build" }] } }, { layers: 3 });
  assert.equal(started.empty, "no brief: this video was started without one");
  assert.equal(started.startedWithout, true);
  assert.doesNotMatch(started.empty, /asks/);
  const record = (scenes) => ({ record: { revision: 1, document: { scenes } } });
  assert.deepEqual([videoLayers(null), videoLayers({}), videoLayers(record([{ layers: [] }])), videoLayers(record([{ layers: [{}, {}] }, { layers: [{}] }]))], [null, null, 0, 3]);

  // Replies logged, no line saved yet.
  const asked = briefRows({ brief: { rev: 0, savedAt: null, confirmed: false, lines: [], missing: ["message", "plays_on", "made_from", "look_sound", "never"], replies: { count: 2, limit: 10 } } });
  assert.equal(asked.empty, "no brief lines saved yet");
  assert.equal(asked.short, "");
  // "just start" before any line: the agent guesses them, so nothing says it will ask.
  assert.equal(briefRows({ brief: { rev: 0, confirmed: false, noPlayback: "just start", lines: [], missing: [], replies: { count: 1, limit: 10 } } }).empty, "no brief lines yet; no playback: just start");
  assert.equal(asked.status, null, "no revision to name before a line is saved");
  assert.equal(asked.replies, "your replies 2 of 10");
  assert.equal(asked.missing, "missing: message, plays on, made from, look and sound, never");
  assert.equal(asked.footnote, "replies recorded by the agent; kino cannot check them");
  assert.equal(briefRows({ brief: { rev: 0, confirmed: true, lines: [], missing: [], replies: { count: 1, limit: 10 } } }).confirmed, false, "a playback with no line confirms nothing");

  // A mixed brief: the lines come in the brief's order whatever order they arrive in.
  const brief = {
    rev: 2, savedAt: "2026-10-20T14:02:11.000Z", confirmed: false,
    lines: [
      { name: "plays_on", text: "TikTok, 9:16, 24 s", by: "guessed" },
      { name: "never", text: "no meme text", by: "you", quote: "no meme text please" },
      { name: "message", text: "skate crew; make them want to skate now", by: "you", quote: "my skate crew, they should feel like going out to skate" },
    ],
    missing: ["look_sound", "made_from"],
    replies: { count: 4, limit: 10 },
  };
  const rows = briefRows({ brief });
  assert.equal(rows.empty, null);
  assert.equal(rows.status, "r2 · not confirmed yet");
  assert.equal(rows.replies, "your replies 4 of 10");
  assert.deepEqual(rows.lines.map((line) => [line.label, line.by]), [["message", "you"], ["plays on", "guessed"], ["never", "you"]]);
  assert.equal(rows.lines[2].quote, "no meme text please", "the quote is shown as the agent recorded it");
  assert.equal(rows.lines[2].sentence, 'never: you said, recorded by the agent, "no meme text please". The agent reads it as: no meme text.');
  assert.equal(rows.lines[1].sentence, "plays on: guessed by the agent: TikTok, 9:16, 24 s.");
  assert.equal(rows.missing, "missing: made from, look and sound", "missing lines in the brief's order, in words");
  assert.equal(rows.footnote, "quotes and replies recorded by the agent; kino cannot check them");
  assert.equal(rows.fix, "a line is wrong? tell your agent in the chat", "the panel says how a wrong line is fixed");
  assert.equal(rows.short, "3 lines, not confirmed yet", "the closed section's summary");
  assert.equal(rows.listLabel, "Brief, revision 2, not confirmed");
  assert.equal(brief.lines[0].name, "plays_on", "the agent data is not reordered in place");

  const confirmed = briefRows({ brief: { ...brief, rev: 3, confirmed: true, missing: [] } });
  assert.equal(confirmed.status, "r3 · confirmed in chat");
  assert.equal(confirmed.short, "3 lines, confirmed in chat");
  assert.equal(briefRows({ brief }, { layers: 4 }).startedWithout, false, "a saved brief shows on any video");
  // "just start", or no one could answer: settled with no playback, said in words (review round 1).
  const skipped = briefRows({ brief: { ...brief, noPlayback: "just start" } });
  assert.deepEqual([skipped.status, skipped.confirmed, skipped.listLabel], ["r2 · no playback: just start", false, "Brief, revision 2, no playback: just start"]);
  assert.equal(briefRows({ brief: { ...brief, rev: 3, confirmed: true, noPlayback: "just start" } }).status, "r3 · confirmed in chat", "a confirmation wins");
  assert.equal(confirmed.listLabel, "Brief, revision 3, confirmed in chat");
  assert.equal(confirmed.missing, "");
  const guessedOnly = briefRows({ brief: { ...brief, lines: [brief.lines[0]] } });
  assert.equal(guessedOnly.footnote, "replies recorded by the agent; kino cannot check them", "no quote, so the footnote names only the replies");

  // At the limit the panel says the agent makes the remaining calls itself.
  assert.equal(briefRows({ brief: { ...brief, replies: { count: 10, limit: 10 } } }).replies, "your replies 10 of 10: the agent makes the other calls");
  assert.equal(briefRows({ brief: { ...brief, replies: { count: 9, limit: 10 } } }).replies, "your replies 9 of 10");

  // Every agent call carries the agent data, brief included; a note leaves the brief as it was.
  const state = applyEvent(fromSnapshot({ boot: "b", seq: 1, projectId: "orbit" }), { seq: 2, type: "call", projectId: "orbit", event: { verb: "notes", client: "claude-code", at: "2026-10-20T14:02:11.000Z" }, agent: { plan: null, notes: [], turns: [], codes: {}, brief } });
  assert.equal(briefRows(state.agent).status, "r2 · not confirmed yet");
  const noted = applyEvent(state, { seq: 3, type: "note", projectId: "orbit", note: { id: "N1", text: "bigger" } });
  assert.equal(noted.agent.brief, brief);
});

test("variants compare the stage scene's set, else the newest set, else every scene", () => {
  const scene = (id, variant) => ({ id, name: id, ...(variant ? { variant } : {}) });
  const document = { scenes: [
    scene("intro"),
    scene("a", { of: "a", set: "V1", label: "original", vary: "layout" }), scene("a2", { of: "a", set: "V1", label: "wide", vary: "layout" }),
    scene("b2", { of: "b", set: "V2", label: "slow", vary: "timing" }), scene("b", { of: "b", set: "V2", label: "original", vary: "timing" }),
    { id: "card", isComponent: true },
  ] };
  assert.deepEqual(variantChoices(document, "a2").scenes.map((entry) => entry.id), ["a", "a2"]);
  const newest = variantChoices(document, "intro");
  assert.equal(newest.set, "V2");
  assert.deepEqual(newest.scenes.map((entry) => entry.id), ["b", "b2"], "the original comes first");
  const none = variantChoices({ scenes: [scene("one"), scene("two"), { id: "card", isComponent: true }] });
  assert.deepEqual([none.set, none.scenes.map((entry) => entry.id)], [null, ["one", "two"]], "components are not variants");
});

test("the Mac app's Undo and Redo edit text in a text field and reach the page outside one", () => {
  assert.equal(editCommandTarget("undo", true), "text");
  assert.equal(editCommandTarget("redo", true), "text");
  assert.equal(editCommandTarget("undo", false), "page");
  assert.equal(editCommandTarget("redo", false), "page");
  assert.equal(editCommandTarget("paste-replace", false), null, "the removed editor commands do nothing");
});

test("the status line says when the Mac app's local service stopped for good, and how to restart it", () => {
  assert.deepEqual(desktopServiceLine("failed"), { state: "failed", text: "local service stopped · View › Restart local service" });
  // While it restarts on its own, or once it is back, the stream's own words are enough.
  assert.equal(desktopServiceLine("reconnecting"), null);
  assert.equal(desktopServiceLine("ready"), null);
});

test("the top bar's agent chips, idle line, running render and its agent, and the timeline's now block", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const at = (seconds) => new Date(now - seconds * 1000).toISOString();
  const nova = { id: "a2", name: "Nova", color: "#42c0b6" };
  const data = {
    projectId: "p1",
    agents: [{ ...nova, kind: "cli", lastAt: at(2) }, { id: "a1", name: "Juno", color: "#5b9cf5", kind: "cli", lastAt: at(3600) }],
    live: { latest: { a2: { agent: nova, call: 7, phase: "start", at: at(2), label: "editing arrival title now", target: { sceneId: "s1", range: [44, 52] } } } },
    calls: [{ verb: "edit", at: at(33 * 60), agent: nova }, { verb: "render", at: at(40), agent: nova }],
    renders: [{ id: "R25", projectId: "p1", status: "done", startedAt: at(900) }, { id: "R26", projectId: "p1", status: "inProgress", progress: 0.62, startedAt: at(38), by: "agent" }],
  };
  // One chip per agent at work, its label cut to three words; Juno is idle and has none.
  assert.deepEqual(agentChips(data, now).map((chip) => [chip.name, chip.doing]), [["Nova", "editing arrival title"]]);
  assert.equal(idleLine(data, now), "all idle · last edit 33 min ago");
  assert.equal(idleLine({ agents: [], calls: [] }, now), null);
  // The running render, and the agent whose render call started it (within 15 s); none for yours.
  assert.equal(runningRender(data).id, "R26");
  assert.equal(renderAgent(data, runningRender(data)).name, "Nova");
  assert.equal(renderAgent(data, { ...runningRender(data), by: "you" }), null);
  // The now block: the range the shown call is about, in this scene only.
  assert.deepEqual(nowBlock(data.live.latest.a2, "s1", now), { start: 44, end: 52, label: "editing arrival" });
  assert.equal(nowBlock(data.live.latest.a2, "s2", now), null);
});

test("the projects screen folds the verification projects away under tests, and filters by name or id", () => {
  const projects = [{ id: "a", name: "Media verification" }, { id: "app-trailer", name: "App trailer" }, { id: "b", name: "Motion study" }, { id: "smoke", name: "smokescreen promo" }];
  const groups = projectGroups(projects);
  assert.deepEqual(groups.mine.map((row) => [row.project.id, row.index]), [["app-trailer", 1], ["smoke", 3]]);
  assert.deepEqual(groups.tests.map((row) => row.project.id), ["a", "b"]);
  assert.deepEqual(projectGroups(projects, "SMOKE").mine.map((row) => row.project.id), ["smoke"]);
});

test("the dashboard clock does not tick while the window is hidden", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const listeners = new Set();
  const doc = { visibilityState: "visible", addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  let ticks = 0;
  const stop = tickWhileShown(() => { ticks += 1; }, 1000, doc);
  t.mock.timers.tick(3000);
  assert.equal(ticks, 3);
  doc.visibilityState = "hidden";
  for (const fn of listeners) fn();
  t.mock.timers.tick(5000);
  assert.equal(ticks, 3, "no ticks while hidden");
  doc.visibilityState = "visible";
  for (const fn of listeners) fn();
  assert.equal(ticks, 4, "one tick at once when shown again");
  t.mock.timers.tick(1000);
  assert.equal(ticks, 5);
  stop();
  assert.equal(listeners.size, 0);
  t.mock.timers.tick(5000);
  assert.equal(ticks, 5);
});

test("the dashboard's background check reads saved results only (no whisper, ffmpeg or frames)", () => {
  assert.deepEqual(backgroundCheckInput("p1"), { project: "p1", quiet: true, pixels: false });
});
