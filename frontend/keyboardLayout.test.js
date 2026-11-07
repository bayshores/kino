import test from "node:test";
import assert from "node:assert/strict";
import { shortcutLetter } from "./keyboardLayout.js";

// What navigator.keyboard.getLayoutMap() returns: the printed character for each key position.
const QWERTY = new Map([["KeyA", "a"], ["KeyQ", "q"], ["KeyW", "w"], ["KeyZ", "z"], ["KeyH", "h"], ["KeyJ", "j"], ["KeyM", "m"]]);
const AZERTY = new Map([["KeyA", "q"], ["KeyQ", "a"], ["KeyW", "z"], ["KeyZ", "w"], ["KeyH", "h"], ["KeyM", ","], ["Semicolon", "m"]]);
const DVORAK = new Map([["KeyA", "a"], ["KeyJ", "h"], ["KeyH", "d"], ["KeyW", ","]]);
const RUSSIAN = new Map([["KeyA", "ф"], ["KeyH", "р"]]);

test("the typed letter wins when Alt leaves it unchanged (Windows and Linux, any layout)", () => {
  // AZERTY: the key with A printed on it sits where QWERTY has Q.
  assert.equal(shortcutLetter({ code: "KeyQ", key: "a" }), "a");
  assert.equal(shortcutLetter({ code: "KeyA", key: "q" }, AZERTY), "q");
  // Dvorak: the key with H printed on it sits where QWERTY has J.
  assert.equal(shortcutLetter({ code: "KeyJ", key: "h" }), "h");
  assert.equal(shortcutLetter({ code: "KeyA", key: "A" }), "a");
});

test("when Option changes the character, the layout says which letter is on the key", () => {
  assert.equal(shortcutLetter({ code: "KeyA", key: "å" }, QWERTY), "a");
  assert.equal(shortcutLetter({ code: "KeyQ", key: "æ" }, AZERTY), "a");
  assert.equal(shortcutLetter({ code: "KeyZ", key: "Â" }, AZERTY), "w");
  assert.equal(shortcutLetter({ code: "KeyJ", key: "∆" }, DVORAK), "h");
  // Option can also give a dead key or a plain punctuation mark.
  assert.equal(shortcutLetter({ code: "KeyH", key: "Dead" }, AZERTY), "h");
  assert.equal(shortcutLetter({ code: "KeyA", key: "@" }, QWERTY), "a");
  // A key with a punctuation mark printed on it is not a letter, wherever it sits.
  assert.equal(shortcutLetter({ code: "KeyM", key: "∞" }, AZERTY), null);
  assert.equal(shortcutLetter({ code: "KeyW", key: "≤" }, DVORAK), null);
});

test("the key position is the last resort: no layout map, or a non-Latin layout", () => {
  assert.equal(shortcutLetter({ code: "KeyA", key: "å" }), "a");
  assert.equal(shortcutLetter({ code: "KeyA", key: "ф" }, RUSSIAN), "a");
  assert.equal(shortcutLetter({ code: "KeyH", key: "р" }, RUSSIAN), "h");
  // Without a layout map, a typed digit or punctuation mark is trusted: that key is no letter.
  assert.equal(shortcutLetter({ code: "KeyW", key: "," }), null);
  assert.equal(shortcutLetter({ code: "Digit1", key: "¡" }), null);
  assert.equal(shortcutLetter({ code: "", key: "" }), null);
  assert.equal(shortcutLetter(null), null);
});
