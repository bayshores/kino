import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createLatestFrameQueue,
  INITIAL_VIDEO_FRAME,
  isCurrentVideoCapture,
  videoFrameCanvasSize,
  videoFrameEncoding,
} from "./videoPreview.js";

function encodeFrame(canvas, source) {
  const { type, quality } = videoFrameEncoding(source);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// One worker for every preview encodes the frames (videoFrameWorker.js): reading a frame back
// from the graphics card waited for the card's other drawing, up to 150 ms a picture on the
// page's own thread while a large scene with an effect over a video played. Null where the
// browser has no workers, VideoFrame or OffscreenCanvas; the page then encodes as before.
let frameWorker;
const workerJobs = new Map();
let nextJob = 0;

function encoderWorker() {
  if (frameWorker !== undefined) return frameWorker;
  frameWorker = null;
  if (typeof Worker !== "function" || typeof VideoFrame !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    frameWorker = new Worker(new URL("./videoFrameWorker.js", import.meta.url), { type: "module" });
    frameWorker.onmessage = ({ data }) => {
      const resolve = workerJobs.get(data.id);
      workerJobs.delete(data.id);
      resolve?.(data.blob ?? null);
    };
    frameWorker.onerror = () => {
      // A worker that cannot start: the jobs it had end empty, and the page encodes from now on.
      for (const resolve of workerJobs.values()) resolve(null);
      workerJobs.clear();
      frameWorker = null;
    };
  } catch { frameWorker = null; }
  return frameWorker;
}

/** The video's current picture as a file made in the worker, or undefined when there is no worker. */
function encodeInWorker(video, size, source) {
  const worker = encoderWorker();
  if (!worker) return undefined;
  let frame;
  try { frame = new VideoFrame(video); }
  catch { return undefined; }
  const id = nextJob++;
  const { type, quality } = videoFrameEncoding(source);
  return new Promise((resolve) => {
    workerJobs.set(id, resolve);
    try { worker.postMessage({ id, frame, width: size.width, height: size.height, type, quality }, [frame]); }
    catch { workerJobs.delete(id); frame.close(); resolve(undefined); }
  });
}

function revokeSessionUrls(session) {
  for (const url of session.urls) URL.revokeObjectURL(url);
  session.urls.clear();
  session.currentUrl = null;
}

function cancelVideoFrameCallback(video, session) {
  if (session.frameCallback == null) return;
  video.cancelVideoFrameCallback?.(session.frameCallback);
  session.frameCallback = null;
}

// Runs `step` once the browser has painted the next frame.
function afterPaint(step) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(step, 0));
  else setTimeout(step, 0);
}

function resolvePaintWaiter(waiting) {
  if (!waiting) return;
  if (waiting.frameHandle != null) globalThis.cancelAnimationFrame?.(waiting.frameHandle);
  if (waiting.paintTimer != null) clearTimeout(waiting.paintTimer);
  if (waiting.fallbackTimer != null) clearTimeout(waiting.fallbackTimer);
  waiting.resolve?.();
  waiting.resolve = null;
}

/**
 * Capture only selected videos as bounded pictures; their original element remains the decoder.
 * While `playing`, a new picture waits for the preview's next frame (the scene clock draws one
 * every frame anyway) instead of asking for a drawing of its own: before, every captured picture
 * drew the whole scene once more, so a playing scene with such a video was drawn about twice as
 * often as the clock asked.
 */
// `displaySide` gives the longer side of the stage on screen (device pixels): a playing video is
// copied no bigger than that, which made each copy up to a third smaller to encode and decode.
// `capture(id)` says whether a video's frames are wanted now (ScenePreview: inside or just before
// a capture window); without it every frame is.
export function useVideoFrames(layers, { active = true, playing = false, displaySide, capture: wanted } = {}) {
  const displaySideRef = useRef(displaySide);
  displaySideRef.current = displaySide;
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const suppliedDescriptors = useMemo(() => (Array.isArray(layers) ? layers : [])
    .filter((layer) => layer?.type === "video" && typeof layer.id === "string" && typeof layer.src === "string")
    .map((layer) => ({ id: layer.id, source: layer.src, mediaSource: layer.mediaSrc ?? layer.src }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), [layers]);
  const signature = JSON.stringify([Boolean(active), suppliedDescriptors.map(({ id, source, mediaSource }) => [id, source, mediaSource])]);
  const descriptorState = useRef({ signature, descriptors: suppliedDescriptors });
  if (descriptorState.current.signature !== signature)
    descriptorState.current = { signature, descriptors: suppliedDescriptors };
  const descriptors = descriptorState.current.descriptors;
  const epochState = useRef({ signature, epoch: 0 });
  if (epochState.current.signature !== signature) {
    epochState.current = { signature, epoch: epochState.current.epoch + 1 };
  }
  const epoch = epochState.current.epoch;
  const activeEpoch = useRef(epoch);
  activeEpoch.current = epoch;

  const [frames, setFrames] = useState(() => new Map());
  // Pictures captured while playing that are not stored in `frames` yet (id -> frame).
  const waiting = useRef(new Map());
  const playingNow = useRef(playing);
  playingNow.current = playing;
  const elements = useRef(new Map());
  const refs = useRef(new Map());
  const sessions = useRef(new Map());

  const refFor = useCallback((id) => {
    let callback = refs.current.get(id);
    if (!callback) {
      callback = (element) => {
        if (element) elements.current.set(id, element);
        else {
          elements.current.delete(id);
          refs.current.delete(id);
        }
      };
      refs.current.set(id, callback);
    }
    return callback;
  }, []);

  const acknowledgePaint = useCallback((paintedFrames, hasSvg = true) => {
    for (const session of sessions.current.values()) {
      // Pictures captured while playing are not waited for: once a newer one is on screen, the
      // older ones (shown before, or never shown) are let go after the browser has painted.
      const shown = hasSvg ? paintedFrames?.get(session.id) : null;
      if (shown && session.urls.has(shown) && session.shownUrl !== shown) {
        session.shownUrl = shown;
        const older = [];
        for (const url of session.urls) { if (url === shown) break; older.push(url); }
        if (older.length) afterPaint(() => {
          for (const url of older) { URL.revokeObjectURL(url); session.urls.delete(url); }
        });
      }
      const waiting = session.waitingPaint;
      if (!waiting) continue;
      if (waiting.acknowledged) continue;
      if (hasSvg && paintedFrames?.get(session.id) !== waiting.url) continue;
      waiting.acknowledged = true;
      const finish = () => {
        if (session.waitingPaint !== waiting) return;
        session.waitingPaint = null;
        resolvePaintWaiter(waiting);
      };
      waiting.fallbackTimer = setTimeout(finish, 250);
      if (typeof requestAnimationFrame === "function") {
        waiting.frameHandle = requestAnimationFrame(() => {
          waiting.frameHandle = null;
          waiting.paintTimer = setTimeout(finish, 0);
        });
      } else waiting.paintTimer = setTimeout(finish, 0);
    }
  }, []);

  const storedFrames = useMemo(() => {
    const result = new Map();
    if (active) for (const descriptor of descriptors) {
      const current = frames.get(descriptor.id);
      result.set(descriptor.id,
        current?.epoch === epoch && current.source === descriptor.source &&
          current.mediaSource === descriptor.mediaSource ? current.url : INITIAL_VIDEO_FRAME);
    }
    return result;
  }, [active, descriptors, epoch, frames]);
  // While playing, each drawing reads the newest pictures (this render reads the ref on purpose:
  // the scene clock renders every frame, and that render picks them up).
  let videoFrames = storedFrames;
  if (playing && active && waiting.current.size) {
    videoFrames = new Map(storedFrames);
    for (const descriptor of descriptors) {
      const frame = waiting.current.get(descriptor.id);
      if (frame?.epoch === epoch && frame.source === descriptor.source && frame.mediaSource === descriptor.mediaSource)
        videoFrames.set(descriptor.id, frame.url);
    }
  }
  // After a pause, the pictures captured while playing become the stored ones.
  useEffect(() => {
    if (playing || !waiting.current.size) return;
    const captured = waiting.current;
    waiting.current = new Map();
    setFrames((current) => {
      const next = new Map(current);
      for (const [id, frame] of captured) next.set(id, frame);
      return next;
    });
  }, [playing]);

  useEffect(() => {
    const allowed = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
    setFrames((current) => {
      let changed = false;
      const next = new Map();
      for (const [id, frame] of current) {
        const descriptor = allowed.get(id);
        if (active && descriptor && frame.epoch === epoch && frame.source === descriptor.source &&
            frame.mediaSource === descriptor.mediaSource) next.set(id, frame);
        else changed = true;
      }
      return changed ? next : current;
    });
    if (!active) return undefined;
    const created = [];

    const disposeSession = (session) => {
      if (!session.active) return;
      session.active = false;
      session.generation += 1;
      session.queue.dispose();
      cancelVideoFrameCallback(session.video, session);
      for (const [event, listener] of session.listeners) session.video.removeEventListener(event, listener);
      session.listeners.length = 0;
      resolvePaintWaiter(session.waitingPaint);
      session.waitingPaint = null;
      revokeSessionUrls(session);
      if (session.canvas) {
        session.canvas.width = 1;
        session.canvas.height = 1;
        session.canvas = null;
        session.context = null;
      }
    };

    const capture = async (session, request) => {
      const video = session.video;
      if (!session.active || session.epoch !== activeEpoch.current || request.generation !== session.generation ||
          request.mediaSource !== session.mediaSource || video.getAttribute("src") !== session.mediaSource ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.seeking) return;
      const size = videoFrameCanvasSize(video.videoWidth, video.videoHeight, video.paused ? undefined : displaySideRef.current?.());
      if (!size) return;
      const captureTime = video.currentTime;
      const wasPlaying = !video.paused;
      let blob = await encodeInWorker(video, size, session.mediaSource);
      if (blob === undefined) {
        // No worker: the page draws and encodes the frame itself.
        if (!session.canvas) {
          session.canvas = document.createElement("canvas");
          // A canvas kept in memory (willReadFrequently), not on the graphics card: encoding a
          // picture of a canvas on the card first copies it back, and that copy waited for the
          // card's other drawing, holding the page up to about 90 ms a picture.
          session.context = session.canvas.getContext("2d", { alpha: true, willReadFrequently: true });
          if (!session.context) return;
        }
        const canvas = session.canvas;
        canvas.width = size.width;
        canvas.height = size.height;
        try {
          session.context.drawImage(video, 0, 0, size.width, size.height);
        } catch {
          return;
        }
        blob = await encodeFrame(canvas, session.mediaSource);
      }
      if (!blob || !session.active || session.epoch !== activeEpoch.current || !isCurrentVideoCapture({
        generation: request.generation,
        currentGeneration: session.generation,
        source: request.mediaSource,
        currentSource: video.getAttribute("src"),
        captureTime,
        currentTime: video.currentTime,
        wasPlaying,
        isPlaying: !video.paused,
        seeking: video.seeking,
      })) return;

      let url;
      try { url = URL.createObjectURL(blob); }
      catch { return; }
      const previousUrl = session.currentUrl;
      session.currentUrl = url;
      session.urls.add(url);
      const frame = { epoch: session.epoch, source: session.source, mediaSource: session.mediaSource, url };
      // While playing, the next frame is captured at once: this picture shows with the next
      // drawing, and acknowledgePaint lets the older ones go.
      if (playingNow.current) { waiting.current.set(session.id, frame); return; }
      const painted = new Promise((resolve) => { session.waitingPaint = { url, resolve }; });
      setFrames((current) => {
        if (!session.active) return current;
        const next = new Map(current);
        next.set(session.id, frame);
        return next;
      });
      await painted;
      if (!session.active) return;
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
        session.urls.delete(previousUrl);
      }
    };

    for (const descriptor of descriptors) {
      const video = elements.current.get(descriptor.id);
      if (!video) continue;
      const session = {
        ...descriptor,
        epoch,
        video,
        active: true,
        generation: 0,
        frameCallback: null,
        canvas: null,
        context: null,
        currentUrl: null,
        urls: new Set(),
        waitingPaint: null,
        listeners: [],
        queue: null,
      };
      session.queue = createLatestFrameQueue((request) => capture(session, request));
      session.enqueueFrame = () => enqueueFrame();
      sessions.current.set(session.id, session);
      created.push(session);

      const enqueueFrame = () => {
        if (!session.active || video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        if (wantedRef.current && !wantedRef.current(session.id)) return;
        session.queue.enqueue({ generation: session.generation, mediaSource: session.mediaSource });
      };
      const listen = (event, listener) => {
        video.addEventListener(event, listener);
        session.listeners.push([event, listener]);
      };
      const scheduleFrameCallback = () => {
        if (!session.active || video.paused || session.frameCallback != null ||
            typeof video.requestVideoFrameCallback !== "function") return;
        session.frameCallback = video.requestVideoFrameCallback(() => {
          session.frameCallback = null;
          enqueueFrame();
          scheduleFrameCallback();
        });
      };
      listen("loadeddata", enqueueFrame);
      listen("seeked", enqueueFrame);
      listen("seeking", () => {
        session.generation += 1;
        session.queue.clear();
      });
      listen("play", () => {
        session.generation += 1;
        enqueueFrame();
        scheduleFrameCallback();
      });
      listen("pause", () => {
        session.generation += 1;
        cancelVideoFrameCallback(video, session);
        enqueueFrame();
      });
      listen("timeupdate", enqueueFrame);
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) enqueueFrame();
      scheduleFrameCallback();
    }

    return () => {
      for (const session of created) {
        disposeSession(session);
        if (sessions.current.get(session.id) === session) sessions.current.delete(session.id);
      }
    };
  }, [active, descriptors, epoch, signature]);

  // Captures the current frame of each video now (one that just became wanted while paused).
  const refresh = useCallback(() => { for (const session of sessions.current.values()) session.enqueueFrame?.(); }, []);
  const elementFor = useCallback((id) => elements.current.get(id) ?? null, []);
  return { videoFrames, refFor, acknowledgePaint, refresh, elementFor };
}
