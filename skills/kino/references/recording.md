# Recording the screen

kino records the screen on this Mac while you (the agent) use an app, then edits the recording
from its own pointer and click data: zooms that follow each click, kino's smooth pointer, click
rings. Nothing is guessed: every zoom and pointer place comes from what was recorded.

Contents: Recording · Steps and marks · Editing a recording · Privacy and permissions

## Recording

- `project {action:"record", options:{step:"windows"}}` lists windows (id, app, title, size);
  `step:"displays"` the displays; `step:"permissions"` what macOS allows.
- `step:"start"` starts. `target` is `{display:<id>}` (default the main display), `{window:<id>}`,
  `{app:"Safari"}` (its largest window, recorded even when other windows cover it) or
  `{area:{x, y, width, height}}` in display points. Options: `fps` (default 60), `size` (long
  side px, default 1920, or "full"), `audio:true` (the computer's sound), `mic:true` (macOS 15+;
  with both, kino mixes them into the clip's one sound track),
  `keys` ("off" default, "kinds": key kinds and shortcuts, never text), `maxSeconds` (default
  600), `idleSeconds` (stop after that long with no input), `excludeApps` (bundle ids).
- The picture is recorded without the pointer; the pointer, clicks, scrolls, keys and the text
  caret are kept as data. Clicks say who made them: `agent` (posted by a program) or `person`.
- `step:"stop"` finishes and answers `src` (a library video), `seconds`, clicks and marks. A stop
  rule (maxSeconds, idleSeconds, the window closed) or the person's Stop in the dashboard ends it
  too: the next `status` or `stop` answers what was kept. A recording kino or the Mac quit during
  is kept the next time a recording starts (all but its last 2 s).
- CLI: `kino project record start target='{"app":"Notes"}' maxSeconds=60`, `kino project record
  mark Open the menu`, `kino project record stop`.

## Steps and marks

- Mark each step as you do it: `options:{step:"mark", label:"open Export"}`. A mark is a cue
  (`<move id>.mark1`) and a zoom target when no click is near it. `pause` and `resume` cut the
  pause out of the video.
- Plan the steps before you start, act at a steady pace (a second between actions reads well),
  and stop within 2 s of the last step: dead time at the ends is footage you will cut.
- A browser driven through its debugging protocol (Playwright, CDP) moves no real pointer: mark
  each step so the zooms still land.

## Editing a recording

- Add the `src` as a video layer, then the move. kino adds the recording's data to the layer:

```json
{"op":"add_layer","layerType":"video","name":"screen","properties":{"src":"/api/media/<recording>.mp4","x":0,"y":0,"width":1920,"height":1080}}
{"op":"move","name":"screen-recording","layer":"screen"}
```

- `screen-recording` pushes in 2x from 0.3 s before each click (or mark) to 2.5 s after,
  joins clicks closer than 2.5 s, follows the pointer while zoomed and never shows past the
  picture's edge. One clamped spring drives every zoom (no overshoot).
- Its pointer is kino's own (arrow, hand, I-beam, as recorded), smoothed, on time at every
  click, grows with the zoom, squishes while pressed and hides while typing or outside a window
  recording's picture (clicks out there get no zoom). A ring opens at
  each click; each click is a cue (`<id>.click1`) for a click sound.
- Fields: `zoom` (1 to 4, 1 = none), `pointer:false`, `size` (pointer, default 1.5x the real
  one), `clicks:"none"`, `typing` (2 to 8: typing runs of 1.5 s or more play that much faster;
  the clip ends sooner), `hold` (seconds a zoom stays, default 2.5).
- Fill the frame with the clip for zooms: the zoom scales the clip itself, so a clip in a corner
  would grow past its box. Cut dead time first (`split_layer {from, to}`), then the move.
- check reads the pointer as the clip's subject (crop_no_subject) and its moves as motion
  (frozen_picture); `check {fix:"auto"}` adds
  motion blur where a zoom pans fast at 30 fps (judder).

## Privacy and permissions

- The first start asks macOS for Screen Recording permission for kino: the person allows it in
  System Settings, then you start again. Input Monitoring tells agent clicks from the person's.
- Typed text is never kept, even with `keys:"characters"` the edit keeps only key kinds.
  Recordings stay on this Mac. The dashboard shows a red `rec` button while one runs; the person
  can stop it at any time.
