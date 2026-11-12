# Check and look

`check` measures; `look` shows. Both read the saved project.

Contents: Check · Polish · Looking · Review before final · Building in order

## Check

- Each finding says what it measured, what is required and a fix op. A rule's exact limits:
  `library {topic:"rules", name:"quality", search:"<code>"}`.
- `check {fix:"auto"}` applies the `(auto)` fixes in one edit (skipping one that adds an error
  or keeps its finding), re-checks, up to 3 rounds: call it once. A warning's fix skips layers
  your last edit moved, a waiver names or a spine beat uses.
- After an edit, `check {}` redraws only the frames the edit touches (seconds), and a check of an
  unchanged scene answers from the last one, also while `reference_drift` runs.
- First `check` ends with `Rules:`; a same-rev repeat is 1 line (`{rules:true}`: all).
- The first 8 lines of `check`, `look` versus and review, and `status` lead with what decides your
  next call (errors, advice, drift, `whole scene:`, inbox); the rest is detail.
- Footage: `speech_cut` (a voice cut mid-word: sound reference), `soft_upscale` (drawn over 1.3x
  its file), `crop_no_subject` (cropped, no subject marked), `head_cut_off` (Mac), `jump_cut`
  (one file framed alike back to back), `frozen_footage` (picture stops 0.3 s+: start earlier,
  mediaSpeed 0.85+, or cut away), `out_of_sync` (a line over another moment of a synced file).
- `covered_layer`: a solid shape, mp4 or jpg above hides a layer (png, webm, mov may be clear).
- Motion rules (camera, brightness, frozen pictures): motion reference.
- Contrast: under 0.2 s warns, longer is an error; the fix tries a scrim, a halo
  shadow, a darker place, a large-text size, then a plate.
- `default_font` fix: `library {topic:"fonts", search:"<first type label's words>"}`.
- Errors, and in a real edit warnings except taste ones (they ride on the final's receipt), block final. On purpose:
  `{"op":"waive_check","code":"overlap","target":"*","reason":"meant"}`; a list or glob
  waives each match. `quote` (the person's words) and named layers, never `*`:
  what viewers see, `crop_no_subject`; whole-scene `held_static`, `text_slides`, `ending_seen`,
  `music_stall` the scene. `head_cut_off`, `narrow_window`, `soft_upscale`: named layers.
  Reason names: `ask_unmet` the origin word; `default_font`, `type_seen` a moment you
  labeled type (`yt:<id> @4.4`); `reference_range` its rows (dark, text...). `shape_guess`: never.
- AI tells warn: `own_words` (no `source`), `stock_copy`,
  `same_entrance`, `word_by_word`, `soft_cuts`, `blurred_backdrop`, `text_glow`, `page_chrome`,
  `split_card_layout`, `seen_before`, `type_seen` (like a recent project's: set from references).
- Set `role` on layers (headline, cta, logo, hero, decor, `ui`: product text, contrast only)
  and `videoType` (`library {topic:"rules", name:"quality-settings"}`).
- luma_jump, reading_time, type_min, safe_zone turn to advice when 2+ saved, measured references go as far (flashes, shortest text hold, smallest line, edge); past them they say by how much.
- A slow linear move (under 4% of the frame diagonal a second) still running when its layer leaves (cut, hide, fade out, scene end) passes linear_motion, text too: no waiver.

## Polish

What a viewer calls sloppy though gates pass: fix it. Each has an automatic fix
(`check {fix:"auto"}`) but render_artifact.

- Type: `font_fallback` (gate, a face kino has not loaded), `text_collision` and `text_ghost`
  (gates: texts touch or mix), `text_wrap` (a lone word or punctuation on a line),
  `type_min` (gate: body 3%, headline 4% of the short side; a URL is body), `off_brand_font`,
  `role_font_drift` (one family per role, one caption size per voice; never a font nobody chose).
- Framing: `cut_off_at_rest` (inside the 5% margin), `judder` (a big layer panning fast
  unblurred: motion blur).
- `held_static`: nothing moves for 1.5 s+. Fix: one slow move per hold. An end card still over
  4.5 s is an error. A planned still (end mark, black): `update_scene {rests:[{at, until}]}` (4 s in all).
- Warned: vocabulary_budget, brand_consistency, story_stall, hook_readable, ending_count,
  accent_budget, `text_only_open`, `pacing_jump` (cut rate 3x, unless a cue, sound or spine edge
  explains it).
- Rendered (`check` only): `text_on_busy` (words over busy detail), `small_on_empty` (a small
  picture on a flat frame), `render_artifact` (an RGB split drawing flat slabs).
- The fixes: a missing face takes the nearest loaded weight, else the brand font; the lesser
  text (a caption, else the later) moves to a free safe place; a wrap gets a width that fits or
  balances; a cut-off picture scales inside the margin; busy text moves to a calm place, else
  gets a plate; a small picture grows and crops; an RGB split softens to 40%.

## Looking

- CLI: `kino look frame t=3 width=720`; a list is one word (`fields=x,width`).
- `inspect {targets, fields}`: `color` answers with `fill`,
  `size`: `width`, `height`.
- `sheet` (default): about 12 tiles a scene; with cuts, a tile or more a shot, labeled
  `2 · 1.42s` (24 shots at most; `from` shows the rest); several scenes: one frame each.
  `sheet {from, to}`: one stretch.
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
- Motion blur, smear or shutter: {op:"update_project", properties:{shutterAngle:180}} draws it in look frames, sheets and drafts (up to 6 moments a frame); 0 or none stays sharp.

## Review before final

`check` misses what only eyes catch (a subject cut off). The QC loop:

1. `edit`, then read the receipt: `newFindings` (at most 5, codes and times) are what it
   brought in; fix them next.
2. `look {mode:"review"}` (a scene; `from`/`to` for a stretch) picks the moments that matter
   (cuts, effects, moves, text landing, quiet stretches), riskiest full size. Each tile: the
   frame, its time, what happens, findings in yellow. Cuts add seam rows (motion reference).
3. Study every frame for type, wrapping, overlaps, framing, empty space and artifacts. Fix them all in one `edit`.
4. `look {mode:"review"}` again shows only the moments whose picture changed.
5. A final render does not wait for look review; its receipt names the moments not yet reviewed
   as they are now. Review before it anyway.
6. Saved references: with no `look {mode:"versus"}` in 10 revs, final runs it: rows by place
   (opening, loudest change, ending), gaps in fill, contrast, drift, range, softness, accent. A
   lost judge round blocks. Skip: `waive_check {code:"reference", target:"*", reason}`.

## Building in order

Get a rough whole scene first (layout, background and the main subject, often one
`compose`), then build in at most 3 sections, a designer's order: 1
supporting parts, 2 motion and timing, 3 polish (color, type, sound). Each section is one
`edit`, then `look {mode:"sheet", from, to}` at the time it covers before the next one;
those looks are your pass. With the fixes in one more `edit` that is
at most 5 edits to build it; the storyboard, a redo the person asks for at a stop and a retry come on top.
