# Taste

What the checks measure, and how to keep a video small.

## Taste

- One hero per scene; it moves most. Supporting layers move less and follow it.
- Start 0.1–0.3 s after a cut. Exits take 55–75% of their entrance. No linear easing on
  position or scale, and no bounce on fades. A slow camera push may be linear and longer than
  the hero band: a custom animation (not an entrance or exit) of 2 s or more, position and
  scale only, on a layer that is not text and fills half the frame or more (a plate, the world
  group) or has role background, whose part on screen moves under 4% of the frame diagonal a
  second (e.g. 3 s from `{scaleX:1, scaleY:1}` to `{scaleX:1.12, scaleY:1.12}`; there is no
  `scale` value). Vary easing and duration by size.
- Text must be fully readable for characters ÷ 20 seconds, and should stay about 0.2 s per
  word + 2 s. Readable floor (`type_min`): body 3%, role headline 4% of the short side (32 and 43 px at 1080p); the face and size are the references' call.
- Use the brand's colors and fonts only. Keep text inside the 5% safe margin (9:16: clear of
  the app's top 14% and bottom 37%).
- Set `role` on layers (headline, cta, logo, hero, decor, …) and the project's `videoType`;
  the checks use them (`library {topic:"rules", name:"quality-settings"}`).

## Basics and style

- The rules above are basics: they hold for every video, and gates never change.
- Style is a choice: hard cuts or dissolves, whole lines or word-by-word captions, kicks on the
  beat or accents between beats, a held card or a moving frame. Take it from the references the
  person chose and write it as the style spec (the techniques reference); without one, check
  follows kino's default style and says so.
- Restraint: most shots are plain cuts on the voice or the beat. Pick one or two signature
  devices and repeat them at alike moments (a motif), not a new device per shot; spend designed
  moves on the hook, the reveal and the payoff. One type style throughout. Keep brightness
  steady across cuts (no bright shots between near-black ones).
- Vary pacing, type size and camera by section rather than adding set pieces. `busy_edit` warns
  past 3 devices, moves on over 40% of shots, over 2 text looks (a pink stream and a dim stream
  are two), or 3 bright-dark swings between shots (a dark end card aside). Fix by removing moves
  (`{op:"move", id, name, remove:true}`). `restraint` warns on a transition off a shot change,
  two grades on one layer at once, one footage moment shown twice, and letterboxed footage.
- With `fit_music` cues: `seam_lock` warns on a cut, accent or large move within 0.2 s of a song
  seam but over 1 frame off it, and on a drop or return with no change (a held shot that pans or
  punches in on it counts); only the video's scene is judged. `rest_fit` warns on a cut, accent or
  fast move inside a dropout, and on a picture that does not restart within 1 frame of the
  return. Start the shot or move at the cue's time; a hold, freeze or black suits a rest.
- Before you say done: `request_unmet` (in `check`) holds the final render while something the
  person asked for is missing (words in quotes, music, voice, captions, logo, sound effects, end
  card); notes it cannot read are listed: look at each. `look {mode:"motion", ref:"sound"}` ends
  with the cut list and the mix check (voice 6 LU over music, no clipping, no 10 LU jump at a
  clip edge, no 1 s silence, loudness range 8 LU or less for phone speakers).
- The older checks agree: `technique_repeat` lets a device repeat 2 or 3 times (a motif) and
  never counts plain cuts; `few_techniques` asks only for one signature device under 70 s (a flat
  edit); `vocabulary_budget` only holds the edit to the style bible's moves.
- Defaults nobody chose read as AI edited; each warns with its measure: `fade_only_entrances`
  (over 60% of 5+ layers coming on only fade or through a blur, blur+fade or blur-rise: cut in on a motion or the beat),
  `drift_on_every_shot` (every footage shot, 3+, drifts 0.5% to 5%: lock most off),
  `even_shot_lengths` (6+ shots spread under 0.6 stdev / mean, pro about 0.9: one long hold, a
  few quick cuts), `split_card_layout` (big type on one half, a framed card on the other over a
  flat frame for 4 s: fill the frame with the footage, the number on it) and `page_chrome`
  (small tracked caps labels or a row of thin bars over 8 s: say it with the voice or real UI).
- Never stack a small label (a kicker or eyebrow, often caps or the accent) right above a
  headline: `stacked_label` warns and its fix deletes the label. Let the headline stand alone.
- Give each cut a reason: a beat (half-beat grid or cue, within a frame), a word edge or pause, or the
  fastest point of a move (cut on action). `cut_motivation` warns when over 40% of 8+ cuts have none.

## Keep it small

- Every op you send costs tokens. A 15 s promo needs about 15–40 layers and 20–60
  animations, built in one or two edits.
- Show a feature with a few shapes (a card, an icon, one line of text). Do not draw a full
  app screen, a calendar grid cell by cell or rows of fake UI.
- Leave out fields that match the defaults (weight 400, line height 1.2, left aligned). Set
  the typeface your references chose; kino has no default type look.
- A card used several times is a component: build it once, insert copies (the building blocks
  reference has the example).
