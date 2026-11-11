// check {fix:"auto"} fixes what the polish rules find, as one edit of normal ops, proves each fix
// safe before saving it (a fix that would add an error is dropped and named), and does nothing
// the second time. Runs on a real server with a temporary data folder.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestServer } from "./media.test.support.mjs";

let server;
before(async () => { server = await startTestServer(); });
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

const text = (name, value, properties, animations = []) => ({ op: "add_layer", layerType: "text", name,
  properties: { fontFamily: "Inter", fontSize: 92, fill: "#ffffff", textResize: "width-height", ...properties, text: value }, animations });
const shown = (start, end) => [{ preset: "show", start }, { preset: "hide", start: end }];
const rules = (check) => check.data.findings.map((finding) => finding.rule);

test("check {fix:\"auto\"} fixes a fallback weight, an orphan and a held end card in one edit, then has nothing left", async () => {
  await agent("project", { action: "create", id: "polish", name: "Polish", width: 1920, height: 1080, duration: 6, background: "#101010" });
  const made = await agent("edit", { project: "polish", ops: [
    text("title", "zuri.", { fontFamily: "Noto Serif", fontWeight: 600, fontSize: 200, x: 760, y: 120 }, shown(0, 2)),
    text("caption", "this is lowkey the best project", { textResize: "height", width: 1020, x: 450, y: 700, textAlign: "center" }, shown(0, 2)),
    text("url", "github.com/someone/project", { fontSize: 64, x: 480, y: 480, textAlign: "center" }, [{ preset: "preset-fade", start: 2.2, duration: 0.5 }]),
  ] });
  assert.equal(made.isError, undefined, made.text);
  const first = await agent("check", { project: "polish", pixels: false });
  for (const rule of ["font_fallback", "text_wrap", "held_static"]) assert.ok(rules(first).includes(rule), `${rule}: ${first.text}`);

  const fixed = await agent("check", { project: "polish", fix: "auto", pixels: false });
  assert.equal(fixed.isError, undefined, fixed.text);
  assert.equal(fixed.data.rev, first.data.rev + 1, "one edit");
  for (const rule of ["font_fallback", "text_wrap", "held_static"]) {
    assert.match(fixed.text, new RegExp(`fixed ${rule} `), fixed.text);
    assert.ok(!rules(fixed).includes(rule), `${rule} is gone: ${fixed.text}`);
  }
  assert.equal(fixed.data.errors, 0, fixed.text);
  const again = await agent("check", { project: "polish", fix: "auto", pixels: false });
  assert.equal(again.data.rev, fixed.data.rev, again.text);
  assert.match(again.text, /No auto fixes to apply/);
});

test("a fix that would add an error is not applied, and the answer says why", async () => {
  await agent("project", { action: "create", id: "crowded", name: "Crowded", width: 1920, height: 1080, duration: 3, background: "#101010" });
  // Widening the caption to one line would run it into the label beside it.
  await agent("edit", { project: "crowded", ops: [
    text("caption", "this is lowkey the best project", { textResize: "height", width: 1020, x: 450, y: 700, textAlign: "center" }, shown(0, 2.5)),
    text("label", "LIVE", { fontSize: 60, x: 1520, y: 712 }, shown(0, 2.5)),
  ] });
  const first = await agent("check", { project: "crowded", pixels: false });
  assert.equal(first.data.errors, 0, first.text);
  assert.ok(rules(first).includes("text_wrap"), first.text);
  const fixed = await agent("check", { project: "crowded", fix: "auto", pixels: false });
  assert.match(fixed.text, /not applied text_wrap caption: it would add \w+/, fixed.text);
  assert.equal(fixed.data.errors, 0, fixed.text);
  // Only the bad fix is left out: a fix beside it on the same layer (held_static) still applies.
  assert.doesNotMatch(fixed.text, /fixed text_wrap/, fixed.text);
});

test("check {fix:\"auto\"} leaves a layer the latest edit moved (until another edit), a waiver names or the spine uses where it is; its warning stays", async () => {
  await agent("project", { action: "create", id: "placed", name: "Placed", width: 1920, height: 1080, duration: 3, background: "#101010" });
  await agent("edit", { project: "placed", ops: [text("counter", "75.6 m", { x: 600, y: 400 }, shown(0, 2.5)), text("tag", "LIVE", { fontSize: 60, x: 600, y: 800 }, shown(0, 2.5))] });
  // The agent moves the counter on purpose (a critic's fix): held_static's drift leaves it be.
  const moved = await agent("edit", { project: "placed", ops: [{ op: "update_layer", layer: "counter", properties: { y: 200 } }] });
  const held = await agent("check", { project: "placed", fix: "auto", pixels: false, rules: ["held_static"] });
  assert.match(held.text, new RegExp(`not applied held_static counter: left where you placed it \\(rev ${moved.data.rev}\\); the warning stays\n`), held.text);
  assert.equal(held.data.rev, moved.data.rev, "nothing saved");
  // An edit that moves nothing: the auto fix applies again.
  await agent("edit", { project: "placed", ops: [{ op: "update_layer", layer: "tag", properties: { text: "LIVE NOW" } }] });
  assert.match((await agent("check", { project: "placed", fix: "auto", pixels: false, rules: ["held_static"] })).text, /fixed held_static counter/);
  // A layer a waiver names is a designed element: a warning's move leaves it too.
  await agent("project", { action: "create", id: "waived", name: "Waived", width: 1920, height: 1080, duration: 3, background: "#101010" });
  await agent("edit", { project: "waived", ops: [text("counter", "75.6 m", { x: 600, y: 400 }, shown(0, 2.5)), text("tag", "LIVE", { fontSize: 60, x: 600, y: 800 }, shown(0, 2.5)),
    { op: "waive_check", code: "own_words", target: "counter", reason: "the hook number, placed on purpose" }] });
  const waived = await agent("check", { project: "waived", fix: "auto", pixels: false, rules: ["held_static"] });
  assert.match(waived.text, /not applied held_static counter: left where a waiver names it \(own_words\); the warning stays\n/, waived.text);
  // So is a layer the spine's beats use.
  await agent("edit", { project: "waived", ops: [{ op: "unwaive_check", code: "own_words", target: "counter" }] });
  const spine = [{ role: "hook", from: 0, to: 3, uses: ["counter"], purpose: "the number lands first" }];
  const briefed = await agent("notes", { project: "waived", action: "brief", fields: { style: { spine, by: "guessed" } } });
  assert.equal(briefed.isError, undefined, briefed.text);
  assert.match((await agent("check", { project: "waived", fix: "auto", pixels: false, rules: ["held_static"] })).text, /left where the spine's hook uses it/);
  // A fix that moves nothing (role_font_drift's set_font) leaves a spine layer alone too.
  await agent("edit", { project: "waived", ops: [text("cap1", "she walks to the store", { fontSize: 40, role: "caption", x: 200, y: 900 }, shown(0, 2.5)),
    text("cap2", "the phone tells her where", { fontSize: 40, fontFamily: "Noto Serif", role: "caption", x: 1000, y: 900 }, shown(0, 2.5))] });
  await agent("notes", { project: "waived", action: "brief", fields: { style: { spine: [{ ...spine[0], uses: ["counter", "cap2"] }], by: "guessed" } } });
  const font = await agent("check", { project: "waived", fix: "auto", pixels: false, rules: ["role_font_drift"] });
  assert.match(font.text, /not applied role_font_drift cap2: left alone: the spine's hook uses it; the warning stays/, font.text);
});

test("a rule waived a sixth time says so in the edit receipt's notes and right after check's counts", async () => {
  await agent("project", { action: "create", id: "waived6", name: "Waived6", width: 1920, height: 1080, duration: 3, background: "#101010" });
  const tiles = [0, 1, 2, 3, 4, 5].map((index) => ({ op: "add_layer", layerType: "rectangle", name: `tile${index}`, properties: { x: 100 + index * 300, y: 400, width: 200, height: 200, fill: "#3a5a40" } }));
  const five = await agent("edit", { project: "waived6", ops: [...tiles.slice(0, 5), { op: "waive_check", code: "hold", target: "tile?", reason: "on purpose" }] });
  assert.doesNotMatch(JSON.stringify(five.data.notes ?? []), /waived 5 times/, five.text);
  const six = await agent("edit", { project: "waived6", ops: [tiles[5], { op: "waive_check", code: "hold", target: "tile5", reason: "on purpose" }] });
  assert.match(six.data.notes.join(" "), /^hold is waived 6 times here: likely a kino false positive/, six.text);
  assert.match((await agent("check", { project: "waived6", pixels: false })).text.split("\n")[1], /^note: hold is waived 6 times/);
});

test("check {fix:\"auto\"} tightens a slow layer stagger and keeps its order", async () => {
  await agent("project", { action: "create", id: "cards", name: "Cards", width: 1920, height: 1080, duration: 4, background: "#101010" });
  // Four cards 0.3 s apart (0.9 s in all): stagger_long asks for 0.5 s.
  await agent("edit", { project: "cards", ops: [0, 1, 2, 3].map((index) => ({ op: "add_layer", layerType: "rectangle", name: `card${index}`,
    properties: { x: 120 + index * 440, y: 390, width: 400, height: 300, fill: "#3a5a40" }, animations: [{ preset: "preset-fade", start: 0.2 + index * 0.3, duration: 0.4 }] })) });
  const fixed = await agent("check", { project: "cards", fix: "auto", pixels: false, rules: ["stagger_long"] });
  assert.match(fixed.text, /fixed stagger_long card0/, fixed.text);
  assert.ok(!rules(fixed).includes("stagger_long"), fixed.text);
});

test("check {fix:\"auto\"} blurs both fast stretches of a panel that pans in and out (judder)", async () => {
  await agent("project", { action: "create", id: "pans", name: "Pans", width: 1920, height: 1080, duration: 6, background: "#101010" });
  const pan = (name, start, from, to) => ({ op: "add_animation", layer: "panel", animation: { kind: "custom", name, start, duration: 2, easing: "smooth", from: { x: from }, to: { x: to } } });
  const made = await agent("edit", { project: "pans", ops: [{ op: "add_layer", layerType: "rectangle", name: "panel", properties: { x: 400, y: 240, width: 1100, height: 600, fill: "#3cc8b4" } },
    pan("In", 0, -1100, 400), pan("Out", 3, 400, 1920)] });
  assert.equal(made.isError, undefined, made.text);
  const fixed = await agent("check", { project: "pans", fix: "auto", pixels: false });
  assert.equal(fixed.text.match(/fixed judder panel/g)?.length, 2, fixed.text);
  assert.ok(!rules(fixed).includes("judder"), fixed.text);
});

test("check {fix:\"auto\"} roves a jumpy hand-off between two moves: same start, end and places", async () => {
  await agent("project", { action: "create", id: "roves", name: "Roves", width: 1920, height: 1080, duration: 3, background: "#101010" });
  // A dot speeds up to x 700 in 1 s, then covers as much again in 0.5 s: its speed jumps at 1 s.
  const leg = (name, start, duration, easing, from, to) => ({ op: "add_animation", layer: "dot", animation: { kind: "custom", name, start, duration, easing, from: { x: from }, to: { x: to } } });
  await agent("edit", { project: "roves", ops: [{ op: "add_layer", layerType: "rectangle", name: "dot", properties: { x: 1300, y: 440, width: 200, height: 200, fill: "#3cc8b4" } },
    leg("Go", 0, 1, "ease-in", 100, 700), leg("On", 1, 0.5, "ease-out", 700, 1300)] });
  const fixed = await agent("check", { project: "roves", fix: "auto", pixels: false, rules: ["speed_jump"] });
  assert.match(fixed.text, /fixed speed_jump dot/, fixed.text);
  assert.ok(!rules(fixed).includes("speed_jump"), fixed.text);
  // The 1.5 s is shared by distance and the join re-eased to one speed; places stay.
  const { text: legs } = await agent("inspect", { project: "roves", layer: "dot" });
  assert.match(legs, /'Go' custom x 100→700 0s\+0\.75s \[0\.333,0,0\.667,0\.333\]/, legs);
  assert.match(legs, /'On' custom x 700→1300 0\.75s\+0\.75s \[0\.333,0\.667,0\.667,1\]/, legs);
});
