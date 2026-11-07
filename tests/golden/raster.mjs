// Chromium draws effect scenes (blurs, glows, tiled copies) with the GPU on a Mac and with the
// CPU on Linux, where CI has no GPU. The CPU draws blurs a little brighter near edges and
// anti-aliases edges more coarsely, so a few pictures differ by more than the golden tolerance.
// Those frames have a second golden made on Linux in tests/golden/frames-cpu/, and the tests that
// compare a Chromium blur with exact maths allow the CPU's larger error. Measured on 2026-10-19:
// a Mac (Apple M3 Pro) reports GPU raster; Linux under Xvfb reports "Rasterization: Software only".
// KINO_CPU_RASTER=1 or 0 says which one this machine uses, for example on a Linux machine with a GPU.
export const CPU_RASTER = process.env.KINO_CPU_RASTER ? process.env.KINO_CPU_RASTER === "1" : process.platform !== "darwin";
