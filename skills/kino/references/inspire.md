# Inspire

How other edits are cut and move. kino searches YouTube (the person's yt-dlp; no account, no
cookies), measures a 360p copy of each result's first 90 s and deletes it, keeping the numbers,
a thumbnail and frame strips (the dashboard's F3 screen). Songs: `library {topic:"soundtrack"}`.

Contents: What is measured · Before the plan · Borrowing a rhythm · Shorts · Fingerprint and
frame strips · Proposing ideas · Sound effects

## What is measured

- Cuts: shots, cuts a second, median and longest shot (in beats too), the bpm and cuts on the
  beat (within 0.08 s).
- The fingerprint (Apple Vision, Mac only; elsewhere named as not measured): motion and holds,
  camera moves, cuts in motion, blur dips, dissolves, text on screen, what stays in place,
  palette and brightness. Text numbers are reliable; motion numbers advise (handheld reads as
  camera moves); reveals can mistake interface labels for captions.
- A measured reference lists words heard in it (a voice or the song) and a footage `said:`
  call; a scan of a video with no captions offers that line as
  `library {"topic":"footage","scan":"F1","said":"<line>"}`.
- One video is measured at a time. Searches and saved references belong to the project; the
  numbers are shared.
- yt-dlp missing: the search says how to install it (`KINO_YTDLP`). Downloads need deno, node
  or bun (`KINO_YTDLP_JS`). On YouTube's "not a bot" sign-in, kino pauses 15 minutes.

## Before the plan

- Once the brief is settled, `step:` asks for 2+ saved references, each studied (`look
  {mode:"reference"}`) and labeled (`name:"seen …"`), before `set_plan`. Its search is made from
  the brief's names, quotes and song (`Or without the song` is in both).
  Results far longer than the video, and song releases, are dropped (`Dropped N:` names 3;
  `name:"yt:<id>"` opens one); `shared:` lists words many titles have, dropped ones too. Until then the first
  edit that adds layers or animations is refused (`order_needed`). A final render of 5 s or
  more with none saved is refused (`reference_needed`), as is one whose references were all
  saved after its first build. `waive_check {code:"reference", target:"*", reason}` skips all.
- Saving the brief's `about` line searches its quote, and the quote with up to 6 words beside it
  in their message, and keeps what the subject is known for in `state.origin` (a word in 40% of
  6+ titles; the 3 most viewed). With a word and none of their footage, `next:` leads to a
  footage search for `<about quote> <word>`, then a scan with `want:"<word>"`.
- Best first: views, verified channel, 2 a channel, then frames (SigLIP) against the words and
  taste (saved = liked, unsaved = rejected). Copies collapse (`N copies hidden`). `doubt:` is
  slop from the title (AI, SEO, tutorial, template, stock, hashtags, few views, under 6 s) or
  kino's measure (a patch in place 60%+, almost no cuts, text on plain, 10 min+); `same
  frames`: an AI loop or a still. `fit:` holds it to the brief (`3:08 for a 20 s edit: name the
  stretch you take`; 9:16 once measured). Reject AI imagery or voice, templates, stock, reuploads.
- Compare first: one search (same words again = one) and under 3 results read (a study or
  look): `step:` and a save lead to a second search with new results. A save needs
  `take:"<structure, pacing, type, transitions or sound: what>"`, plus `1:02 to 1:20` for a
  reference 3x the video; status, the study, look show it back.

## Borrowing a rhythm from YouTube

- `library {topic:"inspire", search:"walking tour edit"}` lists what it found, with ids like
  `yt:tgEWNHVbk3U`. `library {topic:"inspire"}` lists the project's searches and saved ones.
- `library {topic:"inspire", name:"yt:…"}` waits for its numbers and lists
  its cut times (`*` on the beat); `full:true` lists all.
- A video the person linked needs no search: `name:"yt:<id>"` or `name:"measure yt:<id>"`, or
  the whole link in `search` (a watch, youtu.be or `/shorts/` link). kino reads its title and
  length and measures it.
- `name:"save yt:…"` (`"save yt:… as launch"` keys it for a board `move.ref` `"launch@3.1"`),
  `"unsave yt:…"`, `"measure yt:…"` (after a failure), `"cancel"` and `"copy <project>"` (its
  saved references) do what they say. A saved one keeps a still a second for `look versus`.
- `borrow_rhythm {ref, fit?}` (an edit op) lends each section's shot lengths in a new order as
  cue marks `rhythm-1`, … (`at:"cue:rhythm-3"`); `fit:true` scales to the scene.
  `reference_closeness` warns on copied cut timing.
- Search, read one, borrow it scaled:

```json
{"tool":"library","topic":"inspire","search":"fast cut walking edit"}
{"tool":"library","topic":"inspire","name":"yt:tgEWNHVbk3U"}
{"tool":"edit","ops":[{"op":"borrow_rhythm","ref":"yt:tgEWNHVbk3U","fit":true}]}
```

## Short vertical edits (YouTube Shorts)

- `kind:"shorts"` searches YouTube's Shorts, then videos of 60 s or less; `Short 9:16`
  (`vertical:true`) marks a tall one. Links from other short-video apps are refused.

```json
{"tool":"library","topic":"inspire","search":"app launch animation","kind":"shorts","count":6}
```

## Fingerprint and frame strips

- Reading one reference also gives its fingerprint and 3 to 6 suggested style lines, each with
  the time it came from and technique tags (`[slow-push]`, `[type-words]`). They are guesses: look
  at the strips first, then keep the ones you confirm in the brief's style (with `ref` and `at`).
- A reference with text asks for its type: read the family class (serif, sans, mono, script),
  size, case and reveal off the strips; save `"type: <family class>, <size>, <case>, <reveal>"`
  with `ref` and `at`.
- `look {mode:"reference", ref, t}` shows the strip nearest `t` and its neighbors: 6 frames
  1/12 s apart from 0.25 s before the moment, 240 px wide. Without `t`, `page` 1, 2, … of 6.
  Without `ref`: the saved references, one line each.
- Strips are kept around cuts, motion peaks and each suggested line's time (24 at most).
- With saved references, a full check runs `reference_drift` (text far from theirs warns;
  motion advises) and `reference_range` (brightness, contrast, dark share, text entrances, a
  clip's own speech where theirs have a voice).

```json
{"tool":"library","topic":"inspire","name":"yt:tgEWNHVbk3U"}
{"tool":"look","mode":"reference","ref":"yt:tgEWNHVbk3U","t":2}
```

## Proposing ideas to the person

- After reading a reference, propose what to take from it: `library {topic:"inspire", ideas:{ref,
  take:[{title, from, to?, what, why, use, place?:{at, to?}, tags?}], skip?:[{title, why}]}}`.
  At most 6 takes and 4 skips; `from`/`to` are times in their video, `place` in yours.
- F3 shows them as numbered cards on their video's film strip, each with an on/off switch, and
  the person allows them (with a note) or says not yet. Only the person switches or
  allows; your next call's inbox says which to use. Then add each to the brief's style
  (`notes {action:"brief"}`, with `ref` and `at`) and make them.

```json
{"tool":"library","topic":"inspire","ideas":{"ref":"yt:tgEWNHVbk3U","take":[{"title":"cut on the third beat","from":1,"to":2,"what":"a hard cut lands on the beat","why":"the cut feels earned","use":"cut the title in on rhythm-3","place":{"at":1}}],"skip":[{"title":"their logo","why":"their brand, not a style"}]}}
```
## Sound effects from YouTube

- `library {topic:"inspire", search:"soft whoosh card slide", kind:"sounds"}`: YouTube sound
  effects of 60 s or less, junk left out (packs, meme sounds), each measured. Search the
  visible action in words. `name:"sounds 3"` ranks search 3 by match to the words and the
  person's taste.
- `project {action:"import", file:"yt:<id>"}` brings its short preview in with its credit
  (as metadata). A song: `library {topic:"soundtrack", song:"yt:<id>"}`; a video: footage guide.
- `name:"forget 3"` drops search 3 from the project; measured references stay in kino's cache.
