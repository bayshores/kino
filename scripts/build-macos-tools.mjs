#!/usr/bin/env node
// Build the pinned arm64 media tools in the ignored .local tree. No system install or user HOME
// changes are made. The no-argument mode only prints the plan; downloads/builds require --build.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, readlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWriteStream as createNodeWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const CONFIG_PATH = join(SCRIPT_DIR, "macos-tools.json");
const PRIVATE_ROOT = join(ROOT, ".local", "macos-tools");
const CACHE_ROOT = join(PRIVATE_ROOT, "cache");
const ARCHIVE_CACHE = join(CACHE_ROOT, "archives");
const OUTPUT_PATH = join(PRIVATE_ROOT, "dist");
const CONFIG = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
// kino's own Swift helper for Apple's sound isolation audio unit (voice isolation engine "apple").
const VOICE_HELPER_SOURCE = join(ROOT, "backend", "voice", "kino-voice.swift");
// kino's own Swift helper for Apple Vision's subject and person masks (the edit op cut_out).
const CUTOUT_HELPER_SOURCE = join(ROOT, "backend", "cutout", "kino-cutout.swift");
// kino's own Swift helper for Apple Vision measures (Inspire's fingerprint, reference_drift).
const MEASURE_HELPER_SOURCE = join(ROOT, "backend", "measure", "kino-measure.swift");
const BINARIES = ["ffmpeg", "ffprobe", "gifski", "kino-voice", "kino-cutout", "kino-measure"];
const MANIFEST_SCHEMA = 6;
const JOBS = 2;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_KEY_BYTES = 1024 * 1024;
const SIGNING_FINGERPRINT = CONFIG.tools.ffmpeg.signingKeyFingerprint;
const INHERITED_BUILD_SETTINGS = /^(?:CC|CXX|CPP|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|LIBS|AR|ARFLAGS|RANLIB|NM|LD|AS|PKG_CONFIG(?:_.*)?|RUSTC|RUSTDOC|RUSTFLAGS|RUSTDOCFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_TARGET_.*_LINKER|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|MAKEFLAGS|MFLAGS|GNUMAKEFLAGS)$/i;
const ARCHIVE_HOSTS = new Set([
  "ffmpeg.org",
  "code.videolan.org",
  "github.com",
  "codeload.github.com",
  "ftp.osuosl.org",
  "distfiles.ariadne.space",
  "release-assets.githubusercontent.com",
]);

function fail(message) {
  throw new Error(message);
}

function printPlan() {
  console.log("Pinned kino macOS arm64 media-tool build (plan only; no network or build work).");
  console.log(`Target: macOS ${CONFIG.target.minimumMacOS}+ arm64; build jobs capped at ${JOBS}.`);
  console.log(`FFmpeg ${CONFIG.tools.ffmpeg.version}, x264 ${CONFIG.tools.x264.version}, libvpx ${CONFIG.tools.libvpx.version}, Opus ${CONFIG.tools.opus.version}, Gifski ${CONFIG.tools.gifski.version}.`);
  console.log("kino-voice: kino's Swift helper for Apple sound isolation, compiled from server/voice/kino-voice.swift.");
  console.log("kino-cutout: kino's Swift helper for Apple Vision subject masks, compiled from server/cutout/kino-cutout.swift.");
  console.log("kino-measure: kino's Swift helper for Apple Vision measures (flow, text, feature prints), compiled from server/measure/kino-measure.swift.");
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log("Run with --build to download hash-pinned upstream sources, verify FFmpeg's signature, and build only inside .local/macos-tools.");
  console.log("Run with --verify to check a previously built bundle without changing it.");
}

function sourceArchiveNames() {
  return {
    ffmpeg: `ffmpeg-${CONFIG.tools.ffmpeg.version}.tar.xz`,
    x264: `x264-${CONFIG.tools.x264.commit}.tar.gz`,
    libvpx: `libvpx-${CONFIG.tools.libvpx.version}.tar.gz`,
    opus: `opus-${CONFIG.tools.opus.version}.tar.gz`,
    pkgconf: `pkgconf-${CONFIG.tools.pkgconf.version}.tar.xz`,
    gifski: `gifski-${CONFIG.tools.gifski.version}.tar.gz`,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function cleanBuildEnvironment(overrides) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED_BUILD_SETTINGS.test(name)));
  return {
    ...inherited,
    CC: overrides.CC,
    CXX: overrides.CXX,
    AR: overrides.AR,
    RANLIB: overrides.RANLIB,
    NM: overrides.NM,
    LD: overrides.CC,
    CFLAGS: "",
    CXXFLAGS: "",
    CPPFLAGS: "",
    LDFLAGS: "",
    LIBS: "",
    PKG_CONFIG_PATH: "",
    MAKEFLAGS: "",
    MFLAGS: "",
    GNUMAKEFLAGS: "",
    RUSTFLAGS: "",
    RUSTDOCFLAGS: "",
    CARGO_ENCODED_RUSTFLAGS: "",
    ...overrides,
  };
}

function verifyFailure(message) {
  fail(`Bundled media tools are missing or invalid (${message}). Run npm run desktop:tools.`);
}

function pathIsInside(rootPath, candidatePath) {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function integrityTree(rootPath, label) {
  const root = resolve(rootPath);
  const entries = [];
  const visit = async (directory) => {
    const children = await readdir(directory);
    children.sort();
    for (const name of children) {
      const path = join(directory, name);
      const rel = relative(root, path).split(sep).join("/");
      const info = await lstat(path);
      if (info.isDirectory()) {
        entries.push([rel, "directory"]);
        await visit(path);
      } else if (info.isFile()) {
        entries.push([rel, `sha256:${await sha256File(path)}`]);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        const resolvedTarget = resolve(dirname(path), target);
        if (isAbsolute(target) || !pathIsInside(root, resolvedTarget))
          fail(`${label} contains a symlink that escapes its corresponding-source tree: ${rel}`);
        entries.push([rel, `symlink:${target}`]);
      } else {
        fail(`${label} contains an unsupported filesystem entry: ${rel}`);
      }
    }
  };

  await visit(root);
  entries.sort(([left], [right]) => left.localeCompare(right, "en"));
  return Object.fromEntries(entries);
}

async function assertCurrentRebuildInputs(rebuildRoot) {
  const inputs = [
    ["build script", join(SCRIPT_DIR, "build-macos-tools.mjs"), join(rebuildRoot, "scripts", "build-macos-tools.mjs")],
    ["build config", CONFIG_PATH, join(rebuildRoot, "scripts", "macos-tools.json")],
    ["build documentation", join(ROOT, "docs", "bundled-tools.md"), join(rebuildRoot, "docs", "bundled-tools.md")],
    ["voice helper source", VOICE_HELPER_SOURCE, join(rebuildRoot, "backend", "voice", "kino-voice.swift")],
    ["cut-out helper source", CUTOUT_HELPER_SOURCE, join(rebuildRoot, "backend", "cutout", "kino-cutout.swift")],
    ["measure helper source", MEASURE_HELPER_SOURCE, join(rebuildRoot, "backend", "measure", "kino-measure.swift")],
  ];
  for (const [label, currentPath, bundledPath] of inputs) {
    await assertRegularFile(bundledPath, `rebuild source ${label}`);
    const [current, bundled] = await Promise.all([readFile(currentPath), readFile(bundledPath)]);
    if (!current.equals(bundled)) verifyFailure(`bundled rebuild ${label} differs from the current workspace`);
  }
}

async function assertRegularFile(path, label) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") verifyFailure(`missing ${label}`); throw error; }
  if (!info.isFile()) verifyFailure(`${label} is not a regular file`);
}

async function assertDirectory(path, label) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") verifyFailure(`missing ${label}`); throw error; }
  if (!info.isDirectory()) verifyFailure(`${label} is not a directory`);
}

function run(command, args, { cwd, env = process.env, capture = false, maxOutput = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    const collect = (which, chunk) => {
      const next = which === "stdout" ? stdout + chunk : stderr + chunk;
      if (Buffer.byteLength(next) > maxOutput) {
        child.kill("SIGKILL");
        rejectPromise(new Error(`${basename(command)} produced too much diagnostic output.`));
      } else if (which === "stdout") stdout = next;
      else stderr = next;
    };
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => collect("stdout", chunk));
      child.stderr.on("data", (chunk) => collect("stderr", chunk));
    }
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise(capture ? stdout : "");
      else rejectPromise(new Error(`${basename(command)} failed (${code ?? signal}).${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadVerified(url, destination, expectedHash, maxBytes = MAX_ARCHIVE_BYTES) {
  try {
    const existingHash = await sha256File(destination);
    if (existingHash !== expectedHash) fail(`Cached source hash mismatch: ${basename(destination)}.`);
    return destination;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const parsed = new URL(url);
  if (parsed.protocol !== "https:") fail(`Refusing a non-HTTPS source URL: ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  const responseHost = response.url ? new URL(response.url).hostname : "";
  if (response.status === 406 && (parsed.hostname === "code.videolan.org" || responseHost === "code.videolan.org")) {
    await response.body?.cancel();
    return downloadVerifiedWithCurl(url, destination, expectedHash, maxBytes);
  }
  if (!response.ok || !response.body) fail(`Source download failed (${response.status}): ${url}`);
  const finalHost = responseHost;
  if (!ARCHIVE_HOSTS.has(finalHost)) fail(`Refusing an unexpected source redirect host: ${finalHost}`);

  const temporary = `${destination}.${process.pid}.part`;
  const hash = createHash("sha256");
  let total = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) return callback(new Error(`Source exceeds the ${maxBytes} byte download limit: ${url}`));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createNodeWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    const actualHash = hash.digest("hex");
    if (actualHash !== expectedHash) fail(`SHA-256 mismatch for ${basename(destination)}: expected ${expectedHash}, received ${actualHash}.`);
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function downloadVerifiedWithCurl(url, destination, expectedHash, maxBytes) {
  const temporaryDirectory = await mkdtemp(join(dirname(destination), ".source-download-"));
  const temporary = join(temporaryDirectory, basename(destination));
  try {
    const finalUrl = (await run("/usr/bin/curl", [
      "--disable", "--fail", "--silent", "--show-error", "--location", "--max-redirs", "5",
      "--proto", "=https", "--proto-redir", "=https", "--max-filesize", String(maxBytes),
      "--output", temporary, "--write-out", "%{url_effective}", url,
    ], { capture: true, maxOutput: 4096 })).trim();
    const finalHost = new URL(finalUrl).hostname;
    if (!ARCHIVE_HOSTS.has(finalHost)) fail(`Refusing an unexpected source redirect host: ${finalHost}`);
    const info = await stat(temporary);
    if (!info.isFile() || info.size > maxBytes) fail(`Source exceeds the ${maxBytes} byte download limit: ${url}`);
    const actualHash = await sha256File(temporary);
    if (actualHash !== expectedHash) fail(`SHA-256 mismatch for ${basename(destination)}: expected ${expectedHash}, received ${actualHash}.`);
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function downloadUnhashed(url, destination, maxBytes = MAX_KEY_BYTES) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") fail(`Refusing a non-HTTPS key URL: ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body || new URL(response.url).hostname !== "ffmpeg.org")
    fail(`FFmpeg signing-key download failed or redirected unexpectedly: ${url}`);
  const temporary = `${destination}.${process.pid}.part`;
  let total = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) return callback(new Error("FFmpeg signing key exceeded its size limit."));
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createNodeWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function extractArchive(archive, destination) {
  await mkdir(destination, { recursive: true });
  const listing = (await run("tar", ["-tf", archive], { capture: true })).split(/\r?\n/).filter(Boolean);
  const roots = new Set();
  for (const entry of listing) {
    const normalized = entry.replace(/^\.\//, "");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) fail(`Unsafe path in pinned source archive: ${basename(archive)}.`);
    const root = normalized.split("/")[0];
    if (root && root !== ".") roots.add(root);
  }
  if (roots.size !== 1) fail(`Expected one root folder in ${basename(archive)}; found ${roots.size}.`);
  await run("tar", ["-xf", archive, "-C", destination]);
  return join(destination, [...roots][0]);
}

function replaceTemplate(value, substitutions) {
  return value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key) => {
    if (!(key in substitutions)) fail(`Unknown build recipe placeholder: ${key}`);
    return substitutions[key];
  });
}

async function buildConfigureProject(source, args, env) {
  await run("./configure", args, { cwd: source, env });
  await run("make", ["-j", String(JOBS)], { cwd: source, env });
  await run("make", ["install"], { cwd: source, env });
}

async function copyRequiredLicense(source, target, name) {
  const destination = join(target, name);
  await copyFile(source, destination);
  return destination;
}

async function verifySystemOnlyDependencies(binary) {
  const output = await run("xcrun", ["otool", "-L", binary], { capture: true });
  const dependencies = output.split(/\r?\n/).slice(1).map((line) => line.trim().split(" (")[0]).filter(Boolean);
  const allowed = ["/usr/lib/", "/System/Library/", "/System/Cryptexes/App/usr/lib/", "/System/Volumes/Preboot/Cryptexes/OS/usr/lib/"];
  const unexpected = dependencies.filter((dependency) => !allowed.some((prefix) => dependency.startsWith(prefix)));
  if (unexpected.length) fail(`${basename(binary)} still depends on non-system libraries:\n${unexpected.join("\n")}`);
  return dependencies;
}

function parseFfmpegCodecList(output) {
  const codecs = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[A-Z.]{6}\s+([A-Za-z0-9_.+-]+)\s+/);
    if (match) codecs.add(match[1]);
  }
  return [...codecs].sort();
}

async function assertRequiredFfmpegCodecs(binary, required, label = basename(binary)) {
  const [encoderOutput, decoderOutput] = await Promise.all([
    run(binary, ["-hide_banner", "-encoders"], { capture: true }),
    run(binary, ["-hide_banner", "-decoders"], { capture: true }),
  ]);
  const detected = {
    encoders: parseFfmpegCodecList(encoderOutput),
    decoders: parseFfmpegCodecList(decoderOutput),
  };
  for (const kind of ["encoders", "decoders"]) {
    const available = new Set(detected[kind]);
    const missing = required[kind].filter((codec) => !available.has(codec));
    if (missing.length) fail(`${label} is missing required FFmpeg ${kind}: ${missing.join(", ")}.`);
  }
  return detected;
}

function requireSystemZlib(dependencies, label = "FFmpeg") {
  const zlib = dependencies.find((dependency) => /^\/usr\/lib\/libz(?:\.\d+)?\.dylib$/.test(dependency));
  if (!zlib) fail(`${label} is missing the expected macOS system zlib dependency (libz.1.dylib).`);
  return zlib;
}

async function verifyFfmpegSignature({ archive, signature, key, gpgHome }) {
  await mkdir(gpgHome, { recursive: true, mode: 0o700 });
  const env = { ...process.env, GNUPGHOME: gpgHome };
  const fingerprintOutput = await run("gpg", ["--batch", "--no-options", "--with-colons", "--show-keys", "--fingerprint", key], { capture: true, env });
  let inPrimaryKey = false;
  const primaryFingerprints = [];
  for (const line of fingerprintOutput.split(/\r?\n/)) {
    const fields = line.split(":");
    if (fields[0] === "pub") inPrimaryKey = true;
    else if (fields[0] === "sub") inPrimaryKey = false;
    else if (fields[0] === "fpr" && inPrimaryKey) {
      primaryFingerprints.push(fields[9]);
      inPrimaryKey = false;
    }
  }
  if (!primaryFingerprints.includes(SIGNING_FINGERPRINT)) fail("FFmpeg release primary-key fingerprint did not match the pinned official key.");
  await run("gpg", ["--batch", "--no-options", "--import", key], { env });
  const verification = await run("gpg", ["--batch", "--no-options", "--status-fd", "1", "--verify", signature, archive], { capture: true, env });
  const valid = [...verification.matchAll(/^\[GNUPG:\] VALIDSIG (.+)$/gm)].some((match) => {
    const fields = match[1].trim().split(/\s+/);
    const signingFingerprint = fields[0];
    const primaryFingerprint = fields[9];
    return signingFingerprint === SIGNING_FINGERPRINT || primaryFingerprint === SIGNING_FINGERPRINT;
  });
  if (!valid) fail("FFmpeg release signature did not validate with the pinned official primary signing key.");
}

async function verifyBundle() {
  try {
    await assertDirectory(OUTPUT_PATH, "build output");
    const manifestPath = join(OUTPUT_PATH, "build-manifest.json");
    await assertRegularFile(manifestPath, "build manifest");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const expectedVersions = Object.fromEntries(Object.entries(CONFIG.tools).map(([name, tool]) => [name, tool.version]));
    const expectedHashes = Object.fromEntries(Object.entries(CONFIG.tools).map(([name, tool]) => [name, tool.sha256]));
    for (const [name, actual, expected] of [
      ["source versions", manifest.sourceVersions, expectedVersions],
      ["source hashes", manifest.sourceHashes, expectedHashes],
      ["build target", manifest.target, CONFIG.target],
    ]) if (stableJson(actual) !== stableJson(expected)) verifyFailure(`manifest ${name} do not match pinned config`);
    if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.gifskiCargoLockSha256 !== CONFIG.tools.gifski.cargoLockSha256)
      verifyFailure("manifest schema or Gifski Cargo.lock pin does not match configuration");
    if (stableJson(manifest.requiredCodecs) !== stableJson(CONFIG.requiredCodecs))
      verifyFailure("manifest required codec selections do not match configuration");

    const sourcesDir = join(OUTPUT_PATH, "sources");
    const licensesDir = join(OUTPUT_PATH, "licenses");
    await assertDirectory(sourcesDir, "corresponding-source directory");
    await assertDirectory(licensesDir, "license directory");
    const actualSourceTree = await integrityTree(sourcesDir, "corresponding-source bundle");
    const actualLicenseTree = await integrityTree(licensesDir, "license bundle");
    if (stableJson(actualSourceTree) !== stableJson(manifest.integrityTrees?.sources) ||
      stableJson(actualLicenseTree) !== stableJson(manifest.integrityTrees?.licenses))
      verifyFailure("source or license path set/content differs from the build manifest");
    const signatureProof = manifest.signatureVerification;
    const keyHash = actualSourceTree["archives/ffmpeg-devel.asc"]?.slice("sha256:".length);
    const signatureHash = actualSourceTree[`archives/ffmpeg-${CONFIG.tools.ffmpeg.version}.tar.xz.asc`]?.slice("sha256:".length);
    if (signatureProof?.algorithm !== "OpenPGP" || signatureProof?.verifiedDuringBuild !== true ||
      signatureProof?.primaryKeyFingerprint !== SIGNING_FINGERPRINT ||
      signatureProof?.signingKeySha256 !== keyHash || signatureProof?.signatureSha256 !== signatureHash)
      verifyFailure("FFmpeg signature evidence does not match the bundled verified key and signature");

    const expectedConfigureArgs = Object.fromEntries(["pkgconf", "x264", "libvpx", "opus", "ffmpeg"].map((name) => [name, CONFIG.tools[name].configureArgs]));
    const expectedFfmpegArgs = CONFIG.tools.ffmpeg.configureArgs.map((arg) => replaceTemplate(arg, { stage: "{stage}", pkgConfig: "{pkgConfig}" }));
    if (stableJson(manifest.build?.configureArgs) !== stableJson(expectedConfigureArgs) ||
      stableJson(manifest.build?.ffmpegConfigureArgs) !== stableJson(expectedFfmpegArgs) ||
      stableJson(manifest.build?.gifskiCargoArgs) !== stableJson(CONFIG.tools.gifski.cargoArgs) ||
      stableJson(manifest.build?.gifskiFeatures) !== stableJson(CONFIG.tools.gifski.cargoFeatures))
      verifyFailure("manifest build recipe does not match pinned config");

    const archiveDir = join(sourcesDir, "archives");
    await assertDirectory(archiveDir, "source archive directory");
    for (const [name, archiveName] of Object.entries(sourceArchiveNames())) {
      const archive = join(archiveDir, archiveName);
      await assertRegularFile(archive, `${name} source archive`);
      const actual = await sha256File(archive);
      if (actual !== CONFIG.tools[name].sha256) verifyFailure(`${name} source archive hash mismatch`);
    }
    const signature = join(archiveDir, `ffmpeg-${CONFIG.tools.ffmpeg.version}.tar.xz.asc`);
    const signingKey = join(archiveDir, "ffmpeg-devel.asc");
    await assertRegularFile(signature, "FFmpeg signature");
    await assertRegularFile(signingKey, "FFmpeg signing key");
    const gifskiSource = join(sourcesDir, `gifski-${CONFIG.tools.gifski.version}`);
    await assertDirectory(gifskiSource, "Gifski corresponding source");
    const lockPath = join(gifskiSource, "Cargo.lock");
    await assertRegularFile(lockPath, "Gifski Cargo.lock");
    if (await sha256File(lockPath) !== CONFIG.tools.gifski.cargoLockSha256)
      verifyFailure("Gifski Cargo.lock hash mismatch");
    await assertRegularFile(join(gifskiSource, ".cargo", "config.toml"), "vendored Cargo configuration");
    await assertDirectory(join(gifskiSource, "vendor"), "vendored Gifski crate sources");
    if ((await readdir(join(gifskiSource, "vendor"))).length === 0) verifyFailure("vendored Gifski crate sources are empty");

    const rebuildRoot = join(sourcesDir, "rebuild");
    await assertCurrentRebuildInputs(rebuildRoot);
    const bundledConfig = JSON.parse(await readFile(join(rebuildRoot, "scripts", "macos-tools.json"), "utf8"));
    if (stableJson(bundledConfig) !== stableJson(CONFIG)) verifyFailure("bundled rebuild config differs from pinned config");

    const licenseDir = licensesDir;
    for (const name of [
      "FFmpeg-COPYING.GPLv2", "FFmpeg-COPYING.LGPLv2.1", "x264-COPYING", "libvpx-LICENSE",
      "opus-COPYING", "pkgconf-COPYING", "gifski-LICENSE", "gifski-cargo-crates.json", "THIRD-PARTY-NOTICES.txt",
    ]) await assertRegularFile(join(licenseDir, name), `license or notice ${name}`);

    const binaryDir = join(OUTPUT_PATH, "bin");
    await assertDirectory(binaryDir, "binary directory");
    for (const name of BINARIES) {
      const binary = join(binaryDir, name);
      await assertRegularFile(binary, `${name} binary`);
      if (!/^[a-f0-9]{64}$/.test(manifest.binaryHashes?.[name] ?? "") || await sha256File(binary) !== manifest.binaryHashes[name])
        verifyFailure(`${name} binary hash mismatch`);
      const architecture = await run("xcrun", ["lipo", "-info", binary], { capture: true });
      if (!architecture.includes("arm64")) verifyFailure(`${name} is not an arm64 binary`);
      const dependencies = await verifySystemOnlyDependencies(binary);
      const recorded = manifest.dynamicDependencies?.[name];
      if (!Array.isArray(recorded) || stableJson([...dependencies].sort()) !== stableJson([...recorded].sort()))
        verifyFailure(`${name} system dylib closure differs from the build manifest`);
    }
    const detectedCodecs = await assertRequiredFfmpegCodecs(join(binaryDir, "ffmpeg"), CONFIG.requiredCodecs);
    if (stableJson(detectedCodecs) !== stableJson(manifest.detectedCodecCapabilities))
      verifyFailure("detected FFmpeg codec capabilities differ from the build manifest");
    const zlib = requireSystemZlib(manifest.dynamicDependencies?.ffmpeg ?? []);
    if (manifest.build?.systemLibraries?.zlib !== zlib)
      verifyFailure("FFmpeg system zlib dependency differs from the build manifest");
    console.log(`Verified pinned macOS media-tool bundle at ${OUTPUT_PATH}`);
  } catch (error) {
    if (String(error?.message).includes("Run npm run desktop:tools.")) throw error;
    verifyFailure(error?.message ?? "verification failed");
  }
}

async function assertHost() {
  if (process.platform !== CONFIG.target.platform || process.arch !== CONFIG.target.architecture)
    fail(`This source build is pinned for macOS ${CONFIG.target.architecture}; current host is ${process.platform}/${process.arch}.`);
  const kernel = (await run("uname", ["-r"], { capture: true })).trim();
  const targetKernelMajor = Number(CONFIG.target.libvpxTarget.match(/darwin(\d+)-/)?.[1]);
  if (!Number.isInteger(targetKernelMajor) || Number(kernel.split(".")[0]) !== targetKernelMajor)
    fail(`libvpx ${CONFIG.tools.libvpx.version} is pinned to upstream target ${CONFIG.target.libvpxTarget}; current Darwin kernel is ${kernel}.`);
  await run("xcrun", ["--find", "clang"], { capture: true });
  await run("xcrun", ["--show-sdk-path"], { capture: true });
  await run("make", ["--version"], { capture: true });
  await run("tar", ["--version"], { capture: true });
  await run("gpg", ["--version"], { capture: true });
  await run("cargo", ["--version"], { capture: true });
  await run("rustc", ["--version"], { capture: true });
  await run("xcrun", ["--find", "otool"], { capture: true });
  await run("xcrun", ["--find", "swiftc"], { capture: true });
}

async function build() {
  await assertHost();
  try {
    await stat(OUTPUT_PATH);
    fail(`Build output already exists at ${OUTPUT_PATH}; review it before removing it.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await mkdir(ARCHIVE_CACHE, { recursive: true });
  const work = await mkdtemp(join(PRIVATE_ROOT, ".work-"));
  const sources = {};
  const archives = {};
  const signingKey = join(work, "ffmpeg-devel.asc");
  const signature = join(work, `ffmpeg-${CONFIG.tools.ffmpeg.version}.tar.xz.asc`);
  const gpgHome = join(work, "gnupg");
  const cargoHome = join(work, "cargo-home");
  const stage = join(work, "stage");
  const pkgconfPrefix = join(work, "pkgconf");
  const out = join(work, "dist");
  const compilerPaths = {};
  for (const [key, tool] of [["CC", "clang"], ["CXX", "clang++"], ["AR", "ar"], ["RANLIB", "ranlib"], ["NM", "nm"]])
    compilerPaths[key] = (await run("xcrun", ["--find", tool], { capture: true })).trim();
  const sdkRoot = (await run("xcrun", ["--show-sdk-path"], { capture: true })).trim();
  const sdkVersion = (await run("xcrun", ["--show-sdk-version"], { capture: true })).trim();
  const clangVersion = (await run("xcrun", ["clang", "--version"], { capture: true })).split(/\r?\n/)[0];
  const rustcVersion = (await run("rustc", ["--version"], { capture: true })).trim();
  const cargoVersion = (await run("cargo", ["--version"], { capture: true })).trim();
  const swiftVersion = (await run("xcrun", ["swiftc", "--version"], { capture: true })).split(/\r?\n/)[0];
  const envBase = cleanBuildEnvironment({
    ...compilerPaths,
    CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER: compilerPaths.CC,
    MACOSX_DEPLOYMENT_TARGET: CONFIG.target.minimumMacOS,
    SDKROOT: sdkRoot,
    CARGO_HOME: cargoHome,
    CARGO_BUILD_JOBS: String(JOBS),
    CARGO_TARGET_AARCH64_APPLE_DARWIN_MACOSX_DEPLOYMENT_TARGET: CONFIG.target.minimumMacOS,
  });
  const archiveNames = sourceArchiveNames();

  try {
    await mkdir(stage, { recursive: true });
    for (const name of ["ffmpeg", "x264", "libvpx", "opus", "pkgconf", "gifski"]) {
      const tool = CONFIG.tools[name];
      const archive = join(ARCHIVE_CACHE, archiveNames[name]);
      await downloadVerified(tool.url, archive, tool.sha256);
      archives[name] = archive;
    }
    await downloadUnhashed(CONFIG.tools.ffmpeg.signatureUrl, signature);
    await downloadUnhashed(CONFIG.tools.ffmpeg.signingKeyUrl, signingKey);
    await verifyFfmpegSignature({ archive: archives.ffmpeg, signature, key: signingKey, gpgHome });

    for (const name of Object.keys(archives)) {
      sources[name] = await extractArchive(archives[name], join(work, "src", name));
    }

    const pkgconf = sources.pkgconf;
    const pkgconfArgs = CONFIG.tools.pkgconf.configureArgs.map((arg) => replaceTemplate(arg, { pkgconfPrefix }));
    await buildConfigureProject(pkgconf, pkgconfArgs, envBase);
    const pkgConfig = join(pkgconfPrefix, "bin", "pkgconf");
    const env = {
      ...envBase,
      PKG_CONFIG: pkgConfig,
      PKG_CONFIG_LIBDIR: join(stage, "lib", "pkgconfig"),
      PKG_CONFIG_PATH: "",
    };

    for (const name of ["x264", "libvpx", "opus"]) {
      const tool = CONFIG.tools[name];
      const substitutions = { stage, libvpxTarget: CONFIG.target.libvpxTarget };
      const args = tool.configureArgs.map((arg) => replaceTemplate(arg, substitutions));
      const source = sources[name];
      const configure = name === "libvpx" ? join(source, "configure") : "./configure";
      const configureCwd = name === "libvpx" ? join(work, "build", "libvpx") : source;
      if (name === "libvpx") await mkdir(configureCwd, { recursive: true });
      await run(configure, args, { cwd: configureCwd, env });
      await run("make", ["-j", String(JOBS)], { cwd: configureCwd, env });
      await run("make", ["install"], { cwd: configureCwd, env });
    }

    const ffmpegArgs = CONFIG.tools.ffmpeg.configureArgs.map((arg) => replaceTemplate(arg, { stage, pkgConfig }));
    await buildConfigureProject(sources.ffmpeg, ffmpegArgs, env);

    const gifskiSource = sources.gifski;
    const lockPath = join(gifskiSource, "Cargo.lock");
    const lockHash = await sha256File(lockPath);
    if (lockHash !== CONFIG.tools.gifski.cargoLockSha256)
      fail(`Gifski Cargo.lock hash mismatch: expected ${CONFIG.tools.gifski.cargoLockSha256}, received ${lockHash}.`);
    const vendorConfig = await run("cargo", ["vendor", "--locked", "--versioned-dirs", "vendor"], { cwd: gifskiSource, env: envBase, capture: true });
    await mkdir(join(gifskiSource, ".cargo"), { recursive: true });
    await writeFile(join(gifskiSource, ".cargo", "config.toml"), vendorConfig, { mode: 0o644 });
    const cargoArgs = ["build", ...CONFIG.tools.gifski.cargoArgs];
    await run("cargo", cargoArgs, { cwd: gifskiSource, env: envBase });

    const ffmpegBinary = join(sources.ffmpeg, "ffmpeg");
    const ffprobeBinary = join(sources.ffmpeg, "ffprobe");
    const gifskiBinary = join(gifskiSource, "target", "aarch64-apple-darwin", "release", "gifski");
    const binDir = join(out, "bin");
    const licensesDir = join(out, "licenses");
    const bundledSources = join(out, "sources");
    await mkdir(binDir, { recursive: true });
    await mkdir(licensesDir, { recursive: true });
    await mkdir(join(bundledSources, "archives"), { recursive: true });
    for (const [name, sourceBinary] of [["ffmpeg", ffmpegBinary], ["ffprobe", ffprobeBinary], ["gifski", gifskiBinary]]) {
      const destination = join(binDir, name);
      await copyFile(sourceBinary, destination);
      await chmod(destination, 0o755);
    }
    const voiceHelperArgs = ["swiftc", "-O", "-target", `arm64-apple-macos${CONFIG.target.minimumMacOS}`, "-o", join(binDir, "kino-voice"), VOICE_HELPER_SOURCE];
    await run("xcrun", voiceHelperArgs, { env: envBase });
    await chmod(join(binDir, "kino-voice"), 0o755);
    const voiceHelperVersion = (await run(join(binDir, "kino-voice"), ["--version"], { capture: true })).trim();
    const cutoutHelperArgs = ["swiftc", "-O", "-target", `arm64-apple-macos${CONFIG.target.minimumMacOS}`, "-o", join(binDir, "kino-cutout"), CUTOUT_HELPER_SOURCE];
    await run("xcrun", cutoutHelperArgs, { env: envBase });
    await chmod(join(binDir, "kino-cutout"), 0o755);
    const cutoutHelperVersion = (await run(join(binDir, "kino-cutout"), ["--version"], { capture: true })).trim();
    const measureHelperArgs = ["swiftc", "-O", "-target", `arm64-apple-macos${CONFIG.target.minimumMacOS}`, "-o", join(binDir, "kino-measure"), MEASURE_HELPER_SOURCE];
    await run("xcrun", measureHelperArgs, { env: envBase });
    await chmod(join(binDir, "kino-measure"), 0o755);
    const measureHelperVersion = (await run(join(binDir, "kino-measure"), ["--version"], { capture: true })).trim();
    const detectedCodecCapabilities = await assertRequiredFfmpegCodecs(join(binDir, "ffmpeg"), CONFIG.requiredCodecs);

    const licenseEntries = [
      [join(sources.ffmpeg, "COPYING.GPLv2"), "FFmpeg-COPYING.GPLv2"],
      [join(sources.ffmpeg, "COPYING.LGPLv2.1"), "FFmpeg-COPYING.LGPLv2.1"],
      [join(sources.x264, "COPYING"), "x264-COPYING"],
      [join(sources.libvpx, "LICENSE"), "libvpx-LICENSE"],
      [join(sources.opus, "COPYING"), "opus-COPYING"],
      [join(sources.pkgconf, "COPYING"), "pkgconf-COPYING"],
      [join(sources.gifski, "LICENSE"), "gifski-LICENSE"],
    ];
    for (const [source, name] of licenseEntries) await copyRequiredLicense(source, licensesDir, name);

    for (const archive of Object.values(archives)) await copyFile(archive, join(bundledSources, "archives", basename(archive)));
    await copyFile(signature, join(bundledSources, "archives", basename(signature)));
    await copyFile(signingKey, join(bundledSources, "archives", basename(signingKey)));
    await copyFile(lockPath, join(bundledSources, `gifski-${CONFIG.tools.gifski.version}-Cargo.lock`));
    await cpDirectory(gifskiSource, join(bundledSources, `gifski-${CONFIG.tools.gifski.version}`));
    const rebuildRoot = join(bundledSources, "rebuild");
    await mkdir(join(rebuildRoot, "scripts"), { recursive: true });
    await mkdir(join(rebuildRoot, "docs"), { recursive: true });
    await copyFile(join(SCRIPT_DIR, "build-macos-tools.mjs"), join(rebuildRoot, "scripts", "build-macos-tools.mjs"));
    await copyFile(CONFIG_PATH, join(rebuildRoot, "scripts", "macos-tools.json"));
    await copyFile(join(ROOT, "docs", "bundled-tools.md"), join(rebuildRoot, "docs", "bundled-tools.md"));
    await mkdir(join(rebuildRoot, "backend", "voice"), { recursive: true });
    await copyFile(VOICE_HELPER_SOURCE, join(rebuildRoot, "backend", "voice", "kino-voice.swift"));
    await mkdir(join(rebuildRoot, "backend", "cutout"), { recursive: true });
    await copyFile(CUTOUT_HELPER_SOURCE, join(rebuildRoot, "backend", "cutout", "kino-cutout.swift"));
    await mkdir(join(rebuildRoot, "backend", "measure"), { recursive: true });
    await copyFile(MEASURE_HELPER_SOURCE, join(rebuildRoot, "backend", "measure", "kino-measure.swift"));

    const cargoMetadataText = await run("cargo", ["metadata", "--format-version", "1", "--locked", "--offline"], { cwd: gifskiSource, env: envBase, capture: true });
    const cargoMetadata = JSON.parse(cargoMetadataText);
    const cargoLicenseRows = cargoMetadata.packages.map(({ name, version, license, license_file }) => ({
      name, version, license: license ?? null, licenseFile: license_file ? basename(license_file) : null,
    })).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
    await writeFile(join(licensesDir, "gifski-cargo-crates.json"), `${JSON.stringify(cargoLicenseRows, null, 2)}\n`, { mode: 0o644 });

    const notices = [
      "kino bundled media-tool source and license notices",
      "",
      "FFmpeg 9.0.2: GPL-2.0-or-later build with x264; source archive and official detached signature are in ../sources/archives.",
      "x264 r3222: GPL-2.0-or-later; corresponding source archive is in ../sources/archives.",
      "libvpx 1.17.0: BSD-3-Clause; corresponding source archive is in ../sources/archives.",
      "Opus 1.6.1: BSD-3-Clause; corresponding source archive is in ../sources/archives.",
      "Gifski 1.34.0: AGPL-3.0-or-later; PNG-only build excludes its optional FFmpeg video feature.",
      "pkgconf 2.5.1: build-only dependency; its source archive and license are included for recipe reproducibility.",
      "Gifski Rust crate license metadata is listed in gifski-cargo-crates.json; crate sources and license files are vendored under ../sources.",
      "kino-voice: part of kino (MIT), compiled from ../sources/rebuild/backend/voice/kino-voice.swift; it calls the AUSoundIsolation audio unit that macOS provides and contains no Apple code.",
      "kino-cutout: part of kino (MIT), compiled from ../sources/rebuild/backend/cutout/kino-cutout.swift; it calls the Vision framework that macOS provides and contains no Apple code or model files.",
      "kino-measure: part of kino (MIT), compiled from ../sources/rebuild/backend/measure/kino-measure.swift; it calls the Vision framework that macOS provides and contains no Apple code or model files.",
      "The exact configure arguments, source checksums, toolchain details, and system dylib closure are recorded in ../build-manifest.json.",
      "",
    ].join("\n");
    await writeFile(join(licensesDir, "THIRD-PARTY-NOTICES.txt"), notices, { mode: 0o644 });

    const integrityTrees = {
      sources: await integrityTree(bundledSources, "corresponding-source bundle"),
      licenses: await integrityTree(licensesDir, "license bundle"),
    };
    const signatureVerification = {
      algorithm: "OpenPGP",
      primaryKeyFingerprint: SIGNING_FINGERPRINT,
      signingKeySha256: await sha256File(signingKey),
      signatureSha256: await sha256File(signature),
      verifiedDuringBuild: true,
    };

    const dependencyMap = {};
    for (const name of BINARIES) dependencyMap[name] = await verifySystemOnlyDependencies(join(binDir, name));
    const systemZlib = requireSystemZlib(dependencyMap.ffmpeg);
    const binaryHashes = {};
    for (const name of BINARIES) binaryHashes[name] = await sha256File(join(binDir, name));
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA,
      target: CONFIG.target,
      sourceVersions: Object.fromEntries(Object.entries(CONFIG.tools).map(([name, tool]) => [name, tool.version])),
      sourceHashes: Object.fromEntries(Object.entries(CONFIG.tools).map(([name, tool]) => [name, tool.sha256])),
      gifskiCargoLockSha256: lockHash,
      requiredCodecs: CONFIG.requiredCodecs,
      detectedCodecCapabilities,
      signatureVerification,
      integrityTrees,
      binaryHashes,
      dynamicDependencies: dependencyMap,
      build: {
        jobs: JOBS,
        minimumMacOS: CONFIG.target.minimumMacOS,
        systemLibraries: { zlib: systemZlib },
        macOSSDKVersion: sdkVersion,
        clang: clangVersion,
        compilerTools: Object.fromEntries(Object.entries(compilerPaths).map(([name, path]) => [name, basename(path)])),
        rustc: rustcVersion,
        cargo: cargoVersion,
        swift: swiftVersion,
        voiceHelper: { version: voiceHelperVersion, sourceSha256: await sha256File(VOICE_HELPER_SOURCE), swiftcArgs: voiceHelperArgs.slice(1, 4) },
        cutoutHelper: { version: cutoutHelperVersion, sourceSha256: await sha256File(CUTOUT_HELPER_SOURCE), swiftcArgs: cutoutHelperArgs.slice(1, 4) },
        measureHelper: { version: measureHelperVersion, sourceSha256: await sha256File(MEASURE_HELPER_SOURCE), swiftcArgs: measureHelperArgs.slice(1, 4) },
        configureArgs: Object.fromEntries(["pkgconf", "x264", "libvpx", "opus", "ffmpeg"].map((name) => [name, CONFIG.tools[name].configureArgs])),
        ffmpegConfigureArgs: ffmpegArgs.map((arg) => arg.replaceAll(stage, "{stage}").replaceAll(pkgConfig, "{pkgConfig}")),
        gifskiCargoArgs: CONFIG.tools.gifski.cargoArgs,
        externalLibraries: ["x264 (static)", "libvpx (static)", "Opus (static)"],
        gifskiFeatures: CONFIG.tools.gifski.cargoFeatures,
        patches: [],
      },
    };
    await writeFile(join(out, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

    await mkdir(PRIVATE_ROOT, { recursive: true });
    await rename(out, OUTPUT_PATH);
    console.log(`Built media tools and corresponding source bundle: ${OUTPUT_PATH}`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function cpDirectory(source, destination, rootSource = source) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (source === rootSource && entry.name === "target") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await cpDirectory(from, to, rootSource);
    else if (entry.isFile()) await copyFile(from, to);
    else if (entry.isSymbolicLink()) await symlink(await readlink(from), to);
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printPlan();
} else {
  try {
    if (args.length === 0) printPlan();
    else if (args.length === 1 && args[0] === "--build") await build();
    else if (args.length === 1 && args[0] === "--verify") await verifyBundle();
    else fail("Usage: node scripts/build-macos-tools.mjs [--build|--verify]");
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
