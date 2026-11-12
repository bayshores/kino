# Check and look

`check` measures; `look` shows. Both read the saved project.

Polish (what a viewer calls sloppy though gates pass): taste reference.

Contents: Check · Looking · Review before final · Building in order

## Check

- Each finding says what it measured, what is required and a fix op. A rule's exact limits:
  `library {topic:"rules", name:"quality", search:"<code>"}`. A topic too long for one answer
  comes back cut with the lines left: `search` reads the lines that mention a word.
- `check {fix:"auto"}` applies the `(auto)` fixes in one edit (skipping one that adds an error
  or keeps its finding), re-checks, up to 3 rounds: call it once. A warning's fix skips layers
  your last edit moved, a waiver names or a spine beat uses.
- After an edit, `check {}` redraws only the frames the edit touches, and a check of an
  unchanged scene answers from the last one, also while `reference_drift` runs.
- First `check` ends with `Rules:`; a same-rev repeat is 1 line (`{rules:true}` all).
- The first 8 lines of `check`, `look` versus and review, and `status` lead with what decides your
  next call (errors, advice, drift, `whole scene:`, inbox); the rest is detail.
- Footage: `speech_cut` (a voice cut mid-word: sound reference), `soft_upscale` (drawn over 1.3x
  its file; one file drawn at one size on several layers lists them in `refs`, `waive_check`
  targets that list, and a waiver on one layer covers only it), `crop_no_subject` (cropped, no subject marked), `head_cut_off` (Mac), `jump_cut`
  (one file framed alike back to back), `frozen_footage` (picture stops 0.3 s+: start earlier,
  mediaSpeed 0.85+, or cut away), `out_of_sync` (a line over another moment of a synced file).
- `covered_layer`: a solid shape, mp4 or jpg above hides a layer (png, webm, mov may be clear).
- Motion rules (camera, brightness, frozen pictures): motion reference.
- Contrast: under 0.2 s warns, longer is an error; the fix tries a scrim, a halo
  shadow, a darker place, a large-text size, then a plate.
- With sound in the scene, `check` adds a `mix:` line: every place the mix passes the master
  limiter at render loudness `"off"` (time, dB over, layers at their volume, xN to clear it),
  then what the default `"auto"` gain does to the same peaks; `look {mode:"motion",
  ref:"sound"}` lists them (worst 6). No render needed. `check {fix:"auto"}` applies those xN
  (sound reference); a layer whose volume moves at a place is named under `not applied`, with
  its xN to apply by hand. Places are timed by 0.1 s windows, even when FFmpeg prints no time.
- The counts line of `status` and receipts reads `err, warn` then the open finding names, and
  `N waived` then the waived ones, by rule then ref; check's `waived:` line lists the same.
- Full-frame footage you add over a text that shows at the same time is moved under the text; the
  receipt notes name it, the seconds and the `move_layers` call that puts it back. Masks are left
  alone (masked-type's fill stays on its word); a layer a `move_layers` or `reorder_layer` in the
  same edit names stays. A blend mode other than normal, or an alpha channel, is not moved.
- `default_font` fix: `library {topic:"fonts", search:"<first type label's words>"}`.
- `check {rules:["missing_glyphs"], fix:"auto"}` applies the glyph-range fix (a
  `textStyleRanges` range in a font that has the characters); when no font has them, the
  receipt names a font file to import (Chinese: NotoSansSC-Regular.ttf).
- `opacity` 0 under a fade-in warns, names the `delete_animation` call, and its next is
  `update_layer visible:false`.
- Errors, and in a real edit warnings except taste ones (they ride on the final's receipt), block final. On purpose:
  `{"op":"waive_check","code":"overlap","target":"*","reason":"meant"}`; a list or glob
  waives each match. `quote` (the person's words) and named layers, never `*`:
  what viewers see, `crop_no_subject`; whole-scene `held_static`, `text_slides`, `ending_seen`,
  `music_stall` the scene. `head_cut_off`, `narrow_window`, `soft_upscale`: named layers.
  Reason names: `ask_unmet` the origin word; `default_font`, `type_seen` a moment you
  labeled type (`yt:<id> @4.4`); `reference_range` its rows (dark footage: its fix is `lift_dark
  {layer}`; color-wheels `gamma` only brings a picture down). `shape_guess`: never.
- AI tells warn: `own_words` (no `source`), `stock_copy`,
  `same_entrance`, `word_by_word`, `soft_cuts`, `blurred_backdrop`, `text_glow`, `page_chrome`,
  `split_card_layout`, `seen_before`, `type_seen` (like a recent project's: set from references).
- Set `role` on layers (headline, cta, logo, hero, decor, `ui`: product text, contrast only)
  and `videoType`. Checker facts: `library {topic:"rules", name:"quality-settings"}`
  (roles, videoType, assertions, waivers, face and crop findings) and `name:"quality-references"`
  (reference rules, the storyboard stop, the final render).
- luma_jump, reading_time, type_min, safe_zone turn to advice when 2+ saved, measured references go as far (flashes, shortest text hold, smallest line, edge); past them they say by how much.
- A slow linear move (under 4% of the frame diagonal a second) still running when its layer leaves (cut, hide, fade out, scene end) passes linear_motion, text too: no waiver.

## Looking

- CLI: `kino look frame t=3 width=720`; a list is one word (`fields=x,width`).
- `inspect {targets, fields}`: `color` answers with `fill`,
  `size`: `width`, `height`.
- `sheet` (default): about 12 tiles a scene; with cuts, a tile or more a shot, labeled
  `2 · 1.42s` (24 shots at most; `from` shows the rest); several scenes: one frame each.
  `sheet {from, to}`: one stretch.
- look sheet, look review and check print `returns: <thing> at <times> (what changes)`: each made
  layer, word, image, move or shot shown at 2+ places, and what the first second and last frame
  share. A fact. A group of layers, or layers named by number (tread-1 to tread-4), counts as
  one device with its count: `tread (4 layers) at 1 2 3 ×3`.
- `check`, `status`, look sheet and look review print `made:` after `returns:`: the share of half-second moments with a cut-out, a
  drawn graphic or shape, a particle overlay, or type at 8% of frame height or more that is not
  a caption. Beside it: `deck: N of M cards unused (names)` (`deck_unused`) and
  `drawn graphic: yours X of N moments, your references' made labels a of b`. Facts, no target.
- `frame {t, width?}` (up to 1280 px; `zoom` for detail), `zoom {layer, t?}`, `strip {anim}`
  (`every:true`: each frame), `compare {rev}`, `changed`, `variants`.
- `motion {from?, to?}` (graph and trace, no render), `frames {from, to?}` (each 30 fps frame):
  motion reference.
- `source {layer, t?}`: a video layer's whole source frame (default: mid-screen-time), a 10%
  grid, the crop dashed, subject boxes (`agent`: from `mark_subject`; `vision`: Mac only), the
  result and each box's share. Not your last look for `changed`. Cropping: framing reference.
- `board {page?}`: the storyboard, 4 shots a page, with numbers (storyboard reference).
- look {mode:"frames", times:[0.5,1,1.2], layer:"title"}: up to 60 chosen times as labeled pages (time, frame), cropped to a layer; few times get bigger tiles. every:4 with from/to thins a range.
- look {mode:"frame", times:[1,1.45,1.9]}: 2 to 4 times side by side; an edit that adds a move ends its receipt with this call (start, middle, end).

## Review before final

`check` misses what only eyes catch (a subject cut off). The QC loop:

1. `edit`, then read the receipt: `newFindings` (at most 5, codes and times) are what it
   brought in; fix them next.
2. `look {mode:"review"}` (a scene; `from`/`to` for a stretch) picks the moments that matter
   (cuts, effects, moves, text landing, quiet stretches), riskiest full size. Each tile: frame,
   time, what happens, findings in yellow. Cuts add seam rows (motion reference).
3. Study every frame for type, wrapping, overlaps, framing, empty space, artifacts; fix all in one `edit`.
4. `look {mode:"review"}` again shows only the moments whose picture changed.
5. A final render does not wait for look review (its receipt names moments not yet reviewed).
   Review first anyway.
6. Saved references: with no `look {mode:"versus"}` in 10 revs, final runs it: rows by place
   (opening, loudest change, ending), gaps in fill, contrast, drift, range, softness, accent. A
   lost judge round blocks. Skip: `waive_check {code:"reference", target:"*", reason}`.

## Building in order

Get a rough whole scene first (layout, background, main subject; often one `compose`), then
build in at most 3 sections, a designer's order: 1 supporting parts, 2 motion and timing, 3
polish (color, type, sound). Each section is one `edit`, then `look {mode:"sheet", from, to}`
over its time before the next; those looks are your pass. With the fixes in one more `edit`
that is
at most 5 edits to build it; the storyboard, a redo the person asks for at a stop and a retry come on top.
