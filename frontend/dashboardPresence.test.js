// The agents' live markers (milestone LIVE, parts 1 and 3) as plain data: when a marker shows and
// fades, which writes flash (fresh ones only) or get a steady outline under reduced motion, where
// tags go on the stage (another scene's at the edge, two agents stacked), the timeline's px, the
// building marks, the next timer, and the throttled screen-reader line. The presence objects have
// the shape of the server's "presence" event (design F3), as the reducer keeps them in data.live.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FADE_MS, FLASH_MS, FOLLOW_GAP_MS, REST_ROW_PX, SHOWN_MS, STACK_PX, STAGE_BOT_PX, START_MS, STEADY_MS, TAG_PX, TURN_GAP_MS, announceText, buildingIds, changeMarks, chipPlaces, createAnnouncer, cursorPlaces, followStart,
  leavingPresence, newestPresence, nextChangeAt, noteFirstSeen, restPlaces, ridePlace, serverNow, shownPresence, stageBuilding, stageCrew, tagPlaces, timelineMarks, timelineSpan, timelineX,
} from "./dashboard/presence.js";
import { callLine } from "./dashboard/format.js";

const T0 = Date.parse("2026-10-25T10:42:00.000Z");
const NOVA = { id: "a1", name: "Nova", color: "#42c0b6", kind: "claude-code" };
const JUNO = { id: "a2", name: "Juno", color: "#6cb6ff", kind: "codex" };

function presence(fields = {}) {
  return {
    agent: NOVA, call: 41, phase: "done", verb: "look", label: "look at 1.0–2.0 s", write: false,
    target: { sceneId: "intro", sceneName: "intro", layerIds: ["title"], time: null, range: [1, 2], text: "Title, 1.0–2.0 s" },
    changed: null, building: [], turn: "T4", isError: false, ms: 12, at: new Date(T0).toISOString(), ...fields,
  };
}
const write = (fields = {}) => presence({
  call: 42, verb: "edit", label: "move Title", write: true,
  target: { sceneId: "intro", sceneName: "intro", layerIds: ["title"], time: null, range: [0, 1.5], text: "Title" },
  changed: { sceneId: "intro", layerIds: ["title"], range: [0, 1.5], text: "Title" }, ...fields,
});
const liveOf = (...list) => ({ latest: Object.fromEntries(list.map((entry) => [entry.agent.id, entry])), building: [], skew: 0 });

test("the server's clock: skew is how far this computer is ahead", () => {
  assert.equal(serverNow({ skew: 250 }, T0 + 1000), T0 + 750);
  assert.equal(serverNow({ skew: -80 }, T0), T0 + 80);
  assert.equal(serverNow(undefined, T0), T0);
});

test("a done call shows for 5 s and then fades out in 300 ms; a running call stays", () => {
  const live = liveOf(presence());
  assert.equal(shownPresence(live, T0 + 4900).length, 1, "shown at 4.9 s");
  assert.equal(shownPresence(live, T0 + 5100).length, 0, "not shown at 5.1 s");
  assert.equal(leavingPresence(live, T0 + 4900).length, 0, "not fading while shown");
  assert.equal(leavingPresence(live, T0 + 5100).length, 1, "fading at 5.1 s");
  assert.equal(leavingPresence(live, T0 + SHOWN_MS + FADE_MS + 1).length, 0, "gone once faded");
  const running = liveOf(presence({ phase: "start" }));
  assert.equal(shownPresence(running, T0 + 60_000).length, 1, "a running call stays shown a minute on");
  assert.equal(shownPresence(running, T0 + 9 * 60_000).length, 1, "and nine minutes on");
  assert.equal(shownPresence(running, T0 + 10 * 60_000 + 1).length, 0, "but not past 10 min");
  // A done call while another of the agent's calls still runs (`running`) stays shown too, and
  // its next change is the 10 min limit, not the 5 s fade.
  const beside = liveOf(presence({ running: 1 }));
  assert.equal(shownPresence(beside, T0 + 60_000).length, 1, "another call still runs");
  assert.equal(nextChangeAt(beside, T0 + 60_000), T0 + 10 * 60_000);
});

test("markers are newest first, 8 at most, and newestPresence is the newest of any agent", () => {
  const agents = Array.from({ length: 10 }, (_, index) => presence({ agent: { ...NOVA, id: `a${index + 1}`, name: `A${index}` }, call: index, at: new Date(T0 + index * 10).toISOString() }));
  const shown = shownPresence(liveOf(...agents), T0 + 200);
  assert.equal(shown.length, 8);
  assert.deepEqual(shown.slice(0, 2).map((entry) => entry.agent.id), ["a10", "a9"]);
  assert.equal(newestPresence(liveOf(...agents)).agent.id, "a10");
  assert.equal(newestPresence({ latest: {} }), null);
});

test("two calls that finish in the same millisecond: the one published later is the newest, whatever their call numbers", () => {
  const iris = presence({ agent: { ...JUNO, id: "a4", name: "Iris" }, call: 50, seq: 901 });
  const vega = presence({ agent: { ...NOVA, id: "a6", name: "Vega" }, call: 57, seq: 900 });
  assert.equal(newestPresence(liveOf(vega, iris)).agent.name, "Iris");
  assert.equal(newestPresence(liveOf(iris, vega)).agent.name, "Iris");
  // Without event numbers (an older server) the later call still wins a tie.
  assert.equal(newestPresence(liveOf(presence({ agent: JUNO, call: 50 }), presence({ agent: NOVA, call: 57 }))).agent.id, NOVA.id);
});

test("only a write that is fresh when first seen flashes, for 900 ms, starting where it already is", () => {
  const done = write();
  const seen = noteFirstSeen(new Map(), [done], T0 + 120);
  const at = (time) => changeMarks([done], time, { seen });
  assert.deepEqual(at(T0 + 400).map((mark) => [mark.steady, mark.delay]), [[false, 120]], "flashing, 120 ms in when first seen");
  assert.equal(at(T0 + FLASH_MS - 1).length, 1);
  assert.equal(at(T0 + FLASH_MS).length, 0, "over at 900 ms");
  // The same write first seen 1.2 s late (a snapshot or a replay) never flashes.
  const late = noteFirstSeen(new Map(), [done], T0 + 1200);
  assert.equal(changeMarks([done], T0 + 1250, { seen: late }).length, 0);
  // First seen later does not change when it was first seen.
  noteFirstSeen(seen, [done], T0 + 800);
  assert.equal(at(T0 + 850)[0].delay, 120);
  // Not for a read, a running edit, a failed edit or a dry run that saved nothing.
  for (const other of [presence(), write({ phase: "start" }), write({ isError: true }), write({ changed: null, label: "try: move Title" })]) {
    assert.equal(changeMarks([other], T0 + 300, { seen: noteFirstSeen(new Map(), [other], T0 + 10) }).length, 0, other.label);
  }
});

test("under reduced motion a fresh write gets a steady outline for 1.5 s instead", () => {
  const done = write();
  const seen = noteFirstSeen(new Map(), [done], T0 + 50);
  assert.deepEqual(changeMarks([done], T0 + 1000, { still: true, seen }).map((mark) => mark.steady), [true]);
  assert.equal(changeMarks([done], T0 + STEADY_MS - 1, { still: true, seen }).length, 1);
  assert.equal(changeMarks([done], T0 + STEADY_MS, { still: true, seen }).length, 0, "the timer takes it away at 1.5 s");
});

test("seen calls are forgotten after 10 s", () => {
  const seen = noteFirstSeen(new Map(), [write()], T0 + 10);
  assert.equal(seen.size, 1);
  noteFirstSeen(seen, [], T0 + 10_001);
  assert.equal(seen.size, 0);
});

const boxes = { title: { left: 100, top: 80, width: 200, height: 40 }, logo: { left: 20, top: 5, width: 50, height: 50 } };
const boxOf = (layerIds) => boxes[layerIds[0]] ?? null;
const places = (list, extra = {}) => tagPlaces(list, { sceneId: "intro", width: 640, height: 360, boxOf, sceneName: (id) => ({ outro: "Outro" })[id], ...extra });

test("a tag sits just above its outline, inside it at the stage's top, and at the top left without a layer", () => {
  const [above] = places([presence()]);
  assert.deepEqual([above.text, above.x, above.y, above.edge], ["Nova: look at 1.0–2.0 s", 100, 80 - TAG_PX, false]);
  assert.deepEqual(above.box, boxes.title);
  const [top] = places([presence({ target: { sceneId: "intro", layerIds: ["logo"], text: "Logo" } })]);
  assert.deepEqual([top.x, top.y], [20, 0], "kept on the stage");
  const [none] = places([presence({ target: { sceneId: "intro", layerIds: [], time: 0.5, text: "0.5 s" }, label: "look at 0.5 s" })]);
  assert.deepEqual([none.x, none.y, none.box], [0, 0, null]);
  const [missing] = places([presence({ target: { sceneId: "intro", layerIds: ["gone"] } })]);
  assert.deepEqual([missing.x, missing.y], [0, 0], "a layer the stage cannot find");
  const [project] = places([presence({ target: null, verb: "project", label: "list projects" })]);
  assert.deepEqual([project.text, project.x, project.y], ["Nova: list projects", 0, 0]);
  // A done write without a target points at what it changed.
  const [changed] = places([write({ target: null })]);
  assert.deepEqual([changed.x, changed.y], [100, 80 - TAG_PX]);
});

test("a cursor points at the middle of what the call is about and stays put when the call names nothing", () => {
  const last = new Map();
  const at = (list) => cursorPlaces(places(list), { width: 640, height: 360, last }).map(({ presence: p, x, y }) => [p.agent.name, x, y]);
  assert.deepEqual(at([presence({ label: "look" })]), [["Nova", 200, 100]], "the middle of Title");
  assert.deepEqual(at([presence({ target: null, label: "status" })]), [["Nova", 200, 100]], "a call about no layer leaves it where it was");
  assert.deepEqual(at([presence({ target: { sceneId: "intro", layerIds: ["logo"] } })]), [["Nova", 45, 30]], "it moves to the next layer");
  assert.deepEqual(at([presence({ agent: JUNO, target: null, label: "status" })]), [["Juno", 320, 180]], "a new agent starts in the stage's middle");
  assert.deepEqual(at([presence({ target: { sceneId: "outro", layerIds: [] } })]), [["Nova", 628, TAG_PX + 6]], "another scene: by its tag at the right edge");
});

test("a call about another scene puts the tag at the stage's right edge with the scene's name", () => {
  const [edge] = places([presence({ target: { sceneId: "outro", sceneName: "outro", layerIds: ["title"], text: "Title" } })]);
  assert.deepEqual([edge.text, edge.x, edge.y, edge.edge, edge.box], ["Nova in Outro", 640, 0, true, null]);
  const [unnamed] = places([presence({ target: { sceneId: "s9", sceneName: "credits", layerIds: [] } })]);
  assert.equal(unnamed.text, "Nova in credits", "the server's name when this document does not know the scene");
});

test("two agents on the same spot stack their tags 18 px apart", () => {
  const [nova, juno] = places([presence(), presence({ agent: JUNO, call: 40, label: "inspect Title" })]);
  assert.equal(nova.y, 80 - TAG_PX);
  assert.equal(nova.y - juno.y, STACK_PX, "upward, off the layer it names");
  assert.equal(juno.x, nova.x);
  const [low, high] = places([presence({ target: { sceneId: "intro", layerIds: ["logo"] } }), presence({ agent: JUNO, target: { sceneId: "intro", layerIds: ["logo"] } })]);
  assert.deepEqual([low.y, high.y], [0, STACK_PX], "down when the stage has no room above");
  // Tags clash by their width: a long one at the top left meets one 150 px along; a short one does not.
  const near = { boxOf: () => ({ left: 150, top: 16, width: 50, height: 20 }) };
  const [long, along] = places([presence({ target: null, label: "read the outline" }), presence({ agent: JUNO, target: { sceneId: "intro", layerIds: ["x"] } })], near);
  assert.deepEqual([long.y, along.y], [0, STACK_PX]);
  const [short, apart] = places([presence({ target: null, label: "look" }), presence({ agent: JUNO, target: { sceneId: "intro", layerIds: ["x"] } })], near);
  assert.deepEqual([short.y, apart.y], [0, 0]);
  const [a, b] = places([presence({ target: null }), presence({ agent: JUNO, target: null })]);
  assert.deepEqual([a.y, b.y], [0, STACK_PX], "both at the top left");
  const [c, d] = places([presence({ target: { sceneId: "outro" } }), presence({ agent: JUNO, target: { sceneId: "outro" } })]);
  assert.deepEqual([c.y, d.y], [0, STACK_PX], "both at the edge");
  const [e, f] = places([presence(), presence({ agent: JUNO, target: { sceneId: "intro", layerIds: ["logo"] } })]);
  assert.equal(e.y === f.y, false, "near spots do not overlap either");
  const [g, h] = places([presence({ target: null }), presence({ agent: JUNO, target: null })], { height: 20 });
  assert.equal(h.y, 20 - TAG_PX, "a stack never leaves the stage at the bottom");
  assert.ok(g.y <= h.y);
});

test("timeline px for a time and a range, at three durations", () => {
  for (const [duration, width, t, range, x, span] of [
    [1, 800, 0.5, [0.25, 0.75], 400, { x: 200, width: 400 }],
    [15, 600, 3, [2, 3.5], 120, { x: 80, width: 60 }],
    [600, 1200, 450, [0, 600], 900, { x: 0, width: 1200 }],
  ]) {
    assert.equal(timelineX(t, duration, width), x, `${t} s of ${duration} s`);
    assert.deepEqual(timelineSpan(range, duration, width), span, `${range} of ${duration} s`);
  }
  assert.equal(timelineX(-1, 10, 500), 0, "kept on the track");
  assert.equal(timelineX(11, 10, 500), 500);
  assert.equal(timelineX(1, 10, 0), 0, "no track yet");
  assert.equal(timelineSpan([2, 2], 10, 500).width, 1, "at least 1 px");
});

test("the timeline draws a line at a call's time, a tint over its range, and nothing for another scene", () => {
  const options = { sceneId: "intro", duration: 4, trackWidth: 400 };
  assert.deepEqual(timelineMarks([presence()], options).map(({ range, x, width }) => [range, x, width]), [[true, 100, 100]]);
  assert.deepEqual(timelineMarks([presence({ target: { sceneId: "intro", time: 0.5, range: null } })], options).map(({ range, x, width }) => [range, x, width]), [[false, 50, 1]]);
  assert.equal(timelineMarks([presence({ target: { sceneId: "outro", range: [1, 2] } })], options).length, 0);
  assert.equal(timelineMarks([presence({ target: { sceneId: "intro", layerIds: ["title"] } })], options).length, 0, "no time, no mark");
  assert.equal(timelineMarks([presence()], { ...options, trackWidth: 0 }).length, 0, "before the track is measured");
  const chips = chipPlaces(timelineMarks([presence(), presence({ agent: JUNO })], options));
  assert.deepEqual(chips.map((chip) => [chip.text, chip.x, chip.y]), [["Nova", 100, 0], ["Juno", 100, 15]]);
});

test("building marks are the scene's own, and hide 2 min after the newest write", () => {
  const live = {
    latest: { a1: write({ at: new Date(T0 + 1000).toISOString() }) },
    building: [{ sceneId: "intro", layerId: "title", agentId: "a1", at: new Date(T0).toISOString() }, { sceneId: "outro", layerId: "end", agentId: "a1", at: new Date(T0).toISOString() }],
    skew: 0,
  };
  assert.deepEqual([...buildingIds(live, "intro", T0 + 2000)], ["title"]);
  assert.deepEqual([...buildingIds(live, "outro", T0 + 2000)], ["end"]);
  assert.deepEqual([...buildingIds(live, "intro", T0 + 1000 + TURN_GAP_MS)], ["title"], "still at 2 min");
  assert.equal(buildingIds(live, "intro", T0 + 1001 + TURN_GAP_MS).size, 0, "hidden past 2 min");
  assert.equal(buildingIds({ latest: {}, building: [] }, "intro", T0).size, 0);
  assert.equal(buildingIds(undefined, "intro", T0).size, 0);
  // Reads after the write (a look, a render wait every 15 s) do not keep the marks up.
  const reading = { ...live, latest: { a1: presence({ at: new Date(T0 + 1000 + TURN_GAP_MS).toISOString() }) } };
  assert.equal(buildingIds(reading, "intro", T0 + 1 + TURN_GAP_MS).size, 0, "a read is not a write");
});

test("one timer: the next change is the nearest of fresh, flash, steady, fade and the turn gap", () => {
  const live = liveOf(write());
  assert.equal(nextChangeAt(live, T0 + 10), T0 + FLASH_MS);
  assert.equal(nextChangeAt(live, T0 + FLASH_MS), T0 + 1000);
  assert.equal(nextChangeAt(live, T0 + 1000), T0 + STEADY_MS);
  assert.equal(nextChangeAt(live, T0 + STEADY_MS), T0 + SHOWN_MS);
  assert.equal(nextChangeAt(live, T0 + SHOWN_MS), T0 + SHOWN_MS + FADE_MS);
  assert.equal(nextChangeAt(live, T0 + SHOWN_MS + FADE_MS), null, "nothing more without building marks");
  live.building = [{ sceneId: "intro", layerId: "title", agentId: "a1", at: new Date(T0).toISOString() }];
  assert.equal(nextChangeAt(live, T0 + SHOWN_MS + FADE_MS), T0 + TURN_GAP_MS + 1);
  assert.equal(nextChangeAt({ latest: {}, building: [] }, T0), null);
});

test("a write that did not run says so: held (you paused writes) or refused (a stop waits)", () => {
  assert.equal(announceText(write({ held: true, changed: null })), "Nova: move Title, held (nothing changed)");
  assert.equal(announceText(write({ refused: "C1", changed: null })), "Nova: move Title, refused: a stop waits (nothing changed)");
  const [held] = places([write({ held: true, changed: null })]);
  assert.equal(held.text, "Nova: move Title, held");
  const [refused] = places([write({ refused: "C1", changed: null })]);
  assert.equal(refused.text, "Nova: move Title, refused");
  // The log row: the label, then what happened.
  assert.equal(callLine({ verb: "edit", label: "move Title", held: true, summary: "held: the person paused agent writes" }), "move Title, held: the person paused agent writes");
  assert.equal(callLine({ verb: "edit", label: "move Title", waiting: "C1", summary: "waiting for you: C1 rough" }), "move Title, waiting for you: C1 rough");
  assert.equal(callLine({ verb: "edit", label: "move Title", isError: true, summary: "error: no layer" }), "move Title, error: no layer");
  assert.equal(callLine({ verb: "edit", label: "move Title", summary: "{\"rev\":4}" }), "move Title");
  assert.equal(callLine({ verb: "status", summary: "p1 rev 4" }), "status p1 rev 4");
});

// Review round 2: a call that waits for your approval has not run, and a failed call did not do
// what its label says. The marker, the screen reader and the log say so.
test("a call that waits for your approval, or failed, says so: not as if it ran", () => {
  const asked = presence({ verb: "project", label: "share view link", target: null, approval: "Q3" });
  assert.equal(announceText(asked), "Nova: share view link, waits for your approval (not run yet)");
  const [waits] = places([asked]);
  assert.equal(waits.text, "Nova: share view link, waits for you");
  const failed = write({ isError: true, changed: null });
  assert.equal(announceText(failed), "Nova: move Title, failed");
  const [broke] = places([failed]);
  assert.equal(broke.text, "Nova: move Title, failed");
  assert.equal(places([presence()])[0].text, "Nova: look at 1.0–2.0 s", "a call that ran has no outcome");
  assert.equal(callLine({ verb: "project", label: "share view link", approval: "Q3", summary: "{\"status\":\"awaiting_approval\"}" }), "share view link, waits for your approval Q3");
});

test("the stage draws no building outlines while it plays; the timeline keeps them", () => {
  const live = { latest: { a1: presence() }, building: [{ sceneId: "intro", layerId: "title", agentId: "a1", at: new Date(T0).toISOString() }], skew: 0 };
  assert.deepEqual(stageBuilding(live, "intro", T0 + 1000).map((entry) => entry.layerId), ["title"]);
  assert.deepEqual(stageBuilding(live, "intro", T0 + 1000, { playing: true }), []);
  assert.deepEqual([...buildingIds(live, "intro", T0 + 1000)], ["title"]);
  const many = { ...live, building: Array.from({ length: 80 }, (_, index) => ({ sceneId: "intro", layerId: `l${index}`, agentId: "a1", at: new Date(T0).toISOString() })) };
  assert.equal(stageBuilding(many, "intro", T0 + 1000).length, 50, "at most 50 outlines");
});

test("follow agent: only a write that just started in another scene moves the stage, at most once every 2 s", () => {
  const scenes = { sceneId: "intro", sceneIds: ["intro", "outro"] };
  const started = (fields = {}) => write({ phase: "start", changed: null, target: { sceneId: "outro", layerIds: [], time: 3, range: null, text: "outro" }, ...fields });
  assert.deepEqual(followStart(started(), { ...scenes, now: T0 + 200 }), { sceneId: "outro", time: 3 });
  assert.equal(followStart(started({ verb: "look", write: false }), { ...scenes, now: T0 + 200 }), null, "a read in another scene stays at the edge");
  assert.equal(followStart(started({ verb: "status", write: false, target: { sceneId: "outro", text: "outro" } }), { ...scenes, now: T0 + 200 }), null, "status does not reset the time");
  assert.equal(followStart(started(), { ...scenes, now: T0 + 1200 }), null, "over a second old: a snapshot or a reload");
  assert.equal(followStart(started(), { ...scenes, now: T0 + 200, lastAt: T0 + 200 - FOLLOW_GAP_MS + 1 }), null, "moved under 2 s ago");
  assert.deepEqual(followStart(started(), { ...scenes, now: T0 + 200, lastAt: T0 + 200 - FOLLOW_GAP_MS }), { sceneId: "outro", time: 3 });
  assert.equal(followStart(started({ target: { sceneId: "intro", layerIds: [], text: "intro" } }), { ...scenes, now: T0 + 200 }), null, "already on the stage");
  assert.equal(followStart(started({ target: { sceneId: "gone", layerIds: [], text: "gone" } }), { ...scenes, now: T0 + 200 }), null, "a scene this video has not");
  assert.equal(followStart(started({ phase: "done" }), { ...scenes, now: T0 + 200 }), null);
  assert.deepEqual(followStart(started({ target: { sceneId: "outro", range: [2, 4], text: "outro" } }), { ...scenes, now: T0 + 200 }), { sceneId: "outro", time: 2 });
});

test("the screen reader's line for each kind of call", () => {
  assert.equal(announceText(presence()), "Nova is looking at Title, 1.0–2.0 s");
  assert.equal(announceText(presence({ verb: "inspect", target: { text: "Title, Logo" } })), "Nova is looking at Title, Logo");
  assert.equal(announceText(presence({ verb: "status", target: { sceneId: "intro", text: "intro" } })), "Nova is looking at intro");
  assert.equal(announceText(presence({ verb: "check", phase: "start", target: { text: "S1" } })), "Nova is looking at S1");
  assert.equal(announceText(write({ phase: "start", changed: null })), "Nova is changing Title");
  assert.equal(announceText(write()), "Nova changed Title");
  assert.equal(announceText(write({ isError: true, changed: null })), "Nova: move Title, failed");
  assert.equal(announceText(write({ write: false, label: "try: move Title", changed: null })), "Nova: try: move Title");
  assert.equal(announceText(presence({ verb: "project", label: "create a share link", target: null })), "Nova: create a share link");
  assert.equal(announceText(presence({ verb: "look", target: null, label: "look at the whole scene" })), "Nova: look at the whole scene");
  assert.equal(announceText(presence({ agent: JUNO, verb: "render", label: "render draft", target: null })), "Juno: render draft");
  assert.equal(announceText(null), "");
});

test("the live line: at most one every 4 s, the newest waiting line wins, and a repeat is skipped", () => {
  let now = 0;
  const timers = [];
  const said = [];
  const announcer = createAnnouncer({
    onLine: (text) => said.push([now, text]), clock: () => now,
    setTimer: (run, wait) => { timers.push({ run, at: now + wait }); return timers.length; }, clearTimer: () => {},
  });
  const runTimers = (until) => {
    for (;;) {
      const due = timers.filter((timer) => !timer.done && timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.done = true;
      now = due.at;
      due.run();
    }
    now = until;
  };
  announcer.say("Nova is looking at Title");
  assert.deepEqual(said, [[0, "Nova is looking at Title"]], "the first line at once");
  now = 500; announcer.say("Nova is changing Title");
  now = 900; announcer.say("Nova changed Title");
  runTimers(3999);
  assert.equal(said.length, 1, "nothing more within 4 s");
  runTimers(4000);
  assert.deepEqual(said.at(-1), [4000, "Nova changed Title"], "the newest waiting line, when the gap ends");
  assert.equal(said.length, 2, "the line in between is dropped");
  now = 9000; announcer.say("Nova changed Title");
  assert.equal(said.length, 2, "the same line again is skipped");
  announcer.say("Juno: render draft");
  assert.deepEqual(said.at(-1), [9000, "Juno: render draft"]);
  now = 9100; announcer.say("Nova is looking at Logo");
  announcer.stop();
  runTimers(20_000);
  assert.equal(said.length, 3, "stop drops what waits");
});

test("every agent seen in the last 10 min keeps a bot on the stage, in a steady order", () => {
  const atlas = { id: "a10", name: "Atlas", color: "#e0a050" };
  const live = liveOf(
    presence({ agent: JUNO, at: new Date(T0 + 5000).toISOString() }),
    presence({ agent: atlas, at: new Date(T0 + 9000).toISOString() }),
    presence(),
  );
  assert.deepEqual(stageCrew(live, T0 + 60_000).map((entry) => entry.agent.id), ["a1", "a2", "a10"], "a1, a2, a10 whoever called last");
  assert.deepEqual(stageCrew(live, T0 + START_MS + 1).map((entry) => entry.agent.id), ["a2", "a10"], "Nova's last call is over 10 min old");
  assert.deepEqual(stageCrew(null, T0), []);
});

test("resting bots: in the bottom margin, else a left margin a bot fits in, else dimmed over the frame's corner", () => {
  const frame = { width: 800, height: 450 };
  // A tall bottom margin: side by side from the pane's left edge, 64 px slots, above the pane's bottom.
  const bottom = restPlaces(2, { ...frame, room: { left: 20, right: 20, top: 30, bottom: 60 } });
  assert.equal(bottom.over, false);
  assert.deepEqual(bottom.places, [{ x: -20 + 6 + 18, y: 450 + 60 - 6 - REST_ROW_PX }, { x: -20 + 6 + 64 + 18, y: 450 + 60 - 6 - REST_ROW_PX }]);
  assert.ok(bottom.places.every((place) => place.y >= 450), "under the frame, not over it");
  // A narrow left margin (29 px, a 16:9 frame in a wide pane): one bot a row, stacked upward,
  // inside the margin and clear of the frame's corner mark.
  const side = restPlaces(2, { ...frame, room: { left: 29, right: 29, top: 0, bottom: 0 } });
  assert.equal(side.over, false);
  assert.equal(side.slot, 29);
  for (const place of side.places) assert.ok(place.x >= -29 && place.x + STAGE_BOT_PX <= 0, `inside the margin: ${place.x}`);
  assert.equal(side.places[0].y, 450 - 12 - REST_ROW_PX);
  assert.equal(side.places[1].y, side.places[0].y - REST_ROW_PX, "the next one rests above");
  // No room: over the frame's bottom left corner, marked `over` (drawn dimmed).
  const over = restPlaces(1, { ...frame, room: { left: 4, right: 4, top: 0, bottom: 0 } });
  assert.equal(over.over, true);
  assert.deepEqual(over.places, [{ x: 6 + 18, y: 450 - 6 - REST_ROW_PX }]);
  // Not measured yet: over the frame too.
  assert.equal(restPlaces(1, { ...frame, room: null }).over, true);
});

test("a riding bot sits just under and right of its cursor's tip, inside the frame", () => {
  assert.deepEqual(ridePlace({ x: 100, y: 80 }, { width: 800, height: 450 }), { x: 110, y: 96 });
  assert.deepEqual(ridePlace({ x: 795, y: 445 }, { width: 800, height: 450 }), { x: 800 - STAGE_BOT_PX, y: 450 - STAGE_BOT_PX });
});
