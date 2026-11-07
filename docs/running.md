# Running kino

How to run kino from source, where it keeps your files, and how rendering and the Mac app
behave. The short version is in the [README](../README.md#quick-start).

## Run locally

Requires Node.js 22 or newer, and FFmpeg (5.1 or newer) and Gifski on your PATH
(`brew install ffmpeg gifski` on macOS). Install the full npm dependency set, including
Electron: effect and backdrop exports use its Chromium renderer even when kino runs in a browser.

```sh
npm install
npm run desktop          # the Mac app
npm run dev              # or the browser path: http://127.0.0.1:4173 (server on 127.0.0.1:4781)
npm run build && npm start   # or a production build at http://127.0.0.1:4781
```

The server binds to loopback by default and needs no account. Optional settings are in
`.env.example` (development loads `.env` when present).

**Where files live**

| | Browser path | Mac app (`~/Library/Application Support/kino/`) |
|---|---|---|
| Projects and media | `.local/data` | `data` |
| Agent exports | `.local/exports` | `exports` |
| App settings | | `settings` |

Back up the whole data folder (and `settings` for the Mac app) to keep documents with their
media. The two stores are separate; moving projects between them is not automatic yet.

## Rendering

Exports with effects or backdrops are drawn by Electron's Chromium, one frame at a time by
default.

- **`KINO_RASTER_WORKERS`** (2 to 8) lets a movie export draw that many frames at once. kino
  starts the smallest of: that number; half the processor cores; as many as the free memory
  holds (1.6 GB each up to 1080x1920 pixels, 0.8 GB more for each further 1080x1920, keeping a
  fifth of memory free); and one per 30 frames. Running exports count against these limits.
  Several workers are not the default because their frames can differ from one worker's by a
  level or so on a few pixels (measured on a test scene full of group effects).
- **`KINO_RASTER_GPU=off`** draws without the graphics processor, as a computer without one
  does. Its pixels differ from the graphics processor's, and it is slower (4 times on that test
  scene).
- A frame may take 45 seconds per 1920x1080 pixels (180 s at 4K). When a worker crashes or a
  frame runs out of time, kino starts a new worker and draws the frame once more, with a
  `chromium-worker-stopped` warning; a second failure ends the export with the reason.

**Graphics card on Windows (WSL 2 Ubuntu).** Start the server without `xvfb-run` (WSLg gives a
display) and tell Mesa to draw on the card:

```sh
DISPLAY=:0 GALLIUM_DRIVER=d3d12 MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA npm start
```

The name is part of the card's name (`AMD` for an AMD card). Under `xvfb-run`, or without
`GALLIUM_DRIVER`, Chromium draws on the processor (Mesa's llvmpipe); without the adapter name,
Mesa may pick the graphics built into the processor. Measured on 2026-10-20 (i9-13900K, RTX 4090,
Mesa 25.2.8): a vertical final render (720 frames at 1080x1920) took 4.7 minutes on the card and
32 minutes on the processor.

## Render settings

The dashboard's settings screen sets how this computer renders, so most people need none of the
variables above. A variable set when the server starts still wins: the dashboard then disables
that control and names the variable. The settings reach every render (agent renders, export
queues, single exports, the dashboard's stage frames and `check`'s frame tests).

- **graphics card:** Auto, Processor only, or (on Linux and WSL) a card by name.
  - macOS: Auto asks Chromium for the faster card. Measured on an Apple M3 Pro. Unverified on
    Intel Macs with two cards.
  - WSL 2: when `/dev/dxg` and WSLg's display are there and `DISPLAY` is `:0` or unset, Auto sets
    the variables above for each worker (the NVIDIA card's name from
    `/usr/lib/wsl/lib/nvidia-smi`, else an AMD card's). Under another X server, such as
    `xvfb-run`'s, nothing is added and the processor draws. Unverified on the PC after this
    change: the manual variables above were what was measured.
  - Linux: Auto keeps Chromium's choice; a named NVIDIA card gets the PRIME offload variables, a
    Mesa card `DRI_PRIME`. Unverified on real hardware (tested with stubs only).
  - Native Windows: Auto as on macOS. kino has no Windows package; unverified.
  - Variables you set yourself are never replaced. A render that drew on the processor although
    the setting asked for a card warns `graphics-card-not-used`.
- **frames at once:** 1 (default) to 8, or Auto. `KINO_RASTER_WORKERS` wins.
- **memory to leave free:** 5 to 60% (default 20).
- **video encoder** (MP4): Auto tries the hardware encoders this computer has (VideoToolbox on
  macOS; NVENC, AMF or Quick Sync on Windows; NVENC, VA-API or Quick Sync on Linux) and uses the
  first whose test encode works, else libx264. A named encoder that does not work here stops MP4
  renders with an error that lists the ones that do; one that cannot encode a file's size or
  frame rate falls back to libx264 for that file and says why. VideoToolbox and libx264 were
  measured on a Mac, NVENC on an RTX 4090 in WSL 2; Quick Sync, AMF and VA-API are unverified
  (tested with stubs only).
- **video quality** (MP4): Standard (24 Mbps at 720p and up, 12 below), High (twice that),
  Smaller file (half).
- **render cache:** 64 MB to 64 GB (default 512 MB), with a button that empties it.

## The Mac app

`npm run desktop` builds and opens the Electron window, which starts its own server on a free
loopback port. The window is sandboxed with no Node access and uses an automatic local session.

- **Closing and quitting** happen at once: every change is an agent operation the server has
  already saved. A note you are typing is kept in the window until you send it. A window that
  does not answer within 15 seconds gets a **kino is not answering** dialog (go ahead anyway, or
  wait).
- **Recovery.** The dashboard's status line shows live, reconnecting or reconnected, and replays
  missed events. The app restarts its server after an unexpected exit, up to three times in two
  minutes; then a dialog offers **Restart local service**, also under **View**. These dialogs have
  unit tests but have not been checked by hand in the packaged app.
- **Concurrent saves** (for example from two agents) merge by scene, layer and animation ID; the
  later save wins competing values, and deleting wins over editing. **Edit → Undo** outside a text
  field asks to revert the agent's last turn.
- **Agents.** The settings screen (pane **1 agents**) shows `kino setup` and an MCP
  configuration to copy. The app's MCP runner finds the running app through a private connection
  file, so agents need no kino login or separate Node install.

## Packaging

On a macOS 26 arm64 host, run `npm run desktop:tools` once to build the pinned FFmpeg, ffprobe,
Gifski, kino-voice and kino-cutout tools under the ignored `.local/macos-tools` (see
[bundled-tools.md](bundled-tools.md) for source pins and licenses). For subject cut-out alone,
`npm run desktop:cutout` compiles only kino-cutout into `.local/macos-tools/helpers` in seconds.
`npm run desktop:pack`
verifies that bundle and builds an ad-hoc signed app at `release/mac-arm64/kino.app`, with the
media tools, their license texts and complete corresponding source (**Help → Bundled media
licenses** and **Help → Bundled media source**). It is not notarized; first launch on a fresh Mac
is unverified.
