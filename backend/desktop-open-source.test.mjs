// "o open the source" (desktop/open-source.mjs): only a trusted window may ask, and only a
// YouTube https page is handed to the default browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installOpenSource, openSource } from "../desktop/open-source.mjs";

function fakeShell() {
  const opened = [];
  return { opened, openExternal: async (url) => { opened.push(url); } };
}

test("a YouTube page opens in the default browser; other links and untrusted senders are refused", async () => {
  const shell = fakeShell();
  assert.deepEqual(await openSource({ shell, trusted: true, url: "https://www.youtube.com/watch?v=tgEWNHVbk3U" }), { ok: true });
  assert.deepEqual(await openSource({ shell, trusted: true, url: "https://youtu.be/tgEWNHVbk3U" }), { ok: true });
  for (const url of ["http://www.youtube.com/watch?v=x", "https://evil.example/watch", "file:///etc/passwd", "javascript:alert(1)", "https://youtube.com.evil.example/", 42]) {
    assert.equal((await openSource({ shell, trusted: true, url })).ok, false, String(url));
  }
  assert.deepEqual(await openSource({ shell, trusted: false, url: "https://www.youtube.com/watch?v=tgEWNHVbk3U" }), { ok: false, error: "This request is not allowed." });
  assert.deepEqual(shell.opened, ["https://www.youtube.com/watch?v=tgEWNHVbk3U", "https://youtu.be/tgEWNHVbk3U"]);
});

test("the IPC handler checks the sender", async () => {
  const handlers = new Map();
  const shell = fakeShell();
  installOpenSource({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, shell, trustedSender: (event) => event.trusted });
  const handler = handlers.get("kino:open-source");
  assert.equal((await handler({ trusted: false }, "https://www.youtube.com/watch?v=tgEWNHVbk3U")).ok, false);
  assert.equal((await handler({ trusted: true }, "https://www.youtube.com/watch?v=tgEWNHVbk3U")).ok, true);
  assert.equal(shell.opened.length, 1);
});
