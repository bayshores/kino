import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { encodeLottiePng } from "./lottie-png.mjs";

const MAX_RASTER_AXIS = 2048;
const MAX_ERROR_LENGTH = 8000;

function aborted(signal) {
  const error = new Error("Lottie image processing was cancelled", {
    cause: signal?.reason,
  });
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw aborted(signal);
}

function normalizeMime(mime) {
  if (typeof mime !== "string") throw new TypeError("Lottie image MIME type is required");
  const value = mime.split(";", 1)[0].trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/u.test(value)) {
    throw new TypeError(`Unsupported Lottie image MIME type: ${mime}`);
  }
  return value === "image/jpg" ? "image/jpeg" : value;
}

function sourceExtension(mime) {
  switch (mime) {
    case "image/png": return ".png";
    case "image/jpeg":
    case "image/jpg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "image/avif": return ".avif";
    case "image/bmp": return ".bmp";
    case "image/tiff": return ".tiff";
    default: return ".img";
  }
}

function outputType(mime) {
  // Preserve PNG/JPEG sources. Other raster formats currently normalize to PNG.
  if (mime === "image/jpeg") return { mime: "image/jpeg", extension: ".jpg", codec: "mjpeg" };
  if (mime === "image/png") return { mime: "image/png", extension: ".png", codec: "png" };
  return { mime: "image/png", extension: ".png", codec: "png" };
}

function toolCommand(kind) {
  if (kind === "ffprobe") {
    return process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";
  }
  return process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
}

function processError(command, kind, error) {
  if (error?.name === "AbortError") return error;
  if (error?.code === "ENOENT") {
    return new Error(
      `${kind} executable “${basename(command)}” was not found. Install FFmpeg with ffprobe, or configure KINO_FFMPEG and KINO_FFPROBE.`,
      { cause: error },
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  const message = kind === "FFmpeg"
    ? `FFmpeg could not decode or resize this Lottie image. Install FFmpeg with support for its image format. ${detail}`
    : `ffprobe could not inspect this Lottie image. Check that it is a supported raster image. ${detail}`;
  return new Error(message, { cause: error });
}

function runProcess(command, args, signal, cwd) {
  throwIfAborted(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stdoutSize = 0;
    let stderr = "";
    let killTimer;
    let settled = false;

    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(output);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      stdout.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_ERROR_LENGTH) stderr = stderr.slice(-MAX_ERROR_LENGTH);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, terminatingSignal) => {
      if (signal?.aborted) {
        finish(aborted(signal));
      } else if (code === 0) {
        finish(null, Buffer.concat(stdout, stdoutSize).toString("utf8"));
      } else {
        finish(new Error(
          `${basename(command)} failed with exit code ${code ?? terminatingSignal}: ${stderr.trim() || "no diagnostic output"}`,
        ));
      }
    });
  });
}

async function execute(run, kind, args, signal, cwd) {
  const command = toolCommand(kind);
  try {
    throwIfAborted(signal);
    const output = await run(command, args, signal, cwd);
    if (Buffer.isBuffer(output)) return output.toString("utf8");
    if (typeof output === "string") return output;
    if (typeof output?.stdout === "string") return output.stdout;
    if (Buffer.isBuffer(output?.stdout)) return output.stdout.toString("utf8");
    throw new TypeError(`${kind} returned no text output`);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw aborted(signal);
    throw processError(command, kind === "ffprobe" ? "ffprobe" : "FFmpeg", error);
  }
}

function safeIndex(index) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TypeError("Lottie image index must be a nonnegative integer");
  }
  return index;
}

/** Writes a new file only this user can read; removes it again when the write fails. */
export async function writePrivateFile(path, buffer) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(buffer);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
}

function parseProbeResult(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("ffprobe returned invalid image metadata", { cause: error });
  }
  const stream = parsed?.streams?.find((candidate) =>
    Number.isInteger(Number(candidate.width)) && Number.isInteger(Number(candidate.height))
  );
  const rawWidth = Number(stream?.width);
  const rawHeight = Number(stream?.height);
  if (!Number.isSafeInteger(rawWidth) || !Number.isSafeInteger(rawHeight) || rawWidth < 1 || rawHeight < 1) {
    throw new Error("ffprobe did not report positive image dimensions");
  }

  const sideData = stream.side_data_list?.find((item) => item.rotation != null);
  const rotation = Number(sideData?.rotation ?? stream.tags?.rotate ?? 0);
  const normalizedRotation = Number.isFinite(rotation)
    ? ((Math.round(rotation) % 360) + 360) % 360
    : 0;
  const quarterTurn = normalizedRotation === 90 || normalizedRotation === 270;
  return {
    sourceWidth: quarterTurn ? rawHeight : rawWidth,
    sourceHeight: quarterTurn ? rawWidth : rawHeight,
    sourceRawWidth: rawWidth,
    sourceRawHeight: rawHeight,
    orientation: normalizedRotation,
  };
}

function dataHref(mime, buffer) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/** Inspect an embedded raster image and retain it in the caller's private temp directory. */
export async function inspectLottieImage(
  source,
  { directory, index, signal, runProcess: run = runProcess } = {},
) {
  if (!source || typeof source !== "object") throw new TypeError("A Lottie image source is required");
  const mime = normalizeMime(source.mime);
  const buffer = Buffer.isBuffer(source.buffer)
    ? source.buffer
    : source.buffer instanceof Uint8Array
      ? Buffer.from(source.buffer)
      : null;
  if (!buffer?.length) throw new TypeError("Lottie image bytes are required");
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("A private Lottie image temp directory is required");
  }
  const imageIndex = safeIndex(index);
  throwIfAborted(signal);

  const workingDirectory = resolve(directory);
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
  const path = join(workingDirectory, `lottie-image-${imageIndex}-${randomUUID()}${sourceExtension(mime)}`);
  let ownsPath = false;
  try {
    await writePrivateFile(path, buffer);
    ownsPath = true;
    throwIfAborted(signal);
    const probeText = await execute(run, "ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:stream_tags=rotate:stream_side_data=rotation",
      "-of", "json",
      path,
    ], signal, workingDirectory);
    throwIfAborted(signal);
    const dimensions = parseProbeResult(probeText);
    // Keep the decoded source once for every use of this bitmap. Formats not
    // supported by Skia retain the FFmpeg first-frame fallback below.
    const bitmap = await loadImage(buffer).catch(() => null);
    throwIfAborted(signal);
    return {
      ...dimensions,
      ...(bitmap ? { sourceWidth: bitmap.width, sourceHeight: bitmap.height, bitmap } : {}),
      buffer,
      mime,
      path,
      href: dataHref(mime, buffer),
    };
  } catch (error) {
    if (ownsPath) await unlink(path).catch(() => {});
    if (signal?.aborted || error?.name === "AbortError") throw aborted(signal);
    if (error?.message?.startsWith("ffprobe could not inspect")) throw error;
    throw processError(toolCommand("ffprobe"), "ffprobe", error);
  }
}

function resolutionRatio(value) {
  if (value === "original") return null;
  if (value == null) return 3;
  const match = /^(1|2|3)x$/u.exec(value);
  if (!match) throw new TypeError("Lottie image size must be 1x, 2x, 3x, or original");
  return Number(match[1]);
}

function validAxis(value, label) {
  const axis = Number(value);
  if (!Number.isFinite(axis) || axis < 0) {
    throw new TypeError(`Lottie image ${label} must be a nonnegative finite number`);
  }
  return axis;
}

function targetAxis(maxWorldAxis, ratio, sourceAxis) {
  return Math.min(
    MAX_RASTER_AXIS,
    Math.ceil(Math.max(1, Math.min(maxWorldAxis * ratio, sourceAxis))),
  );
}

/** Resize a real raster asset using the Canvas2D low-smoothing image pipeline. */
export async function resizeLottieImage(
  image,
  {
    maxWidth,
    maxHeight,
    imageDPIRatio = "3x",
    directory,
    index,
    signal,
    runProcess: run = runProcess,
  } = {},
) {
  if (!image || typeof image !== "object" || !Buffer.isBuffer(image.buffer)) {
    throw new TypeError("Inspect the Lottie image before resizing it");
  }
  const mime = normalizeMime(image.mime);
  const sourceWidth = Number(image.sourceWidth);
  const sourceHeight = Number(image.sourceHeight);
  if (!Number.isSafeInteger(sourceWidth) || sourceWidth < 1 || !Number.isSafeInteger(sourceHeight) || sourceHeight < 1) {
    throw new TypeError("Lottie image has invalid source dimensions");
  }
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("A private Lottie image temp directory is required");
  }
  const imageIndex = safeIndex(index);
  const ratio = resolutionRatio(imageDPIRatio);
  throwIfAborted(signal);
  const worldWidth = validAxis(maxWidth, "maximum width");
  const worldHeight = validAxis(maxHeight, "maximum height");
  const target = outputType(mime);
  const width = ratio === null ? sourceWidth : targetAxis(worldWidth, ratio, sourceWidth);
  const height = ratio === null ? sourceHeight : targetAxis(worldHeight, ratio, sourceHeight);
  const clamped = ratio !== null && (
    (sourceWidth > MAX_RASTER_AXIS && width < worldWidth) ||
    (sourceHeight > MAX_RASTER_AXIS && height < worldHeight)
  );

  if (width === sourceWidth && height === sourceHeight && target.mime === mime) {
    return { width, height, href: image.href ?? dataHref(mime, image.buffer), clamped };
  }

  const workingDirectory = resolve(directory);
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
  const inputPath = typeof image.path === "string" && image.path.length > 0
    ? resolve(image.path)
    : join(workingDirectory, `lottie-source-${imageIndex}-${randomUUID()}${sourceExtension(mime)}`);
  let ownsInput = false;
  let outputPath;
  let ownsOutput = false;
  try {
    try {
      await access(inputPath);
    } catch (error) {
      if (error?.code !== "ENOENT" || inputPath === image.path) throw error;
      await writePrivateFile(inputPath, image.buffer);
      ownsInput = true;
    }

    throwIfAborted(signal);
    let buffer;
    const bitmap = image.bitmap ?? await loadImage(image.buffer).catch(() => null);
    throwIfAborted(signal);
    if (bitmap) {
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "low";
      context.drawImage(bitmap, 0, 0, width, height);
      buffer = target.mime === "image/png"
        ? encodeLottiePng(context.getImageData(0, 0, width, height).data, width, height, { signal })
        : canvas.encodeSync("jpeg", 80);
    } else {
      outputPath = join(workingDirectory, `lottie-resized-${imageIndex}-${randomUUID()}${target.extension}`);
      ownsOutput = true;
      await execute(run, "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-autorotate",
        "-i", inputPath,
        "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
        "-vf", `scale=${width}:${height}:flags=area`,
        "-c:v", target.codec,
        ...(target.mime === "image/jpeg" ? ["-q:v", "2"] : ["-compression_level", "6"]),
        "-update", "1", outputPath,
      ], signal, workingDirectory);
      buffer = await readFile(outputPath);
    }
    throwIfAborted(signal);
    if (!buffer.length) throw new Error("The image encoder produced an empty Lottie image");

    const href = dataHref(target.mime, buffer);
    if (
      target.mime === mime &&
      sourceWidth <= MAX_RASTER_AXIS &&
      sourceHeight <= MAX_RASTER_AXIS &&
      image.buffer.length < href.length * 0.75
    ) {
      return {
        width: sourceWidth,
        height: sourceHeight,
        href: image.href ?? dataHref(mime, image.buffer),
        clamped,
      };
    }
    return { width, height, href, clamped };
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw aborted(signal);
    if (error?.message?.startsWith("FFmpeg could not decode or resize")) throw error;
    throw new Error(`Lottie image conversion failed: ${error.message || String(error)}`, { cause: error });
  } finally {
    if (ownsOutput && outputPath) await unlink(outputPath).catch(() => {});
    if (ownsInput) await unlink(inputPath).catch(() => {});
  }
}
