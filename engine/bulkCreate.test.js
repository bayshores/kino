import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createScene, createLayer, parseDocument, MAX_SCENES } from "./model.js";
import { bulkCreateColumns, bulkCreateTemplate, planBulkCreate, applyBulkCreate, bulkCreateSummary, bulkCreateLimitProblem } from "./bulkCreate.js";
import { expandComponents } from "./linkedComponents.js";

function fixture() {
  return parseDocument(createDocument({ id: "project", scenes: [createScene({ id: "base", name: "Card", width: 480, height: 320, duration: 6,
    background: "#123456", backgroundEnabled: false, layers: [
      createLayer("text", { id: "title", name: "Title", text: "Original", textResize: "width-height" }),
      createLayer("image", { id: "photo", name: "Photo", src: "/api/media/aaa.png" }),
      createLayer("image", { id: "gif", name: "Animation", src: "/api/media/aaa.gif", mediaSourceDuration: 2 }),
    ],
  })] }));
}
function run(document, rows, options = {}) {
  const [header, ...data] = rows;
  const plan = planBulkCreate(document, "base", header, data, options.files ?? []);
  return { plan, document: parseDocument(applyBulkCreate(document, plan, options.sources ?? {}, options)) };
}

test("columns include unique direct text and image/GIF layers, including grouped children, and explain exclusions", () => {
  const document = fixture();
  document.scenes[0].layers.push(
    createLayer("text", { id: "duplicate-title", name: "Title" }),
    createLayer("video", { id: "video", name: "Video" }),
    createLayer("path", { id: "path", name: "Vector" }),
    createLayer("text", { id: "reserved", name: "ID" }),
    createLayer("image", { id: "log", name: "info_log" }),
    createLayer("group", { id: "group", name: "Group" }),
    createLayer("text", { id: "child", name: "Child", parentId: "group" }),
  );
  const { columns, skipped } = bulkCreateColumns(document, "base");
  assert.deepEqual(columns.map((column) => column.name), ["Photo", "Animation", "Child"]);
  assert.ok(skipped.some((item) => item.reason === "Rename one of the 2 layers named Title"));
  assert.ok(skipped.some((item) => item.name === "ID"));
  assert.ok(skipped.some((item) => item.name === "Video"));
});

test("create makes linked variants in CSV order, flips the base and keeps version 3 background fields", () => {
  const before = fixture();
  const { document, plan } = run(before, [["id", "Title"], ["", "Original"], ["blue", "Blue"], ["red", "Red"]]);
  assert.equal(plan.skipped.filter((entry) => entry.row).length, 1);
  assert.equal(plan.creates.length, 2);
  assert.equal(before.scenes.length, 1, "the source stays untouched");
  const [base, blue, red] = document.scenes;
  assert.equal(base.isComponent, true);
  assert.deepEqual([blue.name, red.name], ["Card - blue", "Card - red"]);
  assert.deepEqual(blue.bulkVariant, { baseSceneId: "base", key: "blue", instanceId: blue.layers[0].id });
  assert.deepEqual([blue.width, blue.height, blue.duration, blue.background, blue.backgroundEnabled], [480, 320, 6, "#123456", false]);
  assert.deepEqual([blue.layers[0].type, blue.layers[0].componentSceneId, blue.layers[0].x, blue.layers[0].y, blue.layers[0].clipContent, blue.layers[0].componentStart], ["component", "base", 0, 0, true, 0]);
  assert.equal(expandComponents(document, blue.id).layers.find((layer) => layer.text === "Blue")?.type, "text");
});

test("template contains the base row, scene ordered variants, media sources and only differing cells", () => {
  const { document } = run(fixture(), [["id", "Title", "Photo"], ["a", "Original", "/api/media/bbb.png"], ["b", "Other", ""]]);
  assert.deepEqual(bulkCreateTemplate(document, "base"), [
    ["id", "Title", "Photo", "Animation", "info_log"],
    ["", "Original", "/api/media/aaa.png", "/api/media/aaa.gif", "Base scene (not created)"],
    ["a", "", "/api/media/bbb.png", "", ""],
    ["b", "Other", "", "", ""],
  ]);
});

test("updates keep identity, scene name/position and hand overrides; blanks reset only matched column keys", () => {
  const first = run(fixture(), [["id", "Title", "Photo"], ["a", "First", "/api/media/bbb.png"]]).document;
  const variant = first.scenes[1];
  variant.name = "My custom name";
  variant.layers[0].x = 42;
  variant.layers[0].componentOverrides.title.fill = "#ff0000";
  variant.layers[0].componentOverrides.photo.opacity = 0.4;
  const { document, plan } = run(first, [["id", "Title"], ["a", ""]]);
  assert.equal(plan.updates.length, 1);
  assert.equal(document.scenes[1].id, variant.id);
  assert.equal(document.scenes[1].name, "My custom name");
  assert.equal(document.scenes[1].layers[0].x, 42);
  assert.deepEqual(document.scenes[1].layers[0].componentOverrides, { title: { fill: "#ff0000" }, photo: { src: "/api/media/bbb.png", mediaSourceDuration: 0, opacity: 0.4 } });
  assert.equal(run(document, [["id", "Title"], ["a", ""]]).plan.unchanged.length, 1);
});

test("headers prefer exact matches then unique case insensitive matches and report ignored columns", () => {
  const { plan, document } = run(fixture(), [["ID", "title", "unmatched", "info_log"], ["one", "Value", "ignored", "ignored"]]);
  assert.equal(document.scenes[1].layers[0].componentOverrides.title.text, "Value");
  assert.ok(plan.skipped.some((item) => item.column === "unmatched"));
  const ambiguous = fixture();
  ambiguous.scenes[0].layers.push(createLayer("text", { id: "title2", name: "TITLE" }));
  const result = planBulkCreate(ambiguous, "base", ["id", "title", "Title"], [["x", "ignored", "exact"]], []);
  assert.ok(result.skipped.some((item) => item.column === "title" && /ambiguous/i.test(item.message)));
  assert.equal(result.creates[0].changes[0].value, "exact");
});

test("every repeated id is an error with the other CSV row and valid rows still apply", () => {
  const { plan, document } = run(fixture(), [["id", "Title"], ["same", "A"], ["ok", "Yes"], ["same", "B"], ["", "Original"]]);
  assert.equal(plan.errors.length, 2);
  assert.match(plan.errors[0].message, /also on row 4/);
  assert.match(plan.errors[1].message, /also on row 2/);
  assert.equal(document.scenes.length, 2);
  assert.equal(document.scenes[1].bulkVariant.key, "ok");
  const summary = bulkCreateSummary(["id", "Title"], [["same", "A"], ["ok", "Yes"], ["same", "B"], ["", "Original"]], plan);
  assert.equal(summary[2].at(-1), "Created");
  assert.equal(summary[4].at(-1), "Skipped: no id");
});

test("exact header matches take precedence and unchanged overrides do not depend on object key order", () => {
  const { document } = run(fixture(), [["id", "title", "Title"], ["a", "Ignored", "Exact"]]);
  const instance = document.scenes[1].layers[0];
  assert.equal(instance.componentOverrides.title.text, "Exact");
  instance.componentOverrides.title.fill = "#ff0000";
  const { plan } = run(document, [["id", "Title"], ["a", "Exact"]]);
  assert.equal(plan.unchanged.length, 1);
});

test("missing variants are listed and only deleted with the flag; referenced variants give an error", () => {
  const first = run(fixture(), [["id", "Title"], ["a", "A"], ["b", "B"]]).document;
  const [header, ...rows] = [["id", "Title"], ["a", "A"]];
  const plan = planBulkCreate(first, "base", header, rows, []);
  assert.equal(plan.deletes.length, 1);
  assert.equal(applyBulkCreate(first, plan, {}, {}).scenes.length, 3);
  assert.equal(applyBulkCreate(first, plan, {}, { deleteMissing: true }).scenes.length, 2);
  assert.equal(bulkCreateSummary(header, rows, { ...plan, deleteMissing: true }).at(-1).at(-1), "Deleted");
  first.scenes[2].isComponent = true;
  first.scenes.push(createScene({ id: "consumer", layers: [createLayer("component", { id: "reference", componentSceneId: first.scenes[2].id })] }));
  const blocked = planBulkCreate(first, "base", header, rows, []);
  assert.match(blocked.deletes[0].error, /linked instance/i);
  assert.equal(applyBulkCreate(first, blocked, {}, { deleteMissing: true }).scenes.length, 4);
});

test("detached or replaced variant instances give an error without rebuilding the user's work", () => {
  const first = run(fixture(), [["id", "Title"], ["a", "A"]]).document;
  first.scenes[1].layers = [createLayer("rectangle", { id: "handmade" })];
  const { plan, document } = run(first, [["id", "Title"], ["a", "B"], ["new", "Yes"]]);
  assert.match(plan.errors[0].message, /Variant a no longer uses Card; skipped/);
  assert.equal(document.scenes[1].layers[0].id, "handmade");
  assert.equal(plan.creates.length, 1);
});

test("image names match exactly then case insensitively and upload each used image once", () => {
  const files = [{ name: "a.PNG", type: "image/png" }, { name: "A.png", type: "image/png" }, { name: "still.gif", type: "image/gif" }, { name: "unused.png", type: "image/png" }];
  const { plan, document } = run(fixture(), [["id", "Photo", "Animation"], ["a", "a.PNG", "STILL.GIF"], ["b", "a.PNG", ""]], {
    files, sources: { "a.PNG": { src: "/api/media/bbb.png" }, "still.gif": { src: "/api/media/bbb.gif", measurements: { duration: 3 } } },
  });
  assert.deepEqual(plan.imagesNeeded, ["a.PNG", "still.gif"]);
  assert.ok(plan.skipped.some((item) => item.file === "unused.png"));
  assert.equal(document.scenes[1].layers[0].componentOverrides.gif.mediaSourceDuration, 3);
  assert.equal(document.scenes[2].layers[0].componentOverrides.photo.src, "/api/media/bbb.png");
});

test("image files with a generic browser MIME type use their image extension", () => {
  const plan = planBulkCreate(fixture(), "base", ["id", "Photo"], [["a", "photo.png"]], [{ name: "photo.png", type: "application/octet-stream" }]);
  assert.equal(plan.errors.length, 0);
  assert.deepEqual(plan.imagesNeeded, ["photo.png"]);
});

test("ambiguous, missing, and non-image cells are row errors and existing media URLs stay usable", () => {
  const files = ["a.PNG", "A.png", "video.mp4"];
  const { plan, document } = run(fixture(), [["id", "Photo"], ["ambiguous", "a.png"], ["missing", "none.png"], ["video", "video.mp4"], ["good", "/api/media/bbb.svg"]], { files });
  assert.match(plan.errors[0].message, /ambiguous: a.PNG and A.png/);
  assert.match(plan.errors[1].message, /missing/);
  assert.match(plan.errors[2].message, /not an image/);
  assert.equal(document.scenes.length, 2);
});

test("new variants are placed after the last existing variant and existing scene order stays fixed", () => {
  const first = run(fixture(), [["id", "Title"], ["a", "A"]]).document;
  first.scenes.splice(1, 0, createScene({ id: "between" }));
  first.scenes.push(createScene({ id: "after" }));
  const next = run(first, [["id", "Title"], ["b", "B"], ["a", "A"], ["c", "C"]]).document;
  assert.deepEqual(next.scenes.map((scene) => scene.bulkVariant?.key ?? scene.id), ["base", "between", "a", "b", "c", "after"]);
});

test("limits are friendly before apply and deletions count only when requested", () => {
  const document = fixture();
  while (document.scenes.length < MAX_SCENES) document.scenes.push(createScene({ id: `empty-${document.scenes.length}` }));
  const plan = planBulkCreate(document, "base", ["id", "Title"], [["new", "Value"]], []);
  assert.equal(bulkCreateLimitProblem(document, plan), "This would make 101 scenes; the limit is 100.");
  assert.throws(() => applyBulkCreate(document, plan, {}), /limit is 100/);
  assert.throws(() => planBulkCreate(document, "base", ["id"], Array.from({ length: MAX_SCENES + 2 }, (_, index) => [String(index)]), []), /rows/i);
});

test("background animation ids are fresh and the result survives parseDocument", () => {
  const document = fixture();
  document.scenes[0].backgroundAnimations = [{ id: "bg", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ffffff" }, to: { fill: "#000000" } }];
  const next = run(document, [["id"], ["a"], ["b"]]).document;
  assert.equal(new Set(next.scenes.map((scene) => scene.backgroundAnimations[0].id)).size, 3);
  assert.deepEqual(parseDocument(next), next);
});
