# Techniques and the style spec

Agents left alone make the same edit: hard cuts, text cards, a kick on every beat. kino names
the techniques, finds them in your video and lets references set the style.

Contents: The vocabulary · The style spec · What check measures · The deck · Treatments · Building with techniques

## The vocabulary

50 tags in 6 groups. `library {topic:"techniques", name?}` lists them, or one. `*` marks ones check cannot find in a document yet.

- **transition**: cut, match-cut*, dissolve, fade-black, blur-through, zoom-through, whip-pan,
  mask-wipe, glitch-hit, flash, push-transition
- **camera**: slow-push, drift, parallax, orbit-3d, speed-ramp, freeze-frame, shake
- **type**: type-cut, type-fade, type-slide, type-pop, type-words, type-letters,
  type-mask-rise, type-blur-in, type-giant, type-counter, type-swap, type-kinetic
- **texture**: speed-lines, particles, rgb-split, light-sweep, grain, vignette, depth-blur, motion-blur
- **set piece**: tile-ring, clip-field*, draw-on, swipe-cards, logo-match-move, status-line, split-screen,
  device-in-scene*, screen-zoom (read from the `move` that built them)
- **rhythm**: beat-cut, beat-kick, syncopated, hold

After its findings, every check answer lists the techniques the video uses, most used first:
`techniques: cut 12, type-pop 5, slow-push 2 · style: kino default`.

How kino finds them (from the document, not the pixels):

- A dissolve: two full-frame pictures whose opacities cross, or two floating clips fading one
  into the other in place. A fade-black fades through a dark background.
- blur-through, zoom-through (25% or more of scale into or out of the change), whip-pan (a fast
  slide with a directional blur) and push-transition (both pictures slide the same way) are read
  at each change of full-frame picture.
- slow-push and drift are slow scales and moves (1.2 s or more) of a layer filling 40% of the
  frame; parallax: two layers moving slowly, 1.5 times apart in speed.
- type-* is how each text enters: by words or letters with a stagger, a fade, a slide, a scale
  (pop), a blur, a reveal (mask-rise), or nothing (type-cut).
- beat-kick: 3+ pulses of a layer (1-10%, back in 0.4 s); depth-blur: a blurred full-frame
  picture behind sharp things; screen-zoom: a video scaled 2x in 1 s.

## The style spec

Write it on the brief once you know what the references do (library inspire, the person's
words). It says which techniques the video wants and avoids:

```json
{"tool":"notes","action":"brief","fields":{"style":{"wants":["type-words","dissolve","slow-push"],"avoids":["beat-kick"],"lines":[{"text":"lowercase captions, word by word","ref":"yt:3VHoNjrUD4Q","at":8.2,"tags":["type-words"]},{"text":"dissolves between screen recordings","ref":"yt:3VHoNjrUD4Q","at":21.5,"tags":["dissolve"]}],"by":"guessed"}}}
{"tool":"library","topic":"techniques","name":"zoom-through"}
{"tool":"notes","action":"brief","fields":{"style":{"wants":["disolve"],"by":"guessed"}},"expect":"bad_input"}
```

- `wants` and `avoids` take tags only; an unknown tag is refused with the closest one.
- `lines` (up to 8): what a reference does, `ref` (yt:<id>, a file, a link), `at` (the second
  it happens) and the `tags` that moment shows.
- `by:"you"` with `quote` when the person asked for the style in their own words; else
  `"guessed"`. Their spec is never replaced by a guess.
- Saving it keeps a confirmed brief confirmed, like `idea`.

**Only backed wants change rules.** A wanted tag turns rules off when the spec is `by:"you"`, or
when a line with `ref` and `at` names it in `tags`. A guess with no reference is shown but
turns nothing off. Write the time you saw it.

What a backed want does:

| Wanted | Effect |
|---|---|
| dissolve, fade-black | `soft_cuts` is off (blur-through does not turn it off) |
| type-words, type-letters | `word_by_word` off, typing keeps its stagger |
| depth-blur | `blurred_backdrop` is off |
| beat-kick | `beat_kick` is off |
| hold | `text_slides` is off |
| the entrance every text uses | `same_entrance` is quiet |
| any tag | `technique_repeat` lets it repeat; `style_wanted` warns when it is not used |

An avoided tag used is a gate (`style_avoided`) only if the person banned it. The other gates (reading time,
type size, contrast, safe zone, overlap, flashing, linear motion and the rest) never change with
the spec. With no spec, check follows kino's default style and says `style: kino default`.

## What check measures

Warnings (style_avoided a gate); each fix names techniques that fit, never "add motion". `text_slides` and
`few_techniques` leave videos under 8 s (a title card, a sting) alone.

| Rule | Flags | Required |
|---|---|---|
| `text_slides` | text over a picture that does not move (no clip playing, no camera move) | 25% of the video at most, no card over 3 s but the closing one |
| `few_techniques` | a flat edit: no designed device (cut, type-cut, hold, beat-cut, syncopated don't count) | 1 under 70 s, then 2, 4 at most |
| `plain_beats` | the hook, reveal or payoff (else first, last 2.5 s) of only footage, words and plain cuts, fades, blurs or freezes | a move on one; all plain holds the final render |
| `technique_repeat` | monotony: a set piece over 3 times; one non-cut transition on 4+, 75% of changes, no plain cut; a loud accent (flash, whip-pan...) over 3 times or once per 15 s; one entrance on 75% of texts | 2-3 alike uses: a motif |
| `metronome` | shots within 20% of one length, or 90% of cuts on the beat at one count | |
| `beat_kick` | the same small scale pulse 6 times or more | 5 alike at most |
| `flat_sections` | next sections alike in 3 of: cut rate, motion, picture (footage, dark, light), framing scale | differ in 2 |
| `style_avoided` | a technique the spec avoids, used | |
| `style_wanted` | a backed wanted technique not used (hard cuts stay free) | |
| `off_beat` | an accent 1 frame to 70 ms off a beat: a near miss | on it, or clearly between (syncopated) |
| `deck_unused` | fewer than half of the deck's cards used (a card swapped out does not count) | half or more |

## The deck

Once a treatment is picked (or waived), kino deals a hand: one or two techniques per group
(transition, camera, type, texture), at most one set piece (a move). `status` shows it:
`deck (seed 4821): dissolve, parallax, type-words, depth-blur, set piece: zoom-through; swaps left 2`.
The seed is the project's plus the reroll count. The deal:

- puts a backed spec's wanted tags first and never deals an avoided one;
- fits the material: no phone cards without a phone or screen recording, no type-heavy cards
  for footage without words, no speed ramp without video;
- steers away from what the last 3 projects were dealt and used;
- never deals plain cuts, plain text, beat kicks, or both type-pop and slow-push.

Build each card where it fits. One that does not: swap it with the reason (2 a deal). None fit:
deal again.

```json
{"tool":"notes","action":"deck"}
{"tool":"notes","action":"deck","reroll":true}
{"tool":"notes","action":"deck","swap":{"out":"particles","in":"light-sweep"},"expect":"bad_input"}
```

`variants {vary:"deck"}` remakes a composed scene with the next 3 decks; `look
{mode:"variants"}` shows their first 8 s side by side; `pick_variant` makes that deck the
project's. Recipes and compose take the project's seed when you give none.

## Treatments

Before building, write 5 treatments (idea, signature move, rhythm, `source`: the file or screen
it uses, never words alone) with `p`, how typical (0 to 1). kino shows the 3 least typical (A, B, C). Save the pick
with their words (under "just start", yours, no quote): it sets `style.idea` and drafts the
first signature (spine.md). A first build before is `order_needed`; waive_check code
"treatments" skips it.

```json
{"tool":"notes","action":"brief","fields":{"treatments":[{"idea":"dawn montage","move":"slow pushes","rhythm":"even","p":0.6},{"idea":"one board's day","move":"match cuts","rhythm":"builds","p":0.15},{"idea":"a map draws it","move":"mask-wipe","rhythm":"steady","p":0.1,"source":"route.mp4"},{"idea":"tricks frozen","move":"freeze-frame","rhythm":"stop-go","p":0.25},{"idea":"street sounds lead","move":"cut on sounds","rhythm":"offbeat","p":0.05}]}}
{"tool":"notes","action":"brief","fields":{"treatments":{"pick":"B","quote":"the map one"}}}
```

## Building with techniques

- Read what the references do before building: name 4 to 8 techniques with the times you saw
  them, and write the spec.
- Give each section a different mix: a calm section with drift and type-fade, then a fast one
  with beat-cut and type-giant. `flat_sections` checks that sections differ.
- Keep set pieces and loud accents for the moments that matter: one zoom-through into the
  product, one glitch-hit on the drop.
- A slow-push or drift under text turns a slide into a shot; depth-blur behind floating clips
  gives depth without new footage.
- Kicks and flashes on every beat read as a tic. Pick the 2 or 3 biggest hits.
