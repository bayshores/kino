// Draws the live preview's videos that live in a canvas: heavily blurred videos (render.js
// softVideoMarkup), and videos drawn from the preview's hidden decoder <video> while it does not
// capture them (render.js decoderVideoMarkup). Each new frame of the <video> goes into its canvas,
// fitted inside the layer and blurred there. The canvas is stretched over the layer, so the look
// matches the export's full-size blur at a small part of the cost.

const running = new WeakSet();
// A decoder <video> -> the canvas it is drawn into now (a new drawing can make a new canvas).
const decoderCanvas = new WeakMap();

function canvasFor(video) {
  const canvas = decoderCanvas.get(video);
  if (canvas?.isConnected) return canvas;
  return video.parentElement?.querySelector("canvas[data-soft-video]") ?? null;
}

function draw(canvas, video) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const [width, height, margin, blur] = canvas.dataset.softVideo.split(" ").map(Number);
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  // Fitted inside the layer as object-fit: contain fits the plain video.
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const drawWidth = video.videoWidth * scale, drawHeight = video.videoHeight * scale;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.filter = blur ? `blur(${blur}px)` : "none";
  context.imageSmoothingQuality = "high";
  context.drawImage(video, margin + (width - drawWidth) / 2, margin + (height - drawHeight) / 2, drawWidth, drawHeight);
}

/**
 * Draws every canvas video in `container` now and keeps each one drawn as its frames change.
 * `decoderFor(layerId)` gives the decoder <video> of a canvas with data-decoder.
 */
export function drawSoftVideos(container, decoderFor) {
  for (const canvas of container?.querySelectorAll("canvas[data-soft-video]") ?? []) {
    const id = canvas.dataset.decoder;
    const video = id === undefined ? canvas.parentElement?.querySelector("video") : decoderFor?.(id);
    if (!video) continue;
    if (id !== undefined) decoderCanvas.set(video, canvas);
    draw(canvas, video);
    if (running.has(video)) continue;
    running.add(video);
    const redraw = () => { const current = canvasFor(video); if (current) draw(current, video); };
    video.addEventListener("loadeddata", redraw);
    video.addEventListener("seeked", redraw);
    if (typeof video.requestVideoFrameCallback !== "function") continue;
    const step = () => {
      if (!video.isConnected) { running.delete(video); return; }
      redraw();
      video.requestVideoFrameCallback(step);
    };
    video.requestVideoFrameCallback(step);
  }
}
