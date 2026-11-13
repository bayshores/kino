// Milestone LIVE, parts 1 and 3, in a real browser: the agents' live markers on the dashboard
// (frontend/dashboard/presence.jsx). The test plays several agents at once through
// POST /api/agent/<verb>, each with its own x-kino-session header (what the thin client adds by
// itself), and checks what the page draws: the named, colored tag over what a call is about, the
// one flash on what a write changed, the striped "building" mark until a look covers the layer,
// the tag at the stage's edge for an agent in another scene, the steady outline under reduced
// motion, the screen reader's line, and that only transform and opacity ever animate.
//
// The harness (Electron's Chromium, Vite, a real kino server with a temporary data folder) is
// tests/dashboard-browser.support.mjs. Set KINO_DASHBOARD_SHOTS=<folder> to keep a screenshot
// of each step.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { q, sleep, startDashboard, textOf, until } from "./dashboard-browser.support.mjs";

// The sessions' first calls are made in this order, so the server names them Nova (a1), Juno (a2),
// Atlas (a3), Iris (a4), Orion (a5) and Vega (a6) whichever test runs alone.
const SESSIONS = ["test-nova", "test-juno", "test-atlas", "test-iris", "test-orion", "test-vega"];
const NOVA = { session: SESSIONS[0], id: "a1", name: "Nova", color: "rgb(66, 192, 182)" };
const JUNO = { session: SESSIONS[1], id: "a2", name: "Juno", color: "rgb(108, 182, 255)" };

let dashboard;
let server;
let browser;
let firstScene;
let outroScene;

/** One agent call. `session` is the agent's x-kino-session header; none is the older "agent". */
async function agent(verb, body = {}, session = null) {
  const response = await server.api(`/api/agent/${verb}`, {
    method: "POST", body: { client: "claude-code", ...body }, headers: session ? { "x-kino-session": session } : {},
  });
  assert.equal(response.status, 200, `${verb} answers 200`);
  const reply = await response.json();
  assert.ok(!reply.isError, `${verb}: ${reply.text}`);
  return reply;
}

async function snapshot() {
  return (await server.api("/api/dashboard/snapshot?project=pulse")).json();
}

const layerId = (scene, name) => scene.layers.find((layer) => layer.name === name)?.id;
const tagOf = (agentId) => q(`.presence-tag[data-agent="${agentId}"]`);
const rect = (expression) => `(() => { const element = ${expression}; if (!element) return null; const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; })()`;

/** The text a layer's row button is described by (aria-describedby), "" for none. */
const describedBy = (name) => `(() => {
  const row = [...document.querySelectorAll(".p-timeline .row-button")].find((element) => element.innerText.trim() === ${JSON.stringify(name)});
  return (row?.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
})()`;

/** The shot strip is the default timeline; the layers' rows and the agents' lanes show after "Show every lane and layer". */
async function fullTimeline() {
  const toggle = q('.p-timeline .strip-toggle[aria-label="Show every lane and layer"]');
  if (await browser.evaluate(`!!${toggle}`)) await browser.click(toggle, "Show every lane and layer");
  await browser.waitFor(`!!document.querySelector(".p-timeline .row-button")`, { what: "the layers' rows" });
}

/** Waits until no agent's marker is on the stage (each fades 5 s after its call). */
async function quiet() {
  await browser.waitFor(`document.querySelectorAll(".presence-tag").length === 0`, { timeout: 8000, what: "no live marker on the stage" });
}

/** The contrast of an element's text against its own background, worked out in the page (WCAG 2). */
const contrastOf = (expression) => `(() => {
  const element = ${expression};
  if (!element) return null;
  const style = getComputedStyle(element);
  const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const light = (color) => { const [r, g, b] = color.match(/[\\d.]+/g).map(Number); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
  const [a, b] = [light(style.color), light(style.backgroundColor)].sort((x, y) => y - x);
  return { ratio: (a + 0.05) / (b + 0.05), color: style.color, background: style.backgroundColor };
})()`;

before(async () => {
  dashboard = await startDashboard({ prefix: "kino-dashboard-presence-" });
  ({ server, browser } = dashboard);

  // Each session's first call, before any project exists: it names the agent and shows nothing.
  for (const session of SESSIONS) await server.api("/api/agent/status", { method: "POST", body: { client: "claude-code" }, headers: { "x-kino-session": session } });

  // The project, made by an older client (no session): it is the "agent".
  await agent("project", { action: "create", id: "pulse", name: "Pulse", width: 640, height: 360, duration: 2 });
  await agent("edit", { ops: [
    { op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 120, y: 170, width: 400, height: 140, fill: "#1b2a4a", radius: 12 } },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "Pulse", x: 170, y: 60, width: 300, height: 70, fontSize: 56, fontWeight: 700, fill: "#ffb38a", textAlign: "center" } },
    { op: "add_scene", name: "outro", width: 640, height: 360, duration: 2, background: "#0b1020" },
    { op: "add_layer", scene: "outro", layerType: "text", name: "bye", properties: { text: "Bye", x: 220, y: 140, width: 200, height: 70, fontSize: 56, fill: "#ffffff", textAlign: "center" } },
  ] });
  [firstScene, outroScene] = (await snapshot()).record.document.scenes;
  // A look over each whole scene checks what the setup made, so no layer starts out "building".
  await agent("look", { mode: "sheet", scene: firstScene.id });
  await agent("look", { mode: "sheet", scene: outroScene.id });
  assert.deepEqual((await snapshot()).presence.building, [], "the setup leaves no building marks");
  // The setup's agent is done with what it made: it lets go of the parts it holds (crew locks),
  // so Nova and the others can change them.
  await agent("notes", { action: "release", project: "pulse" });

  await dashboard.open();
  await fullTimeline();
  await quiet();
});

after(async () => {
  await dashboard?.stop();
});

test("a look puts the agent's named, colored tag over what it looks at, and the live line says so", async () => {
  await agent("look", { mode: "zoom", layer: "title", t: 1 }, NOVA.session);

  // The tag sits just above the outline of the layer the look names, in Nova's color.
  const placed = await browser.waitFor(`(() => {
    const tag = ${rect(tagOf(NOVA.id))};
    const box = ${rect(q(".presence-box"))};
    const stage = ${rect(q(".presence-stage"))};
    if (!tag || !box) return null;
    const text = ${tagOf(NOVA.id)}.innerText;
    return Math.abs(tag.bottom - box.top) <= 1.5 && Math.abs(tag.left - box.left) <= 1.5 ? { tag, box, stage, text } : null;
  })()`, { what: "Nova's tag just above the title's outline" });
  assert.match(placed.text, /^Agent 1: /);
  assert.equal(await browser.evaluate(`getComputedStyle(${tagOf(NOVA.id)}).backgroundColor`), NOVA.color);
  // The outline is the layer's box on the stage, both measured in the same frame (the stage
  // changes size when the live line under it changes).
  const { box, stage } = placed;
  assert.ok(Math.abs(box.width / stage.width - 300 / 640) < 0.01, `the outline is the title's width (${box.width} of ${stage.width} px)`);
  // Nova's cursor, in Nova's color, glides to the middle of the outline (its tip is the svg's corner).
  const cursor = q(`.presence-cursor[data-agent="${NOVA.id}"]`);
  const tip = await browser.waitFor(`(() => {
    const at = ${rect(cursor)};
    const box = ${rect(q(".presence-box"))};
    if (!at || !box) return null;
    const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    return Math.abs(at.left - middle.x) <= 1.5 && Math.abs(at.top - middle.y) <= 1.5 ? at : null;
  })()`, { what: "Nova's cursor at the middle of the title" });
  assert.ok(tip.width > 0);
  assert.equal(await browser.evaluate(`getComputedStyle(${cursor}).fill`), NOVA.color);
  // The timeline names the agent too, at the look's time.
  await browser.waitFor(`${q(`.presence-chip[data-agent="${NOVA.id}"]`)}?.innerText === "Agent 1"`, { what: "Nova's chip on the timeline" });
  assert.ok(await browser.evaluate(`!!document.querySelector(".presence-span:not(.is-range)")`), "a line at the look's time");
  // Review round 2: the chip is never over a turn's button. The turns are marks on each agent's
  // own lane now, and the chip stays off those lanes altogether.
  const turns = await browser.waitFor(`(() => {
    const chip = ${q(`.presence-chip[data-agent="${NOVA.id}"]`)}.getBoundingClientRect();
    const over = (box) => box.left < chip.right && chip.left < box.right && box.top < chip.bottom && chip.top < box.bottom;
    const boxes = [...document.querySelectorAll(".p-timeline .lane-agent .agent-mark")].map((element) => element.getBoundingClientRect());
    if (!boxes.length) return null;
    const lanes = [...document.querySelectorAll(".p-timeline .lane-agent")].map((element) => element.getBoundingClientRect());
    return { hits: boxes.filter(over).length, lanes: lanes.filter(over).length, chip: [chip.top, chip.bottom] };
  })()`, { what: "the agent's turns on the timeline" });
  assert.equal(turns.hits, 0, `the name chip covers no turn: ${JSON.stringify(turns)}`);
  assert.equal(turns.lanes, 0, `the chip is off the agents' lanes: ${JSON.stringify(turns)}`);
  // The screen reader hears it.
  const line = await browser.waitFor(`(${q(".presence-sr")}?.textContent ?? "").startsWith("Agent 1 is looking at") && ${q(".presence-sr")}.textContent`, { what: "the live line" });
  assert.match(line, /title/);
  assert.equal(await browser.evaluate(`${q(".presence-sr")}.getAttribute("aria-live")`), "polite");
  await browser.shot("presence-look");
});

test("each agent keeps one bot on the stage: beside its cursor during a call, then at rest off the picture; it takes no click and stays quiet while the stage plays", async () => {
  await agent("inspect", { targets: ["card"] }, JUNO.session);
  const bot = q(`.stage-bot[data-agent="${JUNO.id}"]`);
  // While the call shows, Juno's bot (28 px) rides just under and right of Juno's cursor tip.
  await browser.waitFor(`(() => {
    const at = ${bot}?.classList.contains("is-riding") && ${bot}.getBoundingClientRect();
    const tip = ${q(`.presence-cursor[data-agent="${JUNO.id}"]`)}?.getBoundingClientRect();
    if (!at || !tip) return null;
    return Math.abs(at.left - tip.left - 10) <= 2 && Math.abs(at.top - tip.top - 16) <= 2 && Math.round(at.width) === 28;
  })()`, { what: "Juno's bot beside its cursor" });
  // 5 s after the call it glides back to rest, with its name under it, outside the picture (or
  // dimmed over its corner when the frame fills the pane).
  const rest = await browser.waitFor(`(() => {
    const element = ${bot};
    if (!element || element.classList.contains("is-riding") || element.getAnimations().length) return null;
    const at = element.getBoundingClientRect();
    const frame = ${q(".stage")}.getBoundingClientRect();
    const pane = ${q(".stage-wrap")}.getBoundingClientRect();
    const overFrame = at.left < frame.right && frame.left < at.right && at.top < frame.bottom && frame.top < at.bottom;
    return {
      inPane: at.left >= pane.left - 0.5 && at.right <= pane.right + 0.5 && at.top >= pane.top - 0.5 && at.bottom <= pane.bottom + 0.5,
      overFrame, dimmed: Number(getComputedStyle(element).opacity) < 1, name: element.querySelector(".stage-bot-name").innerText,
      clicks: getComputedStyle(element).pointerEvents, hidden: element.closest("[aria-hidden=true]") !== null,
    };
  })()`, { timeout: 9000, what: "Juno's bot at rest" });
  assert.equal(rest.inPane, true, JSON.stringify(rest));
  assert.ok(!rest.overFrame || rest.dimmed, `a resting bot over the picture is dimmed: ${JSON.stringify(rest)}`);
  assert.equal(rest.name, "Agent 2");
  assert.equal(rest.clicks, "none", "a click goes through to the stage, its notes and findings");
  assert.equal(rest.hidden, true, "decoration: the live line and the panes name the agents");
  // One bot per agent seen in the last 10 min, whatever it did last.
  const ids = await browser.evaluate(`[...document.querySelectorAll(".stage-bot")].map((element) => element.dataset.agent)`);
  assert.ok(ids.includes(NOVA.id) && ids.includes(JUNO.id) && new Set(ids).size === ids.length, ids.join(", "));
  // While the stage plays, the bots ask for no animation frames.
  await browser.click(q(".play-button"), "Play");
  await sleep(400);
  const frames = await browser.evaluate(`(async () => { const before = window.kinoBotLoop.frames; await new Promise((done) => setTimeout(done, 1200)); return window.kinoBotLoop.frames - before; })()`);
  await browser.click(q(".play-button"), "Pause");
  assert.equal(frames, 0, "no bot frames during playback");
  await quiet();
});

test("a write flashes what it changed once, marks it building, and a look that covers it clears the mark", async () => {
  const title = layerId(firstScene, "title");
  await agent("edit", { ops: [{ op: "update_layer", layer: "title", properties: { fill: "#2f6fd0" } }] }, NOVA.session);

  // Mid-flash (about 400 ms in, inside the 200–600 ms hold) the fill and outline are at full strength.
  await browser.waitFor(`!!document.querySelector(".presence-flash")`, { timeout: 5000, what: "the flash" });
  const middle = await browser.evaluate(`new Promise((done) => {
    const flash = document.querySelector(".presence-flash");
    const animation = flash.getAnimations()[0];
    const wait = () => (animation.currentTime >= 380 ? done({ time: animation.currentTime, opacity: Number(getComputedStyle(flash).opacity), name: animation.animationName }) : requestAnimationFrame(wait));
    wait();
  })`);
  await browser.shot("presence-flash");
  assert.equal(middle.name, "presence-flash");
  assert.ok(middle.time < 600, `read in the hold (${middle.time} ms)`);
  assert.ok(middle.opacity > 0.95, `full strength mid-flash (${middle.opacity})`);
  // It runs once: gone a second later, and the same write never flashes again.
  await browser.waitFor(`!document.querySelector(".presence-flash")`, { timeout: 1500, what: "the flash to end" });
  await sleep(300);
  assert.equal(await browser.evaluate(`document.querySelectorAll(".presence-flash").length`), 0, "the flash does not come back");

  // Building: the title's timeline row is striped and the stage shows a quiet outline, until a look covers it.
  await browser.waitFor(`!!document.querySelector(".track.is-building") && !!document.querySelector(".presence-building")`, { what: "the building marks" });
  assert.equal(await browser.evaluate(`document.querySelectorAll(".track.is-building").length`), 1, "only the changed layer is building");
  assert.deepEqual((await snapshot()).presence.building.map((entry) => entry.layerId), [title]);
  // A screen reader hears it too: the title's row button is described by the building note.
  assert.match(await browser.evaluate(describedBy("title")), /^building: an agent changed it this turn and has not looked at it since$/);
  assert.equal(await browser.evaluate(describedBy("card")), "", "the card is not building");
  await browser.shot("presence-building");
  await agent("look", { mode: "sheet", from: 0, to: 2 }, NOVA.session);
  await browser.waitFor(`!document.querySelector(".track.is-building") && !document.querySelector(".presence-building")`, { what: "the building marks to clear" });
  assert.equal(await browser.evaluate(describedBy("title")), "", "checked: no longer described as building");
  assert.deepEqual((await snapshot()).presence.building, []);
  // The sheet's range shows on the timeline as a tint.
  await browser.waitFor(`!!document.querySelector(".presence-span.is-range")`, { what: "the look's range on the timeline" });
  await browser.shot("presence-cleared");
});

test("an older turn's checkpoint shows no live marks; back to now shows them again", async () => {
  await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { radius: 16 } }] }, NOVA.session);
  await browser.waitFor(`!!document.querySelector(".presence-building") && !!${tagOf(NOVA.id)}`, { what: "Nova's tag and the building outline" });
  // The first turn's mark on the agent's lane: the stage shows that turn's frame, which the marks are not about.
  // A loaded machine can draw the lane after the outline: wait for the mark, then click it once.
  await browser.waitFor(`(() => { const mark = ${q(".p-timeline .lane-agent .agent-mark")}; if (!mark) return false; mark.click(); return true; })()`, { what: "the first turn's mark on the agent's lane" });
  await browser.waitFor(`${textOf(".stage-label")}.includes("checkpoint")`, { what: "the first turn's checkpoint" });
  assert.equal(await browser.evaluate(`document.querySelectorAll(".presence-stage, .presence-tag, .presence-box, .presence-building, .presence-flash").length`), 0, "no marks on the checkpoint");
  await browser.shot("presence-checkpoint");
  await browser.key("Escape");
  await browser.waitFor(`!${textOf(".stage-label")}.includes("checkpoint") && !!document.querySelector(".presence-building")`, { what: "now, with the building outline" });
  await agent("look", { mode: "sheet", from: 0, to: 2 }, NOVA.session);
  await browser.waitFor(`!document.querySelector(".presence-building")`, { what: "the card checked" });
  await quiet();
});

test("two agents get two names and colors that read, and one in another scene shows at the stage's edge", async () => {
  // The scene menu in the stage's toolbar names the scene the stage shows.
  const stageScene = `(${q("#scene-menu .menu-value")} ?? ${q(".stage-toolbar .scene-name")})?.innerText.trim()`;
  assert.equal(await browser.evaluate(stageScene), firstScene.name, "the stage shows the first scene");
  await agent("look", { mode: "zoom", layer: "bye", t: 1 }, JUNO.session);
  // A read never moves the stage (follow agent moves it for a write): Juno's look in the outro
  // shows at the stage's edge while the stage stays on the first scene.
  await browser.waitFor(`${tagOf(JUNO.id)}?.classList.contains("is-edge")`, { what: "Juno's tag at the edge" });
  await sleep(1200);
  assert.equal(await browser.evaluate(stageScene), firstScene.name, "still the first scene after Juno's read");
  await agent("look", { mode: "frame", t: 0.5, scene: firstScene.id }, NOVA.session);
  const edge = await browser.waitFor(`(() => {
    const tag = ${tagOf(JUNO.id)};
    if (!tag || !tag.classList.contains("is-edge") || !${tagOf(NOVA.id)}) return null;
    const place = ${rect(tagOf(JUNO.id))};
    const stage = ${rect(q(".presence-stage"))};
    // It glides there in 180 ms: wait until it has arrived.
    return Math.abs(place.right - stage.right) <= 1.5 ? { text: tag.innerText, place, stage } : null;
  })()`, { what: "Juno's tag at the stage's right edge and Nova's tag" });
  assert.equal(edge.text, "Agent 2 in outro");
  assert.ok(edge.place.top >= edge.stage.top && edge.place.bottom <= edge.stage.bottom, "inside the stage");
  // Two colors, each with text that reads at 4.5:1 or more (WCAG AA).
  const nova = await browser.evaluate(contrastOf(tagOf(NOVA.id)));
  const juno = await browser.evaluate(contrastOf(tagOf(JUNO.id)));
  assert.equal(nova.background, NOVA.color);
  assert.equal(juno.background, JUNO.color);
  assert.ok(nova.ratio >= 4.5, `Nova's tag reads at ${nova.ratio.toFixed(2)}:1`);
  assert.ok(juno.ratio >= 4.5, `Juno's tag reads at ${juno.ratio.toFixed(2)}:1`);
  assert.match(await browser.evaluate(`${tagOf(NOVA.id)}.innerText`), /^Agent 1: /);
  await browser.shot("presence-two-agents");
});

test("under reduced motion nothing moves: a write gets a steady outline instead of the flash", async () => {
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await browser.waitFor(`matchMedia("(prefers-reduced-motion: reduce)").matches`, { what: "reduced motion" });
    await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { fill: "#24365e" } }] }, NOVA.session);
    await browser.waitFor(`!!document.querySelector(".presence-steady")`, { timeout: 5000, what: "the steady outline" });
    const still = await browser.evaluate(`({
      flashes: document.querySelectorAll(".presence-flash").length,
      animations: document.getAnimations().map((animation) => animation.animationName ?? animation.transitionProperty ?? "?"),
      outline: getComputedStyle(document.querySelector(".presence-steady")).outlineWidth,
      stilled: !!document.querySelector(".presence-stage.presence-still"),
    })`);
    await browser.shot("presence-reduced-motion");
    assert.equal(still.flashes, 0, "no flash");
    assert.deepEqual(still.animations, [], "nothing on the page animates");
    assert.equal(still.outline, "2px");
    assert.ok(still.stilled);
    // The outline goes after 1.5 s.
    await browser.waitFor(`!document.querySelector(".presence-steady")`, { timeout: 2500, what: "the steady outline to go" });
  } finally {
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  }
});

test("six agents' quick calls draw one tag each, animate only transform and opacity, and the live line changes at most once every 4 s", async () => {
  // While the calls run, the page notes every animated property of the markers, the most tags at
  // once, and each change of the screen reader's line.
  await browser.evaluate(`(() => {
    const probe = window.presenceProbe = { properties: [], others: [], most: 0, doubled: false, lines: [] };
    const skip = new Set(["offset", "computedOffset", "easing", "composite"]);
    probe.timer = setInterval(() => {
      for (const animation of document.getAnimations()) {
        const marker = animation.effect?.target?.closest?.(".presence-stage, .presence-timeline");
        for (const frame of animation.effect?.getKeyframes?.() ?? []) for (const name of Object.keys(frame)) {
          if (skip.has(name)) continue;
          const list = marker ? probe.properties : probe.others;
          if (!list.includes(name)) list.push(name);
        }
      }
      const tags = [...document.querySelectorAll(".presence-tag")].map((tag) => tag.dataset.agent);
      probe.most = Math.max(probe.most, tags.length);
      if (new Set(tags).size !== tags.length) probe.doubled = true;
    }, 30);
    const line = document.querySelector(".presence-sr");
    probe.lines.push({ at: performance.now(), text: line.textContent, first: true });
    probe.observer = new MutationObserver(() => probe.lines.push({ at: performance.now(), text: line.textContent }));
    probe.observer.observe(line, { childList: true, characterData: true, subtree: true });
  })()`);

  // 6 agents × 10 calls, each agent one after another and all six at once, as fast as they answer.
  const began = Date.now();
  const calls = [
    () => ({ verb: "status", body: {} }),
    () => ({ verb: "inspect", body: { targets: ["title"] } }),
    () => ({ verb: "inspect", body: { targets: ["card"] } }),
  ];
  await Promise.all(SESSIONS.map(async (session, index) => {
    await sleep(index * 40);
    for (let count = 0; count < 10; count += 1) {
      const { verb, body } = calls[(count + index) % calls.length]();
      await agent(verb, body, session);
      await sleep(20);
    }
  }));
  const burst = Date.now() - began;
  const newest = await until(async () => (await snapshot()).presence.latest[0], "the newest presence");
  // The line's last change can come up to 4 s after the one before it.
  await sleep(4300);
  const probe = await browser.evaluate(`(() => { const probe = window.presenceProbe; clearInterval(probe.timer); probe.observer.disconnect(); return { ...probe, timer: null, observer: null, tags: [...document.querySelectorAll(".presence-tag")].map((tag) => tag.innerText) }; })()`);
  await browser.shot("presence-six-agents");

  assert.ok(probe.most >= 2 && probe.most <= 6, `at most one tag per agent (most at once: ${probe.most})`);
  assert.equal(probe.doubled, false, "no agent had two tags");
  assert.ok(probe.properties.length > 0, "the markers animated");
  assert.deepEqual(probe.properties.filter((name) => name !== "transform" && name !== "opacity"), [], `markers animate only transform and opacity (saw ${probe.properties.join(", ")})`);
  // The line: 60 calls are said in a few lines, at least 4 s apart, and the last is the newest call.
  const changes = probe.lines.filter((entry) => !entry.first && entry.text);
  // One line at the first call (later when a line was said under 4 s before), one more each 4 s
  // while calls come, and the newest at the end.
  const most = Math.floor(burst / 4000) + 2;
  assert.ok(changes.length >= 1 && changes.length <= most, `the live line changed ${changes.length} times in ${burst} ms of calls (at most ${most}): ${changes.map((entry) => entry.text).join(" | ")}`);
  for (let index = 1; index < changes.length; index += 1) {
    assert.ok(changes[index].at - changes[index - 1].at >= 3900, `${Math.round(changes[index].at - changes[index - 1].at)} ms between lines`);
  }
  // The page calls the agents by number, in the order they joined (a4 is "Agent 4").
  const shown = `Agent ${newest.agent.id.slice(1)}`;
  assert.ok(changes.at(-1).text.startsWith(shown), `the last line (${changes.at(-1).text}) is about ${shown}, the newest call`);
  console.log(`six agents: tags ${probe.tags.join(" | ")}; marker properties ${probe.properties.join(", ")}; other animations ${probe.others.join(", ") || "none"}; ${burst} ms of calls; lines ${changes.map((entry) => entry.text).join(" | ")}`);
});
