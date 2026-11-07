# Voice test fixtures

## 2277-149896-0005.flac

One utterance from the LibriSpeech ASR corpus, unchanged: the `dev-clean` subset, speaker 2277
(female reader "zinniz"), chapter 149896 (*Sister Carrie* by Theodore Dreiser, "Ashes Of Tinder: A
Face At The Window"). 5.6 seconds, 16 kHz mono FLAC, 104,850 bytes, SHA-256
`05013da97856ccce8ef62b3408643f144ae6b88d581731675fd1a70b03288849`. Taken on 2026-10-19 from
<https://www.openslr.org/resources/12/dev-clean.tar.gz> (`LibriSpeech/dev-clean/2277/149896/`).

Words spoken: "Many little wrinkles gathered between his eyes as he contemplated this and his brow
moistened."

LibriSpeech (c) 2014 by Vassil Panayotov. LibriSpeech ASR corpus is licensed under a Creative
Commons Attribution 4.0 International License (<https://creativecommons.org/licenses/by/4.0/>).
The recordings come from LibriVox public-domain audiobooks.

The voice isolation tests (`backend/voice-isolation.test.mjs`) mix this real speech with synthetic
music and hiss made in the test (`tests/voice-mix.mjs`), so they know the clean voice exactly and
can score how much of it each engine recovers.
