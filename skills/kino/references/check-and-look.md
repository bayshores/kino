# Check and look

`check` measures; `look` shows. Both read the saved project.

Polish (what a viewer calls sloppy though gates pass): taste reference.

Contents: Check · Looking · Review before final · Building in order

## Check

- Each finding says what it measured, what is required and a fix op. A rule's exact limits:
  `library {topic:"rules", name:"quality", search:"<code>"}`. A topic too long for one answer
  comes back cut with the lines left: `search` reads the lines that mention a word.
- `check {fix:"auto"}` applies the `(auto)` fixes in one edit, re-checks, up to 3 rounds: call it once. With `rules:[...]` only those rules' fixes apply (`["mix"]`: the mix fix, sound reference). A warning's fix skips layers
  your last edit moved, a waiver names or a spine beat uses.
- First `check` ends with `Rules:`; a same-rev repeat is 1 line (`{rules:true}` all).
- Footage: `speech_cut` (sound reference), `soft_upscale` (drawn over 1.3x its file; block step:
  color reference; a file drawn at one size on several layers lists them in `refs`, and a waiver on one
  layer covers only it), `crop_no_subject`, `head_cut_off` (Mac), `jump_cut`, `frozen_footage`
  (picture stops 0.3 s+: start earlier, mediaSpeed 0.85+, or cut away), `out_of_sync`.
- `covered_layer`: a solid shape, mp4 or jpg above hides a layer (png, webm, mov may be clear).
- Motion rules (camera, brightness, frozen pictures): motion reference.
- Contrast: under 0.2 s warns, longer is an error; the fix tries a scrim, a halo
  shadow, a darker place, a large-text size, then a plate.
- With sound in the scene, `check` adds a `mix:` line: every place the mix passes the master
  limiter at loudness `"off"` (time, dB over, layers, xN to clear it), then what the default
  `"auto"` gain does to the same peaks. `look {mode:"motion", ref:"sound"}` lists them (worst 6)
  and prints the same `cue:` and `ending:` lines.
- `check` and `look` review print a `bare background @T s` fact line (time, frames, color, brightness on both sides, closing call) where the background shows between two full-frame shots or in the scene's first or last stretch. The closing call is the last shot's Hide moved to the end, or `update_scene` duration. A fade to or from the background and a card of words on it are no gap.
- `bare strip`: a full-frame picture (a mirrored one too) leaves an edge uncovered for its whole shot. The line gives the edge, the px, and the scale or x/y that covers it. Facts never block.
- The counts line of `status`, receipts and `check` reads `err, warn`, then the open finding names, `N waived` then the waived ones, and may end `· N warn stop(s) a final render (rule xN)`: fix or waive those before a final render.
- Full-frame footage you add over a text shown at the same time goes under the text; the
  receipt names the `move_layers` call that puts it back.
- `default_font` fix: `library {topic:"fonts", search:"<first type label's words>"}`.
- `check {rules:["missing_glyphs"], fix:"auto"}` applies the glyph-range fix (a
  `textStyleRanges` range in a font that has the characters); when no font has them, the
  receipt names a font file to import.
- `opacity` 0 under a fade-in warns; its next is `update_layer visible:false`.
- Errors, and in a real edit warnings except taste ones (they ride on the final's receipt), block final. On purpose:
  `{"op":"waive_check","code":"overlap","target":"*","reason":"meant"}`; a list or glob
  waives each match. `quote` (the person's words) and named layers, never `*`:
  what viewers see, `crop_no_subject`; whole-scene `held_static`, `text_slides`, `ending_seen`,
  `music_stall` the scene. `head_cut_off`, `narrow_window`, `soft_upscale`: named layers.
  Reason names: `ask_unmet` the origin word; `default_font`, `type_seen` a moment you
  labeled type (`yt:<id> @4.4`); `reference_range` its rows (dark footage: its fix is `lift_dark
  {layer}`). `shape_guess`: never. A second `reference_range` waiver for other rows keeps the first; any other code keeps two on one target when each passes `detail:"<word>"`.
- AI tells warn: `own_words` (no `source`), `stock_copy`,
  `same_entrance`, `word_by_word`, `soft_cuts`, `blurred_backdrop`, `text_glow`, `page_chrome`,
  `split_card_layout`, `seen_before`, `type_seen` (like a recent project's: set from references).
- Set `role` on layers (headline, cta, logo, hero, decor, `ui`: product text, contrast only)
  and `videoType`. Checker facts: `library {topic:"rules", name:"quality-settings"}`
  (roles, videoType, assertions, waivers, face and crop findings) `"quality-references"`
  (reference rules) and `"quality-final"` (board stop, final render).
- luma_jump, reading_time, hold, type_min, safe_zone turn to advice when 2+ saved, measured references go as far; past them, by how much.
- A slow linear move (under 4% of the frame diagonal a second) still running when its layer leaves passes linear_motion, text too: no waiver.

## Looking

- CLI: `kino look frame t=3 width=720`; a list is one word (`fields=x,width`).
- `sheet` (default): about 12 tiles a scene; with cuts, a tile or more a shot, labeled
  `2 · 1.42s` (24 shots at most; `from` shows the rest); several scenes: one frame each.
  `sheet {from, to}`: one stretch.
- look sheet, look review and check print `returns: <thing> at <times> (what changes)`: each made
  layer, word, image, move or shot shown at 2+ places, and what the first second and last frame
  share, ending `first and last picture alike: 0.85 (1 is the same picture)` with pixels on. A fact. A group, or layers named by number, counts as
  one device: `tread (4 layers) at 1 2 3 ×3`.
- `check` and `status` print `made: X% of the time, Y% of the frame area (N frames at 30 fps; footage and found clips never count; by time: type, graphic, cutout, particle, matte)` after `returns:`. Made: lettering that is not a caption, drawn shapes, layers a move placed, cut-outs on a new plate or with a look, particles, mattes. A caption and its pill print as `captions (not made): X% of the time, Y% of the area`; a cut-out over its own clip is not made. Then `deck: N of M cards unused (names)` and `your references' made labels by eye: a of b moments (p%)`. Area counts layer boxes (a cut-out's subject box), an upper bound; a turned panel counts its turned rectangle; a look on a cut-out over its own clip counts as made time but a guessed quarter of its box in area (`thin ink at a guessed quarter of its box`).
- `frame {t, width?}` (up to 1280 px; `zoom` for detail), `zoom {layer, t?}`, `strip {anim}`
  `compare {rev}`, `variants`. `changed` after an edit of several spans shows a frame in each, labeled `<t>s in <from>-<to>s`, and prints `N changed spans (scanned the whole scene against rev R)`; spans left out come back as a `look {mode:"frames", times:[...]}` call.
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
5. Saved references: with no `look {mode:"versus"}` in 10 revs, final runs it: rows by place
   (opening, loudest change, ending), gaps in fill, contrast, drift, range, softness, accent. A
   lost judge round blocks. Skip: `waive_check {code:"reference", target:"*", reason}`.

## Building in order

A rough whole scene first (often one `compose`), then at most 3 sections: 1 supporting parts, 2 motion and timing, 3
polish (color, type, sound). Each is one `edit`, then `look {mode:"sheet", from, to}` over its time; those looks are your pass. With the fixes in one more `edit` that is
at most 5 edits to build it; the storyboard, a redo the person asks for at a stop and a retry come on top.
