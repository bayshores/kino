// Which graphics cards this computer has, and how a Chromium raster worker is told to draw on one
// (backend/chromium-raster.mjs starts each worker with what graphicsLaunch answers).
//
// The setting (the dashboard's compute.graphics) is "auto", "processor" or a card's name:
// - "processor": draw without the graphics card, as KINO_RASTER_GPU=off does.
// - "auto" on macOS and Windows: Chromium's switch force_high_performance_gpu, which picks the
//   separate card on a computer with two (an Apple Silicon Mac has one, so nothing changes there).
// - "auto" on WSL 2: Chromium draws on the card only through WSLg's display (:0) with Mesa's d3d12
//   driver (GALLIUM_DRIVER=d3d12), and Mesa picks the card whose name contains
//   MESA_D3D12_DEFAULT_ADAPTER_NAME (else it may pick the graphics built into the processor).
//   Measured on 2026-10-20 with an RTX 4090: a 720-frame 1080x1920 render took 4.7 min this way
//   and 32 min on the processor (Mesa's llvmpipe, which is what xvfb-run or no GALLIUM_DRIVER gives).
//   DISPLAY=:0 is added only when DISPLAY is unset; under another X server (xvfb-run's :99) the
//   d3d12 variables are not added, since they do not help there, and the processor draws.
// - "auto" on other Linux: Chromium's own choice, unchanged.
// - A card's name (chosen on Linux or WSL, where kino can steer it): on WSL Mesa's adapter name; on
//   Linux NVIDIA's PRIME render offload for the NVIDIA driver, or DRI_PRIME for a Mesa driver. A
//   name that is not among the cards found now acts as "auto"; on macOS and Windows it is "auto".
// Variables the person set themselves (DISPLAY too) are never changed, and KINO_RASTER_GPU=off always wins.
//
// Verified on: an Apple M3 Pro Mac (one card), and WSL 2 by hand (docs/running.md). Not verified on
// real hardware: native Windows, Intel Macs with two cards, Linux PRIME (NVIDIA or Mesa).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const WSL_NVIDIA_SMI = "/usr/lib/wsl/lib/nvidia-smi";
export const NVIDIA_EGL_VENDOR = "/usr/share/glvnd/egl_vendor.d/10_nvidia.json";
const WSL_GPU_DEVICE = "/dev/dxg";
const WSLG_DISPLAY_SOCKET = "/tmp/.X11-unix/X0";
const DRM_FOLDER = "/sys/class/drm";
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_NAME_LENGTH = 120;
const MAX_CARDS = 16;
const WINDOWS_CARDS = ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"];

// The variables that steer which card draws (or how many workers do); the person may set any of
// them before starting kino, and then they win over the dashboard.
export const GRAPHICS_VARIABLES = ["KINO_RASTER_GPU", "KINO_RASTER_WORKERS", "GALLIUM_DRIVER", "MESA_D3D12_DEFAULT_ADAPTER_NAME",
  "DRI_PRIME", "__NV_PRIME_RENDER_OFFLOAD", "__GLX_VENDOR_LIBRARY_NAME", "__EGL_VENDOR_LIBRARY_FILENAMES"];
// Of these, the ones kino may set for a worker but never changes when the person set them.
const STEERING = new Set(GRAPHICS_VARIABLES.slice(2));

const PCI_VENDORS = { "0x10de": "NVIDIA", "0x1002": "AMD", "0x1022": "AMD", "0x8086": "Intel", "0x106b": "Apple" };

// The system calls this module makes, so tests can answer them. `run` resolves with a command's
// output or rejects (missing command, failure or COMMAND_TIMEOUT_MS passed).
export const realSystem = {
  run: (command, args) => new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  }),
  readText: (file) => readFileSync(file, "utf8"),
  list: (folder) => readdirSync(folder),
  realpath: (file) => realpathSync(file),
  exists: (file) => existsSync(file),
};

/** "darwin", "win32", "wsl" (Linux inside WSL 2) or "linux". */
export function hostPlatform({ platform = process.platform, env = process.env, system = realSystem } = {}) {
  // "wsl" is never process.platform; tests give it.
  if (platform === "darwin" || platform === "win32" || platform === "wsl") return platform;
  if (env.WSL_DISTRO_NAME) return "wsl";
  try { if (/microsoft/i.test(system.readText("/proc/sys/kernel/osrelease"))) return "wsl"; } catch { /* not WSL */ }
  return "linux";
}

// A card name as shown to people: one line, no control characters, at most MAX_NAME_LENGTH.
function cleanName(value) {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return name.slice(0, MAX_NAME_LENGTH);
}

// The maker of a card from its name: NVIDIA, AMD, Intel, Apple or "" when the name does not say.
export function vendorOf(name) {
  if (/nvidia|geforce|quadro|tesla|rtx/i.test(name)) return "NVIDIA";
  if (/\bamd\b|radeon|\bati\b/i.test(name)) return "AMD";
  if (/intel/i.test(name)) return "Intel";
  if (/apple/i.test(name)) return "Apple";
  return "";
}

// Lines of a command's output, cleaned, without empty ones and Windows' stand-in adapters.
function nameLines(text) {
  return String(text ?? "").split(/\r?\n/).map(cleanName)
    .filter((name) => name && !/^(Microsoft Basic (Render|Display)|Microsoft Remote Display|Remote Desktop)/i.test(name));
}

async function output(system, command, args) {
  try { return await system.run(command, args); }
  catch { return ""; }
}

async function macCards(system) {
  let data;
  try { data = JSON.parse(await output(system, "system_profiler", ["SPDisplaysDataType", "-json"])); }
  catch { return []; }
  const list = Array.isArray(data?.SPDisplaysDataType) ? data.SPDisplaysDataType : [];
  return list.map((entry) => {
    const name = cleanName(entry?.sppci_model ?? entry?._name);
    const vendorText = String(entry?.spdisplays_vendor ?? "").replace(/^sppci_vendor_/, "");
    return { name, vendor: vendorOf(vendorText) || vendorOf(name) || cleanName(vendorText).slice(0, 40) };
  }).filter((card) => card.name);
}

// The PCI address nvidia-smi gives ("00000000:01:00.0") as Linux writes it ("0000:01:00.0").
function shortPci(address) {
  const match = /^([0-9a-f]+):([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])$/i.exec(String(address ?? "").trim());
  return match ? `${match[1].slice(-4).padStart(4, "0")}:${match[2]}`.toLowerCase() : "";
}

// Linux: each /sys/class/drm/cardN that is a PCI device (vendor, device and driver), named by
// nvidia-smi for NVIDIA's driver and by lspci when it is installed.
async function linuxCards(system) {
  const smi = (await output(system, "nvidia-smi", ["--query-gpu=name,pci.bus_id", "--format=csv,noheader"]))
    .split(/\r?\n/).map((line) => line.split(",")).filter((parts) => cleanName(parts[0]))
    .map(([name, bus]) => ({ name: cleanName(name), pci: shortPci(bus) }));
  let entries = [];
  try { entries = system.list(DRM_FOLDER).filter((entry) => /^card\d+$/.test(entry)).sort(); } catch { /* no DRM folder */ }
  const cards = [];
  for (const entry of entries) {
    const device = path.join(DRM_FOLDER, entry, "device");
    let vendorId, deviceId, pci, driver = "";
    try {
      vendorId = system.readText(path.join(device, "vendor")).trim().toLowerCase();
      deviceId = system.readText(path.join(device, "device")).trim().toLowerCase();
      pci = path.basename(system.realpath(device)).toLowerCase();
    } catch { continue; }
    if (!/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/.test(pci) || cards.some((card) => card.pci === pci)) continue;
    try { driver = path.basename(system.realpath(path.join(device, "driver"))); } catch { /* no driver bound */ }
    const vendor = PCI_VENDORS[vendorId] ?? "";
    let name = smi.find((card) => card.pci === pci)?.name;
    if (!name) {
      // lspci -mm -s <address>: 01:00.0 "VGA compatible controller" "NVIDIA Corporation" "AD102 [GeForce RTX 4090]" ...
      const fields = [...(await output(system, "lspci", ["-mm", "-s", pci])).matchAll(/"([^"]*)"/g)].map((match) => match[1]);
      name = fields[2] ? cleanName(`${vendor || fields[1]} ${fields[2]}`) : "";
    }
    cards.push({ name: name || `${vendor || "Unknown"} graphics (${vendorId}:${deviceId})`, vendor, pci, driver });
  }
  // nvidia-smi saw an NVIDIA card that the DRM folder did not show (it has no display driver).
  for (const card of smi) if (!cards.some((known) => known.name === card.name)) cards.push({ name: card.name, vendor: "NVIDIA", pci: card.pci, driver: "nvidia" });
  return cards;
}

// WSL and Windows: the cards Windows lists. WSL's nvidia-smi names an NVIDIA card even when
// Windows interop (powershell.exe) is turned off.
async function windowsCards(system, platform) {
  const names = nameLines(await output(system, "powershell.exe", WINDOWS_CARDS));
  if (platform === "wsl") names.push(...nameLines(await output(system, WSL_NVIDIA_SMI, ["--query-gpu=name", "--format=csv,noheader"])));
  const cards = [];
  for (const name of names) if (!cards.some((card) => card.name.toLowerCase() === name.toLowerCase())) cards.push({ name, vendor: vendorOf(name) });
  return cards;
}

let detected = null;

/**
 * The graphics cards of this computer: { platform, cards: [{ name, vendor }], canChoose,
 * environment }. `canChoose`: a card can be picked by name (Linux and WSL). `environment`: the
 * GRAPHICS_VARIABLES that are set. Detected once for the server's life; `refresh` detects again.
 * A command that is missing, fails or takes over 5 s gives no cards; this never throws.
 */
export async function listGraphics({ refresh = false, platform, env = process.env, system } = {}) {
  const injected = Boolean(system || platform);
  if (!injected && !refresh && detected) return detected;
  const found = (async () => {
    system ??= realSystem;
    platform = hostPlatform({ platform, env, system });
    let cards = [];
    try {
      cards = platform === "darwin" ? await macCards(system)
        : platform === "linux" ? await linuxCards(system)
          : await windowsCards(system, platform);
    } catch { cards = []; }
    cards = cards.slice(0, MAX_CARDS);
    const environment = {};
    for (const name of GRAPHICS_VARIABLES) if (typeof env[name] === "string" && env[name] !== "") environment[name] = env[name].slice(0, 200);
    return { platform, cards, canChoose: (platform === "linux" || platform === "wsl") && cards.length > 0, environment };
  })();
  if (!injected) detected = found;
  return found;
}

/** Whether a graphics setting needs the card list to start a worker (so the export detects them first). */
export function graphicsNeedsCards(setting, platform) {
  return platform === "wsl" || (platform === "linux" && typeof setting === "string" && setting !== "auto" && setting !== "processor");
}

/** The card a name setting means, by its whole name (any case), or null. */
export function namedCard(setting, cards) {
  if (typeof setting !== "string" || setting === "auto" || setting === "processor") return null;
  const wanted = setting.trim().toLowerCase();
  return (cards ?? []).find((card) => String(card?.name ?? "").toLowerCase() === wanted) ?? null;
}

/**
 * What the dashboard says of a card saved by name (render/devices `saved`), or null for "auto" and
 * "processor": `found`, it is among `graphics.cards` (as namedCard matches it), and `used`, renders
 * draw on it. Where a card cannot be chosen (`graphics.canChoose` false: macOS and Windows)
 * graphicsLaunch acts as "auto" for any name, so a card found there is not used.
 */
export function savedGraphics(setting, graphics = {}) {
  if (typeof setting !== "string" || setting === "auto" || setting === "processor") return null;
  const found = namedCard(setting, graphics.cards) !== null;
  return { name: setting, found, used: found && graphics.canChoose === true };
}

// The card "auto" picks on WSL: an NVIDIA card, else a separate AMD card (Radeon "Graphics" alone
// is the one built into the processor), else none (Mesa's own choice).
function highPerformanceCard(cards) {
  const list = (cards ?? []).filter((card) => card?.name);
  const amd = list.filter((card) => (card.vendor || vendorOf(card.name)) === "AMD");
  return list.find((card) => (card.vendor || vendorOf(card.name)) === "NVIDIA")
    ?? amd.find((card) => !/Radeon(\(TM\))? Graphics$|Vega \d+ Graphics/i.test(card.name)) ?? amd[0] ?? null;
}

// Whether a WSL worker draws on WSLg's display, where Mesa's d3d12 driver reaches the card: the
// GPU device and WSLg's X socket are there, and DISPLAY is WSLg's :0 or unset (then kino sets :0).
function onWslgDisplay(env, files) {
  if (!files(WSL_GPU_DEVICE) || !files(WSLG_DISPLAY_SOCKET)) return false;
  return !env.DISPLAY || /^:0(\.0)?$/.test(env.DISPLAY);
}

/**
 * What a raster worker is started with for this graphics setting: `env`, the variables to add to
 * its environment (never one the person set in `env`), and `args`, switches for Electron
 * (desktop/raster-worker.cjs reads --kino-raster-gpu). Pure: `platform` is hostPlatform()'s
 * answer, `cards` listGraphics()'s, and `files(path)` says whether a file exists.
 */
export function graphicsLaunch(setting = "auto", { platform = "linux", env = {}, cards = [], files = realSystem.exists } = {}) {
  const added = {};
  const set = (name, value) => {
    if (STEERING.has(name) && typeof env[name] === "string" && env[name] !== "") return;
    added[name] = value;
  };
  if (env.KINO_RASTER_GPU === "off" || setting === "processor") return { env: added, args: ["--kino-raster-gpu=off"] };
  const card = namedCard(setting, cards);
  if (platform === "darwin" || platform === "win32") return { env: added, args: ["--kino-raster-gpu=high-performance"] };
  if (platform === "wsl") {
    if (!onWslgDisplay(env, files)) return { env: added, args: [] };
    if (!env.DISPLAY) added.DISPLAY = ":0";
    set("GALLIUM_DRIVER", "d3d12");
    const chosen = card ?? highPerformanceCard(cards);
    if (chosen) set("MESA_D3D12_DEFAULT_ADAPTER_NAME", chosen.name);
    return { env: added, args: [] };
  }
  if (!card) return { env: added, args: [] };
  if (card.vendor === "NVIDIA" && (card.driver === "nvidia" || !card.driver)) {
    set("__NV_PRIME_RENDER_OFFLOAD", "1");
    set("__GLX_VENDOR_LIBRARY_NAME", "nvidia");
    if (files(NVIDIA_EGL_VENDOR)) set("__EGL_VENDOR_LIBRARY_FILENAMES", NVIDIA_EGL_VENDOR);
  } else if (/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/.test(card.pci ?? "")) {
    set("DRI_PRIME", `pci-${card.pci.replace(/[:.]/g, "_")}`);
  }
  return { env: added, args: [] };
}

/**
 * What "auto" draws on here, for the dashboard's label: a card's name, "processor" when it draws
 * on none, or null when Chromium or Mesa chooses and kino cannot tell which. It follows
 * graphicsLaunch: on WSL the card it names to Mesa (none under another X server, such as
 * xvfb-run's); on macOS and Windows the card the high-performance switch should pick (an NVIDIA
 * card, else a separate AMD card, else the one card by a known maker); on Linux Chromium's choice.
 */
export function autoGraphics({ platform = "linux", env = {}, cards = [], files = realSystem.exists } = {}) {
  const launch = graphicsLaunch("auto", { platform, env, cards, files });
  if (launch.args.includes("--kino-raster-gpu=off")) return "processor";
  const list = (cards ?? []).filter((card) => card?.name);
  if (platform === "darwin" || platform === "win32") {
    const known = list.filter((card) => ["NVIDIA", "AMD", "Intel", "Apple"].includes(card.vendor || vendorOf(card.name)));
    return (highPerformanceCard(known) ?? (known.length === 1 ? known[0] : null))?.name ?? null;
  }
  if (platform !== "wsl") return null;
  // Without WSLg's display Mesa draws with llvmpipe, whatever GALLIUM_DRIVER says.
  if (!onWslgDisplay(env, files)) return "processor";
  const driver = launch.env.GALLIUM_DRIVER ?? env.GALLIUM_DRIVER;
  if (driver !== "d3d12") return /^(llvmpipe|softpipe|swr)$/i.test(driver) ? "processor" : null;
  // Mesa takes the first card whose name contains the adapter name, in any case.
  const adapter = String(launch.env.MESA_D3D12_DEFAULT_ADAPTER_NAME ?? env.MESA_D3D12_DEFAULT_ADAPTER_NAME ?? "").toLowerCase();
  return (adapter && list.find((card) => card.name.toLowerCase().includes(adapter))?.name) || null;
}

/**
 * What the render cache key takes from the graphics: everything graphicsLaunch decides the drawing
 * device by, since another device changes the pixels and the graphics facts and warning a cached
 * render repeats. That is the setting, KINO_RASTER_GPU, the card variables the person set, and
 * whether the display is WSLg's. Not DISPLAY itself: xvfb-run -a picks :99, :100 and so on for
 * each run, and every one of those draws on the processor alike.
 */
export function graphicsCacheInput(setting = "auto", env = process.env, { files = realSystem.exists } = {}) {
  const variables = ["KINO_RASTER_GPU", ...STEERING].map((name) => (typeof env[name] === "string" ? env[name] : ""));
  return JSON.stringify([typeof setting === "string" ? setting : "auto", ...variables, onWslgDisplay(env, files)]);
}

/** Whether a renderer a worker reported draws on the processor (llvmpipe, SwiftShader, softpipe). */
export function rendererIsProcessor(renderer) {
  return typeof renderer === "string" && /^processor\b|llvmpipe|swiftshader|softpipe/i.test(renderer);
}

/**
 * The machine settings an export is given (exportScene's context.render), checked, with defaults:
 * { graphics: "auto" | "processor" | a card's name, framesAtOnce: 1 to 8 or "auto",
 * keepFreePercent: 5 to 60 }. They come from the dashboard (compute.*), which checks them first.
 */
export function renderSettings(render = {}) {
  if (render == null) render = {};
  if (typeof render !== "object" || Array.isArray(render)) throw new TypeError("The render settings must be an object.");
  const { graphics = "auto", framesAtOnce = 1, keepFreePercent = 20 } = render;
  if (typeof graphics !== "string" || !graphics.trim() || graphics.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(graphics))
    throw new TypeError("The graphics setting must be \"auto\", \"processor\" or a card's name of 1 to 120 characters.");
  if (framesAtOnce !== "auto" && !(Number.isSafeInteger(framesAtOnce) && framesAtOnce >= 1 && framesAtOnce <= 8))
    throw new TypeError("Frames at once must be a whole number from 1 to 8, or \"auto\".");
  if (!(Number.isSafeInteger(keepFreePercent) && keepFreePercent >= 5 && keepFreePercent <= 60))
    throw new TypeError("The memory to leave free must be a whole percent from 5 to 60.");
  return { graphics, framesAtOnce, keepFreePercent };
}

/**
 * What an export says about its drawing, from the renderers its workers reported
 * (chromium-raster.mjs pool.renderers()): `graphics` = { setting, renderer, card, workers }
 * (renderer and card null when no worker said; several renderers joined with " and ", card true
 * only when every one is a card), and `warning` ({ code: "graphics-card-not-used", message }) when
 * the setting was not "processor" but a worker drew on the processor. KINO_RASTER_GPU=off asks for
 * the processor, so it gives no warning. `cards` (listGraphics' cards, optional): when given, the
 * warning comes only if one of them is a card by NVIDIA, AMD, Intel or Apple (a server without a
 * card, or with only a virtual one, has nothing faster to use).
 */
export function graphicsReport({ setting = "auto", renderers = [], workers = 1, env = process.env, cards } = {}) {
  const drawn = renderers.filter((entry) => typeof entry?.renderer === "string" && entry.renderer);
  const renderer = drawn.length ? [...new Set(drawn.map((entry) => entry.renderer))].join(" and ") : null;
  const card = drawn.length ? drawn.every((entry) => entry.card === true) : null;
  const graphics = { setting, renderer, card, workers: Number.isSafeInteger(workers) && workers > 0 ? workers : 1 };
  const onProcessor = drawn.some((entry) => entry.card === false || rendererIsProcessor(entry.renderer));
  const hasCard = !Array.isArray(cards) || cards.some((entry) => ["NVIDIA", "AMD", "Intel", "Apple"].includes(entry?.vendor));
  if (setting === "processor" || env.KINO_RASTER_GPU === "off" || !onProcessor || !hasCard) return { graphics, warning: null };
  return { graphics, warning: { code: "graphics-card-not-used",
    message: `The frames were drawn on the processor (${renderer}), not on a graphics card, so the render took longer. docs/running.md says how to let kino use the graphics card on this computer.` } };
}
