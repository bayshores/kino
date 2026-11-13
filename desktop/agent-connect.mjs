// The settings screen's "agents" rows (frontend/dashboard/settings.jsx): Cursor and VS Code each open
// an install link (engine/agentLinks.js), and Claude Desktop opens the extension that
// `npm run mcpb:pack` wrote. Only a trusted window may ask, only those two link forms are handed to
// the system, and the extension is always the one file at `bundle`.
import { existsSync } from "node:fs";

const LINK_FORMS = ["cursor://anysphere.cursor-deeplink/mcp/install?", "vscode:mcp/install?"];

/** Opens `url` with shell.openExternal when the sender is trusted and the link is an install link. */
export async function openAgentLink({ shell, trusted, url }) {
  if (!trusted) return { ok: false, error: "This request is not allowed." };
  if (typeof url !== "string" || url.length > 8192 || !LINK_FORMS.some((form) => url.startsWith(form)))
    return { ok: false, error: "Only an install link for Cursor or VS Code can be opened here." };
  try {
    await shell.openExternal(url, { activate: true });
    return { ok: true };
  } catch {
    return { ok: false, error: "That app could not open the link. Is it installed?" };
  }
}

/** "status" tells whether the extension is built; "open" hands it to Claude Desktop, else shows it in Finder. */
export async function claudeDesktopBundle({ shell, trusted, action, bundle }) {
  if (!trusted) return { ok: false, error: "This request is not allowed." };
  const built = existsSync(bundle);
  if (action === "status") return { ok: true, built };
  if (action !== "open") return { ok: false, error: "Unknown action." };
  if (!built) return { ok: false, built, error: "The extension is not built yet." };
  const failed = await shell.openPath(bundle);
  if (!failed) return { ok: true, built };
  shell.showItemInFolder(bundle);
  return { ok: true, built, revealed: true };
}

export function installAgentConnect({ ipcMain, shell, trustedSender, isClosing = () => false, bundle }) {
  ipcMain.handle("kino:agent-link", (event, url) => openAgentLink({ shell, trusted: trustedSender(event) && !isClosing(), url }));
  ipcMain.handle("kino:claude-desktop", (event, action) => claudeDesktopBundle({ shell, trusted: trustedSender(event) && !isClosing(), action, bundle }));
}
