# Inspire

Looking at how other edits are cut and move. kino searches YouTube (with the person's yt-dlp; no
account, no cookies) and measures each result: it downloads a small copy (360p, the first 90 s at
most), measures it and deletes the copy. The numbers, a thumbnail and small frame strips stay. The
person sees it all on the dashboard's F3 inspire screen and can search there too. Songs for the
video are compared the same way: `library {topic:"soundtrack"}`.

Contents: What is measured · Before the plan · Borrowing a rhythm · Shorts · Fingerprint and
frame strips · Proposing ideas · Sound effects

## What is measured

- Shots, cuts a second, the longest shot and where it is, length, the beat (bpm), and cuts on
  the beat (n of m: a cut at most 0.08 s from a beat).
- The fingerprint (Apple Vision on a Mac, `backend/measure`): motion and holds, camera moves
  (push-in, pull-back, pan, rotate, shaky), cuts that land in motion, blur dips, dissolves and
  fades, text on screen (share, big type, case, how it appears), what stays in place across cuts,
  palette and brightness. Off a Mac the Vision numbers are named as not measured, never guessed.
- Text numbers are reliable; motion numbers advise (handheld footage reads as camera moves);
  reveal styles are read 4 times a second and can mistake interface labels for captions.
- One video is measured at a time. A search answers at once; numbers arrive as each is read.
- Searches and saved references belong to the project; the numbers are shared by all projects.
- yt-dlp missing: the search says how to install it (or set `KINO_YTDLP`). Downloads need a
  JavaScript runtime for YouTube's challenge (deno, node or bun; `KINO_YTDLP_JS` names one); with
  none, the answer says so. When YouTube asks to sign in ("not a bot"), kino says so and stops
  downloading for 15 minutes; it never signs in.

## Before the plan

- Once the brief is settled, `step:` asks for 2+ saved references before `set_plan`. Search for
  edits like yours, save 2, study their strips (`look {mode:"reference"}`). Until then the first
  edit that adds layers or animations is refused (`order_needed`). A final render of 5 s or more with
  none saved is refused (`reference_needed`), and so is one whose references were all saved
  after its first build. `waive_check {code:"reference", target:"*", reason}` skips them all.
- Results come best first: views, verified channel, 2 a channel, then how their frames look
  (SigLIP on the thumbnail, then one keyframe a shot once measured) against the search words and
  the project's taste (saved = liked, unsaved = rejected; varied until 2 are saved). Near-identical
  copies collapse into the most viewed (`N copies hidden`). `doubt:` marks likely slop (AI, SEO,
  tutorial, template or stock words in the title or description, hashtag spam, few views, under
  6 s); `same frames` means the shots barely change (AI loop or a still: look first). Vet each
  before saving: who made it, its views, its frames. Reject AI-generated imagery or voice,
  template or stock edits, and reuploads.

## Borrowing a rhythm from YouTube

- `library {topic:"inspire", search:"walking tour edit"}` lists what it found, with ids like
  `yt:tgEWNHVbk3U`. `library {topic:"inspire"}` lists the project's searches and saved ones.
- `library {topic:"inspire", name:"yt:…"}` waits (up to 50 s) for that one's numbers and lists
  its cut times (`*` on the beat); `full:true` lists them all.
- A video the person linked needs no search: `name:"yt:<id>"` or `name:"measure yt:<id>"`, or
  the whole link in `search` (`https://www.youtube.com/watch?v=<id>`, `https://youtu.be/<id>` or
  a `/shorts/` link). kino reads its title and length with yt-dlp, adds it to the project as a
  one-video search (the screen shows the link) and measures it as usual.
- `name:"save yt:…"` (`"save yt:… as launch"` keys it for a board `move.ref` `"launch@3.1"`), `"unsave yt:…"`, `"measure yt:…"` (read again after a failure) and
  `"cancel"` (stop reading) do what they say. A saved or opened one is measured before the
  results nobody picked (a failed one is tried again). It keeps a still a second (10 to 90)
  for `look versus`; saving one kept with 10 measures it again. `"copy <project>"` saves another
  project's saved references here in one call.
- `borrow_rhythm {ref, fit?, at?, scene?}` (an edit op) turns the cuts into cue marks
  `rhythm-1`, `rhythm-2`, … that timing points at (`at:"cue:rhythm-3"`). `fit:true` scales the
  measured stretch to the scene; without it the cuts keep their times and those past the scene
  end are left out. Borrowing again replaces them. Only the times come in, never the footage.
- Search, read one, borrow it scaled to the scene, then cut a title on the third cut:

```json
{"tool":"library","topic":"inspire","search":"fast cut walking edit"}
{"tool":"library","topic":"inspire","name":"yt:tgEWNHVbk3U"}
{"tool":"edit","ops":[{"op":"borrow_rhythm","ref":"yt:tgEWNHVbk3U","fit":true}]}
{"tool":"edit","ops":[{"op":"add_layer","layerType":"text","name":"cut3","properties":{"text":"GO","x":860,"y":480,"width":200,"height":120,"fontSize":96},"animations":[{"preset":"preset-fade","start":"cue:rhythm-3","duration":0.3}]}]}
```

## Short vertical edits (YouTube Shorts)

- `kind:"shorts"` searches YouTube's Shorts filter, then fills up with videos of 60 s or less.
  A result marked `Short 9:16` (`vertical:true` in data) has a `/shorts/` link and a tall
  thumbnail; measuring reads the picture's shape for the others. It takes 5 to 15 s. The dashboard
  search has a shorts toggle on the videos tab.
- TikTok and Instagram need a faked browser or a login to read, which kino never does; paste a
  YouTube Shorts link instead. A TikTok or Instagram link is refused with that reason.

```json
{"tool":"library","topic":"inspire","search":"app launch animation","kind":"shorts","count":6}
```

## Fingerprint and frame strips

- Reading one reference also gives its fingerprint and 3 to 6 suggested style lines, each with
  the time it came from and technique tags (`[slow-push]`, `[type-words]`). They are guesses: look
  at the strips first, then keep the ones you confirm in the brief's style (with `ref` and `at`).
- `look {mode:"reference", ref, t}` shows the strip nearest `t` and its neighbors: 6 frames
  1/12 s apart from 0.25 s before the moment, 240 px wide. Without `t`, `page` 1, 2, … of 6.
  Without `ref` it lists the project's saved references, one line each.
- Strips are kept around cuts, motion peaks and every time a suggested line names (24 at most).
- With saved references, a full check runs `reference_drift` in the background (the next check has
  it): text far from theirs, or alone on a plain frame over twice theirs, warns; motion advises.

```json
{"tool":"library","topic":"inspire","name":"yt:tgEWNHVbk3U"}
{"tool":"look","mode":"reference","ref":"yt:tgEWNHVbk3U","t":2}
```

## Proposing ideas to the person

- After reading a reference, propose what to take from it: `library {topic:"inspire", ideas:{ref,
  take:[{title, from, to?, what, why, use, place?:{at, to?}, tags?}], skip?:[{title, why}]}}`.
  At most 6 takes and 4 skips; `from`/`to` are times in their video, `place` in yours.
- F3 shows them as numbered cards on their video's film strip, each with an on/off switch, and
  the person allows them (with an optional note) or says not yet. Only the person switches or
  allows; your next call's inbox says which ideas to use. Then add each to the brief's style
  (`notes {action:"brief"}`, with `ref` and `at`) and make them.
- While a reference is read, F3 shows the frame being measured, its motion arrows, the text read
  and the cuts found so far (sent live, never saved).

```json
{"tool":"library","topic":"inspire","ideas":{"ref":"yt:tgEWNHVbk3U","take":[{"title":"cut on the third beat","from":1,"to":2,"what":"a hard cut lands on the beat","why":"the cut feels earned","use":"cut the title in on rhythm-3","place":{"at":1}}],"skip":[{"title":"their logo","why":"their brand, not a style"}]}}
```
## Sound effects from YouTube

- `library {topic:"inspire", search:"soft whoosh card slide", kind:"sounds"}`: YouTube sound
  effects, 60 s or shorter, junk left out (compilations, packs, meme sounds, long ambiences for a
  hit, sci-fi unasked), each measured in turn: `yt:<id> "title" 2.1 s, peak 1.1 s, -18 LUFS`.
  Search the visible action in words. `name:"yt:<id>"` waits for one (64-bar shape).
- `name:"sounds 3"`: search 3 ranked by how each sound matches the words (CLAP, `match` 0-100)
  and the person's `use`/`no` on sounds (`taste`); near-duplicates fold into one.
- `project {action:"import", file:"yt:<id>"}` brings its short preview (AAC) in with its credit
  (license "unknown (YouTube)": credit it, check it may be used). Videos and songs never come in.
- `name:"forget 3"` drops search 3 from the project; measured references stay in kino's cache.
