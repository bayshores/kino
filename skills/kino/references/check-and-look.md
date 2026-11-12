# Check and look

`check` measures; `look` shows. Both read the saved project.

Contents: Check · Polish · Looking · Review before final · Building in order

## Check

- Each finding says what it measured, what is required and a fix op. `check {fix:"auto"}`
  applies the `(auto)` fixes in one edit (skipping one that adds an error or keeps its finding),
  re-checks, up to 3 rounds: call it once. A warning's fix skips layers your last
  edit moved, a waiver names or a spine beat uses.
- First `check` ends with `Rules:`; a same-rev repeat is 1 line (`{rules:true}`: all).
- `speech_cut` (gate, a voice cut mid-word): the sound reference.
- `soft_upscale`: a picture drawn bigger than its file (over 1.3x warns, over 2x a gate; fast
  zooms, heavy blur left alone). `crop_no_subject`: footage cropped over 8%, no subject
  marked, warns; a marked subject under 85% in frame is a gate. `head_cut_off` (Mac): a head
  out of the picture 1 s: play another part or move it.
- `jump_cut` (warns): back-to-back shots of one file framed alike: cut away or punch in.
- `frozen_footage` (gate): a clip's picture stops 0.3 s+ (speed 0, a held frame, a still in its
  place). Start it earlier, slow it (mediaSpeed 0.85+), or cut away. A freeze on a sound hit or a
  line's first word warns.
- `out_of_sync` (gate): a line over a synced file's picture of another moment: the fix retimes it.
- `covered_layer` (warns): a solid shape, mp4 or jpg above hides a layer all its time on screen
  (a png, webm or mov may be clear). Fix: move it above; `(auto)`: a full-frame overlay.
- Motion rules (camera, brightness, frozen pictures): motion reference.
- Contrast: failing under 0.2 s warns, longer is an error; the fix tries a scrim, a halo
  shadow, a darker place, a large-text size, then a plate.
- Errors, and in a real edit warnings, block final. On purpose:
  `{"op":"waive_check","code":"default_font","target":"*","reason":"brand font"}`. A list or
  glob (`"arch-*"`) waives each matching layer. These need `quote` (the person's words) and
  named layers, never `*`: what viewers see (small screens, frozen pictures, template ends),
  `crop_no_subject`, `shape_guess`; whole-scene `held_static`, `text_slides`, `ending_seen`,
  `music_stall` take the scene (`"s1"`). `head_cut_off`, `narrow_window`: named layers, no
  quote. `ask_unmet`: the reason names the origin word.
- AI tells warn: `own_words` (no `source`), `stock_copy`,
  `same_entrance`, `word_by_word`, `soft_cuts`, `blurred_backdrop`, `text_glow`, `page_chrome`,
  `split_card_layout`, `seen_before`, `type_seen` (like a recent project's: set from references; waive naming `yt:<id>`).
- Set `role` on layers (headline, cta, logo, hero, decor, `ui`: product text, contrast only)
  and `videoType` (`library {topic:"rules", name:"quality-settings"}`).

## Polish

What a viewer calls sloppy though gates pass: fix before showing.

Each has an automatic fix (`check {fix:"auto"}`) but render_artifact:

- `font_fallback` (gate): the text asks for a face kino has not loaded. Fix: the nearest loaded
  weight, else the brand font, else the face it draws now (or `set_font` the exact face).
- `text_collision` (gate): two texts touch, or a text runs into another text's plate
  (a pill). Fix: the lesser one (a caption, else the later) moves to a free safe place, else
  leaves before. `text_ghost` (gate): two words crossfading in one place mix. Fix: the new
  one starts once the old is gone.
- `judder`: a layer over 20% of the frame pans 0.14+ frame widths a second unblurred (30 fps
  or less). Fix (auto): motion blur while fast, on the group that moves it.
- `text_wrap`: punctuation alone on a line or a one-word title broken (errors); a 2 or 3 word
  title stacked by the wrap, or one short word under a long line (warnings). Fix: a width that
  fits one line or balances the lines, or for 1 to 3 words a smaller size (not under type_min's floor).
- `cut_off_at_rest`: a picture, clip or phone at rest inside the 5% margin or cut by the edge.
  Fix: moved or scaled about its middle inside the margin.
- `held_static`: nothing moves for over 1.5 s (1% of the diagonal a second, 0.4% for a picture
  filling 30%; a clip, effect or fade counts). Fix: one slow move per hold (push, drift, letters
  spread). End card still 3 s+: a push on the whole card (auto); over 4.5 s (a push counts as
  still) an error: end sooner, add an element or end the song; silent over 5 s: cut to 2.5 s.
  A planned still (end mark, black): `update_scene {rests:[{at, until}]}` (4 s in all).
- `off_brand_font`: text outside the brand's fonts (`set_brand {fonts}`, or a family the brief
  names); with no brand, a third type family. Fix (with a brand): `set_font` to the brand font
  at the nearest weight it has, headlines to the first.
- `role_font_drift`: one family per role (display, stat, speech, caption), one caption size
  per voice (caption track or color), warns. Warned: vocabulary_budget, brand_consistency, story_stall,
  hook_readable, ending_count, accent_budget, `text_only_open` (3 s+ of text before any
  picture or logo), `pacing_jump` (cut rate 3x, unless a cue, sound or spine edge is within
  1 s and the new pace holds 12 s).
- `type_min` (gate): body 3%, `role` headline 4% of the short side (32, 43 px at 1080p);
  a URL or @handle is body. Fix: grow size and box.
- Rendered (`check` only): `text_on_busy` (words over a phone, screen recording or sharp
  detail; fix: the nearest calm place beside it, all parts of a caption together, else a plate
  under the text), `small_on_empty` (a picture under 25% of a flat frame, 40% for footage, for
  1.5 s; fix: grow and crop, add a scene or move the camera), `render_artifact` (an RGB split
  drawing flat slabs; the fix softens it to 40%, or delete the animation).

## Looking

- CLI: `kino look frame t=3 width=720`; a list is one word (`fields=x,width`).
- `inspect {targets, fields}`: `color` answers with `fill`,
  `size`: `width`, `height`.
- `sheet` (default): a scene in about 12 tiles; with cuts, one or more a shot, labeled
  `2 · 1.42s` (at most 24 shots; `from` shows the rest). With several
  scenes and none named, one frame a scene. `sheet {from:60, to:120}`: one stretch.
- `frame {t, width?}` (up to 1280 px; `zoom` for detail), `zoom {layer, t?}`, `strip {anim}`
  (`every:true`: each frame), `compare {rev}`, `changed`, `variants`.
- `motion {from?, to?}` (a graph and trace, no render) and `frames {from, to?}` (each 30 fps
  frame): the motion reference.
- `source {layer, t?}`: a video layer's whole source frame at scene time t (default: the middle
  of its time on screen), a 10% grid, the crop as a dashed box, the subject boxes (`agent`:
  yours, from `mark_subject`; `vision`: Apple Vision, Mac only) and the result. The text gives
  the shot, the crop in % and each box's share. Not your last look for `changed`.
  Cropping: the framing reference.
- `board {page?}`: the storyboard, 4 shots a page, with numbers (storyboard reference).

## Review before final

`check` misses what only eyes catch (a subject cut off). The QC loop:

1. `edit`, then read the receipt. `newFindings` names the findings that edit brought into the
   stretch it changed (codes and times, at most 5): fix them in the next edit.
2. `look {mode:"review"}` (a scene; `from`/`to` for a stretch) picks the moments that matter
   (cuts, effects, moves, set pieces, text landing, quiet stretches),
   ranks them by risk (risky ones full size, 2 across; the rest compact, 4 across). Each tile is the whole frame with its time, what
   happens and findings in yellow. Cuts add seam rows (the motion reference).
3. Study every frame for type, wrapping and orphans, overlaps, framing, empty space and
   artifacts. Fix them all in one `edit`.
4. `look {mode:"review"}` again shows only the moments whose picture changed.
5. `render {quality:"final"}` of the whole video is refused (`review_needed`) until every moment
   is reviewed as it is now. Drafts, stills (png) and scenes under 5 s are not gated. A
   skip: `waive_check {code:"review", target:"s1", reason}`.
6. Saved references: final needs `look {mode:"versus"}` in the last 10 revs (`reference_needed`):
   rows by place (opening, loudest change, ending, rest by position), same kind first; a pin
   on its shot; a still on 2 rows at most; their labels. Gaps: fill, contrast, drift, range. A lost
   judge round blocks. Skip: `waive_check {code:"reference", target:"*", reason}`.

## Building in order

Get a rough whole scene first (layout, background and the main subject, often one
`compose`), then build it up in at most 3 sections, in the order a designer would: 1
supporting parts, 2 motion and timing, 3 polish (color, type, sound). Each section is one
`edit`, then `look {mode:"sheet", from, to}` at the time it covers before the next one;
those looks are your pass. With the fixes in one more `edit` that is at most 5 edits to build
it; the storyboard, a redo the person asks for at a stop and a retry come on top.