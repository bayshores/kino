import test from "node:test";
import assert from "node:assert/strict";
import { askAfterServiceStopped, askWhenWindowDoesNotAnswer } from "../desktop/dialogs.mjs";

// A stand-in for Electron's dialog: it keeps each question and gives the button at `response`.
function fakeDialog(response) {
  const asked = [];
  return {
    asked,
    showMessageBox: async (...args) => {
      asked.push(args.at(-1));
      return { response };
    },
  };
}

const EDITOR_WORDS = /editor|unsaved|keep editing|save error|file conflict|recovery cop/i;

test("a window that does not answer offers to go ahead anyway or to wait, without editor words", async () => {
  const window = { id: "window" };
  for (const [action, label] of [["close", "Close anyway"], ["quit", "Quit anyway"], ["reload", "Reload anyway"], ["link", "Open the link anyway"]]) {
    const goAhead = fakeDialog(0);
    assert.equal(await askWhenWindowDoesNotAnswer(goAhead, window, action), true, `${label} goes ahead`);
    const [question] = goAhead.asked;
    assert.deepEqual(question.buttons, [label, "Wait"]);
    assert.equal(question.defaultId, 0);
    assert.equal(question.cancelId, 1, "Esc waits");
    assert.match(question.detail, /projects are saved on this Mac by the local kino service/);
    assert.doesNotMatch(`${question.title} ${question.message} ${question.detail}`, EDITOR_WORDS);

    const wait = fakeDialog(1);
    assert.equal(await askWhenWindowDoesNotAnswer(wait, window, action), false, "Wait keeps the window");
  }
  // The question belongs to the window that did not answer.
  let parent;
  await askWhenWindowDoesNotAnswer({ showMessageBox: async (owner) => { parent = owner; return { response: 1 }; } }, window, "close");
  assert.equal(parent, window);
});

test("after the local service stops, the dialog offers restart, quit or not now", async () => {
  assert.equal(await askAfterServiceStopped(fakeDialog(0)), "restart");
  assert.equal(await askAfterServiceStopped(fakeDialog(1)), "quit");
  assert.equal(await askAfterServiceStopped(fakeDialog(2)), "wait");
  const dialog = fakeDialog(2);
  await askAfterServiceStopped(dialog);
  const [question] = dialog.asked;
  assert.deepEqual(question.buttons, ["Restart local service", "Quit kino", "Not now"]);
  assert.equal(question.cancelId, 2, "Esc keeps the windows open");
  assert.match(question.detail, /projects are saved on this Mac/);
  assert.match(question.detail, /Restart local service in the View menu/);
  assert.doesNotMatch(`${question.title} ${question.message} ${question.detail}`, EDITOR_WORDS);
});
