// "o open the source" (desktop/open-source.mjs): only a trusted window may ask, and only a
// YouTube https page is handed to the default browser. Also the settings rows that open an
// install link or the Claude Desktop extension (desktop/agent-connect.mjs).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claudeDesktopBundle, openAgentLink } from "../desktop/agent-connect.mjs";
import { installOpenSource, openSource } from "../desktop/open-source.mjs";
import { cursorInstallLink, vscodeInstallLink } from "../engine/agentLinks.js";

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

test("settings opens only Cursor's and VS Code's install links, and Claude Desktop's extension when it is built", async () => {
  const shell = { ...fakeShell(), shown: [], openPath: async (file) => { shell.opened.push(file); return shell.fail ? "no app" : ""; }, showItemInFolder: (file) => shell.shown.push(file) };
  const cursor = cursorInstallLink({ mcpServers: { kino: { command: "/Applications/kino.app/Contents/MacOS/kino" } } });
  const vscode = vscodeInstallLink({ mcpServers: { kino: { command: "/Applications/kino.app/Contents/MacOS/kino" } } });
  assert.deepEqual(await openAgentLink({ shell, trusted: true, url: cursor }), { ok: true });
  assert.deepEqual(await openAgentLink({ shell, trusted: true, url: vscode }), { ok: true });
  for (const url of ["https://evil.example/", "file:///etc/passwd", "cursor://other.handler/mcp/install?x=1", "vscode:extension/install?x=1", 42])
    assert.equal((await openAgentLink({ shell, trusted: true, url })).ok, false, String(url));
  assert.equal((await openAgentLink({ shell, trusted: false, url: cursor })).ok, false);
  assert.deepEqual(shell.opened, [cursor, vscode]);

  const directory = await mkdtemp(path.join(tmpdir(), "kino-claude-desktop-"));
  try {
    const bundle = path.join(directory, "kino.mcpb");
    assert.deepEqual(await claudeDesktopBundle({ shell, trusted: true, action: "status", bundle }), { ok: true, built: false });
    assert.equal((await claudeDesktopBundle({ shell, trusted: true, action: "open", bundle })).ok, false);
    await writeFile(bundle, "zip");
    assert.deepEqual(await claudeDesktopBundle({ shell, trusted: true, action: "status", bundle }), { ok: true, built: true });
    assert.deepEqual(await claudeDesktopBundle({ shell, trusted: true, action: "open", bundle }), { ok: true, built: true });
    shell.fail = true;
    assert.deepEqual(await claudeDesktopBundle({ shell, trusted: true, action: "open", bundle }), { ok: true, built: true, revealed: true });
    assert.deepEqual(shell.shown, [bundle]);
    assert.equal((await claudeDesktopBundle({ shell, trusted: false, action: "open", bundle })).ok, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
