// Native-size scene stills render one frame, so their memory budget is independent
// of the video/preset footprint limits. Bound both axes and the raw RGBA pixel count.
const MAX_NATIVE_PNG_DIMENSION = 16_384;
const MAX_NATIVE_PNG_PIXELS = 33_554_432;

export function nativePngSize(scene) {
  if (![scene?.width, scene?.height].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0))
    throw new Error("Native PNG dimensions must be positive finite numbers.");
  const width = Math.max(1, Math.round(scene.width)), height = Math.max(1, Math.round(scene.height));
  if (width > MAX_NATIVE_PNG_DIMENSION || height > MAX_NATIVE_PNG_DIMENSION || width * height > MAX_NATIVE_PNG_PIXELS)
    throw new Error("Native PNG output supports at most 16,384 pixels per side and 33,554,432 pixels in total. Resize the scene or use a smaller export preset.");
  return { width, height };
}
