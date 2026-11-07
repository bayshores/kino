import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderSceneSvg } from "../../engine/render.js";
import { lowpassSampler, volumeAt } from "../../engine/animation.js";
import { applyMediaLowpass } from "../mediaLowpass.js";
import { previewFontScene } from "../../engine/fontDocuments.js";
import { audioSyncState, isGifLayer, syncMediaElement, videoSyncState } from "../../engine/mediaPlay.js";
import { createRetryTimer, gifFrames, hasFrameTimeline } from "../gifFrames.js";
import { authorizedMediaUrl } from "../client.js";
import { expandComponents } from "../../engine/linkedComponents.js";
import { mediaPosterPath } from "../mediaPoster.js";
import { morphDissolveScene } from "../../engine/morphCut.js";
import { speechPieces } from "../../engine/speech.js";
import { useVideoFrames } from "../useVideoFrames.js";
import { CAPTURE_LEAD, capturingAt, INITIAL_VIDEO_FRAME, videoCaptureWindows } from "../videoPreview.js";
import { audibleRanges, heardAt, shownWithGroups } from "../../engine/videoSound.js";
import { useSceneLuts } from "../useSceneLuts.js";
import { patchSvgMarkup, releaseMedia } from "../svgPatch.js";
import { useFilterPrewarm } from "../filterPrewarm.js";
import { drawSoftVideos } from "../softVideo.js";
import { drawLiveTilts } from "../liveTilt.js";

// Where useFilterPrewarm draws each new filter once: over the stage, nearly see-through.
const PREWARM_STYLE = { position: "absolute", inset: 0, opacity: 0.004, pointerEvents: "none" };

const OFFSCREEN_VIDEO_STYLE = {
  position: "fixed", left: "-10000px", top: "0px", width: "1px", height: "1px",
  opacity: 0, overflow: "hidden", pointerEvents: "none",
};

function previewMediaElements(container, previewId) {
  const root = container?.parentElement;
  const decoders = [...(root?.querySelectorAll("video[data-video-frame-decoder]") ?? [])]
    .filter((media) => media.dataset.scenePreviewId === previewId);
  const inlineVideos = [...(container?.querySelectorAll("video") ?? [])];
  const audio = [...(root?.querySelectorAll("audio[data-scene-preview-id]") ?? [])]
    .filter((media) => media.dataset.scenePreviewId === previewId);
  return [...new Set([...decoders, ...inlineVideos, ...audio])];
}

// Video drift larger than this (seconds of the scene; mediaPlay.js allowedMediaDrift) while playing is corrected by seeking, a smaller one by playing a little faster or slower (mediaPlay.js syncMediaElement; the mediaDrift prop).
const MEDIA_DRIFT_SECONDS = 0.08;

// The GIF sources among `layers` that the editor shows frame by frame (sorted, without repeats),
// and a key that changes only when that list changes.
export function gifSourceList(layers) {
  const sources = [...new Set(layers.filter((layer) => isGifLayer(layer) && hasFrameTimeline(layer.src)).map((layer) => layer.src))].sort();
  return { sources, key: sources.join("\n") };
}

// GIF layers that use decoded frames (from the server, or decoded here for embedded GIFs),
// so the scene clock picks each frame.
export function useGifFrames(layers, mediaActive = true) {
  const { sources, key } = useMemo(() => gifSourceList(mediaActive ? layers : layers.filter((layer) => layer.src?.startsWith("data:"))), [layers, mediaActive]);
  const [version, setVersion] = useState(0);
  // Bumped when the earliest failed source may load again, so this effect runs again.
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    // One timer for every failed source, set to the earliest retry time among them.
    const retryTimer = createRetryTimer(() => setRetry((value) => value + 1));
    for (const src of sources) {
      if (gifFrames.get(src)) continue;
      gifFrames.load(src).then((timeline) => {
        if (!active) return;
        if (timeline) setVersion((value) => value + 1);
        else {
          // No retry time means the GIF is shown from its file for good (an embedded GIF over the editor budget).
          const at = gifFrames.retryAt(src);
          if (at !== undefined) retryTimer.schedule(at);
        }
      });
    }
    return () => {
      active = false;
      retryTimer.cancel();
    };
  }, [key, retry]);
  return useMemo(() => {
    const frames = new Map();
    for (const layer of layers) {
      const timeline = isGifLayer(layer) ? gifFrames.get(layer.src) : null;
      if (timeline) frames.set(layer.id, timeline);
    }
    return frames;
  }, [layers, version]);
}

/**
 * Draws a scene at `time` with the export's renderer (renderSceneSvg) and plays its media.
 * `audio` is "own" (the default: this preview plays the scene's sound with <audio> and <video>
 * elements, heard as an export mixes it) or "external" (no sound here: every element stays muted
 * because the caller plays the sound, as the dashboard plays GET /api/dashboard/mix). `mediaDrift`
 * is how far, in seconds, a playing video may drift from the scene clock before it is seeked.
 */
// `calmLight` draws short Light bursts calmly (reduced motion; see effects/light.js).
// `skipPrewarm(time)` is true at the moments another picture shows instead (useFilterPrewarm).
export function ScenePreview({ document, scene: originalScene, time, design, playing, fontVersion, fontPreview, mediaActive = true, audio = "own", mediaDrift = MEDIA_DRIFT_SECONDS, calmLight = false, skipPrewarm }) {
  const container = useRef(null);
  const displaySide = useCallback(() => {
    const box = container.current;
    return box?.clientWidth ? Math.ceil(Math.max(box.clientWidth, box.clientHeight) * (globalThis.devicePixelRatio || 1)) : undefined;
  }, []);
  const idPrefix = useId();
  const resolved = useMemo(() => {
    // A morph cut previews as a dissolve over its window (morphCut.js); the render draws the flow.
    try { return { scene: morphDissolveScene(previewFontScene(expandComponents(document, originalScene.id), fontPreview), speechPieces) }; }
    catch (error) { return { scene: originalScene, error: error.message }; }
  }, [document, originalScene.id, fontVersion, fontPreview]);
  const scene = resolved.scene;
  const imageFrames = useGifFrames(scene.layers, mediaActive);
  const luts = useSceneLuts(scene.layers);
  // Videos captured while an effect changes them (videoPreview.js videoCaptureWindows); at other
  // times the scene draws them from the same decoder <video> (render.js decoderVideoMarkup).
  const captureWindows = useMemo(() => videoCaptureWindows(scene), [scene]);
  const videoLayerIds = useMemo(() => new Set(captureWindows.keys()), [captureWindows]);
  const timeRef = useRef(time);
  timeRef.current = time;
  const wantsCapture = useCallback((id) => capturingAt(captureWindows.get(id), timeRef.current, CAPTURE_LEAD), [captureWindows]);
  const wantedKey = [...captureWindows].filter(([, windows]) => capturingAt(windows, time, CAPTURE_LEAD)).map(([id]) => id).join("\n");
  const videoLayers = useMemo(() => scene.layers
    .filter((layer) => videoLayerIds.has(layer.id))
    .map((layer) => ({ ...layer, mediaSrc: authorizedMediaUrl(layer.src) })), [scene, videoLayerIds]);
  const videoCapture = useVideoFrames(videoLayers, { active: mediaActive, playing: Boolean(playing) && !design, displaySide, capture: wantsCapture });
  useEffect(() => { if (wantedKey) videoCapture.refresh(); }, [wantedKey, videoCapture.refresh]);
  const ownSound = audio !== "external";
  // Sound as the export mixes it: an audio layer only when it and its groups are shown, and a
  // video only while it is drawn (not hidden by a Hide or by a group around it).
  const audioLayers = useMemo(() => (ownSound ? scene.layers.filter((layer) => layer.type === "audio" && layer.src && shownWithGroups(scene.layers, layer)) : []), [scene, ownSound]);
  const videoSound = useMemo(() => new Map(scene.layers.filter((layer) => layer.type === "video")
    .map((layer) => [layer.id, audibleRanges(scene.layers, layer, Number(scene.duration) || 0)])), [scene]);
  const rendered = useMemo(() => {
    try {
      if (resolved.error) return { error: resolved.error };
      const embedMedia = new Map(scene.layers.filter((layer) => layer.src).map((layer) => [layer.id, authorizedMediaUrl(layer.src)]));
      // A captured picture shows only inside its window; just before one it is drawn faintly
      // (videoLead), so it is decoded when the capture takes over. Without a picture yet, the
      // decoder canvas goes on showing the video.
      const videoFrames = new Map(), videoLead = new Map(), staticImages = new Map(imageFrames);
      for (const [id, url] of videoCapture.videoFrames) {
        if (url === INITIAL_VIDEO_FRAME) continue;
        const windows = captureWindows.get(id);
        if (capturingAt(windows, time)) videoFrames.set(id, url);
        else if (capturingAt(windows, time, CAPTURE_LEAD)) videoLead.set(id, url);
      }
      if (!mediaActive) for (const layer of scene.layers) {
        if (!mediaPosterPath(layer.src)) continue;
        const frame = ({ sourceTime }) => authorizedMediaUrl(mediaPosterPath(layer.src, sourceTime));
        if (layer.type === "video") videoFrames.set(layer.id, frame);
        else if (isGifLayer(layer)) staticImages.set(layer.id, frame);
      }
      return { html: renderSceneSvg(scene, time, { design, interactiveMedia: mediaActive, canvas: true, embedMedia,
        imageFrames: mediaActive ? imageFrames : staticImages, videoFrames, idPrefix, luts, calmLight,
        decodedVideos: mediaActive ? videoLayerIds : undefined, videoLead, previewBlur: true }) };
    } catch (error) {
      return { error: error.message };
    }
  }, [scene, time, design, resolved.error, fontVersion, imageFrames, videoCapture.videoFrames, idPrefix, mediaActive, luts, calmLight, captureWindows, videoLayerIds]);
  const html = rendered.html;
  const warm = useRef(null);
  useFilterPrewarm(warm, scene, { active: mediaActive && !design && !resolved.error,
    options: { embedMedia: new Map(scene.layers.filter((layer) => layer.src).map((layer) => [layer.id, authorizedMediaUrl(layer.src)])),
      imageFrames, idPrefix: `${idPrefix}warm`, luts, calmLight }, skip: skipPrewarm });
  useLayoutEffect(() => {
    if (!html || !container.current) {
      videoCapture.acknowledgePaint(videoCapture.videoFrames, false);
      return;
    }
    // Only the parts that changed since the last frame are parsed (svgPatch.js).
    patchSvgMarkup(container.current, html);
    videoCapture.acknowledgePaint(videoCapture.videoFrames);
  }, [html, videoCapture.videoFrames, videoCapture.acknowledgePaint]);
  // The scene's own <video> and <audio> elements let go of their files when the picture goes,
  // so their decoders stop at once instead of when they are garbage collected.
  const drawn = Boolean(html);
  useLayoutEffect(() => {
    const box = container.current;
    return () => releaseMedia(box);
  }, [drawn]);
  // Heavily blurred videos are drawn small into their canvas (render.js softVideoMarkup).
  useLayoutEffect(() => { drawSoftVideos(container.current, videoCapture.elementFor); }, [html, videoCapture.elementFor]);
  // Tilted layers are drawn on the GPU (liveTilt.js, render.js liveTiltTag).
  useLayoutEffect(() => { drawLiveTilts(container.current); }, [html]);
  useEffect(() => {
    for (const media of previewMediaElements(container.current, idPrefix)) {
      const layer = scene.layers.find((item) => item.id === media.dataset.mediaLayerId);
      if (!layer) continue;
      // The layer's volume at this moment, with its Volume animations (fades, ducking) applied.
      // (A media element's volume stops at 1; an export can turn a layer up to 4.)
      media.volume = Math.max(0, Math.min(1, volumeAt(layer, time)));
      // The low-pass cutoff at this moment (Web Audio, only once the layer has one).
      if (ownSound) applyMediaLowpass(media, lowpassSampler(layer)(time));
      const video = media.localName === "video";
      const silent = !ownSound || (video && !heardAt(videoSound.get(layer.id) ?? [], time));
      syncMediaElement(media, video
        ? videoSyncState(layer, time, { design, playing })
        : audioSyncState(layer, time, scene.duration, { design, playing }), { silent, drift: mediaDrift, playing });
    }
  }, [time, playing, scene, design, rendered.html, ownSound, videoSound, mediaDrift]);
  useEffect(() => {
    const media = previewMediaElements(container.current, idPrefix);
    return () => { for (const element of media) element.pause(); };
  }, [mediaActive, scene, idPrefix]);

  if (!html)
    return <div className="render-error">
      {rendered.error || "This scene could not be drawn. Check its media and layer properties."}
    </div>;
  return <>
    <div className="scene-svg" ref={container} />
    {mediaActive && !design && <div className="scene-svg" aria-hidden="true" ref={warm} style={PREWARM_STYLE} />}
    {mediaActive && videoLayers.length > 0 && <div aria-hidden="true" style={OFFSCREEN_VIDEO_STYLE}>
      {videoLayers.map((layer) => <video
        key={layer.id}
        ref={videoCapture.refFor(layer.id)}
        data-media-layer-id={layer.id}
        data-video-frame-decoder="true"
        data-scene-preview-id={idPrefix}
        src={layer.mediaSrc}
        preload="auto"
        muted
        playsInline
        tabIndex={-1}
        aria-hidden="true"
        style={{ width: "1px", height: "1px", objectFit: "contain" }}
      />)}
    </div>}
    {mediaActive && audioLayers.map((layer) => (
      <audio key={layer.id} data-media-layer-id={layer.id} data-scene-preview-id={idPrefix}
        src={authorizedMediaUrl(layer.src)} preload="auto" />
    ))}
  </>;
}
