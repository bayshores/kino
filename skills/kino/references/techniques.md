# Techniques and the style spec

kino names the techniques, finds them, and lets references set the style.

Contents: The vocabulary · The style spec · What check measures · The deck · Treatments · Building with techniques · Effects need a reason

## The vocabulary

56 tags in 6 groups: transition (cut, dissolve, whip-pan, mask-wipe, …), camera (slow-push,
parallax, speed-ramp, …), type (type-words, type-giant, type-mask-rise, …), texture (grain,
rgb-split, depth-blur, …), set piece (read from the `move` that built it) and rhythm (beat-cut,
beat-kick, syncopated, hold). `library {topic:"techniques", name?}` lists them and how check
finds each; check lists those used (`techniques: cut 12, type-pop 5`).

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
A backed dissolve or fade-black turns `soft_cuts` off; type-words or type-letters
`word_by_word`; depth-blur `blurred_backdrop`; beat-kick `beat_kick`; hold `text_slides`; the
entrance every text uses quiets `same_entrance`; any tag may repeat (`technique_repeat`) and is
wanted (`style_wanted`). An avoided tag used is a gate (`style_avoided`) only if the person
banned it. Other gates never change with the spec.

## What check measures

Warnings; each fix names techniques that fit. Limits: `library {topic:"rules", name:"quality",
search:"<code>"}`. `text_slides` and `few_techniques` leave videos under 8 s alone.

- `text_slides`: text over a still or dimmed footage for over 25% of the video.
- `few_techniques`: a flat edit with no designed device (cuts and holds do not count).
- `plain_beats`: the hook, reveal or spine payoff made of only footage, words and plain cuts.
- `technique_repeat`: monotony (one set piece, transition, accent or entrance over and over;
  2-3 alike uses are a motif). `metronome`: shots one length, or every cut on one count.
  `beat_kick`: the same small pulse 6 times or more.
- `flat_sections`: next sections alike in cut rate, motion, picture and framing scale.
- `style_avoided`, `style_wanted`: the spec, broken. `off_beat`: an accent just off a beat.
- `deck_unused`: under half of the deck's cards used. `effect_fit`: a loud effect on no cue,
  too big, stacked or on a talking face (auto removes; waive with cue:<name>).

## The deck

Once a treatment is picked (or waived), kino deals a hand: one or two techniques per group
(transition, camera, type, texture), at most one set piece (a move). `status` shows it
(`deck (seed 4821): dissolve, parallax, ...; swaps left 2`). The deal:

- puts a backed spec's wants first, never an avoided tag;
- fits the material: no phone cards without a phone, no type cards without words;
- steers away from the last 3 projects' decks; never deals plain cuts, plain text, beat kicks,
  or both type-pop and slow-push;
- adds up to 2 made cards (cut_out, keep_line, smear...) on a fact (a subject,
  heard lines) or your labels (at most half, 2 per reference); each says why, its call
  names your clip and line.

New labels or footage deal again until a card is used. Build cards; swap one with a reason or reroll.

```json
{"tool":"notes","action":"deck"}
{"tool":"notes","action":"deck","reroll":true}
```

`variants {vary:"deck"}` remakes a composed scene with the next 3 decks.

## Treatments

Write 5 stories first: idea, `who` (whose want or fear drives it; 3+ differ),
`tension` (what they want, fear or wonder), `turn` (the on-screen flip), move, `ending` (the
last image, from this material), `type` (`<family>, <size>, <case>, <how it appears>`, from your
references; 3+ differ; no default), `source` (file or screen
used), `p` (0 to 1, how typical).
kino shows the 3 least typical, new whos and types first: `A. idea · who: tension → turn · ends on ending · type: type`.
The pick (their words; "just start": yours, with `why`) sets `style.idea`, `style.type`, the first
signature and the spine's end; the lock's fonts name the faces. Building first is `order_needed`; waive_check "treatments" skips it.

```json
{"tool":"notes","action":"brief","fields":{"treatments":[{"idea":"dawn","who":"the city","tension":"asleep?","turn":"first wheels","move":"pushes","ending":"noon","type":"grotesk, fade up","p":0.6,"source":"dawn.mp4"},{"idea":"one board","who":"a kid","tension":"whose?","turn":"he lands it","move":"match cuts","ending":"his","type":"handwriting, drawn on","p":0.15,"source":"crew.mp4"},{"idea":"a map","who":"the crew","tension":"where to?","turn":"loop closes","move":"mask-wipe","ending":"map","type":"serif, cut on","p":0.1,"source":"route.mp4"},{"idea":"tricks","who":"a skater","tension":"lands it?","turn":"a fall","move":"freeze","ending":"laugh","type":"caps, a word a hit","p":0.25,"source":"tricks.mp4"},{"idea":"sounds","who":"you","tension":"that noise?","turn":"wheels on beat","move":"sound cuts","ending":"beat","type":"mono, typed on","p":0.05,"source":"street.wav"}]}}
{"tool":"notes","action":"brief","fields":{"ask":"I like the map one","treatments":{"pick":"B","quote":"the map one"}}}
```

## Building with techniques

- Before building, name 4 to 8 techniques the references use, with times; write the spec.
- Each section gets its own mix (calm: drift, type-fade; fast: beat-cut, type-giant);
  `flat_sections` checks it.
- Set pieces only where they matter.

## Effects need a reason

Every effect needs a cue that motivates it. Placed by beat number, seed or habit, a flash or
shake reads as decoration. Reference counts are ceilings, not targets; none of a device is fine.

- Flash: light rising in the shot, a song seam or a top accent. Shake: a footage contact, a song
  seam or a top accent. Impact frame: a contact. Dip: a rest. Strobe: a measured drum fill. `move {name:"impact-accent", kind,
  at:"cue:<name>"}` refuses any other cue and names one that fits; size follows its weight.
- The picture may come 2 frames early, never late. Slow motion holds frames on drawn footage.
- Lend a reference's principles (pace per section, rests), never its times, order or devices.
- `effect_fit`, `seam_lock`, `rest_fit` and `reference_closeness` check it.
