// The dashboard while agents work (milestone LIVE, panes part), in Electron's Chromium against a
// real kino server: the log names each call's agent in its color with the call's label, the status
// line names the agents when more than one works, the person points at a layer and a time range
// (by mouse and by keyboard) and the agent's status reads the same line, and the "agent went
// quiet" notification (off by default; on, it tells once, silently, while the window is in the
// background).
//
// Two connected agents are played through POST /api/agent/<verb> with their own x-kino-session
// header: the server names them Nova and Juno, in order of their first call.
// Set KINO_DASHBOARD_SHOTS=<folder> to keep a screenshot of each step.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { layerButton, q, sleep, startDashboard, textOf, until } from "./dashboard-browser.support.mjs";

let dashboard;
let server;
let browser;
let reviewKey;
let firstScene;

/** A call as one connected agent (its own session), from a Claude Code MCP client. */
async function as(session, verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body }, headers: { "x-kino-session": session } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const nova = (verb, body) => as("test-nova-1", verb, body);
const juno = (verb, body) => as("test-juno-1", verb, body);

async function snapshot(project = "live") {
  return (await server.api(`/api/dashboard/snapshot?project=${project}`)).json();
}

/** A change the test makes as the dashboard (to turn a setting on or put it back). */
async function asDashboard(route, body, method = "POST") {
  const send = () => server.api(`/api/dashboard/${route}`, { method, body, headers: { "x-kino-review": reviewKey } });
  let response = await send();
  if (response.status === 403) { reviewKey = await dashboard.reviewKey(); response = await send(); }
  assert.equal(response.status, 200, `${route} answers 200`);
  return response.json();
}

/** Shift+→ or Shift+← on the focused element. */
async function shiftArrow(key) {
  const vk = key === "ArrowRight" ? 39 : 37;
  const base = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 8 };
  await browser.send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
  await browser.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

/** The color a CSS color gives text, as getComputedStyle writes it ("rgb(108, 182, 255)"). */
const rgb = (hex) => `rgb(${[1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;
const pointingText = `(${q(".p-timeline .pointing-line")}?.innerText ?? "")`;
const ruler = q(".p-timeline .ruler");

before(async () => {
  dashboard = await startDashboard({ prefix: "kino-dashboard-live-" });
  ({ server, browser } = dashboard);
  reviewKey = await dashboard.reviewKey();
  // Nova's first call makes it the first agent: a project with a card and a headline, 6 s long.
  await nova("project", { action: "create", id: "live", name: "Live", width: 640, height: 360, duration: 6 });
  const made = await nova("edit", { ops: [
    { op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 170, y: 110, width: 300, height: 140, fill: "#1b2a4a", radius: 12 } },
    { op: "add_layer", layerType: "text", name: "headline", properties: { text: "Ship faster", x: 170, y: 150, width: 300, height: 60, fontSize: 40, fill: "#ffb38a", textAlign: "center" } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  // Juno works in a project of its own; Nova opens the live one again (a read alone opens nothing).
  await juno("project", { action: "create", id: "side", name: "Side", width: 640, height: 360, duration: 2 });
  await nova("project", { action: "open", id: "live" });
  firstScene = (await snapshot()).record.document.scenes[0];
  await nova("look", { project: "live", mode: "frame", t: 0.5, scene: firstScene.id });
});

after(async () => {
  await dashboard?.stop();
});

/** Runs a command from the command list (⌘K): opened by its key, the item picked by mouse. */
async function openFromCommands(words) {
  // The command list has no button on the top line: ⌘K or ":" opens it, then a click picks.
  await browser.key(":");
  await browser.waitFor(`document.activeElement?.id === "command-input"`, { what: "the command list" });
  await browser.click(`[...document.querySelectorAll("#command-list [role=option]")].find((item) => item.querySelector(".command-words")?.textContent === ${JSON.stringify(words)})`);
}

/** The calls of the log's newest turn, opened: [{time, agent, color, inline, label}]. */
async function openNewestTurn(check, what) {
  // The log is a view of the agent pane: it opens from the command list (⌘K) and then has a tab.
  if (await browser.evaluate(`!!document.querySelector("#tab-log")`)) await browser.click(q("#tab-log"));
  else await openFromCommands("log");
  await browser.waitFor(`!!document.querySelector("#panel-log")`, { what: "the log view" });
  await browser.waitFor(`document.querySelectorAll(".p-log .log-row").length > 0`, { what: "a turn in the log" });
  const newest = `[...document.querySelectorAll(".p-log .log-row")].at(-1)`;
  if (await browser.evaluate(`${newest}.getAttribute("aria-expanded")`) !== "true") await browser.click(newest);
  return browser.waitFor(`(() => {
    const rows = [...document.querySelectorAll(".p-log .log-call")].map((row) => {
      const cells = [...row.children].filter((cell) => !cell.classList.contains("sr-only"));
      const agent = row.querySelector(".log-agent");
      return { time: cells[0].innerText, agent: agent?.innerText, color: agent ? getComputedStyle(agent).color : null, inline: agent?.style.color ?? "", label: row.querySelector(".grow")?.innerText };
    });
    return (${check})(rows) ? rows : null;
  })()`, { what });
}

test("a log row reads its time, the agent's name in its color and the call's label; the session pane names each agent and its client", async () => {
  await dashboard.open();
  await browser.waitFor(`(document.querySelector(".dash")?.dataset.project === "live")`, { what: "the live project on the stage" });
  await nova("look", { project: "live", mode: "sheet", from: 1, to: 2, scene: firstScene.id });
  const rows = await openNewestTurn(`(rows) => rows.some((row) => row.label.startsWith("look at 1.0–2.0 s")) && rows.some((row) => row.label.startsWith("look at 0.5 s"))`, "both looks in the log");
  // The server's label (design F2), with the scene it looked at.
  const sheet = rows.find((row) => row.label.startsWith("look at 1.0–2.0 s"));
  assert.deepEqual([sheet.agent, sheet.color], ["Nova", rgb("#42c0b6")], JSON.stringify(rows));
  assert.equal(sheet.inline, rgb("#42c0b6"), "the color is the agent's own (from the server), not the page's teal");
  assert.match(sheet.time, /^\d\d:\d\d$/, "the time of day");
  // The session pane: "(bot) Nova · claude-code  working", and Juno in its own color. The bot is
  // a circle in the agent's color whose eyes show its mood (Nova just looked: "look").
  // The session view opens from the command list (⌘K): it has no tab of its own.
  await openFromCommands("session");
  const agents = await browser.waitFor(`(() => {
    const rows = [...document.querySelectorAll("#section-agents .row")].map((row) => ({ text: row.innerText.replace(/\\s+/g, " ").trim(), color: getComputedStyle(row.querySelector(".agent-name")).color, bot: row.querySelector("svg.bot circle")?.getAttribute("fill"), mood: row.querySelector("svg.bot")?.dataset.mood, hidden: row.querySelector("svg.bot")?.getAttribute("aria-hidden") }));
    return rows.length >= 2 ? rows : null;
  })()`, { what: "the agents in the session pane" });
  assert.ok(agents.some((row) => /^Nova · claude-code .*working$/.test(row.text) && row.color === rgb("#42c0b6") && row.bot === "#42c0b6" && row.mood === "look"), JSON.stringify(agents));
  assert.ok(agents.some((row) => /^Juno · claude-code .*(working|idle)$/.test(row.text) && row.color === rgb("#6cb6ff") && row.bot === "#6cb6ff"), JSON.stringify(agents));
  assert.ok(agents.every((row) => row.hidden === "true"), "the bots are decoration: the name is the text");
  await browser.shot("live-log");
});

test("two agents at work: the top line names both, each in its color; one keeps today's line", async () => {
  await dashboard.open();
  await browser.waitFor(`(document.querySelector(".dash")?.dataset.project === "live")`, { what: "the live project on the stage" });
  // Juno first: following the agents, the dashboard ends on Nova's project.
  await juno("status", { project: "side" });
  await nova("status", { project: "live" });
  // One chip per agent at work on the top line, its name in its color.
  const names = await browser.waitFor(`(() => {
    const chips = [...document.querySelectorAll(".topline .agent-chip .chip-name")];
    return chips.length === 2 ? chips.map((name) => ({ name: name.innerText, color: getComputedStyle(name).color })) : null;
  })()`, { what: "2 agents on the top line" });
  assert.deepEqual(names.map((entry) => entry.name).sort(), ["Juno", "Nova"]);
  assert.equal(names.find((entry) => entry.name === "Juno").color, rgb("#6cb6ff"));
  assert.equal(names.find((entry) => entry.name === "Nova").color, rgb("#42c0b6"));
  await browser.shot("live-two-agents");

  // Review round 2: an agent whose last call failed says so in words, and the breathing dot
  // (s-working) shows only while one of them works.
  const chipOf = (name) => `[...document.querySelectorAll(".topline .agent-chip")].find((chip) => chip.querySelector(".chip-name")?.innerText === ${JSON.stringify(name)})`;
  const failed = (name) => `(${chipOf(name)}?.classList.contains("s-failed") && ${chipOf(name)}.innerText.replace(/\\s+/g, " ").trim() === ${JSON.stringify(`${name} failed`)})`;
  const working = `!!${q(".topline .agent-chip.s-working")}`;
  const broken = { ops: [{ op: "no_such_op" }] };
  assert.equal((await juno("edit", { project: "side", ...broken })).isError, true);
  await nova("status", { project: "live" });
  await browser.waitFor(failed("Juno"), { what: "Juno failed on the top line" });
  assert.ok(await browser.evaluate(working), "Nova still works: its dot breathes");
  assert.equal((await nova("edit", { project: "live", ...broken })).isError, true);
  await browser.waitFor(`${failed("Nova")} && ${failed("Juno")}`, { what: "both failed on the top line" });
  assert.equal(await browser.evaluate(working), false, "no agent works: no working chip");
  await browser.shot("live-two-agents-failed");
  await nova("status", { project: "live" });
});

test("pointing: a layer, then a time range by dragging the ruler and by Shift+→; the agent reads the same line, and Esc lets the range go first", async () => {
  await dashboard.open();
  await browser.waitFor(`(document.querySelector(".dash")?.dataset.project === "live")`, { what: "the live project on the stage" });
  await browser.click(layerButton("card"));
  const layerLine = 'the agent sees "pointing card (you selected it in the dashboard)"';
  await browser.waitFor(`${pointingText} === ${JSON.stringify(layerLine)}`, { what: "the layer's pointing line" });
  assert.ok(!(await browser.evaluate(`${q(".layer-values")}.innerText.includes("the agent sees")`)), "the layer's values no longer repeat it");
  // Read once, not twice: the line is no live region of its own; the selected row and the ruler
  // are described by it (the ruler's value says a range as it changes).
  const said = await browser.evaluate(`({
    live: ${q(".p-timeline .pointing-line")}.getAttribute("aria-live"),
    id: ${q(".p-timeline .pointing-line")}.id,
    row: ${layerButton("card")}.getAttribute("aria-describedby"),
    ruler: ${ruler}.getAttribute("aria-describedby"),
  })`);
  // The focused row is also described by its hover card (name, time on screen, who changed it).
  assert.deepEqual(said, { live: null, id: "pointing-line", row: "pointing-line tl-card", ruler: "pointing-line" });

  // Drag on the ruler from 2.0 s to 3.5 s (the scene is 6 s long).
  const box = await browser.evaluate(`(() => { const rect = ${ruler}.getBoundingClientRect(); return { left: rect.left, width: rect.width, y: rect.top + rect.height / 2 }; })()`);
  const x = (seconds) => box.left + (box.width * seconds) / 6;
  const timeBefore = await browser.evaluate(textOf(".play-time"));
  await browser.drag({ x: x(2), y: box.y }, { x: x(3.5), y: box.y }, 8);
  const dragged = await browser.waitFor(`(() => { const match = ${pointingText}.match(/^the agent sees "pointing card at (\\d+\\.\\d+)–(\\d+\\.\\d+) s in (\\S+) \\(you selected it in the dashboard\\)"$/); return match ? [Number(match[1]), Number(match[2]), match[3]] : null; })()`, { what: "the range's pointing line" });
  assert.ok(Math.abs(dragged[0] - 2) <= 0.02 && Math.abs(dragged[1] - 3.5) <= 0.02, `about 2.0–3.5 s: ${dragged}`);
  assert.equal(await browser.evaluate(textOf(".play-time")), timeBefore, "a drag does not move the playhead");
  assert.equal(await browser.evaluate("String(getSelection())"), "", "a drag selects no text on the ruler");
  assert.equal(await browser.evaluate(`document.querySelectorAll(".p-timeline .tl-range").length`), 2, "the band on the ruler and over the lanes");
  assert.match(await browser.evaluate(`${ruler}.getAttribute("aria-valuetext")`), /, pointing \d+\.\d+–\d+\.\d+ s$/);
  const shown = (await browser.evaluate(pointingText)).replace(/^the agent sees "/, "").replace(/"$/, "");
  await until(async () => (await nova("status", { project: "live" })).text.includes(shown), `the agent's status to read "${shown}"`);
  await browser.shot("live-pointing-drag");

  // Esc lets the range go; the layer stays.
  await browser.key("Escape");
  await browser.waitFor(`${pointingText} === ${JSON.stringify(layerLine)} && !document.querySelector(".p-timeline .tl-range")`, { what: "the range let go" });
  assert.equal(await browser.evaluate(`${layerButton("card")}.getAttribute("aria-pressed")`), "true");

  // By keyboard: on the focused ruler, Shift+→ five times from the playhead at 0.
  await browser.evaluate(`${ruler}.focus()`);
  for (let index = 0; index < 5; index += 1) await shiftArrow("ArrowRight");
  await shiftArrow("ArrowLeft");
  const keyed = await browser.waitFor(`(() => { const match = ${pointingText}.match(/^the agent sees "pointing (card at 0\\.0–0\\.4 s in \\S+ \\(you selected it in the dashboard\\))"$/); return match ? match[1] : null; })()`, { what: "the keyboard range 0.0–0.4 s" });
  assert.match(await browser.evaluate(`${ruler}.getAttribute("aria-valuetext")`), /, pointing 0\.0–0\.4 s$/);
  await until(async () => (await nova("status", { project: "live" })).text.includes(`pointing ${keyed}`), "the agent's status to read the keyboard range");
  await browser.shot("live-pointing-keys");

  // Esc twice: first the range, then the layer; nothing is pointed at.
  await browser.key("Escape");
  await browser.waitFor(`${pointingText} === ${JSON.stringify(layerLine)}`, { what: "the keyboard range let go" });
  await browser.key("Escape");
  await browser.waitFor(`!${q(".p-timeline .pointing-line")}`, { what: "nothing pointed at" });
  assert.equal(await browser.evaluate(`${ruler}.getAttribute("aria-describedby")`), null, "nothing to describe the ruler by");
  await until(async () => !/pointing /.test((await nova("status", { project: "live" })).text), "the agent's status without pointing");
});

// Review round 2: a press on the ruler let go outside it (before it became a drag) is over, so a
// hover over the ruler draws no range; and Esc lets go of a range still being drawn, before the
// agent is told anything.
test("the ruler: a press let go outside it leaves no range for a hover, and Esc drops a range still being drawn", async () => {
  await dashboard.open();
  await browser.waitFor(`(document.querySelector(".dash")?.dataset.project === "live")`, { what: "the live project on the stage" });
  const box = await browser.evaluate(`(() => { const rect = ${ruler}.getBoundingClientRect(); return { left: rect.left, width: rect.width, y: rect.top + rect.height / 2, below: rect.bottom + 30 }; })()`);
  const x = (seconds) => box.left + (box.width * seconds) / 6;
  const mouse = (type, at, buttons = 0) => browser.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  const ranges = `document.querySelectorAll(".p-timeline .tl-range").length`;
  const valueText = `${ruler}.getAttribute("aria-valuetext")`;

  // A 2 px press (not a drag yet), moved down into the lanes and let go there.
  await mouse("mouseMoved", { x: x(1), y: box.y });
  await mouse("mousePressed", { x: x(1), y: box.y }, 1);
  await mouse("mouseMoved", { x: x(1) + 2, y: box.y }, 1);
  await mouse("mouseMoved", { x: x(1) + 2, y: box.below }, 1);
  await mouse("mouseReleased", { x: x(1) + 2, y: box.below });
  // Back over the ruler with no button down: a hover, not a drag.
  for (const seconds of [2, 3, 4]) await mouse("mouseMoved", { x: x(seconds), y: box.y });
  await sleep(300);
  await browser.shot("live-ruler-hover");
  assert.equal(await browser.evaluate(ranges), 0, "a hover draws no range");
  assert.doesNotMatch(await browser.evaluate(valueText), /pointing/);

  // A real drag, and Esc while the button is still down: the range goes, and letting go points
  // at nothing and moves no playhead.
  const timeBefore = await browser.evaluate(textOf(".play-time"));
  await mouse("mouseMoved", { x: x(1), y: box.y });
  await mouse("mousePressed", { x: x(1), y: box.y }, 1);
  for (const seconds of [1.5, 2, 2.5]) await mouse("mouseMoved", { x: x(seconds), y: box.y }, 1);
  await browser.waitFor(`${ranges} === 2`, { what: "the range being drawn" });
  await browser.shot("live-ruler-drawing");
  await browser.key("Escape");
  await browser.waitFor(`${ranges} === 0`, { what: "Esc let the range go" });
  await mouse("mouseReleased", { x: x(2.5), y: box.y });
  await sleep(300);
  await browser.shot("live-ruler-esc");
  assert.equal(await browser.evaluate(ranges), 0, "letting go after Esc points at nothing");
  assert.equal(await browser.evaluate(pointingText), "");
  assert.doesNotMatch(await browser.evaluate(valueText), /pointing/);
  assert.equal(await browser.evaluate(textOf(".play-time")), timeBefore, "the press that Esc ended does not seek");
  assert.doesNotMatch((await nova("status", { project: "live" })).text, /pointing /, "the agent was told nothing");
});

test("the quiet notification is off by default, and its checkbox is reached by keyboard with a visible focus", async () => {
  const settings = (await (await server.api("/api/dashboard/settings")).json()).settings;
  assert.equal(settings.notify?.quiet, false, "off by default");
  await dashboard.open();
  await browser.waitFor(`(document.querySelector(".dash")?.dataset.project === "live")`, { what: "the live project on the stage" });
  // Settings is the gear button on the top line.
  await browser.click(q('.topline button[aria-label="Settings"]'));
  await browser.waitFor(`!!document.querySelector("#set-quiet")`, { what: "the settings screen" });
  assert.equal(await browser.evaluate(`document.querySelector("#set-quiet").checked`), false);
  assert.equal(await browser.evaluate(`document.querySelector('label[for="set-quiet"]').innerText`), "tell me when an agent goes quiet");
  // Tab from the control before it reaches it, the focus ring shows, and Space turns it on and off.
  await browser.evaluate(`(() => {
    const all = [...document.querySelectorAll("section.screen button, section.screen input, section.screen select, section.screen a[href]")].filter((element) => !element.disabled && element.getClientRects().length);
    all[all.indexOf(document.querySelector("#set-quiet")) - 1].focus();
  })()`);
  await browser.key("Tab");
  assert.equal(await browser.evaluate(`document.activeElement?.id`), "set-quiet", "Tab reaches the checkbox");
  assert.notEqual(await browser.evaluate(`getComputedStyle(document.activeElement).outlineStyle`), "none", "a visible focus");
  await browser.shot("live-quiet-setting");
  await browser.key(" ");
  await until(async () => (await (await server.api("/api/dashboard/settings")).json()).settings.notify?.quiet === true, "the setting saved on");
  // The checkbox shows the saved setting: press again only once the screen shows it on, as a
  // person would (a press before that would turn it on a second time).
  await browser.waitFor(`document.querySelector("#set-quiet").checked`, { what: "the checkbox shown on" });
  await browser.key(" ");
  await until(async () => (await (await server.api("/api/dashboard/settings")).json()).settings.notify?.quiet === false, "the setting saved off");
  await browser.key("Escape");
});

test("quiet on: 31 s after the agent's last call, with the window in the background, one silent notification", async () => {
  // Notifications are recorded, the page's clock can be moved on, and the test says when the
  // window is in the background: the test window cannot really be put there (it is hidden on a
  // Mac and still reports the focus; on Linux it is shown without it), so document.hasFocus()
  // answers false while window.__background is set and the browser's own answer otherwise.
  const { identifier } = await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__notes = [];
    window.__shift = 0;
    window.__background = false;
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + window.__shift;
    const realHasFocus = Document.prototype.hasFocus;
    Document.prototype.hasFocus = function () { return window.__background ? false : realHasFocus.call(this); };
    window.Notification = class {
      static permission = "granted";
      static requestPermission() { return Promise.resolve("granted"); }
      constructor(title, options = {}) { window.__notes.push({ title, body: options.body, silent: options.silent, tag: options.tag }); }
      close() {}
    };
  ` });
  try {
    await dashboard.open();
    await browser.waitFor(`(document.querySelector(".dash")?.dataset.project === "live")`, { what: "the live project on the stage" });
    await asDashboard("settings", { notify: { quiet: true } }, "PUT");
    // Only Nova works in this project (Juno's calls are in the side project).
    const before = await nova("look", { project: "live", mode: "frame", t: 1.5, scene: firstScene.id });
    assert.equal(before.isError, undefined, before.text);
    await openNewestTurn(`(rows) => rows.some((row) => row.label.startsWith("look at 1.5 s"))`, "the look in the log");
    // In the foreground nothing is told, also 31 s later.
    await browser.evaluate(`window.__shift = 31000`);
    await sleep(5600);
    assert.equal(await browser.evaluate(`window.__notes.length`), 0, "not while the window has the focus");
    // The window goes to the background.
    assert.equal(await browser.evaluate("document.hasFocus()"), true, "the window has the focus first");
    await browser.evaluate(`window.__background = true`);
    assert.equal(await browser.evaluate("document.hasFocus()"), false);
    const notes = await browser.waitFor(`window.__notes.length ? window.__notes : null`, { timeout: 8000, what: "the quiet notification" });
    assert.equal(notes.length, 1, JSON.stringify(notes));
    assert.deepEqual({ title: notes[0].title, silent: notes[0].silent }, { title: "kino", silent: true });
    assert.match(notes[0].body, /^Nova went quiet · look at 1\.5 s/, "the agent and the label of its last call");
    // Once per quiet spell: the next checks tell nothing new.
    await sleep(5600);
    assert.equal(await browser.evaluate(`window.__notes.length`), 1, "told once");
    await browser.shot("live-quiet-told");
  } finally {
    await browser.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await asDashboard("settings", { notify: { quiet: false } }, "PUT");
  }
});
