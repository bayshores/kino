// "o open the source" on the inspire screen (frontend/dashboard/inspire.jsx): the YouTube page of a
// reference opens in the person's default browser. Only https links to youtube.com or youtu.be
// are opened (backend/inspire.mjs isYouTubeUrl); anything else is refused.
import { isYouTubeUrl } from "../backend/inspire.mjs";

export function installOpenSource({ ipcMain, shell, trustedSender, isClosing = () => false }) {
  ipcMain.handle("kino:open-source", async (event, url) => openSource({ shell, trusted: trustedSender(event) && !isClosing(), url }));
}

/** Opens `url` with shell.openExternal when the sender is trusted and the link is YouTube's. */
export async function openSource({ shell, trusted, url }) {
  if (!trusted) return { ok: false, error: "This request is not allowed." };
  if (!isYouTubeUrl(url)) return { ok: false, error: "Only a YouTube page can be opened here." };
  try {
    await shell.openExternal(new URL(url).href, { activate: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `The browser could not open it: ${error.message}` };
  }
}
