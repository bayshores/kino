// Which card a Chromium raster worker draws on (render-devices.mjs graphicsLaunch), on every
// platform, with the cards and files of each made up here; how the cards are found
// (listGraphics) with every system command answered by a stub; and what the worker reports
// (desktop/raster-worker.cjs describeRenderer). The real paths are not all verified: see the
// module's header.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  NVIDIA_EGL_VENDOR, WSL_NVIDIA_SMI, autoGraphics, graphicsCacheInput, graphicsLaunch, graphicsReport, graphicsNeedsCards, hostPlatform, listGraphics,
  namedCard, renderSettings, rendererIsProcessor, savedGraphics, vendorOf,
} from "./render-devices.mjs";

const require = createRequire(import.meta.url);
const { cleanRenderer, describeRenderer } = require("../desktop/raster-worker.cjs");

const WSL_FILES = new Set(["/dev/dxg", "/tmp/.X11-unix/X0"]);
const has = (set) => (file) => set.has(file);
const WSL_CARDS = [{ name: "Intel(R) UHD Graphics 770", vendor: "Intel" }, { name: "NVIDIA GeForce RTX 4090", vendor: "NVIDIA" }];

test("processor only, or KINO_RASTER_GPU=off, draws without the card on every platform", () => {
  for (const platform of ["darwin", "win32", "linux", "wsl"]) {
    assert.deepEqual(graphicsLaunch("processor", { platform, env: {}, cards: WSL_CARDS, files: has(WSL_FILES) }),
      { env: {}, args: ["--kino-raster-gpu=off"] }, platform);
    assert.deepEqual(graphicsLaunch("auto", { platform, env: { KINO_RASTER_GPU: "off" }, cards: WSL_CARDS, files: has(WSL_FILES) }),
      { env: {}, args: ["--kino-raster-gpu=off"] }, `${platform}: the variable wins over the setting`);
    assert.deepEqual(graphicsLaunch("NVIDIA GeForce RTX 4090", { platform, env: { KINO_RASTER_GPU: "off" }, cards: WSL_CARDS, files: has(WSL_FILES) }).args,
      ["--kino-raster-gpu=off"]);
  }
});

test("auto on macOS and Windows asks Chromium for the high-performance card; a card's name acts as auto there", () => {
  for (const platform of ["darwin", "win32"]) {
    assert.deepEqual(graphicsLaunch("auto", { platform, env: {} }), { env: {}, args: ["--kino-raster-gpu=high-performance"] });
    assert.deepEqual(graphicsLaunch("AMD Radeon Pro 5500M", { platform, env: {}, cards: [{ name: "AMD Radeon Pro 5500M", vendor: "AMD" }] }),
      { env: {}, args: ["--kino-raster-gpu=high-performance"] });
  }
});

test("auto on WSL draws through WSLg with Mesa's d3d12 driver on the NVIDIA card", () => {
  assert.deepEqual(graphicsLaunch("auto", { platform: "wsl", env: {}, cards: WSL_CARDS, files: has(WSL_FILES) }), {
    env: { DISPLAY: ":0", GALLIUM_DRIVER: "d3d12", MESA_D3D12_DEFAULT_ADAPTER_NAME: "NVIDIA GeForce RTX 4090" }, args: [],
  });
  // WSLg's display set by the person is kept as it is (not added again).
  assert.deepEqual(graphicsLaunch("auto", { platform: "wsl", env: { DISPLAY: ":0" }, cards: WSL_CARDS, files: has(WSL_FILES) }), {
    env: { GALLIUM_DRIVER: "d3d12", MESA_D3D12_DEFAULT_ADAPTER_NAME: "NVIDIA GeForce RTX 4090" }, args: [],
  });
  // Without an NVIDIA card, a separate AMD card; the Radeon built into the processor only when it is the one AMD card.
  const amd = [{ name: "AMD Radeon(TM) Graphics", vendor: "AMD" }, { name: "AMD Radeon RX 7900 XTX", vendor: "AMD" }];
  assert.equal(graphicsLaunch("auto", { platform: "wsl", env: {}, cards: amd, files: has(WSL_FILES) }).env.MESA_D3D12_DEFAULT_ADAPTER_NAME, "AMD Radeon RX 7900 XTX");
  assert.equal(graphicsLaunch("auto", { platform: "wsl", env: {}, cards: amd.slice(0, 1), files: has(WSL_FILES) }).env.MESA_D3D12_DEFAULT_ADAPTER_NAME, "AMD Radeon(TM) Graphics");
  // Only Intel graphics: Mesa's own choice.
  assert.deepEqual(graphicsLaunch("auto", { platform: "wsl", env: {}, cards: WSL_CARDS.slice(0, 1), files: has(WSL_FILES) }),
    { env: { DISPLAY: ":0", GALLIUM_DRIVER: "d3d12" }, args: [] });
});

test("WSL without /dev/dxg or WSLg's display changes nothing", () => {
  for (const files of [new Set(["/tmp/.X11-unix/X0"]), new Set(["/dev/dxg"]), new Set()])
    assert.deepEqual(graphicsLaunch("auto", { platform: "wsl", env: {}, cards: WSL_CARDS, files: has(files) }), { env: {}, args: [] });
});

test("on WSL under another X server (xvfb-run's :99) the person's DISPLAY is kept and no d3d12 variable is added, since d3d12 does not help there", () => {
  for (const setting of ["auto", "NVIDIA GeForce RTX 4090"])
    assert.deepEqual(graphicsLaunch(setting, { platform: "wsl", env: { DISPLAY: ":99" }, cards: WSL_CARDS, files: has(WSL_FILES) }), { env: {}, args: [] }, setting);
});

test("a card's name on WSL becomes Mesa's adapter name; a name not found now acts as auto", () => {
  assert.equal(graphicsLaunch("intel(r) uhd graphics 770", { platform: "wsl", env: {}, cards: WSL_CARDS, files: has(WSL_FILES) }).env.MESA_D3D12_DEFAULT_ADAPTER_NAME,
    "Intel(R) UHD Graphics 770");
  assert.equal(graphicsLaunch("NVIDIA GeForce RTX 3080", { platform: "wsl", env: {}, cards: WSL_CARDS, files: has(WSL_FILES) }).env.MESA_D3D12_DEFAULT_ADAPTER_NAME,
    "NVIDIA GeForce RTX 4090");
});

test("variables the person set are never changed", () => {
  const env = { GALLIUM_DRIVER: "llvmpipe", MESA_D3D12_DEFAULT_ADAPTER_NAME: "Intel" };
  assert.deepEqual(graphicsLaunch("auto", { platform: "wsl", env, cards: WSL_CARDS, files: has(WSL_FILES) }), { env: { DISPLAY: ":0" }, args: [] });
  const linux = [{ name: "NVIDIA GeForce RTX 3060 Laptop GPU", vendor: "NVIDIA", pci: "0000:01:00.0", driver: "nvidia" },
    { name: "AMD Radeon 680M", vendor: "AMD", pci: "0000:05:00.0", driver: "amdgpu" }];
  assert.deepEqual(graphicsLaunch(linux[0].name, { platform: "linux", env: { __NV_PRIME_RENDER_OFFLOAD: "0", __GLX_VENDOR_LIBRARY_NAME: "mesa" }, cards: linux, files: () => false }),
    { env: {}, args: [] });
  assert.deepEqual(graphicsLaunch(linux[1].name, { platform: "linux", env: { DRI_PRIME: "1" }, cards: linux, files: () => false }), { env: {}, args: [] });
});

test("a card's name on Linux: PRIME render offload for NVIDIA's driver, DRI_PRIME for a Mesa driver", () => {
  const cards = [
    { name: "Intel Alder Lake-P GT2 [Iris Xe Graphics]", vendor: "Intel", pci: "0000:00:02.0", driver: "i915" },
    { name: "NVIDIA GeForce RTX 3060 Laptop GPU", vendor: "NVIDIA", pci: "0000:01:00.0", driver: "nvidia" },
    { name: "NVIDIA TU117M", vendor: "NVIDIA", pci: "0000:02:00.0", driver: "nouveau" },
  ];
  assert.deepEqual(graphicsLaunch(cards[1].name, { platform: "linux", env: {}, cards, files: has(new Set([NVIDIA_EGL_VENDOR])) }), {
    env: { __NV_PRIME_RENDER_OFFLOAD: "1", __GLX_VENDOR_LIBRARY_NAME: "nvidia", __EGL_VENDOR_LIBRARY_FILENAMES: NVIDIA_EGL_VENDOR }, args: [],
  });
  assert.deepEqual(graphicsLaunch(cards[1].name, { platform: "linux", env: {}, cards, files: () => false }).env,
    { __NV_PRIME_RENDER_OFFLOAD: "1", __GLX_VENDOR_LIBRARY_NAME: "nvidia" }, "the EGL file only when it is there");
  assert.deepEqual(graphicsLaunch(cards[2].name, { platform: "linux", env: {}, cards, files: () => false }).env, { DRI_PRIME: "pci-0000_02_00_0" });
  assert.deepEqual(graphicsLaunch(cards[0].name, { platform: "linux", env: {}, cards, files: () => false }).env, { DRI_PRIME: "pci-0000_00_02_0" });
  // Auto, and a name not found, leave Chromium's own choice.
  assert.deepEqual(graphicsLaunch("auto", { platform: "linux", env: {}, cards, files: () => true }), { env: {}, args: [] });
  assert.deepEqual(graphicsLaunch("Some Old Card", { platform: "linux", env: {}, cards, files: () => true }), { env: {}, args: [] });
});

test("the dashboard's Auto names what auto draws on: the card, the processor, or nothing when Chromium or Mesa chooses", () => {
  // This PC's Windows list starts with two virtual displays.
  const pc = [{ name: "USB Mobile Monitor Virtual Display", vendor: "" }, { name: "Parsec Virtual Display Adapter", vendor: "" }, ...WSL_CARDS];
  assert.equal(autoGraphics({ platform: "wsl", env: {}, cards: pc, files: has(WSL_FILES) }), "NVIDIA GeForce RTX 4090");
  assert.equal(autoGraphics({ platform: "wsl", env: { DISPLAY: ":0" }, cards: pc, files: has(WSL_FILES) }), "NVIDIA GeForce RTX 4090");
  assert.equal(autoGraphics({ platform: "wsl", env: { DISPLAY: ":99" }, cards: pc, files: has(WSL_FILES) }), "processor", "under xvfb-run");
  assert.equal(autoGraphics({ platform: "wsl", env: {}, cards: pc, files: has(new Set(["/dev/dxg"])) }), "processor", "without WSLg");
  assert.equal(autoGraphics({ platform: "wsl", env: { KINO_RASTER_GPU: "off" }, cards: pc, files: has(WSL_FILES) }), "processor");
  assert.equal(autoGraphics({ platform: "wsl", env: { GALLIUM_DRIVER: "llvmpipe" }, cards: pc, files: has(WSL_FILES) }), "processor");
  // The person's adapter name: the first card whose name contains it, in any case.
  assert.equal(autoGraphics({ platform: "wsl", env: { MESA_D3D12_DEFAULT_ADAPTER_NAME: "intel" }, cards: pc, files: has(WSL_FILES) }), "Intel(R) UHD Graphics 770");
  // Only virtual displays and Intel graphics: Mesa chooses, and kino does not claim which.
  assert.equal(autoGraphics({ platform: "wsl", env: {}, cards: pc.slice(0, 3), files: has(WSL_FILES) }), null);
  assert.equal(autoGraphics({ platform: "wsl", env: {}, cards: pc.slice(0, 2), files: has(WSL_FILES) }), null);
  // Native Windows and macOS: the faster card, never a virtual display.
  assert.equal(autoGraphics({ platform: "win32", env: {}, cards: pc }), "NVIDIA GeForce RTX 4090");
  assert.equal(autoGraphics({ platform: "win32", env: {}, cards: pc.slice(0, 3) }), "Intel(R) UHD Graphics 770", "the one card by a known maker");
  assert.equal(autoGraphics({ platform: "win32", env: {}, cards: pc.slice(0, 2) }), null);
  assert.equal(autoGraphics({ platform: "darwin", env: {}, cards: [{ name: "Apple M3 Pro", vendor: "Apple" }] }), "Apple M3 Pro");
  assert.equal(autoGraphics({ platform: "darwin", env: {}, cards: [{ name: "Intel UHD Graphics 630", vendor: "Intel" }, { name: "AMD Radeon Pro 5500M", vendor: "AMD" }] }),
    "AMD Radeon Pro 5500M");
  assert.equal(autoGraphics({ platform: "darwin", env: {}, cards: [] }), null);
  // Plain Linux: Chromium's own choice.
  assert.equal(autoGraphics({ platform: "linux", env: {}, cards: [{ name: "NVIDIA GeForce RTX 3060", vendor: "NVIDIA" }] }), null);
});

test("a card's name matches in any case, as renders match it", () => {
  assert.equal(namedCard("nvidia geforce rtx 4090", WSL_CARDS)?.name, "NVIDIA GeForce RTX 4090");
  assert.equal(namedCard(" NVIDIA GeForce RTX 4090 ", WSL_CARDS)?.name, "NVIDIA GeForce RTX 4090");
  assert.equal(namedCard("NVIDIA GeForce RTX 3080", WSL_CARDS), null);
  assert.equal(namedCard("auto", WSL_CARDS), null);
});

test("the cards are needed to start a worker only on WSL, and for a card's name on Linux", () => {
  assert.equal(graphicsNeedsCards("auto", "wsl"), true);
  assert.equal(graphicsNeedsCards("auto", "linux"), false);
  assert.equal(graphicsNeedsCards("processor", "linux"), false);
  assert.equal(graphicsNeedsCards("NVIDIA GeForce RTX 3060", "linux"), true);
  assert.equal(graphicsNeedsCards("NVIDIA GeForce RTX 3060", "darwin"), false);
  assert.equal(graphicsNeedsCards("auto", "win32"), false);
});

test("WSL is Linux whose kernel says microsoft, or that has WSL_DISTRO_NAME", () => {
  const kernel = (text) => ({ readText: () => text });
  assert.equal(hostPlatform({ platform: "linux", env: {}, system: kernel("5.15.167.4-microsoft-standard-WSL2\n") }), "wsl");
  assert.equal(hostPlatform({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, system: kernel("6.8.0") }), "wsl");
  assert.equal(hostPlatform({ platform: "linux", env: {}, system: kernel("6.8.0-45-generic") }), "linux");
  assert.equal(hostPlatform({ platform: "linux", env: {}, system: { readText() { throw new Error("no /proc"); } } }), "linux");
  assert.equal(hostPlatform({ platform: "darwin", env: { WSL_DISTRO_NAME: "x" } }), "darwin");
  assert.equal(hostPlatform({ platform: "win32", env: {} }), "win32");
});

// A system whose commands answer from `outputs` ({ "command args": text, or an Error to fail })
// and whose files come from `files` ({ path: text }) and `links` ({ path: target }).
function stubSystem({ outputs = {}, files = {}, links = {}, folders = {} } = {}) {
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      const answer = outputs[key];
      if (answer === undefined) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    readText: (file) => { if (!(file in files)) throw new Error(`ENOENT ${file}`); return files[file]; },
    list: (folder) => { if (!(folder in folders)) throw new Error(`ENOENT ${folder}`); return folders[folder]; },
    realpath: (file) => { if (!(file in links)) throw new Error(`ENOENT ${file}`); return links[file]; },
    exists: (file) => file in files,
  };
}

test("on a Mac the cards come from system_profiler", async () => {
  const system = stubSystem({ outputs: { "system_profiler SPDisplaysDataType -json": JSON.stringify({ SPDisplaysDataType: [
    { _name: "Apple M3 Pro", sppci_model: "Apple M3 Pro", spdisplays_vendor: "sppci_vendor_Apple" },
    { _name: "AMD Radeon Pro 5500M", sppci_model: "AMD Radeon Pro 5500M", spdisplays_vendor: "AMD (0x1002)" },
  ] }) } });
  assert.deepEqual(await listGraphics({ platform: "darwin", env: { KINO_RASTER_WORKERS: "2", HOME: "/x" }, system }), {
    platform: "darwin",
    cards: [{ name: "Apple M3 Pro", vendor: "Apple" }, { name: "AMD Radeon Pro 5500M", vendor: "AMD" }],
    canChoose: false,
    environment: { KINO_RASTER_WORKERS: "2" },
  });
});

test("on Linux the cards come from the DRM folder, named by nvidia-smi and lspci", async () => {
  const drm = "/sys/class/drm";
  const system = stubSystem({
    outputs: {
      "nvidia-smi --query-gpu=name,pci.bus_id --format=csv,noheader": "NVIDIA GeForce RTX 3060 Laptop GPU, 00000000:01:00.0\n",
      "lspci -mm -s 0000:00:02.0": '00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake-P GT2 [Iris Xe Graphics]" -r0c "Lenovo" "Device 3b1a"\n',
    },
    folders: { [drm]: ["card1", "card0", "card0-eDP-1", "renderD128", "version"] },
    files: {
      [`${drm}/card0/device/vendor`]: "0x8086\n", [`${drm}/card0/device/device`]: "0x46a6\n",
      [`${drm}/card1/device/vendor`]: "0x10de\n", [`${drm}/card1/device/device`]: "0x2520\n",
    },
    links: {
      [`${drm}/card0/device`]: "/sys/devices/pci0000:00/0000:00:02.0", [`${drm}/card0/device/driver`]: "/sys/bus/pci/drivers/i915",
      [`${drm}/card1/device`]: "/sys/devices/pci0000:00/0000:00:01.0/0000:01:00.0", [`${drm}/card1/device/driver`]: "/sys/bus/pci/drivers/nvidia",
    },
  });
  const found = await listGraphics({ platform: "linux", env: { DRI_PRIME: "1" }, system });
  assert.deepEqual(found, {
    platform: "linux",
    cards: [
      { name: "Intel Alder Lake-P GT2 [Iris Xe Graphics]", vendor: "Intel", pci: "0000:00:02.0", driver: "i915" },
      { name: "NVIDIA GeForce RTX 3060 Laptop GPU", vendor: "NVIDIA", pci: "0000:01:00.0", driver: "nvidia" },
    ],
    canChoose: true,
    environment: { DRI_PRIME: "1" },
  });
});

test("on WSL the cards come from Windows and WSL's nvidia-smi, each once", async () => {
  const system = stubSystem({ outputs: {
    "powershell.exe -NoProfile -Command Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name":
      "Intel(R) UHD Graphics 770\r\nNVIDIA GeForce RTX 4090\r\nMicrosoft Basic Display Adapter\r\n\r\n",
    [`${WSL_NVIDIA_SMI} --query-gpu=name --format=csv,noheader`]: "NVIDIA GeForce RTX 4090\n",
  } });
  const found = await listGraphics({ platform: "wsl", env: {}, system });
  assert.deepEqual(found.cards, WSL_CARDS);
  assert.equal(found.canChoose, true);
  // Interop off: powershell.exe is not there, nvidia-smi still names the NVIDIA card.
  const noInterop = stubSystem({ outputs: { [`${WSL_NVIDIA_SMI} --query-gpu=name --format=csv,noheader`]: "NVIDIA GeForce RTX 4090\n" } });
  assert.deepEqual((await listGraphics({ platform: "wsl", env: {}, system: noInterop })).cards, [{ name: "NVIDIA GeForce RTX 4090", vendor: "NVIDIA" }]);
});

test("missing commands, failures, timeouts and nonsense give no cards, never an error", async () => {
  const timedOut = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
  for (const [platform, outputs] of [
    ["darwin", {}],
    ["darwin", { "system_profiler SPDisplaysDataType -json": "not json" }],
    ["darwin", { "system_profiler SPDisplaysDataType -json": timedOut }],
    ["win32", { "powershell.exe -NoProfile -Command Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name": timedOut }],
    ["wsl", {}],
    ["linux", { "nvidia-smi --query-gpu=name,pci.bus_id --format=csv,noheader": new Error("NVIDIA-SMI has failed") }],
  ]) {
    const found = await listGraphics({ platform, env: {}, system: stubSystem({ outputs }) });
    assert.deepEqual(found.cards, [], `${platform} ${JSON.stringify(Object.keys(outputs))}`);
    assert.equal(found.canChoose, false);
  }
  // A system whose every call throws at once.
  const broken = { run() { throw new Error("boom"); }, readText() { throw new Error("boom"); }, list() { throw new Error("boom"); }, realpath() { throw new Error("boom"); } };
  assert.deepEqual((await listGraphics({ platform: "linux", env: {}, system: broken })).cards, []);
});

test("the real computer's cards are detected once and again on refresh, without an error", async () => {
  const first = await listGraphics();
  assert.ok(["darwin", "linux", "wsl", "win32"].includes(first.platform));
  assert.ok(Array.isArray(first.cards));
  assert.equal(await listGraphics(), await listGraphics(), "kept for the server's life");
  const again = await listGraphics({ refresh: true });
  assert.deepEqual(again.cards, first.cards);
});

test("a card's maker comes from its name", () => {
  assert.equal(vendorOf("NVIDIA GeForce RTX 4090"), "NVIDIA");
  assert.equal(vendorOf("AMD Radeon RX 7900 XTX"), "AMD");
  assert.equal(vendorOf("Intel(R) Arc(TM) A770 Graphics"), "Intel");
  assert.equal(vendorOf("Apple M3 Pro"), "Apple");
  assert.equal(vendorOf("Virtual Display"), "");
});

test("the machine settings are checked, with defaults", () => {
  assert.deepEqual(renderSettings(), { graphics: "auto", framesAtOnce: 1, keepFreePercent: 20 });
  assert.deepEqual(renderSettings(null), { graphics: "auto", framesAtOnce: 1, keepFreePercent: 20 });
  assert.deepEqual(renderSettings({ graphics: "NVIDIA GeForce RTX 4090", framesAtOnce: "auto", keepFreePercent: 35 }),
    { graphics: "NVIDIA GeForce RTX 4090", framesAtOnce: "auto", keepFreePercent: 35 });
  for (const render of [{ graphics: "" }, { graphics: "x".repeat(121) }, { graphics: "a\nb" }, { graphics: 3 }, { framesAtOnce: 0 },
    { framesAtOnce: 9 }, { framesAtOnce: 2.5 }, { framesAtOnce: "4" }, { keepFreePercent: 4 }, { keepFreePercent: 61 }, { keepFreePercent: 20.5 }, []])
    assert.throws(() => renderSettings(render), TypeError, JSON.stringify(render));
});

test("the render cache key takes the graphics setting, KINO_RASTER_GPU, the card variables and WSLg's display", () => {
  assert.notEqual(graphicsCacheInput("auto", {}), graphicsCacheInput("processor", {}));
  assert.notEqual(graphicsCacheInput("auto", {}), graphicsCacheInput("auto", { KINO_RASTER_GPU: "off" }));
  assert.equal(graphicsCacheInput(undefined, {}), graphicsCacheInput("auto", {}));
  // Each variable a person may set to point kino at another device gives another key.
  const wsl = { files: has(WSL_FILES) };
  const base = graphicsCacheInput("auto", { DISPLAY: ":0" }, wsl);
  for (const [name, value] of [["GALLIUM_DRIVER", "llvmpipe"], ["MESA_D3D12_DEFAULT_ADAPTER_NAME", "Intel"], ["DRI_PRIME", "1"],
    ["__NV_PRIME_RENDER_OFFLOAD", "1"], ["__GLX_VENDOR_LIBRARY_NAME", "nvidia"], ["__EGL_VENDOR_LIBRARY_FILENAMES", NVIDIA_EGL_VENDOR]]) {
    const changed = graphicsCacheInput("auto", { DISPLAY: ":0", [name]: value }, wsl);
    assert.notEqual(changed, base, name);
    assert.notEqual(graphicsCacheInput("auto", { DISPLAY: ":0", [name]: `${value}x` }, wsl), changed, `${name}: its value counts`);
  }
  // WSLg's display (:0, or DISPLAY unset, when kino adds :0) draws on the card; another X server does not.
  assert.equal(graphicsCacheInput("auto", {}, wsl), base);
  assert.equal(graphicsCacheInput("auto", { DISPLAY: ":0.0" }, wsl), base);
  const xvfb = graphicsCacheInput("auto", { DISPLAY: ":99" }, wsl);
  assert.notEqual(xvfb, base, "xvfb-run's display is not WSLg's");
  // xvfb-run -a picks another number each run: the key stays the same, so the cache still works.
  assert.equal(graphicsCacheInput("auto", { DISPLAY: ":100" }, wsl), xvfb);
  assert.equal(graphicsCacheInput("auto", { DISPLAY: ":99" }, wsl), xvfb);
  // Without WSLg's GPU device and socket (macOS, Windows, Linux) no display is WSLg's.
  assert.equal(graphicsCacheInput("auto", { DISPLAY: ":0" }, { files: has(new Set()) }), graphicsCacheInput("auto", { DISPLAY: ":99" }, { files: has(new Set()) }));
  // A variable kino does not draw by (KINO_RASTER_WORKERS, PATH) leaves the key alone.
  assert.equal(graphicsCacheInput("auto", { DISPLAY: ":0", KINO_RASTER_WORKERS: "4", PATH: "/bin" }, wsl), base);
});

test("a card saved by name is used only where cards can be chosen and it is found", () => {
  assert.equal(savedGraphics("auto", { cards: WSL_CARDS, canChoose: true }), null);
  assert.equal(savedGraphics("processor", { cards: WSL_CARDS, canChoose: true }), null);
  assert.deepEqual(savedGraphics("nvidia geforce rtx 4090", { cards: WSL_CARDS, canChoose: true }),
    { name: "nvidia geforce rtx 4090", found: true, used: true });
  assert.deepEqual(savedGraphics("NVIDIA GeForce RTX 3080", { cards: WSL_CARDS, canChoose: true }),
    { name: "NVIDIA GeForce RTX 3080", found: false, used: false });
  // macOS and Windows: the card is there, but renders act as "auto" for any name (graphicsLaunch).
  const mac = [{ name: "AMD Radeon Pro 5500M", vendor: "AMD" }, { name: "Intel UHD Graphics 630", vendor: "Intel" }];
  for (const platform of ["darwin", "win32"]) {
    assert.deepEqual(savedGraphics("AMD Radeon Pro 5500M", { platform, cards: mac, canChoose: false }),
      { name: "AMD Radeon Pro 5500M", found: true, used: false }, platform);
    assert.deepEqual(graphicsLaunch("AMD Radeon Pro 5500M", { platform, cards: mac }), graphicsLaunch("auto", { platform, cards: mac }), platform);
  }
});

test("the worker names its renderer, and says processor when Chromium draws without a card", () => {
  assert.equal(cleanRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)"), "Apple M3 Pro (Metal)");
  assert.equal(cleanRenderer("ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 4090), OpenGL 4.6)"), "D3D12 (NVIDIA GeForce RTX 4090)");
  assert.equal(cleanRenderer("ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)"), "llvmpipe (LLVM 15.0.7, 256 bits)");
  assert.equal(cleanRenderer("Mesa Intel(R) UHD Graphics 630\n(CFL GT2)"), "Mesa Intel(R) UHD Graphics 630 (CFL GT2)");
  const metal = { auxAttributes: { glRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)" }, gpuDevice: [{ active: true, vendorId: 4203 }] };
  assert.deepEqual(describeRenderer(metal, { gpu_compositing: "enabled", rasterization: "enabled" }), { renderer: "Apple M3 Pro (Metal)", card: true });
  assert.deepEqual(describeRenderer({ gpuDevice: [{ active: false, deviceString: "Intel UHD" }, { active: true, deviceString: "NVIDIA RTX A2000" }] }, {}),
    { renderer: "NVIDIA RTX A2000", card: true }, "the active device when there is no GL renderer");
  assert.deepEqual(describeRenderer({ auxAttributes: { glRenderer: "ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)" } }, { gpu_compositing: "enabled" }),
    { renderer: "processor (software: llvmpipe (LLVM 15.0.7, 256 bits))", card: false });
  assert.deepEqual(describeRenderer(metal, { gpu_compositing: "disabled_software", rasterization: "disabled_software" }),
    { renderer: "processor (software: Apple M3 Pro (Metal))", card: false });
  assert.deepEqual(describeRenderer(null, null, true), { renderer: "processor (software)", card: false });
  assert.deepEqual(describeRenderer(null, null), { renderer: null, card: null }, "nothing known: nothing claimed");
  assert.equal(rendererIsProcessor("processor (software)"), true);
  assert.equal(rendererIsProcessor("Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE))"), true);
  assert.equal(rendererIsProcessor("Apple M3 Pro (Metal)"), false);
  assert.equal(rendererIsProcessor(null), false);
});

test("an export reports what drew it, and warns when the card was asked for but the processor drew", () => {
  const metal = { renderer: "Apple M3 Pro (Metal)", card: true };
  const software = { renderer: "processor (software: llvmpipe (LLVM 15.0.7, 256 bits))", card: false };
  assert.deepEqual(graphicsReport({ setting: "auto", renderers: [metal], workers: 1, env: {} }),
    { graphics: { setting: "auto", renderer: "Apple M3 Pro (Metal)", card: true, workers: 1 }, warning: null });
  const slow = graphicsReport({ setting: "auto", renderers: [software], workers: 2, env: {} });
  assert.deepEqual(slow.graphics, { setting: "auto", renderer: software.renderer, card: false, workers: 2 });
  assert.equal(slow.warning.code, "graphics-card-not-used");
  assert.match(slow.warning.message, /llvmpipe.*docs\/running\.md/);
  assert.equal(graphicsReport({ setting: "NVIDIA GeForce RTX 4090", renderers: [software], env: {} }).warning.code, "graphics-card-not-used");
  assert.equal(graphicsReport({ setting: "processor", renderers: [software], env: {} }).warning, null, "asked for the processor");
  assert.equal(graphicsReport({ setting: "auto", renderers: [software], env: { KINO_RASTER_GPU: "off" } }).warning, null, "the variable asked for it");
  assert.deepEqual(graphicsReport({ setting: "auto", renderers: [{ renderer: null, card: null }], env: {} }),
    { graphics: { setting: "auto", renderer: null, card: null, workers: 1 }, warning: null }, "a worker that did not say claims nothing");
  const mixed = graphicsReport({ setting: "auto", renderers: [metal, software, metal], workers: 3, env: {} });
  assert.equal(mixed.graphics.renderer, `Apple M3 Pro (Metal) and ${software.renderer}`);
  assert.equal(mixed.graphics.card, false);
  assert.equal(mixed.warning.code, "graphics-card-not-used");
  // A computer without a card (a CI server, or only a virtual adapter) has nothing faster to use.
  assert.equal(graphicsReport({ setting: "auto", renderers: [software], env: {}, cards: [] }).warning, null);
  assert.equal(graphicsReport({ setting: "auto", renderers: [software], env: {}, cards: [{ name: "Unknown graphics (0x1414:0x5353)", vendor: "" }] }).warning, null);
  assert.equal(graphicsReport({ setting: "auto", renderers: [software], env: {}, cards: [{ name: "NVIDIA GeForce RTX 4090", vendor: "NVIDIA" }] }).warning.code,
    "graphics-card-not-used");
});
