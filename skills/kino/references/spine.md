# The direction lock: story spine and style bible

A rough first pass may be anything. Past 30 layers, `step:` and each receipt's `next` say
`lock direction`, and a final render is refused (`direction_needed`) until the brief's style
spec holds a story spine and a style bible that the person approved. Once a treatment is
picked (or the spec names an idea), it also needs the `idea` and a signature. One `notes brief`
call does it; its draft is in that `next`.

```json
{"tool":"notes","action":"brief","fields":{"style":{"spine":[{"role":"hook","from":0,"to":3,"uses":["verdict"],"purpose":"the judge's verdict comes first"},{"role":"problem","from":3,"to":9,"uses":["walk"],"purpose":"eyes covered, the app must guide him"},{"role":"payoff","from":9,"to":13,"uses":["arrival"],"purpose":"he arrives"},{"role":"end","from":13,"to":15,"purpose":"name and link"}],"fonts":{"caption":{"family":"JetBrains Mono","size":48},"display":{"family":"JetBrains Mono","size":140}},"accent":{"color":"#ff4f9a","share":0.1},"moves":[{"tag":"dissolve","where":"between walk shots"},{"tag":"slow-push","where":"on each phone close-up"}],"logo":{"asset":"logo","max":2},"rejected":["Seven open-weight models. One RTX 4090."],"by":"guessed","waived":"no one is watching this run"}}}
{"tool":"notes","action":"brief","fields":{"style":{"idea":"a man with covered eyes walks home on the app's voice alone","signatures":[{"beat":2,"what":"the phone's arrow turns him at his own door","source":"arrival.mp4, the door","why":"only this app talks him there","at":[9,12]}],"moments":[{"tag":"screen-zoom","beat":2,"what":"into the arrow"}]}}}
{"tool":"notes","action":"brief","fields":{"style":{"moves":[1,2,3,4,5],"by":"guessed"}},"expect":"bad_input"}
```

## Idea and signature first

Write these before the spine, then fill the spine around them:
- `idea`: one sentence, what only this product can show (a picked treatment's idea).
- `signatures`: 1 or 2 `{beat, what, source, why, at?}`: the spine beat's index, the designed
  moment, the material it uses, why only this product. `at: [from, to]` once it is built. The
  pick's move and `source` draft the first one.
- `moments`: up to 3 set pieces `{tag, beat, what}`, used once on purpose; `moves` stay the
  recurring glue. The deck deals `moments[0]` (else a set piece) first.

The pick's signature call also drafts the spine before the build, so it tells the pick's story:
hook (the first image of its who), problem (its tension), turn (its turn), signature, payoff, end
(its ending), in rough seconds. template_end quotes the payoff, its `uses` and that ending. Building waits
(`order_needed`) until the spine has a problem, a turn and a payoff; times may change later. The
lock keeps that spine and asks the rest of the bible (fonts, plus moves and logo when not saved;
beats are timed over the brief's length). With no idea, `lock direction: idea + signature`
asks for the idea and its signature moment from the real material first; there is no template spine.

## The spine

Beats in story order, each `{role, from, to, uses?, purpose}`:
- `role`: hook, problem, turn (where it flips), product, how (it works, shown where it acts),
  proof, signature, breath (a deliberate quiet beat), payoff, end, coda, or another short name.
  `music_turn` warns when the music does nothing at a turn (no song section, under 4 dB of
  change, no dip just before): `fit_music {layer}`, then move the turn onto the `song-` cue
  its note names, or volume keys.
- `uses`: what the beat shows or plays (real material, not invented screens): layer names,
  media file names as `library media` lists them (extension optional), or audio layers.
- `purpose`: one sentence on what the beat does for the story.

## The style bible

- `fonts`: one `{family, size}` per text role (caption, display, label, stat, quote: a voice
  or pull-quote face; quoted lines in it keep it at any size).
- `accent`: `{color, share}`, the most of the frame the accent may cover.
- `moves`: at most 4 techniques (library techniques), each with `where` it recurs; they count
  as wanted techniques. Moves drafted from the deck are `sources:{moves:"dealt"}`: suggestions,
  never the person's style.
- `logo`: `{asset, max}`, one logo, shown at most `max` times.
- `avoids`: the one avoid list (the style spec's). A used one blocks a final render only when
  the avoids are the person's words (`by:"you"` with their quote, and not `copied`); any other
  warns, and the board stop asks the person about it. kino drafts no avoids.
- `sources`: where `wants`, `avoids` or `moves` came from when not `by`: `"copied"` (another
  project's brief), `"dealt"` (the deck), `"guessed"`, `"you"`. A remake reads the old video's
  techniques used (check), not its brief's avoids; copied avoids go in as `sources:{avoids:"copied"}`.
- `rejected`: text the person turned down (the newest 12 are kept; the answer names any dropped).
  Record it as they say it: `notes {action:"answer", ..., rejected:["<their words>"]}`, here, or
  as a brief reply `log:[{a:"<their words>", kind:"rejected"}]` (a reply, not a question).
- A style sent without `by` changes only its keys: `{style:{fonts:{caption:{size:60}}}}` keeps
  the rest (`null` removes a key). The person's style (`by:"you"`) changes only with their words.

## Approval

- The person approves: send `{by:"you", quote}` (their words). It makes the wants and moves they
  saw theirs; copied or dealt lists and guessed avoids keep their source until they answer about
  them (`sources:{avoids:"you"}`).
- No one watching (a batch run): `waived` with the reason, `by:"guessed"`.

## What check holds to it

| Rule | Gate when |
|---|---|
| `spine_drift` | over 2 s in no beat; the problem beat after 15% of the runtime (3 s at least); a beat other than the end or coda after the payoff (a second payoff warns); beats out of order or past the end; a beat's `uses` first on screen (or heard) outside it (a name in several beats: first in the earliest, then on screen in each) |
| `rejected_text` | a text, or two shown together, nearly says a rejected line (case, punctuation, "seven" or "7" alike) |
| `style_avoided` | an avoided technique is used, when the person's words ban it |
| `signature_missing` | (warns while editing, gates the final render) an `idea` with no signature range (a `signature` beat or `signatures[].at`), a range with no designed technique, set piece or full-frame picture, or one shorter than the longest text-only beat |
| `overlay_covers_subject` | an opaque card, picture, shape, caption or label covers over 30% of the middle of a subject marked with `mark_subject` for 0.5 s (any video); the auto fix moves it to the nearest free place (a caption: a suggestion). Tints under 60% opacity warn, and so does big type on purpose: the hook, the end line, or a style that asks for type over the footage (`type-giant`, or its words). With no mark, a face or raised hands Apple Vision found (full check, Mac) warn |

Big numbers ("40%", a counter) are the `stat` role: set `fonts.stat` to hold them to a face;
then a big line in that face that leads with a number ("3x faster") is a stat too.
Warned, never a gate (a second face with a job, a set piece used once, a double payoff can be
designed; the taste judge and the person weigh them): `role_font_drift` (a text off its `fonts`
family, or a caption off its size by 15%), `brand_consistency` (the logo shown more than
`logo.max` times), `accent_budget` (fills, outlines and a gradient's main stop in `accent.color` over
`share` of the frame for 1 s; media is not measured), `vocabulary_budget` (a designed technique
outside `moves`), `ending_count` (over 2 closing titles or logos after the last story beat; a
running caption track is not one, and one that starts after it counts once). None of these
fire inside a signature range (a `signature` beat, or a signature's `at`). `moments` count
toward no `vocabulary_budget`; for `technique_repeat` each moment leaves out one use of its tag
(the one in its beat), so the other uses still count.

A deliberate exception: `edit` op `waive_check {code, target, reason}`.
