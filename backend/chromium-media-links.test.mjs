// The Chromium export worker paints each frame from an IPC message and loads the export's picture
// files by kino-frame://media/ link (desktop/raster-page.cjs, desktop/raster-worker.cjs). Before,
// the SVG went into the page as JavaScript source, which Chromium kept, and every picture rode
// inside the SVG as a base64 data: URL, which Chromium also kept: a final 1080x1920 render of a
// project full of video grew the renderer by about 70 MB a frame until the Mac ran out of memory.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { createChromiumRasterizer } from "./chromium-raster.mjs";
import { chromiumFrameMaps, exportScene, linkEmbeddedPictures, linkedFilesKey, renderSceneFrames } from "./export.mjs";
import { escapeXml, renderSceneSvg } from "../engine/render.js";
import { effectDefaults } from "../engine/effects/catalog.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { makeVideo, skipWithoutMediaTools } from "./media.test.support.mjs";

// An opaque picture of seeded noise: PNG compression cannot shrink it, so it is about width x
// height x 3 bytes, and no two seeds give the same picture.
function noise(width, height, seed, type = "image/png") {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  let state = seed * 2654435761 % 4294967296 || 1;
  for (let index = 0; index < image.data.length; index += 4) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    image.data[index] = state & 255;
    image.data[index + 1] = (state >>> 8) & 255;
    image.data[index + 2] = (state >>> 16) & 255;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas.toBuffer(type);
}

const svg = (width, height, content) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${content}</svg>`;
const picture = (href, width, height, extra = "") =>
  `<image href="${href}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none"${extra}/>`;

async function worker(t, prefix = "kino-media-links-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const media = join(directory, "media");
  await mkdir(media);
  let raster;
  t.after(async () => { await raster?.close(); await rm(directory, { recursive: true, force: true }); });
  raster = await createChromiumRasterizer({ directory: join(directory, "chromium"), mediaDirectory: media });
  return { raster, directory, media };
}

test("a picture loaded by link paints exactly the pixels of the same picture in a data URL", async (t) => {
  const { raster, media } = await worker(t);
  for (const [type, extension] of [["image/png", "png"], ["image/jpeg", "jpg"]]) {
    const bytes = noise(160, 90, 7, type);
    const file = join(media, `picture.${extension}`);
    await writeFile(file, bytes);
    const link = raster.mediaUrl(file);
    assert.match(link, /^kino-frame:\/\/media\//);
    // Scaled up, scaled down, drawn twice and half transparent: the same work the export asks for.
    const scene = href => svg(320, 180, `<rect width="320" height="180" fill="#123456"/>${picture(href, 320, 180)}` +
      `${picture(href, 100, 60, ' opacity="0.5"')}`);
    const fromData = await raster.renderPixels(scene(`data:${type};base64,${bytes.toString("base64")}`), 320, 180);
    const fromLink = await raster.renderPixels(scene(link), 320, 180);
    assert.ok(fromLink.pixels.equals(fromData.pixels), `${extension}: the linked picture paints the same pixels`);
  }
});

// Large pictures drawn small, and <use> copies of them (as the copies and motion-blur effects draw
// them), come back in turn at other sizes. Two things made such paints depend on the paints before:
// - on a test edit's frames, 1 to 7 of 292 linked frames came out a little different when the page neither
//   kept its pictures nor waited for the <image> load events (desktop/raster-page.cjs);
// - Chromium draws a picture that comes back at another size from the copy it decoded for the
//   first size, a little differently than a fresh one. Each paint now asks for its pictures by
//   links of its own (raster-page.cjs paintLinks); with one link for all paints, scene 0 painted
//   again after scene 2 (the fifth paint below) came out different from its first paint.
// So each scene must paint the same pixels every time, after any other scene and after itself, and
// the pixels a new worker paints first from data URLs.
test("linked pictures and their <use> copies paint the same pixels whatever was painted before", async (t) => {
  const { raster, media } = await worker(t);
  const files = [];
  for (let index = 0; index < 3; index += 1) {
    const file = join(media, `large-${index}.png`);
    await writeFile(file, noise(960, 540, 40 + index));
    files.push(file);
  }
  const scene = hrefs => svg(320, 180, `<rect width="320" height="180" fill="#202830"/>` +
    `<defs><g id="layer">${picture(hrefs[0], 200, 112)}<g transform="translate(120 60)">${picture(hrefs[1], 160, 90, ' opacity="0.4"')}</g></g></defs>` +
    `<use href="#layer"/><use href="#layer" x="12" y="8" opacity="0.5"/>` +
    `<g style="mix-blend-mode:plus-lighter">${picture(hrefs[2], 320, 180, ' opacity="0.3"')}</g>`);
  const order = [[0, 1, 2], [2, 0, 1], [1, 2, 0]];
  const linked = order.map(indexes => scene(indexes.map(index => raster.mediaUrl(files[index]))));
  const first = [];
  for (const [paint, index] of [0, 1, 2, 2, 0, 1, 1, 2, 0, 0, 2, 1].entries()) {
    const pixels = (await raster.renderPixels(linked[index], 320, 180)).pixels;
    if (first[index]) assert.ok(pixels.equals(first[index]), `paint ${paint + 1} (scene ${index}) shows the scene's first pixels`);
    else first[index] = pixels;
  }
  const { raster: fresh } = await worker(t);
  const fromData = scene(order[1].map(index => `data:image/png;base64,${readFileSync(files[index]).toString("base64")}`));
  assert.ok((await fresh.renderPixels(fromData, 320, 180)).pixels.equals(first[1]), "scene 1 shows what a new worker paints from data URLs");
});

// A busy computer may answer a linked picture late. This worker answers every picture 200 ms late
// (KINO_RASTER_TEST_PICTURE_DELAY_MS), and the page must still show it in its <image> and in the
// <use> copies (desktop/raster-page.cjs paintSvg loads a frame's pictures first and waits for each
// linked <image> to load). Checked: with both the preload and that wait taken out, this test fails;
// with the wait alone, it passes. It does not see the page keeping the pictures (shownPictures):
// here each paint asks for its picture once, as the <image> and its <use> copies find it in
// Chromium's memory cache while the preloaded Image holds it, so nothing makes Chromium ask again.
test("pictures that arrive late still show in their <image> and its <use> copies", async (t) => {
  const before = process.env.KINO_RASTER_TEST_PICTURE_DELAY_MS;
  process.env.KINO_RASTER_TEST_PICTURE_DELAY_MS = "200";
  let slow;
  try { slow = await worker(t); }
  finally {
    if (before === undefined) delete process.env.KINO_RASTER_TEST_PICTURE_DELAY_MS;
    else process.env.KINO_RASTER_TEST_PICTURE_DELAY_MS = before;
  }
  const { raster, media } = slow;
  const bytes = noise(480, 270, 61);
  const file = join(media, "late.png");
  await writeFile(file, bytes);
  const scene = href => svg(320, 180, `<rect width="320" height="180" fill="#283038"/>` +
    `<defs>${picture(href, 160, 90).replace("<image ", '<image id="late" ')}</defs>` +
    `<use href="#late"/><use href="#late" x="140" y="70" opacity="0.6"/>` +
    `<g transform="translate(40 100)">${picture(href, 120, 68)}</g>`);
  const fromData = (await raster.renderPixels(scene(`data:image/png;base64,${bytes.toString("base64")}`), 320, 180)).pixels;
  const background = Buffer.from([0x28, 0x30, 0x38, 255]);
  assert.ok(!fromData.subarray(0, 4).equals(background), "the picture covers the top left corner");
  for (let paint = 1; paint <= 3; paint += 1) {
    const started = Date.now();
    const fromLink = (await raster.renderPixels(scene(raster.mediaUrl(file)), 320, 180)).pixels;
    assert.ok(Date.now() - started >= 200, "the picture came late");
    assert.ok(fromLink.equals(fromData), `paint ${paint}: the late linked picture paints the data URL's pixels`);
  }
});

// The export's temporary folder can have any name: "&" and "'" in it reach the SVG escaped.
test("an effect picture linked from a folder whose name has & and ' paints the same pixels", async (t) => {
  const { raster, media } = await worker(t, "kino-a&b'c-");
  assert.match(media, /&b'c/);
  const tile = dataUrl(noise(80, 80, 71));
  const scene = svg(128, 96, `<rect width="128" height="96" fill="#3a7"/>${picture(tile, 96, 72, ' opacity="0.8"')}`);
  const linked = linkEmbeddedPictures(scene, raster, media);
  assert.match(linked, /href="kino-frame:\/\/media[^"]*&amp;b&apos;c-[^"]*\.png"/, "the link is written escaped");
  const fromData = await raster.renderPixels(scene, 128, 96);
  const fromLink = await raster.renderPixels(linked, 128, 96);
  assert.ok(fromLink.pixels.equals(fromData.pixels), "the linked tile paints the same pixels");
  // The frame cache key reads the escaped link back to the file.
  const file = /href="kino-frame:\/\/media([^"]+)"/.exec(linked)[1].replaceAll("&amp;", "&").replaceAll("&apos;", "'");
  const info = statSync(file, { bigint: true });
  assert.equal(linkedFilesKey(linked), `${info.size}:${info.mtimeNs}:${info.ino}`);
  assert.equal(linkedFilesKey(`<image href="${escapeXml(`kino-frame://media${media}/none.png`)}"/>`), "missing");
});

test("an export whose temporary folder has & in its name draws its effect pictures", async (t) => {
  const folders = await mkdtemp(join(tmpdir(), "kino-temporary-"));
  t.after(() => rm(folders, { recursive: true, force: true }));
  // A noise mask with one-pixel cells draws a noise picture of over 16 KB, which is linked.
  const rect = createLayer("rectangle", { id: "r", name: "R", x: 0, y: 0, width: 400, height: 300, fill: "#ff8040", strokeWidth: 0 });
  rect.animations = [{ id: "n", name: "noise", kind: "effect", effect: "noise-mask", start: 0, duration: 1, easing: "linear",
    to: { ...effectDefaults("noise-mask"), cellSize: 1, threshold: 0.4 } }];
  const scene = parseDocument(createDocument({ scenes: [createScene({ id: "s", width: 400, height: 300, duration: 1, background: "#102030", layers: [rect] })] })).scenes[0];
  const before = process.env.TMPDIR;
  const results = [];
  try {
    for (const name of ["plain", "a&b'c"]) {
      process.env.TMPDIR = join(folders, name);
      await mkdir(process.env.TMPDIR);
      assert.equal(tmpdir(), join(folders, name));
      results.push((await exportScene(scene, { format: "png", time: 0.5 }, {})).buffer);
      assert.deepEqual(readdirSync(join(folders, name)), [], "the export removed its folder");
    }
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
  assert.ok(results[1].equals(results[0]), "the same picture in both folders");
});

test("the page loads pictures only from the export's media folder", async (t) => {
  const { raster, directory, media } = await worker(t);
  const outside = join(directory, "outside.png");
  await writeFile(outside, noise(8, 8, 1));
  await writeFile(join(media, "notes.txt"), "not a picture");
  await symlink(outside, join(media, "escape.png"));
  // Files outside the folder, and files that are not pictures, get no link.
  assert.equal(raster.mediaUrl(outside), null);
  assert.equal(raster.mediaUrl(join(media, "notes.txt")), null);
  assert.equal(raster.mediaUrl("relative/picture.png"), null);
  // A link written by hand to such a file, or to a link inside the folder that leads out of it, is
  // refused by the worker: the frame fails instead of showing that file.
  for (const link of [`kino-frame://media${outside}`, raster.mediaUrl(join(media, "escape.png")), `kino-frame://media${join(media, "missing.png")}`]) {
    await assert.rejects(raster.renderPixels(svg(8, 8, picture(link, 8, 8)), 8, 8), /could not be loaded/);
  }
  // Other schemes stay refused as before.
  await assert.rejects(raster.renderPixels(svg(8, 8, picture(`file://${outside}`, 8, 8)), 8, 8), /embedded raster data/);
});

// The renderer's private memory after each paint, in MB, as the worker reports it.
const rendererMB = raster => raster.memory().rendererKB / 1024;

test("the renderer does not keep the SVG text of the frames it has drawn", async (t) => {
  const { raster } = await worker(t);
  const sizes = [];
  // 60 different SVGs of 2 MB each (120 MB of SVG in all). The old worker kept each one as script
  // source: its renderer grew 4.15 MB a frame and never came down (74 MB to 655 MB over 150
  // frames). Sent as messages, the text waits only for Chromium's next garbage collection, which
  // the page now runs after every 32 MB of SVG.
  for (let index = 0; index < 60; index += 1) {
    const text = String(index).padStart(4, "0").repeat(512 * 1024);
    await raster.renderPixels(svg(64, 64, `<desc>${text}</desc><rect width="64" height="64" fill="rgb(${index},40,80)"/>`), 64, 64);
    sizes.push(rendererMB(raster));
  }
  const growth = Math.max(...sizes.slice(10)) - sizes[9];
  assert.ok(growth < 60, `the renderer grew ${growth.toFixed(1)} MB over 50 frames of 2 MB SVG (${sizes.map(Math.round).join(", ")})`);
  assert.equal(raster.memory().frames, 60);
});

test("the renderer stays level while each frame shows a different large picture by link", async (t) => {
  const { raster, media } = await worker(t);
  const sizes = [];
  // 60 different 900x600 pictures of about 1.6 MB each, as a video export shows them.
  for (let index = 0; index < 60; index += 1) {
    const file = join(media, `frame-${index}.png`);
    await writeFile(file, noise(900, 600, index + 1));
    await raster.renderPixels(svg(900, 600, picture(raster.mediaUrl(file), 900, 600)), 900, 600);
    sizes.push(rendererMB(raster));
  }
  const growth = Math.max(...sizes.slice(10)) - sizes[9];
  t.diagnostic(`grew at most ${growth.toFixed(1)} MB, ended ${(sizes.at(-1) - sizes[9]).toFixed(1)} MB above frame 10`);
  // Chromium drops pictures it no longer shows now and then, so memory goes up and down a little.
  // On a Mac: by link, at most 4.5 to 5.1 MB above frame 10 (and 4.5 to 5.1 MB at the end) in 4
  // runs; the same pictures sent as data URLs gave 130.6 to 134.8 MB (both) in 3 runs.
  assert.ok(growth < 20, `the renderer grew ${growth.toFixed(1)} MB over 50 frames (${sizes.map(Math.round).join(", ")})`);
  assert.ok(sizes.at(-1) - sizes[9] < 20, `the renderer ended ${(sizes.at(-1) - sizes[9]).toFixed(1)} MB above frame 10`);
});

test("Chromium frame SVGs carry video, GIF and still pictures as links", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-frame-maps-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const videoFile = join(directory, "video-window-0", "frame-1.png");
  const gifFile = join(directory, "gif-0", "frame-0.png");
  await mkdir(join(directory, "video-window-0"));
  await mkdir(join(directory, "gif-0"));
  await writeFile(videoFile, noise(4, 4, 2));
  await writeFile(gifFile, noise(4, 4, 3));
  const still = noise(4, 4, 4);
  const rasterizer = { mediaUrl: file => `kino-frame://media${file}` };
  const media = {
    directory,
    images: new Map([["still", `data:image/png;base64,${still.toString("base64")}`]]),
    imageFrames: new Map([["gif", { durations: [1], frames: [{ mimeType: "image/png", file: gifFile, get buffer() { return readFileSync(gifFile); } }] }]]),
    videos: new Map([["video", { frameFor: () => videoFile }]]),
  };
  const scene = parseDocument(createDocument({ scenes: [createScene({ id: "s", width: 30, height: 10, duration: 1, layers: [
    createLayer("image", { id: "still", x: 0, y: 0, width: 10, height: 10, src: "/api/media/still.png" }),
    createLayer("image", { id: "gif", x: 10, y: 0, width: 10, height: 10, src: "/api/media/anim.gif" }),
    createLayer("video", { id: "video", x: 20, y: 0, width: 10, height: 10, src: "/api/media/clip.mp4", mediaDuration: 1 }),
  ] })] })).scenes[0];
  const markup = renderSceneSvg(scene, 0, { raster: false, embedMedia: media.images, ...chromiumFrameMaps(media, rasterizer) });
  assert.ok(markup.includes(`href="kino-frame://media${videoFile}"`), "the video picture is a link");
  assert.ok(markup.includes(`href="kino-frame://media${gifFile}"`), "the GIF frame is a link");
  const stillLink = /href="(kino-frame:\/\/media[^"]*chromium-stills[^"]*\.png)"/.exec(markup)?.[1];
  assert.ok(stillLink, "the still image is a link to a file in the export's folder");
  assert.ok(readFileSync(stillLink.slice("kino-frame://media".length)).equals(still), "with the still's own bytes");
  assert.ok(!markup.includes("data:image"), "no picture travels inside the SVG");
  // The same still gets the same file on every frame.
  const again = renderSceneSvg(scene, 0.5, { raster: false, embedMedia: media.images, ...chromiumFrameMaps(media, rasterizer) });
  assert.ok(again.includes(stillLink));
  // Without Chromium (resvg draws the frame) the pictures stay embedded bytes.
  const plain = renderSceneSvg(scene, 0, { raster: false, embedMedia: media.images, ...chromiumFrameMaps(media, undefined) });
  assert.ok(!plain.includes("kino-frame://"));
  assert.equal(plain.split("data:image/png;base64,").length - 1, 3);
});

// An effect's own picture (a noise tile, a displacement map) as engine/effects writes it: a PNG data URL.
const dataUrl = bytes => `data:image/png;base64,${bytes.toString("base64")}`;

test("an effect's embedded picture is linked once per picture and paints the same pixels", async (t) => {
  const { raster, media } = await worker(t);
  const tile = dataUrl(noise(80, 80, 11)); // about 26 KB of base64
  const small = dataUrl(noise(4, 4, 12));
  // The picture three ways an effect uses it: an <image> in a pattern, an feImage, and an <image>.
  // The two <image> elements get the link; the feImage keeps its data URL, because an feImage fires
  // no load event for the page to wait for (desktop/raster-page.cjs).
  const scene = svg(128, 96, `<defs><pattern id="p" patternUnits="userSpaceOnUse" width="32" height="32">` +
    `<image href="${tile}" width="32" height="32" preserveAspectRatio="none"/></pattern>` +
    `<filter id="f" x="0" y="0" width="1" height="1"><feImage href="${tile}" x="0" y="0" width="64" height="48" preserveAspectRatio="none" result="map"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="12" xChannelSelector="R" yChannelSelector="G"/></filter></defs>` +
    `<rect width="128" height="48" fill="url(#p)"/><rect y="48" width="128" height="48" fill="#3a7" filter="url(#f)"/>` +
    picture(small, 8, 8) + `<g transform="translate(80 60)">${picture(tile, 40, 30, ' opacity="0.6"')}</g>`);
  const linked = linkEmbeddedPictures(scene, raster, media);
  const links = [...new Set(linked.match(/kino-frame:\/\/media[^"]+/g))];
  assert.equal(links.length, 1, "the two <image> uses of the tile share one file");
  assert.equal(linked.split(links[0]).length - 1, 2);
  assert.ok(linked.includes(`<feImage href="${tile}"`), "the feImage keeps the data URL");
  assert.ok(linked.includes(small), "a picture under 16 KB stays in the SVG");
  assert.ok(readFileSync(links[0].slice("kino-frame://media".length)).equals(noise(80, 80, 11)), "the file holds the picture's own bytes");
  assert.equal(linkEmbeddedPictures(scene, raster, media), linked, "the next frame gets the same link");
  const fromData = await raster.renderPixels(scene, 128, 96);
  const fromLink = await raster.renderPixels(linked, 128, 96);
  assert.ok(fromLink.pixels.equals(fromData.pixels), "the linked tile paints the same pixels");
  // resvg draws without a rasterizer: nothing changes.
  assert.equal(linkEmbeddedPictures(scene, undefined, media), scene);
});

test("linked effect pictures stay while recent frames use them and are removed after", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-effect-pictures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rasterizer = { mediaUrl: file => `kino-frame://media${file}` };
  const pictures = Array.from({ length: 6 }, (_, index) => dataUrl(noise(80, 80, 20 + index)));
  const frame = (...indexes) => svg(8, 8, indexes.map(index => picture(pictures[index], 8, 8)).join(""));
  const fileOf = markup => /kino-frame:\/\/media([^"]+)/.exec(markup)[1];
  const limits = { keepSvgs: 2, maxBytes: 1 };
  // Picture 0 is in every frame; pictures 1 to 4 are each in one frame.
  const files = [];
  for (let index = 1; index <= 4; index += 1) {
    const markup = linkEmbeddedPictures(frame(0, index), rasterizer, directory, limits);
    files.push(markup.match(/kino-frame:\/\/media[^"]+/g)[1].slice("kino-frame://media".length));
  }
  const folder = dirname(files[3]);
  assert.match(basename(folder), /^chromium-pictures-/);
  const kept = readdirSync(folder).sort();
  // Over the byte limit, only the pictures of the last two SVGs stay: picture 0, 3 and 4.
  assert.deepEqual(kept, ["picture-0.png", "picture-3.png", "picture-4.png"]);
  assert.ok(!existsSync(files[0]) && !existsSync(files[1]));
  // A removed picture that comes back gets a new file, never an old name.
  const again = linkEmbeddedPictures(frame(1), rasterizer, directory, limits);
  assert.match(again, /picture-5\.png/);
  assert.ok(readFileSync(fileOf(again)).equals(Buffer.from(pictures[1].split(",")[1], "base64")));
  // A second worker on the same export folder writes to a folder of its own: its picture-0 is
  // another file, and the first worker's files keep their bytes.
  const other = { mediaUrl: file => `kino-frame://media${file}` };
  const otherFile = fileOf(linkEmbeddedPictures(frame(5), other, directory, limits));
  assert.notEqual(dirname(otherFile), folder);
  assert.equal(basename(otherFile), "picture-0.png");
  assert.ok(readFileSync(join(folder, "picture-0.png")).equals(Buffer.from(pictures[0].split(",")[1], "base64")));
  assert.ok(readFileSync(otherFile).equals(Buffer.from(pictures[5].split(",")[1], "base64")));
});

test("the renderer stays level when every frame repeats a large effect picture", async (t) => {
  const { raster, media } = await worker(t);
  // One 900x600 noise picture, about 1.6 MB, in every frame as an effect's data URL. Sent as a data
  // URL every time, Chromium kept about its size per frame.
  const tile = dataUrl(noise(900, 600, 31));
  const sizes = [];
  for (let index = 0; index < 50; index += 1) {
    const frameSvg = svg(900, 600, `<rect width="900" height="600" fill="rgb(${index},0,0)"/>${picture(tile, 900, 600, ' opacity="0.9"')}`);
    await raster.renderPixels(linkEmbeddedPictures(frameSvg, raster, media), 900, 600);
    sizes.push(rendererMB(raster));
  }
  const growth = Math.max(...sizes.slice(10)) - sizes[9];
  t.diagnostic(`grew at most ${growth.toFixed(1)} MB`);
  // On a Mac: linked, at most 11.7 to 11.8 MB above frame 10 in 5 runs; sent as a data URL every
  // time, 16.9 to 17.3 MB in 3 runs. The page's own garbage collection, which counts both the SVG
  // text and the pictures' pixels (raster-page.cjs), keeps both from growing without end; a link
  // still saves the 2.2 MB of text a frame. Each paint decodes the linked picture again (its own
  // link, paintLinks), so this is higher than when all paints shared one decoded copy (3.1 MB).
  assert.ok(growth < 15, `the renderer grew ${growth.toFixed(1)} MB over 40 frames (${sizes.map(Math.round).join(", ")})`);
});

test("a document cannot point a layer at an export's picture file", () => {
  const link = "kino-frame://media/tmp/kino-export-x/video-0/000001.png";
  const scene = createScene({ id: "s", width: 10, height: 10, duration: 1, layers: [
    createLayer("image", { id: "picture", x: 0, y: 0, width: 10, height: 10, src: "/api/media/still.png" }),
  ] });
  // Only the export's own frame maps may hand out these links, never a layer's src or embedMedia.
  assert.throws(() => renderSceneSvg({ ...scene, layers: [{ ...scene.layers[0], src: link }] }, 0, { raster: false }), /must use \/api\/media/);
  assert.throws(() => renderSceneSvg(scene, 0, { raster: false, embedMedia: new Map([["picture", link]]) }), /must use \/api\/media/);
});

test("a Chromium export shows each video frame's own picture through its link", { skip: skipWithoutMediaTools }, async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-linked-video-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  // Ten frames at 10 fps, each a different colour.
  const frameColor = index => [index * 24 + 8, 200 - index * 16, (index * 77) % 256];
  await makeVideo(join(mediaRoot, "clip.mp4"), { width: 32, height: 32, fps: 10, frames: 10, frameColor });
  const scene = parseDocument(createDocument({ scenes: [createScene({ id: "s", width: 64, height: 32, duration: 1, background: "#000000", layers: [
    createLayer("video", { id: "clip", x: 0, y: 0, width: 32, height: 32, src: "/api/media/clip.mp4", mediaDuration: 1 }),
    // "add" blending makes the export use Chromium.
    createLayer("rectangle", { id: "dot", x: 40, y: 8, width: 16, height: 16, fill: "#202020", strokeWidth: 0, blendMode: "add" }),
  ] })] })).scenes[0];
  const times = Array.from({ length: 10 }, (_, index) => index / 10 + 0.05);
  const frames = await renderSceneFrames(scene, times, { mediaRoot, width: 64 });
  frames.forEach((frame, index) => {
    const at = (16 * 64 + 16) * 4;
    const shown = [...frame.pixels.subarray(at, at + 3)];
    assert.ok(shown.every((level, channel) => Math.abs(level - frameColor(index)[channel]) <= 3),
      `frame ${index} shows the clip's frame ${index}: ${shown} against ${frameColor(index)}`);
  });
});
