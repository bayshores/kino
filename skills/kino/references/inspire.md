# Inspire

How other edits are cut and move: kino searches YouTube (the person's yt-dlp; no account or cookies), measures a 360p copy of each result's first 90 s, deletes it and keeps the numbers, a thumbnail and frame strips. Songs: `library {topic:"soundtrack"}`.

## What is measured

- Cuts: shots, cuts a second, median and longest shot (in beats too), the bpm and cuts on the beat (within 0.08 s).
- The fingerprint (Apple Vision, Mac only; elsewhere named as not measured): motion and holds, camera moves, cuts in motion, blur dips, dissolves, text on screen, what stays in place, palette and brightness. Text numbers are reliable; motion numbers advise (handheld reads as camera moves); reveals can mistake interface labels for captions.
- A measured reference lists words heard in it (a voice or the song) and a footage `said:` call; a scan of a captionless video offers that line as `library {"topic":"footage","scan":"F1","said":"<line>"}`.
- One video is measured at a time. Searches and saved references belong to the project; the numbers are shared.
- yt-dlp missing: the search says how to install it (`KINO_YTDLP`). Downloads need deno, node or bun (`KINO_YTDLP_JS`). On YouTube's "not a bot" sign-in, kino pauses 15 minutes.

## Before the plan

- After the brief, `step:` asks for 2+ saved references, each studied (`look {mode:"reference"}`) and labeled (`name:"seen …"`), before `set_plan`. Its search comes from the brief's names, quotes and song (`Or without the song` is in both). Results far longer than the video and song releases are dropped (`Dropped N:` names 3; `name:"yt:<id>"` opens one); `shared:` lists words many titles have, dropped ones too. Until then the first edit that adds layers or animations is refused (`order_needed`). A final render of 5 s or more with none saved is refused (`reference_needed`), as is one whose references were all saved after its first build. `waive_check {code:"reference", target:"*", reason}` skips all.
- Saving the brief's `about` line searches its quote (and the quote with up to 6 words beside it in their message) and keeps what the subject is known for in `state.origin` (a word in 40% of 6+ titles; the 3 most viewed). With a word and none of their footage, `next:` leads to a footage search for `<about quote> <word>`, then a scan with `want:"<word>"`.
- Best first: views, verified channel, 2 a channel, then frames (SigLIP) against the words and taste (saved = liked, unsaved = rejected). Copies collapse (`N copies hidden`). `doubt:` is slop from the title (AI, SEO, tutorial, template, stock, hashtags, few views, under 6 s) or kino's measure (a patch in place 60%+, almost no cuts, text on plain, 10 min+); `same frames`: an AI loop or a still. `fit:` holds it to the brief (`3:08 for a 20 s edit: name the stretch you take`; 9:16 once measured). Reject AI imagery or voice, templates, stock, reuploads.
- Compare first: one search (same words again = one) and under 3 results read (a study or look): `step:` and a save lead to a second search with new results. A save needs `take:"<structure, pacing, type, transitions or sound: what>"`, plus `1:02 to 1:20` for a reference 3x the video; a longer take is cut at a whole word (stretch kept; it says so).

## Borrowing a rhythm from YouTube

- `library {topic:"inspire", search:"walking tour edit"}` lists what it found, with ids like `yt:tgEWNHVbk3U`. `library {topic:"inspire"}` lists the project's searches and saved ones.
- `library {topic:"inspire", name:"yt:…"}` waits for its numbers, prints a `skeleton:` line (shots, holds, fast runs, change point, lettering, motion, beat cuts) and lists its cut times (`*` on the beat); `full:true` lists all.
- It also prints up to 3 public "most replayed" humps with kino's shot count and median shot inside each. Facts only: a graph is scaled to its own video, a hump can be a liked part or an unclear one, and `check` and the defaults never read them.
- A video the person linked needs no search: `name:"yt:<id>"` or `name:"measure yt:<id>"`, or the whole link in `search` (watch, youtu.be or `/shorts/`). kino reads its title and length and measures it.
- `name:"save yt:…"` (`"save yt:… as launch"` keys it for a board `move.ref` `"launch@3.1"`), `"unsave yt:…"`, `"measure yt:…"` (after a failure), `"cancel"` and `"copy <project>"` (its saved references) work as named. A saved one keeps a still a second for `look versus`.
- `borrow_rhythm {ref, seed?, order?, fit?}` lends the skeleton as cue marks `rhythm-1`, … (`at:"cue:rhythm-3"`), scaled to the scene (`fit:false` keeps its seconds). Sections are shuffled by a seed from the project id (`seed:<n>` changes it, `order:"exact"` keeps the reference's order); the receipt prints the seed and the scale. `reference_closeness` warns on copied cut timing.
- Search, read, borrow:

```json
{"tool":"library","topic":"inspire","search":"fast cut walking edit"}
{"tool":"library","topic":"inspire","name":"yt:tgEWNHVbk3U"}
{"tool":"edit","ops":[{"op":"borrow_rhythm","ref":"yt:tgEWNHVbk3U","fit":true}]}
```

## Short vertical edits (YouTube Shorts)

- `kind:"shorts"` searches YouTube's Shorts, then videos of 60 s or less; `Short 9:16` (`vertical:true`) marks a tall one. Links from other short-video apps are refused.

```json
{"tool":"library","topic":"inspire","search":"app launch animation","kind":"shorts","count":6}
```

## Fingerprint and frame strips

- A read also gives the fingerprint and 3 to 6 suggested style lines, each with its time and technique tags (`[slow-push]`, `[type-words]`). They are guesses: look at the strips, then keep the ones you confirm in the brief's style (with `ref` and `at`).
- A reference with text asks for its type: read the family class (serif, sans, mono, script), size, case and reveal off the strips; save `"type: <family class>, <size>, <case>, <reveal>"` with `ref` and `at`. A type label is measured only where kino's text reader reads its own words in a kept frame within 0.5 s: put the on-screen lettering in the label's words, quoted or in capitals ("the lyric word KNOW"). Up to 6 saved labels are tried. Else the receipt says 'type label <ref> @<s> not used: <why>' (once per project, by a saved edit; a dry run repeats it) and an `add_layer` text with a `role` and no font takes the face of the project's own text doing that job (same role, else the largest text or the smallest reading line), else an installed face with the weight ('face from ...'). Its fill and subtitle edge follow the picture behind the text box at its show time (receipt: color, layer, contrast).
- `look {mode:"reference", ref, t}` shows the strip nearest `t` and its neighbors: 6 frames 1/12 s apart from 0.25 s before the moment, 240 px wide. Without `t`, `page` 1, 2, … of 6. Without `ref`: the saved references.
- Strips are kept around cuts, motion peaks and suggested lines (24 at most).
- `seen` takes a comma after the time (`@1.8, frame, color: ...` or `@1.8,frame`), an `s` after the second, and commas, `+`, `&` or `/` between kinds; a line that does not parse names the missing part. A seen time is a moment or a strip time a look printed.
- A full check with saved references runs `reference_drift` (text far from theirs warns; motion advises) and `reference_range` (brightness, contrast, dark share, text entrances, a clip's own speech where theirs have a voice).

```json
{"tool":"library","topic":"inspire","name":"yt:tgEWNHVbk3U"}
{"tool":"look","mode":"reference","ref":"yt:tgEWNHVbk3U","t":2}
```

## Proposing ideas to the person

- After a read, propose what to take: `library {topic:"inspire", ideas:{ref, take:[{title, from, to?, what, why, use, place?:{at, to?}, tags?}], skip?:[{title, why}]}}`. At most 6 takes and 4 skips; `from`/`to` are times in their video, `place` in yours.
- F3 shows them as numbered cards on their video's film strip, each with an on/off switch; the person allows them (with a note) or says not yet. Only the person switches or allows; your next inbox says which. Then add each to the brief's style (`notes {action:"brief"}`, with `ref` and `at`) and make them.

```json
{"tool":"library","topic":"inspire","ideas":{"ref":"yt:tgEWNHVbk3U","take":[{"title":"cut on the third beat","from":1,"to":2,"what":"a hard cut lands on the beat","why":"the cut feels earned","use":"cut the title in on rhythm-3","place":{"at":1}}],"skip":[{"title":"their logo","why":"their brand, not a style"}]}}
```

## Sound effects from YouTube

- `library {topic:"inspire", search:"soft whoosh card slide", kind:"sounds"}`: YouTube sound effects of 60 s or less, junk left out (packs, meme sounds), each measured. Search the visible action in words. `name:"sounds 3"` ranks search 3 by match to the words and the person's taste.
- `project {action:"import", file:"yt:<id>"}` brings its short preview in with its credit (as metadata). A song: `library {topic:"soundtrack", song:"yt:<id>"}`; a video: footage guide. `name:"forget 3"` drops search 3 from the project; measured references stay in kino's cache.
