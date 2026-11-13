// A still PNG export renders one frame of a scene. That frame's time is the
// editor playhead, in seconds from the start of the scene. The editor, the
// export page, the batch queue and the server all read the time through these
// functions, so the same number travels from the timeline to the rendered PNG.

function sceneDuration(scene, duration) {
  const value = Number(duration ?? scene?.duration);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Clamps a playhead time into 0..duration. A value that is not a finite number becomes 0 (the first frame). */
export function stillFrameTime(time, duration) {
  const end = sceneDuration(null, duration);
  if (typeof time !== "number" || !Number.isFinite(time)) return 0;
  return Math.min(end, Math.max(0, time));
}

/** The longest duration among the scenes, used as the upper limit of a time shared by a batch. */
export function longestSceneDuration(scenes, duration) {
  return Math.max(0, ...scenes.map((scene) => sceneDuration(scene, duration)));
}

/** Throws unless `time` is a finite number of seconds from 0 through `duration`. */
export function assertStillFrameTime(time, duration) {
  if (typeof time !== "number" || !Number.isFinite(time))
    throw new Error("A still image time must be a finite number of seconds.");
  if (time < 0 || time > duration)
    throw new Error(`A still image time must be between 0 and ${duration} seconds, the scene duration.`);
}

/** True for the formats that save one frame of a scene: a PNG or a JPEG still. */
export function isStillFormat(format) {
  return format === "png" || format === "jpeg";
}

/**
 * A batch shares one playhead time. Each scene renders that time, clamped to its
 * own duration, so a shorter scene exports its last frame. Other formats ignore it.
 */
export function stillOptionsForScene(options, scene) {
  if (!isStillFormat(options.format) || options.time === undefined) return { ...options };
  return { ...options, time: stillFrameTime(options.time, sceneDuration(scene, options.duration)) };
}

/** Rejects a batch still time that no selected scene can show. */
export function assertBatchStillTime(options, scenes) {
  if (!isStillFormat(options.format) || options.time === undefined || !scenes.length) return;
  assertStillFrameTime(options.time, longestSceneDuration(scenes, options.duration));
}

/** Throws unless a still's `design` option is left out, true or false. Only a still image can ask for it. */
export function assertStillDesign(design, format) {
  if (design === undefined) return;
  if (typeof design !== "boolean") throw new Error("The export design view must be true or false.");
  if (design && !isStillFormat(format)) throw new Error("The design view applies only to still PNG and JPEG exports.");
}

/**
 * The frame a batch row's thumbnail shows. A still image's thumbnail shows the frame its file
 * saves (its time, or the design view); animated formats show their first frame.
 */
export function thumbnailFrame(options) {
  if (!isStillFormat(options.format)) return { time: 0 };
  return { time: options.time ?? 0, ...(options.design ? { design: true } : {}) };
}
