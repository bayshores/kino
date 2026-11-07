# Testing

How kino is tested. Every feature and its evidence is in [COMPATIBILITY.md](../COMPATIBILITY.md).

## Running the tests

```sh
npm test                           # every test, including the golden frames
npm test -- backend/crew.test.mjs   # only the files named
npm test -- --changed               # only the tests related to this branch's changes
npm run build
```

Options for `node --test` go after `--`, written as `--name=value`. CI splits the files across
eight machines by the time each took (`tests/test-times.json`), so they finish at about the same
time; `scripts/test-times.mjs` says how to refresh those times from a CI run. A new file with no
recorded time counts as a typical file.

Tests cover document validation, operations, storage and revision conflicts, rendering, exports,
the HTTP and WebSocket service, the MCP protocol and the agent tools. They use temporary data
folders, never the default workspace. A server a test starts stops by itself when that test
process dies (`KINO_EXIT_WITH_PARENT`, or `NODE_TEST_CONTEXT` from `node --test`), so a killed run
leaves none running. Integration tests use the real HTTP renderer and MCP stdio
process and decode the files they make.

`tests/dashboard-browser.test.mjs` drives the dashboard and the share-link viewer in an Electron
window and saves screenshots. The window is hidden on a Mac; on Linux it is shown without focus
(on CI, xvfb's virtual screen), because a hidden window there paints about once a second and the
playback tests count display frames. Before any test, the file checks that the window paints at
least 20 frames a second.

## Golden frames

```sh
npm run golden:update                 # after an intended rendering change
KINO_GOLDEN_UPDATE=1 node --test tests/look-source-frames.test.mjs   # look source and sheet goldens
KINO_GOLDEN_UPDATE=1 node --test tests/look-board-frames.test.mjs    # look board goldens
```

`npm test` includes 86 golden frames: 81 scenes in `tests/golden/frames/`, 3 looks in
`tests/golden/look-source/` (`look source` twice and a sheet by shot, from the Sintel test clip,
with Apple Vision off) and 2 storyboard pages in `tests/golden/look-board/` (the storyboard
reference's footage board on a 9:16 project and its motion board on a 16:9 one). `npm run
golden:update` does not write the looks; the second and third commands above do. The looks also
fail when any 16×16 block has more than 8 different pixels, so one wrong digit in a label is
caught. The four clip speed scenes play a video and a GIF that `tests/golden/media.mjs` makes
with FFmpeg on each run, and `backend/agent-reach-golden.test.mjs` rebuilds the scenes through
agent ops (the move scenes in `tests/golden/moves.mjs` through the `move` op) and compares one frame of each
with the same goldens.

Chromium draws effect scenes with the GPU on a Mac and with the CPU on Linux CI, which moves some
blur and edge pixels past the tolerance, so those frames also have a Linux golden in
`tests/golden/frames-cpu/` (`tests/golden/raster.mjs`). After changing one of them, run
`npm run golden:update` on a Mac, then copy the Linux renders from the failed CI run's
`golden-failures-*` download (the `*.actual.png` files) into `tests/golden/frames-cpu/`.

## Voice isolation

`backend/voice-isolation.test.mjs` tests the engines, `backend/voice-media.test.mjs` the library
files they make, and `backend/agent-voice.test.mjs` the `isolate_voice` op through the agent
service. They mix a LibriSpeech clip (`tests/fixtures/voice`) with generated music and hiss
(`tests/voice-mix.mjs`) and score the result with SI-SDR. No test downloads anything (test
servers start with `KINO_VOICE_DOWNLOAD=0`). RNNoise runs everywhere. The DPDFNet tests run only
when the model is on the computer, named by `KINO_VOICE_MODEL` (CI downloads it once, checks its
SHA-256 and caches it). The Apple engine test needs macOS 13 or later and the Swift compiler,
and builds the `kino-voice` helper itself; through the op, Apple is used when the helper is built
(`npm run desktop:tools`) or named by `KINO_VOICE_HELPER`. To run them all on a Mac:

```sh
KINO_VOICE_MODEL=/path/to/dpdfnet2_48khz_hr.onnx node --test backend/voice-*.test.mjs backend/agent-voice.test.mjs
```

## Subject cut-out

`backend/cutout-matte.test.mjs` tests the steadier, `backend/cutout.test.mjs` the engine and its
files, and `backend/agent-cutout.test.mjs` the `cut_out` op through the agent service (every
example in `skills/kino/references/cutout.md`). The footage is made in code
(`backend/cutout.test.support.mjs`), so every frame's true outline is known and each matte is
scored by IoU against it. Apple Vision exists only on macOS, so everywhere (CI included) the tests
use a stand-in helper, `backend/cutout.test.stand-in.mjs`, named by `KINO_CUTOUT_HELPER`. The tests
marked "Apple Vision" build the real helper and run on macOS 14 or later; elsewhere they are
skipped with that reason. The golden frames `cutout-pop@*.png` use a cut-out made losslessly in
code (`tests/golden/media.mjs`), so they are the same on every computer.

## Clip speed

Clip speed (`mediaSpeed`, Speed animations, `mediaReverse`, `mediaFrameRate`,
`mediaInterpolation`, `mediaPitch`; `engine/mediaTime.js`) is tested on footage the tests make:
videos whose every frame has its own grey level or bar position, GIFs made byte by byte, and WAV
tones. `engine/mediaTime.test.js` checks the time map, `backend/media-speed-export.test.mjs` and
`backend/media-remap.test.mjs` which file frame each exported frame shows, and
`backend/audio-mix.test.mjs` the pitch of sped-up sound. To make such footage in a new test, give
`makeVideo` in `backend/media.test.support.mjs` a `framePixels(frame)` function that returns each
frame's whole RGB picture.

`mediaInterpolation: "flow"` runs FFmpeg's minterpolate once per clip and keeps the result.
Measured on an Apple M3 Pro with FFmpeg 9.0.2 (2026-10-19), for 2 s of 30 fps footage:

| Footage | Frames made | Time | Frames a second |
|---|---|---|---|
| 1280 × 720 | 2× (60 fps) | 9.4 s | 12.8 |
| 1280 × 720 | 4× (120 fps) | 20.8 s | 11.5 |
| 1920 × 1080 | 2× (60 fps) | 21.4 s | 5.6 |
| 1920 × 1080 | 4× (120 fps) | 48.8 s | 4.9 |

So 10 s of 1080p footage played at 0.25× (4× the frames) takes about four minutes the first time
and nothing after that (the result is cached by the file's SHA-256 under the data folder's
`cache/flow`). The proxy is made at the layer's size or the file's own, whichever is smaller, so a layer shown larger than its file reuses it. The test uses a 96 × 96 clip (0.1 s).

## Agent evals

```sh
npm run mcp:budget                    # size of the tool list an agent loads
npm run eval -- --brief promo-01      # a real agent run on one test brief
```

The eval runner (`evals/run.mjs`) starts a private kino server for each run and runs the agent
in an empty temporary folder that holds only the kino skill. It uses your installed `claude` or
`codex` CLI with an API key you pass in the environment (`ANTHROPIC_API_KEY` or
`CODEX_API_KEY`); each run gets an empty home and config folder, so your own login is never
used. It records tool calls, tokens, cost, time, the exported video and four stills under
`.local/evals/`. The briefs are in `evals/briefs.json`. `--runs 10` repeats a brief, `--watch`
prints each call, and `--rescore` recomputes saved runs.

- **A run passes** when the agent finishes, the newest export matches the brief's length (within
  0.5 s), and it used at most 20k kino tokens and 6 `edit` calls.
- **Brand-kit briefs** (`kit-01` to `kit-05`): the runner loads a brand kit into the project
  first; a run passes when the agent finishes, the length matches and `check` shows 0 errors with
  none waived.
- **Quality gates** (`gates PASS`): the newest export has the brief's full size and length, `check`
  shows 0 errors, and the video has what the brief `requires` (`audio`, `captions`, `beats`).
  A brief's `media` are made with FFmpeg for each run or copied from `evals/assets/`.

## Hand-run checks

Scripts run by hand, not by `npm test`:

```sh
node scripts/desktop-shot.mjs --data <data folder> --out shot.png    # screenshot the desktop app (temporary profile)
node scripts/playback-perf.mjs --data <data folder>                  # dashboard playback frame times
node --import ./scripts/test-fonts.mjs tests/polish-sweep.mjs         # every recipe, look and format
```
