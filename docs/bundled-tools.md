# Bundled macOS media tools

The macOS app can ship arm64 builds of FFmpeg, ffprobe, and Gifski without depending on a user's Homebrew installation. The build script uses pinned upstream source archives, verifies every archive with SHA-256, verifies FFmpeg's detached release signature against its pinned signing-key fingerprint, and builds only under the ignored `.local/macos-tools` directory. It does not install packages or modify `HOME`.

From a macOS arm64 host with Xcode command-line tools (including the Swift compiler), GPG, Rust/Cargo, and `make` available, inspect the no-network plan with:

```sh
node scripts/build-macos-tools.mjs
```

The build requires the explicit `--build` switch. `npm run desktop:tools` runs it at reduced priority (`nice -n 10 node scripts/build-macos-tools.mjs --build`); it caps parallel build jobs at two and writes the bundle to `.local/macos-tools/dist/`. It pins CC, CXX, AR, RANLIB, and NM to the active Xcode toolchain and clears inherited compiler, linker, Rust, and pkg-config flags before configuring sources. It currently targets macOS 13 or later and the arm64 `arm64-darwin25-gcc` libvpx target. libvpx builds in a private out-of-source directory. The script stops if the pinned output already exists or the host target differs; inspect and remove only that generated output before rebuilding.

Check an existing bundle without changing it with:

```sh
node scripts/build-macos-tools.mjs --verify
```

Verification checks the pinned manifest, executable hashes and arm64 slices, system-only dylib closure, required FFmpeg encoders/decoders, the macOS system zlib dependency, and a sorted path-and-SHA-256 inventory for every file in the corresponding-source and license trees. It compares exact paths and file contents, records symlink targets, rejects symlinks that escape those trees, and compares the bundled rebuild script, config, and documentation with the current workspace. The manifest records that the FFmpeg signature was verified during the build and binds that evidence to the bundled key and signature hashes; `--verify` does not access a GPG keyring. If the bundle is missing or invalid, it prints `Run npm run desktop:tools.`

The build keeps FFmpeg's built-in demuxers, decoders, filters, and encoders, while disabling optional autodetected libraries. It explicitly enables zlib from the macOS SDK for PNG/APNG; the only runtime zlib dependency is the system `libz.1.dylib`, with no Homebrew library or added source pin. It statically links x264, libvpx, and Opus so the existing paths remain available: VideoToolbox H.264 and x264 MP4 encoding, VP9 WebM encoding and WebM alpha decoding, libopus WebM audio, ProRes MOV, FFmpeg GIF/APNG, media probing, and video decoding. It enables GPL for x264 and does not enable nonfree components. Gifski is built from its pinned Cargo lockfile with only its `binary` and `gifsicle` features; its optional FFmpeg `video` feature is excluded because kino supplies PNG frame files.

The build and `--verify` both check the actual FFmpeg capability tables against these required names:

| Encoders | Decoders |
| --- | --- |
| `png`, `apng`, `gif`, `libx264`, `h264_videotoolbox`, `libvpx-vp9`, `libopus`, `aac`, `prores_ks` | `png`, `apng`, `gif`, `mjpeg`, `h264`, `hevc`, `vp8`, `vp9`, `libvpx-vp9`, `prores`, `aac`, `opus` |

These selections live in `scripts/macos-tools.json` and the build manifest. A missing required codec or the expected system zlib link fails validation before the bundle is published.

The pinned source set is recorded in [macos-tools.json](../scripts/macos-tools.json). The SHA-256 values below are also checked by the script before extraction. The Gifski `Cargo.lock` hash is checked separately, and its locked crate sources are vendored into the corresponding-source bundle.

| Source | Version | License | SHA-256 |
| --- | --- | --- | --- |
| [FFmpeg](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz) | 9.0.2 | GPL-2.0-or-later build | `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` |
| [x264](https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz) | r3222, commit `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` | GPL-2.0-or-later | `cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9` |
| [libvpx](https://github.com/webmproject/libvpx/archive/refs/tags/v1.17.0.tar.gz) | 1.17.0 | BSD-3-Clause | `1020f184046187baa2985dbde38e0691f49c44088bca7a1842b0236c6081dc0a` |
| [Opus](https://ftp.osuosl.org/pub/xiph/releases/opus/opus-1.6.1.tar.gz) | 1.6.1 | BSD-3-Clause | `6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1` |
| [pkgconf](https://distfiles.ariadne.space/pkgconf/pkgconf-2.5.1.tar.xz) | 2.5.1, build-only | ISC, BSD-4-Clause, BSD-2-Clause, MIT | `cd05c9589b9f86ecf044c10a2269822bc9eb001eced2582cfffd658b0a50c243` |
| [Gifski](https://github.com/ImageOptim/gifski/archive/refs/tags/1.34.0.tar.gz) | 1.34.0 | AGPL-3.0-or-later | `c9711473615cb20d7754e8296621cdd95cc068cb04b640f391cd71f8787b692c` |

The bundle also holds `kino-voice`, kino's own helper for the `apple` voice isolation engine. It is compiled with `xcrun swiftc -O -target arm64-apple-macos13.0` from [backend/voice/kino-voice.swift](../backend/voice/kino-voice.swift), which the rebuild sources include, and it calls the `AUSoundIsolation` audio unit that macOS 13 and later provide. Its binary hash, Swift version and system-only dylib closure are recorded in the manifest (schema 4) and checked by `--verify`. A bundle built before the helper was added fails `--verify` until it is rebuilt with `--build`.

It also holds `kino-cutout`, kino's own helper for subject cut-out (the edit op `cut_out`). It is compiled the same way from [backend/cutout/kino-cutout.swift](../backend/cutout/kino-cutout.swift) and calls the Vision framework that macOS provides (subject masks on macOS 14 and later, person masks on macOS 13 and later); it holds no model files. Its hash, version and dylib closure are recorded in the manifest, so a bundle built before it fails `--verify` until it is rebuilt.

`kino-measure` is built the same way from [backend/measure/kino-measure.swift](../backend/measure/kino-measure.swift): Apple Vision optical flow, text recognition, feature prints and saliency for Inspire's fingerprint and the `reference_drift` check. It holds no model files. It is in the manifest from schema 6. In a checkout without the bundle, kino builds it once from source into the temporary folder when the Swift compiler is installed.

`kino-recorder` is built the same way from [backend/recorder/kino-recorder.swift](../backend/recorder/kino-recorder.swift): screen recordings for `project {action:"record"}` (ScreenCaptureKit picture without the pointer, the pointer and clicks as data). In a checkout without the bundle, kino builds it once from source the same way.

The corresponding-source bundle contains the original archives, FFmpeg signature and key, Gifski source with its unchanged `Cargo.lock` and vendored crates, the pinned config, license texts, and a build manifest with the exact toolchain and commands. The Gifski vendor tree retains each crate's source and license files; `licenses/gifski-cargo-crates.json` indexes the recorded license metadata. No source patches are applied.

The app looks for the tools in `process.resourcesPath/bin`. `build.extraResources` in
`package.json` copies the generated `bin`, `licenses`, `sources` and `build-manifest.json` into the
app's resources, so the executables and their corresponding source ship together.

After packaging, check the app on the build Mac with a `PATH` that excludes Homebrew: executable
architectures, signatures, `otool -L` (the build script also rejects any non-system dynamic
library), ffprobe probing, video decoding, both MP4 encoders, WebM with Opus audio, MOV,
transparent GIF and PNG-sequence Gifski export. First launch on a fresh Mac is unverified.

## Song embeddings (npm, not bundled)

`@huggingface/transformers` 4.3.2 (transformers.js, Apache-2.0) is an optional npm dependency; it
pulls `onnxruntime-node` (MIT), about 470 MB installed. It runs LAION-CLAP `clap-htsat-unfused`
(weights Apache-2.0, original code CC0) from its ONNX port `Xenova/clap-htsat-unfused`, downloaded
once on first use into the data folder's `models/hf` (about 600 MB: audio 118 MB, text 502 MB).
`backend/music-embed.mjs` uses it to give songs a lane and compare them to the person's taste.
`KINO_MUSIC_DOWNLOAD=0` stops the download; without the model, songs rank by the old features.

## Reference looks (npm, not bundled)

The same transformers.js runs SigLIP `google/siglip-base-patch16-224` (weights Apache-2.0) from
its ONNX port `Xenova/siglip-base-patch16-224`, 8-bit, downloaded once on first use into
`models/hf` (about 210 MB: vision 100 MB, text 112 MB). transformers.js 4.3.2 does not run
SigLIP 2 yet. `backend/look-embed.mjs` embeds reference thumbnails and keyframes and search words.
`KINO_LOOK_DOWNLOAD=0` stops the download, `off` turns looks off. Aesthetic Predictor V2.5 is
AGPL-3.0 and is never bundled.
