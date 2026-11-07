# Voice isolation models and licenses

kino splits dialogue from music and noise on this computer only (`backend/voice/`). Nothing is sent
to an outside service. Three engines are available; `auto` uses the first one this computer has.

| Engine | What runs | Where it comes from | License |
|---|---|---|---|
| `dpdfnet` | DPDFNet2 48 kHz HR speech enhancement model | Downloaded once, on first use, into `<data folder>/models/` | Apache-2.0 |
| `apple` | Apple's sound isolation audio unit (`AUSoundIsolation`) through the `kino-voice` helper | Part of macOS 13 and later; the helper is built from `backend/voice/kino-voice.swift` | macOS system component |
| `rnnoise` | RNNoise through FFmpeg's `arnndn` filter | `std.rnnn` in this folder | BSD-3-Clause |

## DPDFNet (engine `dpdfnet`)

- Model: DPDFNet2 48 kHz HR by Ceva (Daniel Rika, Nino Sapir, Ido Gus, "DPDFNet: Boosting
  DeepFilterNet2 via Dual-Path RNN", 2025). Original weights:
  <https://huggingface.co/Ceva-IP/DPDFNet>, licensed under the Apache License 2.0
  ([Apache-2.0.txt](Apache-2.0.txt)).
- ONNX file used by kino, as converted by the sherpa-onnx project:
  <https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/dpdfnet2_48khz_hr.onnx>,
  10,596,848 bytes, SHA-256
  `0b399f8a58dc4d70d8cd97541f5c39869406145193b957d00a03b66070944928`. kino refuses any other
  bytes. The model is not stored in this repository or in the app; it is downloaded on first use.
- Runtime: the npm package `sherpa-onnx-node` 1.13.8 and its platform package
  (`sherpa-onnx-<platform>-<arch>`), by the Next-gen Kaldi team (k2-fsa,
  <https://github.com/k2-fsa/sherpa-onnx>), licensed under the Apache License 2.0
  ([Apache-2.0.txt](Apache-2.0.txt)). It is an optional dependency: when it cannot be installed,
  `auto` uses another engine.
- The platform package contains ONNX Runtime, Copyright (c) Microsoft Corporation, MIT License
  ([onnxruntime-MIT.txt](onnxruntime-MIT.txt)).

## RNNoise (engine `rnnoise`)

- `std.rnnn` is the standard RNNoise model in the text format FFmpeg's `arnndn` filter reads,
  from <https://github.com/richardpl/arnndn-models> (SHA-256
  `6b8943dc4a9b6b24425873992a44f29c0577503276456af46a8854774faeb294`).
- Every weight in it equals the weights in `src/rnn_data.c` of RNNoise v0.1 by Xiph.Org and
  Mozilla (<https://gitlab.xiph.org/xiph/rnnoise>); all 87,503 values were compared on 2026-10-19.
- License: BSD-3-Clause, Copyright (c) 2017 Mozilla, (c) 2007-2017 Jean-Marc Valin,
  (c) 2005-2017 Xiph.Org Foundation, (c) 2003-2004 Mark Borgerding
  ([rnnoise-BSD-3-Clause.txt](rnnoise-BSD-3-Clause.txt)).

## Apple sound isolation (engine `apple`)

The `kino-voice` helper (`backend/voice/kino-voice.swift`, part of kino) loads the audio unit that
macOS provides; no Apple code or model is copied into kino. `scripts/build-macos-tools.mjs`
builds the helper into the Mac app's `Resources/bin` folder.
