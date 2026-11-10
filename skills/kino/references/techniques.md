# Techniques and the style spec

kino names the techniques, finds them, and lets references set the style.

Contents: The vocabulary · The style spec · What check measures · The deck · Treatments · Building with techniques · Effects need a reason

## The vocabulary

56 tags in 6 groups; `library {topic:"techniques", name?}` lists them. `*`: check cannot find it yet.

- **transition**: cut, match-cut*, dissolve, fade-black, blur-through, zoom-through, whip-pan,
  mask-wipe, glitch-hit, flash, push-transition
- **camera**: slow-push, drift, parallax, orbit-3d, speed-ramp, freeze-frame, shake
- **type**: type-cut, type-fade, type-slide, type-pop, type-words, type-letters,
  type-mask-rise, type-blur-in, type-giant, type-counter, type-swap, type-kinetic
- **texture**: speed-lines, particles, rgb-split, light-sweep, grain, vignette, depth-blur, motion-blur
- **set piece**: tile-ring, clip-field*, draw-on, swipe-cards, logo-match-move, status-line, split-screen,
  device-in-scene*, screen-zoom, type-behind (read from the `move` that built them)
- **rhythm**: beat-cut, beat-kick, syncopated, hold

check lists those used (`techniques: cut 12, type-pop 5`), read from the document:

- dissolve: opacities of two pictures cross; fade-black dips through dark. blur-through,
  zoom-through (25%+ scale), whip-pan and push-transition are read at each full-frame change.
- slow-push, drift: a slow move (1.2 s+) of a layer filling 40%; parallax: two, 1.5x apart.
- type-*: how a text enters (words, letters, fade, slide, pop, blur, mask-rise, or cut).
- beat-kick: 3+ pulses (1-10%, back in 0.4 s); depth-blur: a blurred picture behind sharp
  ones; screen-zoom: a video scaled 2x in 1 s.

## The style spec

Write it on the brief once you know what the references do: the techniques the video wants
and avoids.

```json
{"tool":"notes","action":"brief","fields":{"style":{"wants":["type-words","dissolve","slow-push"],"avoids":["beat-kick"],"lines":[{"text":"lowercase captions, word by word","ref":"yt:3VHoNjrUD4Q","at":8.2,"tags":["type-words"]}],"by":"guessed"}}}
{"tool":"library","topic":"techniques","name":"zoom-through"}
{"tool":"notes","action":"brief","fields":{"style":{"wants":["disolve"],"by":"guessed"}},"expect":"bad_input"}
```

- `wants` and `avoids` take tags only; an unknown one is refused, naming the closest.
- `lines` (up to 8): what a reference does, `ref` (yt:<id>, a file, a link), `at` (the second
  it happens) and the `tags` that moment shows.
- `by:"you"` with `quote` when the person asked in their words; else `"guessed"`, which never
  replaces theirs. Saving it keeps a confirmed brief confirmed.

**Only backed wants change rules.** A wanted tag turns rules off when the spec is `by:"you"`, or
when a line with `ref` and `at` names it in `tags`. A guess with no reference turns nothing off.

What a backed want does:

| Wanted | Effect |
|---|---|
| dissolve, fade-black | `soft_cuts` is off (blur-through does not turn it off) |
| type-words, type-letters | `word_by_word` off, typing keeps its stagger |
| depth-blur | `blurred_backdrop` off, `text_slides` ignores blur |
| beat-kick | `beat_kick` is off |
| hold | `text_slides` is off |
| the entrance every text uses | `same_entrance` is quiet |
| any tag | `technique_repeat` lets it repeat (not loud accents); `style_wanted` wants it |

An avoided tag used is a gate (`style_avoided`) only if the person banned it. Other gates never
change with the spec.

## What check measures

Warnings (style_avoided a gate); each fix names techniques that fit. `text_slides` and
`few_techniques` leave videos under 8 s alone.

| Rule | Flags | Required |
|---|---|---|
| `text_slides` | text over a still, or dimmed or blurred footage, no sharp 20% screen on top | 25% at most, no card over 3 s bar the last |
| `few_techniques` | a flat edit: no designed device (cut, type-cut, hold, beat-cut, syncopated don't count) | 1 under 70 s, then 2, 4 at most |
| `plain_beats` | the hook, reveal or spine payoff (else first, last 2.5 s) of only footage, words, plain cuts, fades, blurs, freezes | a move on one; all plain holds the final render |
| `technique_repeat` | monotony: a set piece over 3 times; one non-cut transition on 4+, 75% of changes, no plain cut; a loud accent over 3 times or once per 15 s; one entrance on 75% of texts | 2-3 alike uses: a motif |
| `metronome` | shots within 20% of one length, or 90% of cuts on the beat at one count | |
| `beat_kick` | the same small scale pulse 6 times or more | 5 alike at most |
| `flat_sections` | next sections alike in 3 of: cut rate, motion, picture (footage, dark, light), framing scale | differ in 2 |
| `style_avoided` | a technique the spec avoids, used | |
| `style_wanted` | a backed wanted technique not used (hard cuts stay free) | |
| `off_beat` | an accent 1 frame to 70 ms off a beat: a near miss | on it, or clearly between (syncopated) |
| `deck_unused` | fewer than half of the deck's cards used (a card swapped out does not count) | half or more |
| `effect_fit` | music edit: loud effect on no cue, too big, over budget, stacked, on a talking face | auto removes; waive with cue:<name> |

## The deck

Once a treatment is picked (or waived), kino deals a hand: one or two techniques per group
(transition, camera, type, texture), at most one set piece (a move). `status` shows it
(`deck (seed 4821): dissolve, parallax, ...; swaps left 2`). The deal:

- puts a backed spec's wants first, never an avoided tag;
- fits the material: no phone cards without a phone or recording, no type-heavy cards for
  footage without words, no speed ramp without video;
- steers away from the last 3 projects' decks; never deals plain cuts, plain text, beat kicks,
  or both type-pop and slow-push.

Build a card where it fits; swap a misfit with a reason (2 a deal) or reroll.

```json
{"tool":"notes","action":"deck"}
{"tool":"notes","action":"deck","reroll":true}
{"tool":"notes","action":"deck","swap":{"out":"particles","in":"light-sweep"},"expect":"bad_input"}
```

`variants {vary:"deck"}` remakes a composed scene with the next 3 decks; `look
{mode:"variants"}` compares them; `pick_variant` keeps one.

## Treatments

Write 5 stories first: idea, `who` (whose want or fear drives it; 3+ different),
`tension` (what they want, fear or wonder), `turn` (the on-screen flip), move, `ending` (the
last image, from this material), `type` (the type and how it appears, from your references, such as
"small serif captions, each word cut on"; kino has no default type), `source` (file or screen
used), `p` (0 to 1: how typical).
kino shows the 3 least typical, one per who: `A. idea · who: tension → turn · ends on ending · type: type`.
The pick (their words; under "just start" yours with `why`) sets `style.idea`, `style.type`, the first
signature and the spine's end; the lock's fonts name the faces for the type. Building first is `order_needed`; waive_check "treatments" skips it.

```json
{"tool":"notes","action":"brief","fields":{"treatments":[{"idea":"dawn","who":"the city","tension":"asleep?","turn":"first wheels","move":"pushes","ending":"noon","type":"serif, cut on","p":0.6,"source":"dawn.mp4"},{"idea":"one board","who":"a kid","tension":"whose?","turn":"he lands it","move":"match cuts","ending":"his","type":"serif, cut on","p":0.15,"source":"crew.mp4"},{"idea":"a map","who":"the crew","tension":"where to?","turn":"loop closes","move":"mask-wipe","ending":"map","type":"serif, cut on","p":0.1,"source":"route.mp4"},{"idea":"tricks","who":"a skater","tension":"lands it?","turn":"a fall","move":"freeze","ending":"laugh","type":"serif, cut on","p":0.25,"source":"tricks.mp4"},{"idea":"sounds","who":"you","tension":"that noise?","turn":"wheels on beat","move":"sound cuts","ending":"beat","type":"serif, cut on","p":0.05,"source":"street.wav"}]}}
{"tool":"notes","action":"brief","fields":{"treatments":{"pick":"B","quote":"the map one"}}}
```

## Building with techniques

- Before building, name 4 to 8 techniques the references use, with times; write the spec.
- Each section gets its own mix (calm: drift, type-fade; fast: beat-cut, type-giant);
  `flat_sections` checks it.
- Set pieces only where they matter; a slow-push under text turns a slide into a shot.

## Effects need a reason

Every effect needs a cue that motivates it. Placed by beat number, seed or habit, a flash or
shake reads as decoration. Reference counts are ceilings, not targets; none of a device is fine.

- Flash: light rising in the shot, a song seam or a top accent. Shake, impact frame: a contact
  in the footage. Dip: a rest. Strobe: a measured drum fill. `move {name:"impact-accent", kind,
  at:"cue:<name>"}` refuses any other cue and names one that fits; size follows its weight.
- The picture may come 2 frames early, never late. Slow motion holds frames on drawn footage.
- Lend a reference's principles (pace per section, rests), never its times, order or devices.
- `effect_fit`, `seam_lock`, `rest_fit` and `reference_closeness` check it.
