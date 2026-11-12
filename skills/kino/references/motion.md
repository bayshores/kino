# Motion

What a still frame cannot show: a push, a dip, a sliver at the edge, a chopped move. `check`
judges it (the camera rules); `look` lets you see it.

## Motion checks

Camera rules read the model at 30 samples a second (no render).

- `linear_motion` (gate): constant speed on a move. Let alone: a slow push of a big layer, and an
  ambient drift (2 s or more, position or scale only, line art or a blended light layer, a corner
  under 3% of the frame width a second: 50 px over 3 s on 1920 wide is 0.9%). Faster, or a filled
  card, still eases.
- `lone_zoom` (gate): a clip or picture of 8% to 90% of the frame grows 12% in 0.5 s while the
  shot behind holds still. The shot behind is a full-frame plate, or a picture under it that
  covers its box or 30% of the frame (letterboxed footage counts). Under an 85% opaque layer it
  is not seen. Push that shot too, or group and push both. An entrance or exit, a flat brand
  color or a heavily blurred backdrop behind it is fine. The span ends when growth drops under
  2% in 0.1 s and stops slowing (a long ease-out is the push; an even drift after it is not).
- `edge_linger` (gate): a moving layer hangs as a sliver at the frame edge (under 25% of it and
  15% of the frame seen) for 0.3 s or more while it and its sliver crawl (under 0.25 frame
  widths a second). An ease-out exit that crawls off the edge counts. Auto fix: fade it out
  there; or make it leave at speed.
- `transition_dip` (warning): a dissolve fades both shots at once, so the frame dips under 85%
  covered. A fade through black (under 10%) is deliberate, and so is a quick dip (under 40%
  with the two fades overlapping under 30% of the shorter one). Fix: fade only the top shot.
- `cut_mid_move` (warning): a cut of a large layer while one side moves fast and the other is
  still. Cut after the move settles, or match the move across it. A move or entrance that starts
  on the incoming layer's first frame is begun by the cut and passes.
- `transitions_dense` (warning): over 2 large transitions in 6 beats. A full-frame shot's move
  from its own cut, and an effect (a glow) on a layer that stays on screen, are not transitions.
  With 2+ saved references that have measured cuts, the bound is how often they cut in that time.
- `speed_jump` (warning): where one move hands off to the next, the on-screen speed (place,
  scale at the corners, rotation) jumps over 5%. A still move or a gap between is a hold, not a
  jump, and an instant step (a `frame` cut) is a jump on purpose. Auto fix: same way on, it roves the pair (time shared by distance, one speed at the join);
  at a corner or a stop both sides ease to rest. Starts, ends and values stay.

## Seeing motion

- `look {mode:"motion", from?, to?}`: a graph and a text trace from the model (no render). One
  line a 0.5 s step: `cover` (1 = full-frame pictures cover the frame), `plate` (the top
  full-frame picture: scale rate, speed in frame widths a second, or `still`), the biggest
  other `mover`, an `edge` sliver of 0.1 s or more, footage cuts. The camera rules' findings
  are noted in full on the step they start in (`E lone_zoom 16.07-16.6s: ...`) and shaded red
  on the graph; other findings by code. Quiet steps merge. `more:` names the next call.
- `look {mode:"frames", from, to?}`: each 30 fps frame of a stretch, 6 a row (0.2 s), at most 36
  a call. `strip {anim, every:true}`: each frame of one animation.
- `look {mode:"review"}` adds seam rows: 5 frames from -0.2 to +0.2 s across each footage cut
  and each change of the top full-frame plate. A layer shown or hidden within 0.1 s of a cut
  shares its row. Look for a pop, a flash or a brightness jump across it.
- Workflow: `check` names the moment, `look motion` shows how it moves around it, `look frames`
  shows each frame there.

## Rendered motion

- `luma_jump` (gate): measured on rendered 64 px frames. Off a cut, the brightness moves 12+
  levels of 255 in 0.2 s as a large layer pops (an opacity or color change under 0.3 s), or a
  zoom or push transition jumps; or it dips or bumps 8+ past both shots mid-transition. A layer
  sliding or scaling in, a pop a moving mask or wipe bar reveals, and a transition where only its
  two shots show, covering the frame (their own pictures), are not judged. Fix: fade
  0.3 s+, keep the plate lit, or waive_check a planned beat. A flash is allowed: a flash transition or a light full-frame
  shape shown 0.35 s or less is planned, and `flashing` holds it to 3 a second.
- `frozen_picture` (gate): the rendered picture inside a playing clip's box (phones too)
  unchanged for 0.3 s+, sampled every 0.13 s; not repeating a `frozen_footage` finding. A clip
  hidden under a plate is not watched: a still graphic is `held_static`'s. A still placed on a
  sound hit or a spoken line only warns (not at the shot's own cut-in: that stays a gate).
  A hold with motion on or over it all through (an eased push, a shake, text animating, an
  effect) is alive; the fix is an eased push. A drawn hold under 2 s is yours to keep:
  `waive_check {code:"frozen_picture", target:"<layer>", reason:"drawn hold"}`.
- Scene drift (opt-in, worth it for footage and UI holds): `drift {dir:"auto", speed:0.02}`, a slow linear camera move
  (2% of the diagonal a second, push and slide, within the slow push) through each hold over
  0.8 s where nothing animates (one push per hold, never over 6 s or 12% of the diagonal from
  rest; later holds drift back); rests are skipped and the checker lets it be. `update_scene {properties:{drift:{dir:
  "in"|"left"|"right"|"up"|"down", speed:0.01-0.04}}}` sets it, `drift:false` turns it off.
  Screen-fixed overlays (a status-line badge, caption-words, captions) stay put while the
  picture drifts; the stack order is kept.
- A final render's receipt lists the file's stills (0.5 s+) and one-way brightness jumps off
  the scene's cuts and transitions.

## Inside the clip (warnings; each clip rendered alone, small)

- `source_jump`: a flash frame or camera jump in the file within 0.25 s of a clip's start or
  end (a change over 10% and 4x the usual). Fix: raise mediaOffset past it (start) or shorten
  mediaDuration (end); the finding names the file time. Costly: runs only when asked,
  `check {rules:["source_jump"]}`.
- `dark_under_title`: a display or headline title over a clip that is near black or flat for
  60% of its time. Pick a stronger part of the file, or put the title on a plain card on purpose.
- `low_fps_motion`: a large clip under 12 new frames a second (mediaFrameRate, or slowed with
  nearest frames) while it or its footage moves. Raise mediaFrameRate, or keep it still.
- `jump_cut` with pixels also needs the two pictures alike in framing and light.
