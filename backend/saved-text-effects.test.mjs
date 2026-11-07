import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDocument, createLayer } from "../engine/model.js";
import { savedTextEffectInput } from "../engine/savedTextEffects.js";
import { openStore } from "./store.mjs";

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kino-text-effects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function input(name = "Rise") {
  const layer = createLayer("text", {
    id: "source-layer",
    text: "This source text must not be stored",
    fontSource: "/api/media/01234567-89ab-cdef-0123-456789abcdef.woff2",
    x: 5,
  });
  return savedTextEffectInput(name, layer, {
    id: "source-animation",
    name: "Original animation name",
    kind: "custom",
    start: 3,
    duration: 1,
    easing: "linear",
    from: { x: 10 },
    to: { x: 30 },
  });
}

test("older stores read without rewriting, then persist text effects on the next successful mutation", async (t) => {
  const root = await makeRoot(t);
  const filename = path.join(root, "store.json");
  const first = await openStore(root);
  await first.createProject(createDocument({ id: "text-effect-project", name: "Existing project" }));
  const state = JSON.parse(await readFile(filename, "utf8"));
  delete state.textEffects;
  const oldText = `${JSON.stringify(state)}\n`;
  await writeFile(filename, oldText, { mode: 0o600 });

  const reopened = await openStore(root);
  assert.deepEqual(await reopened.listTextEffects(), []);
  assert.equal(await readFile(filename, "utf8"), oldText);
  const saved = await reopened.saveTextEffect(input("  Rise  "));
  assert.equal(saved.name, "Rise");
  const persisted = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(persisted.textEffects.length, 1);
  assert.equal(JSON.stringify(persisted.textEffects[0]).includes("This source text must not be stored"), false);
  assert.equal(JSON.stringify(persisted.textEffects[0]).includes("/api/media/"), false);
  assert.equal(Object.hasOwn(persisted.textEffects[0].animation, "start"), false);
  assert.equal(Object.hasOwn(persisted.textEffects[0].animation, "id"), false);
  assert.equal(Object.hasOwn(persisted.textEffects[0].animation, "name"), false);
  assert.equal(Object.hasOwn(persisted.textEffects[0].animation, "enabled"), false);
  assert.equal((await first.listTextEffects()).length, 1, "separate handles see the persisted library");
});

test("saved text effects are deep-copied and survive store reopen, rename, and delete", async (t) => {
  const root = await makeRoot(t);
  const store = await openStore(root);
  const source = input();
  const saved = await store.saveTextEffect(source);
  source.animation.to.x = 999;
  saved.animation.from.x = 999;
  const listed = await store.listTextEffects();
  assert.equal(listed[0].animation.to.x, 30);
  assert.equal(listed[0].animation.from.x, 10);

  const renamed = await store.renameTextEffect(saved.id, "  Reusable rise  ");
  assert.equal(renamed.name, "Reusable rise");
  const reopened = await openStore(root);
  assert.deepEqual(await reopened.listTextEffects(), [renamed]);
  assert.deepEqual(await reopened.deleteTextEffect(saved.id), { deleted: saved.id });
  assert.deepEqual(await reopened.listTextEffects(), []);
  await assert.rejects(reopened.renameTextEffect(saved.id, "Missing"), { code: "ERR_TEXT_EFFECT_NOT_FOUND" });
});
