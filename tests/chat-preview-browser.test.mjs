// The render preview page (backend/agent/chat-preview.html) in the tests' hidden Electron window,
// with a small stand-in for the chat app (the MCP Apps host): it hands the page a real render
// answer and records openLink. No chat app is involved. KINO_TEST_SHOTS=<folder> saves a picture
// of the page in each theme.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Browser } from "./dashboard-browser.support.mjs";
import { previewVideo, renderPreview } from "../backend/agent/chat-preview.mjs";
import { runMediaTool } from "../backend/media-probe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.KINO_TEST_SHOTS;

// Stands in for the MCP Apps library: connect() hands over the answer in window.__result, the
// host's context is window.__context, callServerTool answers window.__video (or fails without
// it) and records the call, and openLink records the address.
const HOST = `globalThis.ExtApps = { App: class {
  async connect() { setTimeout(() => this.ontoolresult?.(window.__result), 0); }
  getHostContext() { return window.__context; }
  callServerTool(call) { window.__called = call; return window.__video ? Promise.resolve(window.__video) : Promise.reject(new Error("no tool")); }
  openLink({ url }) { window.__opened = url; return Promise.resolve({}); }
} };`;

test("the preview page plays the render's copy and its button asks the chat app to open kino", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "kino-chat-preview-"));
  let browser;
  try {
    const video = path.join(folder, "Launch draft.mp4");
    await runMediaTool("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video]);
    const preview = await renderPreview({ status: "done", path: video, size: 2_400_000 });
    const answer = { content: [{ type: "text", text: await previewVideo(preview.id) }] };
    const page = (await readFile(path.join(root, "backend/agent/chat-preview.html"), "utf8")).replace("/*__EXT_APPS_BUNDLE__*/", () => HOST);
    const pages = {};
    // dark and light get the video; "failed" is a chat app whose tool call fails.
    for (const name of ["dark", "light", "failed"]) {
      const setup = `<script>window.__result = ${JSON.stringify({ content: [{ type: "text", text: "r1 done" }], _meta: { "kino/preview": preview } })};
        window.__video = ${name === "failed" ? "null" : JSON.stringify(answer)};
        window.__context = ${JSON.stringify({ theme: name === "light" ? "light" : "dark", safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } })};</script>`;
      pages[name] = path.join(folder, `${name}.html`);
      await writeFile(pages[name], page.replace("<head>", () => `<head>${setup}`));
    }
    browser = await Browser.open(path.join(folder, "electron"));
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 360, deviceScaleFactor: 1, mobile: false });
    const facts = `{ chips: [...document.querySelectorAll(".chip")].map((chip) => chip.textContent), label: document.getElementById("open").textContent }`;
    // A failed call: the facts and the button stay, and no player is shown.
    await browser.send("Page.navigate", { url: pathToFileURL(pages.failed).href });
    const failed = await browser.waitFor(`window.__called && !document.getElementById("preview").hidden
      && { ...${facts}, player: !document.getElementById("video").hidden, src: document.getElementById("video").currentSrc }`, { what: "the facts without a video" });
    assert.deepEqual(failed, { chips: ["Launch draft.mp4", "3.0 s", "2.4 MB"], label: "Open in kino", player: false, src: "" });
    for (const theme of ["dark", "light"]) {
      await browser.send("Page.navigate", { url: pathToFileURL(pages[theme]).href });
      const state = await browser.waitFor(`(() => {
        const video = document.getElementById("video");
        return !video.hidden && video.readyState >= 2 && video.duration > 0
          && { src: video.currentSrc.slice(0, 22), muted: video.muted, controls: video.controls, theme: document.documentElement.dataset.theme,
               called: window.__called, ...${facts} };
      })()`, { what: "the preview video to load" });
      assert.deepEqual(state, { src: "data:video/mp4;base64,", muted: true, controls: true, theme,
        called: { name: "render_preview", arguments: { id: preview.id } }, chips: ["Launch draft.mp4", "3.0 s", "2.4 MB"], label: "Open in kino" });
      if (shots) {
        // A chat app's backdrop behind the see-through page, for the picture only.
        await browser.evaluate(`document.body.style.background = ${JSON.stringify(theme === "dark" ? "#0a0a0a" : "#f4f2ec")}; true`);
        const { data } = await browser.send("Page.captureScreenshot", { format: "png" });
        await mkdir(shots, { recursive: true });
        await writeFile(path.join(shots, `chat-preview-${theme}.png`), Buffer.from(data, "base64"));
      }
    }
    // The button is reachable by keyboard and asks the chat app to open the kino link.
    await browser.evaluate(`document.getElementById("open").focus(); document.activeElement.id`);
    await browser.key("Enter");
    assert.equal(await browser.waitFor("window.__opened", { what: "openLink" }), "kino://open");
  } finally {
    await browser?.quit();
    await rm(folder, { recursive: true, force: true });
  }
});
