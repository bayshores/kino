# Footage test fixtures

## sintel-village-dragon.mp4

4.4 seconds of the trailer of the open movie *Sintel*, made smaller for the tests (134,286 bytes,
SHA-256 `01cf39cbab1ff4b3c8f9ba9ec2046701d18171db1d782ff82379a8affa6e9be9`; 384×216 H.264, 24 fps,
106 frames, 4.417 s, no sound). It has three shots, with cuts at frames 30 and 80 (1.25 s and
3.333 s): Sintel in a burning village, a city with a red dragon, and a flying dragon.

Downloaded on 2026-10-21 from Wikimedia Commons, `File:Sintel trailer-1080p.ogv`, the 480p VP9
transcode
<https://upload.wikimedia.org/wikipedia/commons/transcoded/0/06/Sintel_trailer-1080p.ogv/Sintel_trailer-1080p.ogv.480p.vp9.webm>
(3,547,540 bytes, SHA-256 `ee701e90e4fd5c5a6a4f3d65308b94891fbf4fdb168c7fe959655bf77163d470`).
The download itself is not in the repository. It was cut with FFmpeg 6.1.1:

```
ffmpeg -ss 22.6 -i Sintel_trailer-1080p.ogv.480p.vp9.webm -t 4.4 -map 0:v:0 -an \
  -vf scale=384:216:flags=lanczos,fps=24 -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p \
  -g 48 -movflags +faststart -map_metadata -1 sintel-village-dragon.mp4
```

© Blender Foundation | durian.blender.org. Licensed under Creative Commons Attribution 3.0
(<https://creativecommons.org/licenses/by/3.0/>): "The results of the Durian Open Movie project are
being licensed under the Creative Commons Attribution 3.0 license"
(<https://durian.blender.org/sharing/>).

The tests use it as real footage with cuts: `backend/look-source.test.mjs` (look source, marking the
subject, sheet tiles by shot), `tests/look-source-frames.test.mjs` (the golden frames in
`tests/golden/look-source/`) and `backend/shot-detection.test.mjs` (finding its two cuts).
The storyboard tests use it too: `backend/look-board.test.mjs` and `tests/look-board-frames.test.mjs` (`tests/golden/look-board/board-sintel.png`).
