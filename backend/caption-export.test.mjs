// Caption files from phrase looks: one event per phrase (not one per word layer), in reading order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createScene } from "../engine/model.js";
import { applyOperations } from "../engine/operations.js";
import { defaultFonts } from "../engine/fonts.js";
import { captionEvents } from "./agent/caption-export.mjs";

test("a phrase look exports one caption event per phrase, its words in order", () => {
  const said = "Meet Acme Notes. It turns your meetings into summaries.".split(" ");
  let at = 0.2;
  const words = said.map((text) => { const word = { text, start: at, end: at + 0.3 }; at += 0.36 + (text.endsWith(".") ? 0.8 : 0); return word; });
  const document = createDocument({ scenes: [createScene({ id: "s1", width: 1920, height: 1080, duration: 6, background: "#101418" })] });
  for (const look of ["highlight", "pop"]) {
    const next = applyOperations(document, [{ type: "add_captions", sceneId: "s1", words, look }], { fonts: defaultFonts });
    const events = captionEvents(next, "s1", { fonts: defaultFonts });
    assert.equal(events[0].text, "Meet Acme Notes.", look);
    // No two events on screen at once: a player shows one line of captions.
    for (let index = 1; index < events.length; index += 1) assert.ok(events[index].start >= events[index - 1].end - 1e-6, `${look}: ${events[index - 1].text} / ${events[index].text}`);
    assert.equal(events.map((event) => event.text.replace(/\n/g, " ")).join(" ").toLowerCase(), said.join(" ").toLowerCase());
  }
});
