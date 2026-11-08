// The pictures, clip and color look the library screen's samples use (library-catalog.mjs), so a
// zoom, blur, slice or glitch has detail to act on. kino draws them itself, once, into the media
// folder under fixed names (no .json record, so they never show in a person's media library).
// They are served like any upload, at /api/media/<file>, to the export renderer and the app.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { LIBRARY_MEDIA } from "./library-catalog.mjs";
import { compactRecording } from "../../engine/recording.js";
import { runMediaTool } from "../media-probe.mjs";

const FONT = "800 {size}px Inter, Helvetica, Arial, sans-serif";
const font = (size, weight = 800) => FONT.replace("800", String(weight)).replace("{size}", String(size));

function gradient(ctx, x0, y0, x1, y1, stops) {
  const fill = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((color, index) => fill.addColorStop(index / (stops.length - 1), color));
  return fill;
}

// Shot A: a warm evening over hills, a striped sun, a road grid and a big word.
function drawShotA(ctx, w, h) {
  ctx.fillStyle = gradient(ctx, 0, 0, 0, h * 0.62, ["#2A1220", "#8E2F2A", "#E86A33", "#F6B65A"]);
  ctx.fillRect(0, 0, w, h);
  // The sun, cut by bands.
  const sx = w * 0.62, sy = h * 0.5, r = h * 0.3;
  ctx.save();
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = gradient(ctx, 0, sy - r, 0, sy + r, ["#FFE7A3", "#FF9A4A", "#E8473A"]);
  ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  ctx.fillStyle = "#8E2F2A";
  for (let i = 0; i < 6; i++) ctx.fillRect(sx - r, sy + r * (0.1 + i * 0.16), r * 2, 4 + i * 3);
  ctx.restore();
  // Hills in three layers.
  const hills = [["#5B1E2A", 0.58, 0.07], ["#3A1424", 0.66, 0.05], ["#1E0B16", 0.74, 0.04]];
  for (const [color, base, amp] of hills) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 48) ctx.lineTo(x, h * (base - amp * Math.sin(x / w * 7 + base * 20) - amp * 0.6 * Math.sin(x / w * 17)));
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  }
  // A road grid running to the horizon.
  ctx.strokeStyle = "rgba(255,170,90,0.55)"; ctx.lineWidth = Math.max(1, w / 640);
  const horizon = h * 0.8;
  for (let i = -12; i <= 12; i++) { ctx.beginPath(); ctx.moveTo(w / 2 + i * w * 0.012, horizon); ctx.lineTo(w / 2 + i * w * 0.12, h); ctx.stroke(); }
  for (let i = 0; i < 7; i++) { const y = horizon + (h - horizon) * (i / 6) ** 1.8; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  // Birds and the word.
  ctx.strokeStyle = "#2A1220"; ctx.lineWidth = Math.max(2, w / 480);
  for (const [bx, by, s] of [[0.2, 0.22, 1], [0.25, 0.18, 0.8], [0.3, 0.25, 0.6], [0.78, 0.15, 0.7]]) {
    const x = bx * w, y = by * h, k = s * w * 0.018;
    ctx.beginPath(); ctx.moveTo(x - k, y); ctx.quadraticCurveTo(x - k / 2, y - k * 0.6, x, y); ctx.quadraticCurveTo(x + k / 2, y - k * 0.6, x + k, y); ctx.stroke();
  }
  ctx.fillStyle = "#FFF1DC"; ctx.font = font(Math.round(h * 0.2)); ctx.textBaseline = "alphabetic";
  ctx.fillText("DUSK", w * 0.05, h * 0.95);
}

// Shot B: a cool night city, lit windows, a moon, a ring and a big word.
function drawShotB(ctx, w, h) {
  ctx.fillStyle = gradient(ctx, 0, 0, w * 0.4, h, ["#071A2E", "#0F3B5C", "#1F7E86", "#7FD1C2"]);
  ctx.fillRect(0, 0, w, h);
  // Stars.
  ctx.fillStyle = "rgba(230,248,255,0.8)";
  for (let i = 0; i < 90; i++) { const x = (i * 197.3) % w, y = ((i * 73.7) % (h * 0.45)); ctx.fillRect(x, y, w / 640, w / 640); }
  // The moon and a ring around it.
  ctx.fillStyle = "#EAF6F2"; ctx.beginPath(); ctx.arc(w * 0.2, h * 0.24, h * 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#0F3B5C"; ctx.beginPath(); ctx.arc(w * 0.225, h * 0.215, h * 0.09, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(127,209,194,0.7)"; ctx.lineWidth = w / 320;
  ctx.beginPath(); ctx.arc(w * 0.78, h * 0.3, h * 0.16, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(w * 0.78, h * 0.3, h * 0.1, 0, Math.PI * 2); ctx.stroke();
  // Buildings with windows.
  let x = 0, seed = 7;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  while (x < w) {
    const bw = w * (0.05 + rand() * 0.07), bh = h * (0.25 + rand() * 0.4);
    ctx.fillStyle = rand() > 0.5 ? "#0A2236" : "#061423";
    ctx.fillRect(x, h - bh, bw - w * 0.004, bh);
    for (let wy = h - bh + h * 0.03; wy < h - h * 0.03; wy += h * 0.045)
      for (let wx = x + bw * 0.15; wx < x + bw * 0.8; wx += bw * 0.22)
        if (rand() > 0.45) { ctx.fillStyle = rand() > 0.3 ? "#FFD27A" : "#7FD1C2"; ctx.fillRect(wx, wy, bw * 0.12, h * 0.02); }
    x += bw;
  }
  ctx.fillStyle = "#EAF6F2"; ctx.font = font(Math.round(h * 0.2)); ctx.textAlign = "right"; ctx.textBaseline = "alphabetic";
  ctx.fillText("CITY", w * 0.95, h * 0.2);
  ctx.textAlign = "left";
}

// An app screen (portrait): a header, a hero card and list rows, in one accent.
function drawScreen(accent, title) {
  return (ctx, w, h) => {
    ctx.fillStyle = "#101418"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#EDEEF0"; ctx.font = font(Math.round(w * 0.09)); ctx.fillText(title, w * 0.08, h * 0.1);
    ctx.fillStyle = accent; ctx.beginPath(); ctx.roundRect(w * 0.08, h * 0.14, w * 0.84, h * 0.28, w * 0.06); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.beginPath(); ctx.arc(w * 0.26, h * 0.28, w * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(w * 0.44, h * 0.24, w * 0.38, h * 0.025); ctx.fillRect(w * 0.44, h * 0.29, w * 0.26, h * 0.02);
    for (let i = 0; i < 5; i++) {
      const y = h * (0.47 + i * 0.1);
      ctx.fillStyle = "#1C2228"; ctx.beginPath(); ctx.roundRect(w * 0.08, y, w * 0.84, h * 0.08, w * 0.03); ctx.fill();
      ctx.fillStyle = i % 2 ? accent : "#3A4450"; ctx.beginPath(); ctx.arc(w * 0.17, y + h * 0.04, w * 0.05, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#8A949E"; ctx.fillRect(w * 0.27, y + h * 0.025, w * (0.3 + (i % 3) * 0.12), h * 0.014);
      ctx.fillStyle = "#4A545E"; ctx.fillRect(w * 0.27, y + h * 0.048, w * 0.25, h * 0.01);
    }
  };
}

// A simple mark on a clear ground: a ring with a cut and a dot.
function drawLogo(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#FF7D3D"; ctx.lineWidth = w * 0.13; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(w / 2, h / 2, w * 0.32, Math.PI * 0.2, Math.PI * 1.75); ctx.stroke();
  ctx.fillStyle = "#F4F2EE"; ctx.beginPath(); ctx.arc(w * 0.74, h * 0.3, w * 0.09, 0, Math.PI * 2); ctx.fill();
}

// One frame of the clip at t seconds: a street at dusk the camera pans along, a crosswalk, a ball rolling.
function drawClipFrame(ctx, w, h, t) {
  ctx.fillStyle = gradient(ctx, 0, 0, 0, h * 0.6, ["#163A52", "#3E7C8A", "#E9A35B"]);
  ctx.fillRect(0, 0, w, h);
  const pan = t * w * 0.08;
  let seed = 3;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let x = -w * 0.1; x < w * 1.6; ) {
    const bw = w * (0.08 + rand() * 0.1), bh = h * (0.2 + rand() * 0.3), color = ["#1B2E3C", "#24394A", "#2F4A5C"][Math.floor(rand() * 3)];
    const bx = x - pan;
    ctx.fillStyle = color; ctx.fillRect(bx, h * 0.6 - bh, bw - 4, bh);
    for (let wy = h * 0.6 - bh + 10; wy < h * 0.58; wy += 22) for (let wx = bx + 8; wx < bx + bw - 16; wx += 20)
      if (rand() > 0.5) { ctx.fillStyle = "#FFCF7A"; ctx.fillRect(wx, wy, 9, 11); }
    x += bw;
  }
  ctx.fillStyle = "#2B2F35"; ctx.fillRect(0, h * 0.6, w, h * 0.4);
  ctx.fillStyle = "#F2F0EA";
  for (let i = -2; i < 14; i++) ctx.fillRect(i * w * 0.09 - (pan * 1.6) % (w * 0.09), h * 0.72, w * 0.05, h * 0.16);
  ctx.fillStyle = "#FF6B3D";
  const bx = (t / 4) * w * 1.1 - w * 0.05;
  ctx.beginPath(); ctx.arc(bx, h * 0.66 - Math.abs(Math.sin(t * 4)) * h * 0.08, h * 0.05, 0, Math.PI * 2); ctx.fill();
}

// A strong warm-highlights, teal-shadows look as a 17-point .cube.
function cubeText() {
  const size = 17, lines = ["TITLE \"library look\"", `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const [R, G, B] = [r, g, b].map((v) => v / (size - 1));
    const l = 0.3 * R + 0.59 * G + 0.11 * B;
    const mix = (shadow, high) => Math.min(1, Math.max(0, shadow * (1 - l) + high * l));
    lines.push([mix(R * 0.4, R * 0.7 + 0.35), mix(G * 0.7 + 0.12, G * 0.75 + 0.15), mix(B * 0.7 + 0.22, B * 0.4)].map((v) => v.toFixed(4)).join(" "));
  }
  return `${lines.join("\n")}\n`;
}

const DRAW = { "shot-a": drawShotA, "shot-b": drawShotB, logo: drawLogo,
  "screen-a": drawScreen("#FF7D3D", "Today"), "screen-b": drawScreen("#3AA6A0", "Inbox"), "screen-c": drawScreen("#E8C46A", "Saved") };

async function writeAtomic(file, bytes) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

async function makeClip(item, file) {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-library-clip-"));
  try {
    const canvas = createCanvas(item.width, item.height);
    const ctx = canvas.getContext("2d");
    const frames = Math.round(item.duration * 30);
    for (let index = 0; index < frames; index++) {
      drawClipFrame(ctx, item.width, item.height, index / 30);
      await writeFile(path.join(folder, `f${String(index).padStart(3, "0")}.png`), canvas.toBuffer("image/png"));
    }
    const out = path.join(folder, "clip.mp4");
    await runMediaTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "30", "-i", path.join(folder, "f%03d.png"),
      "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
    await rename(out, file);
  } finally { await rm(folder, { recursive: true, force: true }); }
}

// The pointer and clicks kino's recorder would keep with a screen recording (the screen-recording
// move reads them): a made-up pointer that crosses the clip and clicks twice.
function clipRecording({ width, height, duration }) {
  const moves = Array.from({ length: 25 }, (_, index) => ({ type: "move", t: index * 0.15, x: width * (0.12 + index * 0.03), y: height * (0.7 - Math.sin(index / 4) * 0.3) }));
  const click = (t, x, y) => [{ type: "down", t, x, y, button: "left" }, { type: "up", t: t + 0.1, x, y, button: "left" }];
  return compactRecording({ frame: { width, height }, duration }, [...moves, ...click(1.2, width * 0.36, height * 0.44), ...click(3, width * 0.7, height * 0.76)]);
}

let pending = null;
/** Makes the library media files that are missing in `mediaRoot`; answers the media list the
 *  sample's moves look pictures up in (as uploads would be listed). */
export function libraryMedia(mediaRoot) {
  pending ??= (async () => {
    await mkdir(mediaRoot, { recursive: true });
    for (const item of LIBRARY_MEDIA) {
      const file = path.join(mediaRoot, item.id);
      if (existsSync(file)) continue;
      if (item.mime === "video/mp4") {
        await makeClip(item, file);
        await writeAtomic(path.join(mediaRoot, `${item.id}.recording.json`), JSON.stringify(clipRecording(item)));
      }
      else if (item.mime === "text/plain") await writeAtomic(file, cubeText());
      else {
        const canvas = createCanvas(item.width, item.height);
        DRAW[item.name](canvas.getContext("2d"), item.width, item.height);
        await writeAtomic(file, canvas.toBuffer("image/png"));
      }
    }
    return LIBRARY_MEDIA.map((item) => ({ ...item }));
  })().finally(() => { pending = null; });
  return pending;
}
