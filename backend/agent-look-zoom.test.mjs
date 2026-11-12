// look {mode:"zoom"} crops around the part of a layer that is on screen: after its own and its
// groups' move, scale and rotation, clipped to the scene, at a size an agent can judge. In the
// one edit a video inside a 5837×3168 group was cropped at its position inside the group, as a
// 305 px strip at 0.08×. Runs on a real server with a temporary data folder.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readImage, startTestServer } from "./media.test.support.mjs";
import { traceText } from "./agent/motion-graph.mjs";
import { everyNth, leftOutCall, PAGE_PIXELS, PAGE_WIDTH, PAGES_MOST, probeTimes, spanPicks, spansOfFlags, timesEdge, timesLabel, timesPlan } from "./agent/look.mjs";

let server;
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project: "zoom", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;

// A vertical scene with a group "world" much bigger than the frame. Inside it, a red "finale"
// whose own x and y (2000, 1700) are far outside the scene, but which the group moves over the
// lower part of the frame; and a small green "logo" on its own.
before(async () => {
  server = await startTestServer();
  await agent("project", { action: "create", id: "zoom", name: "Zoom", width: 1080, height: 1920, duration: 4, background: "#101418" });
  const made = await agent("edit", { ops: [
    { op: "add_layer", layerType: "group", name: "world", properties: { x: -3000, y: -700, width: 6000, height: 3680 } },
    { op: "add_layer", layerType: "rectangle", name: "plate", properties: { parentId: "world", x: 0, y: 0, width: 5837, height: 3168, fill: "#203040" } },
    { op: "add_layer", layerType: "rectangle", name: "finale", properties: { parentId: "world", x: 2000, y: 1700, width: 4800, height: 2700, fill: "#ff0000" } },
    { op: "add_layer", layerType: "rectangle", name: "logo", properties: { x: 40, y: 40, width: 100, height: 100, fill: "#00ff00" } },
  ] });
  assert.equal(made.isError, undefined, made.text);
});

test("zoom on a big layer inside a group shows its part on screen, at a useful size", async () => {
  const frame = await agent("look", { mode: "frame", t: 1 });
  const picture = await readImage(Buffer.from(frame.images[0].data, "base64"));
  // On screen the finale starts at y = -700 + 1700 = 1000 and covers the frame below that.
  const toScene = 1080 / picture.width;
  let firstRed = -1;
  for (let y = 0; y < picture.height && firstRed < 0; y += 1) if (isRed(picture.pixel(picture.width >> 1, y))) firstRed = Math.round(y * toScene);
  assert.ok(Math.abs(firstRed - 1000) <= 3, `the finale starts at y ${firstRed}`);

  const reply = await agent("look", { mode: "zoom", layer: "finale", t: 1 });
  assert.equal(reply.isError, undefined, reply.text);
  // Before: "Layer finale is outside the scene at 1s, so there is nothing to zoom into."
  const [, x, y, width, height, scale] = /crop (\d+),(\d+) (\d+)×(\d+) \(its part on screen; the layer is 4800×2700 inside world\) at ([\d.]+)×$/m.exec(reply.text) ?? [];
  assert.ok(x !== undefined, reply.text);
  // The finale's part inside the scene, with 24 px above it: 0,976 1080×944 (to a few pixels,
  // as the crop is cut on the picture's pixels).
  const near = (value, expected) => Math.abs(Number(value) - expected) <= 3;
  assert.ok(near(x, 0) && near(y, 976) && near(width, 1080) && near(height, 944), reply.text);
  // Drawn 1024 px on its long edge (before the review: 0.44×, look frame's default 480 px).
  assert.equal(Number(scale), 0.95, reply.text);
  const image = await readImage(Buffer.from(reply.images[0].data, "base64"));
  assert.equal(image.width, 1024);
  assert.ok(isRed(image.pixel(image.width >> 1, image.height >> 1)), "its centre is the red finale");
});

test("a group's scale moves and sizes the crop too", async () => {
  // Half size around the group's centre (3000, 1840 inside it) puts the group's corner at
  // -1500, 220: the finale is 2400×1350 on screen from x -1500 + 1000 = -500, y 220 + 850 = 1070.
  const scaled = await agent("edit", { ops: [{ op: "update_layer", layer: "world", properties: { scaleX: 0.5, scaleY: 0.5 } }] });
  assert.equal(scaled.isError, undefined, scaled.text);
  const reply = await agent("look", { mode: "zoom", layer: "finale", t: 1 });
  assert.equal(reply.isError, undefined, reply.text);
  const [, y, height] = /crop 0,(\d+) 1080×(\d+) \(its part on screen/.exec(reply.text) ?? [];
  assert.ok(Math.abs(Number(y) - 1046) <= 3 && Math.abs(Number(height) - 874) <= 3, reply.text);
  const image = await readImage(Buffer.from(reply.images[0].data, "base64"));
  assert.ok(isRed(image.pixel(image.width >> 1, image.height >> 1)), "its centre is the red finale");
  assert.ok(!isRed(image.pixel(image.width >> 1, 2)), "the 24 px above it are not");
});

test("a small layer is still shown at 2×, and a layer off screen is refused", async () => {
  const reply = await agent("look", { mode: "zoom", layer: "logo", t: 1 });
  assert.equal(reply.isError, undefined, reply.text);
  assert.match(reply.text, /^zoom logo @1s crop 16,16 148×148 at 2×$/m);
  const image = await readImage(Buffer.from(reply.images[0].data, "base64"));
  assert.deepEqual([image.width, image.height], [296, 296]);

  // The review: a layer entirely inside the scene was said to be cropped to "its part on
  // screen" when only the 24 px margin around it reached past the edge; and a 950×250 headline
  // came back 422 px wide, less than in look frame width=720.
  const made = await agent("edit", { ops: [
    { op: "add_layer", layerType: "rectangle", name: "edge", properties: { x: 8, y: 8, width: 200, height: 120, fill: "#00ff00" } },
    { op: "add_layer", layerType: "rectangle", name: "banner", properties: { x: 65, y: 225, width: 950, height: 250, fill: "#00ff00" } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const edge = await agent("look", { mode: "zoom", layer: "edge", t: 1 });
  assert.match(edge.text, /^zoom edge @1s crop 0,0 232×152 at 2×$/m);
  const banner = await agent("look", { mode: "zoom", layer: "banner", t: 1 });
  const [, scale] = /^zoom banner @1s crop 41,201 998×298 at ([\d.]+)×$/m.exec(banner.text) ?? assert.fail(banner.text);
  assert.ok(Number(scale) > 1, banner.text);
  const wide = await readImage(Buffer.from(banner.images[0].data, "base64"));
  assert.ok(wide.width >= 1000 && wide.width <= 1024, `the banner is ${wide.width} px wide`);
  // A layer the size of the scene is all on screen too.
  await agent("edit", { ops: [{ op: "update_layer", layer: "banner", properties: { x: 0, y: 0, width: 1080, height: 1920 } }] });
  const full = await agent("look", { mode: "zoom", layer: "banner", t: 1 });
  assert.match(full.text, /^zoom banner @1s crop 0,0 1080×19\d\d at 0\.53×$/m);

  await agent("edit", { ops: [{ op: "update_layer", layer: "logo", properties: { x: 3000 } }] });
  const outside = await agent("look", { mode: "zoom", layer: "logo", t: 1 });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /outside the scene at 1s/);
});

// A review of agent edits: a text layer was cropped to its box, so "SAVE" at 160 px in a box
// 320 wide (the E wraps to a second line below the box) came back as "SAV". The crop now holds
// the box and the drawn letters.
test("zoom on a text layer holds every letter, also those drawn past its box", async () => {
  const made = await agent("edit", { ops: [
    { op: "add_layer", layerType: "text", name: "cap", properties: { x: 300, y: 1500, width: 320, height: 180, text: "SAVE", fontSize: 160, fill: "#ffffff", textResize: "fixed" } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  // Where the letters are drawn: the white pixels of a frame (0.5 px per scene px).
  const frame = await agent("look", { mode: "frame", t: 1, width: 540 });
  const picture = await readImage(Buffer.from(frame.images[0].data, "base64"));
  const isWhite = ([r, g, b]) => r > 200 && g > 200 && b > 200;
  let lowest = -1, rightmost = -1;
  for (let y = 0; y < picture.height; y += 1)
    for (let x = 0; x < picture.width; x += 1) if (isWhite(picture.pixel(x, y))) { lowest = Math.max(lowest, y * 2); rightmost = Math.max(rightmost, x * 2); }
  assert.ok(lowest > 1500 + 180, `a letter is drawn below the box (lowest white at y ${lowest})`);

  const reply = await agent("look", { mode: "zoom", layer: "cap", t: 1 });
  assert.equal(reply.isError, undefined, reply.text);
  const [, x, y, width, height] = /^zoom cap @1s crop (\d+),(\d+) (\d+)×(\d+) at [\d.]+×$/m.exec(reply.text) ?? assert.fail(reply.text);
  // Before: crop 276,1476 368×228 (the box and 24 px), which ends at y 1704.
  assert.ok(Number(y) + Number(height) >= lowest + 10, `the crop ends below the lowest letter: ${reply.text}`);
  assert.ok(Number(x) + Number(width) >= rightmost + 10, `and right of the rightmost: ${reply.text}`);
  // The crop's lowest quarter shows the E.
  const image = await readImage(Buffer.from(reply.images[0].data, "base64"));
  let white = 0;
  for (let row = Math.floor(image.height * 0.75); row < image.height; row += 2)
    for (let column = 0; column < image.width; column += 2) if (isWhite(image.pixel(column, row))) white += 1;
  assert.ok(white > 50, `the second line shows in the crop (${white} white pixels)`);
});

test("look reads time or at as t and says so, instead of drawing the middle frame", async () => {
  const frame = await agent("look", { mode: "frame", time: 1 });
  assert.match(frame.text, /^frame s1 @1s /, frame.text);
  assert.match(frame.text, /\(time read as t: look takes t, in seconds\)/, frame.text);
  const at = await agent("look", { mode: "frame", at: 3 });
  assert.match(at.text, /@3s/, at.text);
  const plain = await agent("look", { mode: "frame", t: 2 });
  assert.doesNotMatch(plain.text, /read as t/, plain.text);
});

test("look frames shows every frame of a stretch at 30 fps, and strip every:true every frame of an animation", async () => {
  const made = await agent("edit", { ops: [
    { op: "add_layer", layerType: "rectangle", name: "phone", properties: { x: 390, y: 710, width: 300, height: 500, fill: "#ffffff" } },
    { op: "add_animation", layer: "phone", animation: { kind: "custom", name: "Grow", start: 1, duration: 0.5, easing: "smooth", from: { scale: 1 }, to: { scale: 2 } } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const frames = await agent("look", { mode: "frames", from: 1, to: 1.2, width: 120 });
  assert.match(frames.text, /^frames s1 1–1\.2s: 7 frames at 30 fps/, frames.text);
  const long = await agent("look", { mode: "frames", from: 0, to: 3, width: 96 });
  assert.match(long.text, /36 frames .* look \{mode:"frames", from:1\.2, to:3\} for the rest/, long.text);
  const strip = await agent("look", { mode: "strip", anim: "phone.custom", every: true });
  assert.match(strip.text, /every frame at 30 fps, 16 tiles/, strip.text);
});

test("times pages stay inside the page size, balance their pages and cap a call at 3 pages", () => {
  for (const tile of [{ width: 96, height: 54 }, { width: 240, height: 135 }, { width: 480, height: 270 }, { width: 135, height: 240 }, { width: 800, height: 450 }]) {
    for (const count of [1, 7, 24, 60]) {
      const plan = timesPlan(count, tile);
      const rows = Math.ceil(plan.perPage / plan.columns);
      const width = plan.columns * tile.width + (plan.columns - 1) * 4;
      assert.ok(plan.shown <= count && plan.pages <= PAGES_MOST, JSON.stringify({ tile, count, plan }));
      assert.ok(width <= PAGE_WIDTH || plan.columns === 1, `${tile.width}: ${width} px wide`);
      assert.ok(rows === 1 || width * (rows * tile.height + (rows - 1) * 4) <= PAGE_PIXELS, `${tile.width}x${count}: ${rows} rows`);
    }
  }
  // 24 tiles of 240 px are one page (the 24 looks a director made one by one).
  assert.deepEqual(timesPlan(24, { width: 240, height: 135 }), { columns: 6, perPage: 24, pages: 1, shown: 24 });
  // With no width, a few times get bigger tiles, as long as they all stay on one page.
  const wide = { width: 1920, height: 1080 };
  assert.deepEqual([3, 9, 10, 24, 28, 60].map((count) => timesEdge(count, wide)), [480, 480, 400, 280, 240, 240]);
  // Balanced: 40 tiles that fit 36 a page come as two pages of 20, and 4 that fit 3 a row as 2 rows of 2.
  assert.deepEqual(timesPlan(40, { width: 240, height: 135 }).perPage, 20);
  assert.equal(timesPlan(4, { width: 480, height: 297 }).columns, 2);
  // A label's bar fits the crop's margin (24 scene px) and is at most 18 px.
  assert.deepEqual([timesLabel(1, true), timesLabel(0.5, true), timesLabel(2, true), timesLabel(0.25, false)], [16, 10, 18, 18]);
  const fourth = everyNth(1, 2, 4);
  assert.deepEqual([fourth.times.map((time) => time.toFixed(2)).join(" "), fourth.rest], ["1.00 1.13 1.27 1.40 1.53 1.67 1.80 1.93", null]);
  assert.equal(everyNth(0, 100, 1).times.length, 60);
  assert.equal(everyNth(0, 100, 1).rest, 2);
});

test("look frames with times: labeled pages within the size limits, side by side for frame, cropped to a layer, thinned by every", async () => {
  // The scene is 1080×1920: 7 times fit one page at a 400 px long edge (timesEdge), given as text too.
  const chosen = await agent("look", { mode: "frames", times: "0.5, 1, 1.1, 1.25, 1.5, 2, 3" });
  assert.equal(chosen.isError, undefined, chosen.text);
  assert.match(chosen.text, /^frames s1: 7 chosen times in 1 page, tiles 225×400, 4 a row, each labeled time and frame number at 30 fps: 0\.5 1 1\.1 1\.25 1\.5 2 3$/m, chosen.text);
  const page = await readImage(Buffer.from(chosen.images[0].data, "base64"));
  assert.deepEqual([page.width, page.height], [4 * 225 + 3 * 4, 2 * 400 + 4]);

  // 60 times at a large tile would be many pages: a call draws 3 pages, the rest comes back as a call.
  const many = await agent("look", { mode: "frames", times: Array.from({ length: 60 }, (_, index) => index / 15), width: 480 });
  assert.equal(many.images.length, 3, many.text);
  for (const image of many.images) assert.ok((await readImage(Buffer.from(image.data, "base64"))).width <= 1568, "a page is at most 1,568 px wide");
  assert.match(many.text, /not drawn: 45 times; at most 60 times and 3 pages a call/, many.text);
  assert.match(many.text, /^next: look \{"mode":"frames","times":\[1,1\.07,/m, many.text);

  // frame with 3 times: side by side at look frame's own width; 4 narrow to fit one row.
  const three = await agent("look", { mode: "frame", times: [0.5, 1, 2] });
  const row = await readImage(Buffer.from(three.images[0].data, "base64"));
  assert.deepEqual([three.images.length, row.width, row.height], [1, 3 * 480 + 8, 853], three.text);
  const four = await agent("look", { mode: "frame", times: [0.5, 1, 1.5, 2] });
  assert.match(four.text, /389 px each: 4 must fit 1568 px/, four.text);
  const one = await agent("look", { mode: "frame", times: [1] });
  assert.match(one.text, /^frame s1 @1s /, one.text);

  // layer: every tile is that layer's part on screen, joined over the times (phone grows 1 to 1.5 s).
  const cropped = await agent("look", { mode: "frames", times: [0.5, 1.25, 1.5], layer: "phone" });
  assert.equal(cropped.isError, undefined, cropped.text);
  assert.match(cropped.text, /cropped to phone \(\d+,\d+ \d+×\d+, its part on screen at any of the times\)/, cropped.text);
  const crop = await readImage(Buffer.from(cropped.images[0].data, "base64"));
  // The phone (300×500 at 390,710, up to 2× while growing) joined over the times, 24 px margin: 3 tiles of its shape, not of the frame's 135×240.
  const [, cropWidth, cropHeight] = /cropped to phone \(\d+,\d+ (\d+)×(\d+),/.exec(cropped.text);
  assert.ok(Number(cropWidth) < 1080 && Number(cropHeight) < 1920, cropped.text);
  assert.notEqual(crop.width, 3 * 135 + 2 * 4, `${crop.width}×${crop.height}: ${cropped.text}`);
  assert.ok(Math.abs(crop.width - 8) / 3 / crop.height > 0.3 && Math.abs(crop.width - 8) / 3 / crop.height < 1, `${crop.width}×${crop.height}`);
  // look changed redraws the same crop, not the whole frame.
  await agent("edit", { ops: [{ op: "update_layer", layer: "phone", properties: { fill: "#ff8800" } }] });
  const changed = await agent("look", { mode: "changed" });
  await agent("edit", { ops: [{ op: "update_layer", layer: "phone", properties: { fill: "#ffffff" } }] });
  const again = await readImage(Buffer.from(changed.images[0].data, "base64"));
  assert.deepEqual([again.width, again.height], [crop.width, crop.height], changed.text);

  // every:n frames between from and to.
  const thin = await agent("look", { mode: "frames", from: 0, to: 2, every: 15 });
  assert.match(thin.text, /^frames s1: every 15th frame in 1 page, tiles 270×480, 5 a row, each labeled time and frame number at 30 fps: 0 0\.5 1 1\.5 2$/m, thin.text);
  const bad = await agent("look", { mode: "frames", times: [1, -2] });
  assert.match(bad.text, /times is a list of seconds/, bad.text);
  const none = await agent("look", { mode: "frames" });
  assert.match(none.text, /or times:\[1, 1\.5, 2\]/, none.text);
});

test("look motion: the trace measures each 0.5 s and notes the camera rules' findings, not its own verdicts", async () => {
  const reply = await agent("look", { mode: "motion", from: 0.5, to: 2 });
  assert.equal(reply.isError, undefined, reply.text);
  assert.match(reply.text, /^1\.0 cover 1\.00 \| plate \S+ still \| mover phone \+\d+%\/s /m, reply.text);
  assert.doesNotMatch(reply.text, /LONE PUSH|DIP|EDGE/, reply.text);
  assert.ok(reply.images[0].data.length > 1000, "a graph PNG");
  // A camera finding is noted in full on the step it starts in; an edge sliver under 0.1 s is not noted.
  const trace = (count, edge) => ({ fps: 30, times: Array.from({ length: count }, (_, i) => i / 30), cover: Array(count).fill(1), plate: Array(count).fill(null), mover: Array(count).fill(null),
    edge: Array.from({ length: count }, (_, i) => (i < edge ? { name: "card", share: 0.01 } : null)), cuts: [] });
  const finding = { rule: "lone_zoom", severity: "error", at: 0.6, until: 0.9, message: "phone grows x1.40 from 0.6 to 0.9 s while plate behind it holds still: only the picture moves." };
  const { text } = traceText(trace(30, 2), { findings: [finding] });
  assert.match(text, /^0\.5 .*E lone_zoom 0\.6-0\.9s: phone grows x1\.40 from 0\.6 to 0\.9 s$/m, text);
  assert.doesNotMatch(text, /edge card/, text);
  assert.match(traceText(trace(30, 6)).text, /edge card 1\.0% of frame for 0\.20s/);
});

test("look changed shows every span an edit changed, even where the last look drew no frame", async () => {
  await agent("look", { mode: "sheet" });
  const made = await agent("edit", { ops: [0.45, 1.15, 3.0].map((start, index) => ({ op: "add_layer", layerType: "rectangle", name: `flash-${index}`, properties: { x: 300, y: 700, width: 480, height: 480, fill: "#ff00ff" }, animations: [{ preset: "show", start }, { preset: "hide", start: start + 0.2 }] })) });
  assert.equal(made.isError, undefined, made.text);
  const reply = await agent("look", { mode: "changed" });
  assert.equal(reply.isError, undefined, reply.text);
  const labels = reply.text.split("\n")[0];
  for (const span of [/ in 0\.\d+-0\.\d+s/, / in 1\.\d+-1\.\d+s/, / in 3\.\d+-3\.\d+s/]) assert.match(labels, span, reply.text);
  const frames = labels.split(" in ").length - 1;
  assert.match(reply.text, /^3 changed spans \(scanned the whole scene against rev \d+\)$/m, reply.text);
  // Nothing more changed: the next look is quiet, and the spans are remembered as frames.
  assert.match((await agent("look", { mode: "changed" })).text, new RegExp(`^nothing visible changed in s1 since your last look \\(${12 + frames} frames compared\\)`), "12 sheet frames and those of the spans");
  // A cover that is gone by the last frame: the returns line also prints how alike the first and last pictures are.
  const alike = async () => Number((await agent("look", { mode: "sheet" })).text.match(/first and last picture alike: (\d(?:\.\d+)?)/)?.[1]);
  const before = await alike();
  assert.ok(before > 0.5 && before < 1, `the flashes are small: most of the first and last pictures match (${before})`);
  await agent("edit", { ops: [{ op: "add_layer", layerType: "rectangle", name: "cover", properties: { x: -500, y: -500, width: 4000, height: 4000, fill: "#ff00ff" }, animations: [{ preset: "hide", start: 0.3 }] }] });
  assert.ok(await alike() < 0.1, "the first picture is the cover, the last is not");
});

test("spanPicks gives every span a frame, spreads the rest by length and reports the spans the limit cuts", () => {
  const spans = [{ from: 4.3, to: 5.5 }, { from: 8, to: 8.2 }, { from: 9, to: 9.4 }];
  const { picks, left } = spanPicks(spans, 6);
  assert.deepEqual(left, []);
  assert.deepEqual(picks.map((pick) => pick.from), [4.3, 4.3, 4.3, 8, 9, 9], "the long span gets the spare frames");
  const cut = spanPicks(spans, 2);
  assert.deepEqual([cut.picks.map((pick) => pick.time), cut.left], [[4.9, 8.1], [{ from: 9, to: 9.4 }]]);
  // The spans left out are drawn by chosen times (one per span), not a from-to stretch that stops 1.2 s in.
  assert.deepEqual(leftOutCall([{ from: 2, to: 2.4 }, { from: 9, to: 9.4 }]), { call: 'look {mode:"frames", times:[2.2, 9.2]}', count: 2 });
  const probes = probeTimes(14);
  assert.equal(spansOfFlags(probes.times, probes.times.map((time) => time > 4 && time < 4.5), probes.step, probes.last).length, 1);
});
