# Screens

Read before using app screenshots. A still screenshot held small is the most common reason a
launch film reads as a slide deck.

- Import measures each picture: `edges`, `flat` and `busy`, its busiest part as
  `[x, y, w, h]` in % of the picture. kino treats it as a screenshot when it is mostly flat
  fills with sharp edges between them, wider than tall or phone-shaped.
- `device-slide` with a screenshot pushes slowly into its busy part while it holds (up to 18%).
  `region:[x, y, w, h]` on the beat names the part that matters (what the voice or text talks
  about); `region:false` drops the push (frozen_screen still suggests one after 2.5 s).
- `feature-callout` with a screenshot pushes it the same way while its card drifts, never past
  the card's edge. It stays small beside its words: for a screen to read, use `screen-detail`.
- `screen-detail` fills the frame with the screenshot, pushes into `region` (else its busy
  part), dims and softens the rest and lifts that part on a shadow. Use it for the one feature
  a beat is about.
- `move {name:"cursor", to:"app-find", at}` points at a real button: split_image the
  screenshot first so each button is its own piece (never draw a button). A crisp macOS
  arrow with a soft shadow glides in from below right on an eased arc (longer legs take longer),
  squishes 3% at the click while the piece presses 2.5%; cue `<id>.click` (then `.click2`).
  `to` may be [x, y] scene pixels, {layer, point:[x%, y%]} or a list visited in turn; `point`
  sets where in a layer (default the middle), `click:false` only hovers, `state` arrow, hand or
  grab, `size` px (default 6% of the short side), `from` [x, y], `hold` 0.6 s then it fades.
  `drag:"app-card"` grabs that layer (the hand closes, cue `.grab`), it lifts 3% and follows
  the pointer 0.07 s behind to the last `to`, above what it crosses, then drops (cue `.drop`).
  Refused when the target is hidden at the click, or it or its group is turned (ui-plane):
  give `to:[x, y]` in scene pixels then.
- Show one idea per screen: crop or push in until its words can be read, rather than showing the
  whole app small.

## What check says

- `frozen_screen`: a screenshot over 8% of the frame that grows under 3% and moves under 1.5% of
  the frame diagonal in some 2.5 s, with nothing moving over it (a cursor, type or a callout
  moving over it is fine; an eased push counts by its average speed, so its slow ends are fine). `check {fix:"auto"}` turns its hold into a push of 6 to 18% into
  the busy part (never past 1.95 drawn pixels a file pixel).
- `screen_unreadable`: a screenshot drawn under 55% of its width (half a 2x capture's) for over 1.5 s, unless it
  pushes in 1.4x while shown or a cropped copy (screen-detail's lifted part) shows the detail.
  `check {fix:"auto"}` pushes it 1.45 to 1.7x into the busy part; when that would cover words,
  leave its card or the frame, it hints: `screen-detail`, `region`, or a larger crop.
- A phone screenshot shown small for under 1.5 s is fine; so is a screen recording that plays.
