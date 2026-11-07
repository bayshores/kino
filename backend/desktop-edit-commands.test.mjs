import test from "node:test";
import assert from "node:assert/strict";
import { installEditCommands } from "../desktop/edit-commands.mjs";

test("native text bridge only runs trusted undo and redo while open", () => {
  let handler, closing = false;
  const calls = [], sender = { undo: () => calls.push("undo"), redo: () => calls.push("redo"), pasteAndMatchStyle: () => calls.push("pasteAndMatchStyle"), delete: () => calls.push("delete") };
  installEditCommands({ ipcMain: { handle: (_name, callback) => { handler = callback; } }, trustedSender: event => event.trusted === true, isClosing: () => closing });
  assert.equal(handler({ trusted: false, sender }, "undo").ok, false);
  assert.equal(handler({ trusted: true, sender }, "delete").ok, false);
  assert.equal(handler({ trusted: true, sender }, "undo").ok, true);
  assert.equal(handler({ trusted: true, sender }, "redo").ok, true);
  assert.equal(handler({ trusted: true, sender }, "pasteAndMatchStyle").ok, false);
  closing = true;
  assert.equal(handler({ trusted: true, sender }, "undo").ok, false);
  assert.deepEqual(calls, ["undo", "redo"]);
});
