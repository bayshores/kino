const MAX_PIXELS = 64_000_000;

// A zero-centered ordered pattern keeps spatial dither deterministic across frames.
const BAYER_8X8 = new Uint8Array([
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
]);

function qualityOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Render quality options must be an object.");
  }
  return options;
}

function validateMotionBlur(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Motion blur must be a finite number between 0 and 1.");
  }
  if (value < 0 || value > 1) {
    throw new RangeError("Motion blur must be between 0 and 1.");
  }
  return value;
}

// A frame's shutter is drawn this many times at most (the render option motionSamples). Each sample
// is a whole render, so 16 samples cost about 16 times one frame; createSampleBlend keeps the memory
// to one sum buffer however many samples there are.
export const MAX_MOTION_SAMPLES = 16;

function validateShutterAngle(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Shutter angle must be a number of degrees from 0 to 360.");
  }
  if (value < 0 || value > 360) throw new RangeError("Shutter angle must be from 0 to 360 degrees (180 is the film look).");
  return value;
}

function validateMotionSamples(value) {
  if (!Number.isInteger(value)) throw new TypeError(`Motion samples must be a whole number from 2 to ${MAX_MOTION_SAMPLES}.`);
  if (value < 2 || value > MAX_MOTION_SAMPLES) throw new RangeError(`Motion samples must be from 2 to ${MAX_MOTION_SAMPLES}.`);
  return value;
}

/**
 * Normalize the optional quality controls without changing unrelated render options.
 * motionBlur is how long the shutter is open, as a part of one frame (0.5 = half a frame);
 * shutterAngle says the same in degrees (180 = 0.5), so give one of them. motionSamples is how
 * many moments of the open shutter are drawn and averaged (2 by default).
 */
export function normalizeRenderQuality(options) {
  const values = qualityOptions(options);
  let motionBlur = values.motionBlur === undefined ? 0 : validateMotionBlur(values.motionBlur);
  if (values.shutterAngle !== undefined) {
    const fromAngle = validateShutterAngle(values.shutterAngle) / 360;
    if (values.motionBlur !== undefined && Math.abs(fromAngle - motionBlur) > 1e-9) {
      throw new RangeError(`Give shutterAngle or motionBlur, not both: shutterAngle ${values.shutterAngle} is motionBlur ${Number(fromAngle.toFixed(4))}.`);
    }
    motionBlur = fromAngle;
  }
  const motionSamples = values.motionSamples === undefined ? 2 : validateMotionSamples(values.motionSamples);
  const dither = values.dither === undefined ? false : values.dither;
  if (typeof dither !== "boolean") throw new TypeError("Dither must be a boolean.");
  return { motionBlur, motionSamples, dither };
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

/**
 * Return the shutter sample times of the frame at `time`, clamped to the scene's duration:
 * `samples` moments spread evenly over the open shutter (motionBlur / fps seconds, centred on the
 * frame), each in the middle of its own slice. Two samples are t - S/4 and t + S/4.
 */
export function motionSampleTimes(time, duration, fps, motionBlur = 0, samples = 2) {
  finiteNumber(time, "Time");
  finiteNumber(duration, "Duration");
  finiteNumber(fps, "Frame rate");
  validateMotionBlur(motionBlur);
  validateMotionSamples(samples);
  if (duration <= 0) throw new RangeError("Duration must be greater than zero.");
  if (fps <= 0) throw new RangeError("Frame rate must be greater than zero.");
  if (time < 0 || time > duration) throw new RangeError("Time must be within the scene duration.");
  if (motionBlur === 0) return [time];

  const shutter = motionBlur / fps;
  return Array.from({ length: samples }, (_, index) =>
    Math.min(duration, Math.max(0, time + shutter * ((index + 0.5) / samples - 0.5))));
}

function validateSample(sample, index) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    throw new TypeError(`Render sample ${index} must be an object.`);
  }
  const { width, height, pixels } = sample;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError(`Render sample ${index} dimensions must be positive safe integers.`);
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_PIXELS) {
    throw new RangeError(`Render sample ${index} exceeds the ${MAX_PIXELS}-pixel limit.`);
  }
  if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
    throw new TypeError(`Render sample ${index} pixels must be an 8-bit typed array.`);
  }
  if (pixels.length !== pixelCount * 4) {
    throw new RangeError(`Render sample ${index} must contain exactly ${pixelCount * 4} RGBA bytes.`);
  }
  const premultiplied = sample.premultiplied === undefined ? true : sample.premultiplied;
  if (typeof premultiplied !== "boolean") {
    throw new TypeError(`Render sample ${index} premultiplied must be a boolean.`);
  }
  return { pixels, width, height, premultiplied, pixelCount };
}

function byte(value) {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.floor(value + 0.5);
}

/** Blend raw RGBA frames in premultiplied space and return straight-alpha bytes. */
export function blendRenderSamples(samples, options) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("At least one rendered sample is required.");
  }
  const { dither } = normalizeRenderQuality(options);
  const validated = new Array(samples.length);
  let width;
  let height;
  let pixelCount;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = validateSample(samples[index], index);
    if (index === 0) {
      ({ width, height, pixelCount } = sample);
    } else if (sample.width !== width || sample.height !== height) {
      throw new RangeError("All render samples must have matching dimensions.");
    }
    validated[index] = sample;
  }

  const output = new Uint8ClampedArray(pixelCount * 4);
  const sampleCount = validated.length;
  // Final renders use two premultiplied shutter samples. Keep their common opaque
  // pixels on a short integer path instead of repeating alpha divisions and object
  // lookups for every channel. Translucent edges retain the same unpremultiplication.
  if (sampleCount === 2 && validated[0].premultiplied && validated[1].premultiplied) {
    const first = validated[0].pixels, second = validated[1].pixels;
    let x = 0, y = 0;
    for (let offset = 0; offset < output.length; offset += 4) {
      const alphaSum = first[offset + 3] + second[offset + 3];
      const noise = dither ? (BAYER_8X8[((y & 7) << 3) | (x & 7)] < 32 ? -1 : 1) : 0;
      output[offset + 3] = (alphaSum + 1) >> 1;
      if (alphaSum === 510) {
        output[offset] = ((first[offset] + second[offset] + 1) >> 1) + noise;
        output[offset + 1] = ((first[offset + 1] + second[offset + 1] + 1) >> 1) + noise;
        output[offset + 2] = ((first[offset + 2] + second[offset + 2] + 1) >> 1) + noise;
      } else if (alphaSum) {
        output[offset] = byte((first[offset] + second[offset]) * 255 / alphaSum + noise);
        output[offset + 1] = byte((first[offset + 1] + second[offset + 1]) * 255 / alphaSum + noise);
        output[offset + 2] = byte((first[offset + 2] + second[offset + 2]) * 255 / alphaSum + noise);
      }
      if (++x === width) { x = 0; y++; }
    }
    return { pixels: output, width, height };
  }
  let x = 0;
  let y = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    let redPremultipliedSum = 0;
    let greenPremultipliedSum = 0;
    let bluePremultipliedSum = 0;
    let alphaSum = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const sample = validated[sampleIndex];
      const pixels = sample.pixels;
      const alpha = pixels[offset + 3];
      alphaSum += alpha;
      if (sample.premultiplied) {
        redPremultipliedSum += pixels[offset];
        greenPremultipliedSum += pixels[offset + 1];
        bluePremultipliedSum += pixels[offset + 2];
      } else {
        redPremultipliedSum += pixels[offset] * alpha / 255;
        greenPremultipliedSum += pixels[offset + 1] * alpha / 255;
        bluePremultipliedSum += pixels[offset + 2] * alpha / 255;
      }
    }

    const alpha = byte(alphaSum / sampleCount);
    output[offset + 3] = alpha;
    if (alphaSum === 0) {
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
    } else {
      const patternValue = dither ? BAYER_8X8[((y & 7) << 3) | (x & 7)] : 32;
      const noise = dither ? (patternValue < 32 ? -1 : 1) : 0;
      output[offset] = byte(redPremultipliedSum * 255 / alphaSum + noise);
      output[offset + 1] = byte(greenPremultipliedSum * 255 / alphaSum + noise);
      output[offset + 2] = byte(bluePremultipliedSum * 255 / alphaSum + noise);
    }
    if (dither && ++x === width) {
      x = 0;
      y += 1;
    }
  }
  return { pixels: output, width, height };
}

/**
 * Average premultiplied RGBA samples that arrive one at a time, with the same result as
 * blendRenderSamples, while holding one 16-bit sum per channel instead of every sample (a 1080p
 * frame needs 16.6 MB however many samples). Motion blur with many shutter samples uses it.
 */
export function createSampleBlend(width, height) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 || width * height > MAX_PIXELS) {
    throw new RangeError(`A sample blend needs positive dimensions within ${MAX_PIXELS} pixels.`);
  }
  const sums = new Uint16Array(width * height * 4);
  let count = 0;
  return {
    get count() { return count; },
    add(sample) {
      const { pixels, premultiplied } = validateSample(sample, count);
      if (sample.width !== width || sample.height !== height) throw new RangeError("All render samples must have matching dimensions.");
      if (!premultiplied) throw new TypeError("A sample blend adds premultiplied samples only.");
      // 257 samples of 255 still fit in 16 bits.
      if (count === 257) throw new RangeError("A sample blend holds at most 257 samples.");
      for (let index = 0; index < sums.length; index += 1) sums[index] += pixels[index];
      count += 1;
    },
    finish(options) {
      if (!count) throw new TypeError("At least one rendered sample is required.");
      const { dither } = normalizeRenderQuality(options);
      const output = new Uint8ClampedArray(sums.length);
      let x = 0, y = 0;
      for (let offset = 0; offset < output.length; offset += 4) {
        const alphaSum = sums[offset + 3];
        output[offset + 3] = byte(alphaSum / count);
        if (alphaSum) {
          const noise = dither ? (BAYER_8X8[((y & 7) << 3) | (x & 7)] < 32 ? -1 : 1) : 0;
          output[offset] = byte(sums[offset] * 255 / alphaSum + noise);
          output[offset + 1] = byte(sums[offset + 1] * 255 / alphaSum + noise);
          output[offset + 2] = byte(sums[offset + 2] * 255 / alphaSum + noise);
        }
        if (++x === width) { x = 0; y += 1; }
      }
      return { pixels: output, width, height };
    },
  };
}
