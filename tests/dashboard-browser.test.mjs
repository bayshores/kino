// Milestone A5, the dashboard in a real browser. Electron's Chromium opens the dashboard that
// Vite serves, against a real kino server with a temporary data folder. The test plays the
// agent through POST /api/agent/<verb> and plays the person with real key presses, clicks,
// drags, drops and taps (Chrome DevTools Protocol input events). Every action in plan §5.5 is
// done once by keyboard and once by mouse, and each result is checked twice: in the page, and
// in what the agent is told. Also: reduced motion, the accessibility tree and live regions,
// the phone layout, the brief the agent saved (read only), /?editor (it opens the dashboard
// now), and share links: the viewer with comments for comment links, read only for view links,
// and revoking on the shares screen.
//
// Set KINO_DASHBOARD_SHOTS=<folder> to keep a screenshot of each step and of each timed-out wait,
// or KINO_DASHBOARD_TIMEOUT_SHOTS=<folder> for the timed-out waits only (CI does that).
// Set KINO_TEST_CPU_SLOWDOWN=8 to run the page 8 times slower, as on a busy CI machine.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { ffmpeg, run, skipWithoutMediaTools } from "../backend/media.test.support.mjs";
import { BOARD_SKIP_UNDER } from "../backend/stops.test.support.mjs";
import { button, layerButton, pageHas, q, showLanes, sleep, slowdown, startDashboard, textOf, until } from "./dashboard-browser.support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// ---- finding things in the page (each is an expression evaluated in the page) ------------------

/** Each pane's title as drawn, and whether that pane has the focus frame. */
const paneTitles = `[...document.querySelectorAll("section.pane")].map((pane) => ({ text: pane.querySelector(":scope > h2").innerText, focused: pane.dataset.focused === "true" }))`;
// The status line's time reads "00:01.23/00:15.00" with no ▶ or ‖ drawn before it. Whether the
// scene is playing is in its data-state and in the words ", playing" or ", paused" that only a
// screen reader says; these read both, so a test sees the real state, not a drawn sign.
const playText = `(${q(".play-time")}?.textContent ?? "")`;
const playState = `(${q(".play-time")}?.dataset.state ?? "")`;
const isPlaying = `(${playState} === "playing" && ${playText}.endsWith(", playing"))`;
const isPaused = `(${playState} === "paused" && ${playText}.endsWith(", paused"))`;
/** Paused with the playhead at `time` ("00:03.00"). */
const pausedAt = (time) => `(${isPaused} && ${playText}.startsWith(${JSON.stringify(`${time}/`)}))`;
/** The colour a dashboard colour token (`--accent`, say) gives text, as getComputedStyle writes it. */
const token = (name) => `(() => { const probe = document.createElement("span"); probe.style.color = "var(${name})"; document.querySelector(".dash").append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; })()`;

// ---- the server, the agent and the dashboard's own API ----------------------------------------

let dashboard;
let server;
let browser;
let appUrl;
let reviewKey;
let folder;
let firstScene;
let outroScene;

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "test-agent", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function snapshot() {
  return (await server.api("/api/dashboard/snapshot?project=orbit")).json();
}

async function settings() {
  return (await (await server.api("/api/dashboard/settings")).json()).settings;
}

/** A new review key, asked for the way a dashboard page asks. */
async function freshReviewKey() {
  reviewKey = await dashboard.reviewKey();
}

/** A change the test makes as the dashboard (to set things up or put them back). */
async function asDashboard(route, body, method = "POST") {
  const send = () => server.api(`/api/dashboard/${route}`, { method, body, headers: { "x-kino-review": reviewKey } });
  let response = await send();
  // The server keeps only the newest review keys, and every page load that changes something
  // makes one, so the test's key can age out; the dashboard gets a new one the same way.
  if (response.status === 403) { await freshReviewKey(); response = await send(); }
  assert.equal(response.status, 200, `${route} answers 200`);
  return response.json();
}

async function approval(id) {
  return (await snapshot()).approvals.find((entry) => entry.id === id);
}

const inboxText = (reply) => (reply.data?.inbox ?? []).map((entry) => (typeof entry === "string" ? entry : entry.text)).join("\n") || reply.text;

// The same call asked twice while it waits is one request (the second gets the first's id), so
// two requests at once need two roles.
async function share(role = "view") {
  const asked = await agent("project", { action: "share", id: "orbit", role });
  assert.equal(asked.data.status, "awaiting_approval", asked.text);
  // The request's row is under "Needs you", in the list's session view.
  if (await browser.evaluate(`!document.querySelector("#panel-session") && !document.querySelector("section.screen") && !document.querySelector(".dash.phone")`)) await showView("session", { focus: false });
  await browser.waitFor(`!!document.querySelector('[aria-label^="Approval ${asked.data.id}:"]')`, { what: `${asked.data.id} on screen` });
  return asked.data.id;
}

async function noteNamed(prefix) {
  return until(async () => (await snapshot()).agent.notes.find((note) => note.text.startsWith(prefix)), `a note starting "${prefix}"`);
}

/** Loads the dashboard fresh and waits for its first real stage frame. */
const open = (url) => dashboard.open(url);

/** Picks an item in the drop-down list that is open now (a Menu in panes.jsx), by mouse. */
const menuItem = (label) => `[...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')].find((item) => item.innerText.trim() === ${JSON.stringify(label)})`;

/** True while the stage shows scene `name`: the scene menu in the stage's toolbar names it. */
const sceneShown = (name) => `((${q("#scene-menu .menu-value")} ?? ${q(".stage-toolbar .scene-name")})?.innerText.trim() === ${JSON.stringify(name)})`;

/** Shows a scene on the stage by mouse: the scene menu in the stage's toolbar, then the scene's name. */
async function showScene(scene) {
  await browser.click(q("#scene-menu"));
  await browser.click(menuItem(scene.name));
  await browser.waitFor(sceneShown(scene.name), { what: `the scene ${scene.name} on the stage` });
}

/** Opens the whole timeline (every lane and layer, the zoom buttons) from the shot strip, if the strip is showing. */
async function showEveryLane() {
  const toggle = 'button[aria-label="Show every lane and layer"]';
  if (await browser.evaluate(`!!${q(toggle)}`)) await browser.click(q(toggle));
  await browser.waitFor(`!${q(toggle)} && !!${q(".p-timeline .tl-scroll")}`, { what: "the whole timeline" });
}

/**
 * Shows one of the agent pane's views (agent, session, log, checks, notes, seen) by mouse, its
 * tab, then puts the focus on the pane with its key (2), as a person does before j, k or Enter.
 */
async function showView(name, { focus = true } = {}) {
  // session and log have no tab until they are open: they open from the command list (⌘K).
  if (await browser.evaluate(`!!${q(`#tab-${name}`)}`)) await browser.click(q(`#tab-${name}`));
  else await commandByMouse(name);
  await browser.waitFor(`${q(`#tab-${name}`)}.getAttribute("aria-selected") === "true" && !!document.querySelector("#panel-${name}")`, { what: `the ${name} view` });
  if (!focus) return;
  await browser.key("2");
  await browser.waitFor(`document.activeElement?.dataset?.pane === "2"`, { what: "the focus on the agent pane" });
}

/** Runs a command from the command list (⌘K): opened by its key, the item picked by mouse. */
async function commandByMouse(words) {
  // The command list has no button on the top line: ⌘K or ":" opens it, then a click picks.
  await browser.key(":");
  await browser.waitFor(`document.activeElement?.id === "command-input"`, { what: "the command list" });
  await browser.click(`[...document.querySelectorAll("#command-list [role=option]")].find((item) => item.querySelector(".command-words")?.textContent === ${JSON.stringify(words)})`);
}

/** Clicks `target` until `done` is true (a click that lands while the page redraws is lost). */
async function clickUntil(target, done, what) {
  for (let attempt = 1; ; attempt += 1) {
    await browser.click(target);
    try { await browser.waitFor(done, { what, timeout: 3000 }); return; } catch (error) { if (attempt >= 4) throw error; }
  }
}

/** The timeline shows the shot strip until "Show every lane and layer" opens every lane and layer. */
async function openEveryLane() {
  if (await browser.evaluate(`${q('.p-timeline .strip-toggle[aria-label="Show every lane and layer"]')} !== null`)) await browser.click(q(".p-timeline .strip-toggle"));
  await browser.waitFor(`!!${q(".p-timeline .row-button")} && !${q(".p-timeline.strip")}`, { what: "every lane and layer on the timeline" });
}

/** True in the page while project `id` is the one the dashboard shows (its root's data-project). */
const onProject = (id) => `(document.querySelector(".dash")?.dataset.project === ${JSON.stringify(id)})`;

/** The agent pane's session view, where needs you, the agents, brief, stops, plan, media and renders are. */
const SESSION = "#panel-session";

before(async () => {
  dashboard = await startDashboard({ prefix: "kino-dashboard-browser-" });
  ({ server, browser, appUrl, folder } = dashboard);
  await freshReviewKey();

  // The agent's work so far: a plan, one edit, one look.
  await agent("project", { action: "create", id: "orbit", name: "Orbit", width: 640, height: 360, duration: 1 });
  await agent("notes", { action: "set_plan", steps: ["brief", "compose title and card", "check", "render final"] });
  const made = await agent("edit", { ops: [
    { op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 170, y: 110, width: 300, height: 140, fill: "#1b2a4a", radius: 12 } },
    { op: "add_layer", layerType: "text", name: "headline", properties: { text: "Ship faster", x: 170, y: 150, width: 300, height: 60, fontSize: 40, fontWeight: 700, fill: "#ffb38a", textAlign: "center" } },
    // A second, longer scene: something to switch to, compare as a variant, and (made 4K in the export test) a render to cancel.
    { op: "add_scene", name: "outro", width: 640, height: 360, duration: 15, background: "#0b1020" },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const scenes = (await snapshot()).record.document.scenes;
  [firstScene, outroScene] = scenes;
  await agent("look", { mode: "frame", t: 0.5, scene: firstScene.id });
});

after(async () => {
  await dashboard?.stop();
});

// ---- the tests ------------------------------------------------------------------------------------

test("the dashboard is the default view at /, with real frames from the export renderer", async () => {
  await open();
  // One column: the stage and the timeline strip are the two panes; the list of calls (the agent
  // pane) is closed until opened. One pane has the focus frame.
  const titles = await browser.evaluate(paneTitles);
  assert.equal(titles.length, 2, JSON.stringify(titles));
  assert.equal(titles.filter((title) => title.focused).length, 1, JSON.stringify(titles));
  assert.match(titles[0].text, /^stage/);
  assert.match(titles[1].text, /^timeline/);
  assert.equal(await browser.evaluate(`!!document.querySelector("#tab-agent")`), false, "the list is closed");
  // Under the frame: the agent's line, in a sentence.
  assert.ok(await browser.evaluate(textOf(".voice-line")).then((text) => text.trim().length > 0), "the agent's line says something");
  const frame = await browser.evaluate(`(() => { const image = document.querySelector(".stage img"); return { src: image.getAttribute("src"), width: image.naturalWidth, height: image.naturalHeight }; })()`);
  assert.match(frame.src, /^\/api\/dashboard\/frame\?project=orbit&/);
  assert.equal(frame.width * 360, frame.height * 640, "the frame keeps the scene's shape");
  const response = await server.api(frame.src);
  assert.equal(response.headers.get("content-type"), "image/png");
  // The stage's header says the frame's size, rate, quality and revision; its tooltip says it all.
  assert.match(await browser.evaluate(textOf(".stage-label")), /^\d+×\d+\s+30fps\s+draft\s+rev \d+$/);
  assert.match(await browser.evaluate(`${q(".stage-label")}.title`), /^preview \d+×\d+ · 30fps · draft · rev \d+ · exact frame$/);
  // The list of calls opens from the clock icon beside the agent's line (or a command, or a key).
  await browser.click(q('button[aria-label="Earlier lines"]'));
  await browser.waitFor(`${q("#tab-agent")}?.getAttribute("aria-selected") === "true" && !!document.querySelector("#panel-agent")`, { what: "the list open on the agent view" });
  // The agent view: the agent's call that made the headline, and its plan step as its task.
  await browser.waitFor(pageHas("Added rectangle card", "#panel-agent"), { what: "the edit in the agent's log" });
  // A row shows a sentence; its facts (what it made) show when a click opens the row.
  await browser.click(q("#panel-agent .agent-call.has-more .call-text"));
  await browser.waitFor(`!!document.querySelector("#panel-agent .agent-call.open .call-details")`, { what: "the row's facts" });
  assert.match(await browser.evaluate(textOf("#panel-agent .agent-call.open .call-details")), /headline/);
  // No step is ticked off yet, so the task is the plan's first step.
  assert.equal(await browser.evaluate(textOf("#panel-agent .agent-task")), "brief", "the plan's step now is the agent's task");
  assert.match(await browser.evaluate(textOf("#panel-agent .agent-step")), /^step 1 of 4 · last call \d+s ago$/);
  // The seen view: the picture the agent looked at.
  await showView("seen", { focus: false });
  await browser.waitFor(`document.querySelector(".seen-strip img")?.naturalWidth > 0`, { what: "the image the agent saw" });
  await showView("agent", { focus: false });
  await browser.waitFor(`/Checks: \\d+ errors?, \\d+ warnings?/.test(${textOf(".statusline")})`, { what: "the background check" });
  await browser.shot("desktop");
});

test("approvals by keyboard: Tab adds a note, a allows once, A always allows, d denies, D always denies", async () => {
  await open();
  let id = await share();
  await browser.waitFor(`document.querySelector('[role="alert"][aria-live="assertive"]')?.textContent.includes(${JSON.stringify(`${id} needs you`)})`, { what: "the assertive announcement" });
  assert.match(await browser.evaluate("document.title"), /^1 awaiting · /);
  await showView("session");
  await browser.key("Enter");
  await browser.waitFor(`${textOf(".screen .approval-card h3")} === "Create a share link" && ${q(".screen .approval-card h3")}.title === ${JSON.stringify(id)}`, { what: "the approval card" });
  await browser.waitFor(`document.activeElement?.matches("section.screen")`, { what: "the approval screen to take the focus" });
  await browser.shot("approval-card");
  await browser.key("Tab");
  await browser.waitFor(`document.activeElement?.id === "approval-note-${id}"`);
  await browser.type("ok for the client");
  // From the note, Tab goes on through all four answers; it does not jump back to the note.
  for (const label of ["Allow", "Always allow", "Not yet", "Never"]) {
    await browser.key("Tab");
    await browser.waitFor(`document.activeElement?.textContent === ${JSON.stringify(label)}`, { what: `Tab to ${label}` });
  }
  await browser.key("a");
  await until(async () => (await approval(id))?.status === "allowed", "allow once");
  assert.equal((await approval(id)).note, "ok for the client");
  assert.match(inboxText(await agent("status")), new RegExp(`${id} allowed · your note: "ok for the client": Created sharing link \\(secret omitted\\)`));
  await browser.waitFor(pageHas("Allowed", ".screen"));
  assert.equal(await browser.evaluate(`document.querySelector(".screen")?.textContent.includes("#share=")`), false, "the card never shows the URL");
  await browser.key("Escape");

  id = await share();
  await browser.key("A");
  await until(async () => (await approval(id))?.status === "allowed", "always allow");
  assert.equal((await settings()).approvals["share-link"], "allow");
  assert.ok((await agent("project", { action: "share", id: "orbit", role: "view" })).data.url, "the rule lets the next share through");
  await asDashboard("settings", { approvals: { "share-link": "ask" } }, "PUT");
  // Nothing waits now; otherwise the archive request could take the answered row's place under
  // the key, and then the first d only names it (a row that moved under the key).
  await browser.waitFor(`!document.querySelector("#tab-session .tab-count")`, { what: "needs you empty" });

  const archive = await agent("project", { action: "archive", id: "orbit" });
  assert.equal(archive.data.status, "awaiting_approval");
  await browser.waitFor(`!!document.querySelector('[aria-label^="Approval ${archive.data.id}:"]')`, { what: `${archive.data.id} on screen` });
  await browser.key("d");
  await until(async () => (await approval(archive.data.id))?.status === "denied", "deny");
  assert.ok((await snapshot()).projects.some((project) => project.id === "orbit"), "nothing was archived");
  assert.match(inboxText(await agent("status")), new RegExp(`${archive.data.id} denied by the person`));

  id = await share();
  await browser.key("D");
  await until(async () => (await approval(id))?.status === "denied", "always deny");
  assert.equal((await settings()).approvals["share-link"], "deny");
  assert.equal((await agent("project", { action: "share", id: "orbit", role: "view" })).data.error, "denied");
  await asDashboard("settings", { approvals: { "share-link": "ask" } }, "PUT");
});

test("approvals by mouse: deny in the session pane; note, always allow, allow once and always deny on the card", async () => {
  await open();
  let id = await share();
  await showView("session", { focus: false });
  await browser.click(button("Not yet", SESSION));
  await until(async () => (await approval(id))?.status === "denied", "deny by click");

  id = await share();
  await browser.click(`document.querySelector('[aria-label^="Approval ${id}:"]')`);
  await browser.click(q(`#approval-note-${id}`));
  await browser.type("from the mouse");
  await browser.click(button("Always allow", ".screen"));
  await until(async () => (await approval(id))?.status === "allowed", "always allow by click");
  assert.equal((await approval(id)).note, "from the mouse");
  assert.equal((await settings()).approvals["share-link"], "allow");
  await asDashboard("settings", { approvals: { "share-link": "ask" } }, "PUT");
  // The top line's Stage tab goes back from the approval screen.
  await browser.click(q('.topline .tab[data-view="main"]'));

  id = await share();
  await browser.click(`document.querySelector('[aria-label^="Approval ${id}:"]')`);
  await browser.click(q('.screen button[aria-label="Allow once"]'));
  await until(async () => (await approval(id))?.status === "allowed", "allow once by click");
  await browser.click(q('.topline .tab[data-view="main"]'));

  id = await share();
  await browser.click(`document.querySelector('[aria-label^="Approval ${id}:"]')`);
  await browser.click(q('.screen button[aria-label="Always deny"]'));
  await until(async () => (await approval(id))?.status === "denied", "always deny by click");
  assert.equal((await settings()).approvals["share-link"], "deny");
  await asDashboard("settings", { approvals: { "share-link": "ask" } }, "PUT");
});

test("an allowed approval whose call then fails shows as a failure, not a success", async () => {
  const before = await projectIds();
  await agent("project", { action: "duplicate", id: "orbit" });
  const copy = await until(async () => (await projectIds()).find((entry) => !before.includes(entry)), "the copy");
  await open();
  const asked = await agent("project", { action: "archive", id: copy });
  assert.equal(asked.data.status, "awaiting_approval", asked.text);
  // The copy goes to Trash another way before the answer, so the call the answer allows fails.
  const archived = await asDashboard("act/project", { action: "archive", id: copy });
  assert.equal(archived.isError, undefined, archived.text);
  await showView("session", { focus: false });
  await browser.click(`document.querySelector('[aria-label^="Approval ${asked.data.id}:"]')`);
  await browser.waitFor(`document.activeElement?.matches("section.screen")`, { what: "the approval screen" });
  await browser.key("a");
  const answered = await until(async () => { const entry = await approval(asked.data.id); return entry?.result ? entry : null; }, "the allowed call");
  assert.equal(answered.status, "allowed");
  assert.equal(answered.result.isError, true, answered.result.text);
  const card = textOf(".approval-card .err");
  await browser.waitFor(`${card}.startsWith("Allowed ") && ${card}.includes(${JSON.stringify(`The call failed: ${answered.result.text}`)})`, { what: "the card in the error style" });
  assert.equal(await browser.evaluate(`!!document.querySelector(".approval-card .ok")`), false, "not in the success style");
  const said = `${asked.data.id} allowed, but the call failed: `;
  await browser.waitFor(`[...document.querySelectorAll(".topline .err")].some((element) => element.textContent.startsWith(${JSON.stringify(said)}))`, { what: "the message in the error style" });
  await browser.waitFor(`document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent.startsWith(${JSON.stringify(said)})`, { what: "the announcement" });
  await browser.shot("approval-call-failed");
  await browser.key("Escape");
  // The agent's archive call opened the copy, which is now in Trash: open orbit for the next tests.
  const reopened = await agent("project", { action: "open", id: "orbit" });
  assert.equal(reopened.isError, undefined, reopened.text);
});

test("a note goes queued, working, fixed; Looks good folds it into done with the reply", async () => {
  await open();
  await browser.key("c");
  await browser.waitFor(`document.activeElement?.id === "note-text"`);
  await browser.type("Make the card bigger");
  await browser.key("Enter");
  const note = await noteNamed("Make the card bigger");
  // The note line is under every view of the agent pane; the notes view lists the notes.
  await showView("notes", { focus: false });
  const card = `[...document.querySelectorAll("#panel-notes .note-card, #panel-notes .note-line")].find((element) => element.innerText.includes("Make the card bigger"))`;
  const item = `(${card})?.innerText ?? ""`;
  await browser.waitFor(`(${item}).includes("queued")`, { what: "queued" });
  await browser.waitFor(`document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent.includes(${JSON.stringify(`${note.id} queued`)})`, { what: "the polite announcement" });
  assert.match(inboxText(await agent("status")), new RegExp(`${note.id} note.*"Make the card bigger"`));
  await browser.waitFor(`(${item}).includes("working")`, { what: "working" });
  // Any open note can be closed by you, before the agent answers.
  await browser.waitFor(`!!(${card}).querySelector('[aria-label="${note.id} done"]')`, { what: "the done button" });
  await agent("notes", { action: "reply", id: note.id, text: "Card is 360 wide now" });
  await browser.waitFor(`(${item}).includes("fixed") && (${item}).includes("Card is 360 wide now")`, { what: "fixed with the reply" });
  await browser.shot("notes");
  await browser.evaluate(`(${card}).querySelector(".note-yes").click()`);
  // Done, it folds into "1 done"; opened, one line with the reply.
  await browser.waitFor(`!!document.querySelector("#panel-notes .f-done .note-fold-row")`, { what: "the done row" });
  await browser.evaluate(`document.querySelector("#panel-notes .f-done .note-fold-row").click()`);
  await browser.waitFor(`(${item}).includes("Card is 360 wide now")`, { what: "done with the reply" });
  // A need shows above the notes: the question, the recommended option first, "do without".
  await agent("notes", { action: "needs", items: [{ what: "a photo of the team at the launch", why: "the end card has no people in it", ask: "Do you have a photo from the launch?",
    options: [{ do: "End on the logo card", cost: "no people", recommended: true }] }] });
  const need = `[...document.querySelectorAll("#panel-notes .note-card.need")].find((element) => element.innerText.includes("Do you have a photo from the launch?"))`;
  await browser.waitFor(`(${need})?.querySelector(".note-yes")?.innerText.includes("End on the logo card") && (${need}).innerText.includes("do without")`, { what: "the need with its options" });
  await browser.evaluate(`[...(${need}).querySelectorAll("button")].find((button) => button.innerText === "do without").click()`);
  await browser.waitFor(`!(${need})`, { what: "the dropped need gone" });
});

test("a note by mouse: drag on the stage marks a box, a click points at what is under it", async () => {
  await open();
  const scene = (await snapshot()).record.document.scenes[0];
  // On a slow runner the stage can still grow or move after it is measured (CI once pinned
  // 204,114 163×92 for a drag from 25% to 60% of the stage). So the page records where the stage
  // is drawn when the pointer goes down and up, and the expected scene point is worked out from that.
  const recordStage = () => browser.evaluate(`(() => {
    window.stageAtPointer = [];
    const stage = document.querySelector(".stage");
    for (const type of ["pointerdown", "pointerup"]) stage.addEventListener(type, (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      window.stageAtPointer.push({ x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }, { capture: true, once: true });
  })()`);
  const inScene = (seen) => ({ x: Math.round((seen.x - seen.left) * scene.width / seen.width), y: Math.round((seen.y - seen.top) * scene.height / seen.height) });
  let stage = await browser.box(q(".stage"));
  await recordStage();
  await browser.drag({ x: stage.left + stage.width * 0.25, y: stage.top + stage.height * 0.25 }, { x: stage.left + stage.width * 0.6, y: stage.top + stage.height * 0.6 });
  await browser.waitFor(`(document.querySelector(".note-field #note-text")?.getAttribute("aria-label") ?? "").endsWith("about this spot")`, { what: "the note field about the box" });
  const [down, up] = (await browser.evaluate(`window.stageAtPointer`)).map(inScene);
  // About 35% of the scene each way, from about 25% in.
  assert.ok(up.x - down.x > scene.width * 0.2 && up.y - down.y > scene.height * 0.2, JSON.stringify({ down, up }));
  await browser.click(q("#note-text"));
  await browser.type("Move this block up");
  await browser.click(q('.note-field button[aria-label="Send the note"]'));
  const pinned = await noteNamed("Move this block up");
  assert.ok(Math.abs(pinned.area.x - down.x) <= 1 && Math.abs(pinned.area.y - down.y) <= 1, JSON.stringify({ area: pinned.area, down }));
  assert.ok(Math.abs(pinned.area.width - (up.x - down.x)) <= 1 && Math.abs(pinned.area.height - (up.y - down.y)) <= 1, JSON.stringify({ area: pinned.area, down, up }));
  await browser.waitFor(`[...document.querySelectorAll(".note-pin")].some((element) => element.innerText === ${JSON.stringify(pinned.id.replace(/\D+/g, ""))})`, { what: "the numbered dot on the stage" });
  stage = await browser.box(q(".stage"));
  await recordStage();
  await browser.clickAt(stage.left + stage.width * 0.5, stage.top + stage.height * 0.5);
  await browser.waitFor(`window.stageAtPointer.length === 2`, { what: "the click on the stage" });
  const [point] = (await browser.evaluate(`window.stageAtPointer`)).map(inScene);
  // A click points at the layer under it, or the spot when only the background is there.
  await browser.waitFor(`!!document.querySelector(".note-field") && document.activeElement?.id === "note-text"`, { what: "the note field from a click" });
  const about = await browser.evaluate(`document.querySelector("#note-text").getAttribute("aria-label")`);
  const under = (await snapshot()).record.document.scenes[0].layers.map((layer) => layer.name);
  assert.ok(under.some((name) => about.endsWith(` about ${name}`)) || about.endsWith(" about this spot"), JSON.stringify({ about, point }));
  await browser.click(q('.note-field button[aria-label="Drop this note"]'));
  await browser.waitFor(`!document.querySelector(".note-field")`, { what: "the note dropped" });
});

test("pointing at a layer, by mouse and by keyboard, shows its values and tells the agent", async () => {
  await open();
  // The shot strip is the default; the layers show after "Show every lane and layer".
  await showLanes(browser);
  await browser.click(layerButton("card"));
  await browser.waitFor(`${layerButton("card")}?.getAttribute("aria-pressed") === "true"`);
  await browser.waitFor(pageHas('the agent sees "pointing card (you selected it in the dashboard)"', ".p-timeline"));
  await browser.waitFor(`!!document.querySelector(".pointing-box")`, { what: "the pointing box" });
  await until(async () => /card \(you selected it in the dashboard\)/.test((await agent("status")).text), "the agent to see the pointing");
  // A note now points at that layer.
  await browser.key("c");
  const card = (await snapshot()).record.document.scenes[0].layers.find((layer) => layer.name === "card");
  await browser.waitFor(`(document.querySelector(".note-field #note-text")?.getAttribute("aria-label") ?? "").endsWith("about card")`, { what: "the note about the selected layer" });
  await browser.keys("Escape", "Escape");
  await browser.waitFor(`${layerButton("card")}?.getAttribute("aria-pressed") === "false"`);

  const names = await browser.evaluate(`[...document.querySelectorAll(".p-timeline .row-button")].map((element) => element.innerText.trim())`);
  await browser.key("3");
  await browser.waitFor(`!!document.activeElement?.matches('[data-pane="3"]')`, { what: "the focus on the timeline pane" });
  for (let index = 0; index < names.indexOf("headline"); index += 1) await browser.key("j");
  await browser.waitFor(`!!${layerButton("headline")}?.classList.contains("on")`, { what: "the timeline cursor on headline" });
  await browser.key("Enter");
  await browser.waitFor(`${layerButton("headline")}?.getAttribute("aria-pressed") === "true"`);
  await until(async () => /headline \(you selected it in the dashboard\)/.test((await agent("status")).text), "the agent to see the keyboard pointing");
  await browser.key("Escape");
});

test("play and scrub by keyboard: space, , . one frame, { } scenes, [ ] turns", async () => {
  await open();
  await browser.key("1");
  const status = textOf(".bottomline");
  await browser.key(".");
  await browser.waitFor(`${pausedAt("00:00.03")}`, { what: "one frame forward" });
  await browser.key(",");
  await browser.waitFor(`${pausedAt("00:00.00")}`, { what: "one frame back" });
  await browser.key(" ");
  await browser.waitFor(`${isPlaying}`, { what: "playing" });
  assert.doesNotMatch(await browser.evaluate(status), /[▶‖]/, "no play or pause sign before the time");
  await sleep(300);
  await browser.key(" ");
  await browser.waitFor(`${isPaused} && !${pausedAt("00:00.00")}`, { what: "paused after time moved" });
  assert.ok(await browser.evaluate(sceneShown(firstScene.name)));
  await browser.key("}");
  await browser.waitFor(`${sceneShown(outroScene.name)}`, { what: "the next scene" });
  // On the playhead slider End and Home go to the ends, Page Down and Page Up one tick (15 s / 12),
  // so a ten-minute scene is crossed in a few presses.
  await browser.evaluate(`${q(".p-timeline [role=\"slider\"]")}.focus()`);
  await browser.key("End");
  await browser.waitFor(`${pausedAt("00:15.00")}`, { what: "End at the end" });
  await browser.key("PageDown");
  await browser.waitFor(`${pausedAt("00:13.75")}`, { what: "Page Down one tick back" });
  await browser.key("Home");
  await browser.waitFor(`${pausedAt("00:00.00")}`, { what: "Home at the start" });
  await browser.key("PageUp");
  await browser.waitFor(`${pausedAt("00:01.25")}`, { what: "Page Up one tick on" });
  await browser.key("{");
  await browser.waitFor(`${sceneShown(firstScene.name)}`, { what: "the previous scene" });
  await browser.key("[");
  await browser.waitFor(`${textOf(".stage-label")}.includes("checkpoint")`, { what: "a turn checkpoint" });
  await browser.key("]");
  await browser.waitFor(`!${textOf(".stage-label")}.includes("checkpoint")`, { what: "back to now" });
});

test("play and scrub by mouse: transport buttons, the playhead track, the scene menu, the agent's edit marks and the now button", async () => {
  await open();
  const status = textOf(".bottomline");
  // The stage's transport row: |◀ one frame back, ▶ play or ‖ pause, ▶| one frame forward (drawn as
  // icons on the buttons; the status line's time has no sign before it).
  const transport = (name) => q(`.stage-transport button[aria-label="${name}"]`);
  await showScene(firstScene);
  await browser.click(transport("One frame forward"));
  await browser.waitFor(`${pausedAt("00:00.03")}`);
  await browser.click(transport("One frame back"));
  await browser.waitFor(`${pausedAt("00:00.00")}`);
  await browser.click(transport("Play"));
  await browser.waitFor(`${isPlaying} && !!${transport("Pause")}`);
  await browser.click(transport("Pause"));
  await browser.waitFor(`${isPaused} && !!${transport("Play")}`);
  const track = await browser.box(q('[role="slider"]'));
  await browser.clickAt(track.left + track.width * 0.5, track.y);
  const value = await browser.waitFor(`(() => { const slider = ${q('[role="slider"]')}; const now = Number(slider.getAttribute("aria-valuenow")); return Math.abs(now - Number(slider.getAttribute("aria-valuemax")) / 2) < 0.06 ? now : 0; })()`, { what: "the playhead at the middle" });
  assert.ok(value > 0.4 && value < 0.6, String(value));
  // The time under the frame, then the scene's length; the stage's title shows the same time.
  assert.match(await browser.evaluate(textOf(".stage-transport .transport-time")), /^00:00\.[45]\d/, "the transport's clock");
  assert.equal(await browser.evaluate(textOf(".stage-transport .transport-time .play-total")), "/00:01.00", "the scene's length");
  assert.equal(await browser.evaluate(textOf("#pane-1-title")), "stage", "the stage's title has no second clock");
  await showScene(outroScene);
  await showScene(firstScene);
  // The agent's lane (in the first scene, which its edits changed): a mark per layer each turn
  // changed, named by its turn. The turn reviews load after the page, so wait for them.
  await showLanes(browser);
  const marks = ".p-timeline .lane-agent .agent-mark";
  const chips = await browser.waitFor(`(() => { const found = [...new Set([...document.querySelectorAll(${JSON.stringify(marks)})].map((mark) => mark.getAttribute("aria-label").split(":")[0]))]; return found.length ? found : null; })()`, { what: "the agent's lane has its edits" });
  await browser.click(q(marks));
  await browser.waitFor(`${textOf(".stage-label")}.includes(${JSON.stringify(`${chips[0]} checkpoint`)}) && ${q(marks)}.getAttribute("aria-pressed") === "true"`);
  // The dashboard then shows the scene that turn changed.
  const review = await (await server.api(`/api/dashboard/turn?project=orbit&turn=${encodeURIComponent(chips[0])}`)).json();
  const changed = [firstScene, outroScene].find((entry) => entry.id === review.changes?.scenes?.[0]);
  if (changed) await browser.waitFor(sceneShown(changed.name), { what: `the scene ${chips[0]} changed` });
  if (chips.length > 1) {
    await browser.click(`[...document.querySelectorAll(${JSON.stringify(marks)})].find((mark) => mark.getAttribute("aria-label").startsWith(${JSON.stringify(`${chips[1]}:`)}))`);
    await browser.waitFor(`${textOf(".stage-label")}.includes(${JSON.stringify(`${chips[1]} checkpoint`)})`, { what: "the second turn" });
  }
  // "now" in the stage's header leaves the checkpoint.
  const now = q('.p-stage button[aria-label^="Back to now"]');
  await browser.click(now);
  await browser.waitFor(`!${textOf(".stage-label")}.includes("checkpoint") && !${now} && ![...document.querySelectorAll(${JSON.stringify(marks)})].some((mark) => mark.getAttribute("aria-pressed") === "true")`, { what: "back to now" });
});

async function newTurn(width, text) {
  await asDashboard("act/notes", { project: "orbit", action: "add", text });
  await agent("status");
  const edit = await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { width } }] });
  assert.equal(edit.isError, undefined, edit.text);
  if (!(await browser.evaluate(`!!document.querySelector("#panel-log")`))) await showView("log", { focus: false });
  await browser.waitFor(`[...document.querySelectorAll(".log-row")].some((element) => element.innerText.startsWith(${JSON.stringify(edit.data.turn)}))`, { what: `${edit.data.turn} in the log` });
  return edit.data;
}

/** The top bar's hold button, and the hold shown on it and in the agent's line under the frame. */
const holdButton = q('.topline button[aria-keyshortcuts="h"]');
const holdOn = `(${textOf(".voice-line")}.includes("On hold") && ${holdButton}.getAttribute("aria-pressed") === "true" && ${holdButton}.innerText.trim().toLowerCase() === "release")`;
const holdOff = `(!${textOf(".voice-line")}.includes("On hold") && ${holdButton}.getAttribute("aria-pressed") === "false")`;

const cardWidth = async () => (await snapshot()).record.document.scenes[0].layers.find((layer) => layer.name === "card").width;

test("undo by keyboard: u asks first (n keeps it), y reverts, and the agent is told", async () => {
  await open();
  const before = await cardWidth();
  const { turn, rev } = await newTurn(380, "make the card wider");
  await browser.key("2");
  await browser.waitFor(`document.activeElement?.dataset?.pane === "2"`, { what: "pane 2" });
  await browser.key("u");
  // On the stage the question is the line under the frame: its answers are two buttons, and the
  // page behind stays usable (nothing is inert).
  const asking = `${q(".voice.is-ask")}`;
  await browser.waitFor(`/^Undo (this turn|T\\d+ and \\d+ later turns?)\\?/.test(${asking}?.querySelector(".voice-line")?.innerText ?? "")`, { what: "the undo question under the frame" });
  assert.equal(await browser.evaluate(`!!document.querySelector('[role="alertdialog"]')`), false, "no box on the stage");
  assert.match(await browser.evaluate(`${asking}.innerText`), /Back to rev \d+/);
  assert.match(await browser.evaluate(`${asking}.innerText`), /The agent is told/);
  assert.equal(await browser.evaluate(`!!${q(".voice.is-ask .voice-button.primary")} && ${textOf(".voice.is-ask .voice-button.primary")}`), "Undo");
  assert.equal(await browser.evaluate(textOf(".voice.is-ask .voice-button:not(.primary)")), "Keep");
  assert.equal(await browser.evaluate(`!!document.querySelector("[inert]")`), false, "the page behind is not inert");
  await browser.shot("confirm-modal");
  // The Keep button answers no.
  await browser.click(q(".voice.is-ask .voice-button:not(.primary)"));
  await browser.waitFor(`!document.querySelector(".voice.is-ask")`, { what: "Keep to close the question" });
  assert.equal((await snapshot()).record.revision, rev, "keep changed nothing");
  // Esc and n answer no as well.
  await browser.key("u");
  await browser.waitFor(`!!document.querySelector(".voice.is-ask")`);
  await browser.key("Escape");
  await browser.waitFor(`!document.querySelector(".voice.is-ask")`, { what: "Esc to close the question" });
  assert.equal((await snapshot()).record.revision, rev, "Esc changed nothing");
  await browser.key("u");
  await browser.waitFor(`!!document.querySelector(".voice.is-ask")`);
  await browser.key("n");
  await browser.waitFor(`!document.querySelector(".voice.is-ask")`);
  assert.equal((await snapshot()).record.revision, rev, "n changed nothing");
  await browser.key("u");
  await browser.waitFor(`!!document.querySelector(".voice.is-ask")`);
  await browser.key("y");
  await until(async () => (await snapshot()).record.revision === rev + 1, "the revert");
  assert.equal(await cardWidth(), before);
  assert.match(inboxText(await agent("status")), new RegExp(`you reverted ${turn}`));
  const rowOf = (id) => `[...document.querySelectorAll(".log-row")].find((element) => element.innerText.startsWith(${JSON.stringify(id)}))`;
  // The undone turn keeps a tick, dimmed, and says "reverted at rev N"; a screen reader says "undone".
  await browser.waitFor(`!!${rowOf(turn)}?.querySelector(".mark.s-undone.m-done svg")`, { what: "the undone mark" });
  // The orange ring marks a turn that put the project back: here the agent restores the wider
  // card. A turn shows the working spinner for 20 s after its last call, so the page's clock
  // goes 25 s ahead to see its mark now, and back afterwards.
  await asDashboard("act/notes", { project: "orbit", action: "add", text: "put the wider card back" });
  await agent("status");
  const restored = await agent("history", { action: "restore", rev });
  assert.equal(restored.isError, undefined, restored.text);
  const restoreTurn = (await snapshot()).events.filter((call) => call.verb === "history" && call.by !== "you").at(-1)?.turn;
  assert.ok(restoreTurn, "the restore belongs to a turn");
  await browser.evaluate(`(() => { window.realNow = Date.now; Date.now = () => window.realNow.call(Date) + 25_000; })()`);
  try {
    await browser.waitFor(`!!${rowOf(restoreTurn)}?.querySelector(".mark.s-reverted.m-reverted svg")`, { what: "the restored mark" });
    // The ring is the accent color and a little larger than the tick; a screen reader says "restored".
    const marks = await browser.evaluate(`(() => { const size = (row) => { const box = row.querySelector(".mark svg")?.getBoundingClientRect(); return box ? [box.width, box.height] : null; }; const undone = ${rowOf(turn)}; const ring = ${rowOf(restoreTurn)}; const done = [...document.querySelectorAll(".log-row")].find((row) => row.querySelector(".mark.s-done")); const dash = getComputedStyle(document.querySelector(".dash")); return { word: ring.querySelector(".sr-only").textContent, colour: getComputedStyle(ring.querySelector(".mark")).color, accent: dash.getPropertyValue("--accent").trim(), ring: size(ring), tick: done && size(done), undoneWord: undone.querySelector(".sr-only").textContent, undoneText: undone.innerText, undoneColour: getComputedStyle(undone.querySelector(".mark")).color, doneColour: done && getComputedStyle(done.querySelector(".mark")).color }; })()`);
    assert.equal(marks.word, "restored");
    assert.equal(marks.colour, await browser.evaluate(token("--accent")), `the ring is the accent color (${marks.accent})`);
    assert.ok(marks.ring[0] >= 9 && marks.ring[0] <= 11 && marks.ring[1] >= 9 && marks.ring[1] <= 11, `the ring is about 10 px: ${marks.ring}`);
    // A done turn's tick is there, about 10 px and not taller than the ring, in the green --ok.
    assert.ok(marks.tick && marks.doneColour, `a done turn's tick is drawn: ${JSON.stringify(marks)}`);
    assert.ok(marks.tick[0] >= 8 && marks.tick[0] <= 12 && marks.tick[1] >= 6 && marks.tick[1] <= marks.ring[1], `the tick is about 10 px and not taller than the ring: ${marks.tick}`);
    assert.equal(marks.doneColour, await browser.evaluate(token("--ok")), "a done tick is green (--ok)");
    assert.equal(marks.undoneWord, "undone");
    assert.match(marks.undoneText, /reverted at rev \d+/);
    assert.notEqual(marks.undoneColour, marks.colour, "the undone tick is not the accent color");
    assert.notEqual(marks.undoneColour, marks.doneColour, "the undone tick is dimmer than a done one");
  } finally {
    await browser.evaluate(`(() => { if (window.realNow) Date.now = window.realNow; })()`);
  }
});

test("undo by mouse: a log row opens the turn review, its revert button asks, the confirm button reverts", async () => {
  await open();
  const before = await cardWidth();
  const { turn, rev } = await newTurn(400, "try it wider again");
  await browser.click(`[...document.querySelectorAll(".log-row")].find((element) => element.innerText.startsWith(${JSON.stringify(turn)}))`);
  await browser.click(button(`review ${turn}`, ".p-log"));
  await browser.waitFor(`[...document.querySelectorAll(".compare img")].filter((image) => image.complete && image.naturalWidth).length === 2`, { what: "before and after frames" });
  assert.ok(await browser.evaluate(pageHas("Changed card", ".screen")));
  await browser.shot("turn-review");
  await browser.click(button("Revert this turn", ".screen"));
  await browser.click(button("Revert", '[role="alertdialog"]'));
  await until(async () => (await snapshot()).record.revision === rev + 1, "the revert");
  assert.equal(await cardWidth(), before);
  assert.match(inboxText(await agent("status")), new RegExp(`you reverted ${turn}`));
});

test("hold by keyboard and by mouse pauses agent writes, and the agent is told", async () => {
  await open();
  const rev = (await snapshot()).record.revision;
  await browser.key("H");
  await browser.waitFor(holdOn, { what: "the hold on the top bar and the status line" });
  const held = await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { width: 250 } }] });
  assert.equal(held.data.held, true);
  assert.equal((await snapshot()).record.revision, rev);
  await browser.key("h");
  await browser.waitFor(holdOff, { what: "h releases it" });
  assert.match(inboxText(await agent("status")), /hold released: agent writes work again/);

  await browser.click(holdButton);
  await browser.waitFor(holdOn, { what: "the hold by mouse" });
  assert.equal((await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { width: 250 } }] })).data.held, true);
  await browser.click(holdButton);
  await browser.waitFor(holdOff, { what: "released by mouse" });
  assert.equal((await snapshot()).hold.on, false);
});

const renderRow = (state) => `[...document.querySelectorAll(".p-session div.row")].find((row) => ${state})`;
const hasRender = (state) => `!!${renderRow(state)}`;
/** The render row of job `id`. The name's title reads "final R2 r3 mp4". */
const renderRowOf = (id) => renderRow(`row.querySelector(".render-name")?.title.split(" ")[1] === ${JSON.stringify(id)}`);
/** Waits for a render row with a cancel button, and checks that the button names its render. */
async function runningRender() {
  const running = await browser.waitFor(`(() => { const row = ${renderRow(`!!row.querySelector("button")`)}; return row && { title: row.querySelector(".render-name").title, name: row.querySelector("button").getAttribute("aria-label") }; })()`,
    { timeout: 30_000, what: "a running render" });
  const [quality, id] = running.title.trim().split(/\s+/);
  assert.equal(running.name, `Cancel the ${quality} render ${id}`);
  return id;
}

test("export, cancel, download and share, by keyboard and by mouse", async () => {
  await open();
  await showScene(firstScene);
  // The renders are in the agent pane's session view.
  await showView("session", { focus: false });
  await browser.key("1");
  await browser.key("e");
  await browser.waitFor(hasRender(`!!row.querySelector("a[download]")`), { timeout: 90_000, what: "a finished render" });
  const downloaded = browser.once((message) => message.download, 30_000, "the download");
  await browser.click(`${renderRow(`!!row.querySelector("a[download]")`)}.querySelector("a[download]")`);
  const { download } = await downloaded;
  assert.equal(download.state, "completed");
  assert.ok(download.bytes > 1000, `${download.bytes} bytes`);
  assert.equal((await readFile(download.file)).subarray(4, 8).toString("latin1"), "ftyp", "an MP4 file");

  // Keyboard: Enter on the focused download link.
  const again = browser.once((message) => message.download, 30_000, "the keyboard download");
  await browser.evaluate(`${renderRow(`!!row.querySelector("a[download]")`)}.querySelector("a[download]").focus()`);
  await browser.key("Enter");
  assert.equal((await again).download.state, "completed");

  // Cancel: x by key, [x] by mouse. Each cancel must reach a render that is still going. At
  // 640×360 the 15 s outro renders in about 2 s, and the dashboard hears how renders are going
  // once a second, so on a slow machine it could finish before the cancel got there (CI then
  // timed out waiting for "canceled"). At 3840×2160 the same scene takes many seconds.
  const resize = async (width, height) => {
    const resized = await agent("edit", { ops: [{ op: "update_scene", scene: outroScene.id, properties: { width, height } }] });
    assert.equal(resized.isError, undefined, resized.text);
  };
  await resize(3840, 2160);
  try {
    await showScene(outroScene);
    await browser.key("e");
    const keyed = await runningRender();
    await browser.key("x");
    await browser.waitFor(`${renderRowOf(keyed)}?.innerText.toLowerCase().includes("canceled")`, { timeout: 30_000, what: `${keyed} canceled by x` });
    await browser.click(button("Render", ".p-session"));
    const clicked = await runningRender();
    assert.notEqual(clicked, keyed);
    await browser.click(q(`.p-session button[aria-label="Cancel the final render ${clicked}"]`));
    await browser.waitFor(`${renderRowOf(clicked)}?.innerText.toLowerCase().includes("canceled")`, { timeout: 30_000, what: `${clicked} canceled by its cancel button` });
    // The server agrees, and both were the long 4K render.
    const told = (await snapshot()).renders.filter((job) => [keyed, clicked].includes(job.id)).map(({ id, status, width }) => ({ id, status, width }));
    assert.deepEqual(told, [{ id: keyed, status: "canceled", width: 3840 }, { id: clicked, status: "canceled", width: 3840 }]);
  } finally {
    // Back to 640×360, the size the later tests were written for, even when a step above failed.
    await resize(640, 360);
  }

  // Share: from the dashboard it needs no approval. The Share button opens the share box, and
  // Make link shows the link in it.
  await browser.click(button("Share", ".p-session"));
  await browser.waitFor(`!!${q("#share-box")}`, { what: "the share box" });
  await browser.click(button("Make link", "#share-box"));
  await browser.waitFor(`/^https?:\\/\\//.test(${textOf("#share-box .share-url")})`, { what: "the share link" });
  const first = await browser.evaluate(textOf("#share-box .share-url"));
  await browser.evaluate(`${button("Make link", "#share-box")}.focus()`);
  await browser.key("Enter");
  await browser.waitFor(`${textOf("#share-box .share-url")} !== ${JSON.stringify(first)}`, { what: "a second share link" });
  assert.equal((await snapshot()).approvals.filter((entry) => entry.status === "pending").length, 0);
});

/** Moves the projects list's cursor to `id` with j and k. */
async function cursorTo(id) {
  for (let step = 0; step < 20; step += 1) {
    const { ids, at } = await browser.evaluate(`(() => { const rows = [...document.querySelectorAll(".proj-list [data-id]")]; return { ids: rows.map((row) => row.dataset.id), at: rows.findIndex((row) => row.getAttribute("aria-selected") === "true") }; })()`);
    const want = ids.indexOf(id);
    assert.ok(want >= 0, `${id} is in the table`);
    if (want === at) return;
    await browser.key(want > at ? "j" : "k");
  }
  throw new Error(`Could not move to ${id}`);
}

/** True while the project list has a card for project `id` (the cards show names, so the id is in data-id). */
const inList = (id) => `!!document.querySelector(${JSON.stringify(`.proj-list [data-id="${id}"]`)})`;

const projectIds = async () => (await snapshot()).projects.map((project) => project.id);

test("projects by keyboard: Enter opens, y duplicates, Delete moves to Trash after a confirm", async () => {
  await open();
  await browser.key(":");
  await browser.waitFor(`document.activeElement?.id === "command-input"`);
  await browser.type("projects");
  await browser.key("Enter");
  await browser.waitFor(`${textOf("#screen-title")}.startsWith("Projects")`);
  const before = await projectIds();
  await cursorTo("orbit");
  await browser.key("y");
  const copy = (await until(async () => (await projectIds()).find((id) => !before.includes(id)), "the copy"));
  await browser.waitFor(inList(copy));
  await cursorTo(copy);
  await browser.key("Delete");
  await browser.waitFor(`${textOf('[role="alertdialog"]')}.includes(${JSON.stringify(`Move ${copy} to Trash?`)})`);
  await browser.key("y");
  await until(async () => !(await projectIds()).includes(copy), "the copy in Trash");
  await browser.waitFor(`!${inList(copy)}`);
  await cursorTo("orbit");
  await browser.key("Enter");
  await browser.waitFor(`!!document.querySelector("section.pane") && ${q("#project-name")}?.innerText.trim() === "Orbit"`);
});

test("projects by mouse: duplicate, archive with its confirm button, open", async () => {
  await open();
  await commandByMouse("projects");
  const before = await projectIds();
  await browser.click(q('[aria-label="Duplicate orbit"]'));
  const copy = await until(async () => (await projectIds()).find((id) => !before.includes(id)), "the copy");
  await browser.click(q(`[aria-label="Move ${copy} to Trash"]`));
  await browser.click(button("Move to Trash", '[role="alertdialog"]'));
  await until(async () => !(await projectIds()).includes(copy), "the copy in Trash");
  await browser.waitFor(`!${inList(copy)}`, { what: "the copy to leave the list" });
  // The open project has no Open button; its card's picture opens it.
  await browser.click(q('.proj-row[data-id="orbit"] .proj-open'));
  await browser.waitFor(`!!document.querySelector("section.pane")`);
});

test("a screen opened from the command list takes the focus, so Enter, j and k act on that screen", async () => {
  await open();
  await commandByMouse("projects");
  await browser.waitFor(`document.activeElement?.matches("section.screen") && ${textOf("#screen-title")}.startsWith("Projects")`, { what: "the focus on the projects screen" });
  await cursorTo("orbit");
  await browser.key("Enter");
  await browser.waitFor(`!!document.querySelector("section.pane") && ${q("#project-name")}?.innerText.trim() === "Orbit"`, { what: "Enter to open orbit, not to press the projects button again" });
  for (const name of ["variants", "settings"]) {
    await commandByMouse(name);
    await browser.waitFor(`document.activeElement?.matches("section.screen")`, { what: `the focus on the ${name} screen` });
    await browser.key("Escape");
    await browser.waitFor(`!!document.querySelector("section.pane")`, { what: `Esc from ${name}` });
  }
  // "shares" is not a screen any more: it opens the share box, which takes the focus and closes with Esc.
  await commandByMouse("shares");
  await browser.waitFor(`!!${q("#share-box")} && !!document.activeElement?.closest("#share-box")`, { what: "the focus in the share box" });
  await browser.key("Escape");
  await browser.waitFor(`!${q("#share-box")}`, { what: "Esc from the share box" });
});

test("variants by keyboard: a number key picks, r rejects all with a reason", async () => {
  await open();
  await browser.key(":");
  await browser.type("variants");
  await browser.key("Enter");
  await browser.waitFor(`${textOf("#screen-title")} === "Variants"`);
  await browser.waitFor(`[...document.querySelectorAll(".variant img")].filter((image) => image.complete && image.naturalWidth).length === 2`, { what: "both variant frames" });
  await browser.shot("variants");
  await browser.key("2");
  await noteNamed(`I pick variant 2: ${outroScene.name}`);
  await browser.key("r");
  await browser.waitFor(`document.activeElement?.id === "reject-note"`);
  await browser.type("too slow");
  await browser.key("Enter");
  await noteNamed("None of the 2 variants work: too slow");
});

test("variants by mouse: a pick button, then reject all with a reason", async () => {
  await open();
  await commandByMouse("variants");
  await browser.click(q(`.screen button[aria-label="Pick ${firstScene.name}"]`));
  await noteNamed(`I pick variant 1: ${firstScene.name}`);
  await browser.click(button("None of these", ".screen"));
  await browser.click(q("#reject-note"));
  await browser.type("more contrast");
  await browser.click(button("Send", ".page-ask"));
  await noteNamed("None of the 2 variants work: more contrast");
});

test("settings by keyboard and by mouse save at once", async () => {
  try {
    await open();
    await browser.key(":");
    await browser.type("settings");
    await browser.key("Enter");
    await browser.waitFor(`${textOf("#screen-title")} === "settings"`);
    await browser.evaluate(`${q("#set-frames")}.focus()`);
    await browser.selectAll();
    await browser.type("900");
    await browser.key("Tab");
    await until(async () => (await settings()).limits.finalRenderFrames === 900, "the frame limit");
    // A choice is a radio group: typing the start of an option picks it.
    await browser.evaluate(`${q("#set-approval-share-link input:checked")}.focus()`);
    await browser.key("d");
    await until(async () => (await settings()).approvals["share-link"] === "deny", "the share rule");
    // ↓ moves to the next row's choice; a number jumps to that pane (settings.jsx settingsKeys).
    await browser.key("ArrowDown");
    await browser.waitFor(`!!document.activeElement?.closest("#set-approval-crew-budget")`, { what: "↓ to the next approval" });
    await browser.key("5");
    await browser.waitFor(`!!document.activeElement?.closest('.set-pane[data-pane="5"]')`, { what: "5 to the render pane" });
    // The long settings screen scrolls in its own box: the window itself has nothing to scroll.
    assert.deepEqual(await browser.evaluate(`[document.documentElement.scrollHeight - innerHeight, ${q(".screen-wrap")}.scrollHeight > ${q(".screen-wrap")}.clientHeight]`), [0, true], "only the settings screen scrolls");
    await browser.evaluate(`${q("#set-channels")}.focus()`);
    await browser.key(" ");
    await until(async () => (await settings()).channels === true, "channels on");
    await browser.shot("settings");

    await browser.click(q("#set-channels"));
    await until(async () => (await settings()).channels === false, "channels off by click");
    await browser.click(button("Clear the frame cache", ".screen"));
    await browser.waitFor(`document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent === "Frame cache cleared."`);
  } finally {
    // Put them back even if a step failed: the share rule "deny" would refuse later tests' links.
    await asDashboard("settings", { approvals: { "share-link": "ask" }, limits: { finalRenderFrames: 600 }, channels: false }, "PUT");
  }
});

test("rendering settings by keyboard and by mouse: graphics card, frames at once, video encoder and quality, render cache", async () => {
  try {
    await open();
    await browser.key(":");
    await browser.type("settings");
    await browser.key("Enter");
    await browser.waitFor(`${textOf("#screen-title")} === "settings"`);
    // The device list has loaded once Auto names what it picks (or says it found no card).
    await browser.waitFor(`!${q(".render-devices")}?.textContent.includes("Looking")`, { what: "the devices" });
    // Each control is described by its hint.
    for (const id of ["set-graphics", "set-frames-at-once", "set-keep-free", "set-render-cache", "set-video-encoder", "set-video-quality"])
      assert.equal(await browser.evaluate(`${q(`#${id}`)}.getAttribute("aria-describedby")`), `${id}-hint`, id);
    await browser.evaluate(`${q("#set-graphics")}.focus()`);
    await browser.key("p");
    await until(async () => (await settings()).compute.graphics === "processor", "processor only");
    await browser.evaluate(`${q("#set-frames-at-once input:checked")}.focus()`);
    await browser.key("4");
    await until(async () => (await settings()).compute.framesAtOnce === 4, "4 frames at once");
    // Every whole number the server takes (1 to 8) has its option, so a saved 7 shows as 7, not 1.
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll("#set-frames-at-once input")].map((option) => option.value)`),
      ["1", "2", "3", "4", "5", "6", "7", "8", "auto"]);
    await asDashboard("settings", { compute: { framesAtOnce: 7 } }, "PUT");
    await browser.waitFor(`${q("#set-frames-at-once input:checked")}?.value === "7"`, { what: "a saved 7 shown as 7" });
    // Auto is named after what renders draw on with this server's variables (render-devices.mjs
    // autoGraphics; under xvfb-run on WSL that is the processor), never a virtual display.
    const devices = await (await server.api("/api/dashboard/render/devices")).json();
    assert.equal(await browser.evaluate(`${q("#set-graphics")}.options[0].textContent`), devices.graphics.auto ? `Auto (${devices.graphics.auto})` : "Auto");
    // A card saved in another case is that card, as renders match it, not "not found".
    const card = devices.graphics.canChoose ? devices.graphics.cards.at(-1) : null;
    if (card) {
      await asDashboard("settings", { compute: { graphics: card.name.toLowerCase() } }, "PUT");
      await browser.waitFor(`${q("#set-graphics")}.value === ${JSON.stringify(card.name.toLowerCase())}`, { what: "the saved card chosen" });
      assert.equal(await browser.evaluate(`${q("#set-graphics")}.selectedOptions[0].textContent`), card.name);
      assert.equal(await browser.evaluate(`[...${q("#set-graphics")}.options].some((option) => option.textContent.includes("not found"))`), false);
      await asDashboard("settings", { compute: { graphics: "processor" } }, "PUT");
    }
    // On macOS and Windows renders cannot choose a card by name, so a saved name that is one of
    // the cards there is shown as acting as Auto, never as chosen. The page hears a Mac's answer.
    const mac = { ...devices, overrides: { graphics: null, card: [], framesAtOnce: null }, lastRender: null,
      graphics: { platform: "darwin", cards: [{ name: "AMD Radeon Pro 5500M", vendor: "AMD" }, { name: "Intel UHD Graphics 630", vendor: "Intel" }],
        canChoose: false, environment: {}, auto: "AMD Radeon Pro 5500M", saved: { name: "AMD Radeon Pro 5500M", found: true, used: false } } };
    await browser.evaluate(`(() => {
      const answer = ${JSON.stringify(JSON.stringify(mac))};
      window.kinoRealFetch = window.fetch;
      window.fetch = (url, options) => String(url).includes("/api/dashboard/render/devices")
        ? Promise.resolve(new Response(answer, { headers: { "content-type": "application/json" } })) : window.kinoRealFetch(url, options);
    })()`);
    try {
      await asDashboard("settings", { compute: { graphics: "AMD Radeon Pro 5500M" } }, "PUT");
      await browser.click(button("Detect again", ".screen"));
      await browser.waitFor(`${q("#set-graphics")}.selectedOptions[0]?.textContent === "AMD Radeon Pro 5500M (acts as Auto here)"`, { what: "the Mac's saved card shown as Auto" });
      assert.match(await browser.evaluate(textOf("#set-graphics-hint")), /A card cannot be chosen by name on this computer, so "AMD Radeon Pro 5500M" acts as Auto\./);
      await browser.shot("settings-rendering-mac");
    } finally {
      await browser.evaluate("window.fetch = window.kinoRealFetch ?? window.fetch");
      await asDashboard("settings", { compute: { graphics: "processor" } }, "PUT");
      await browser.click(button("Detect again", ".screen"));
      await browser.waitFor(`${q(".render-devices")}?.textContent.includes(${JSON.stringify(devices.graphics.cards.map((entry) => entry.name).join(", ") || "No graphics card found")})`, { what: "this computer's devices again" });
    }
    await browser.evaluate(`${q("#set-video-encoder")}.focus()`);
    await browser.key("s");
    await until(async () => (await settings()).exports.videoEncoder === "software", "the software encoder");
    await browser.evaluate(`${q("#set-video-quality input:checked")}.focus()`);
    await browser.key("h");
    await until(async () => (await settings()).exports.videoQuality === "high", "high quality");
    await browser.evaluate(`${q("#set-keep-free")}.focus()`);
    await browser.selectAll();
    await browser.type("25");
    await browser.key("Tab");
    await until(async () => (await settings()).compute.keepFreePercent === 25, "25% left free");
    await browser.evaluate(`${q("#set-render-cache")}.focus()`);
    await browser.selectAll();
    await browser.type("300");
    await browser.key("Tab");
    await until(async () => (await settings()).compute.renderCacheMegabytes === 300, "a 300 MB render cache");
    await browser.shot("settings-rendering");
    await browser.click(button("Clear the render cache", ".screen"));
    await browser.waitFor(`document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent.startsWith("Render cache cleared")`);
    await browser.click(button("Detect again", ".screen"));
    await browser.waitFor(`${button("Detect again", ".screen")} !== null`, { what: "detected again" });
  } finally {
    await asDashboard("settings", { exports: { videoEncoder: "auto", videoQuality: "standard" },
      compute: { graphics: "auto", framesAtOnce: 1, keepFreePercent: 20, renderCacheMegabytes: 512 } }, "PUT");
  }
});

test("media by mouse (drop a file on the window) and by keyboard (the add files button)", async () => {
  await open();
  const dropped = path.join(folder, "dropped.png");
  const picked = path.join(folder, "picked.png");
  await writeFile(dropped, DOT_PNG);
  await writeFile(picked, DOT_PNG);
  const at = await browser.box(q(".stage"));
  const data = { items: [], files: [dropped], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) await browser.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data });
  const droppedNote = await noteNamed('I added media "dropped.png"');
  assert.match(droppedNote.text, /src \/api\/media\/[\w-]+\.png/);

  await browser.send("Page.setInterceptFileChooserDialog", { enabled: true });
  const chooser = browser.once((message) => message.event === "Page.fileChooserOpened", 15_000, "the file chooser");
  await showView("session", { focus: false });
  await browser.evaluate(`${button("Add files", ".p-session")}.focus()`);
  await browser.key("Enter");
  const { params } = await chooser;
  await browser.send("DOM.setFileInputFiles", { files: [picked], backendNodeId: params.backendNodeId });
  await browser.send("Page.setInterceptFileChooserDialog", { enabled: false });
  await noteNamed('I added media "picked.png"');
});

test("panes, zoom, filter, help, transcript, full frames, follow and the command line by keyboard and mouse", async () => {
  await open();
  for (const number of ["1", "2", "3"]) {
    await browser.key(number);
    await browser.waitFor(`document.activeElement?.dataset?.pane === "${number}"`, { what: `pane ${number}` });
    // One pane at a time has the focus frame. Pane 2 (the list) opens when its key is pressed.
    const focused = await browser.evaluate(`[...document.querySelectorAll("section.pane")].filter((pane) => pane.dataset.focused === "true").map((pane) => pane.dataset.pane)`);
    assert.deepEqual(focused, [number]);
  }
  // 4 and 5 are no panes now.
  await browser.key("4");
  assert.equal(await browser.evaluate(`document.activeElement?.dataset?.pane`), "3");
  // Tab goes into the focused pane's buttons and fields, then on through every pane's (the
  // stage's are its scene menu and transport row) to the key line, and the pane frame follows the focus.
  await browser.key("1");
  await browser.waitFor(`document.activeElement?.dataset?.pane === "1"`);
  const where = `(() => { const element = document.activeElement; return element?.closest(".bottomline") ? "bottomline" : element?.closest("section.pane")?.dataset.pane ?? element?.tagName; })()`;
  const visited = [];
  while (visited.at(-1) !== "bottomline" && visited.length < 300) {
    await browser.key("Tab");
    visited.push(await browser.evaluate(where));
    if (visited.length === 1) {
      assert.equal(await browser.evaluate(`document.activeElement.matches("button, a, input, select, textarea, [tabindex]")`), true, "a control, not the pane itself");
      assert.equal(await browser.evaluate(`${q('section[data-pane="1"]')}.dataset.focused`), "true");
    }
  }
  assert.equal(visited[0], "1", `Tab from pane 1 goes into pane 1 (went to ${visited[0]})`);
  for (const stop of ["1", "2", "3", "bottomline"]) assert.ok(visited.includes(stop), `Tab reaches ${stop}: ${visited.join(" ")}`);
  await browser.waitFor(`${q('section[data-pane="3"]')}.dataset.focused === "true"`, { what: "the frame on the last pane Tab went through" });
  await browser.key("1");
  await browser.waitFor(`document.activeElement?.dataset?.pane === "1"`);
  await browser.key("+");
  await browser.waitFor(`!!document.querySelector('.pane.is-zoomed[data-pane="1"]')`);
  await browser.key("_");
  await browser.waitFor(`!document.querySelector(".pane.is-zoomed")`);
  await browser.key("/");
  await browser.waitFor(`document.activeElement?.id === "log-filter"`);
  await browser.type("zzz-nothing");
  await browser.waitFor(pageHas("nothing matches", "#panel-log"));
  await browser.keys("Escape", "Escape");
  await browser.waitFor(`!document.querySelector("#log-filter")`);
  await browser.key("?");
  await browser.waitFor(`${textOf("#screen-title")} === "Keys"`);
  assert.ok(await browser.evaluate(`${textOf(".screen")}.toLowerCase().includes("next, previous button or field")`), "the help says what Tab does");
  await browser.key("Escape");
  await browser.key("t");
  await browser.waitFor(`${textOf("#screen-title")}.startsWith("Transcript")`);
  await browser.key("Escape");
  await browser.key("o");
  await browser.waitFor(`(${q(".stage-label")}?.title ?? "").includes("· full ·")`);
  await browser.key("o");
  await browser.waitFor(`(${q(".stage-label")}?.title ?? "").includes("· draft ·")`);
  // Follow is on by default and says nothing; turned off, the top line says so.
  assert.equal(await browser.evaluate(`!!document.querySelector(".topline .follow")`), false);
  await browser.key("f");
  await browser.waitFor(`${q(".topline .follow")}?.getAttribute("aria-pressed") === "false"`);
  await browser.key("f");
  await browser.waitFor(`!document.querySelector(".topline .follow")`);
  await browser.key(":");
  await browser.waitFor(`document.activeElement?.id === "command-input"`);
  await browser.key("Escape");
  await browser.waitFor(`!document.querySelector("#command-input")`);

  // The same by mouse.
  // The panes have no title line now: a click on the timeline's ruler puts the frame on pane 3.
  await browser.click(q('section[data-pane="3"] [role="slider"]'));
  await browser.waitFor(`${q('section[data-pane="3"]')}.dataset.focused === "true"`);
  await browser.click(q("#tab-checks"));
  await browser.waitFor(`${q("#tab-checks")}.getAttribute("aria-selected") === "true" && !!document.querySelector("#panel-checks") && ${q('section[data-pane="2"]')}.dataset.focused === "true"`);
  // The key line has no keys button now (each key is in its button's tooltip): the command
  // list (⌘K or ":") opens the keys screen, and the top line's Stage tab closes it by mouse.
  await browser.key(":");
  await browser.waitFor(`document.activeElement?.id === "command-input"`);
  await browser.type("help");
  await browser.key("Enter");
  await browser.waitFor(`${textOf("#screen-title")} === "Keys"`);
  await browser.click(q('.topline .tab[data-view="main"]'));
  await browser.waitFor(`!document.querySelector(".help-screen")`, { what: "keys screen closed by the Stage tab" });
  await browser.key("f");
  await browser.click(button("follow off", ".topline"));
  await browser.waitFor(`!document.querySelector(".topline .follow")`, { what: "follow on by mouse" });
});

test("stage zoom: the zoom menu draws the frame at 200% in a box that scrolls, and the full-window button fills the window and restores", async () => {
  await open();
  const wrap = q(".stage-wrap");
  const zoomButton = q("#stage-zoom");
  // By mouse: the menu opens under its button, 200% picks scene pixels at twice their size.
  await browser.click(zoomButton);
  await browser.waitFor(`${zoomButton}.getAttribute("aria-expanded") === "true" && !!document.querySelector('[role="menu"][aria-label="Stage zoom"]')`, { what: "the zoom menu open" });
  await browser.click(menuItem("200%"));
  await browser.waitFor(`!document.querySelector('[role="menu"]') && ${zoomButton}.innerText.trim() === "200%" && ${zoomButton}.getAttribute("aria-label") === "Stage zoom: 200%"`, { what: "200% picked" });
  const drawn = await browser.waitFor(`(() => { const box = ${wrap}; const stage = document.querySelector(".stage"); return box.classList.contains("scrolls") && box.scrollWidth > box.clientWidth + 10 && stage ? stage.getBoundingClientRect().width : 0; })()`, { what: "a frame wider than the pane, in a box that scrolls" });
  const shownName = await browser.evaluate(`${q("#scene-menu .menu-value")}.innerText.trim()`);
  const scene = (await snapshot()).record.document.scenes.find((entry) => entry.name === shownName);
  assert.equal(Math.round(drawn), scene.width * 2, `the frame is drawn at twice the scene's width (${scene.width} px)`);
  await browser.evaluate(`${wrap}.scrollLeft = 120`);
  assert.ok(await browser.evaluate(`${wrap}.scrollLeft`) > 100, "the box scrolls sideways");
  // The box that scrolls is named, Tab can reach it, and the arrow keys move the frame in it
  // (the playhead stays where it is).
  assert.deepEqual(await browser.evaluate(`[${wrap}.getAttribute("role"), ${wrap}.getAttribute("aria-label"), ${wrap}.tabIndex]`),
    ["region", "The frame at 200%: the arrow keys scroll it", 0]);
  await browser.evaluate(`${wrap}.focus()`);
  const [left, top] = await browser.evaluate(`[${wrap}.scrollLeft, ${wrap}.scrollTop]`);
  const playTime = await browser.evaluate(textOf(".play-time"));
  await browser.key("ArrowRight");
  await browser.key("ArrowDown");
  await browser.waitFor(`${wrap}.scrollLeft >= ${left + 39} && (${wrap}.scrollTop >= ${top + 39} || ${wrap}.scrollHeight <= ${wrap}.clientHeight)`, { what: "→ and ↓ move the frame" });
  await browser.key("ArrowLeft");
  await browser.waitFor(`Math.abs(${wrap}.scrollLeft - ${left}) < 2`, { what: "← moves it back" });
  assert.equal(await browser.evaluate(textOf(".play-time")), playTime, "the arrows did not move the playhead");
  // By keyboard: Enter opens the menu on the checked item, Home goes to Fit, Enter picks it.
  await browser.evaluate(`${zoomButton}.focus()`);
  await browser.key("Enter");
  await browser.waitFor(`document.activeElement?.getAttribute("role") === "menuitemradio" && document.activeElement.innerText.trim() === "200%"`, { what: "the focus on the checked item" });
  // A scroll that leaves the button where it is (here the frame moves under the list) keeps the
  // list open; before, any scroll closed it, so a pan just before opening it could shut it.
  await browser.evaluate(`${wrap}.scrollLeft += 30`);
  await sleep(150);
  assert.ok(await browser.evaluate(`!!document.querySelector('[role="menu"][aria-label="Stage zoom"]') && document.activeElement?.innerText.trim() === "200%"`), "the list stays open");
  await browser.key("Home");
  await browser.waitFor(`document.activeElement?.innerText.trim() === "Fit"`);
  await browser.key("Enter");
  await browser.waitFor(`!${wrap}.classList.contains("scrolls") && ${wrap}.scrollWidth <= ${wrap}.clientWidth && document.activeElement === ${zoomButton}`, { what: "Fit again, the focus back on the button" });

  // The render menu sits at the window's right edge: its list opens leftward, wholly inside the window.
  await browser.click(q("#render-menu"));
  await browser.waitFor(`!!document.querySelector('[role="menu"][aria-label="Render"]')?.style.maxHeight`, { what: "the render list placed" });
  assert.ok(await browser.evaluate(`document.querySelector('[role="menu"][aria-label="Render"]').getBoundingClientRect().right <= window.innerWidth`), "the render list inside the window");
  await browser.key("Escape");

  // The full-window button: the stage pane fills the window; pressed again, the panes come back.
  const full = q('.p-stage button[aria-label^="Fill the window"]');
  await browser.click(full);
  await browser.waitFor(`!!document.querySelector('.pane.is-zoomed[data-pane="1"]') && ${q('.p-stage .stage-toolbar button[aria-pressed="true"][aria-label]')}?.getAttribute("aria-label").startsWith("Restore the panes")`, { what: "the stage filling the window" });
  await browser.click(q('.p-stage button[aria-label^="Restore the panes"]'));
  await browser.waitFor(`!document.querySelector(".pane.is-zoomed") && ${full}?.getAttribute("aria-pressed") === "false"`, { what: "the panes back" });
});

test("the status line's check counts are a button that opens the checks view", async () => {
  await open();
  // The list is closed until it is opened: the clock button beside the agent's line opens it.
  await browser.click(q('button[aria-label="Earlier lines"]'));
  await browser.waitFor(`${q("#tab-agent")}?.getAttribute("aria-selected") === "true"`, { what: "the activity view" });
  const counts = q(".statusline .s-checks");
  await browser.waitFor(`/^Checks: \\d+ errors?, \\d+ warnings?$/.test(${counts}?.innerText.trim() ?? "")`, { what: "the check counts" });
  assert.equal(await browser.evaluate(`${counts}.tagName`), "BUTTON");
  await browser.click(counts);
  await browser.waitFor(`${q("#tab-checks")}?.getAttribute("aria-selected") === "true" && !!${q("#panel-checks")}`, { what: "the checks view open" });
});

test("a long note under the frame (a failed frame's error) and window resizes cause no ResizeObserver loop", async () => {
  await open();
  await browser.waitFor(`!!document.querySelector(".stage")`, { what: "the stage" });
  // The label line under the frame is as wide as the frame, so its height changes with the
  // frame's size. It used to be measured and drawn inside the observer's own callback, which
  // resized it again in the same display frame: the page logged a ResizeObserver loop error.
  await browser.evaluate(`(() => {
    window.resizeLoops = 0;
    window.resizeLoopWatch = (event) => { if (/ResizeObserver loop/.test(event.message)) window.resizeLoops += 1; };
    window.addEventListener("error", window.resizeLoopWatch);
  })()`);
  const line = "Video layer clip has no src (no media file), so this frame could not be drawn. ";
  try {
    for (const [index, [width, height]] of [[1300, 760], [1500, 700], [1200, 820], [1440, 900]].entries()) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await browser.evaluate(`(() => {
        const note = document.createElement("p");
        note.className = "stage-notes";
        note.textContent = ${JSON.stringify(line)}.repeat(${2 + index});
        document.querySelector(".stage-group > div:last-child").replaceChildren(note);
      })()`);
      // A ResizeObserver loop is reported at the end of the frame it happens in: three display frames is enough.
      await browser.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
    }
    assert.equal(await browser.evaluate("window.resizeLoops"), 0, "no ResizeObserver loop error");
  } finally {
    await browser.evaluate(`(() => {
      window.removeEventListener("error", window.resizeLoopWatch);
      document.querySelector(".stage-group > div:last-child")?.replaceChildren();
    })()`).catch(() => {});
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test("session sections open and close by mouse and by keyboard, and stay so after a reload", async () => {
  await open();
  await showView("session", { focus: false });
  const plan = q('.p-session button[aria-controls="section-plan"]');
  const all = q('.p-session .session-facts button');
  try {
    await browser.click(plan);
    await browser.waitFor(`${plan}.getAttribute("aria-expanded") === "false" && ${q("#section-plan")}.hidden`, { what: "the plan closed" });
    assert.ok(!(await browser.evaluate(pageHas("compose title and card", ".p-session"))), "its steps are hidden");
    assert.match(await browser.evaluate(`${plan}.innerText`), /plan\s*\d+/i, "a closed section says how many things it holds");
    // A reload opens the agent pane on its agent view; the session view keeps the plan closed.
    await open();
    await showView("session", { focus: false });
    await browser.waitFor(`${plan}?.getAttribute("aria-expanded") === "false"`, { what: "the plan still closed after a reload" });
    // Keyboard: Enter on the focused section button opens it again.
    await browser.evaluate(`${plan}.focus()`);
    await browser.key("Enter");
    await browser.waitFor(`${plan}.getAttribute("aria-expanded") === "true" && ${textOf(".p-session")}.toLowerCase().includes("compose title and card")`, { what: "the plan open again" });
    // The header button closes all three, then opens them all.
    assert.equal(await browser.evaluate(`${all}.getAttribute("aria-expanded")`), "true");
    await browser.click(all);
    await browser.waitFor(`[...document.querySelectorAll(".p-session .caret-button")].every((element) => element.getAttribute("aria-expanded") === "false") && ${all}.getAttribute("aria-expanded") === "false"`, { what: "every section closed" });
    await browser.click(all);
    await browser.waitFor(`[...document.querySelectorAll(".p-session .caret-button")].every((element) => element.getAttribute("aria-expanded") === "true")`, { what: "every section open" });
  } finally {
    await browser.evaluate(`localStorage.removeItem("kino.dashboard.sections")`);
  }
});

test("the film strip: the pictures are a grid that scrolls down, and a picture picked by mouse or keyboard puts the stage at its moment", async () => {
  // Pictures enough to fill more than one row: frames of the outro at whole seconds.
  for (const t of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const looked = await agent("look", { mode: "frame", t, scene: outroScene.id });
    assert.equal(looked.isError, undefined, looked.text);
  }
  await open();
  // The pictures are the agent pane's seen view.
  await showView("seen", { focus: false });
  const strip = q(".seen-strip");
  await browser.waitFor(`${strip}.querySelectorAll(".thumb").length >= 9`, { what: "the pictures in the grid" });
  // A grid that scrolls down, not a strip that scrolls sideways: no ‹ › buttons, nothing to scroll sideways.
  assert.equal(await browser.evaluate(`getComputedStyle(${strip}).display`), "grid");
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('button[aria-label^="Scroll the pictures"]')].every((button) => getComputedStyle(button).display === "none")`), true, "no sideways scroll buttons");
  assert.equal(await browser.evaluate(`${strip}.scrollWidth <= ${strip}.clientWidth + 1`), true, "nothing scrolls sideways");
  // The newest picture is selected.
  assert.equal(await browser.evaluate(`[...${strip}.querySelectorAll(".thumb")].at(-1).getAttribute("aria-current")`), "true");
  // At every window width the cards are one size, in rows of at least two, with no card over
  // another and none past the grid's right edge; each caption sits inside its card.
  const layout = `(() => {
    const box = ${strip}.getBoundingClientRect();
    const cards = [...${strip}.querySelectorAll(".thumb")].map((thumb) => { const rect = thumb.getBoundingClientRect(); const caption = thumb.querySelector(".thumb-caption").getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, captionIn: caption.bottom <= rect.bottom + 1 && caption.top >= rect.top - 1 }; });
    const rows = new Set(cards.map((card) => Math.round(card.top)));
    const overlaps = cards.filter((card, index) => cards.some((other, at) => at < index && card.left < other.right - 1 && card.right > other.left + 1 && card.top < other.bottom - 1 && card.bottom > other.top + 1)).length;
    return { count: cards.length, widthSpread: Math.max(...cards.map((card) => card.width)) - Math.min(...cards.map((card) => card.width)), heightSpread: Math.max(...cards.map((card) => card.height)) - Math.min(...cards.map((card) => card.height)), rows: rows.size, perRow: cards.filter((card) => Math.round(card.top) === Math.round(cards[0].top)).length, overlaps, pastRight: cards.filter((card) => card.right > box.right + 1).length, captionsIn: cards.every((card) => card.captionIn) };
  })()`;
  for (const width of [1100, 1250, 1440]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.waitFor(`innerWidth === ${width}`);
    await sleep(300);
    const grid = await browser.evaluate(layout);
    assert.ok(grid.widthSpread < 1.5 && grid.heightSpread < 1.5, `one card size in a ${width}-wide window: ${JSON.stringify(grid)}`);
    assert.ok(grid.perRow >= 2 && grid.rows >= 2, `rows of at least two cards, more than one row: ${JSON.stringify(grid)}`);
    assert.equal(grid.overlaps, 0, `no card over another at ${width}: ${JSON.stringify(grid)}`);
    assert.equal(grid.pastRight, 0, `no card past the grid's edge at ${width}: ${JSON.stringify(grid)}`);
    assert.equal(grid.captionsIn, true, `each caption inside its card at ${width}`);
  }
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await browser.waitFor("innerWidth === 1440");

  // A click on a picture selects it and puts the stage at its scene and time.
  const thumb = (at) => `[...document.querySelectorAll(".seen-strip .thumb")].find((element) => element.getAttribute("aria-label").includes(${JSON.stringify(` ${at}: `)}))`;
  await browser.click(thumb("00:03.00"));
  await browser.waitFor(`${thumb("00:03.00")}.getAttribute("aria-current") === "true" && ${sceneShown(outroScene.name)} && ${pausedAt("00:03.00")}`, { what: "the stage at the picture's moment" });
  // By keyboard: Enter on a focused picture.
  await browser.evaluate(`${thumb("00:06.00")}.focus()`);
  await browser.key("Enter");
  await browser.waitFor(`${thumb("00:06.00")}.getAttribute("aria-current") === "true" && ${pausedAt("00:06.00")}`, { what: "the stage at the picture picked by Enter" });
});

test("timeline zoom: − and + by mouse and by keyboard, the zoom menu back to Fit, and the ruler follows", async () => {
  await open();
  await showScene(outroScene);
  await showEveryLane();
  const ruler = q('.p-timeline [role="slider"]');
  const scroller = q(".p-timeline .tl-scroll");
  const zoomIn = q('button[aria-label="Zoom the timeline in"]');
  const zoomOut = q('button[aria-label="Zoom the timeline out"]');
  const width = () => browser.evaluate(`${ruler}.getBoundingClientRect().width`);
  // The room the tracks have at Fit, read now: the timeline's width less the names column and the
  // end padding. A scrollbar that comes or goes changes it, so each check reads it again.
  const room = `(() => { const box = ${scroller}; const content = box.querySelector(".tl-content"); return box.clientWidth - box.querySelector(".tl-corner").offsetWidth - parseFloat(getComputedStyle(content).paddingRight); })()`;
  const labels = () => browser.evaluate(`[...document.querySelectorAll(".p-timeline .tick-label")].map((label) => label.innerText.trim())`);
  // On a timeout, say the sizes, so a failure on another machine shows what was off.
  const sizes = `JSON.stringify({ ruler: ${ruler}.getBoundingClientRect().width, room: ${room}, client: ${scroller}.clientWidth, scroll: ${scroller}.scrollWidth, height: ${scroller}.clientHeight, scrollHeight: ${scroller}.scrollHeight, corner: ${scroller}.querySelector(".tl-corner").offsetWidth, zoom: ${textOf("#timeline-zoom")}.trim() })`;
  const tracksAt = async (times, what, also = "true") => {
    try {
      await browser.waitFor(`Math.abs(${ruler}.getBoundingClientRect().width - ${room} * ${times}) < 2 && ${also}`, { what });
    } catch (error) {
      error.message += ` Sizes: ${await browser.evaluate(sizes)}`;
      throw error;
    }
  };
  assert.ok(Math.abs((await width()) - (await browser.evaluate(room))) < 2, `at Fit the tracks fill the room: ${await browser.evaluate(sizes)}`);
  const fitLabels = await labels();
  assert.equal(fitLabels[0], "00:00", "whole seconds on a 15 s scene");
  assert.equal(await browser.evaluate(`${zoomOut}.disabled && ${textOf("#timeline-zoom")}.trim() === "fit"`), true, "Fit is the widest view");
  assert.equal(await browser.evaluate(`${scroller}.scrollWidth <= ${scroller}.clientWidth`), true, "at Fit nothing scrolls");
  await browser.click(zoomIn);
  await tracksAt(2, "the tracks twice as wide", `${textOf("#timeline-zoom")}.trim() === "2×"`);
  // By keyboard: Enter on the focused + button.
  await browser.evaluate(`${zoomIn}.focus()`);
  await browser.key("Enter");
  await tracksAt(4, "the tracks four times as wide", `${textOf("#timeline-zoom")}.trim() === "4×"`);
  const zoomedLabels = await labels();
  assert.ok(zoomedLabels.length > fitLabels.length, `finer ruler steps: ${fitLabels.length} labels at Fit, ${zoomedLabels.length} at 4×`);
  assert.ok(zoomedLabels.some((label) => /^\d\d:\d\d\.\d$/.test(label)), `tenths on the ruler: ${zoomedLabels.slice(0, 4).join(" ")}`);
  assert.equal(await browser.evaluate(`${scroller}.scrollWidth > ${scroller}.clientWidth`), true, "the tracks scroll sideways");
  // A click on the zoomed ruler still puts the playhead where it was clicked.
  const box = await browser.box(ruler);
  const scroll = await browser.evaluate(`${scroller}.scrollLeft`);
  const label = await browser.evaluate(`${scroller}.querySelector(".tl-corner").offsetWidth`);
  const x = (await browser.box(scroller)).left + label + 30;
  await browser.clickAt(x, box.y);
  const expected = ((x - box.left) / box.width) * 15;
  await browser.waitFor(`Math.abs(Number(${ruler}.getAttribute("aria-valuenow")) - ${expected}) < 0.06`, { what: `the playhead at ${expected.toFixed(2)} s (scrolled ${scroll} px)` });
  await browser.click(zoomOut);
  await tracksAt(2, "− back to 2×");
  // The menu, by mouse, back to Fit.
  await browser.click(q("#timeline-zoom"));
  await browser.click(menuItem("fit"));
  await tracksAt(1, "Fit again", `${zoomOut}.disabled`);
  assert.deepEqual(await labels(), fitLabels);
});

test("full size keeps the film strip, the stage and the timeline as they were; the same picture from two looks shows twice; a sheet's picture says sheet", async () => {
  // Two looks at the same unchanged frame give the same file; then a contact sheet.
  for (const body of [{ mode: "frame", t: 0.25, scene: firstScene.id }, { mode: "frame", t: 0.25, scene: firstScene.id }, { mode: "sheet" }]) {
    const looked = await agent("look", body);
    assert.equal(looked.isError, undefined, looked.text);
  }
  const expected = Math.min(24, (await snapshot()).events.filter((call) => call.by !== "you").flatMap((call) => call.images ?? []).length);
  await open();
  await showView("seen", { focus: false });
  const panes = `(() => { const box = (selector) => document.querySelector(selector).getBoundingClientRect(); return [box('section.pane[data-pane="1"]').height, box('section.pane[data-pane="3"]').height]; })()`;
  const [stageBefore, timelineBefore] = await browser.evaluate(panes);
  const thumbs = `[...document.querySelectorAll(".seen-strip .thumb")]`;
  await browser.waitFor(`${thumbs}.length === ${expected}`, { what: `${expected} pictures in the strip` });
  const [sheet, again, once] = await browser.evaluate(`${thumbs}.slice(-3).reverse().map((thumb) => thumb.querySelector("img").getAttribute("src"))`);
  assert.equal(again, once, "the two looks at one frame gave one file, and the strip shows it twice");
  assert.notEqual(sheet, again);
  assert.equal(await browser.evaluate(`${thumbs}.at(-1).querySelector(".thumb-caption .dim").textContent.trim()`), "sheet", "the caption names the look, with no colon");

  // Full size, in the agent pane: the strip stays under the picture, the picture fits, and the
  // stage and the timeline keep their heights.
  const full = button("Full size", ".p-seen");
  await browser.click(full);
  await browser.waitFor(`(() => { const image = document.querySelector(".seen-full img"); return !!(image && image.complete && image.naturalWidth) && document.querySelector("main.panes").classList.contains("seen-open"); })()`, { what: "the picture at full size" });
  const at = await browser.evaluate(`(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const body = box(".p-seen"), strip = box(".p-seen .seen-strip"), image = box(".seen-full img");
    return { body: [body.top, body.bottom], strip: [strip.top, strip.bottom], image: [image.top, image.bottom] };
  })()`);
  const [stageAfter, timelineAfter] = await browser.evaluate(panes);
  assert.ok(Math.abs(stageAfter - stageBefore) < 1 && Math.abs(timelineAfter - timelineBefore) < 1, `the stage and the timeline keep their heights: ${[stageBefore, timelineBefore]} → ${[stageAfter, timelineAfter]}`);
  assert.ok(at.strip[1] - at.strip[0] > 40 && at.strip[0] >= at.body[0] && at.strip[1] <= at.body[1] + 1, `the strip in the pane: ${at.strip} in ${at.body}`);
  assert.ok(at.image[0] >= at.body[0] - 1 && at.image[1] <= at.strip[0] + 1, `the picture above the strip: ${at.image}`);
  // Enter on the pressed button puts the strip back on its own.
  await browser.evaluate(`${full}.focus()`);
  await browser.key("Enter");
  await browser.waitFor(`!document.querySelector(".seen-full") && !document.querySelector("main.panes").classList.contains("seen-open")`, { what: "full size closed" });
});

test("the focus never falls to the page: − and + at their last level, now, and an answered request", async () => {
  await open();
  const active = (expression) => `document.activeElement === ${expression}`;
  // − and +: the one that is turned off at its last level hands the focus to the other.
  await showScene(outroScene);
  await showEveryLane();
  const zoomIn = q('button[aria-label="Zoom the timeline in"]');
  const zoomOut = q('button[aria-label="Zoom the timeline out"]');
  await browser.evaluate(`${zoomIn}.focus()`);
  for (const level of ["2×", "4×", "8×", "16×", "32×"]) {
    await browser.key("Enter");
    await browser.waitFor(`${textOf("#timeline-zoom")}.trim() === ${JSON.stringify(level)}`, { what: `the timeline at ${level}` });
  }
  await browser.waitFor(`${zoomIn}.disabled && ${active(zoomOut)}`, { what: "the focus on − once + is off" });
  for (const level of ["16×", "8×", "4×", "2×", "fit"]) {
    await browser.key("Enter");
    await browser.waitFor(`${textOf("#timeline-zoom")}.trim() === ${JSON.stringify(level)}`, { what: `the timeline at ${level}` });
  }
  await browser.waitFor(`${zoomOut}.disabled && ${active(zoomIn)}`, { what: "the focus on + once − is off" });

  // now: the button goes once pressed, and the focus goes to the stage pane. (A turn's mark is on
  // the agent's lane of a scene it changed: the first scene, where the card and headline are.)
  await showScene(firstScene);
  await showEveryLane();
  await browser.click(q(".p-timeline .agent-mark"));
  const now = q('.p-stage button[aria-label^="Back to now"]');
  await browser.waitFor(`!!${now}`, { what: "a checkpoint and its now button" });
  await browser.evaluate(`${now}.focus()`);
  await browser.key("Enter");
  await browser.waitFor(`!${now} && ${active(q('section[data-pane="1"]'))}`, { what: "the focus on the stage pane after now" });

  // An answered request: the focus goes to the next one's allow button, then to the section's caret.
  await showView("session", { focus: false });
  const first = await share("view");
  const second = await share("comment");
  assert.notEqual(first, second, "two requests");
  const allow = (id) => `[...document.querySelectorAll(".p-session .needs-you")].find((row) => row.querySelector(".row-button").getAttribute("aria-label").startsWith(${JSON.stringify(`Approval ${id}:`)}))?.querySelector(".allow")`;
  await browser.evaluate(`${allow(first)}.focus()`);
  await browser.key("Enter");
  await until(async () => (await approval(first))?.status === "allowed", "the first request allowed");
  await browser.waitFor(active(allow(second)), { what: "the focus on the next request's allow button" });
  await browser.key("Enter");
  await until(async () => (await approval(second))?.status === "allowed", "the second request allowed");
  await browser.waitFor(active(q('.p-session button[aria-controls="section-needs-you"]')), { what: "the focus on the needs-you caret" });
  assert.equal(await browser.evaluate(`${q('.p-session button[aria-controls="section-needs-you"]')}.getAttribute("aria-expanded")`), "true", "needs you is still open");
});

test("a closed needs you opens again for a new request; with it closed, a answers what the orange top line names", async () => {
  await open();
  await showView("session", { focus: false });
  const caret = q('.p-session button[aria-controls="section-needs-you"]');
  try {
    await browser.click(caret);
    await browser.waitFor(`${caret}.getAttribute("aria-expanded") === "false"`, { what: "needs you closed" });
    const asked = await agent("project", { action: "share", id: "orbit", role: "view" });
    const id = asked.data.id;
    await browser.waitFor(`${caret}.getAttribute("aria-expanded") === "true" && !!document.querySelector('.p-session [aria-label^="Approval ${id}:"]')`, { what: "needs you open again for the new request" });
    await browser.click(caret);
    await browser.waitFor(`${caret}.getAttribute("aria-expanded") === "false"`, { what: "needs you closed again" });
    // The request is never unseen: the agent's line under the frame says who asks and what for,
    // with the a key's answer as its first button, in every view of the agent pane.
    await showView("agent", { focus: false });
    await browser.waitFor(`${q(".voice.is-need")} && ${pageHas("Allow", ".voice.is-need .voice-answers .voice-button.primary")}`, { what: "the agent's line asking" });
    await browser.key("1");
    await browser.key("a");
    await until(async () => (await approval(id))?.status === "allowed", "a allows what the top line names");
    await browser.waitFor(`!${q(".voice.is-need")}`, { what: "the agent's line back to normal" });
  } finally {
    await browser.evaluate(`localStorage.removeItem("kino.dashboard.sections")`);
  }
});

test("in [3] ← and k pick the older picture, → and j the newer; the focus moves with them; a picture reached by Tab is in view; the key line's [ and ]", async () => {
  // The strip must hold more pictures than fit; run on its own, this test looks at enough scenes first.
  for (let t = 1; t <= 8 && (await snapshot()).events.filter((call) => call.by !== "you").flatMap((call) => call.images ?? []).length < 12; t += 1) {
    assert.equal((await agent("look", { mode: "frame", t, scene: outroScene.id })).isError, undefined);
  }
  // The undo button under the frame shows the turn before the agent's last call, so an edit comes
  // before the last look.
  const edited = await agent("edit", { ops: [{ op: "update_layer", layer: "card", properties: { radius: 14 } }] });
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal((await agent("look", { mode: "frame", t: 0.4, scene: firstScene.id })).isError, undefined);
  await open();
  const thumbs = `[...document.querySelectorAll(".seen-strip .thumb")]`;
  const current = `${thumbs}.findIndex((thumb) => thumb.getAttribute("aria-current") === "true")`;
  await showView("seen");
  const count = await browser.waitFor(`${thumbs}.length >= 3 && ${current} === ${thumbs}.length - 1 ? ${thumbs}.length : 0`, { what: "the newest of three pictures or more selected" });
  // A picked picture that shows one moment of a scene puts the stage there, as a click does: its
  // card's tooltip ends with that time ("T3 00:03.00").
  const momentOf = `(() => { const thumb = ${thumbs}[${current}]; return thumb.getAttribute("aria-label").includes("Show this moment on the stage.") ? thumb.title.split(" ").at(-1) : ""; })()`;
  const moments = [];
  for (const [key, index] of [["ArrowLeft", count - 2], ["k", count - 3], ["ArrowRight", count - 2], ["j", count - 1]]) {
    await browser.key(key);
    await browser.waitFor(`${current} === ${index}`, { what: `${key} to picture ${index + 1} of ${count}` });
    const at = await browser.evaluate(momentOf);
    if (at) {
      await browser.waitFor(pausedAt(at), { what: `the stage at ${at} after ${key}` });
      moments.push(at);
    }
  }
  // Older pictures with k until one shows another time, then back to the newest with j.
  let back = 0;
  while (back < Math.min(8, count - 1)) {
    const was = await browser.evaluate(playText);
    await browser.key("k");
    back += 1;
    await browser.waitFor(`${current} === ${count - 1 - back}`, { what: `k to picture ${count - back} of ${count}` });
    const at = await browser.evaluate(momentOf);
    if (at && !was.startsWith(`${at}/`)) {
      await browser.waitFor(pausedAt(at), { what: `the stage moved to ${at} after k` });
      moments.push(at);
      break;
    }
  }
  assert.ok(new Set(moments).size >= 2, `the arrows moved the stage to the pictures' moments: ${moments.join(" ")}`);
  for (; back > 0; back--) await browser.key("j");
  await browser.waitFor(`${current} === ${count - 1}`, { what: "back to the newest picture" });
  // A focused picture: the focus moves with the selection.
  await browser.evaluate(`${thumbs}[${count - 1}].focus()`);
  await browser.key("ArrowLeft");
  await browser.waitFor(`${current} === ${count - 2} && document.activeElement === ${thumbs}[${count - 2}]`, { what: "the focus on the older picture" });
  // Tab reaches the selected picture only (one stop for the pictures) and the grid scrolls as
  // little as needed to show it whole, under the facts line that stays at the top.
  const panel = q("#panel-seen");
  const fullSize = button("Full size", ".p-seen");
  assert.deepEqual(await browser.evaluate(`${thumbs}.map((thumb) => thumb.tabIndex).filter((index) => index === 0).length`), 1, "one picture in the Tab order");
  assert.equal(await browser.evaluate(`getComputedStyle(${q(".seen-strip")}).display`), "grid", "the pictures are a grid");
  const edges = (thumb) => `(() => { const box = ${panel}.getBoundingClientRect(); const facts = ${q(".seen-facts")}.getBoundingClientRect(); const rect = ${thumb}.getBoundingClientRect(); return { above: Math.round(rect.top - facts.bottom), below: Math.round(box.bottom - rect.bottom) }; })()`;
  const whole = (thumb) => `(() => { const at = ${edges(thumb)}; return at.above >= -1 && at.below >= -1; })()`;
  const where = `(() => { const thumb = document.activeElement; return { selected: thumb.matches(".thumb") && thumb.getAttribute("aria-current") === "true", ...${edges("thumb")}, scrollTop: ${panel}.scrollTop }; })()`;
  // The scroll position over the next ten frames: it must not move again after the Tab.
  const frames = `new Promise((done) => { const seen = []; const step = () => { seen.push(${panel}.scrollTop); if (seen.length < 10) requestAnimationFrame(step); else done(seen); }; requestAnimationFrame(step); })`;
  assert.ok(await browser.evaluate(`${panel}.scrollHeight > ${panel}.clientHeight + 20`), "more rows of pictures than fit");
  // (1) The selected picture is the third oldest, in the top row, and the grid is at its end;
  // (2) it is the second newest, in the last row, and the grid is at its start.
  for (const [index, scrollTo, what] of [[2, `${panel}.scrollHeight`, "the third oldest picture"], [count - 2, "0", "the second newest picture"]]) {
    await browser.evaluate(`${thumbs}[${index}].click()`);
    await browser.waitFor(`${current} === ${index}`, { what: `${what} selected` });
    await browser.evaluate(`${fullSize}.focus()`);
    await browser.evaluate(`${panel}.scrollTop = ${scrollTo}`);
    await browser.waitFor(`!${whole(`${thumbs}[${index}]`)}`, { what: `${what} not whole in view` });
    await browser.key("Tab");
    await browser.waitFor(`document.activeElement === ${thumbs}[${index}]`, { what: `Tab from Full size on ${what}` });
    const seen = await browser.evaluate(frames);
    const view = await browser.evaluate(where);
    assert.ok(view.selected && view.above >= -1 && view.below >= -1, `${what} is whole in view: ${JSON.stringify(view)}`);
    assert.deepEqual([...new Set(seen)], [view.scrollTop], "no jump after the Tab");
  }

  // The key buttons (the bottom key line is gone): undo is the only one with a key left under the
  // frame, in words, in the quieter text (--fg1); its key is in its tooltip and aria-keyshortcuts,
  // and the button does what its key does.
  const keyButtons = await browser.evaluate(`[...document.querySelectorAll(".voice-tools [aria-keyshortcuts]")].map((item) => ({ word: item.getAttribute("aria-label"), key: item.getAttribute("aria-keyshortcuts"), title: item.title, colour: getComputedStyle(item).color }))`);
  assert.deepEqual(keyButtons.map((entry) => [entry.word, entry.key, entry.title]), [["Undo the last turn", "u", "Undo the last turn (u)"]], "the key buttons");
  const quiet = await browser.evaluate(token("--fg1"));
  for (const entry of keyButtons) assert.equal(entry.colour, quiet, `${entry.word} is quiet text: ${JSON.stringify(keyButtons)}`);
  // The status line draws no ▶ or ‖ before the time; a screen reader says the state as a word.
  assert.equal(await browser.evaluate(`${q(".play-time .sr-only")}.textContent`), ", paused");
  assert.doesNotMatch(await browser.evaluate(textOf(".statusline")), /[▶‖]/);
});

test("a drop-down list taller than its room stays in the window and scrolls", async () => {
  // The first frame can only load in a window of normal height (the stage has no room at 120 px), so open first, then shrink.
  await open();
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 120, deviceScaleFactor: 1, mobile: false });
  try {
    await browser.waitFor("innerHeight === 120");
    const zoomButton = q("#stage-zoom");
    await browser.evaluate(`${zoomButton}.scrollIntoView({ block: "center" })`);
    await browser.click(zoomButton);
    const list = q('[role="menu"][aria-label="Stage zoom"]');
    const placed = await browser.waitFor(`(() => { const menu = ${list}; if (!menu || getComputedStyle(menu).visibility === "hidden") return null; const box = menu.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, scrolls: menu.scrollHeight > menu.clientHeight }; })()`, { what: "the zoom list placed" });
    assert.ok(placed.top >= 0 && placed.bottom <= 120, `inside the window: ${placed.top} to ${placed.bottom}`);
    assert.equal(placed.scrolls, true, "the list scrolls");
    await browser.key("End");
    await browser.waitFor(`(() => { const item = document.activeElement; const box = ${list}.getBoundingClientRect(); const rect = item.getBoundingClientRect(); return item.innerText.trim() === "200%" && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1; })()`, { what: "End shows the last item" });
    await browser.key("Escape");
    await browser.waitFor(`!${list} && document.activeElement === ${zoomButton}`, { what: "the list closed, the focus on its button" });
  } finally {
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test("a long project name gives way to the nav; the zoomed lanes follow the playhead; the timeline keeps its height and margin; quiet text reads at 4.5:1", async () => {
  await open();
  const long = "Orbit: the long cut for the spring launch, with every scene, every channel and every format that we deliver this year";
  const renamed = await agent("edit", { ops: [{ op: "rename_project", name: long }] });
  assert.equal(renamed.isError, undefined, renamed.text);
  try {
    // The whole name is in the title's tooltip and the project name button's label; the button shows it cut.
    await browser.waitFor(`${q(".topline .title")}?.title === ${JSON.stringify(`kino: ${long}`)} && ${q("#project-name")}?.getAttribute("aria-label") === ${JSON.stringify(`Project: ${long}. Its brief.`)}`, { what: "the long name in the top line" });
    const top = await browser.evaluate(`(() => { const nav = document.querySelector(".topline .top-right").getBoundingClientRect(); const shown = document.querySelector("#project-name"); return { right: nav.right, width: innerWidth, shown: shown.innerText.trim(), scroll: document.documentElement.scrollWidth }; })()`);
    assert.ok(top.right <= top.width + 0.5, `share, settings and render end inside the window (${top.right} of ${top.width})`);
    assert.ok(top.shown.endsWith("…") && top.shown.length < long.length, `the name is cut short: ${top.shown}`);
    assert.ok(top.scroll <= top.width, "no sideways scrolling");
  } finally {
    const back = await agent("edit", { ops: [{ op: "rename_project", name: "Orbit" }] });
    assert.equal(back.isError, undefined, back.text);
  }

  // The timeline strip keeps its height whatever the scene's layers, and its tracks end short of the border.
  const measure = () => browser.evaluate(`(() => {
    const pane = document.querySelector('section.pane[data-pane="3"]').getBoundingClientRect();
    const ruler = document.querySelector('.p-timeline [role="slider"]').getBoundingClientRect();
    return { height: pane.height, margin: pane.right - ruler.right };
  })()`);
  await showScene(firstScene);
  const layered = await measure();
  // The shot strip is a fixed band now (74 px), no longer a quarter of the window.
  assert.ok(Math.abs(layered.height - 74) < 2, `the strip's band: ${layered.height} px`);
  await showScene(outroScene);
  assert.ok(Math.abs((await measure()).height - layered.height) < 1, "a scene with no layers keeps the height");

  // Zoomed in, the lanes scroll to keep the playhead in view.
  await showEveryLane();
  assert.ok((await measure()).margin >= 12, `the tracks end ${(await measure()).margin} px from the border (the shot strip fills its column, the whole timeline keeps a margin)`);
  const scroller = q(".p-timeline .tl-scroll");
  const slider = q('.p-timeline [role="slider"]');
  await browser.click(q("#timeline-zoom"));
  await browser.click(menuItem("8×"));
  await browser.waitFor(`${textOf("#timeline-zoom")}.trim() === "8×" && ${scroller}.scrollWidth > ${scroller}.clientWidth * 4`, { what: "the timeline at 8×" });
  const inView = `(() => { const lanes = ${scroller}.getBoundingClientRect(); const label = ${scroller}.querySelector(".tl-corner").offsetWidth; const head = document.querySelector(".p-timeline .playhead").getBoundingClientRect(); return head.left >= lanes.left + label - 2 && head.left <= lanes.right + 1; })()`;
  await browser.evaluate(`${slider}.focus({ preventScroll: true })`);
  await browser.key("End");
  await browser.waitFor(`${pausedAt("00:15.00")} && ${inView}`, { what: "the playhead at the end, in view" });
  await browser.key("Home");
  await browser.waitFor(`${pausedAt("00:00.00")} && ${inView}`, { what: "the playhead at the start, in view" });
  // In the middle of the scene, then a wider and a narrower window: the lanes scroll again so the
  // playhead stays in view.
  for (let tick = 0; tick < 6; tick++) await browser.key("PageUp");
  await browser.waitFor(`${pausedAt("00:07.50")} && ${inView}`, { what: "the playhead in the middle, in view" });
  try {
    for (const width of [1900, 1100, 1440]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await browser.waitFor(`innerWidth === ${width} && ${inView}`, { what: `the playhead in view in a ${width}-wide window` });
    }
  } finally {
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  await browser.click(q("#timeline-zoom"));
  await browser.click(menuItem("fit"));
  await browser.waitFor(`${textOf("#timeline-zoom")}.trim() === "fit"`);

  // Quiet text (--fg1) reads at 4.5:1 or more on every background, faint text (--fg2) on the page.
  const contrast = await browser.evaluate(`(() => {
    const style = getComputedStyle(document.querySelector(".dash"));
    const rgb = (name) => { const hex = style.getPropertyValue(name).trim(); return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255); };
    const light = (name) => { const [r, g, b] = rgb(name).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [high, low] = [light(a), light(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };
    return { quiet: Math.min(...["--bg0", "--well", "--bg1", "--bg2"].map((background) => ratio("--fg1", background))), faint: ratio("--fg2", "--bg0") };
  })()`);
  assert.ok(contrast.quiet >= 4.5, `quiet text ${contrast.quiet.toFixed(2)}:1`);
  assert.ok(contrast.faint >= 4.5, `faint text ${contrast.faint.toFixed(2)}:1`);
});

test("reduced motion: the working spinner stands still; without it, it turns", async () => {
  const spinner = `document.querySelector(".agent-working .braille")?.textContent ?? ""`;
  const samples = async () => {
    const seen = new Set();
    for (let index = 0; index < 6; index += 1) { seen.add(await browser.evaluate(spinner)); await sleep(90); }
    return seen;
  };
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await open();
    assert.equal(await browser.evaluate(`matchMedia("(prefers-reduced-motion: reduce)").matches`), true);
    // The agent view's working spinner is in the list, which is closed until opened.
    await showView("agent", { focus: false });
    await agent("status");
    await browser.waitFor(`(${spinner}) === "…"`, { what: "the still spinner" });
    assert.deepEqual([...await samples()], ["…"]);
  } finally {
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  }
  await browser.waitFor(`(${spinner}) !== "…" && (${spinner}) !== ""`, { what: "the turning spinner" });
  assert.ok((await samples()).size > 1, "the spinner turns");
});

test("the accessibility tree: landmarks, named panes and controls, a log, live regions", async () => {
  await open();
  // The agent pane is the list under the frame; it is closed until opened.
  await showView("agent", { focus: false });
  await browser.waitFor(`/Checks: \\d+ errors?, \\d+ warnings?/.test(${textOf(".statusline")})`);
  const { nodes } = await browser.send("Accessibility.getFullAXTree");
  const shown = nodes.filter((node) => !node.ignored);
  const role = (node) => node.role?.value;
  const name = (node) => node.name?.value ?? "";
  const live = (node) => node.properties?.find((property) => property.name === "live")?.value?.value;
  assert.ok(shown.some((node) => role(node) === "main" && name(node) === "Dashboard"), "a main landmark");
  assert.ok(shown.some((node) => role(node) === "contentinfo" && name(node) === "Status"), "the status line");
  assert.ok(shown.some((node) => role(node) === "navigation" && name(node) === "Views"), "the views nav (the key line is gone)");
  const regions = shown.filter((node) => role(node) === "region").map(name);
  // The panes are regions named by their titles, with no number: "stage · 00:00.00"...
  for (const start of ["stage", "timeline"])
    assert.ok(regions.some((region) => region.startsWith(start)), `a region named ${start}: ${regions.join(" | ")}`);
  assert.ok(regions.some((region) => /^(test-agent|agent)\b/.test(region)), `the agent pane is a region named by its agent: ${regions.join(" | ")}`);
  const buttons = shown.filter((node) => role(node) === "button");
  assert.ok(buttons.length > 20);
  assert.deepEqual(buttons.filter((node) => !name(node).trim()).map((node) => node.nodeId), [], "every button has a name");
  assert.deepEqual(shown.filter((node) => name(node).includes("│")).map(name), [], "no separator in any name");
  assert.ok(shown.some((node) => role(node) === "log" && name(node).endsWith("'s calls")), "the agent's log of calls");
  assert.ok(shown.some((node) => role(node) === "image" && name(node).startsWith("preview ")) || shown.some((node) => role(node) === "img" && name(node).startsWith("preview ")), "the stage image");
  assert.ok(shown.some((node) => role(node) === "slider" && name(node) === "Playhead"), "the playhead");
  // The list's views are tabs: All, Edits, Looks, Checks, Notes, Session.
  assert.equal(shown.filter((node) => role(node) === "tab").length, 6);
  assert.ok(nodes.some((node) => live(node) === "polite"), "a polite live region");
  assert.ok(nodes.some((node) => role(node) === "alert" && live(node) === "assertive"), "an assertive alert region");
});

test("the phone layout puts approvals first and an approval is answered with a tap", async () => {
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    await open();
    await browser.waitFor(`!!document.querySelector(".phone-stack")`);
    const asked = await agent("project", { action: "share", id: "orbit", role: "view" });
    const id = asked.data.id;
    await browser.waitFor(`${q(".phone-stack")}.firstElementChild?.matches("article.approval-card") && !!document.querySelector(${JSON.stringify(`.phone-stack .approval-card h3[title="${id}"]`)})`, { what: "the approval card first" });
    assert.ok(await browser.evaluate("document.documentElement.scrollWidth <= 390"), "no sideways scrolling");
    // The status line wraps to more rows on a phone, and no row starts with a separator bar
    // (before, rows 2 and 3 did: each item but the first drew one before it).
    const status = await browser.evaluate(`[...${q(".statusline")}.children].filter((item) => item.getClientRects().length).map((item) => {
      const before = getComputedStyle(item, "::before");
      return { text: item.innerText.replace(/\\s+/g, " ").trim(), top: Math.round(item.getBoundingClientRect().top), bar: !["none", "normal"].includes(before.content) && before.display !== "none" };
    })`);
    const rowStarts = status.filter((item, index) => index > 0 && item.top > status[index - 1].top + 2);
    assert.ok(rowStarts.length >= 1, `the status line wraps on a phone: ${JSON.stringify(status)}`);
    assert.deepEqual(rowStarts.filter((item) => item.bar), [], `no status row starts with a bar: ${JSON.stringify(status)}`);
    // The page itself does not scroll: the stack scrolls inside it. (The screen-reader words of
    // each pane sit inside the pane; when the pane was not their anchor they made the page 98 px taller.)
    const page = await browser.evaluate(`(() => { const tall = document.documentElement.scrollHeight; window.scrollTo(0, 2000); const moved = window.scrollY; window.scrollTo(0, 0); return { tall, moved }; })()`);
    assert.ok(page.tall <= 844 && page.moved === 0, `the page does not scroll: ${JSON.stringify(page)}`);
    await browser.shot("phone-approval");
    await browser.tap(button("Allow", ".phone-stack .approval-card"));
    await until(async () => (await approval(id))?.status === "allowed", "the tap");
    assert.match(inboxText(await agent("status")), new RegExp(`${id} allowed: Created sharing link \\(secret omitted\\)`), "the inbox line never holds the URL");
    await browser.waitFor(`!${q(".phone-stack")}.firstElementChild?.matches("article.approval-card")`, { what: "the card to leave" });
  } finally {
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test("the brief shows read only: you said with the agent's quote, guessed, missing, confirmed in chat, by keyboard, mouse, screen reader and phone", async () => {
  const section = q("#section-brief");
  const caret = q('.p-session button[aria-controls="section-brief"]');
  const polite = `(document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? "")`;
  const brief = async (body) => {
    const saved = await agent("notes", { project: "brief-panel", action: "brief", ...body });
    assert.equal(saved.isError, undefined, saved.text);
    return saved;
  };
  try {
    // Review round 2: the section starts closed, so the plan and the renders stay in view. A
    // video made before briefs (orbit has layers and a plan) says it has none and promises no
    // questions: kino tells the agent its changes need no brief.
    await agent("project", { action: "open", id: "orbit" });
    await open();
    await browser.evaluate(`localStorage.removeItem("kino.dashboard.sections")`);
    await open();
    await browser.waitFor(`${q(".topline .title")}?.title === "kino: Orbit"`, { what: "the orbit project on the stage" });
    await showView("session", { focus: false });
    assert.deepEqual(await browser.evaluate(`[${caret}.getAttribute("aria-expanded"), ${section}.hidden]`), ["false", true], "the brief starts closed");
    await browser.click(caret);
    await browser.waitFor(pageHas("no brief: this video was started without one", "#section-brief"), { what: "orbit's brief: none, and none to come" });
    assert.equal(await browser.evaluate(pageHas("asks", "#section-brief")), false, "no promise of questions the agent is told not to ask");

    // The agent saves the brief from its chat with the person (notes brief); the dashboard only shows it.
    const made = await agent("project", { action: "create", id: "brief-panel", name: "Brief panel", width: 360, height: 640, duration: 2 });
    assert.equal(made.isError, undefined, made.text);
    await open();
    await browser.waitFor(`${q(".topline .title")}?.title === "kino: Brief panel"`, { what: "the brief-panel project on the stage" });
    await showView("session", { focus: false });
    await browser.waitFor(pageHas("no brief yet: kino tells your agent to ask you in the chat before it builds", "#section-brief"), { what: "the empty brief of a new video" });

    // r1: one line in the person's words, one guessed, one reply logged. It shows without a reload.
    await brief({
      fields: { ask: "no meme text please", never: { text: "no meme text", by: "you", quote: "no meme text please" }, plays_on: { text: "TikTok, 9:16, 24 s", by: "guessed" } },
      log: [{ q: "What would make you wince if I got it wrong?", a: "no meme text please" }],
    });
    await browser.waitFor(pageHas("r1 · not confirmed yet", "#section-brief"), { what: "brief r1 on screen" });
    const shown = await browser.evaluate(`${section}.innerText`);
    for (const words of ['never you said "no meme text please"', "→ no meme text", "plays on guessed: TikTok, 9:16, 24 s", "your replies 1 of 10",
      "missing: message, made from, look and sound, about", "a line is wrong? tell your agent in the chat", "quotes and replies recorded by the agent; kino cannot check them"])
      assert.ok(shown.includes(words), `the brief shows ${JSON.stringify(words)}: ${shown}`);
    assert.ok(shown.indexOf("plays on guessed") < shown.indexOf("never you said"), "the lines come in the brief's order");
    await browser.waitFor(`${polite} === "Brief revision 1 saved by the agent."`, { what: "the polite announcement of r1" });

    // The person answered the playback in the chat: the brief is confirmed, again without a reload.
    await brief({ log: [{ q: "What's wrong or missing?", a: "looks right", kind: "playback", rev: 1, confirmed: true }] });
    await browser.waitFor(pageHas("r1 · confirmed in chat", "#section-brief") + ` && ${pageHas("your replies 2 of 10", "#section-brief")}`, { what: "the brief confirmed in chat" });
    await browser.waitFor(`${polite} === "Brief confirmed in chat."`, { what: "the polite announcement of the confirmation" });

    // Read only: the caret is the only control, inside the section there is nothing to type in or press.
    assert.deepEqual(await browser.evaluate(`[...${caret}.closest(".session-section").querySelectorAll("button, input, select, textarea, a[href], [contenteditable], [tabindex]")].map((element) => element.getAttribute("aria-controls") ?? element.outerHTML.slice(0, 80))`),
      ["section-brief"], "the caret is the brief's only control");

    // A screen reader hears a named list, and each line as one sentence (the drawn · and → are hidden).
    const { nodes } = await browser.send("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const list = nodes.find((node) => !node.ignored && node.role?.value === "list" && node.name?.value === "Brief, revision 1, confirmed in chat");
    assert.ok(list, "a list named for the brief's revision and state");
    const heard = [];
    const walk = (node) => {
      if (!node) return;
      if (!node.ignored && node.role?.value === "StaticText" && node.name?.value) heard.push(node.name.value);
      for (const id of node.childIds ?? []) walk(byId.get(id));
    };
    walk(list);
    assert.deepEqual(heard, [
      "plays on: guessed by the agent: TikTok, 9:16, 24 s.",
      'never: you said, recorded by the agent, "no meme text please". The agent reads it as: no meme text.',
    ], "each line reads as one sentence");

    // The caret by keyboard: 2 focuses the agent pane (on its session view), Tab reaches the
    // caret, Enter closes it, space opens it.
    await browser.key("2");
    await browser.waitFor(`document.activeElement?.matches("section.p-agent")`, { what: "pane 2 focused" });
    for (let step = 0; step < 12 && !(await browser.evaluate(`document.activeElement === ${caret}`)); step += 1) await browser.key("Tab");
    assert.equal(await browser.evaluate(`document.activeElement === ${caret}`), true, "Tab reaches the brief's caret");
    await browser.key("Enter");
    await browser.waitFor(`${caret}.getAttribute("aria-expanded") === "false" && ${section}.hidden`, { what: "the brief closed by Enter" });
    assert.match(await browser.evaluate(`${caret}.innerText`), /^Brief\s+2 lines, confirmed in chat$/, "a closed brief says how many lines it holds and its state");
    await browser.key(" ");
    await browser.waitFor(`${caret}.getAttribute("aria-expanded") === "true" && !${section}.hidden`, { what: "the brief opened by space" });
    // ... and by mouse.
    await browser.click(caret);
    await browser.waitFor(`${caret}.getAttribute("aria-expanded") === "false" && ${section}.hidden`, { what: "the brief closed by a click" });
    await browser.click(caret);
    await browser.waitFor(`${caret}.getAttribute("aria-expanded") === "true" && !${section}.hidden`, { what: "the brief opened by a click" });
    await browser.shot("brief-section");

    // Nothing in it moves: no animation, and under reduced motion no transition either.
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const moving = await browser.evaluate(`[${caret}, ${section}, ...${section}.querySelectorAll("*")].map((element) => getComputedStyle(element))
      .filter((style) => style.animationName !== "none" || style.transitionDuration.split(",").some((value) => parseFloat(value) !== 0)).length`);
    assert.equal(moving, 0, "no animation or transition in the brief under reduced motion");
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

    // A new line (a 120-character quote with an unbroken 60-character word) is r2, not confirmed until the next playback.
    const word = "kickflip".repeat(8).slice(0, 60);
    const quote = `raw and bright, real street sound, no synth dings, ${word}`.padEnd(120, " ok");
    assert.equal(quote.length, 120);
    await brief({ fields: { ask: quote, look_sound: { text: "raw and bright; street sound, no synth", by: "you", quote } }, log: [{ q: "What should it look and sound like?", a: quote }] });
    await browser.waitFor(pageHas("r2 · not confirmed yet", "#section-brief"), { what: "brief r2 not confirmed" });
    await browser.waitFor(`${polite} === "Brief revision 2 saved by the agent."`, { what: "the polite announcement of r2" });
    assert.ok(await browser.evaluate(pageHas(`look and sound you said "${quote}"`, "#section-brief")), "the whole quote shows, never cut");
    assert.ok(await browser.evaluate(`${section}.scrollWidth <= ${section}.clientWidth`), "the long word wraps in the session pane");

    // "Just start" in the chat: the agent goes on with no playback, and the panel says so in words.
    await brief({ no_playback: "just start" });
    await browser.waitFor(pageHas("r2 · no playback: just start", "#section-brief"), { what: "brief r2 kept with no playback" });
    await browser.waitFor(`${polite} === "Brief kept with no playback: just start."`, { what: "the polite announcement of no playback" });

    // The phone (review round 2): a card under the stage, closed with a one-line summary, so the
    // whole 9:16 frame is on the first screen; 390 px wide with no sideways scrolling.
    await browser.evaluate(`localStorage.removeItem("kino.dashboard.sections")`);
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await open();
    const card = q(".phone-stack .brief-card");
    const cardCaret = q('.phone-stack .brief-card button[aria-controls="brief-card-lines"]');
    await browser.waitFor(`${pageHas("brief (3 lines, no playback: just start)", ".phone-stack .brief-card")}`, { what: "the phone's closed brief card" });
    const closed = await browser.evaluate(`(() => {
      const card = ${card};
      const stack = ${q(".phone-stack")}.getBoundingClientRect();
      const frame = ${q(".phone-stack .stage-wrap")}.getBoundingClientRect();
      return { afterStage: card.previousElementSibling?.matches("section.p-stage") ?? false, beforeLog: card.nextElementSibling?.matches("section.p-log") ?? false,
        expanded: ${cardCaret}.getAttribute("aria-expanded"), linesHidden: document.getElementById("brief-card-lines").hidden,
        frameShown: frame.top >= stack.top && frame.bottom <= stack.bottom,
        // One row: the summary fits the caret's 44 px touch target, and the card adds only its padding.
        oneRow: card.querySelector("h3").getBoundingClientRect().height <= 44 && card.getBoundingClientRect().height < 70 };
    })()`);
    assert.deepEqual(closed, { afterStage: true, beforeLog: true, expanded: "false", linesHidden: true, frameShown: true, oneRow: true }, `the closed card: ${JSON.stringify(closed)}`);
    // The status line's checks button is one text row tall, so the frame fits, but a tap 42 px
    // above its bottom still reaches it: a 44 px touch target.
    assert.ok(await browser.evaluate(`(() => { const box = ${q(".statusline .s-checks")}.getBoundingClientRect();
      return !!document.elementFromPoint(box.left + box.width / 2, box.bottom - 42)?.closest(".s-checks"); })()`), "the phone's checks button keeps a 44 px touch target");
    await browser.shot("brief-phone-closed");
    await browser.click(cardCaret);
    await browser.waitFor(`${cardCaret}.getAttribute("aria-expanded") === "true" && ${pageHas("r2 · no playback: just start", ".phone-stack .brief-card")}`, { what: "the phone's brief card opened by a tap" });
    const place = await browser.evaluate(`(() => {
      const card = ${card};
      const box = card.getBoundingClientRect();
      const lines = [...card.querySelectorAll("li")].map((line) => line.getBoundingClientRect());
      return { page: document.documentElement.scrollWidth <= 390,
        stack: ${q(".phone-stack")}.scrollWidth - ${q(".phone-stack")}.clientWidth, card: card.scrollWidth - card.clientWidth,
        inside: lines.every((line) => line.right <= box.right + 0.5),
        controls: [...card.querySelectorAll("button, input, select, textarea, a[href], [contenteditable], [tabindex]")].map((element) => element.getAttribute("aria-controls")) };
    })()`);
    assert.deepEqual(place, { page: true, stack: 0, card: 0, inside: true, controls: ["brief-card-lines"] }, `the open card's size and controls: ${JSON.stringify(place)}`);
    assert.ok(await browser.evaluate(pageHas(`look and sound you said "${quote}"`, ".phone-stack .brief-card")), "the whole quote shows on the phone");
    await browser.shot("brief-phone");
    // A video started without a brief shows no card on the phone: there is nothing to show and none to come.
    await agent("project", { action: "open", id: "orbit" });
    await open();
    await browser.waitFor(`${onProject("orbit")}`, { what: "orbit on the phone" });
    assert.equal(await browser.evaluate(`!!${card}`), false, "no brief card for a video started without one");
  } finally {
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.evaluate(`localStorage.removeItem("kino.dashboard.sections")`);
    await agent("project", { action: "open", id: "orbit" });
  }
});

test("/?editor opens the dashboard: there is no manual editor", async () => {
  await open(`${appUrl}?editor`);
  assert.equal(await browser.evaluate(`!!document.querySelector("section.pane")`), true, "the dashboard's panes");
  assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label="Undo"]') || !!document.querySelector(".app-shell")`), false, "no editor toolbar");
  await browser.shot("editor-url-opens-dashboard");
});

// ---- share links: the viewer and the shares screen ----------------------------------------------

/** A share link made with the owner's API, as the shares screen does. */
async function shareLink(role, label = "") {
  const response = await server.api("/api/projects/orbit/shares", { method: "POST", body: { role, label } });
  assert.equal(response.status, 201, `a ${role} link is made`);
  return response.json();
}

/** Opens a share link in the app. Each visit has its own query, so it is a full page load even
 * when only the hash (the link's token) differs from the page before. */
let visits = 0;
async function openViewer(token, ready = `!!document.querySelector(".viewer .viewer-frame svg")`) {
  visits += 1;
  await browser.send("Page.navigate", { url: `${appUrl}?project=orbit&visit=${visits}#share=${token}` });
  await browser.waitFor(ready, { timeout: 30_000, what: "the viewer" });
}

const comments = async () => (await (await server.api("/api/projects/orbit/comments")).json()).comments;

test("a comment link opens the viewer with comments; a new comment saves and reaches the owner's notes tab", async () => {
  const { token } = await shareLink("comment", "for Ana");
  await openViewer(token);
  await browser.waitFor(`!!document.querySelector(".viewer-comments .comments-panel")`, { what: "the comments column" });
  assert.equal(await browser.evaluate(textOf(".viewer-role")), "can comment");
  assert.equal(await browser.evaluate(`${q(".viewer-comments-toggle")}.getAttribute("aria-expanded")`), "true");

  // Name, then a click on the frame puts a new comment there, at the current time.
  await browser.click(q(".comments-name input"));
  await browser.type("Ana");
  const frame = await browser.box(q(".viewer-marks.placing"), "the frame, ready for a comment");
  await browser.clickAt(frame.left + frame.width * 0.25, frame.top + frame.height * 0.4);
  await browser.waitFor(`document.activeElement?.getAttribute("aria-label") === "Comment text"`, { what: "the new comment box" });
  assert.match(await browser.evaluate(textOf(".viewer-new-comment-place")), /new comment · .* · at 1[56]\d, 14\d/);
  await browser.type("The headline comes in late");
  await browser.key("Enter");
  const saved = await until(async () => (await comments()).find((entry) => entry.text === "The headline comes in late"), "the saved comment");
  assert.equal(saved.author, "Ana");
  assert.equal(saved.sceneId, firstScene.id);
  assert.ok(Math.abs(saved.x - 160) <= 2 && Math.abs(saved.y - 144) <= 2, `the comment sits where the click was (${saved.x}, ${saved.y})`);
  assert.equal(typeof saved.time, "number");
  await browser.waitFor(`${pageHas("The headline comes in late", ".comments-panel")} && !!document.querySelector(".viewer-pin:not(.draft)")`, { what: "the thread and its pin" });

  // Posting opens the new thread. Reply in it, then resolve it.
  await browser.waitFor(`${q(".comment-thread-open")}?.getAttribute("aria-expanded") === "true"`, { what: "the new thread, open" });
  await browser.click(q('textarea[aria-label="Reply"]'));
  await browser.type("Agreed, start it at 0.2 s");
  await browser.key("Enter");
  await until(async () => (await comments()).some((entry) => entry.parentId === saved.id && entry.text === "Agreed, start it at 0.2 s"), "the reply");
  await browser.waitFor(pageHas("Agreed, start it at 0.2 s", ".comments-panel"));
  await browser.shot("viewer-comment-link");
  await browser.click(q('[aria-label="Resolve the comment by Ana"]'));
  await until(async () => (await comments()).find((entry) => entry.id === saved.id)?.resolved === true, "the resolve");

  // The owner sees it, read only, in the dashboard's notes tab, and can send it to the agent.
  await open();
  await showView("notes", { focus: false });
  await browser.waitFor(`${pageHas("The headline comes in late", ".share-comments")} && ${pageHas("Agreed, start it at 0.2 s", ".share-comments")} && ${pageHas("resolved", ".share-comments")}`,
    { what: "the comment in the notes tab" });
  // A comment made while the dashboard is open arrives over the stream.
  const live = await server.api("/api/projects/orbit/comments", { method: "POST", headers: { "X-Kino-Share": token }, body: { text: "Make the card warmer", author: "Ana", sceneId: firstScene.id, time: 0.5, x: 320, y: 180 } });
  assert.equal(live.status, 201);
  await browser.waitFor(pageHas("Make the card warmer", ".share-comments"), { what: "the live comment" });
  await browser.shot("dashboard-share-comments");
  await browser.click(q(`[aria-label="Send Ana's comment to the agent as a note"]`));
  const note = await noteNamed("A comment from a share link");
  assert.match(note.text, /Ana: Make the card warmer/);
  assert.match(inboxText(await agent("status")), /Make the card warmer/);
});

test("⇧C on a comment link hides and shows the pins, moves focus from a hidden pin to the frame, and types a C in a text field", async () => {
  const { token } = await shareLink("comment", "for Cy");
  const posted = await server.api("/api/projects/orbit/comments", { method: "POST", headers: { "X-Kino-Share": token }, body: { text: "Pin to hide", author: "Cy", sceneId: firstScene.id, time: 0.2, x: 480, y: 90 } });
  assert.equal(posted.status, 201);
  await openViewer(token);
  const pins = `document.querySelectorAll(".viewer-pin:not(.draft)").length`;
  const eye = `${q('[aria-label="Show comments on the canvas"]')}.getAttribute("aria-pressed")`;
  await browser.waitFor(`${pins} > 0`, { what: "the pins on the frame" });

  // In the name field Shift+C types a capital C and the pins stay.
  await browser.click(q(".comments-name input"));
  await browser.key("C");
  assert.match(await browser.evaluate(`${q(".comments-name input")}.value`), /C$/);
  assert.ok(await browser.evaluate(`${pins} > 0`), "the pins stay while typing");
  await browser.key("Backspace");

  // On a pin, ⇧C hides the pins and focus goes to the frame; ⇧C there shows them again.
  await browser.evaluate(`${q(".viewer-pin:not(.draft)")}.focus()`);
  await browser.key("C");
  await browser.waitFor(`${pins} === 0`, { what: "the pins hidden" });
  assert.equal(await browser.evaluate(`document.activeElement?.classList.contains("viewer-frame")`), true, "focus is on the frame");
  assert.equal(await browser.evaluate(eye), "false");
  assert.match(await browser.evaluate(textOf(".viewer-announcement")), /Comments hidden on the canvas\. Press ⇧C to show them\./);
  await browser.shot("viewer-pins-hidden");
  await browser.key("C");
  await browser.waitFor(`${pins} > 0`, { what: "the pins shown again" });
  assert.equal(await browser.evaluate(eye), "true");
  assert.equal(await browser.evaluate(textOf(".viewer-announcement")), "Comments shown on the canvas.");

  // ⇧C works with the comments column closed too.
  await browser.click(q(".viewer-comments-toggle"));
  await browser.waitFor(`!document.querySelector(".viewer-comments")`, { what: "the comments column closed" });
  await browser.key("C");
  await browser.waitFor(`${pins} === 0`, { what: "the pins hidden with the column closed" });
  await browser.key("C");
  await browser.waitFor(`${pins} > 0`, { what: "the pins back" });
});

test("the viewer's phone cards have no pins: ⇧C, the comments column and a new comment say nothing about hiding them", async () => {
  // Its own label: the shares screen test below finds its link by the label "for Bo".
  const { token } = await shareLink("comment", "for the phone");
  const pinsSetting = `localStorage.getItem("kino-comment-pins")`;
  const cardsReady = `!!document.querySelector(".viewer-cards .viewer-card")`;
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  let before;
  try {
    // The pins were hidden earlier in the wide view; the setting is kept per browser.
    await openViewer(token, cardsReady);
    before = await browser.evaluate(pinsSetting);
    await browser.evaluate(`localStorage.setItem("kino-comment-pins", "hidden")`);
    await openViewer(token, cardsReady);
    assert.equal(await browser.evaluate(`!!document.querySelector(".viewer-marks, .viewer-pin")`), false, "the cards draw no pins");

    // ⇧C changes nothing and says nothing: there are no pins here to hide or show.
    await browser.key("C");
    assert.equal(await browser.evaluate(pinsSetting), "hidden");
    assert.doesNotMatch(await browser.evaluate(textOf(".viewer-announcement")), /Comments (hidden|shown)/);

    // The comments column has no button for the pins, and a new comment does not say they are hidden.
    await browser.tap(q(".viewer-comments-toggle"));
    await browser.waitFor(`!!document.querySelector(".viewer-comments .comments-panel")`, { what: "the comments column" });
    assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label="Show comments on the canvas"]')`), false);
    await browser.tap(button("Comment on this scene", ".viewer-comments"));
    await browser.waitFor(`document.activeElement?.getAttribute("aria-label") === "Comment text"`, { what: "the new comment box" });
    await browser.type("Seen on a phone");
    await browser.key("Enter");
    await until(async () => (await comments()).some((entry) => entry.text === "Seen on a phone"), "the saved comment");
    await browser.waitFor(pageHas("Seen on a phone", ".comments-panel"), { what: "the new thread" });
    assert.doesNotMatch(await browser.evaluate(textOf(".viewer-announcement")), /hidden on the canvas/);
    await browser.shot("viewer-cards-comments");
  } finally {
    await browser.evaluate(before == null ? `localStorage.removeItem("kino-comment-pins")` : `localStorage.setItem("kino-comment-pins", ${JSON.stringify(before)})`);
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test("a view link opens the viewer read only: no comment box, no pins, and the server refuses comments", async () => {
  const { token } = await shareLink("view", "for the client");
  await openViewer(token);
  assert.equal(await browser.evaluate(textOf(".viewer-role")), "view only");
  assert.equal(await browser.evaluate(`!!document.querySelector(".viewer-comments, .viewer-comments-toggle, .viewer-marks, .viewer-pin, textarea")`), false);
  // ⇧C does nothing here: there are no pins to hide.
  const pinsSetting = `localStorage.getItem("kino-comment-pins")`;
  const before = await browser.evaluate(pinsSetting);
  await browser.key("C");
  assert.equal(await browser.evaluate(pinsSetting), before);
  assert.doesNotMatch(await browser.evaluate(textOf(".viewer-announcement")), /Comments/);
  const refused = await server.api("/api/projects/orbit/comments", { method: "POST", headers: { "X-Kino-Share": token }, body: { text: "sneaky", author: "x" } });
  assert.equal(refused.status, 403);
  await browser.shot("viewer-view-link");
});

test("the shares screen makes a link and revokes it, and the revoked link stops working", async () => {
  await open();
  await commandByMouse("shares");
  await browser.waitFor(`!!document.querySelector('#share-box[role="dialog"] .share-list[aria-label="Links"]')`, { what: "the links made by the earlier tests" });
  await browser.click(q("#share-label"));
  await browser.type("for Bo");
  // The new box starts on a watch link; this test needs a comment link.
  await browser.click(`[...document.querySelectorAll("#share-box .ui-seg-item")].find((item) => item.innerText === "Comment")`);
  await browser.click(button("Make link", ".share-form"));
  const url = await browser.waitFor(`${q(".share-made .share-url")}?.innerText`, { what: "the new link" });
  const token = url.split("#share=")[1];
  assert.ok(token, url);
  const made = await until(async () => (await (await server.api("/api/projects/orbit/shares")).json()).shares.find((entry) => entry.label === "for Bo"), "the link on the server");
  assert.equal(made.role, "comment");
  await browser.waitFor(`[...document.querySelectorAll(".share-list li")].some((row) => row.innerText.includes("for Bo") && row.innerText.includes("Comment") && !row.classList.contains("revoked"))`, { what: "the row" });
  await browser.shot("shares-screen");

  await openViewer(token);
  assert.equal(await browser.evaluate(`!!document.querySelector(".viewer-comments")`), true, "the link works before it is revoked");

  await open();
  await browser.key(":");
  await browser.type("shares");
  await browser.key("Enter");
  await browser.waitFor(`!!document.querySelector('#share-box')`, { what: "the share box" });
  await browser.click(q(`[aria-label='Revoke the comment link "for Bo"']`));
  await browser.waitFor(`${textOf('[role="alertdialog"]')}.includes('Revoke the comment link "for Bo"?')`);
  await browser.key("y");
  await until(async () => (await (await server.api("/api/projects/orbit/shares")).json()).shares.find((entry) => entry.id === made.id)?.revokedAt, "the revoke");
  await browser.waitFor(`[...document.querySelectorAll(".share-list li")].some((row) => row.innerText.includes("for Bo") && row.innerText.includes("revoked"))`, { what: "the revoked row" });

  await openViewer(token, pageHas("This link no longer works."));
  await browser.shot("revoked-link");
  const refused = await server.api("/api/projects/orbit", { headers: { "X-Kino-Share": token } });
  assert.ok([403, 404, 410].includes(refused.status), `the server refuses the revoked link (${refused.status})`);
});

test("Trash on the projects screen restores an archived project", async () => {
  const before = await projectIds();
  await agent("project", { action: "duplicate", id: "orbit" });
  const copy = await until(async () => (await projectIds()).find((id) => !before.includes(id)), "the copy");
  await open();
  await commandByMouse("projects");
  await browser.click(q(`[aria-label="Move ${copy} to Trash"]`));
  await browser.waitFor(`${textOf('[role="alertdialog"]')}.includes("It can be restored from Trash on this screen.")`);
  await browser.click(button("Move to Trash", '[role="alertdialog"]'));
  await until(async () => !(await projectIds()).includes(copy), "the copy in Trash");
  await browser.click(`[...document.querySelectorAll(".ui-seg-item")].find((item) => item.innerText.startsWith("Trash"))`, "the trash view");
  await browser.click(q(`[aria-label="Restore ${copy} from Trash"]`));
  await until(async () => (await projectIds()).includes(copy), "the restore");
  await browser.waitFor(`!document.querySelector(${JSON.stringify(`[aria-label="Restore ${copy} from Trash"]`)}) `, { what: "the restore button gone" });
  await browser.click(`[...document.querySelectorAll(".ui-seg-item")].find((item) => item.innerText.startsWith("Mine"))`, "the mine view");
  // The rows show a project's name; its id is on the row's data-id.
  await browser.waitFor(`!!document.querySelector('.proj-list[aria-label="Projects"] li[data-id="${copy}"]')`, { what: "the copy back in the list" });
});

test("variants shows the set the variants operation made, and a pick asks the agent for pick_variant", async () => {
  const composed = await agent("edit", { project: "orbit", ops: [{ op: "compose", type: "other", duration: 6, beats: [{ recipe: "headline-reveal", text: "Plan the week" }, { recipe: "cta-end", text: "Try Orbit" }] }] });
  assert.equal(composed.isError, undefined, composed.text);
  const original = (await snapshot()).record.document.scenes.at(-1);
  const made = await agent("edit", { project: "orbit", ops: [{ op: "variants", scene: original.id, vary: "layout", count: 2 }] });
  assert.equal(made.isError, undefined, made.text);
  const members = (await snapshot()).record.document.scenes.filter((scene) => scene.variant?.set);
  assert.equal(members.length, 3, "the original and two variants");
  await open();
  await commandByMouse("variants");
  await browser.waitFor(`${textOf("#screen-title")}.startsWith("Variants")`);
  // The screen no longer prints the set's id: a real set says "Pick one", a bare list of scenes does not.
  await browser.waitFor(pageHas("Pick one. Your agent gets the pick as a note.", ".screen"));
  await browser.waitFor(`[...document.querySelectorAll(".variant img")].filter((image) => image.complete && image.naturalWidth).length === 3`, { what: "three variant frames" });
  // Each caption's name carries what the scene is (original or the varied thing) as its title.
  assert.equal(await browser.evaluate(`document.querySelectorAll(".variant figcaption b")[0].title`), "Original");
  assert.equal(await browser.evaluate(`document.querySelectorAll(".variant figcaption b")[1].title`), "layout variant");
  assert.equal(await browser.evaluate(`document.querySelectorAll(".variant figcaption button").length`), 3, "a Pick button on each of the three");
  await browser.shot("variant-set");
  await browser.key("2");
  const note = await until(async () => (await snapshot()).agent.notes.find((entry) => entry.text.includes("Run pick_variant")), "the pick note");
  assert.match(note.text, /^I pick variant 2: .* Run pick_variant \{scene:"[^"]+"\}/);
  const picked = members.find((scene) => note.text.includes(`(${scene.id})`));
  assert.ok(picked && picked.variant.of !== picked.id, "the pick names a variant, not the original");
});

// Live playback: Space draws the scene in the window as it plays, at the speed of real time (also
// on a slowed-down page), with the export's own sound mix (GET /api/dashboard/mix) on a running
// AudioContext; an agent's edit shows while it plays; a pause shows the exact frame at the paused
// time. Its own project, so the scenes and turns the tests above count stay as they were.
test("live playback: Space plays the scene in real time with the export's sound; an edit shows while playing; a pause shows the exact frame", { skip: skipWithoutMediaTools }, async (t) => {
  const toneFile = path.join(folder, "tone.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "aevalsrc='0.25*sin(2*PI*440*t)':s=48000:d=6", "-c:a", "pcm_s16le", toneFile]);
  const uploaded = await server.api("/api/media", { method: "POST", headers: { "content-type": "audio/wav", "x-file-name": "tone.wav" }, body: await readFile(toneFile) });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const tone = (await uploaded.json()).src;
  const made = await agent("project", { action: "create", id: "tone", name: "Tone", width: 640, height: 360, duration: 6 });
  assert.equal(made.isError, undefined, made.text);
  const edited = await agent("edit", { project: "tone", ops: [
    { op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 20, y: 120, width: 100, height: 100, fill: "#ffb38a" } },
    { op: "add_animation", layer: "box", animation: { kind: "in", start: 0, duration: 6, easing: "linear", from: { x: 20 }, to: { x: 520 } } },
    { op: "add_layer", layerType: "audio", name: "tone", properties: { src: tone } },
  ] });
  assert.equal(edited.isError, undefined, edited.text);

  // What the page's network and Web Audio do, from the protocol's own events.
  const events = [];
  const keep = (message) => { if (message.event === "Network.responseReceived" || message.event?.startsWith("WebAudio.")) events.push(message); };
  browser.listeners.add(keep);
  await browser.send("Network.enable");
  await browser.send("WebAudio.enable");
  const status = textOf(".statusline");
  // The label's facts are separate spans now; the tooltip holds the whole label with its " · " joins.
  const label = `(${q(".stage-label")}?.title ?? "")`;
  // The status line's time ("00:01.23/…") and the page's own clock, read together.
  const sample = async () => {
    const { text, now } = await browser.evaluate(`({ text: ${playText}, now: performance.now() })`);
    const [, minutes, seconds] = text.match(/^(\d\d):(\d\d\.\d\d)\//);
    return { time: Number(minutes) * 60 + Number(seconds), now };
  };
  try {
    await open();
    await browser.waitFor(`${onProject("tone")}`, { what: "the tone project on the stage" });
    // The sound is fetched before play, so it can start with the key press.
    const mix = await until(() => events.find((message) => message.event === "Network.responseReceived" && message.params.response.url.includes("/api/dashboard/mix?project=tone") && message.params.response.status === 200), "the scene's sound mix");
    assert.equal(mix.params.response.mimeType, "audio/wav");

    await browser.key("1");
    // The first frames-a-second number the label shows, read once a display frame from Play.
    await browser.evaluate(`(() => {
      window.firstRate = null;
      const read = () => { const found = ${label}.match(/^live · (\\d+)\\/\\d+fps/); if (found) window.firstRate = Number(found[1]); else requestAnimationFrame(read); };
      requestAnimationFrame(read);
    })()`);
    await browser.key(" ");
    await browser.waitFor(`!!document.querySelector(".stage .stage-live .scene-svg svg") && ${label}.startsWith("live · ")`, { what: "the live picture" });
    await browser.waitFor(`${label}.includes("sound on")`, { what: "the sound playing" });
    // The clock runs a little slow while the picture gets ready and then catches up: the speed is read from the steady part.
    await browser.waitFor(`(() => { const found = ${playText}.match(/^(\\d\\d):(\\d\\d\\.\\d\\d)\\//); return !!found && Number(found[1]) * 60 + Number(found[2]) >= 0.7; })()`, { what: "the clock past the start" });
    const first = await sample();
    await sleep(2000);
    const second = await sample();
    const speed = (second.time - first.time) / ((second.now - first.now) / 1000);
    assert.ok(speed >= 0.9 && speed <= 1.1, `played ${speed.toFixed(3)}× real time (from ${first.time} s to ${second.time} s)`);
    t.diagnostic(`played ${speed.toFixed(3)}× real time at CPU slowdown ${slowdown}; the stage said "${await browser.evaluate(label)}"`);
    // The first count, half a second after Play, is a rate too: it once counted half a second's
    // pictures as a second's and said about 15 of 30.
    const firstRate = await browser.evaluate("window.firstRate");
    const steadyRate = Number((await browser.evaluate(label)).match(/^live · (\d+)\//)?.[1]);
    t.diagnostic(`the label's first count said ${firstRate} fps, two seconds later ${steadyRate}`);
    assert.ok(firstRate >= 0.7 * steadyRate, `the first count (${firstRate} fps) is a rate, like the later one (${steadyRate} fps)`);
    await browser.shot("live-playing");

    // The AudioContext runs, and its clock moves on.
    const created = await until(() => events.find((message) => message.event === "WebAudio.contextCreated" && message.params.context.contextType === "realtime"), "an AudioContext");
    const contextId = created.params.context.contextId;
    const state = () => events.filter((message) => ["WebAudio.contextCreated", "WebAudio.contextChanged"].includes(message.event) && message.params.context.contextId === contextId).at(-1).params.context.contextState;
    await until(() => state() === "running", "the AudioContext running");
    const before = (await browser.send("WebAudio.getRealtimeData", { contextId })).realtimeData.currentTime;
    await sleep(500);
    const later = (await browser.send("WebAudio.getRealtimeData", { contextId })).realtimeData.currentTime;
    assert.ok(later - before > 0.3, `the AudioContext's time moved ${later - before} s in 0.5 s`);
    t.diagnostic(`the AudioContext ran: its time moved ${(later - before).toFixed(3)} s in 0.5 s`);

    // The agent recolours the box while it plays: the live picture changes, and it keeps playing.
    const recolour = await agent("edit", { project: "tone", ops: [{ op: "update_layer", layer: "box", properties: { fill: "#2fb37a" } }] });
    assert.equal(recolour.isError, undefined, recolour.text);
    await browser.waitFor(`(document.querySelector(".stage-live svg")?.outerHTML ?? "").toLowerCase().includes("#2fb37a")`, { what: "the edit in the live picture" });
    await browser.waitFor(`${label}.includes(${JSON.stringify(`rev ${recolour.data.rev}`)})`, { what: "the new revision while playing" });
    const still = await sample();
    await sleep(300);
    assert.ok((await sample()).time !== still.time && (await browser.evaluate(isPlaying)), "it kept playing through the edit");

    // A pause shows the exact frame from the server, at the paused time on the frame grid.
    await browser.key(" ");
    await browser.waitFor(`${isPaused}`, { what: "paused" });
    const frame = await browser.waitFor(`(() => { const image = document.querySelector(".stage img"); return !document.querySelector(".stage-live") && image?.complete && image.naturalWidth ? image.getAttribute("src") : null; })()`, { what: "the exact frame" });
    const paused = await sample();
    const shownAt = Number(new URL(frame, appUrl).searchParams.get("t"));
    assert.ok(Math.abs(shownAt * 30 - Math.round(shownAt * 30)) < 0.05, `the frame at ${shownAt} s is on the 30 fps grid`);
    assert.ok(Math.abs(shownAt - paused.time) < 0.006, `the frame at ${shownAt} s is the paused time ${paused.time} s`);
    // The shown facts are one span each (no dots drawn between them); joined, they are the old text.
    assert.match(await browser.evaluate(`[...document.querySelectorAll(".stage-label > span")].map((fact) => fact.innerText).join(" · ")`), /^\d+×\d+ · 30fps · draft · rev \d+$/);
    assert.match(await browser.evaluate(`${q(".stage-label")}.title`), /^preview \d+×\d+ · 30fps · draft · rev \d+ · exact frame$/);
    await browser.shot("paused-exact-frame");

    // Under reduced motion Space still plays and pauses.
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    try {
      await browser.key(" ");
      await browser.waitFor(`${isPlaying} && ${label}.startsWith("live · ")`, { what: "playing under reduced motion" });
      await browser.key(" ");
      await browser.waitFor(`${isPaused}`, { what: "paused under reduced motion" });
    } finally {
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    }
  } finally {
    browser.listeners.delete(keep);
    await browser.send("WebAudio.disable").catch(() => {});
    await browser.send("Network.disable").catch(() => {});
    await agent("project", { action: "open", id: "orbit" });
  }
});

test("a video in a playing scene plays on its own: one video element, no seek every frame, and the paused frame until it has a picture", { skip: skipWithoutMediaTools }, async (t) => {
  const clipFile = path.join(folder, "clip.mp4");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "15", "-an", clipFile]);
  const uploaded = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "clip.mp4" }, body: await readFile(clipFile) });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const src = (await uploaded.json()).src;
  const made = await agent("project", { action: "create", id: "clip", name: "Clip", width: 640, height: 360, duration: 4 });
  assert.equal(made.isError, undefined, made.text);
  const edited = await agent("edit", { project: "clip", ops: [
    { op: "add_layer", layerType: "rectangle", name: "ground", properties: { x: 0, y: 0, width: 640, height: 360, fill: "#203040", radius: 0 } },
    { op: "add_layer", layerType: "video", name: "clip", properties: { src, x: 160, y: 90, width: 320, height: 180, mediaSourceDuration: 4 } },
    // A box that moves, so the scene's picture changes every frame around the video.
    { op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 20, y: 300, width: 40, height: 40, fill: "#ffb38a", radius: 0 } },
    { op: "add_animation", layer: "box", animation: { kind: "in", start: 0, duration: 4, easing: "linear", from: { x: 20 }, to: { x: 580 } } },
  ] });
  assert.equal(edited.isError, undefined, edited.text);
  try {
    await open();
    await browser.waitFor(`${onProject("clip")}`, { what: "the clip project on the stage" });
    await browser.key("1");
    await browser.waitFor(`(() => { const image = ${q(".stage img")}; return !!(image?.complete && image.naturalWidth); })()`, { what: "the exact frame" });
    // Once a display frame from Play: which video element the live picture has, whether it has a
    // picture for its time, and whether the paused frame still covers it. And every seek.
    await browser.evaluate(`(() => {
      window.clipSeeks = [];
      document.addEventListener("seeking", (event) => { if (event.target.tagName === "VIDEO") window.clipSeeks.push(Math.round(performance.now() - window.clipBegan)); }, true);
      window.clipFrames = []; window.clipVideos = [];
      window.clipBegan = performance.now();
      const tick = (now) => {
        const video = document.querySelector(".stage-live video");
        if (video && !window.clipVideos.includes(video)) window.clipVideos.push(video);
        window.clipFrames.push({ at: Math.round(now - window.clipBegan), video: Boolean(video), ready: video ? video.readyState : null, seeking: video ? video.seeking : null, held: !!document.querySelector(".stage img.holding") });
        if (now - window.clipBegan < 2500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
    await browser.key(" ");
    await browser.waitFor(isPlaying, { what: "playing" });
    await browser.waitFor(`performance.now() - window.clipBegan > 2600`, { what: "2.5 s of play" });
    const seen = await browser.evaluate(`({ frames: window.clipFrames, seeks: window.clipSeeks, videos: window.clipVideos.length })`);
    // A frame where the live video shows with no picture for its time (still loading or seeking).
    // Under load the first picture took over 400 ms and the hold ended first: the paused frame now
    // stays while a video loads, up to VIDEO_HOLD_MS (panes.jsx).
    const blank = seen.frames.filter((frame) => frame.video && !frame.held && (frame.ready < 2 || frame.seeking));
    const steadySeeks = seen.seeks.filter((at) => at > 1000);
    t.diagnostic(`${seen.frames.length} display frames in 2.5 s; ${seen.videos} video element(s); seeks at ${JSON.stringify(seen.seeks)} ms; held for ${seen.frames.filter((frame) => frame.held).length} frame(s); ${blank.length} frame(s) of a video with no picture`);
    // Before, each new frame's SVG replaced the video element (it compared "VIDEO" with "video"),
    // so the video loaded and sought again about 30 times a second and was often black.
    assert.equal(seen.videos, 1, "the live picture keeps one video element");
    assert.ok(steadySeeks.length <= 2, `no seek every frame once playing: ${JSON.stringify(seen.seeks)}`);
    assert.ok(blank.length <= 2, `the video has a picture while it shows: ${JSON.stringify(blank)}`);
    await browser.key(" ");
    await browser.waitFor(isPaused, { what: "paused" });
  } finally {
    await agent("project", { action: "open", id: "orbit" });
  }
});

test("a video under an effect plays with a new captured picture about every frame, encoded off the page as JPEG, and its element survives layers showing before it", { skip: skipWithoutMediaTools }, async (t) => {
  const clipFile = path.join(folder, "effect-clip.mp4");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "15", "-an", clipFile]);
  const uploaded = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "effect-clip.mp4" }, body: await readFile(clipFile) });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const src = (await uploaded.json()).src;
  const made = await agent("project", { action: "create", id: "fxclip", name: "Effect clip", width: 640, height: 360, duration: 4 });
  assert.equal(made.isError, undefined, made.text);
  const edited = await agent("edit", { project: "fxclip", ops: [
    { op: "add_layer", layerType: "video", name: "clip", properties: { src, x: 160, y: 90, width: 320, height: 180, mediaSourceDuration: 4 } },
    { op: "add_animation", layer: "clip", effect: "spin-blur", start: 0, duration: 4, parameters: { angle: 4 } },
    // A plain video above it, and a box that shows before that video halfway through.
    { op: "add_layer", layerType: "rectangle", name: "early box", properties: { x: 20, y: 20, width: 40, height: 40, fill: "#ffb38a", radius: 0 } },
    { op: "add_animation", layer: "early box", animation: { kind: "show", start: 1.5 } },
    { op: "add_animation", layer: "early box", animation: { kind: "hide", start: 0 } },
    { op: "add_layer", layerType: "video", name: "plain", properties: { src, x: 500, y: 250, width: 120, height: 68, mediaSourceDuration: 4 } },
  ] });
  assert.equal(edited.isError, undefined, edited.text);
  try {
    await open();
    await browser.waitFor(`${onProject("fxclip")}`, { what: "the effect clip project on the stage" });
    await browser.key("1");
    await browser.waitFor(`(() => { const image = ${q(".stage img")}; return !!(image?.complete && image.naturalWidth); })()`, { what: "the exact frame" });
    // Once a display frame while playing: the captured pictures (blob images) and the plain video
    // element. The pictures are counted for 2.5 s from the first one, against the display frames
    // and the frames of the clip's decoder video in those 2.5 s: on a slow computer the video can
    // take a second to load, and display frames before it has a picture are no chance to capture.
    await browser.evaluate(`(() => {
      window.fx = { pictures: new Set(), plain: new Set(), frames: 0, videoFrames: 0, decoders: new WeakSet(), began: performance.now(), from: null, done: false };
      const counting = (at) => window.fx.from !== null && at - window.fx.from < 2500;
      const tick = (now) => {
        // The clip's decoder video: each new frame it shows is a chance to capture one.
        for (const video of document.querySelectorAll(".stage-live video[data-video-frame-decoder]")) {
          if (window.fx.decoders.has(video)) continue;
          window.fx.decoders.add(video);
          const count = (at) => {
            if (window.fx.done) return;
            if (counting(at)) window.fx.videoFrames += 1;
            video.requestVideoFrameCallback(count);
          };
          video.requestVideoFrameCallback(count);
        }
        for (const image of document.querySelectorAll(".stage-live svg image")) {
          const href = image.getAttribute("href");
          if (!href?.startsWith("blob:") || window.fx.pictures.has(href)) continue;
          window.fx.from ??= now;
          if (!counting(now)) continue;
          window.fx.pictures.add(href);
          // What kind of file one picture is, read while it is on screen.
          if (window.fx.pictures.size === 10) fetch(href).then((reply) => reply.blob()).then((blob) => { window.fx.type = blob.type; }, () => { window.fx.type = "unreadable"; });
        }
        if (counting(now)) window.fx.frames += 1;
        const plain = [...document.querySelectorAll(".stage-live video")].find((video) => video.dataset.mediaLayerId && !video.closest("[visibility=hidden]"));
        if (plain && now - window.fx.began > 700) window.fx.plain.add(plain);
        window.fx.done = (window.fx.from !== null && now - window.fx.from >= 2500) || now - window.fx.began >= 10_000;
        if (!window.fx.done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
    await browser.key(" ");
    await browser.waitFor(isPlaying, { what: "playing" });
    await browser.waitFor("window.fx.done", { what: "2.5 s of play from the first captured picture" });
    const seen = await browser.evaluate(`({ pictures: window.fx.pictures.size, frames: window.fx.frames, videoFrames: window.fx.videoFrames, plainElements: window.fx.plain.size, type: window.fx.type, wait: window.fx.from === null ? null : Math.round(window.fx.from - window.fx.began) })`);
    t.diagnostic(`${seen.pictures} captured pictures in ${seen.frames} display frames and ${seen.videoFrames} frames of the clip's decoder video, 2.5 s from the first picture (${seen.wait} ms after the count began); ${seen.plainElements} element(s) for the plain video; last picture ${seen.type}`);
    // 30 frames a second of footage: before, each picture also redrew the whole scene and was
    // encoded as PNG on the page's thread. Each display frame shows one new picture at most, and
    // each frame of the decoder video is one to capture, so the chances are the fewer of the two.
    // At least 40% of them is a loose floor for busy computers; 35% under 60 chances (Linux CI
    // draws on the CPU: 15 pictures in 38 frames once).
    const chances = Math.min(seen.frames, seen.videoFrames);
    const floor = Math.max(1, Math.ceil(chances * (chances < 60 ? 0.35 : 0.4)));
    assert.ok(seen.pictures >= floor, `a new picture about every frame: ${seen.pictures} in ${seen.frames} display frames and ${seen.videoFrames} video frames (at least ${floor})`);
    assert.equal(seen.type, "image/jpeg", "an MP4's frames are JPEG");
    assert.equal(seen.plainElements, 1, "the plain video keeps one element when the box shows before it");
    await browser.key(" ");
    await browser.waitFor(isPaused, { what: "paused" });
  } finally {
    await agent("project", { action: "open", id: "orbit" });
  }
});

test("at 1100×760 and 1280×800 the log ends on a whole row, shows its scroll bar and keeps the newest turn in view; j and k keep the picked turn in view; the stage's facts keep the rev number", async () => {
  const made = await agent("project", { action: "create", id: "turns", name: "Turns", width: 1920, height: 1080, duration: 4 });
  assert.equal(made.isError, undefined, made.text);
  // 24 turns (a row is about 20 px and the log about 370 px tall at 800 px, so some 19 rows show):
  // a note between two edits starts a new turn.
  for (let index = 1; index <= 24; index++) {
    const edited = await agent("edit", { project: "turns", ops: [{ op: "add_layer", layerType: "rectangle", name: `box ${index}`, properties: { x: 20 * index, y: 20 * index, width: 100, height: 60, fill: "#336699", radius: 0 } }] });
    assert.equal(edited.isError, undefined, edited.text);
    const noted = await agent("notes", { project: "turns", action: "add", text: `turn ${index} done` });
    assert.equal(noted.isError, undefined, noted.text);
  }
  const log = `(() => {
    const panel = ${q("#panel-log")};
    const bottom = panel.getBoundingClientRect().top + panel.clientHeight;
    const rows = [...panel.querySelectorAll(".log-row")].map((row) => row.getBoundingClientRect());
    return { rows: rows.length, client: panel.clientHeight, scroll: panel.scrollHeight, bar: panel.offsetWidth - panel.clientWidth, cut: rows.filter((row) => row.top < bottom - 0.5 && row.bottom > bottom + 0.5).length };
  })()`;
  // Whether a log row is wholly inside the log box: the newest (the last row) or the picked one.
  const inView = (row) => `(() => {
    const panel = ${q("#panel-log")};
    const box = panel.getBoundingClientRect();
    const row = ${row};
    if (!row) return { found: false };
    const rect = row.getBoundingClientRect();
    return { found: true, id: row.querySelector(".agent")?.textContent, index: [...panel.querySelectorAll(".log-row")].indexOf(row), inView: rect.top >= box.top - 0.5 && rect.bottom <= box.top + panel.clientHeight + 0.5, top: Math.round(rect.top - box.top), bottom: Math.round(rect.bottom - box.top), client: panel.clientHeight, scrollTop: Math.round(panel.scrollTop) };
  })()`;
  const newest = inView(`[...panel.querySelectorAll(".log-row")].at(-1)`);
  const picked = inView(`panel.querySelector(".log-row.selected")`);
  const facts = `(() => { const label = ${q(".stage-label")}; return { text: [...label.children].map((fact) => fact.innerText).join(" · "), cut: label.scrollWidth > label.clientWidth + 1 }; })()`;
  try {
    for (const [width, height] of [[1100, 760], [1280, 800]]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
      await open();
      await showView("log", { focus: false });
      // The stage has the focus (as after a load), so the log is not the list j and k move in.
      await browser.key("1");
      await browser.waitFor(`document.activeElement?.dataset?.pane === "1"`, { what: "pane 1" });
      await browser.waitFor(`${onProject("turns")} && document.querySelectorAll("#panel-log .log-row").length >= 24`, { what: `the turns project's log at ${width}×${height}` });
      const shown = await browser.evaluate(log);
      assert.ok(shown.scroll > shown.client + 19, `more rows than fit at ${width}×${height}: ${JSON.stringify(shown)}`);
      assert.equal(shown.cut, 0, `no row cut in half at ${width}×${height}: ${JSON.stringify(shown)}`);
      assert.ok(shown.bar >= 6, `the scroll bar is drawn and takes room at ${width}×${height}: ${JSON.stringify(shown)}`);
      // The log opens on its end: the newest turn (the last row) is in view. Before, it showed the
      // oldest turns and never scrolled by itself.
      const last = await browser.evaluate(newest);
      assert.ok(last.inView, `the newest turn is in view at ${width}×${height}: ${JSON.stringify(last)}`);
      // Paused, the stage's facts end in the rev number, and the title gives way to them.
      const said = await browser.evaluate(facts);
      assert.ok(!said.cut && /· rev \d+$/.test(said.text), `the stage facts fit at ${width}×${height}: ${JSON.stringify(said)}`);
    }
    // A new turn while the log is at its end: the log follows it.
    const rowCount = await browser.evaluate(`document.querySelectorAll("#panel-log .log-row").length`);
    const edited = await agent("edit", { project: "turns", ops: [{ op: "add_layer", layerType: "rectangle", name: "box 25", properties: { x: 460, y: 460, width: 100, height: 60, fill: "#336699", radius: 0 } }] });
    assert.equal(edited.isError, undefined, edited.text);
    await browser.waitFor(`document.querySelectorAll("#panel-log .log-row").length === ${rowCount + 1}`, { what: "the new turn in the log" });
    const followed = await browser.waitFor(`(() => { const now = ${newest}; return now.inView ? now : null; })()`, { what: "the log following the new turn" });
    assert.ok(followed.inView, JSON.stringify(followed));
    // The agent pane focused on its log view: the picked turn starts on the newest, and k (older)
    // and j (newer) keep it in view, as little scrolling as needed. Before, k went up past the top of the box.
    await browser.key("2");
    await browser.waitFor(`document.activeElement?.dataset?.pane === "2"`, { what: "pane 2" });
    const first = await browser.waitFor(`(() => { const now = ${picked}; return now.found ? now : null; })()`, { what: "a picked turn" });
    assert.ok(first.inView && first.id === followed.id, `the picked turn is the newest, in view: ${JSON.stringify(first)} (newest ${followed.id})`);
    // There are rowCount + 1 rows now; the newest is row index rowCount. k past the oldest and j
    // past the newest stay where they are.
    const out = [];
    let index = rowCount;
    for (const [key, times] of [["k", rowCount + 2], ["j", 6], ["j", rowCount]]) {
      for (let press = 0; press < times; press++) {
        index = key === "k" ? Math.max(0, index - 1) : Math.min(rowCount, index + 1);
        await browser.key(key);
        const now = await browser.waitFor(`(() => { const now = ${picked}; return now.index === ${index} ? now : null; })()`, { what: `${key} to the turn in row ${index + 1}` });
        if (!now.inView) out.push({ key, press, ...now });
      }
    }
    assert.deepEqual(out, [], "every picked turn is in view");
    assert.equal((await browser.evaluate(picked)).id, followed.id, "j comes back to the newest turn");

    // [4] still focused, the log scrolled up by hand with the mouse wheel: a new turn leaves it
    // where it is, even with the picked turn out of view. Picking another turn brings that one
    // into view; at the end again, the log follows the new turn. Before, every new turn
    // scrolled the log back to the picked turn.
    const view = `(() => {
      const panel = ${q("#panel-log")};
      const box = panel.getBoundingClientRect();
      const rows = [...panel.querySelectorAll(".log-row")];
      const first = rows.find((row) => row.getBoundingClientRect().bottom > box.top + 1);
      return { scrollTop: Math.round(panel.scrollTop), atEnd: panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2, first: first?.querySelector(".agent")?.textContent, rows: rows.length, picked: panel.querySelector(".log-row.selected .agent")?.textContent };
    })()`;
    const wheel = async (deltaY) => {
      const at = await browser.box(q("#panel-log"));
      for (let step = 0; step < 40; step++) {
        const now = await browser.evaluate(view);
        if (deltaY < 0 ? now.scrollTop === 0 : now.atEnd) return now;
        await browser.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY });
        await sleep(120);
      }
      throw new Error(`the mouse wheel did not scroll the log to its ${deltaY < 0 ? "top" : "end"}: ${JSON.stringify(await browser.evaluate(view))}`);
    };
    let boxes = 25;
    // The agent adds a note, then an edit: a new turn (a note ends the turn before it).
    const newTurnInLog = async () => {
      const count = await browser.evaluate(`document.querySelectorAll("#panel-log .log-row").length`);
      boxes += 1;
      const noted = await agent("notes", { project: "turns", action: "add", text: `box ${boxes} next` });
      assert.equal(noted.isError, undefined, noted.text);
      const added = await agent("edit", { project: "turns", ops: [{ op: "add_layer", layerType: "rectangle", name: `box ${boxes}`, properties: { x: 10, y: 10, width: 100, height: 60, fill: "#336699", radius: 0 } }] });
      assert.equal(added.isError, undefined, added.text);
      await browser.waitFor(`document.querySelectorAll("#panel-log .log-row").length === ${count + 1}`, { what: `the turn with box ${boxes} in the log` });
      // Two display frames, so whatever scrolling the new row brings has happened.
      await browser.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      return browser.evaluate(view);
    };
    assert.equal(await browser.evaluate(`document.activeElement?.dataset?.pane`), "2", "the agent pane has the focus");
    const top = await wheel(-3000);
    assert.equal(top.picked, followed.id, `the newest turn is still picked: ${JSON.stringify(top)}`);
    const kept = await newTurnInLog();
    assert.deepEqual({ scrollTop: kept.scrollTop, first: kept.first, picked: kept.picked }, { scrollTop: 0, first: top.first, picked: top.picked },
      `a new turn leaves the log where it was scrolled by hand: before ${JSON.stringify(top)}, after ${JSON.stringify(kept)}`);
    // k twice picks an older turn, which is brought into view; scrolled up again, the next turn
    // leaves the log there too.
    const olderIndex = kept.rows - 4;
    await browser.keys("k", "k");
    const older = await browser.waitFor(`(() => { const now = ${picked}; return now.index === ${olderIndex} ? now : null; })()`, { what: "k twice to an older turn" });
    assert.ok(older.inView, `the turn picked with k is brought into view: ${JSON.stringify(older)}`);
    const topAgain = await wheel(-3000);
    const keptAgain = await newTurnInLog();
    assert.deepEqual({ scrollTop: keptAgain.scrollTop, first: keptAgain.first, picked: keptAgain.picked }, { scrollTop: 0, first: topAgain.first, picked: older.id },
      `after k, a new turn leaves the log where it was scrolled by hand: before ${JSON.stringify(topAgain)}, after ${JSON.stringify(keptAgain)}`);
    // Scrolled to the end by hand, the log follows the next turn.
    await wheel(3000);
    const following = await newTurnInLog();
    assert.ok(following.atEnd, `at its end, the log follows a new turn: ${JSON.stringify(following)}`);
    assert.ok((await browser.evaluate(newest)).inView, "the newest turn is in view");
  } finally {
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await agent("project", { action: "open", id: "orbit" });
  }
});

// The light-rays scene of the next test, 1920×1080 and 60 s long: a black ground, a grey panel at
// x 60 (its left edge tells how sharp the picture is), a white sun that makes the rays, and above
// them a green marker that moves from x 330 at 0 s to x 1730 at 60 s (it tells which moment a
// picture shows). The test plays it once, from Play to the pause, without reaching the end: that
// took 9.6 s on CI and more than 12 s on 1 or 2 cores, where a 12 s scene had started again, and
// 36 s on Linux CI from 2026-11-01, where a 30 s scene had.
const RAYS_SECONDS = 60;
const markerAt = (seconds) => 330 + (1400 * seconds) / RAYS_SECONDS;

/**
 * How sharp the left edge of the light-rays scene's grey panel is in a picture of the window: for
 * rows across the edge, how many pixels are neither the black ground nor the grey panel. Drawn at
 * full resolution, an edge has at most one such pixel; drawn smaller and enlarged, it has several.
 */
async function panelEdge(png, stage) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const perCssPixel = image.width / stage.viewport;
  const rows = [];
  for (let sceneY = 640; sceneY <= 840; sceneY += 20) {
    const x = Math.round((stage.left + (60 * stage.width) / 1920) * perCssPixel);
    const y = Math.round((stage.top + (sceneY * stage.height) / 1080) * perCssPixel);
    const pixels = context.getImageData(x - 20, y, 40, 1).data;
    const red = Array.from({ length: 40 }, (_, index) => pixels[index * 4]);
    const [low, high] = [red[0], red[39]];
    // Any pixel more than 3% away from both colours counts: an enlarged edge fades over about as
    // many pixels as it was enlarged, so a narrower band (10% to 90%) can catch only one of them.
    rows.push({ low, high, between: red.filter((value) => value > low + 0.03 * (high - low) && value < high - 0.03 * (high - low)).length });
  }
  return { perCssPixel, rows, mean: rows.reduce((sum, row) => sum + row.between, 0) / rows.length };
}

/**
 * What one painted frame of the window (`bytes`, a PNG or JPEG) shows on the stage, read on the row
 * at scene y 740 through the panel and the marker: `filled` when the scene fills the stage there
 * (the panel 200 scene pixels wide at x 60, and the marker), and then `markerX`, the marker's scene
 * x, which says which moment the picture is of. A picture drawn small and not enlarged has no panel
 * of that size there; the exact frame from before the play has the marker at x 330. `stages` are
 * the stage's boxes in windows of different heights; during a resize the window can paint a frame
 * before the stage has its new size, so each box is tried.
 */
async function raysFrame(bytes, stages) {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  let missed;
  for (const stage of stages) {
    const perCssPixel = image.width / stage.viewport;
    const y = Math.round((stage.top + (740 * stage.height) / 1080) * perCssPixel);
    if (y >= image.height) continue;
    const data = context.getImageData(0, y, image.width, 1).data;
    const runs = (matches) => {
      const found = [];
      for (let x = 0; x < image.width; x++) {
        const [r, g, b] = [data[x * 4], data[x * 4 + 1], data[x * 4 + 2]];
        if (!matches(r, g, b)) continue;
        if (found.length && found.at(-1)[1] >= x - 2) found.at(-1)[1] = x;
        else found.push([x, x]);
      }
      return found;
    };
    // Window pixels per scene pixel when the scene fills this stage.
    const perScenePixel = (stage.width / 1920) * perCssPixel;
    const sized = (width) => ([start, end]) => Math.abs(end - start + 1 - width * perScenePixel) <= Math.max(3, 0.1 * width * perScenePixel);
    const panel = runs((r, g, b) => r > 100 && r < 160 && Math.abs(r - g) < 20 && Math.abs(r - b) < 20).find(sized(200));
    const marker = runs((r, g, b) => g > 170 && g - r > 80 && g - b > 80).find(sized(100));
    const panelX = panel ? (panel[0] / perCssPixel - stage.left) / (stage.width / 1920) : null;
    if (panel && marker && Math.abs(panelX - 60) <= 10) return { filled: true, markerX: Math.round(60 + (marker[0] - panel[0]) / perScenePixel) };
    missed ??= { filled: false, panelX: panelX && Math.round(panelX), marker: Boolean(marker) };
  }
  return missed ?? { filled: false };
}

test("light rays play at a lower resolution on a large 2× stage; no older or unfinished picture shows when they go off and on or the window is resized; a pause shows the full exact frame", async (t) => {
  const made = await agent("project", { action: "create", id: "rays", name: "Rays", width: 1920, height: 1080, duration: RAYS_SECONDS });
  assert.equal(made.isError, undefined, made.text);
  const edited = await agent("edit", { project: "rays", ops: [
    { op: "add_layer", layerType: "rectangle", name: "ground", properties: { x: 0, y: 0, width: 1920, height: 1080, fill: "#000000", radius: 0 } },
    { op: "add_layer", layerType: "rectangle", name: "panel", properties: { x: 60, y: 560, width: 200, height: 360, fill: "#808080", radius: 0 } },
    { op: "add_layer", layerType: "ellipse", name: "sun", properties: { x: 1560, y: 80, width: 200, height: 200, fill: "#ffffff" } },
    { op: "group_layers", layers: ["ground", "panel", "sun"], name: "footage", groupId: "footage" },
    { op: "add_animation", layer: "footage", effect: "light-rays", start: 0, duration: RAYS_SECONDS, parameters: { centerX: 0.86, centerY: 0.17, length: 0.3, threshold: 0.65 } },
    { op: "add_layer", layerType: "rectangle", name: "marker", properties: { x: 330, y: 600, width: 100, height: 280, fill: "#00ff00", radius: 0 } },
    { op: "add_animation", layer: "marker", animation: { kind: "in", start: 0, duration: RAYS_SECONDS, easing: "linear", from: { x: markerAt(0) }, to: { x: markerAt(RAYS_SECONDS) } } },
  ] });
  assert.equal(edited.isError, undefined, edited.text);
  // The agent looks at what it built, as it would: that clears the layers' building outlines,
  // which would otherwise sit beside the panel this test measures.
  const lookAtIt = async () => assert.equal((await agent("look", { project: "rays", mode: "frame", t: 0 })).isError, undefined);
  await lookAtIt();
  const saved = (await (await server.api("/api/dashboard/snapshot?project=rays")).json()).record.document;
  const rays = saved.scenes[0].layers.find((layer) => layer.name === "footage").animations[0];
  assert.equal(rays.effect, "light-rays");
  const turnRays = async (enabled) => {
    const reply = await agent("edit", { project: "rays", ops: [{ op: "update_animation", layer: "footage", animation: rays.id, properties: { enabled } }] });
    assert.equal(reply.isError, undefined, reply.text);
    await lookAtIt();
  };

  const status = textOf(".statusline");
  // The label's facts are separate spans now; the tooltip holds the whole label with its " · " joins.
  const label = `(${q(".stage-label")}?.title ?? "")`;
  const shownFacts = `[...document.querySelectorAll(".stage-label > span")].map((fact) => fact.innerText).join(" · ")`;
  const exactFrame =`(() => { const image = document.querySelector(".stage img"); return image?.complete && image.naturalWidth ? { src: image.getAttribute("src"), naturalWidth: image.naturalWidth } : null; })()`;
  const stageBox = `(() => { const box = document.querySelector(".stage").getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height, viewport: innerWidth, viewportHeight: innerHeight }; })()`;
  const picture = `(() => { const element = [...document.querySelectorAll(".stage-live .live-picture")].find((item) => item.style.transform.startsWith("scale(")); if (!element) return null; const box = element.getBoundingClientRect(); return { willChange: getComputedStyle(element).willChange, transform: element.style.transform, width: box.width, height: box.height, layoutWidth: element.offsetWidth, transition: getComputedStyle(element).transitionDuration }; })()`;
  const reducedNow = `(() => { const now = ${picture}; return now?.willChange === "transform" && ${label}.includes("drawn at") ? now : null; })()`;
  const fullNow = `(() => !${picture} && !!document.querySelector(".stage-live .live-picture") && !${label}.includes("drawn at") && ${label}.startsWith("live · "))()`;
  const sceneTime = async () => {
    const [, minutes, seconds] = (await browser.evaluate(playText)).match(/^(\d\d):(\d\d\.\d\d)\//);
    return Number(minutes) * 60 + Number(seconds);
  };
  const windowPicture = async () => {
    const shot = await browser.send("capture", {}, 10_000);
    assert.equal(shot.empty, false, "a picture of the window");
    return Buffer.from(shot.data, "base64");
  };
  // Every frame the window paints (the protocol's screencast; each one is acknowledged so the next
  // comes), in the order the frames arrive, each with the time the protocol says it was drawn.
  // Neither order is right on every computer. Chromium encodes up to three frames at once, so a
  // frame can arrive after a later one; on the Mac the drawn times are right. Under xvfb on Linux
  // the frames arrive in the order drawn, but some drawn times jump: a few frames in a row are
  // stamped 8.4 s late, also on a blank page (Electron 44, Ubuntu 24.04). Sorted by those times,
  // 20 of 189 frames looked older than an earlier one when none was. So the check below compares
  // a frame only with the frames that came before it in both orders.
  const painted = [];
  const keepFrame = (message) => {
    if (message.event !== "Page.screencastFrame") return;
    painted.push({ data: message.params.data, drawnAt: message.params.metadata?.timestamp });
    browser.send("Page.screencastFrameAck", { sessionId: message.params.sessionId }).catch(() => {});
  };
  browser.listeners.add(keepFrame);
  const size = (height) => browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height, deviceScaleFactor: 2, mobile: false });

  // A 2× screen with the stage zoomed: about 2770×1560 device pixels, three times 1280×720.
  await size(900);
  try {
    await open();
    await browser.waitFor(`${onProject("rays")}`, { what: "the rays project on the stage" });
    // This test reads the scene's own pixels in pictures of the window. While the agent's edit
    // shows, its stage bot rides beside its cursor over the frame (presence.jsx) and crossed the
    // marker on the measured row, so the agents' layer is hidden here (the next page load drops it).
    // The seen drawer opens under the video after each look and closes a few seconds later, which
    // resizes the stage measured below, so it is hidden too.
    await browser.evaluate(`document.head.insertAdjacentHTML("beforeend", "<style>.presence-stage { visibility: hidden !important; } .live-seen { display: none !important; }</style>")`);
    await browser.key("1");
    await browser.key("+");
    await browser.waitFor(`!!document.querySelector('.pane.is-zoomed[data-pane="1"]')`, { what: "the stage zoomed" });
    await browser.waitFor(`(() => { const frame = ${exactFrame}; return frame && new URL(frame.src, location.href).searchParams.get("w") === "1920"; })()`, { what: "the 1920-wide exact frame of the zoomed stage" });
    const stage = await browser.evaluate(stageBox);
    const room = await browser.evaluate(`(() => { const box = ${q(".stage-wrap")}.getBoundingClientRect(); return { top: box.top, height: box.height }; })()`);
    assert.ok(stage.width * 2 * stage.height * 2 > 2 * 1280 * 720, `the stage is ${stage.width}×${stage.height} CSS pixels at 2×`);
    // The stage in a window 180 pixels shorter, for the resize while playing (at 800 high the
    // whole 1074-wide stage still fits over the agent's line and the playback row).
    await size(720);
    const shorter = await browser.waitFor(`(() => { const box = ${stageBox}; return box.viewportHeight === 720 && box.height < ${stage.height - 20} ? box : null; })()`, { what: "the smaller stage in the shorter window" });
    assert.ok(shorter.height < stage.height - 20, `the stage is smaller in the shorter window: ${shorter.width}×${shorter.height}`);
    // The stage sits in the middle of its room. When the window grows, it can paint one frame
    // before the stage has its new size: the shorter stage, in the middle of the taller room.
    const growing = { ...shorter, top: room.top + (room.height - shorter.height) / 2, viewportHeight: 900 };
    await size(900);
    await browser.waitFor(`(() => { const box = ${stageBox}; return box.viewportHeight === 900 && Math.abs(box.height - ${stage.height}) < 1; })()`, { what: "the stage back at its size in the 900-high window" });
    const exact =await browser.waitFor(exactFrame, { what: "the exact frame before playing" });
    // After the resize the window can take a moment to paint the exact frame again.
    let before;
    for (let attempt = 0; attempt < 10; attempt++) {
      before = await raysFrame(await windowPicture(), [stage]);
      if (before.filled) break;
      await sleep(200);
    }
    assert.ok(before.filled && Math.abs(before.markerX - markerAt(0)) <= 3, `the exact frame at 0 s shows the marker at ${markerAt(0)}: ${JSON.stringify(before)}`);
    // The panel's edge in pictures of the window, taken until `wanted` holds or 3 s have passed:
    // on a busy computer the window can still show the picture from before a switch for a while.
    const edgeUntil = async (wanted) => {
      const end = Date.now() + 3000;
      for (;;) {
        const edge = await panelEdge(await windowPicture(), stage);
        if (edge.perCssPixel < 2 || wanted(edge) || Date.now() > end) return edge;
        await sleep(150);
      }
    };

    // Every frame the window paints from here until after the pause is kept (the protocol's
    // screencast), for the check further down.
    await browser.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });

    // Right after Play the stage keeps the exact frame until the smaller picture is ready: in no
    // display frame is the full-resolution live picture drawn (at this size it took about half a
    // second a frame, so the stage stood still). Checked once a display frame from the key press.
    await browser.evaluate(`(() => {
      window.startFrames = [];
      const began = performance.now();
      const tick = (now) => {
        const pictures = [...document.querySelectorAll(".stage-live .live-picture")];
        const enlarged = pictures.some((item) => item.style.transform.startsWith("scale("));
        window.startFrames.push({ at: Math.round(now - began), full: pictures.some((item) => !item.classList.contains("live-layer")), held: !!document.querySelector(".stage img.holding"), enlarged });
        if (!enlarged && now - began < 5000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // Until the pause: the display frames in which the full-resolution picture draws the rays.
      window.fullRays = []; window.fullRaysStop = false;
      const watch = (now) => {
        if (document.querySelector('.stage-live .live-picture:not(.live-layer) [result="raysSum"]')) window.fullRays.push(Math.round(now - began));
        if (!window.fullRaysStop) requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    })()`);
    // Playing with rays: its own layer, drawn at 1280×720 and enlarged to fill the stage.
    const playedAt = Date.now();
    await browser.key(" ");
    const reduced = await browser.waitFor(reducedNow, { what: "the live picture drawn smaller and enlarged" });
    // The page's own record is made once a display frame, so this check can see the enlarged
    // picture before the record has its frame: wait for that frame (it is the record's last).
    await browser.waitFor("window.startFrames.at(-1)?.enlarged === true", { what: "the display frame that drew the smaller picture, in the page's record" });
    const startFrames = await browser.evaluate("window.startFrames");
    t.diagnostic(`display frames from Play to the smaller picture: ${JSON.stringify(startFrames)}`);
    assert.deepEqual(startFrames.filter((frame) => frame.full), [], "no full-resolution live picture right after Play");
    assert.ok(startFrames.some((frame) => frame.held), `the exact frame stays while the smaller picture gets ready: ${JSON.stringify(startFrames)}`);
    assert.ok(startFrames.at(-1).enlarged, `the smaller picture shows: ${JSON.stringify(startFrames.at(-1))}`);
    const scale = Number(reduced.transform.match(/scale\(([\d.]+)/)[1]);
    assert.equal(reduced.willChange, "transform");
    assert.ok(Math.abs(reduced.width - stage.width) < 1 && Math.abs(reduced.height - stage.height) < 1, `the enlarged picture fills the stage: ${reduced.width}×${reduced.height}`);
    assert.ok(Math.abs(reduced.layoutWidth * 2 - 1280) <= 2, `laid out ${reduced.layoutWidth} CSS pixels wide, 1280 device pixels`);
    assert.ok(Math.abs(scale - (stage.width * 2) / 1280) < 0.01, `enlarged ${scale} times`);
    assert.equal(reduced.transition, "0s", "nothing slides: the picture is enlarged in one step");
    const drawn = (await browser.evaluate(`${q(".stage-label")}.title`)).match(/drawn at (\d+)×(\d+) while playing \(light rays\)/);
    assert.ok(drawn, `the label's tooltip says so: ${await browser.evaluate(`${q(".stage-label")}.title`)}`);
    assert.ok(Math.abs(Number(drawn[1]) - 1280) <= 1 && Math.abs(Number(drawn[2]) - 720) <= 1, drawn[0]);
    // That size and the measured rate are on screen in the stage's header row, whole (not cut off
    // with "…"); the tooltip says why the picture is drawn smaller.
    const facts = await browser.evaluate(`(() => { const element = ${q(".stage-label")}; const box = element.getBoundingClientRect(); const row = element.closest(".pane").getBoundingClientRect(); return { text: [...element.children].map((fact) => fact.innerText).join(" · "), title: element.title, cut: element.scrollWidth > element.clientWidth + 1, inRow: box.width > 0 && box.left >= row.left && box.right <= row.right }; })()`);
    assert.match(facts.text, /^live · (\d+|…)\/30fps · drawn at \d+×\d+ · rev \d+/);
    assert.ok(!facts.cut && facts.inRow, `the stage's facts fit their row: ${JSON.stringify(facts)}`);
    assert.match(facts.title, /^live · (\d+|…)\/30fps · drawn at \d+×\d+ while playing \(light rays\) · rev \d+/);
    while ((await sceneTime()) < 1) await sleep(50);
    const soft = await edgeUntil((edge) => edge.mean >= 2);
    await browser.shot("light-rays-playing-reduced");

    // While it plays, the agent turns the rays off and on twice, then the window is resized six
    // times.
    let sharp;
    for (let round = 0; round < 2; round++) {
      await turnRays(false);
      await browser.waitFor(fullNow, { what: "the full-resolution live picture without rays" });
      await sleep(150);
      if (round === 0) {
        sharp = await edgeUntil((edge) => edge.mean <= 1.2);
        await browser.shot("light-rays-off-playing-sharp");
      }
      await turnRays(true);
      await browser.waitFor(reducedNow, { what: "the live picture drawn smaller again" });
      await sleep(150);
    }
    const softAgain = await edgeUntil((edge) => edge.mean >= 2);
    for (let step = 0; step < 6; step++) {
      await size(step % 2 ? 900 : 720);
      await sleep(120);
    }
    await size(900);
    await browser.waitFor(`(() => { const box = ${stageBox}; return box.viewportHeight === 900 && Math.abs(box.height - ${stage.height}) < 1; })()`, { what: "the stage back at its size in the 900-high window" });
    await browser.waitFor(reducedNow, { what: "the live picture drawn smaller after the resizes" });
    await sleep(200);
    // The scene time follows the computer's clock (the scene has no sound), so a scene that ran past
    // its end shows a small time again; the time since Play tells.
    const ended = await sceneTime();
    const sincePlay = (Date.now() - playedAt) / 1000;
    assert.ok(sincePlay < RAYS_SECONDS - 0.5 && ended < RAYS_SECONDS - 0.5 && (await browser.evaluate(isPlaying)),
      `still playing the first time through: ${sincePlay.toFixed(1)} s after Play, at ${ended} s in the scene`);

    // A pause shows the exact frame from the server at the full 1920 width, as before.
    await browser.key(" ");
    await browser.waitFor(`${isPaused}`, { what: "paused" });
    const frame = await browser.waitFor(exactFrame, { what: "the exact frame" });
    assert.equal(frame.naturalWidth, 1920);
    assert.notEqual(frame.src, exact.src, "the exact frame of the paused time");
    assert.match(await browser.evaluate(shownFacts), /^1920×1080 · 30fps · draft · rev \d+$/);
    assert.match(await browser.evaluate(`${q(".stage-label")}.title`), /^preview 1920×1080 · 30fps · draft · rev \d+ · exact frame$/);
    // When the agent turned the rays back on, the full-resolution picture kept its last drawing
    // until the smaller one was ready: drawn with the rays it took seconds a frame on Linux CI.
    assert.deepEqual(await browser.evaluate("(() => { window.fullRaysStop = true; return window.fullRays; })()"), [], "the full-resolution picture never draws the rays");
    await sleep(200);
    await browser.send("Page.stopScreencast");

    // Every painted frame shows the scene filling the stage (never the small drawing before it is
    // enlarged), and the marker never moves back: the stage never went back to the exact frame
    // from before the play or to any other older picture, from the play to the pause.
    const frames = [];
    for (const { data } of painted) frames.push(await raysFrame(Buffer.from(data, "base64"), [stage, shorter, growing]));
    const markers = frames.map((item) => item.markerX ?? null);
    // Pairs (earlier, later) in arrival order whose drawn times agree; a frame is checked against
    // the frames before it in such pairs.
    const drawnBefore = (earlier, later) => painted[earlier].drawnAt < painted[later].drawnAt;
    const pairs = (frames.length * (frames.length - 1)) / 2;
    let agreed = 0;
    for (let later = 1; later < frames.length; later += 1) for (let earlier = 0; earlier < later; earlier += 1) if (drawnBefore(earlier, later)) agreed += 1;
    t.diagnostic(`${frames.length} painted frames from the play to the pause, ${agreed} of ${pairs} pairs in the same order by arrival and by drawn time; marker at x ${markers.join(" ")}`);
    if (frames.length) {
      assert.ok(frames.length >= 30, `the screencast saw ${frames.length} frames`);
      // Without drawn times, or with times that disagree with the arrival order for many frames,
      // the check below would compare little; measured, 97 to 100 in 100 pairs agree (on a Mac and
      // under xvfb on Linux).
      assert.ok(agreed >= 0.8 * pairs, `the arrival order and the drawn times agree for ${agreed} of ${pairs} pairs of frames`);
      const wrong = frames.map((item, index) => ({ index, ...item })).filter((item, index) =>
        !item.filled || frames.slice(0, index).some((earlier, before) => drawnBefore(before, index) && earlier.markerX > item.markerX + 3));
      assert.deepEqual(wrong, [], `every frame fills the stage and is no older than the ones before it: ${JSON.stringify(frames)}`);
      assert.ok(Math.max(...markers) > markerAt(1.5), `the frames show the scene playing: ${markers.join(" ")}`);
    } else {
      t.diagnostic("the screencast painted no frames in this window, so the frame check says nothing here");
    }

    t.diagnostic(`panel edge, pixels between ground and panel per row: ${soft.mean} with rays (drawn at ${drawn[1]}×${drawn[2]}), ${sharp.mean} without, ${softAgain.mean} with the rays back on; the window picture has ${soft.perCssPixel} pixels per CSS pixel`);
    for (const row of [...soft.rows, ...sharp.rows, ...softAgain.rows]) assert.ok(row.low < 16 && row.high > 110, `measured across the panel's edge: ${JSON.stringify(row)}`);
    if (soft.perCssPixel >= 2) {
      assert.ok(sharp.mean <= 1.2, `sharp without rays: ${JSON.stringify(sharp.rows)}`);
      assert.ok(soft.mean >= 2, `softer with rays, so it really was drawn smaller: ${JSON.stringify(soft.rows)}`);
      assert.ok(softAgain.mean >= 2, `softer with the rays back on: ${JSON.stringify(softAgain.rows)}`);
    } else {
      t.diagnostic(`the window picture is ${soft.perCssPixel}× (not the emulated 2×), so the edge widths say nothing here`);
    }

    // A narrower window while playing: in the display frame where the stage gets smaller, the
    // enlarged picture already has the stage's new size, so no frame shows the old picture cut
    // to the smaller box. A second ResizeObserver, made after the stage's own, runs after it in
    // the same frame, before that frame is painted, and compares the two.
    await browser.key(" ");
    await browser.waitFor(reducedNow, { what: "the live picture drawn smaller, for the narrower window" });
    await browser.evaluate(`(() => {
      window.stageFits = [];
      window.stageWatch = new ResizeObserver(() => {
        const stage = ${q(".stage")}.getBoundingClientRect();
        const picture = [...document.querySelectorAll(".stage-live .live-picture")].find((item) => item.style.transform.startsWith("scale("))?.getBoundingClientRect();
        window.stageFits.push({ stage: [Math.round(stage.width), Math.round(stage.height)], picture: picture ? [Math.round(picture.width), Math.round(picture.height)] : null });
      });
      window.stageWatch.observe(${q(".stage-wrap")});
    })()`);
    // After each width, wait until the stage has a new width and the observer has recorded it: on 2
    // cores a fixed 250 ms sometimes passed before the stage changed, so a width was never drawn.
    let stageWidth = await browser.evaluate(`Math.round(${q(".stage")}.getBoundingClientRect().width)`);
    for (const width of [1240, 1440, 1100, 1440]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false });
      stageWidth = await browser.waitFor(`(() => { const now = Math.round(${q(".stage")}.getBoundingClientRect().width); return innerWidth === ${width} && now !== ${stageWidth} && window.stageFits.at(-1)?.stage[0] === now ? now : null; })()`, { what: `the stage drawn at a new size in the ${width}-wide window` });
    }
    const fits = await browser.evaluate(`(() => { window.stageWatch.disconnect(); return window.stageFits; })()`);
    t.diagnostic(`stage and enlarged picture in each resize: ${JSON.stringify(fits)}`);
    assert.ok(new Set(fits.map((fit) => fit.stage[0])).size >= 3, `the stage changed size: ${JSON.stringify(fits)}`);
    const misfits = fits.filter((fit) => fit.picture && (Math.abs(fit.picture[0] - fit.stage[0]) > 1 || Math.abs(fit.picture[1] - fit.stage[1]) > 1));
    assert.deepEqual(misfits, [], `the picture has the stage's size in the same frame: ${JSON.stringify(fits)}`);
    await browser.key(" ");
    await browser.waitFor(`${isPaused}`, { what: "paused after the narrower window" });
    await browser.waitFor(exactFrame, { what: "the exact frame after the narrower window" });

    // Under reduced motion it is the same: drawn smaller while playing, in one step.
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    try {
      await browser.key(" ");
      const calm = await browser.waitFor(reducedNow, { what: "the reduced live picture under reduced motion" });
      assert.equal(calm.transition, "0s");
      await browser.key(" ");
      assert.equal((await browser.waitFor(exactFrame, { what: "the exact frame under reduced motion" })).naturalWidth, 1920);
    } finally {
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    }
  } finally {
    browser.listeners.delete(keepFrame);
    await browser.send("Page.stopScreencast").catch(() => {});
    await browser.key("_").catch(() => {});
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await agent("project", { action: "open", id: "orbit" });
  }
});

test("light rays in a scene with a video: when the smaller picture takes over and when it hands back, the video on screen always has a picture", { skip: skipWithoutMediaTools }, async (t) => {
  const clipFile = path.join(folder, "rays-clip.mp4");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=7", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "15", "-an", clipFile]);
  const uploaded = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "rays-clip.mp4" }, body: await readFile(clipFile) });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const src = (await uploaded.json()).src;
  const made = await agent("project", { action: "create", id: "raysclip", name: "Rays clip", width: 1920, height: 1080, duration: 9 });
  assert.equal(made.isError, undefined, made.text);
  // Rays from 1.5 s to 6 s over a black ground with a sun, and a video above them. Linux CI draws
  // on the CPU and took up to 3.7 s to make the first smaller picture, so shorter rays showed none.
  const edited = await agent("edit", { project: "raysclip", ops: [
    { op: "add_layer", layerType: "rectangle", name: "ground", properties: { x: 0, y: 0, width: 1920, height: 1080, fill: "#000000", radius: 0 } },
    { op: "add_layer", layerType: "ellipse", name: "sun", properties: { x: 1560, y: 80, width: 200, height: 200, fill: "#ffffff" } },
    { op: "group_layers", layers: ["ground", "sun"], name: "footage", groupId: "footage" },
    { op: "add_animation", layer: "footage", effect: "light-rays", start: 1.5, duration: 4.5, parameters: { centerX: 0.86, centerY: 0.17, length: 0.3, threshold: 0.65 } },
    { op: "add_layer", layerType: "video", name: "clip", properties: { src, x: 640, y: 300, width: 640, height: 360, mediaSourceDuration: 7 } },
  ] });
  assert.equal(edited.isError, undefined, edited.text);
  // A 2× screen with the stage zoomed, so the rays play on the smaller picture, as in the test above.
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  try {
    await open();
    await browser.waitFor(`${onProject("raysclip")}`, { what: "the rays clip project on the stage" });
    await browser.key("1");
    await browser.key("+");
    await browser.waitFor(`!!document.querySelector('.pane.is-zoomed[data-pane="1"]')`, { what: "the stage zoomed" });
    await browser.waitFor(`(() => { const image = ${q(".stage img")}; return !!(image?.complete && image.naturalWidth) && new URL(image.src, location.href).searchParams.get("w") === "1920"; })()`, { what: "the 1920-wide exact frame" });
    // Once a display frame from Play: which live picture is on top (the smaller one when it is
    // enlarged, else the full-resolution one), whether the paused frame still covers it, and its
    // videos: "never" counts a video that has not had a picture yet (it draws nothing: black).
    // "fullRays": the full-resolution picture draws the rays, also in its filter pre-draw.
    await browser.evaluate(`(() => {
      window.handFrames = []; window.handStop = false;
      const had = new WeakSet();
      const began = performance.now();
      const tick = (now) => {
        for (const video of document.querySelectorAll(".stage-live video")) if (video.readyState >= 2) had.add(video);
        const shown = [...document.querySelectorAll(".stage-live .live-picture")].filter((item) => !item.classList.contains("live-layer") || item.style.transform.startsWith("scale("));
        const top = shown.at(-1);
        const videos = top ? [...top.querySelectorAll("video")] : [];
        window.handFrames.push({ at: Math.round(now - began), time: ${playText}.slice(0, 8), kind: !top ? "none" : top.classList.contains("live-layer") ? "smaller" : "full", both: shown.length > 1,
          held: !!document.querySelector(".stage img.holding"), never: videos.filter((video) => !had.has(video) && video.readyState < 2).length, seeking: videos.filter((video) => video.seeking).length,
          fullRays: !!document.querySelector('.stage-live .live-picture:not(.live-layer) [result="raysSum"]') });
        if (!window.handStop && now - began < 10_000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
    await browser.key(" ");
    await browser.waitFor(isPlaying, { what: "playing" });
    await browser.waitFor(`(() => { const found = ${playText}.match(/^(\\d\\d):(\\d\\d\\.\\d\\d)\\//); return !!found && Number(found[1]) * 60 + Number(found[2]) >= 8.5; })()`, { what: "the scene played past the rays, to 8.5 s" });
    await browser.key(" ");
    await browser.waitFor(isPaused, { what: "paused" });
    const frames = (await browser.evaluate("(() => { window.handStop = true; return window.handFrames; })()")).filter((frame) => frame.kind !== "none");
    const shownFrames = frames.filter((frame) => !frame.held);
    const seconds = (frame) => Number(frame.time.slice(0, 2)) * 60 + Number(frame.time.slice(3, 8));
    // From 1 s, half a second before the rays: the start of play is the test of a video in a
    // playing scene above.
    const black = shownFrames.filter((frame) => frame.never > 0 && seconds(frame) >= 1);
    const smaller = shownFrames.filter((frame) => frame.kind === "smaller");
    const fullAfter = shownFrames.filter((frame) => frame.kind === "full" && seconds(frame) >= 6);
    const handover = shownFrames.filter((frame) => frame.kind === "smaller" && frame.both && seconds(frame) >= 5.9);
    t.diagnostic(`${frames.length} display frames; held ${frames.length - shownFrames.length}; smaller picture ${smaller.length} (${smaller[0]?.time} to ${smaller.at(-1)?.time}); handover frames with both pictures ${handover.length}; frames whose video on top was seeking ${shownFrames.filter((frame) => frame.seeking).length} (${shownFrames.filter((frame) => frame.seeking).map((frame) => `${frame.kind} at ${frame.time}`).join(", ") || "none"})`);
    // Linux CI draws on the CPU and shows only about 10 frames in these 5 s: ask for 5 of each
    // picture where the page drew enough frames, else at least one.
    const enough = Math.min(5, Math.max(1, Math.floor(shownFrames.length / 4)));
    // A page that drew under 20 frames (CI's CPU took up to 5 s to make the first smaller
    // picture) only has to show it once, even at the hand-back.
    const slow = shownFrames.length < 20;
    assert.ok(smaller.length >= enough && (slow || seconds(smaller[0]) < 6), `the smaller picture showed while the rays did: ${JSON.stringify(smaller.slice(0, 3))}`);
    // CI draws only a few frames a second on the CPU: one full frame after the rays proves the hand-back.
    // A page under 20 frames may reach 8.5 s before it draws again: the black-frame check below still holds.
    assert.ok(slow || fullAfter.length >= 1, "the full-resolution picture showed again after the rays");
    // Before, the full-resolution picture was made again when the rays ended, with a new video
    // that had no picture for its first frame: one black frame of the video.
    assert.deepEqual(black, [], "no shown frame has a video without a picture on top");
    // The smaller picture draws the rays, so the full-resolution one never does, not even to
    // pre-draw their filter: on Linux CI that one frame took seconds, and the stage stood still.
    assert.deepEqual(frames.filter((frame) => frame.fullRays), [], "the full-resolution picture never draws the rays");
  } finally {
    await browser.key("_").catch(() => {});
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await agent("project", { action: "open", id: "orbit" });
  }
});

test("light rays playing in a 1440 to 1512 px window: the stage's facts give way before its title, so the scene menu stays whole and clickable; the drawing note is short and its whole sentence is in the tooltip and the stage's name; Tab to the scene menu draws it; Play does not change the pane's classes", async (t) => {
  const made = await agent("project", { action: "create", id: "rays-laptop", name: "Rays laptop", width: 1920, height: 1080, duration: 20 });
  assert.equal(made.isError, undefined, made.text);
  const edited = await agent("edit", { project: "rays-laptop", ops: [
    { op: "add_layer", layerType: "rectangle", name: "ground", properties: { x: 0, y: 0, width: 1920, height: 1080, fill: "#000000", radius: 0 } },
    { op: "add_layer", layerType: "ellipse", name: "sun", properties: { x: 1560, y: 80, width: 200, height: 200, fill: "#ffffff" } },
    { op: "group_layers", layers: ["ground", "sun"], name: "footage", groupId: "footage" },
    { op: "add_animation", layer: "footage", effect: "light-rays", start: 0, duration: 20, parameters: { centerX: 0.86, centerY: 0.17, length: 0.3, threshold: 0.65 } },
    { op: "add_scene", name: "outro", width: 1920, height: 1080, duration: 5, background: "#0b1020" },
  ] });
  assert.equal(edited.isError, undefined, edited.text);
  const [raysScene] = (await (await server.api("/api/dashboard/snapshot?project=rays-laptop")).json()).record.document.scenes;
  // The stage's toolbar row as drawn (the scene menu, the facts, the zoom and full-window buttons):
  // where the scene menu is inside the row (`left` and `right` from the row's start), whether it
  // shows its whole name and a click at its middle reaches it, the facts beside it, and the
  // pane's title (a clock, with no scene name: the menu names the scene).
  const header = `(() => {
    const h2 = ${q("#pane-1-title")};
    const line = ${q(".p-stage .stage-toolbar")};
    const menu = ${q("#scene-menu")};
    const label = ${q(".stage-label")};
    const inside = line.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      title: h2.innerText, left: Math.round(box.left - inside.left), right: Math.round(box.right - inside.left), width: Math.round(inside.width),
      menuWhole: menu.scrollWidth <= menu.clientWidth + 1, clickable: menu.contains(hit), lineScroll: line.scrollLeft,
      // The facts are separate pieces now; joined here as the tooltip joins them.
      text: [...label.children].map((fact) => fact.innerText).join(" · "), tooltip: label.title, stageName: ${q(".stage")}.getAttribute("aria-label"),
      factsCut: label.scrollWidth > label.clientWidth + 1, paneClass: h2.closest("section").className,
    };
  })()`;
  // The menu is drawn whole inside the row, and a click reaches it; the facts give way first.
  const menuDrawn = (row) => row.left >= 0 && row.right <= row.width && row.menuWhole && row.clickable;
  try {
    for (const [width, height] of [[1440, 900], [1470, 956], [1512, 982], [1100, 760]]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
      await open();
      await browser.waitFor(`${onProject("rays-laptop")}`, { what: "the rays-laptop project on the stage" });
      if (!(await browser.evaluate(sceneShown(raysScene.name)))) await showScene(raysScene);
      await browser.key("1");
      await browser.waitFor(`document.activeElement?.dataset?.pane === "1"`, { what: "pane 1" });
      const paused = await browser.evaluate(header);
      assert.ok(menuDrawn(paused), `paused, the scene menu is whole at ${width}×${height}: ${JSON.stringify(paused)}`);
      // At 1440 to 1512 the stage has more than 1280×720 device pixels, so the rays are drawn smaller.
      const reduced = width >= 1440;
      await browser.key(" ");
      const playing = await browser.waitFor(`(() => { const now = ${header}; return ${isPlaying} && now.text.startsWith("live · ") && ${reduced ? `now.text.includes("drawn at")` : "true"} ? now : null; })()`, { what: `playing at ${width}×${height}` });
      const said = `at ${width}×${height}: ${JSON.stringify(playing)}`;
      t.diagnostic(`playing ${said}`);
      assert.ok(menuDrawn(playing), `playing, the scene menu is whole and a click reaches it ${said}`);
      assert.equal(playing.title, "stage", `the title reads "stage" ${said}`);
      assert.equal(playing.paneClass, paused.paneClass, `Play does not change the stage pane's classes ${said}`);
      if (reduced) {
        // The note on screen is short; the tooltip and the stage's name say it all.
        assert.match(playing.text, /^live · (\d+|…)\/30fps · drawn at 1280×720 · rev \d+/, said);
        assert.ok(!playing.text.includes("while playing"), said);
        assert.match(playing.tooltip, /^live · (\d+|…)\/30fps · drawn at 1280×720 while playing \(light rays\) · rev \d+/, said);
        assert.ok(playing.stageName.includes("drawn at 1280×720 while playing (light rays)"), said);
      }
      // Tab from the pane goes to the scene menu, and it is drawn whole there; the row does not
      // scroll to it.
      await browser.key("Tab");
      await browser.waitFor(`document.activeElement?.id === "scene-menu"`, { what: `Tab to the scene menu at ${width}×${height}` });
      const focused = await browser.evaluate(header);
      assert.ok(menuDrawn(focused) && focused.lineScroll === 0, `the focused scene menu is drawn ${said} → ${JSON.stringify(focused)}`);
      await browser.key("Tab");
      await browser.waitFor(`document.activeElement?.id !== "scene-menu"`, { what: "Tab on from the scene menu" });
      assert.equal((await browser.evaluate(header)).lineScroll, 0, "the row stays at its start");
      // Space on the pane (not on the button that has the focus now) pauses.
      await browser.key("1");
      await browser.waitFor(`document.activeElement?.dataset?.pane === "1"`, { what: "pane 1 again" });
      await browser.key(" ");
      await browser.waitFor(`${isPaused}`, { what: "paused" });
    }
  } finally {
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await agent("project", { action: "open", id: "orbit" });
  }
});

test("more lanes than fit: the timeline ends on a whole lane and shows its scroll bar; the checks tab: only the mark has a colour, a fix in plain words, a long line ends in … and opens, a note wraps", async () => {
  const made = await agent("project", { action: "create", id: "lanes", name: "Lanes", width: 640, height: 360, duration: 4 });
  assert.equal(made.isError, undefined, made.text);
  const ops = [];
  for (let index = 1; index <= 24; index++) ops.push({ op: "add_layer", layerType: "rectangle", name: `box ${index}`, properties: { x: 10 + index * 24, y: 300, width: 16, height: 16, fill: "#808080", radius: 0 } });
  // White text on a white plate (an error, with an edit as its fix) that fades in at once (a warning).
  ops.push({ op: "add_layer", layerType: "rectangle", name: "plate", properties: { x: 100, y: 80, width: 440, height: 160, fill: "#ffffff", radius: 0 } });
  ops.push({ op: "add_layer", layerType: "text", name: "title", properties: { text: "Same as the plate", x: 120, y: 120, width: 400, height: 60, fontSize: 40, fill: "#ffffff" } });
  ops.push({ op: "add_animation", layer: "title", preset: "fade", start: 0, duration: 2 });
  const edited = await agent("edit", { project: "lanes", ops });
  assert.equal(edited.isError, undefined, edited.text);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    await open();
    await browser.waitFor(`${onProject("lanes")}`, { what: "the lanes project on the stage" });
    await openEveryLane();

    // The lanes box ends on a lane's lower edge (below the head rows, --tl-head: the ruler, story,
    // shots, voice, audio and agent lanes; a layer lane is 14.6 px), so no lane is cut in half,
    // and the scroll bar is drawn, so it is plain there are more.
    const lanes = `(() => {
      const box = ${q(".p-timeline .tl-scroll")};
      const bottom = box.getBoundingClientRect().top + box.clientHeight;
      const head = parseFloat(getComputedStyle(box).getPropertyValue("--tl-head")) || 0;
      const cut = [...box.querySelectorAll(".tl-content .track")].map((track) => track.getBoundingClientRect()).filter((lane) => lane.top < bottom - 0.5 && lane.bottom > bottom + 0.5).length;
      return { client: box.clientHeight, scroll: box.scrollHeight, barRight: box.offsetWidth - box.clientWidth, barBottom: box.offsetHeight - box.clientHeight, cut, head, lanes: (box.clientHeight - head) / 14.6 };
    })()`;
    const fit = await browser.evaluate(lanes);
    assert.ok(fit.scroll > fit.client + 14, `more lanes than fit: ${JSON.stringify(fit)}`);
    assert.equal(fit.cut, 0, `no lane cut in half: ${JSON.stringify(fit)}`);
    assert.ok(Math.abs(fit.lanes - Math.round(fit.lanes)) < 0.1, `whole lanes: ${JSON.stringify(fit)}`);
    assert.ok(fit.barRight >= 6, `the scroll bar is drawn and takes room: ${JSON.stringify(fit)}`);
    // Scrolled to the last layer, the agent's lane is still in view (pinned under the ruler), and
    // the agent pane says nothing for a why and a next the agent did not say.
    const pinned = await browser.evaluate(`(() => {
      const box = ${q(".p-timeline .tl-scroll")};
      box.scrollTop = box.scrollHeight;
      const top = box.getBoundingClientRect().top, bottom = top + box.clientHeight;
      const inView = (element) => { const rect = element?.getBoundingClientRect(); return !!rect && rect.top >= top - 0.5 && rect.bottom <= bottom + 0.5; };
      return { scrolled: box.scrollTop, lane: inView(${q(".p-timeline .lane-agent")}), label: inView(${q(".p-timeline .agent-lane-label")}),
        said: !!document.querySelector(".p-agent .agent-said"), notSaid: (document.querySelector(".p-agent")?.innerText ?? "").includes("not said") };
    })()`);
    assert.ok(pinned.scrolled > 0 && pinned.lane && pinned.label, `the agent's lane stays in view: ${JSON.stringify(pinned)}`);
    assert.deepEqual([pinned.said, pinned.notSaid], [false, false], "no why and next rows when the agent said neither");
    await browser.evaluate(`${q(".p-timeline .tl-scroll")}.scrollTop = 0`);
    // With a layer picked, its values show under the lanes: the lanes box gets shorter and still
    // ends on a whole lane, and the values sit below it, inside the pane.
    const boxLabel = `[...document.querySelectorAll(".p-timeline .tl-label")].find((item) => item.textContent.trim() === "box 3")`;
    await browser.click(boxLabel);
    const picked = await browser.waitFor(`(() => {
      const values = ${q(".layer-values")};
      if (!values) return null;
      const now = ${lanes};
      const box = ${q(".p-timeline .tl-scroll")}.getBoundingClientRect(), body = ${q(".p-timeline .pane-body")}.getBoundingClientRect(), shown = values.getBoundingClientRect();
      return { ...now, valuesTop: shown.top, valuesBottom: shown.bottom, valuesHeight: shown.height, boxBottom: box.bottom, bodyBottom: body.bottom };
    })()`, { what: "the picked layer's values" });
    assert.ok(picked.client < fit.client, `the lanes box made room for the values: ${JSON.stringify(picked)}`);
    assert.equal(picked.cut, 0, `no lane cut in half with a layer picked: ${JSON.stringify(picked)}`);
    assert.ok(Math.abs(picked.lanes - Math.round(picked.lanes)) < 0.1 && picked.lanes >= 2, `whole lanes with a layer picked: ${JSON.stringify(picked)}`);
    assert.ok(picked.valuesHeight > 10 && picked.valuesTop >= picked.boxBottom - 0.5 && picked.valuesBottom <= picked.bodyBottom + 0.5, `the values below the lanes, inside the pane: ${JSON.stringify(picked)}`);
    await browser.click(boxLabel);
    await browser.waitFor(`!${q(".layer-values")}`, { what: "the layer let go" });
    // Zoomed in, the sideways scroll bar is drawn too, and the lanes still end on a whole lane.
    await browser.click(q("#timeline-zoom"));
    await browser.click(menuItem("8×"));
    await browser.waitFor(`${textOf("#timeline-zoom")}.trim() === "8×"`, { what: "the timeline at 8×" });
    const zoomed = await browser.waitFor(`(() => { const now = ${lanes}; return now.barBottom >= 6 ? now : null; })()`, { what: "the sideways scroll bar" });
    assert.equal(zoomed.cut, 0, `no lane cut in half at 8×: ${JSON.stringify(zoomed)}`);
    assert.ok(Math.abs(zoomed.lanes - Math.round(zoomed.lanes)) < 0.1 && zoomed.barRight >= 6, `whole lanes and both scroll bars at 8×: ${JSON.stringify(zoomed)}`);
    await browser.click(q("#timeline-zoom"));
    await browser.click(menuItem("fit"));
    await browser.waitFor(`${textOf("#timeline-zoom")}.trim() === "fit"`);

    // The checks tab: one line a finding. Only the mark is red (error) or orange (warning); the
    // rule, the layer, the time and the message are plain text, the fix is words, not JSON.
    await showView("checks", { focus: false });
    await browser.waitFor(`document.querySelectorAll("#panel-checks .check-row .check-mark.err").length >= 1 && document.querySelectorAll("#panel-checks .check-row .check-mark.warn").length >= 1`, { what: "an error and a warning in the checks tab" });
    assert.match(await browser.evaluate(textOf(".check-summary")), /^Rev \d+: \d+ errors?, \d+ warnings?/);
    const rows = await browser.evaluate(`(() => {
      const colour = (element) => getComputedStyle(element).color;
      const grey = (value) => { const [r, g, b] = value.match(/\\d+/g).map(Number); return Math.max(r, g, b) - Math.min(r, g, b) <= 24; };
      return [...document.querySelectorAll("#panel-checks .check-row")].map((row) => ({
        text: row.querySelector(".check-text").textContent, message_text: row.querySelector(".check-line").textContent, title: row.title, expanded: row.getAttribute("aria-expanded"), word: row.querySelector(".sr-only").textContent,
        what: row.querySelector(".check-what")?.textContent.trim() ?? "", fix: row.querySelector(".check-fix")?.textContent.replace(/^fix: /, "") ?? "",
        time: row.querySelector(".check-at").textContent, shown: row.querySelector(".check-text").innerText,
        kind: row.querySelector(".check-mark").classList.contains("err") ? "error" : "warning", mark: colour(row.querySelector(".check-mark")), drawn: row.querySelector(".check-mark").matches("svg") || !!row.querySelector(".check-mark svg"),
        message: colour(row.querySelector(".check-line")), coloured: [...row.querySelectorAll(".check-text, .check-text *")].map(colour).filter((value) => !grey(value)),
        cut: [...row.querySelectorAll(".check-line")].some((line) => line.scrollWidth > line.clientWidth + 1 && getComputedStyle(line).textOverflow === "ellipsis"),
      }));
    })()`);
    // The error mark is the recording red (--rec) now, no longer --err.
    const [error, accent, text] = [await browser.evaluate(token("--rec")), await browser.evaluate(token("--accent")), await browser.evaluate(token("--fg0"))];
    for (const row of rows) {
      assert.equal(row.mark, row.kind === "error" ? error : accent, `the mark's colour: ${JSON.stringify(row)}`);
      assert.ok(row.drawn, "the mark is drawn");
      assert.equal(row.word, `${row.kind}: `, "a screen reader says error or warning");
      assert.equal(row.message, text, `the message is normal text: ${JSON.stringify(row)}`);
      assert.deepEqual(row.coloured, [], `nothing but the mark has a colour: ${JSON.stringify(row)}`);
      assert.doesNotMatch(row.text, /[{}]/, `no JSON on screen: ${row.text}`);
      assert.doesNotMatch(row.fix, /["[\]]/, `the fix in words: ${row.text}`);
      assert.match(row.time, /^(\d\d:\d\d\.\d\d)?$/, "the time as a clock, not @7.87s");
      // Closed, a row shows the time, the mark and the message only: the rule, the layer and the fix wait for a click.
      assert.equal(row.shown.trim(), row.message_text.trim(), `a closed row shows only its message: ${JSON.stringify(row.shown)}`);
    }
    const contrast = rows.find((row) => row.what.startsWith("contrast title"));
    assert.ok(contrast, rows.map((row) => row.what).join("\n"));
    assert.match(contrast.fix, /^update_layer title · fill #[0-9a-f]{6} \(auto\)$/);
    // A long line ends in "…"; its tooltip has all of it, and a click opens it to full length.
    const long = rows.findIndex((row) => row.cut);
    assert.ok(long >= 0, `a line long enough to be cut: ${rows.map((row) => row.text).join(" | ")}`);
    assert.match(rows[long].title, /^(error|warning) \S+/);
    const row = `document.querySelectorAll("#panel-checks .check-row")[${long}]`;
    await browser.click(row);
    await browser.waitFor(`${row}.getAttribute("aria-expanded") === "true" && [...${row}.querySelectorAll(".check-line")].every((line) => line.scrollWidth <= line.clientWidth + 1)`, { what: "the long line opened" });
    const opened = await browser.evaluate(`${row}.innerText.replace(/\\s+/g, " ")`);
    assert.ok(rows[long].title.split("\n")[0].split(": ").slice(1).join(": ").split(" ").every((word) => opened.includes(word)), `the opened line says all the tooltip says: ${opened}`);
    // Enter on the focused line closes it again.
    await browser.evaluate(`${row}.focus()`);
    await browser.key("Enter");
    await browser.waitFor(`${row}.getAttribute("aria-expanded") === "false"`, { what: "the line closed by Enter" });
    // A note (why a check did not run, and how to turn it on) is never cut: it wraps onto more
    // lines inside the tab, so all of it can be read without a mouse. Before, it ended in "…" and
    // only its tooltip had the rest.
    const notes = await browser.evaluate(`(() => {
      const panel = ${q("#panel-checks")}.getBoundingClientRect();
      return [...document.querySelectorAll("#panel-checks .check-note")].map((note) => {
        const box = note.getBoundingClientRect();
        return { text: note.innerText, cut: note.scrollWidth > note.clientWidth + 1, ellipsis: getComputedStyle(note).textOverflow === "ellipsis", lines: Math.round(box.height / parseFloat(getComputedStyle(note).lineHeight)), inside: box.left >= panel.left - 0.5 && box.right <= panel.right + 0.5 };
      });
    })()`);
    assert.ok(notes.length >= 1, "the checks tab has a note (this project sets no video type)");
    assert.ok(notes.some((note) => note.lines >= 2), `a note long enough to need more than one line: ${JSON.stringify(notes)}`);
    for (const note of notes) {
      assert.match(note.text, /^\S/);
      assert.doesNotMatch(note.text, /^note: /, "a check note has no note: prefix");
      assert.ok(!note.cut && !note.ellipsis && note.inside, `the whole note shows, wrapped inside the tab: ${JSON.stringify(note)}`);
    }
    await browser.shot("checks-tab");
  } finally {
    // The log tab exists only once the log was opened; a click on a missing tab waited 15 s for it.
    if (await browser.evaluate(`!!${q("#tab-log")}`).catch(() => false)) await browser.click(q("#tab-log")).catch(() => {});
    await agent("project", { action: "open", id: "orbit" });
  }
});

// ---- stops: the stop card and the stop settings (direction plan milestone B2b) ---------------
//
// A stop (notes checkpoint) waits for the person. kino lists it first in "needs you", and the
// person answers on its card (a approves, Tab approves with a note, d asks for a redo with a
// note; A and D are off on stops) or in the chat, where the agent records the reply word for word
// and the card says "recorded by the agent", with a reopen button. The agent hears a dashboard
// answer or a reopen in its inbox. These tests come last, so no stop waits during the tests above.
// Their videos have no footage and a board skip-under of 3600 s, so the rough cut comes first.
// kino refuses a chat answer recorded under 5 s after the ask (too_fast), so the two chat answers
// here wait 5.2 s, timed on the steady clock as the server times them: this PC's wall clock
// (WSL 2) jumps by several seconds against it, back and forth (measured: −2.5 s to +7.6 s in 30 s).

// The B2a fixture: a 24 s 1080×1920 card with one 96 px title passes check (no errors).
const STOP_TITLE = { op: "add_layer", layerType: "text", name: "title", properties: { text: "Park reopens Saturday", x: 140, y: 760, width: 800, height: 240, fontSize: 96, fill: "#ffffff" } };
const moveTitle = (y) => ({ op: "update_layer", layer: "title", properties: { y } });
const politeText = `(document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? "")`;
const assertiveText = `(document.querySelector('[role="alert"][aria-live="assertive"]')?.textContent ?? "")`;
const topMessage = `(${q(".topline .message")}?.textContent ?? "")`;
const GO_ON = ' Tell your agent "go on": it hears your answer with its next call.';
/** The button that opens a stop's sheet from its "needs you" row, and that row. */
const stopOpen = (id) => `document.querySelector(${JSON.stringify(`#section-needs-you [aria-label^="Stop ${id}:"]`)})`;
const stopRow = (id) => `[...document.querySelectorAll("#section-needs-you .needs-you")].find((row) => row.querySelector(${JSON.stringify(`[aria-label^="Stop ${id}:"]`)}))`;
// The note on the stop card, and the words that label it (for a screen reader too).
const stopNote = q(".stop-card textarea");
const noteLabel = `(() => {
  const field = ${stopNote};
  if (!field) return null;
  const by = field.getAttribute("aria-labelledby");
  return (by ? by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : field.labels?.[0]?.textContent ?? field.getAttribute("aria-label") ?? "").replace(/\\s+/g, " ").trim();
})()`;

async function stopsOf(project) {
  return (await (await server.api(`/api/dashboard/snapshot?project=${project}`)).json()).agent.stops;
}
const roundOf = async (project, id) => (await stopsOf(project)).rounds.find((round) => round.id === id);

async function stopCheck(project) {
  const reply = await agent("check", { project });
  assert.equal(reply.data.errors, 0, reply.text);
  return reply;
}

/** A video for stops: the fixture, its brief settled with no playback ("just start"), and a full check. */
async function stopVideo(id, { brief = true } = {}) {
  // The storyboard is asked with or without footage: the person's board skip-under skips it here
  // (backend/stops.test.support.mjs), so the rough cut comes first.
  await asDashboard("settings", { limits: { skipBoardUnder: BOARD_SKIP_UNDER } }, "PUT");
  const made = await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: 24, background: "#101820" });
  assert.equal(made.isError, undefined, made.text);
  // References are not what these stops are about (the reference step and gate: agent-brief and agent-review tests).
  const edited = await agent("edit", { project: id, ops: [STOP_TITLE, { op: "waive_check", code: "reference", target: "*", reason: "a stops fixture" }] });
  assert.equal(edited.isError, undefined, edited.text);
  if (brief) await saveStopBrief(id);
  await stopCheck(id);
}
async function saveStopBrief(id) {
  const brief = await agent("notes", { project: id, action: "brief", no_playback: "just start" });
  assert.equal(brief.isError, undefined, brief.text);
}

/** notes checkpoint that must wait for the person; `at` is when its answer came back, on the steady clock. */
async function askStop(project, kind) {
  const reply = await agent("notes", { project, action: "checkpoint", id: kind });
  assert.equal(reply.data?.status, "waiting_for_you", reply.text);
  return { ...reply.data, reply, at: performance.now() };
}

/** Waits out what is left of 5.2 s since a stop was asked (too_fast refuses an answer under 5 s). */
async function stopGap(at) {
  for (let left = at + 5200 - performance.now(); left > 0; left = at + 5200 - performance.now()) await sleep(left);
}

/** "14:05": an ISO time as the page shows it, on the page's own clock and time zone. */
const pageClock = (iso) => browser.evaluate(`(() => { const at = new Date(${JSON.stringify(iso)}); return [at.getHours(), at.getMinutes()].map((part) => String(part).padStart(2, "0")).join(":"); })()`);

/** Opens the dashboard on `project` (the agent's project, which the dashboard follows). */
async function openOn(project) {
  const opened = await agent("project", { action: "open", id: project });
  assert.equal(opened.isError, undefined, opened.text);
  await open();
  await browser.waitFor(`${onProject(project)}`, { what: `the ${project} project on the dashboard` });
  // Stops are listed under "needs you" in the session view of the agent pane.
  // The list (every earlier line) is closed until opened; showView opens it.
  // On a phone the stack has no list to open.
  if (await browser.evaluate(`!document.querySelector("#panel-session") && !document.querySelector(".dash.phone")`)) await showView("session", { focus: false });
}

/**
 * The agent's next call, and the time the page then shows on the stop's line ("the agent has your
 * answer (14:07)"): the server marks the answer heard (heardAt) when that call takes its inbox.
 */
async function agentHears(project, id) {
  const line = `${id} [^·]+ · [^\\n]*\\n?[^\\n]*the agent has your answer \\((\\d\\d:\\d\\d)\\)`;
  const shown = `(${q("#section-stops")}?.innerText.match(new RegExp(${JSON.stringify(line)})) ?? [])[1] ?? ""`;
  const first = await agent("status", { project });
  return { first, time: await browser.waitFor(shown, { what: `${id}: the agent has your answer` }) };
}

/** Every node of the accessibility tree that a screen reader reads. */
async function readNodes() {
  const { nodes } = await browser.send("Accessibility.getFullAXTree");
  return nodes.filter((node) => !node.ignored).map((node) => ({ role: node.role?.value ?? "", name: (node.name?.value ?? "").trim(), node }));
}

// B2c: the person's own final render waits for the video's stops, and the dashboard says why in
// words (not the refusal's JSON); a draft still renders.
test("e on a video whose stops are open says the final render waits for them", async () => {
  await stopVideo("stops-final");
  await openOn("stops-final");
  await browser.key("e");
  const said = await browser.waitFor(`(() => { const text = ${topMessage}; return text.includes("final render") && text; })()`, { what: "the refusal on the dashboard" });
  assert.equal(said, "A final render waits for this video's stops: rough, color, sound. A draft render works now. Answer them when your agent asks, or set them to allow in settings › stops.");
  assert.equal(await browser.evaluate(politeText), said, "a screen reader hears it too");
  assert.equal(await browser.evaluate(`${q(".topline .message")}.title`), said, "the top line cuts it short; pointing at it shows it whole");
  await browser.shot("final-waits-for-stops");
  assert.equal((await snapshot()).renders.filter((job) => job.projectId === "stops-final").length, 0, "nothing was rendered");
});

test("a waiting stop: needs you lists it first, the status line and the title say so, an alert is read, and the agent's writes wait", async () => {
  await stopVideo("stops-a");
  await openOn("stops-a");
  const asked = await askStop("stops-a", "rough");
  assert.equal(asked.id, "C1", asked.reply.text);
  const askedAt = (await stopsOf("stops-a")).waiting.askedAt;
  const clock = await pageClock(askedAt);
  // The alert, read at once; the window title counts the stop.
  await browser.waitFor(`${assertiveText} === "C1 needs you: the rough cut is ready. Press a to approve, or d to ask for a redo with a note."`, { what: "the assertive announcement of C1" });
  await browser.waitFor(`/^1 awaiting · /.test(document.title)`, { what: "the window title counts the stop" });
  // "needs you": the stop is the first row, with its ask's first line and two answers.
  const row = await browser.waitFor(`(() => {
    const first = ${q("#section-needs-you .needs-you")};
    if (!first || first !== ${stopRow("C1")}) return null;
    const open = first.querySelector('[aria-label^="Stop C1:"]');
    return { button: open.innerText.replace(/\\s+/g, " ").trim(), label: open.getAttribute("aria-label"), dim: first.querySelector(".dim")?.innerText.trim() ?? "",
      actions: [...first.querySelectorAll("button")].filter((button) => button !== open).map((button) => [button.textContent.trim(), button.classList.contains("allow")]) };
  })()`, { what: "C1 first in needs you" });
  assert.deepEqual(row, { button: "Rough cut C1", label: "Stop C1: the rough cut waits for you. Open its sheet.", dim: asked.ask.split("\n")[0],
    actions: [["Approve", true], ["Redo", false]] }, JSON.stringify(row));
  // On a wide window the line under the frame names what to do and holds the answers, and the
  // Crew tab counts the stop (the status line and the orange top line are no longer drawn there).
  const said = await browser.waitFor(`(() => {
    const line = ${q(".voice .voice-line")}, answers = [...document.querySelectorAll(".voice .voice-answers .voice-button")];
    return line && answers.length ? { line: line.innerText.trim(), answers: answers.map((button) => button.textContent.trim()) } : null;
  })()`, { what: "the stop on the line under the frame" });
  assert.deepEqual(said, { line: "Look at the rough cut, then approve it or ask for a redo.", answers: ["Approve rough cut", "Redo"] });
  await browser.waitFor(`${q('.tabs [aria-label=", 1 waiting for you"]')} !== null`, { what: "the Crew tab counts the stop" });
  // The agents section marks the agent that asked as needing you.
  await browser.waitFor(`[...document.querySelectorAll("#section-agents .row")].some((element) => element.innerText.includes("test-agent") && element.innerText.toLowerCase().includes("needs you"))`, { what: "test-agent needs you" });
  // A closed "needs you" counts the stop.
  const caret = q('.p-session button[aria-controls="section-needs-you"]');
  try {
    // The list has just opened and the frame glides to its new size (240 ms): let it settle.
    await sleep(600);
    await clickUntil(caret, `${caret}.getAttribute("aria-expanded") === "false" && /^needs you\\s*1$/i.test(${caret}.innerText.trim())`, "the closed section counts the stop");
    await clickUntil(caret, `${caret}.getAttribute("aria-expanded") === "true"`, "needs you open again");
  } finally {
    await browser.evaluate(`localStorage.removeItem("kino.dashboard.sections")`);
  }
  // The stops section says it waits.
  await browser.waitFor(pageHas(`C1 rough cut · waits for you since ${clock}`, "#section-stops"), { what: "the waiting line under stops" });
  // The agent's writes wait for the person; nothing changed.
  const rev = (await (await server.api("/api/projects/stops-a")).json()).revision;
  const edit = await agent("edit", { project: "stops-a", ops: [moveTitle(780)] });
  assert.equal(edit.data?.waiting, "C1", edit.text);
  assert.equal((await (await server.api("/api/projects/stops-a")).json()).revision, rev, "the edit changed nothing");
  await browser.shot("stop-waiting");
  // By mouse, the row opens the stop's sheet: the card with the agent's ask.
  await browser.click(stopOpen("C1"));
  await browser.waitFor(`!!document.querySelector('article.stop-card[aria-labelledby="stop-C1"]')`, { what: "C1's card" });
  const card = await browser.evaluate(`(() => {
    const card = ${q("article.stop-card")};
    const heading = document.getElementById("stop-C1");
    return { heading: heading.innerText.replace(/\\s+/g, " ").trim(), hidden: [...heading.querySelectorAll('[aria-hidden="true"]')].map((element) => element.textContent).join(""),
      text: card.innerText, ask: [...card.querySelectorAll("p")].map((line) => line.innerText.trim()), meta: [...card.querySelectorAll(".stop-meta li")].map((item) => item.innerText.trim()) };
  })()`);
  assert.equal(card.heading, "C1, the rough cut, waits for you");
  assert.equal(card.hidden, "", "no drawn ◉ any more");
  assert.deepEqual(card.meta, [clock, "Test-agent", `Rev ${asked.rev}`], "when, who and which revision asked");
  for (const line of asked.ask.split("\n")) assert.ok(card.ask.includes(line), `the ask's line ${JSON.stringify(line)}, one paragraph each: ${JSON.stringify(card.ask)}`);
  assert.deepEqual(asked.offer, ["color", "sound"]);
  assert.ok(card.text.includes(`The ask offers "stop asking" for the color and sound checks, answered in the chat`), card.text);
  // The footnote about A and D is gone from the card (they are still off, and say so when pressed: next test).
  assert.ok(!card.text.includes("A and D are off on stops"), card.text);
  await browser.key("Escape");
  await browser.waitFor(`!document.querySelector("article.stop-card") && !!${stopRow("C1")}`, { what: "back on the main screen" });
});

test("a on a stop approves it: the dashboard answer is saved, the agent hears it with its next call, and its writes work again", async () => {
  await openOn("stops-a");
  await browser.waitFor(`!!${stopRow("C1")}`, { what: "C1 in needs you" });
  await showView("session");
  await browser.key("a");
  const round = await until(async () => { const found = await roundOf("stops-a", "C1"); return found?.status === "answered" ? found : null; }, "C1 approved");
  const { at, afterSeconds, ...answer } = round.answer;
  assert.deepEqual(answer, { via: "dashboard", words: null, read_as: "approve", client: "dashboard" });
  assert.ok(Number.isInteger(afterSeconds) && afterSeconds >= 0, `afterSeconds ${afterSeconds}`);
  await browser.waitFor(`${politeText} === ${JSON.stringify(`C1 approved.${GO_ON}`)} && ${topMessage} === ${JSON.stringify(`C1 approved.${GO_ON}`)}`, { what: "the polite region and the top line" });
  const clock = await pageClock(at);
  await browser.waitFor(pageHas(`C1 rough cut · approved on the dashboard · ${afterSeconds} s after asking · ${clock}`, "#section-stops"), { what: "C1's line under stops" });
  // Until the agent's next call takes the answer from its inbox, the line says to tell the agent.
  assert.ok(await browser.evaluate(pageHas(`tell your agent "go on": it hears your answer with its next call`, "#section-stops")), "the line says to tell the agent");
  assert.equal(await browser.evaluate(`!!${stopRow("C1")}`), false, "C1 left needs you");
  assert.match(await browser.evaluate("document.title"), /^(?!\d+ awaiting)/, "the title no longer counts it");
  // The agent's next call carries the answer; then the line says the agent has it.
  const { first, time } = await agentHears("stops-a", "C1");
  assert.match(inboxText(first), /C1 rough approved by the person in kino\. Go on\./);
  assert.equal(time, await pageClock((await roundOf("stops-a", "C1")).answer.heardAt), "the time the server marked the answer heard");
  // Writes work again.
  const edit = await agent("edit", { project: "stops-a", ops: [moveTitle(780)] });
  assert.equal(edit.data?.waiting, undefined, edit.text);
  assert.equal(edit.isError, undefined, edit.text);
});

test("Tab on a stop approves with a note; A and D are off; the approve-with-a-note button focuses an empty note", async () => {
  await stopCheck("stops-a");
  const asked = await askStop("stops-a", "color");
  assert.equal(asked.id, "C2", asked.reply.text);
  await openOn("stops-a");
  await browser.waitFor(`${q("#section-needs-you .needs-you")} === ${stopRow("C2")}`, { what: "C2 first in needs you" });
  // A and D on the main screen, where the row they act on is the stop, say they are off on stops.
  const off = "A and D are off on stops: a stop is set to allow only in settings › stops.";
  for (const key of ["A", "D"]) {
    if (key === "D") {
      await open();
      await showView("session", { focus: false });
      await browser.waitFor(`${q("#section-needs-you .needs-you")} === ${stopRow("C2")}`, { what: "C2 first in needs you" });
    }
    await showView("session");
    assert.equal(await browser.evaluate(topMessage), "", "no message yet on the fresh page");
    await browser.key(key);
    await browser.waitFor(`${topMessage} === ${JSON.stringify(off)}`, { what: `${key} is off on the main screen` });
    await sleep(300);
    assert.equal((await stopsOf("stops-a")).waiting?.id, "C2", `${key} answered nothing`);
    assert.equal((await settings()).approvals["checkpoint-color"], "ask", `${key} set nothing`);
  }
  // A fresh page (a message stays until the next one); Enter on the row opens the stop screen,
  // with 4 stills of the revision the stop shows.
  await open();
  await showView("session");
  await browser.waitFor(`${q("#section-needs-you .needs-you")} === ${stopRow("C2")}`, { what: "C2 first in needs you" });
  await browser.key("Enter");
  await browser.waitFor(`!!document.querySelector('article.stop-card[aria-labelledby="stop-C2"]')`, { what: "C2's card" });
  await browser.waitFor(`document.activeElement?.matches("section.screen")`, { what: "the stop screen takes the focus" });
  const stills = `[...document.querySelectorAll(".stop-card img")]`;
  await browser.waitFor(`${stills}.length === 4 && ${stills}.every((image) => image.complete && image.naturalWidth > 0)`, { timeout: 30_000, what: "4 stills loaded" });
  const shown = await browser.evaluate(`${stills}.map((image) => ({ alt: image.alt, src: new URLSearchParams(image.getAttribute("src").split("?")[1]) })).map(({ alt, src }) => [alt, src.get("project"), src.get("rev"), src.get("w")])`);
  assert.deepEqual(shown, [3, 9, 15, 21].map((seconds) => [`Rev ${asked.rev} at ${seconds.toFixed(1)} s`, "stops-a", String(asked.rev), "480"]), JSON.stringify(shown));
  assert.ok(await browser.evaluate(`!!${q(`.stop-card .stills-grid[aria-label="Stills of rev ${asked.rev}"]`)}`), "the stills are labeled with the revision you answer");
  assert.equal(await browser.evaluate(pageHas(`offers "stop asking"`, ".stop-card")), false, "only the first of rough, color and sound offers it");
  await browser.shot("stop-screen");
  // A on the stop screen says the same; C2 still waits.
  assert.equal(await browser.evaluate(topMessage), "", "no message yet on the fresh page");
  await browser.key("A");
  await browser.waitFor(`${topMessage} === ${JSON.stringify(off)}`, { what: "A is off on the stop screen" });
  await sleep(300);
  assert.equal((await stopsOf("stops-a")).waiting?.id, "C2", "A answered nothing");
  assert.equal((await settings()).approvals["checkpoint-color"], "ask", "and set nothing");
  // By mouse: the button with an empty note focuses the note, in its approve-with-notes mode, inside
  // the click itself (a phone opens its keyboard only for a focus inside the tap).
  await browser.click(q(".stop-card .stop-meta"));
  assert.equal(await browser.evaluate(`(() => { ${button("Approve with note", ".stop-card")}.click(); return document.activeElement === ${stopNote}; })()`), true, "the note focused inside the click");
  await browser.waitFor(`document.activeElement === ${stopNote}`, { what: "the note focused by the button" });
  assert.equal(await browser.evaluate(noteLabel), "Note for approve with notes");
  assert.equal(await browser.evaluate(`${stopNote}.placeholder`), "Note. Enter approves with it");
  assert.equal(await browser.evaluate(`${stopNote}.maxLength`), 2000);
  assert.equal((await stopsOf("stops-a")).waiting?.id, "C2", "an empty note sent nothing");
  // By keyboard: from nothing focused, Tab goes to the note; Enter approves with it.
  await browser.click(q(".stop-card .stop-meta"));
  await browser.waitFor(`document.activeElement !== ${stopNote}`, { what: "the note no longer focused" });
  await browser.key("Tab");
  await browser.waitFor(`document.activeElement === ${stopNote}`, { what: "idle Tab focuses the note" });
  assert.equal(await browser.evaluate(noteLabel), "Note for approve with notes");
  await browser.type("warmer");
  await browser.key("Enter");
  const round = await until(async () => { const found = await roundOf("stops-a", "C2"); return found?.status === "answered" ? found : null; }, "C2 approved with notes");
  assert.deepEqual([round.answer.via, round.answer.read_as, round.answer.words], ["dashboard", "approve with notes", "warmer"]);
  await browser.waitFor(`${politeText} === ${JSON.stringify(`C2 approved with your note.${GO_ON}`)}`, { what: "the polite announcement" });
});

test("d on a stop asks for a redo with a note: an empty note is refused, the redo reaches the agent", async () => {
  const asked = await askStop("stops-a", "sound");
  assert.equal(asked.id, "C3", asked.reply.text);
  // The ask's call also carried C2's answer from the dashboard.
  assert.match(inboxText(asked.reply), /C2 color approved by the person in kino, with notes: "warmer"\. Make those changes, then go on\./);
  await openOn("stops-a");
  // By mouse: the row's redo opens the stop screen with the redo note focused.
  await browser.click(`[...(${stopRow("C3")})?.querySelectorAll("button") ?? []].find((element) => element.textContent.trim() === "Redo")`, "C3's Redo");
  await browser.waitFor(`document.activeElement === ${stopNote}`, { what: "the redo note focused from the row" });
  assert.equal(await browser.evaluate(noteLabel), "What to redo");
  assert.equal(await browser.evaluate(`${stopNote}.placeholder`), "What to redo. Enter sends it");
  // Esc leaves the note first, then the screen.
  await browser.key("Escape");
  await browser.waitFor(`document.activeElement !== ${stopNote} && !!document.querySelector("article.stop-card")`, { what: "Esc leaves the note" });
  await browser.key("Escape");
  await browser.waitFor(`!document.querySelector("article.stop-card")`, { what: "back from the stop screen" });
  // By keyboard: d on the main screen does the same.
  await showView("session");
  await browser.key("d");
  await browser.waitFor(`document.activeElement === ${stopNote} && !!document.querySelector('article.stop-card[aria-labelledby="stop-C3"]')`, { what: "d opens C3 with its redo note focused" });
  assert.equal(await browser.evaluate(noteLabel), "What to redo");
  // Enter on an empty redo says what to do and sends nothing.
  await browser.key("Enter");
  await browser.waitFor(`${topMessage} === "Say what to redo first: type it in the note, then press Enter." && !!${q(".topline .message.err")}`, { what: "the empty redo refused" });
  await sleep(300);
  assert.equal((await stopsOf("stops-a")).waiting?.id, "C3", "nothing was sent");
  await browser.type("the ding is too loud");
  // Esc leaves the note (to look at the stills); Tab goes back into it, and it is still a redo.
  await browser.key("Escape");
  await browser.waitFor(`document.activeElement !== ${stopNote}`, { what: "Esc leaves the note" });
  await browser.key("Tab");
  await browser.waitFor(`document.activeElement === ${stopNote}`, { what: "Tab back into the note" });
  assert.equal(await browser.evaluate(noteLabel), "What to redo", "Tab keeps a typed redo note a redo");
  await browser.key("Enter");
  const round = await until(async () => { const found = await roundOf("stops-a", "C3"); return found?.status === "answered" ? found : null; }, "C3 redo");
  assert.deepEqual([round.answer.via, round.answer.read_as, round.answer.words], ["dashboard", "redo", "the ding is too loud"]);
  await browser.waitFor(`${politeText} === ${JSON.stringify(`C3: redo sent with your note.${GO_ON}`)}`, { what: "the polite announcement" });
  await browser.key("Escape");
  const clock = await pageClock(round.answer.at);
  await browser.waitFor(pageHas(`C3 sound pass · redo on the dashboard: "the ding is too loud" · ${round.answer.afterSeconds} s after asking · ${clock}`, "#section-stops"), { what: "C3's line under stops" });
  // The agent hears it, and status says where the video stands.
  const status = await agent("status", { project: "stops-a" });
  assert.match(inboxText(status), /C3 sound: the person asked for a redo in kino: "the ding is too loud"\. Fix only what they named, check, then ask again: notes \{action:"checkpoint", id:"sound"\}\./);
  assert.match(status.text.split("\n")[1], /^direction: C3 sound redo · replies \d+\/10$/, status.text);
});

test("a chat answer shows the person's words, how long after the ask, and recorded by the agent", async () => {
  await agent("edit", { project: "stops-a", ops: [moveTitle(760)] });
  await stopCheck("stops-a");
  const asked = await askStop("stops-a", "sound");
  assert.equal(asked.id, "C4", asked.reply.text);
  await openOn("stops-a");
  await browser.waitFor(`!!${stopRow("C4")}`, { what: "C4 in needs you" });
  await stopGap(asked.at);
  const words = "looks good, but keep the title a little higher";
  const recorded = await agent("notes", { project: "stops-a", action: "answer", id: "C4", rev: asked.rev, words, read_as: "approve with notes" });
  assert.equal(recorded.isError, undefined, recorded.text);
  const round = await roundOf("stops-a", "C4");
  assert.equal(round.answer.via, "chat");
  const clock = await pageClock(round.answer.at);
  await browser.waitFor(pageHas(`C4 sound pass · approved with notes in chat: "${words}" · ${round.answer.afterSeconds} s after asking · ${clock} · recorded by the agent`, "#section-stops"), { what: "C4's chat answer under stops" });
  // The announcement reads the answer as the stop line does ("approved with notes").
  await browser.waitFor(`${politeText} === ${JSON.stringify(`C4 approved with notes in chat (recorded by the agent): "${words}".`)}`, { what: "the polite announcement of the chat answer" });
  assert.equal(await browser.evaluate(`!!${stopRow("C4")}`), false, "C4 left needs you");
  await browser.shot("stop-chat-answer");
});

test("reopen asks first (n keeps the answer), then reopens a chat answer, and the agent asks again", async () => {
  await openOn("stops-a");
  const words = "looks good, but keep the title a little higher";
  const label = `Reopen C4: the agent recorded "${words}" as approve with notes. kino tells it to ask you again.`;
  const reopen = `document.querySelector(${JSON.stringify(`#section-stops button[aria-label=${JSON.stringify(label)}]`)})`;
  await browser.waitFor(`!!${reopen}`, { what: "C4's reopen button" });
  assert.equal(await browser.evaluate(`${reopen}.textContent.trim()`), "Reopen");
  // Only answered rounds with no later round of their kind have one: C1 and C2 here, not C3 (redo, then C4).
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll("#section-stops button")].map((element) => element.getAttribute("aria-label") ?? "").filter((name) => name.startsWith("Reopen ")).map((name) => name.split(":")[0]).sort()`),
    ["Reopen C1", "Reopen C2", "Reopen C4"]);
  const nodes = await readNodes();
  assert.ok(nodes.some((node) => node.role === "button" && node.name === label), "a screen reader hears the reopen button by its label");
  // By keyboard: Enter on the button asks first; n keeps the answer.
  await browser.evaluate(`${reopen}.focus()`);
  await browser.key("Enter");
  const question = `Reopen C4 (the sound pass)? The agent recorded "${words}" as approve with notes. kino tells it to ask you again.`;
  await browser.waitFor(`${textOf('[role="alertdialog"]')}.includes(${JSON.stringify(question)}) && !!${button("Reopen", '[role="alertdialog"]')}`, { what: "the reopen question" });
  await browser.key("n");
  await browser.waitFor(`!document.querySelector('[role="alertdialog"]')`, { what: "n closes the question" });
  await sleep(300);
  assert.equal((await roundOf("stops-a", "C4")).status, "answered", "n kept the answer");
  // By mouse: the button, then y.
  await browser.click(reopen);
  await browser.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { what: "the question again" });
  await browser.key("y");
  const round = await until(async () => { const found = await roundOf("stops-a", "C4"); return found?.status === "reopened" ? found : null; }, "C4 reopened");
  assert.match(round.reopenedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(round.answer.words, words, "the answer is kept");
  await browser.waitFor(`${politeText} === ${JSON.stringify('C4 reopened. The agent is told with its next call; tell it "go on" if it is waiting.')}`, { what: "the polite announcement" });
  const clock = await pageClock(round.reopenedAt);
  await browser.waitFor(pageHas(`C4 sound pass · reopened ${clock} (was: approved with notes in chat: "${words}"); the agent asks again`, "#section-stops"), { what: "C4's reopened line" });
  assert.equal(await browser.evaluate(`!!${reopen}`), false, "no reopen on a reopened round");
  await browser.shot("stop-reopened");
  // The agent's next call says so, status says where the video stands, and the old answer is refused.
  const status = await agent("status", { project: "stops-a" });
  assert.match(inboxText(status), new RegExp(`C4 sound reopened by the person in kino: your record "${words}" \\(approve with notes\\) is not what they meant\\. Ask again: notes \\{action:"checkpoint", id:"sound"\\}\\.`));
  assert.deepEqual(status.text.split("\n").slice(1, 3).map((line) => line.replace(/replies \d+\/10/, "replies N/10")), ["direction: C4 sound reopened · replies N/10", "step: check, then ask sound again"], status.text);
  const again = await agent("notes", { project: "stops-a", action: "answer", id: "C4", rev: round.rev, words, read_as: "approve with notes" });
  assert.equal(again.isError, true, again.text);
  assert.equal(again.data.error, "reopened", again.text);
  assert.equal(again.data.reason, 'C4 was reopened by the person in kino. Ask again: notes {action:"checkpoint", id:"sound"}.');
});

test("keep asking undoes the \"stop asking\" the agent recorded from the chat, and the agent is told", async () => {
  await stopVideo("stops-b");
  const asked = await askStop("stops-b", "rough");
  assert.deepEqual([asked.id, asked.offer], ["C1", ["color", "sound"]], asked.reply.text);
  await openOn("stops-b");
  await stopGap(asked.at);
  const words = "stop asking me, just make it";
  const recorded = await agent("notes", { project: "stops-b", action: "answer", id: "C1", rev: asked.rev, words, read_as: "stop asking" });
  assert.equal(recorded.isError, undefined, recorded.text);
  await browser.waitFor(pageHas(`stop asking: rough, color and sound pass for this video · said in chat: "${words}" · recorded by the agent`, "#section-stops"), { what: "the stop asking line" });
  const keep = `[...document.querySelectorAll("#section-stops button")].find((element) => element.textContent.trim() === "Keep asking")`;
  await browser.waitFor(`!!${keep}`, { what: "the keep asking button" });
  const named = (await readNodes()).filter((node) => node.role === "button" && node.name.toLowerCase().includes("keep asking"));
  assert.equal(named.length, 1, "a screen reader hears one keep asking button");
  await browser.shot("stop-keep-asking");
  // By keyboard: Enter on the focused button.
  await browser.evaluate(`${keep}.focus()`);
  await browser.key("Enter");
  const stops = await until(async () => { const found = await stopsOf("stops-b"); return found.stopAsking?.undoneAt ? found : null; }, "stop asking undone");
  await browser.waitFor(`${politeText} === "The rough, color and sound stops ask again for this video. The agent is told with its next call."`, { what: "the polite announcement" });
  const clock = await pageClock(stops.stopAsking.undoneAt);
  await browser.waitFor(pageHas(`stop asking undone ${clock}: rough, color and sound ask again`, "#section-stops"), { what: "the undone line" });
  assert.equal(await browser.evaluate(`!!${keep}`), false, "no keep asking once undone");
  assert.match(inboxText(await agent("status", { project: "stops-b" })), /you turned the rough, color and sound stops back on for this video \(undid "stop asking" from C1\)/);
});

test("stop settings by keyboard and by mouse: ask or allow and skip-under for each stop, kept after a reload, refused out of range", async () => {
  const stopField = (id) => q(`#${id}`);
  const nameOf = (id) => `${stopField(id)}?.getAttribute("aria-label")`;
  const chosen = (id) => `${q(`#${id} input:checked`)}?.value`;
  try {
    // stopVideo raised the board skip-under for its fixtures: this test reads the defaults.
    await asDashboard("settings", { limits: { skipBoardUnder: 8 } }, "PUT");
    await openOn("stops-b");
    await browser.key(":");
    await browser.type("settings");
    await browser.key("Enter");
    await browser.waitFor(`${textOf("#screen-title")} === "settings"`);
    await browser.waitFor(`!!${stopField("set-stop-rough")}`, { what: "the stops section" });
    // The stops come before the approvals: they hold a final render, so they must not be missed.
    const pane = await browser.evaluate(`${q('.set-pane[data-pane="2"]')}.innerText`);
    assert.match(pane, /^Stops/, "pane 2 is the stops");
    assert.ok(pane.replace(/\s+/g, " ").includes("\"stop asking\" in chat skips the rough cut, color and sound stops for one video."), pane);
    // Each stop: ask or allow, and its skip-under length, with the owner's defaults.
    const STOPS = { board: ["storyboard", 8], rough: ["rough cut", 15], color: ["color pass", 15], sound: ["sound pass", 15] };
    for (const [kind, [word, seconds]] of Object.entries(STOPS)) {
      assert.equal(await browser.evaluate(nameOf(`set-stop-${kind}`)), `${word} stop`);
      assert.equal(await browser.evaluate(nameOf(`set-stop-${kind}-skip`)), `${word}: skip under (s)`);
      assert.deepEqual(await browser.evaluate(`[${chosen(`set-stop-${kind}`)}, [...document.querySelectorAll("#set-stop-${kind} input")].map((option) => option.value), ${stopField(`set-stop-${kind}-skip`)}.value]`),
        ["ask", ["ask", "allow"], String(seconds)], kind);
      assert.equal(await browser.evaluate(`${stopField(`set-stop-${kind}-skip`)}.title`), `videos shorter than this have no ${word} stop (default ${seconds}; 0 never skips)`, `${kind}'s skip hint`);
    }
    assert.equal(await browser.evaluate(`${q("#set-stop-board-hint")}.textContent`), "ask (default): before building", "the storyboard's hint");
    assert.equal(await browser.evaluate(`${q("#set-stop-color-hint")}.textContent`), "ask (default): when the color pass is done", "the color pass's hint");
    // By keyboard: → moves the color pass's choice from ask to allow.
    await browser.evaluate(`${q("#set-stop-color input:checked")}.focus()`);
    await browser.key("ArrowRight");
    await until(async () => (await settings()).approvals["checkpoint-color"] === "allow", "the color pass set to allow");
    await browser.waitFor(`${q("#set-stop-color-hint")}?.textContent === "allowed: passes without asking you"`, { what: "the allow hint" });
    // By mouse: the rough cut skips videos under 20 s; it saves when the field loses the focus.
    await browser.click(stopField("set-stop-rough-skip"));
    await browser.selectAll();
    await browser.type("20");
    await sleep(200);
    assert.equal((await settings()).limits.skipRoughUnder, 15, "nothing saved while typing");
    // The page title is visually hidden now: a click on the stops section's heading takes the focus away.
    await browser.click(q("#set-pane-2"));
    await until(async () => (await settings()).limits.skipRoughUnder === 20, "the rough cut skips under 20 s");
    const saved = await settings();
    assert.deepEqual(Object.fromEntries(Object.entries(saved.approvals).filter(([kind]) => kind.startsWith("checkpoint-"))),
      { "checkpoint-board": "ask", "checkpoint-rough": "ask", "checkpoint-color": "allow", "checkpoint-sound": "ask" });
    assert.deepEqual([saved.limits.skipBoardUnder, saved.limits.skipRoughUnder, saved.limits.skipColorUnder, saved.limits.skipSoundUnder], [8, 20, 15, 15]);
    await browser.evaluate(`${stopField("set-stop-board")}.scrollIntoView({ block: "center" })`);
    await browser.shot("stop-settings");
    // After a reload the fields show what was saved.
    await open();
    await browser.key(":");
    await browser.type("settings");
    await browser.key("Enter");
    await browser.waitFor(`${chosen("set-stop-color")} === "allow" && ${stopField("set-stop-rough-skip")}?.value === "20"`, { what: "the saved stops after a reload" });
    // A 16 s video now has no rough-cut stop.
    const short = await agent("project", { action: "create", id: "stops-c", name: "stops-c", width: 1080, height: 1920, duration: 16 });
    assert.equal(short.isError, undefined, short.text);
    const skipped = await agent("notes", { project: "stops-c", action: "checkpoint", id: "rough" });
    assert.deepEqual(skipped.data, { status: "skipped", kind: "rough", reason: "under 20 s" }, skipped.text);
    // Out of range: the server's message shows, and the saved value stays.
    await browser.evaluate(`${stopField("set-stop-rough-skip")}.focus()`);
    await browser.selectAll();
    await browser.type("4000");
    await browser.key("Tab");
    await browser.waitFor(`${topMessage} === "The rough cut skip-under length is a whole number of seconds from 0 to 3600." && !!${q(".topline .message.err")}`, { what: "the 400's message" });
    assert.equal((await settings()).limits.skipRoughUnder, 20, "4000 was not saved");
    // A decimal is refused the same way, not rounded: 7.5 is not saved as 8.
    await browser.evaluate(`${stopField("set-stop-board-skip")}.focus()`);
    await browser.selectAll();
    await browser.type("7.5");
    await browser.key("Tab");
    await browser.waitFor(`${topMessage} === "The storyboard skip-under length is a whole number of seconds from 0 to 3600."`, { what: "the decimal's 400" });
    assert.equal((await settings()).limits.skipBoardUnder, 8, "7.5 was not saved as 8");
    assert.equal(await browser.evaluate(`${stopField("set-stop-board-skip")}.value`), "7.5", "the field shows what was typed, and the message says it was not saved");
  } finally {
    // The stop tests after this one go on with the fixtures, so the board skip-under goes back up.
    await asDashboard("settings", { approvals: { "checkpoint-color": "ask" }, limits: { skipRoughUnder: 15, skipBoardUnder: BOARD_SKIP_UNDER } }, "PUT");
  }
});

test("the phone puts a waiting stop's card first; a tap approves it, and the stops card shows the answer", async () => {
  await stopCheck("stops-a");
  const asked = await askStop("stops-a", "sound");
  assert.equal(asked.id, "C5", asked.reply.text);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    await openOn("stops-a");
    await browser.waitFor(`${q(".phone-stack")}?.firstElementChild?.matches('article.stop-card[aria-labelledby="stop-C5"]')`, { what: "C5's card first in the phone stack" });
    const place = await browser.evaluate(`(() => {
      const card = ${q(".phone-stack .stop-card")};
      return { page: document.documentElement.scrollWidth, card: card.scrollWidth - card.clientWidth,
        buttons: [...card.querySelectorAll("button")].filter((element) => element.getClientRects().length).map((element) => [element.textContent.trim(), Math.round(element.getBoundingClientRect().height)]) };
    })()`);
    assert.ok(place.page <= 390 && place.card <= 0, `no sideways scrolling: ${JSON.stringify(place)}`);
    for (const label of ["Approve", "Approve with note", "Redo"])
      assert.ok(place.buttons.some(([text, height]) => text === label && height >= 44), `${label} is at least 44 px tall: ${JSON.stringify(place.buttons)}`);
    await browser.waitFor(`[...document.querySelectorAll(".phone-stack .stop-card img")].filter((image) => image.complete && image.naturalWidth > 0).length === 4`, { timeout: 30_000, what: "the stills on the phone" });
    await browser.shot("stop-phone");
    await browser.tap(button("Approve", ".phone-stack .stop-card"));
    const round = await until(async () => { const found = await roundOf("stops-a", "C5"); return found?.status === "answered" ? found : null; }, "C5 approved by a tap");
    assert.deepEqual([round.answer.via, round.answer.read_as, round.answer.words], ["dashboard", "approve", null]);
    const clock = await pageClock(round.answer.at);
    await browser.waitFor(`!document.querySelector(".phone-stack .stop-card") && ${pageHas(`C5 sound pass · approved on the dashboard · ${round.answer.afterSeconds} s after asking · ${clock}`, ".phone-stack")}`, { what: "the stops card shows C5's answer" });
    // The card that had the focus is gone: the focus is on C5's line in the card that took its place.
    await browser.waitFor(`${focusPlace} === "line C5" && !!document.activeElement.closest(".phone-stack > .stop-done")`, { what: "the focus on C5's line at the top of the stack" });
    assert.ok(await browser.evaluate("document.documentElement.scrollWidth <= 390"), "no sideways scrolling with the stops card");
    await browser.shot("stop-phone-answered");
    assert.match(inboxText(await agent("status", { project: "stops-a" })), /C5 sound approved by the person in kino\. Go on\./);
  } finally {
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test("a screen reader hears the stop: its row, the status line, the card, its three answers, the note by its label, reopen, the settings fields and the keys", async () => {
  // The rough cut again: the person reopens C1 (here through the dashboard's route), and the agent asks it again.
  await asDashboard("stops", { project: "stops-a", action: "reopen", id: "C1" });
  const checkedAfter = await stopCheck("stops-a");
  // The sound on this same revision was just approved, so the rough would merge into it: a real edit makes a new revision and the rough is asked on its own.
  await agent("edit", { project: "stops-a", ops: [moveTitle(770)] });
  await stopCheck("stops-a");
  const asked = await askStop("stops-a", "rough");
  assert.equal(asked.id, "C6", asked.reply.text);
  // The agent's first call after the reopen (the check) carries it.
  assert.match(inboxText(checkedAfter), /C1 rough reopened by the person in kino: they take back their answer \(approve\)\. Ask again: notes \{action:"checkpoint", id:"rough"\}\./);
  await openOn("stops-a");
  await browser.waitFor(`!!${stopRow("C6")}`, { what: "C6 in needs you" });
  const clock = await pageClock((await stopsOf("stops-a")).waiting.askedAt);
  let nodes = await readNodes();
  const names = (role) => nodes.filter((node) => node.role === role).map((node) => node.name);
  assert.ok(names("button").includes("Stop C6: the rough cut waits for you. Open its sheet."), `the row: ${names("button").filter((name) => name.startsWith("Stop")).join(" | ")}`);
  assert.ok(names("button").includes("Reopen C5: take back your answer (approve). kino tells the agent to ask you again."), "reopen on a dashboard answer");
  assert.ok(names("button").includes("Reopen C2: take back your answer (approve with notes). kino tells the agent to ask you again."), "reopen on a dashboard answer with a note");
  assert.deepEqual(nodes.filter((node) => node.name.includes("◉")).map((node) => node.name), [], "the drawn ◉ is never read");
  // On a wide window the line under the frame reads the stop in words (the status line no longer does).
  assert.ok(nodes.some((node) => node.role === "region" && node.name === "test-agent needs you"), `the agent's line is a region that says who needs you: ${names("region").join(" | ")}`);
  assert.ok(nodes.some((node) => node.name === "Look at the rough cut, then approve it or ask for a redo."), "the line under the frame says what to do");
  // The card on the stop screen.
  await browser.click(stopOpen("C6"));
  await browser.waitFor(`!!document.querySelector('article.stop-card[aria-labelledby="stop-C6"]')`, { what: "C6's card" });
  nodes = await readNodes();
  assert.ok(nodes.some((node) => node.role === "article" && node.name === "C6, the rough cut, waits for you"), `the card: ${names("article").join(" | ")}`);
  assert.ok(nodes.some((node) => node.name === "What the agent sends you"), "the ask's block is named");
  for (const [label, keys] of [["Approve", "a"], ["Approve with note", "Tab"], ["Redo", "d"]]) {
    const found = nodes.find((node) => node.role === "button" && node.name === label);
    assert.ok(found, `the ${label} button: ${names("button").filter((name) => /approve|redo/i.test(name)).join(" | ")}`);
    assert.equal(await browser.evaluate(`${button(label, ".stop-card")}.getAttribute("aria-keyshortcuts")`), keys, `${label}'s key`);
  }
  assert.ok(nodes.some((node) => node.role === "textbox" && node.name === "Note for approve with notes"), `the note by its label: ${names("textbox").join(" | ")}`);
  assert.ok(nodes.some((node) => node.role === "image" || node.role === "img") && nodes.some((node) => ["image", "img"].includes(node.role) && node.name === `Rev ${asked.rev} at 3.0 s`), "the stills by their revision and time");
  await browser.key("Escape");
  // The settings fields.
  await browser.key(":");
  await browser.type("settings");
  await browser.key("Enter");
  await browser.waitFor(`!!${q("#set-stop-rough")}`, { what: "the stops settings" });
  nodes = await readNodes();
  assert.ok(nodes.some((node) => node.role === "radiogroup" && node.name === "rough cut stop"), `the rough cut stop field: ${nodes.filter((node) => node.name.includes("rough cut")).map((node) => `${node.role} ${node.name}`).join(" | ")}`);
  assert.ok(nodes.some((node) => node.role === "spinbutton" && node.name === "rough cut: skip under (s)"), "the rough cut's skip-under field");
  // The keys screen lists the stop's keys.
  await browser.key("Escape");
  await browser.key("?");
  await browser.waitFor(pageHas("On a stop: approve, approve with a note, redo with a note, a note on one shot (A, D off)", ".screen"), { what: "the stop's keys on the keys screen" });
  await browser.key("Escape");
});

test("reduced motion: nothing on the stop card moves, and the card is answered by mouse", async () => {
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await openOn("stops-a");
    assert.equal(await browser.evaluate(`matchMedia("(prefers-reduced-motion: reduce)").matches`), true);
    await browser.click(stopOpen("C6"));
    await browser.waitFor(`!!document.querySelector('article.stop-card[aria-labelledby="stop-C6"]')`, { what: "C6's card" });
    const moving = await browser.evaluate(`[${q(".stop-card")}, ...${q(".stop-card")}.querySelectorAll("*")].map((element) => getComputedStyle(element))
      .filter((style) => style.animationName !== "none" || style.transitionDuration.split(",").some((value) => parseFloat(value) !== 0)).length`);
    assert.equal(moving, 0, "no animation or transition on the stop card under reduced motion");
    const card = await browser.evaluate(`(() => { const style = getComputedStyle(${q(".stop-card")}); return [style.animationName, style.transitionDuration]; })()`);
    assert.deepEqual(card, ["none", "0s"]);
    await browser.click(button("Approve", ".stop-card"));
    const round = await until(async () => { const found = await roundOf("stops-a", "C6"); return found?.status === "answered" ? found : null; }, "C6 approved by a click");
    assert.deepEqual([round.answer.via, round.answer.read_as, round.answer.words], ["dashboard", "approve", null]);
    await browser.waitFor(`${politeText} === ${JSON.stringify(`C6 approved.${GO_ON}`)}`, { what: "the polite announcement" });
  } finally {
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await browser.key("Escape").catch(() => {});
    await agent("project", { action: "open", id: "orbit" });
  }
});

// ---- review round 1 of B2b: the stop screen's own keys, redo then the next round, focus, the
// closed "needs you", the row's approve button, a chat answer on a phone, and a stop in a project
// that is not open. A video of its own (stops-r), so the rounds above keep their ids.

/** Where the focus is: "body", or the stop line (data-stop-line) it is in, or another element's tag. */
const focusPlace = `(() => { const active = document.activeElement; if (!active || active === document.body) return "body";
  const line = active.closest("[data-stop-line]"); return line ? "line " + line.dataset.stopLine : active.tagName.toLowerCase(); })()`;

test("on the stop screen d and a answer by key; after a redo the screen moves to the next round, and the focus stays on the stop's line", async () => {
  await stopVideo("stops-r");
  const first = await askStop("stops-r", "rough");
  assert.equal(first.id, "C1", first.reply.text);
  await openOn("stops-r");
  await browser.waitFor(`!!${stopRow("C1")}`, { what: "C1 in needs you" });
  await showView("session");
  await browser.key("Enter");
  await browser.waitFor(`!!document.querySelector('article.stop-card[aria-labelledby="stop-C1"]') && document.activeElement !== ${stopNote}`, { what: "C1's stop screen, the note not focused" });
  // d on the stop screen puts the cursor in the note for a redo.
  await browser.key("d");
  await browser.waitFor(`document.activeElement === ${stopNote}`, { what: "d focuses the redo note" });
  assert.equal(await browser.evaluate(noteLabel), "What to redo");
  await browser.type("make the title bigger");
  await browser.key("Enter");
  const redo = await until(async () => { const found = await roundOf("stops-r", "C1"); return found?.status === "answered" ? found : null; }, "C1 redo");
  assert.deepEqual([redo.answer.via, redo.answer.read_as, redo.answer.words], ["dashboard", "redo", "make the title bigger"]);
  // The card is gone; the focus is on C1's line (its reopen button), not lost to the page.
  await browser.waitFor(`!document.querySelector("article.stop-card") && ${focusPlace} === "line C1"`, { what: "the focus on C1's line after the redo" });
  // The agent fixes it and asks again: the screen moves to C2, whose a approves it.
  await agent("edit", { project: "stops-r", ops: [{ op: "update_layer", layer: "title", properties: { fontSize: 120 } }] });
  await stopCheck("stops-r");
  const second = await askStop("stops-r", "rough");
  assert.equal(second.id, "C2", second.reply.text);
  await browser.waitFor(`!!document.querySelector('article.stop-card[aria-labelledby="stop-C2"]') && ${textOf("#screen-title")}.includes("Rough cut, C2")`, { what: "the stop screen moves to C2" });
  await browser.evaluate("document.activeElement?.blur()");
  await browser.key("a");
  const approved = await until(async () => { const found = await roundOf("stops-r", "C2"); return found?.status === "answered" ? found : null; }, "C2 approved by a");
  assert.deepEqual([approved.answer.via, approved.answer.read_as, approved.answer.words], ["dashboard", "approve", null]);
  await browser.waitFor(`${focusPlace} === "line C2"`, { what: "the focus on C2's line after a" });
  await browser.key("Escape");
});

test("with needs you closed the line under the frame still names a stop and nothing is answered; the row's Approve button approves by mouse; reopen keeps the focus on the line", async () => {
  // The rough cut was approved on this revision, so the color would merge into it: a real edit asks the color on its own.
  await agent("edit", { project: "stops-r", ops: [moveTitle(780)] });
  await stopCheck("stops-r");
  const asked = await askStop("stops-r", "color");
  assert.equal(asked.id, "C3", asked.reply.text);
  await openOn("stops-r");
  await browser.waitFor(`!!${stopRow("C3")}`, { what: "C3 in needs you" });
  const caret = q('.p-session button[aria-controls="section-needs-you"]');
  await browser.click(caret, "the needs you caret");
  await browser.waitFor(`${caret}.getAttribute("aria-expanded") === "false"`, { what: "needs you closed" });
  // Closed, the stop is still never unseen: the line under the frame names it, with the a key's
  // word. Closing the section answers nothing.
  await browser.waitFor(`${pageHas("Look at the color pass, then approve it or ask for a redo.", ".voice .voice-line")} && ${pageHas("Approve color pass", ".voice .voice-answers")}`, { what: "the line under the frame for C3" });
  await sleep(300);
  assert.equal((await stopsOf("stops-r")).waiting?.id, "C3", "closing needs you answered nothing");
  await browser.click(caret, "the needs you caret");
  await browser.waitFor(`${caret}.getAttribute("aria-expanded") === "true" && !!${stopRow("C3")}`, { what: "needs you open again" });
  await browser.click(`[...(${stopRow("C3")})?.querySelectorAll("button") ?? []].find((element) => element.textContent.trim() === "Approve")`, "C3's Approve");
  const round = await until(async () => { const found = await roundOf("stops-r", "C3"); return found?.status === "answered" ? found : null; }, "C3 approved by the row's button");
  assert.deepEqual([round.answer.via, round.answer.read_as], ["dashboard", "approve"]);
  // The row and its button are gone, and no other row waits: the focus goes to the section's caret.
  await browser.waitFor(`!${stopRow("C3")} && document.activeElement === ${caret}`, { what: "the focus on the needs you caret after the row's approve" });
  // Reopen C3 by keyboard: the button goes, and the focus goes to C3's line.
  const reopen = `document.querySelector('#section-stops [data-stop-line="C3"] button[aria-label^="Reopen C3:"]')`;
  await browser.waitFor(`!!${reopen}`, { what: "C3's reopen" });
  await browser.evaluate(`${reopen}.focus()`);
  await browser.key("Enter");
  await browser.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { what: "the reopen question" });
  await browser.key("y");
  await until(async () => (await roundOf("stops-r", "C3"))?.status === "reopened", "C3 reopened");
  await browser.waitFor(`!${reopen} && ${focusPlace} === "line C3"`, { what: "the focus on C3's line after reopen" });
});

test("at phone width a chat answer to a stop keeps its line, with reopen and the footnote, at the top of the stack; the top line says it", async () => {
  await stopCheck("stops-r");
  const asked = await askStop("stops-r", "color");
  assert.equal(asked.id, "C4", asked.reply.text);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  try {
    await openOn("stops-r");
    await browser.waitFor(`${q(".phone-stack")}?.firstElementChild?.matches('article.stop-card[aria-labelledby="stop-C4"]')`, { what: "C4's card first on the phone" });
    await stopGap(asked.at);
    const recorded = await agent("notes", { project: "stops-r", action: "answer", id: "C4", rev: asked.rev, words: "ok", read_as: "approve" });
    assert.equal(recorded.isError, undefined, recorded.text);
    const round = await roundOf("stops-r", "C4");
    const clock = await pageClock(round.answer.at);
    const line = `C4 color pass · approved in chat: "ok" · ${round.answer.afterSeconds} s after asking · ${clock} · recorded by the agent`;
    await browser.waitFor(`${q(".phone-stack")}?.firstElementChild?.matches("article.stop-done") && ${pageHas(line, ".phone-stack .stop-done")}`, { what: "C4's line at the top of the stack" });
    const place = await browser.evaluate(`(() => { const card = ${q(".phone-stack .stop-done")}; const reopen = card.querySelector('button[aria-label^="Reopen C4:"]');
      return { bottom: Math.round(card.getBoundingClientRect().bottom), reopen: !!reopen, footnote: card.querySelector(".stop-footnote")?.textContent ?? "", page: document.documentElement.scrollWidth }; })()`);
    assert.ok(place.bottom <= 844, `the card is on the first screen: ${JSON.stringify(place)}`);
    assert.ok(place.reopen, "with its reopen button");
    assert.equal(place.footnote, "answers in chat are recorded by the agent; kino cannot check them: reopen one that is not what you said");
    assert.ok(place.page <= 390, "no sideways scrolling");
    assert.equal(await browser.evaluate(topMessage), 'C4 approved in chat (recorded by the agent): "ok".', "the top line says what the agent recorded");
    await browser.shot("stop-phone-chat-answer");
    await browser.tap(button("Dismiss", ".phone-stack .stop-done"));
    await browser.waitFor(`!document.querySelector(".phone-stack .stop-done")`, { what: "dismissed" });
  } finally {
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test("a stop waiting in a project that is not open shows in needs you, the status line and the title; Enter opens that project", async () => {
  await stopVideo("stops-x");
  await openOn("stops-r");
  // Follow off: the dashboard stays on stops-r while the agent works in stops-x.
  await browser.evaluate("document.activeElement?.blur()");
  await browser.key("f");
  await browser.waitFor(`${topMessage} === "Follow agent off."`, { what: "follow off" });
  const asked = await askStop("stops-x", "rough");
  assert.equal(asked.id, "C1", asked.reply.text);
  const row = `document.querySelector('#section-needs-you [aria-label^="Stop C1 in stops-x:"]')`;
  // On a wide window the status line no longer names the stop: the Crew tab counts it.
  await browser.waitFor(`!!${row} && ${q('.tabs [aria-label=", 1 waiting for you"]')} !== null && document.title.startsWith("1 awaiting")`, { what: "C1 of stops-x in needs you, the Crew tab and the title" });
  assert.ok(await browser.evaluate(`${onProject("stops-r")}`), "stops-r stays open");
  assert.match(await browser.evaluate(assertiveText), /^C1 needs you in stops-x: the rough cut is ready\./);
  // a does not answer it unseen: it says how to open it.
  await showView("session");
  await browser.key("a");
  await browser.waitFor(`${topMessage}.startsWith("C1 waits in stops-x: press Enter")`, { what: "a says to open stops-x" });
  assert.equal((await stopsOf("stops-x")).waiting?.id, "C1");
  await browser.key("Enter");
  await browser.waitFor(`${onProject("stops-x")} && !!${stopRow("C1")}`, { what: "stops-x open with C1 in needs you" });
  // C1 was announced when it started waiting; opening stops-x does not announce it again.
  await sleep(500);
  assert.match(await browser.evaluate(assertiveText), /^C1 needs you in stops-x: the rough cut is ready\./, "no second alert for C1");
  await asDashboard("stops", { project: "stops-x", action: "answer", id: "C1", rev: asked.rev, read_as: "approve" });
  await browser.key("f");
});

test("a key meant for a stop answered in the chat answers nothing else: the long final render that moved up is named first", async () => {
  // A final render of 720 frames (over the 600-frame limit) waits for the person, then the rough
  // cut. The render is asked before the brief: with a brief, a final waits for the stops (B2c).
  await stopVideo("stops-k", { brief: false });
  // A final render of a whole video needs every moment reviewed first (backend/agent/review.mjs).
  for (let round = 0; round < 40; round += 1) if (!(await agent("look", { project: "stops-k", mode: "review", inline: false })).data.left) break;
  const render = await agent("render", { project: "stops-k", action: "start", quality: "final", format: "mp4" });
  assert.equal(render.data?.status, "awaiting_approval", render.text);
  await saveStopBrief("stops-k");
  const asked = await askStop("stops-k", "rough");
  assert.equal(asked.id, "C1", asked.reply.text);
  await openOn("stops-k");
  const request = `document.querySelector('#section-needs-you [data-need="${render.data.id}"]') ?? [...document.querySelectorAll("#section-needs-you .needs-you")].find((row) => row.textContent.includes(${JSON.stringify(render.data.id)}))`;
  await browser.waitFor(`${q("#section-needs-you .needs-you")} === ${stopRow("C1")} && !!(${request})`, { what: `C1 first in needs you, ${render.data.id} after it` });
  await showView("session");
  // The agent records the person's chat answer: C1 leaves, and the request moves up under the cursor.
  await stopGap(asked.at);
  const recorded = await agent("notes", { project: "stops-k", action: "answer", id: "C1", rev: asked.rev, words: "sounds good", read_as: "approve" });
  assert.equal(recorded.isError, undefined, recorded.text);
  await browser.waitFor(`!${stopRow("C1")}`, { what: "C1 left needs you" });
  // a, pressed for C1, allows nothing: it names the request it would now act on.
  await browser.key("a");
  await browser.waitFor(`${topMessage}.startsWith(${JSON.stringify(`"needs you" changed, so nothing was answered: a now acts on ${render.data.id} (`)})`, { what: "a names the request" });
  await sleep(300);
  assert.equal((await approval(render.data.id)).status, "pending", "nothing was allowed");
  // The next key answers it: d denies it (no render runs).
  await browser.key("d");
  await until(async () => (await approval(render.data.id)).status === "denied", `${render.data.id} denied by the second press`);
});

// ---- the storyboard screen (B4b, board.jsx) -----------------------------------------------------
// A storyboard stop's card shows the board itself: every shot in words at the card's size, beside
// its source frame (the crop, the subject box and the eye line drawn on it) and its cropped still
// (the app's covered areas shaded), not the agent's shrunken page images. Footage: the Sintel test
// clip (tests/fixtures/footage/SOURCES.md, CC BY 3.0).

let sintelSrc = null;
async function sintel() {
  if (sintelSrc) return sintelSrc;
  const uploaded = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "sintel-village-dragon.mp4" },
    body: await readFile(path.join(root, "tests", "fixtures", "footage", "sintel-village-dragon.mp4")) });
  assert.ok([200, 201].includes(uploaded.status), await uploaded.clone().text());
  sintelSrc = (await uploaded.json()).src;
  return sintelSrc;
}

// Five shots of a 9:16 video of 8.8 s: the clip's three shots cropped to 9:16 (the second's
// dragon touches the crop's edge), then two title cards.
// Each shot names a built move, since the board stop refuses plain shots (move_needed).
const boardMove = { kind: "transition", name: "zoom-through", ref: "launch-film@7.27" };
const boardFootage = (src, cue, dur, x, extra = {}) => ({ cue, dur, pacing: "free", media: src, in: cue, crop: [x, 12, 24, 76], subject: { what: "the dragon", box: [x + 4, 30, 14, 30] },
  follow: "steady", text: "none", sound: "none", why: "the dragon over the village", move: boardMove, ...extra });
const boardTitle = (cue, dur, text) => ({ cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none", text: { text, family: "Inter" }, sound: "none", why: "the line on its own", move: boardMove });
const boardShots = (src) => [
  boardFootage(src, 0, 1.25, 20, { subject: { what: "the dragon", box: [24, 30, 14, 30], eyes: 40 } }),
  boardFootage(src, 1.25, 2.083, 38, { subject: { what: "the dragon", box: [38, 30, 14, 30] } }),
  boardFootage(src, 3.333, 1.084, 55),
  boardTitle(4.417, 2.2, "The dragon is back"), boardTitle(6.617, 2.183, "Look up"),
];

/** A video with that board, its brief settled ("just start"); `ask` asks its storyboard stop (C1). */
async function boardVideo(id, { ask = true, shots = boardShots } = {}) {
  const src = await sintel();
  // The stop tests above raised the board skip-under on this shared server: back to the default.
  await asDashboard("settings", { limits: { skipBoardUnder: 8 } }, "PUT");
  const made = await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: 8.8, background: "#101820" });
  assert.equal(made.isError, undefined, made.text);
  assert.equal((await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src } }] })).isError, undefined);
  assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" })).isError, undefined);
  // The person named the shape, so kino does not follow the 16:9 clip before the board.
  const tall = "a vertical video of the dragon";
  assert.equal((await agent("notes", { project: id, action: "brief", fields: { ask: tall, plays_on: { text: "vertical", by: "you", quote: tall } } })).isError, undefined);
  const board = await agent("edit", { project: id, ops: [{ op: "board", music: "none", calls: ["the dragon first: it is the news"], open: [], shots: shots(src) }] });
  assert.equal(board.isError, undefined, board.text);
  if (!ask) return { src, asked: null };
  const asked = await askStop(id, "board");
  assert.equal(asked.id, "C1", asked.reply.text);
  return { src, asked };
}

/**
 * One board video with its storyboard stop waiting, shared by the tests that only look at the
 * board and never answer it (the phone, screen reader and retry tests): made once, on first use.
 */
let boardToView;
function boardViewVideo() {
  boardToView ??= boardVideo("board-view").then(() => "board-view");
  return boardToView;
}

/** The shot panel (the shot in it is the board's article) and each shot's clip on the timeline. */
const boardPanel = q("article.board-shot");
const boardRow = (shot) => q(`article.board-shot[data-shot="${shot}"]`);
const boardClips = `[...document.querySelectorAll(".board-clip")]`;
/** Puts a shot in the panel with its clip on the timeline. */
async function pickShot(shot) {
  await browser.click(q(`.board-clip[data-shot="${shot}"]`));
  await browser.waitFor(`!!${boardRow(shot)}`, { what: `shot ${shot} in the panel` });
}
/** Opens the panel's "crop and numbers", where the source frame and its boxes are drawn. */
const openCropDetails = `(() => { const details = ${boardPanel}?.querySelector(".board-more"); if (details) details.open = true; return details ? 1 : 0; })()`;
/** The panel's source frame is drawn (after openCropDetails). */
const sourceDrawn = `!!${boardPanel}?.querySelector(".board-source")`;
/** The panel's pictures (its frames and option stills) have loaded. */
const boardPictures = `(() => {
  const images = [...(${boardPanel}?.querySelectorAll(".board-frame img, .option-picture img") ?? [])];
  return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
})()`;
/** What the panel shows: its head, its frames, each layer line by name, the drawn boxes and labels. */
const boardSeen = `(() => {
  const row = ${boardPanel};
  const box = (element) => ["x", "y", "width", "height"].map((name) => Number(element.getAttribute(name)));
  return {
    shot: row.dataset.shot, notes: row.hasAttribute("data-notes"), why: row.querySelector(".board-why")?.textContent.trim() ?? null, head: row.querySelector(".board-row-head").innerText.replace(/\\s+/g, " ").trim(),
    frames: [...row.querySelectorAll(".shot-frames figure")].map((figure) => [new URL(figure.querySelector("img")?.src ?? "http://x/").searchParams.get("part"), figure.querySelector("figcaption").textContent.trim()]),
    length: row.querySelector(".shot-length output, .shot-length .shot-length-value")?.textContent.trim() ?? null,
    lines: Object.fromEntries([...row.querySelectorAll(".board-lines > div")].map((line) => [line.querySelector("dt").textContent.trim(), line.querySelector("dd").textContent.trim()])),
    tags: [...row.querySelectorAll(".board-tags li")].map((tag) => tag.textContent.trim()),
    options: [...row.querySelectorAll(".board-option")].map((option) => [option.querySelector(".option-letter").textContent, option.querySelector(".option-why").textContent, option.getAttribute("aria-pressed")]),
    crop: row.querySelector("rect.board-crop") ? box(row.querySelector("rect.board-crop")) : null,
    subjects: [...row.querySelectorAll("rect.board-subject")].map(box),
    eyes: !!row.querySelector("line.board-eyes"),
    labels: [...row.querySelectorAll(".board-label")].map((label) => label.innerText.trim()),
    missing: row.querySelector(".board-missing")?.innerText.trim() ?? null,
    buttons: [...row.querySelectorAll(".shot-actions button")].map((button) => button.innerText.trim()),
  };
})()`;
/** Nothing on the page reaches past the window's right edge (a sideways scroll). */
const sidewaysOverflow = `(() => {
  const width = document.documentElement.clientWidth;
  // The rough cut's footage reaches past its monitor, which clips it (the crop).
  const past = [...document.querySelectorAll(".dash *")].filter((element) => !element.closest(".sr-only") && !element.parentElement?.closest(".cut-monitor") && element.getBoundingClientRect().right > width + 0.5);
  return { width, scroll: document.scrollingElement.scrollWidth, past: past.slice(0, 5).map((element) => element.className || element.tagName) };
})()`;
/** How tall the page is against the window: the page itself never scrolls (each pane, card and stack does). */
const pageHeight = `({ window: innerHeight, page: document.scrollingElement.scrollHeight })`;
/** The font sizes the board's words are drawn at (the rough cut's text is drawn at the video's size). */
const boardFontSizes = `[...new Set([...document.querySelectorAll(".board .board-title, .board-head p, .board-chips li, .cut-clock, .board-row-head, .board-why, .board-tags li, .board-lines dt, .board-lines dd, .board-label, .board figcaption, .board-covered, .board-section, .board-list li, .board summary, .board-note label, [data-note-open], .option-why, .stepper output, .board-lane-name, .board-lane-item, .board-lane-empty, .clip-role, .answer-chips li")].map((element) => getComputedStyle(element).fontSize))]`;

/** The redesign draws the board's words in a small scale (12 to 15 px) where the old card had one size (13 px). */
async function inBoardScale(what) {
  const sizes = await browser.evaluate(boardFontSizes);
  assert.ok(sizes.length > 0 && sizes.every((size) => ["12px", "13px", "14px", "15px"].includes(size)), `${what}: ${JSON.stringify(sizes)}`);
}

async function atPhone(run) {
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    await browser.waitFor(`!!document.querySelector(".dash.phone")`, { what: "the phone layout" });
    return await run();
  } finally {
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.waitFor(`!document.querySelector(".dash.phone")`, { what: "the wide layout" });
  }
}

/** Opens the storyboard stop's screen from its "needs you" row. */
async function openBoardStop(id, stop = "C1") {
  await openOn(id);
  await browser.waitFor(`!!${stopRow(stop)}`, { what: `${stop} in needs you` });
  await browser.click(stopOpen(stop));
  await browser.waitFor(`!!document.querySelector('article.stop-card[aria-labelledby="stop-${stop}"]') && ${boardClips}.length === 5`, { what: `${stop}'s card with its 5 shots` });
}

test("storyboard screen: the rough cut, the shot box and the shot stills show every layer; a approves it, and kino keeps the board it showed", { skip: skipWithoutMediaTools }, async () => {
  const id = "board-layers";
  const { asked } = await boardVideo(id);
  const data = await (await server.api(`/api/dashboard/board-data?project=${id}&stop=C1`)).json();
  await openBoardStop(id);
  // The shot box (the rough cut and the shot) is closed until a still is clicked.
  await pickShot("S1");
  const card = await browser.evaluate(`(() => {
    const card = ${q("article.stop-card")};
    return {
      heading: document.getElementById("stop-C1").innerText.replace(/\\s+/g, " ").trim(),
      head: [...card.querySelectorAll(".board-head p")].map((line) => line.innerText.trim()),
      chips: [...card.querySelectorAll(".board-chips li")].map((chip) => chip.textContent.trim()),
      calls: [card.querySelector(".board-calls-box summary").innerText.trim(), card.querySelector(".board-calls-box").open,
        [...card.querySelectorAll(".board-calls li")].map((call) => [call.querySelector(".call-words").textContent.trim(), call.querySelector(".call-no")?.getAttribute("aria-pressed") ?? null])],
      cut: { play: card.querySelector(".cut-play").getAttribute("aria-label"), clock: card.querySelector(".cut-clock").textContent.trim(),
        covered: [...card.querySelectorAll(".reel-covered .board-covered")].map((area) => area.textContent.trim()) },
      videos: [...document.querySelectorAll(".board-cut video")].map((video) => [video.muted, video.paused, new URL(video.src).pathname]),
      clips: [...card.querySelectorAll(".board-clip")].map((clip) => clip.dataset.shot),
      roles: [...card.querySelectorAll(".clip-role")].map((role) => role.textContent),
      title: card.querySelector(".board-title")?.textContent.trim() ?? null,
      answers: [...card.querySelectorAll(".stop-answer button")].map((button) => button.innerText.trim()),
      stills: card.querySelectorAll(".stills-grid img").length, watch: !!card.querySelector(".stop-watch"),
    };
  })()`);
  assert.equal(card.heading, "C1, the storyboard, waits for you");
  assert.deepEqual(card.head, [], "no purpose line: the brief has none");
  assert.equal(card.title, "C1, board r1");
  assert.deepEqual(card.chips, ["5 shots", "8.8 s", "9:16", "Vertical", "No music", "Fresh eyes: not reported"]);
  assert.deepEqual(card.calls, ["Agent's calls\n1", false, [["the dragon first: it is the news", "false"]]], "folded away; each call takes a no");
  assert.deepEqual(card.cut, { play: "Play the rough cut (no sound)", clock: "0:00.0 / 0:08.8", covered: ["", "App (unverified)"] }, "the rough cut, with the app's covered areas on it");
  assert.deepEqual(card.videos, [[true, true, data.shots[0].media.src]], "one file, muted, still until play");
  assert.deepEqual(card.clips, ["S1", "S2", "S3", "S4", "S5"]);
  assert.deepEqual(card.roles, data.shots.map((shot, index) => (shot.role ? `${index + 1} ${shot.role[0].toUpperCase()}${shot.role.slice(1)}` : null)).filter(Boolean), "the story roles kino picks moves for, in the number chip");
  assert.deepEqual(card.answers, ["Approve", "Change"], "no changes yet: approve, and Change (which presses redo)");
  assert.deepEqual([card.stills, card.watch], [0, false], "no stills of the stage and no watch line: nothing is built yet");

  // Shot 1 in the box: its first and last frame, its length, its layers, kino's numbers.
  await browser.waitFor(boardPictures, { timeout: 60_000, what: "shot 1's pictures" });
  assert.equal(await browser.evaluate(openCropDetails), 1);
  await browser.waitFor(sourceDrawn, { what: "shot 1's source frame" });
  const one = await browser.evaluate(boardSeen);
  assert.deepEqual([one.shot, one.notes, one.head, one.why, one.frames, one.tags, one.options, one.buttons],
    ["S1", true, "Shot 1 Hook", "The dragon over the village", [["still", "0 s"], ["last", "1.3 s"]], ["Zoom through"], [], ["Remove shot", "Note"]]);
  assert.match(one.length, /^1\.3 s$/);
  assert.equal(one.lines.Footage, "sintel-village-dragon.mp4 from 0 s, crop 24 × 76% at 20, 12");
  assert.equal(one.lines.Subject, "the dragon, box by the agent");
  assert.match(one.lines.Measured, /^\d+% in the crop, (edge \d+%|touches the edge), eyes \d+% from the top$/);
  assert.deepEqual([one.lines.Follow, one.lines.Pacing, one.lines.Text, one.lines.Sound, one.lines.Why], ["steady", "free", "none", "none", "the dragon over the village"]);
  assert.deepEqual([one.crop, one.subjects, one.eyes, one.labels], [[20, 12, 24, 76], [[24, 30, 14, 30]], true, ["crop", "agent", "eyes"]], "the boxes in % of the source frame");
  await browser.shot("board-desktop-top");
  // A press on a shot's clip puts it in the panel and the playhead at its start.
  await pickShot("S2");
  await browser.evaluate(openCropDetails);
  const two = await browser.evaluate(boardSeen);
  assert.ok(two.tags.includes("Subject touches the crop edge"), JSON.stringify(two.tags));
  assert.ok(two.lines["Look at"].includes("subject touches the crop edge"), JSON.stringify(two.lines));
  await pickShot("S4");
  assert.equal(await browser.evaluate(textOf(".cut-clock")), "0:04.4 / 0:08.8");
  await browser.evaluate(openCropDetails);
  // A slow runner draws the title card's "no footage" line a moment after the panel.
  await browser.waitFor(`${boardPanel}?.dataset.shot === "S4" && !!${boardPanel}.querySelector(".board-missing")`, { what: "shot 4's no footage line" });
  const four = await browser.evaluate(boardSeen);
  assert.deepEqual([four.frames, four.tags, four.lines.Footage, four.lines.Subject, four.missing, four.crop],
    [[["still", "Title card"]], ['"The dragon is back"', "Zoom through"], "none", "none", "No footage", null]);
  assert.match(four.lines.Text, /^"The dragon is back", Inter \d00, \d+ px, y \d+%$/);
  assert.equal(await browser.evaluate(textOf(".cut-text")), "The dragon is back", "the rough cut draws the title card's text");
  await inBoardScale("every word at the card's own sizes");
  const tall = await browser.evaluate(pageHeight);
  assert.ok(tall.page <= tall.window, `the page itself does not scroll: ${JSON.stringify(tall)}`);
  // The answers stay at the bottom of the window while the board scrolls under them.
  const pinned = await browser.evaluate(`(() => {
    const wrap = ${q(".screen-wrap.is-stop")};
    wrap.scrollTop = 0;
    const bar = ${q(".stop-answer")}.getBoundingClientRect();
    const view = wrap.getBoundingClientRect();
    return bar.bottom <= view.bottom + 1 && bar.top >= view.top;
  })()`);
  assert.equal(pinned, true, "approve is in view at the board's top");
  await browser.shot("board-desktop-title-card");
  // Play runs the shots at their lengths from the playhead; the panel follows it.
  await pickShot("S1");
  await browser.click(q(".cut-play"));
  await browser.waitFor(`${boardPanel}?.dataset.shot === "S2"`, { timeout: 5_000, what: "the rough cut at shot 2" });
  await browser.click(q(".cut-play"));
  assert.equal(await browser.evaluate(`${q(".cut-play")}.getAttribute("aria-pressed")`), "false", "pause");
  assert.equal(await browser.evaluate(`[...document.querySelectorAll(".board-cut video")].every((video) => video.paused)`), true, "the file stops with it");
  await atPhone(async () => {
    await browser.waitFor(`${boardClips}.length === 5`, { what: "the board at 390 px" });
    const overflow = await browser.evaluate(sidewaysOverflow);
    assert.ok(overflow.scroll <= overflow.width && !overflow.past.length, JSON.stringify(overflow));
    const phoneTall = await browser.evaluate(pageHeight);
    assert.ok(phoneTall.page <= phoneTall.window, `the page itself does not scroll at 390 px: ${JSON.stringify(phoneTall)}`);
    await inBoardScale("every word at the card's own sizes at 390 px");
    await browser.waitFor(boardPictures, { timeout: 60_000, what: "the panel's pictures at 390 px" });
    await browser.shot("board-phone-stop-screen");
  });

  // a on the card approves it: kino keeps the board the card showed, approved on the dashboard.
  await stopGap(asked.at);
  await browser.evaluate("document.activeElement?.blur()");
  await browser.key("a");
  const round = await until(async () => { const found = await roundOf(id, "C1"); return found?.status === "answered" ? found : null; }, "C1 approved");
  assert.deepEqual([round.answer.via, round.answer.read_as], ["dashboard", "approve"]);
  const { approved } = (await stopsOf(id)).board;
  assert.deepEqual([approved.stop, approved.rev, approved.by, approved.lapsed], ["C1", asked.rev, "dashboard", null]);
  await browser.key("Escape");
});

test("storyboard screen: c leaves a note on shot 2 and Enter sends it with the card's note; the agent hears both and the stop line names the shot", { skip: skipWithoutMediaTools }, async () => {
  const id = "board-notes";
  const { asked } = await boardVideo(id);
  await openBoardStop(id);
  // c with no shot picked says how to pick one (review round 1 of B4b: it did nothing).
  assert.equal(await browser.evaluate(`document.activeElement.matches("section.screen")`), true, "the stop screen has the focus as it opens");
  await browser.key("c");
  await browser.waitFor(`${topMessage} === "Press j or k to pick a shot, then c to leave a note on it."`, { what: "c: pick a shot first" });
  // j puts the focus on the panel (shot 1), then the next shot goes into it; c opens shot 2's note.
  await browser.evaluate("document.activeElement?.blur()");
  await browser.key("j");
  await browser.waitFor(`document.activeElement === ${boardRow("S1")}`, { what: "j: shot 1 in the panel" });
  await browser.key("j");
  await browser.waitFor(`document.activeElement === ${boardRow("S2")}`, { what: "j: shot 2 in the panel" });
  await browser.key("k");
  await browser.waitFor(`document.activeElement === ${boardRow("S1")}`, { what: "k: back to shot 1" });
  await browser.key("j");
  await browser.waitFor(`document.activeElement === ${boardRow("S2")}`, { what: "j: shot 2 again" });
  await browser.key("c");
  await browser.waitFor(`document.activeElement?.id === "board-note-S2"`, { what: "c: shot 2's note" });
  assert.equal(await browser.evaluate(`document.activeElement.labels[0].textContent`), "Note on shot 2");
  assert.equal(await browser.evaluate(`document.activeElement.maxLength`), 500);
  assert.equal(await browser.evaluate(`document.activeElement.placeholder`), "Goes with your answer");
  await browser.type("tighter");
  await browser.key("Escape");
  await browser.waitFor(`document.activeElement === ${boardRow("S2")}`, { what: "Esc: back on shot 2" });
  assert.equal(await browser.evaluate(`${q("#board-note-S2")}.value`), "tighter", "Esc keeps the note");
  await browser.waitFor(`${textOf(".answer-chips")}.startsWith("Shot 2: note")`, { what: "the note's chip in the answer bar" });
  assert.equal(await browser.evaluate(`[...document.querySelectorAll(".stop-answer .actions button")].map((button) => button.innerText.trim()).join(" | ")`), "Approve | Send 1 change");
  // Tab on the panel goes to the card's note, not back into the shot's.
  await browser.key("Tab");
  await browser.waitFor(`document.activeElement?.id === "stop-note-C1"`, { what: "Esc, then Tab: the card's note" });
  assert.equal(await browser.evaluate(`document.activeElement.placeholder`), "Note for the agent");
  await browser.waitFor(boardPictures, { timeout: 60_000, what: "shot 2's pictures" });
  await browser.shot("board-note-desktop");
  await atPhone(async () => {
    await browser.waitFor(`!!${q("#board-note-S2")}`, { what: "the note at 390 px" });
    await browser.evaluate(`${boardRow("S2")}.scrollIntoView({ block: "start" })`);
    await browser.shot("board-note-phone");
  });
  await browser.type("warmer");
  await stopGap(asked.at);
  await browser.key("Enter");
  const round = await until(async () => { const found = await roundOf(id, "C1"); return found?.status === "answered" ? found : null; }, "C1 answered");
  assert.deepEqual([round.answer.read_as, round.answer.words, round.answer.shots], ["approve with notes", "warmer", [{ id: "S2", n: 2, words: "tighter" }]]);
  // The answered board's status line says how it was answered and when; the card's note is its own
  // line, and the shot with a note has the note mark on its still (the seconds after asking are no longer drawn).
  const line = await browser.waitFor(`(() => { const text = ${textOf(".board-status .voice-line")}; return text.startsWith("Answered") && text; })()`, { what: "C1's board status line" });
  assert.match(line, /^Answered: approved with notes on the dashboard at \d\d:\d\d/);
  assert.equal(await browser.evaluate(textOf(".board-answer-note")), 'Your note: "warmer"');
  assert.equal(await browser.evaluate(`${boardClips}.filter((clip) => clip.querySelector(".mark-note")).map((clip) => clip.dataset.shot).join()`), "S2", "the note on shot 2 is marked on its still");
  const heard = await agent("status", { project: id });
  assert.ok(inboxText(heard).includes('C1 board approved by the person in kino, with notes: "warmer"; on shot 2 (S2): "tighter". Make those changes (shot 2), then go on.'), inboxText(heard));
  // Answered: the board shows read only, with the notes it got.
  await browser.waitFor(`${boardClips}.length === 5 && !document.querySelector("[data-notes], [data-note-open], .stop-card")`, { what: "C1's board read only" });
  await pickShot("S2");
  assert.equal(await browser.evaluate(textOf(`article.board-shot[data-shot="S2"] .board-your-note`)), 'Your note: "tighter"');
  await browser.key("Escape");
});

test("storyboard screen: an option, a new length and remove shot are sent as changes; the agent's new ask says what changed as asked and without being asked", { skip: skipWithoutMediaTools }, async () => {
  const id = "board-redo";
  // Shot 2 comes with one other option: the same file, a wider crop.
  const withOption = (src) => boardShots(src).map((shot, index) => (index === 1 ? { ...shot, alts: [{ crop: [30, 12, 24, 76], why: "wider, the roofs too" }] } : shot));
  const { src, asked } = await boardVideo(id, { shots: withOption });
  await openBoardStop(id);
  await pickShot("S2");
  await browser.waitFor(`${boardPanel}.querySelectorAll(".board-option").length === 2`, { what: "shot 2's options" });
  await browser.click(`${boardPanel}.querySelectorAll(".board-option")[1]`);
  await browser.click(`${boardPanel}.querySelector('.stepper button[aria-label^="Longer"]')`);
  await browser.click(`${boardPanel}.querySelector('.stepper button[aria-label^="Longer"]')`);
  const two = await browser.evaluate(boardSeen);
  assert.deepEqual([two.options, two.length, two.frames], [[["A", "The dragon over the village", "false"], ["", "Wider, the roofs too", "true"]], "2.3 s", [["alt1", "1.3 s"]]]);
  assert.equal(await browser.evaluate(textOf(".shot-length .board-change")), "Was 2.1 s");
  await pickShot("S3");
  await browser.click(button("Remove shot", "article.board-shot"));
  await browser.waitFor(`${q(".board-clip.removed")}?.dataset.shot === "S3"`, { what: "shot 3 removed on the timeline" });
  // The rough cut plays the board as directed: 0.2 s longer, 1.1 s shorter.
  assert.equal(await browser.evaluate(textOf(".cut-clock")).then((text) => text.split(" / ")[1]), "0:07.9");
  const bar = await browser.evaluate(`({ chips: [...document.querySelectorAll(".answer-chips li")].map((chip) => chip.firstChild.textContent.trim()),
    buttons: [...document.querySelectorAll(".stop-answer .actions button")].map((button) => button.innerText.trim()) })`);
  assert.deepEqual(bar, { chips: ["Shot 2: wider, the roofs too", "Shot 2: 2.3 s", "Shot 3: remove"], buttons: ["Approve", "Send 3 changes"] });
  await browser.waitFor(boardPictures, { timeout: 60_000, what: "shot 3's pictures" });
  await browser.shot("board-directed-desktop");
  // × takes one back; d sends the rest as a redo.
  await browser.click(`${q(".answer-chips")}.querySelectorAll("button")[1]`);
  await browser.waitFor(`${q(".answer-chips")}.querySelectorAll("li").length === 2`, { what: "the length taken back" });
  await stopGap(asked.at);
  await browser.evaluate("document.activeElement?.blur()");
  await browser.key("d");
  const round = await until(async () => { const found = await roundOf(id, "C1"); return found?.status === "answered" ? found : null; }, "C1 redo");
  assert.deepEqual([round.answer.read_as, round.answer.words, round.answer.shots],
    ["redo", null, [{ id: "S2", n: 2, words: "use option B: wider, the roofs too" }, { id: "S3", n: 3, words: "remove this shot" }]]);
  // The agent takes option B on shot 2 (asked) and puts text on shot 1 (not asked), then asks again.
  const shots = withOption(src);
  shots[1] = boardFootage(src, 1.25, 2.083, 30, { subject: { what: "the dragon", box: [34, 30, 14, 30] } });
  shots[0] = { ...shots[0], text: { text: "Look", family: "Inter" } };
  const edited = await agent("edit", { project: id, ops: [{ op: "board", music: "none", calls: ["the dragon first: it is the news"], open: [], shots }] });
  assert.equal(edited.isError, undefined, edited.text);
  const again = await askStop(id, "board");
  assert.equal(again.id, "C2", again.reply.text);
  // The open stop screen follows the new ask.
  await browser.waitFor(`!!document.querySelector('article.stop-card[aria-labelledby="stop-C2"]') && ${pageHas("C2, board r2", ".board-title")}`, { what: "C2's card" });
  const head = await browser.evaluate(`[...document.querySelectorAll(".board-head .board-change")].map((line) => line.innerText.trim())`);
  assert.deepEqual(head, ["Changed as you asked in C1: shot 2", "Changed without being asked: shot 1 (text)", "Named but not changed: shot 3"]);
  // The shot box is closed (or on another shot) after the new ask: open shot 1's.
  if (!(await browser.evaluate(`${boardPanel}?.dataset.shot === "S1"`))) await pickShot("S1");
  await browser.evaluate(openCropDetails);
  assert.equal((await browser.evaluate(boardSeen)).lines.Change, "changed without being asked: text");
  assert.match(await browser.evaluate(`${q("#board-S1")}.textContent`), / Changed without being asked: text\.$/, "a screen reader hears it too");
  assert.equal(await browser.evaluate(`${boardClips}.filter((clip) => clip.querySelector(".mark-change")).length`), 3, "shots 1, 2 and 3 are marked on the timeline");
  await browser.waitFor(boardPictures, { timeout: 60_000, what: "C2's first pictures" });
  await browser.shot("board-redo-desktop");
  await atPhone(async () => {
    await browser.waitFor(`${boardClips}.length === 5`, { what: "C2 at 390 px" });
    await browser.evaluate(`${q(".board-head")}.scrollIntoView({ block: "start" })`);
    await browser.shot("board-redo-phone");
  });
  await browser.key("Escape");
});

test("storyboard screen: on a phone the card stacks the shot stills, the shot box and the rough cut; approve is near and nothing scrolls sideways at 390 px", { skip: skipWithoutMediaTools }, async () => {
  const id = await boardViewVideo();
  await openOn(id);
  await atPhone(async () => {
    await browser.waitFor(`${q(".phone-stack article.stop-card")} && ${boardClips}.length === 5`, { what: "the phone's card with the board" });
    // The shot box is closed until a still is tapped.
    await pickShot("S1");
    await browser.waitFor(boardPictures, { timeout: 60_000, what: "the panel's pictures" });
    // Review round 1 of B4b: the approve button was 3,507 px below the card's top (over 4 screens).
    const reach = await browser.evaluate(`(() => {
      const card = ${q(".phone-stack article.stop-card")}.getBoundingClientRect().top;
      return { approve: Math.round(${q(".phone-stack article.stop-card button.allow")}.getBoundingClientRect().top - card), screen: innerHeight };
    })()`);
    console.log(`# phone card: approve ${reach.approve} px below the card's top; screen ${reach.screen} px`);
    assert.ok(reach.approve <= 3 * reach.screen, JSON.stringify(reach));
    const overflow = await browser.evaluate(sidewaysOverflow);
    assert.ok(overflow.scroll <= overflow.width && !overflow.past.length, JSON.stringify(overflow));
    const tall = await browser.evaluate(pageHeight);
    assert.ok(tall.page <= tall.window, `the page itself does not scroll, only the stack: ${JSON.stringify(tall)}`);
    await inBoardScale("no word smaller than the card's");
    await browser.shot("board-phone-card");
    await browser.evaluate(`${q(".phone-stack .board-grid")}.scrollIntoView({ block: "start" })`);
    await browser.shot("board-phone-card-stills");
  });
});

// Review round 2 of B4b: an eye line at 3% had its label above the frame's top, a box ending at
// 98% across had its label past the right edge, and a crop at [0, 0] put its label on the box.
const edgeShots = (src) => [
  boardFootage(src, 0, 1.25, 74, { subject: { what: "the dragon", box: [86, 40, 12, 25], eyes: 3 } }),
  boardFootage(src, 1.25, 2.083, 0, { crop: [0, 0, 31.6, 100], subject: { what: "the dragon", box: [1, 1, 12, 20] } }),
  ...boardShots(src).slice(2),
];
/** Each label on the panel's source frame: whole inside it, off the subject boxes (the crop's) and off the other labels. */
const labelsPlaced = `(() => {
  const inside = (outer, inner) => inner.left >= outer.left - 0.5 && inner.top >= outer.top - 0.5 && inner.right <= outer.right + 0.5 && inner.bottom <= outer.bottom + 0.5;
  const meet = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const row = ${boardPanel};
  const frame = row.querySelector(".board-source .board-frame").getBoundingClientRect();
  const labels = [...row.querySelectorAll(".board-label")].map((label) => ({ text: label.innerText.trim(), box: label.getBoundingClientRect(), crop: label.classList.contains("crop") }));
  const subjects = [...row.querySelectorAll("rect.board-subject")].map((box) => box.getBoundingClientRect());
  return {
    shot: row.dataset.shot, labels: labels.map((label) => label.text),
    cut: labels.filter((label) => !inside(frame, label.box)).map((label) => label.text),
    onBox: labels.filter((label) => label.crop && subjects.some((box) => meet(label.box, box))).map((label) => label.text),
    onLabel: labels.filter((label, index) => labels.some((other, at) => at !== index && meet(label.box, other.box))).map((label) => label.text),
  };
})()`;

test("storyboard screen: labels by the frame's edges stay whole, and the crop's label keeps off the subject box", { skip: skipWithoutMediaTools }, async () => {
  const id = "board-edges";
  await boardVideo(id, { shots: edgeShots });
  await openBoardStop(id);
  const placed = { S1: { shot: "S1", labels: ["crop", "agent", "eyes"], cut: [], onBox: [], onLabel: [] }, S2: { shot: "S2", labels: ["crop", "agent"], cut: [], onBox: [], onLabel: [] } };
  const check = async (width) => {
    for (const shot of ["S1", "S2"]) {
      await pickShot(shot);
      await browser.evaluate(openCropDetails);
      await browser.waitFor(`${sourceDrawn} && ${boardPictures}`, { timeout: 60_000, what: `shot ${shot}'s pictures at ${width}` });
      assert.deepEqual(await browser.evaluate(labelsPlaced), placed[shot], `at ${width}`);
      await browser.evaluate(`${boardPanel}.querySelector(".board-source").scrollIntoView({ block: "center" })`);
      await browser.shot(`board-edges-${width}-${shot}`);
    }
  };
  await check("1440");
  await atPhone(() => check("390"));
  await browser.key("Escape");
});

test("storyboard screen: a screen reader hears the shot as one sentence and not the pictures; nothing moves and no video plays until play", { skip: skipWithoutMediaTools }, async () => {
  const id = await boardViewVideo();
  const data = await (await server.api(`/api/dashboard/board-data?project=${id}&stop=C1`)).json();
  const { shotSentence } = await import("../frontend/dashboard/boardRows.js");
  await openBoardStop(id);
  // A finished entrance fade (the line under the frame, kept by its fill) is not motion: nothing is running.
  // The line under the frame fades in as the screen opens (240 ms): let it finish, then nothing runs.
  const running = `document.getAnimations().filter((animation) => animation.playState !== "finished").map((animation) => animation.animationName ?? animation.transitionProperty)`;
  await browser.waitFor(`${running}.length === 0`, { what: "the entrance fade finished", timeout: 3000 }).catch(() => {});
  assert.deepEqual(await browser.evaluate(running), [], "nothing on the board moves, even without reduced motion");
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    assert.equal(await browser.evaluate(`matchMedia("(prefers-reduced-motion: reduce)").matches`), true);
    for (const shot of data.shots.slice(0, 2)) {
      await pickShot(shot.id);
      const nodes = await readNodes();
      const sentence = shotSentence(shot, data);
      assert.ok(nodes.some((node) => node.role === "article" && node.name === sentence), `shot ${shot.n}'s panel is read as ${sentence}`);
      // The pictures, boxes, labels and layer tags are hidden from it: the sentence says them.
      const all = new Map(nodes.map((entry) => [entry.node.nodeId, entry]));
      const { nodes: raw } = await browser.send("Accessibility.getFullAXTree");
      const children = new Map(raw.map((node) => [node.nodeId, node.childIds ?? []]));
      const inShot = [];
      const walk = (nodeId) => { if (all.has(nodeId)) inShot.push(all.get(nodeId)); for (const child of children.get(nodeId) ?? []) walk(child); };
      for (const entry of nodes.filter((node) => node.role === "article")) walk(entry.node.nodeId);
      assert.ok(inShot.length > 1, "the panel has parts");
      for (const word of ["agent", "eyes", "App (unverified)", "Zoom through", `Shot ${shot.n}`]) assert.ok(!inShot.some((node) => node.name === word), `${word} is not read on its own`);
      // Its buttons are read: they are outside the hidden parts.
      assert.ok(nodes.some((node) => node.role === "button" && node.name === "Note"), `shot ${shot.n}'s note button`);
      assert.ok(nodes.some((node) => node.role === "button" && node.name === "Next shot"), "the next shot button");
    }
    assert.equal(await browser.evaluate(`${boardPanel}.getAttribute("aria-labelledby")`), "board-S2");
    assert.equal(await browser.evaluate(`[...document.querySelectorAll(".shot-frames, .board-tags")].every((part) => part.getAttribute("aria-hidden") === "true")`), true);
    await browser.waitFor(boardPictures, { timeout: 60_000, what: "the pictures" });
    const still = await browser.evaluate(`({ animations: document.getAnimations().length, playing: [...document.querySelectorAll("video")].filter((video) => !video.paused).length,
      transitions: [...new Set([...document.querySelectorAll(".board, .board *")].map((element) => getComputedStyle(element).transitionDuration))] })`);
    assert.deepEqual(still, { animations: 0, playing: 0, transitions: ["0s"] });
    await browser.shot("board-reduced-motion-desktop");
    await atPhone(async () => {
      await browser.waitFor(`${boardClips}.length === 5`, { what: "the board at 390 px" });
      assert.equal(await browser.evaluate(`document.getAnimations().length + [...document.querySelectorAll("video")].filter((video) => !video.paused).length`), 0);
      await browser.shot("board-reduced-motion-phone");
    });
  } finally {
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  }
  await browser.key("Escape");
});

test("storyboard screen: a board that could not be read says so and try again reads it; a picture that failed says so and retry draws it", { skip: skipWithoutMediaTools }, async () => {
  const id = await boardViewVideo();
  await openOn(id);
  await browser.waitFor(`!!${stopRow("C1")}`, { what: "C1 in needs you" });
  // Until the test says so, the page's board reads ask for a project that does not exist (the
  // dev build reads twice on opening, so not "once").
  await browser.evaluate(`(() => {
    const real = window.fetch;
    window.boardReadFails = true;
    window.fetch = (url, options) => {
      if (window.boardReadFails && String(url).includes("/api/dashboard/board-data")) url = String(url).replace("project=${id}", "project=no-such-video");
      return real(url, options);
    };
  })()`);
  await browser.click(stopOpen("C1"));
  const alert = await browser.waitFor(`${q(".board-error [role=alert]")}?.textContent`, { what: "the alert" });
  assert.equal(alert, "The storyboard could not be read: This project could not be found.", "the server's words");
  // role=alert (read at once); its words are in the tree a screen reader reads.
  const nodes = await readNodes();
  assert.ok(nodes.some((node) => node.role === "StaticText" && node.name.includes("This project could not be found")), "a screen reader can read it");
  assert.equal(await browser.evaluate(`${q(".board-error p")}.closest("[aria-hidden=true], [inert]")`), null);
  // The agent's ask shows in the board's place (review round 1 of B4b): approve stays, and what
  // it approves is there in words.
  const sent = await browser.evaluate(`${q('.board-error [role=group][aria-label="What the agent sends you"]')}?.innerText`);
  assert.match(sent ?? "", /^The storyboard is ready \(C1\): 5 shots/, sent);
  assert.match(sent, /\n+Reply: approve · approve with notes: \.\.\. · redo: \.\.\.$/);
  assert.ok(nodes.some((node) => node.role === "group" && node.name === "What the agent sends you"), "a screen reader finds the ask");
  await browser.shot("board-error-desktop");
  await browser.evaluate("window.boardReadFails = false");
  await browser.click(button("Try again", ".board-error"));
  await browser.waitFor(`${boardClips}.length === 5 && document.activeElement === ${q(".board-title")}`, { what: "the board, with the focus on its first line" });
  // A picture that fails shows its words in its place and a retry (the source frame is in "Crop and numbers").
  await pickShot("S1");
  await browser.evaluate(openCropDetails);
  await browser.waitFor(`${sourceDrawn} && ${boardPictures}`, { timeout: 60_000, what: "shot 1's pictures" });
  await browser.evaluate(`${boardRow("S1")}.querySelector(".board-source img").dispatchEvent(new Event("error"))`);
  await browser.waitFor(pageHas("the source frame of shot 1, at 0 s could not be shown", `article.board-shot[data-shot="S1"]`), { what: "the failed picture's words" });
  await browser.shot("board-picture-failed");
  await browser.evaluate(`${button("Retry pictures")}.focus()`);
  await browser.key("Enter");
  // The button goes away with the failure: the focus goes to the panel, not the page.
  await browser.waitFor(`document.activeElement === ${boardRow("S1")}`, { what: "the focus on shot 1's panel after retry" });
  await browser.waitFor(`!${boardRow("S1")}.querySelector(".board-missing") && ${boardPictures}`, { timeout: 60_000, what: "shot 1's pictures again" });
  assert.match(await browser.evaluate(`${boardRow("S1")}.querySelector(".board-source img").currentSrc`), /&try=1$/);
  await browser.key("Escape");
});

test("storyboard screen: :board shows the board not asked yet, read only; after the answer it opens the board stop, read only", { skip: skipWithoutMediaTools }, async () => {
  const command = async (text) => {
    await browser.key(":");
    await browser.waitFor(`!!document.querySelector("#command-input")`, { what: "the command line" });
    // Just after a project opens, the page may still move the focus to a pane: type in the line.
    if (!(await browser.evaluate(`document.activeElement?.id === "command-input"`))) await browser.click(q("#command-input"));
    await browser.type(text);
    await browser.key("Enter");
  };
  // A video with no board yet.
  const bare = await agent("project", { action: "create", id: "board-none", name: "board-none", width: 1080, height: 1920, duration: 4 });
  assert.equal(bare.isError, undefined, bare.text);
  await openOn("board-none");
  await command("board");
  await browser.waitFor(`${textOf("#screen-title")} === "Storyboard" && ${pageHas("No storyboard yet.", ".screen")}`, { what: "no storyboard yet" });
  await browser.key("Escape");

  const id = "board-readonly";
  await boardVideo(id, { ask: false });
  await openOn(id);
  await command("board");
  await browser.waitFor(`${textOf("#screen-title")} === "Storyboard" && ${boardClips}.length === 5`, { what: "the board not asked yet" });
  const before = await browser.evaluate(`({ head: [document.querySelector(".board-facts .board-title").innerText.trim(), document.querySelector(".board-status .voice-line").innerText.trim()],
    directs: document.querySelectorAll("[data-notes], [data-note-open], .board-note, .stepper, button.board-option, .shot-actions button").length, answers: document.querySelectorAll(".stop-card").length })`);
  assert.deepEqual(before, { head: ["Not asked yet, board r1", "Not asked yet: the agent has not shown you this board"], directs: 0, answers: 0 });
  assert.equal(await browser.evaluate(`document.querySelectorAll(".call-no").length`), 0, "no no on a board not asked yet");
  await pickShot("S1");
  await browser.waitFor(boardPictures, { timeout: 60_000, what: "shot 1's pictures" });
  await browser.shot("board-not-asked-desktop");
  await browser.key("Escape");

  // Answered: :board opens the stop's screen, the board read only, and c does nothing there.
  const asked = await askStop(id, "board");
  await stopGap(asked.at);
  await asDashboard("stops", { project: id, action: "answer", id: asked.id, rev: asked.rev, read_as: "approve" });
  await showView("session", { focus: false });
  await browser.waitFor(`${textOf("#section-stops")}.includes("C1 storyboard · approved on the dashboard")`, { what: "C1 answered" });
  await command("board");
  await browser.waitFor(`${textOf("#screen-title")} === "Storyboard, C1" && ${boardClips}.length === 5`, { what: "C1's screen with the board" });
  const after = await browser.evaluate(`({ status: document.querySelector(".board-status .voice-line").innerText.trim(), directs: document.querySelectorAll("[data-notes], [data-note-open], .board-note, .stepper").length,
    answers: document.querySelectorAll(".stop-card, .stop-card button").length })`);
  assert.match(after.status, /^Answered: approved on the dashboard at \d\d:\d\d$/);
  assert.deepEqual([after.directs, after.answers], [0, 0]);
  await pickShot("S2");
  await browser.evaluate(`${boardRow("S2")}.focus()`);
  await browser.key("c");
  await sleep(200);
  assert.equal(await browser.evaluate(`document.querySelectorAll("[id^=board-note]").length`), 0, "c leaves no note on an answered board");
  await browser.shot("board-read-only-desktop");
  await atPhone(async () => {
    await browser.waitFor(`${boardClips}.length === 5`, { what: "the board at 390 px" });
    const overflow = await browser.evaluate(sidewaysOverflow);
    assert.ok(overflow.scroll <= overflow.width && !overflow.past.length, JSON.stringify(overflow));
    await browser.evaluate(`${q("#screen-title")}.scrollIntoView({ block: "start" })`);
    await browser.shot("board-read-only-phone");
  });
  await browser.key("Escape");
});

test("the theme switch changes the page's colors, the choice is kept after a reload, and :theme sets it back", async () => {
  await open();
  const theme = "document.documentElement.dataset.theme";
  const page = `getComputedStyle(${q(".dash")}).backgroundColor`;
  const first = await browser.evaluate(theme);
  const other = first === "light" ? "dark" : "light";
  const colorBefore = await browser.evaluate(page);
  await browser.click(q(".theme-switch"));
  await browser.waitFor(`${theme} === ${JSON.stringify(other)} && ${page} !== ${JSON.stringify(colorBefore)}`, { what: `the ${other} theme and its page color` });
  assert.equal(await browser.evaluate(`${q(".theme-switch")}.getAttribute("aria-pressed")`), String(other === "light"), "the switch says which theme is on");
  await open();
  await browser.waitFor(`${theme} === ${JSON.stringify(other)}`, { what: "the kept theme after a reload" });
  await browser.key(":");
  await browser.waitFor(`document.activeElement?.id === "command-input"`, { what: "the command list" });
  await browser.type(`theme ${first}`);
  await browser.key("Enter");
  await browser.waitFor(`${theme} === ${JSON.stringify(first)} && ${page} === ${JSON.stringify(colorBefore)}`, { what: `the ${first} theme from the command` });
});
