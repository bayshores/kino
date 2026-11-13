// The crew screen (F2, design 02-crew), in Electron's Chromium against a real kino server with a
// stub `claude` program (backend/crew-stub-agent.test.support.mjs) and a temporary HOME: never the
// real claude or codex, never the real home folder. codex is "not installed" here on purpose.
//
// Covers: the five boxes with real rows (the tree, a lead's held part, the rules), the agent
// detail (and i to the inspire screen), changing the start rules by mouse and by keyboard, starting an agent (and the reason
// codex cannot start), holding and releasing it with h, freeing a held part, stopping it with x
// (asked first), and the phone layout. Set KINO_DASHBOARD_SHOTS=<folder> to keep screenshots.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { writeStubPrograms } from "../backend/crew-stub-agent.test.support.mjs";
import { button, q, startDashboard, textOf, until } from "./dashboard-browser.support.mjs";

let dashboard;
let server;
let browser;
let home;

async function as(session, verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body }, headers: { "x-kino-session": session } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const nova = (verb, body) => as("test-crew-nova", verb, body);
const crew = async () => (await (await server.api("/api/dashboard/crew")).json()).crew;
const memberNamed = async (name) => (await crew()).members.find((member) => member.name === name);
const selectedRow = `(${q(".crew-table [role=option][aria-selected=true]")}?.getAttribute("aria-label") ?? "")`;
const pressOnTable = async (...keys) => {
  await browser.evaluate(`${q(".crew-table [role=listbox]")}.focus()`);
  await browser.keys(...keys);
};

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kino-crew-screen-home-"));
  const { KINO_CLAUDE } = await writeStubPrograms(path.join(home, "stub-bin"));
  dashboard = await startDashboard({ prefix: "kino-dashboard-crew-", env: { HOME: home, KINO_CLAUDE, KINO_CODEX: path.join(home, "no-codex") } });
  ({ server, browser } = dashboard);
  await nova("project", { action: "create", id: "crew", name: "Crew", width: 640, height: 360, duration: 4 });
  const made = await nova("edit", { ops: [{ op: "add_layer", layerType: "text", name: "hero-5 caption", properties: { text: "walk", x: 100, y: 100, fontSize: 30, fill: "#ffffff" } }] });
  assert.equal(made.isError, undefined, made.text);
  await dashboard.open();
  await browser.keys("F2");
  await browser.waitFor(`!!${q(".screen.crew .crew-table [role=option]")}`, { what: "the crew screen" });
});

after(async () => {
  await dashboard?.stop();
  if (home) await rm(home, { recursive: true, force: true });
});

test("the crew page shows the real crew: the agents, their lanes, what is held, the rules", async () => {
  // No titled boxes any more: the lists carry their names as labels.
  assert.equal(await browser.evaluate(`document.querySelectorAll(".screen.crew .ui-box-title").length`), 0);
  assert.equal(await browser.evaluate(`${q(".crew-table [role=listbox]")}.getAttribute("aria-label")`), "Agents");
  assert.equal(await browser.evaluate(`${q(".crew-holds")}.getAttribute("aria-label")`), "Who holds what");
  assert.equal(await browser.evaluate(`${q(".crew-rules .crew-rule-list")}.getAttribute("aria-label")`), "Who may start agents");
  const rows = await browser.evaluate(`[...document.querySelectorAll(".crew-table [role=option]")].map((row) => row.getAttribute("aria-label"))`);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^Nova, Lead, .+ Holds hero-5 caption\.$/);
  assert.equal(rows[1], "You");
  // Nova is picked first: her row has her facts, her hold and her buttons (Hold icon, Watch, Stop), and her lane.
  assert.match(await browser.evaluate(textOf(".crew-card[aria-selected=true]")), /Nova[\s\S]*Lead[\s\S]*May do everything[\s\S]*hero-5 caption[\s\S]*Watch\s+Stop/);
  assert.equal(await browser.evaluate(`${q(".crew-card[aria-selected=true] .crew-card-keys button")}.getAttribute("aria-label")`), "Hold Nova");
  assert.equal(await browser.evaluate(`${q(".crew-more-keys")}.innerText.includes("References")`), true);
  assert.match(await browser.evaluate(textOf(".crew-lanes .sr-only")), /^Last 10 minutes\. Nova: 1 edit run/);
  assert.equal(await browser.evaluate(`document.querySelectorAll(".crew-lanes .lane-block.k-edit").length > 0`), true);
  assert.equal(await browser.evaluate(`${q(".crew-lanes [aria-hidden=true]")} !== null`), true, "the lanes are hidden from screen readers");
  // Who holds what: Nova holds the caption; render is free.
  assert.match(await browser.evaluate(textOf(".crew-holds")), /^Nobody is rendering\s+Nova holds hero-5 caption$/);
  // The rules as they are: you, not your notes, leads up to 3 helpers, not timers, 4 at once, 60 calls or 15 min.
  const checks = await browser.evaluate(`[...document.querySelectorAll(".crew-rules input[type=checkbox]")].map((box) => [box.closest("label").innerText.replace(/\\s+/g, " ").trim(), box.checked, box.disabled])`);
  assert.deepEqual(checks, [["You", true, true], ["Your notes", false, false], ["Nova", true, false], ["Timers", false, false]]);
  const numbers = await browser.evaluate(`[...document.querySelectorAll(".crew-rules input[type=number]")].map((field) => [field.getAttribute("aria-label"), field.value])`);
  assert.deepEqual(numbers.map(([, value]) => value), ["3", "4", "60", "15"]);
  // No key line: the keys are in the buttons' tooltips; the dashboard's own key line is not shown here either.
  assert.equal(await browser.evaluate(`${q(".crew-keyline")} === null`), true);
  assert.equal(await browser.evaluate(`${q(".crew-card[aria-selected=true] button[aria-keyshortcuts=h]")}.title`), "Hold (key h)");
  assert.equal(await browser.evaluate(`${q(".keyline")} === null`), true);
  await browser.shot("crew-1-boxes");
  // i opens the inspire screen (F3); F2 comes back.
  await pressOnTable("i");
  await browser.waitFor(`!!${q(".screen.inspire")}`, { what: "the inspire screen" });
  await browser.keys("F2");
  await browser.waitFor(`!!${q(".screen.crew .crew-table [role=option]")}`, { what: "the crew screen again" });
});

test("the start rules change by mouse and by keyboard, and the server keeps them", async () => {
  await browser.click(`[...document.querySelectorAll(".crew-rules .crew-check")].find((label) => label.innerText.includes("Your notes"))`, "the your notes box");
  await until(async () => (await crew()).rules.notes === true, "notes on");
  await browser.waitFor(`[...document.querySelectorAll(".crew-rules .crew-check")].find((label) => label.innerText.includes("Your notes")).querySelector("input").checked`, { what: "your notes ticked" });
  // Keyboard: the timers box takes Space; the "at most" number takes typing and Enter.
  await browser.evaluate(`[...document.querySelectorAll(".crew-rules input[type=checkbox]")].at(-1).focus()`);
  await browser.keys(" ");
  await until(async () => (await crew()).rules.timers === true, "timers on");
  await browser.evaluate(`${q(".crew-rules input[aria-label='Agents at work at once, at most']")}.focus()`);
  await browser.selectAll();
  await browser.type("5");
  await browser.keys("Enter");
  await until(async () => (await crew()).rules.atOnce === 5, "at most 5 at once");
  await browser.evaluate(`${q(".crew-rules input[aria-label='Calls before kino asks you']")}.focus()`);
  await browser.selectAll();
  await browser.type("80");
  await browser.keys("Tab");
  await until(async () => (await crew()).rules.budget.calls === 80, "ask past 80 calls");
  // A number out of range goes back to the saved one.
  await browser.evaluate(`${q(".crew-rules input[aria-label='Helpers each lead may start']")}.focus()`);
  await browser.selectAll();
  await browser.type("99");
  await browser.keys("Enter");
  await browser.waitFor(`${q(".crew-rules input[aria-label='Helpers each lead may start']")}.value === "3"`, { what: "the helpers back at 3" });
  assert.equal((await crew()).rules.leads.helpers, 3);
  await browser.shot("crew-2-rules");
});

test("s starts an agent: codex says it is not installed, claude code starts, h holds, x stops", async () => {
  await pressOnTable("s");
  await browser.waitFor(`document.activeElement?.closest(".crew-start") && document.activeElement.type === "text"`, { what: "the task field" });
  await browser.type("wait forever");
  // Codex is not on this computer: the form says so and will not start it.
  await browser.click(`[...document.querySelectorAll(".crew-start .ui-seg-item")].find((label) => label.innerText.includes("Codex"))`, "codex");
  await browser.waitFor(`${textOf(".crew-start")}.includes("codex was not found on this computer")`, { what: "the reason codex cannot start" });
  assert.equal(await browser.evaluate(`${button("Start", ".crew-start")}.disabled`), true);
  await browser.click(`[...document.querySelectorAll(".crew-start .ui-seg-item")].find((label) => label.innerText.includes("Claude code"))`, "claude code");
  await browser.click(`[...document.querySelectorAll(".crew-start .ui-seg-item")].find((label) => label.innerText.includes("Look only"))`, "look only");
  await browser.evaluate(`${q(".crew-start input[type=text]")}.focus()`);
  await browser.keys("Enter");
  const started = await until(async () => (await crew()).members.find((member) => member.launched && member.task === "wait forever"), "the started agent");
  assert.equal(started.kind, "claude-code");
  assert.equal(started.may, "look");
  // The new agent is selected and its detail shows its task and who started it.
  await browser.waitFor(`${selectedRow}.startsWith(${JSON.stringify(started.name)})`, { what: "the new agent selected" });
  // Its row says what it may do; its task is in the tooltip of the line under its name.
  await browser.waitFor(`${textOf(".crew-card[aria-selected=true] .crew-card-facts")}.includes("May look and search only") && ${q(".crew-card[aria-selected=true] .crew-card-name span")}.title.includes("wait forever")`, { what: "its row" });
  assert.match(await browser.evaluate(selectedRow), new RegExp(`^${started.name}, Lead, `));

  // h holds it (the server refuses its writes), h again releases it.
  await pressOnTable("h");
  await until(async () => (await memberNamed(started.name))?.heldBy === "you", "the agent held");
  await browser.waitFor(`${selectedRow}.includes(", Held.")`, { what: "the row says held" });
  await browser.waitFor(`${q(".crew-card[aria-selected=true] .crew-card-keys button")}.getAttribute("aria-label") === "Release ${started.name}"`, { what: "the release button" });
  await browser.shot("crew-3-held");
  await pressOnTable("h");
  await until(async () => !(await memberNamed(started.name))?.heldBy, "the agent released");

  // x asks first; n keeps it, y stops it.
  await pressOnTable("x");
  await browser.waitFor(`${textOf("body")}.includes("Stop ${started.name}?")`, { what: "the question" });
  await browser.keys("n");
  assert.notEqual((await memberNamed(started.name)).state, "stopped");
  await pressOnTable("x");
  await browser.waitFor(`${textOf("body")}.includes("Stop ${started.name}?")`, { what: "the question again" });
  await browser.keys("y");
  await until(async () => (await memberNamed(started.name))?.state === "stopped", "the agent stopped");
  await browser.waitFor(`${selectedRow}.includes(", Stopped.")`, { what: "the row says stopped" });
});

test("a held part can be freed from who holds what", async () => {
  assert.ok((await crew()).locks.some((entry) => entry.label === "hero-5 caption"), "Nova holds the caption");
  await browser.click(`${q(".crew-holds button[aria-label='free hero-5 caption from Nova']")}`, "free it");
  await until(async () => !(await crew()).locks.some((entry) => entry.label === "hero-5 caption"), "the caption freed");
  await browser.waitFor(`!${textOf(".crew-holds")}.includes("hero-5 caption")`, { what: "the row gone" });
  // Your lane shows what you did: the hold, release, stop and free.
  await browser.waitFor(`/hold.*release.*stop.*free/.test(${textOf(".crew-lanes .sr-only")})`, { what: "your lane" });
  await browser.waitFor(`${textOf(".crew-holds")}.includes("Nobody is rendering")`, { what: "the hold row gone" });
});

test("at phone width the boxes stack without a sideways scroll", async () => {
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  try {
    // The row puts its buttons under its words by CSS at once; the top line takes its phone form one
    // React update later (.dash.phone), so the widths are read after both.
    await browser.waitFor(`getComputedStyle(${q(".crew-card-keys")}).gridColumnStart === "2" && !!document.querySelector(".dash.phone")`, { what: "the phone layout" });
    const measure = `[document.documentElement.scrollWidth, ${q(".screen-wrap")}.scrollWidth, ${q(".screen-wrap")}.clientWidth]`;
    await browser.waitFor(`((w) => w[0] <= 390 && w[1] <= w[2])(${measure})`, { what: "no sideways scroll", timeout: 5000 }).catch(() => {});
    const widths = await browser.evaluate(measure);
    assert.ok(widths[0] <= 390 && widths[1] <= widths[2], `no sideways scroll: ${widths}`);
    // The agents, then the holds and the limits, then who may start agents, one under the other; a row's buttons are under its words.
    const tops = await browser.evaluate(`[".crew-table", ".crew-holds", ".crew-limits", ".crew-more"].map((selector) => document.querySelector(selector).getBoundingClientRect().top)`);
    assert.deepEqual([...tops].sort((a, b) => a - b), tops, "one part under the other");
    assert.equal(await browser.evaluate(`${q(".crew-card-keys")}.getBoundingClientRect().top >= ${q(".crew-card-main")}.getBoundingClientRect().bottom - 1`), true, "the buttons are under the words");
    await browser.shot("crew-4-phone");
  } finally {
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});
