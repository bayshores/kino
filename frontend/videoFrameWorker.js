// A worker that turns a video frame into a picture file (JPEG or PNG) for the live preview
// (useVideoFrames.js). Reading a frame back from the graphics card and encoding it takes 5 to 150
// ms while a large scene plays; done here, the page's own thread does not wait for it.
//
// Message in: { id, frame (a VideoFrame, transferred), width, height, type, quality }.
// Message out: { id, blob } or { id, error }.

let canvas = null;
let context = null;

self.onmessage = async ({ data }) => {
  const { id, frame, width, height, type, quality } = data;
  try {
    if (!canvas) {
      canvas = new OffscreenCanvas(width, height);
      context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    }
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(frame, 0, 0, width, height);
    frame.close();
    const blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
    self.postMessage({ id, blob });
  } catch (error) {
    try { frame?.close(); } catch { /* already closed */ }
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
