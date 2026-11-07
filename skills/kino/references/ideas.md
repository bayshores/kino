# Ideas: one per video

A template video is a stack of safe defaults: a tagline, feature cards, the same change
between each, a glowing logo. People see it as AI-made in a second. Good edits have **one idea**
that comes from the material itself, and everything else serves it. How it moves (cuts or
dissolves, whole lines or word captions) comes from the references the person chose: write it
as the style spec (the techniques reference), not from habit.

Contents: Before you build · The story · The ideas · Copy · What check flags

## Before you build

1. Save the person's material as sources: their message, the README, the script, a
   transcript. `edit {ops:[{op:"source", name:"readme", text:"…"}]}` (12 sources of up to 8,000
   characters; `text:null` removes one). check's `own_words` then names on-screen text whose
   words are in none of them.
2. Read the material for the one thing only this product has: its own screen, its own log, a
   real number, a real moment, a quirk in its name.
3. Pick **one** idea below (or your own from the material) and save it on the brief:
   `notes {action:"brief", fields:{idea:{text:"the lock screen tells it", by:"guessed"}}}`.
   Saving only the idea keeps a confirmed brief confirmed; every stop shows it as `Idea:`, so
   the person can say no to it early.
4. Build the rough around that idea. A second idea is a second video.

## The story

Write it before you build, a line a beat, in the plan or each board shot's `why`. Any genre,
any length, has the same small arc:

- **Hook**: the first second gives a reason to keep watching (a face, a question, a sound).
- **Want or stakes**: what someone needs, or what goes wrong without it.
- **Obstacle or change**: the problem met, the turn, the before and after.
- **Payoff**: the want met, said once and clearly; the end card only names it.

A 6 s logo sting is a hook and a payoff. A 30 s promo gives each beat a shot or two. A 60 s
trailer has acts, each a small arc. Map the beats to the sound: the hook on the first downbeat
or word, the turn where the music changes (a drop, a pause, a new section), the payoff on its
biggest moment. With a voice, its sentences are the beats.

- One idea per beat. A shot that needs two lines to explain is two beats, or one too many.
- Text only for what the picture and the sound do not already say. Ask of each line what the
  viewer would miss without it. Few texts at once (`text_load` warns when they compete).
- A caption of someone speaking goes in quotes (or its own font, style or color), so it never
  reads as narration (`speech_quotes`).
- Check it on the sheet: say the story back a sentence a beat. A beat you cannot say is
  missing; one that takes two sentences is overloaded.

## The ideas

Each says when it fits, the template look it replaces, and how to build it.

**1. The product's own screen is the story.** The product has a screen people know (a lock
screen notification, a chat, a terminal, a dashboard). Replaces: a floating mockup with a
tagline beside it. Build: draw the real screen at full frame from the repo's own words (status
bar, timestamps, the exact message), and let it change the way it does in use: a message
arrives, a reply appears. No device frame needed.

**2. The log is the narrator.** The product writes a record (logs, commits, a timeline, a
receipt). Replaces: subtitles that explain. Build: a monospace list where each line cuts in
(`animations:[{kind:"show", start}]`, no fade) at the moment it happens, with real timestamps. Hold the line that matters
longer and give it the only color change.

**3. A clock runs through it.** The story happens over time (overnight, a deadline, a commute).
Replaces: "Step 1 / Step 2 / Step 3" cards. Build: one real time (11:00, 11:07, 11:21) in a
fixed place; every section moves it on. The gaps between times say how fast things went.

**4. One real number, where it lives.** The material has a number that matters (74% sure, 9
minutes away, $0.02 a frame). Replaces: a big stat card ("10× faster"). Build: show it inside
the thing that produced it (the log line, the receipt, the alert), not on its own card. One
number per video; never round it or invent one.

**5. The real artifact.** Something real was sent or made: a text thread, an email, a pull
request, a handwritten note, a ticket. Replaces: a testimonial quote card. Build: recreate it
exactly (sender, time, typos kept) and let the person read it; the reply is the payoff.

**6. Changes that carry the eye.** There is footage or a UI with things happening (a tap, a
frame change, a door). Replaces: one change used everywhere, all fades or all hard cuts. Build:
pick each change for its moment and the references: a hard cut on an action
(`{kind:"hide", start}` on one section, `{kind:"show", start}` on the next at the same time), a
match cut (same shape or position across the cut), a dissolve between screen recordings, a
zoom-through into a screen, a blur-through inside one place. Cut most changes plainly and
keep one as a motif.

**7. Same frame, before and after.** The product changes one thing people can see. Replaces:
"Say goodbye to X" copy. Build: one framing, held, and the change happens in place (a cut or a
wipe across the same image). No labels needed when the change is visible.

**8. One to many.** One case scales (one camera to all of them, one user to a team). Replaces:
a grid of icons. Build: start full frame on the one, then scale it down into its place among
the many (a `group` with a scale animation); the others are real items, not placeholders.

**9. The name's own quirk.** The name has a joke or a mark (a crossed-out word, a lowercase
style, a pun). Replaces: a logo sting with a glow. Build: set the name exactly as the repo or
brand writes it, and make the quirk the end card's only motion (the strike lands with a hard
cut, the missing letter drops out).

**10. Real footage, held.** There is footage that is good on its own. Replaces: a title
centered over a blur of the same video, with nothing else designed. Build: let the shot run
sharp for a full beat; put text where the picture leaves room (a dim if contrast needs help),
or cut to the text on its own. A designed depth blur (sharp floating clips or type in front of a
blurred scene) is a different technique: use it when the references do.

**11. Their own words.** The person or a user said something good (their message, a review,
an issue comment). Replaces: invented testimonials and slogans. Build: their sentence, set
plainly, attributed as it was given; it is the line the video is built around.

## Copy

- Every on-screen word comes from the material: the README's own phrasing, the script, the
  product's real UI text. Save it as a source so `own_words` can tell you when you drift.
- Your own line is fine when you mean it: waive `own_words` on that layer and say why in the
  board's calls.
- Never: "Introducing", "Meet", "Seamless", "Effortless", "Unlock", "Supercharge",
  "Revolutionize", "The future of", "All-in-one", three-word slogans ("Fast. Simple.
  Secure."), emoji. `stock_copy` names these.
- Name what is simulated ("alert simulated") on the end card when the video recreates
  something.

## What check flags

All warnings (they never block a render); each finding says what to do instead. The last four
of the table are kino's default style, not rules for every video: a style spec that wants the
technique, backed by a reference time or the person's words, turns them off (the techniques
reference has the spec and the technique rules: `text_slides`, `few_techniques`,
`technique_repeat`, `metronome`, `beat_kick`, `flat_sections`).

| Rule | Flags | Instead |
|---|---|---|
| `own_words` | on-screen text whose words are mostly in no source | the material's words, or waive |
| `text_load` | texts asking for 24+ characters a second together, or 3+ separate texts over footage | drop, merge or move a line; let the voice or picture say it |
| `speech_quotes` | spoken captions that look like a line nobody says | quotes, or another font, style or color |
| `stock_copy` | stock promo phrases, three-beat slogans, emoji | one concrete line |
| `text_glow` | a glow (wide shadow, no offset) on text | no glow (the fix removes it) |
| `same_entrance` | 4+ texts all entering with one preset | an entrance that fits each moment; quiet when the spec wants that entrance |
| `word_by_word` | 3+ texts revealed word or letter by letter | whole lines, or word captions if the spec wants type-words |
| `soft_cuts` | a fade or blur at every section change (3+) | varied changes; off when the spec wants dissolve, fade-black or blur-through |
| `blurred_backdrop` | centered text over blurred full-frame footage (not a fill behind sharp footage) | sharp footage, or a depth-blur in the spec |

The older look rules still apply: `centered_run`, `card_grid`, `accent_stripe`,
`glow_blob_pill`, `gradient_text`, `neon_on_dark`, `default_font`.
