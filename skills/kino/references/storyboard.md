# Storyboard

Contents: Build it · Look at it · Fresh-eyes check · Ask · After the approval · Examples · Storyboard: a board from footage

Read before building a video from footage (the `board` stop), or to plan any video shot by shot.

## Build it

- Put the clip in the scene first, one video layer from 0 s, so scene time is file time
  (`look source` needs it). When you build the shots, delete it (or make it shot 1): its sound plays once.
- One `board` op holds the whole storyboard; each call replaces it. Shots in time order, no gap,
  no overlap: the music layer's span, or the whole video when `music` is `"none"`.
- Every shot gives every field, `"none"` when empty: `media` and `in` (file seconds), `crop`,
  `subject`, `follow`, `text`, `sound`, `pacing`, `move`, `why`. Their exact shapes:
  `library {topic:"op", name:"board"}`.
- `crop` `[x, y, w, h]` % of the source at the video's shape (9:16 from 16:9: w = h × 0.316),
  placed from the subject: `look {mode:"source", layer, t}` (t: the shot's `in`) has a % grid.
  `subject` `{what, box, eyes?}`. `follow`: `steady`, `track` or `sweep`; a subject that crosses
  the frame needs `track` or `sweep`.
- `text` in the face your references chose (example faces are placeholders), off faces; no
  meme or novelty fonts unless asked. `sound`: an effect to add `{media, what}` ("phone buzz
  on the table") from the person's files or kino's library, never a made-up synth, and/or the
  clip's own sound `{keep:"all"}` or `{keep:[from, to]}` (file seconds). A shot with
  `"sound":{"keep":[1.5,2.5]}`: placing its layer, even at volume 0, runs `keep_line` on that
  stretch and dips the board's music.
- `pacing`: `beat_cut`, `phrase_flow` or `free`. `calls` (at most 6): your own choices, so an
  approval covers them. `open` (at most 3): questions only the person can answer.
- `move`: `{kind, name, ref}`, `ref` the reference moment copied (`"<key>@<seconds>"`; `look
  versus` pairs it). Else `{none:"cut"}`: a plain cut, right for most shots.
- Send the whole board again to change it, each shot with the `id` `look board` prints.
  Refusals (`op_failed`, `boardError`) name the shot and every bad field.

## Look at it

`look {mode:"board", page}` shows 4 shots a page: the source frame with crop and subject boxes,
the app's covered areas shaded on 9:16, the cropped still with the real text, kino's numbers,
the move and your reason; its text, each shot's number, id and `look:` flags. Fix every flag
before asking: the subject whole and 5%+ from the crop edge, eyes 20–45% from the
top, nothing under the app's captions.

look {mode:"board"} page 1 prints the shots' pace before and after the song's drop beside your
saved references', and the song's beat times after it; facts only. To put the cuts after the
drop on those beats: edit {ops:[{op:"board", snap:"beats"}]}. Cut times only, song stays; a move
over 6 frames lapses an approval.

## Fresh-eyes check

Before you ask, when your app can start a second agent, give it only the brief's
lines, the project id and this: "Read the storyboard with look {project, mode:"board", page}
(every page; change nothing). List where you would have to guess, and the top 3 problems you
can see." Fix the small ones yourself and add each to `calls` (edit `board`): they show as
"my calls". Only questions for the person go out, in one message. At most 2 check rounds.
Then ask with `fresh:"ran"`, or `fresh:"skipped"` when your app cannot start one. (After superpowers' builder-check prompt, obra/superpowers, MIT.)

## Ask

- No `check` first. Open items: ask them in one message, log each reply word for word
  (`notes {action:"brief", log}`), fold the answers into the board, empty `open`. If they say "your call", send their words: `notes {action:"checkpoint",
  id:"board", words:"<their reply>"}`. It answers `your_call`: decide each item, write
  your decisions in `calls` and empty `open` (edit `board`), then ask again with the fresh-eyes answer:
  `notes {action:"checkpoint", id:"board", fresh:"ran"}` (or `"skipped"`).
- `notes {action:"checkpoint", id:"board"}`: kino writes the ask (your calls, plain then flagged
  shots first, at most 8 shots). Send it as written, with the `look board` pages
  when your app can send files, and end your turn. "All shots": the same call with `all:true`.
  After a redo or approve with notes, kino lists what changed, what they named
  but did not change, and a new shot order or music: send it as written.
- Shot notes from the board screen ("use option B: <why>" is `alts[0]`, C `alts[1]`; "make it
  1.8 s"; "remove this shot"): edit `board` to match.
- With a picked `style.type` and footage, the answer carries a style frame (the type over the
  first shot): send it with the ask.
- Refused: `board_first`, `board_gap` (music or video not covered), `open_items`,
  `move_needed` (no designed move on the hook, reveal or payoff; it names moves that fit).
- Record their reply with `notes answer`. Placing a second shot, the first build and drafts
  wait for the board (`board_needed`).

## After the approval

Board approved: build it in one call, `edit {ops:[{op:"compose", from:"board"}]}`: a layer per
shot in board order, board music kept; sent again it replaces only its board-* layers.
kino keeps a copy of the approved board: build to it. These lapse the approval: media, text,
sound, pacing, follow, move, music (or its file), shot order, a shot added or removed, a new open
item; a cut, in-point or end moved over 6 frames; a crop changed over 5% of the frame width.
`board.lapsed` and `status` say so: ask again (only changed shots show). A gap lapses it until
covered. Smaller changes are logged (`board.revisions`). "Approve with notes": make the changes.
After the person answers rough,
color or sound, only another song, media or shot list lapses it. Approved with only "your
call": fix what a viewer finds (cut a repeat), never waive it.

A shot as one video layer (W × H the video, `[x, y, w, h]` the crop): `height` = H × 100 / h,
`width` = `height` × the source's width / height, `x` = −x / 100 × `width`, `y` = −y / 100 ×
`height`, `mediaStart` = `cue`, `mediaOffset` = `in`, `mediaDuration` = `dur`, `mediaSpeed` = `speed`.

## Examples

```json
{"tool":"edit","ops":[{"op":"board","music":"none","shots":[{"cue":0,"dur":2.5,"pacing":"free","media":"none","in":"none","crop":"none","subject":"none","follow":"none","text":{"text":"Orbit","family":"Noto Serif","weight":700,"size":160,"y":45},"sound":"none","move":{"kind":"type","name":"wordmark-type","ref":"launch@6"},"why":"the name alone first"},{"cue":2.5,"dur":3.5,"pacing":"free","media":"none","in":"none","crop":"none","subject":"none","follow":"none","text":{"text":"Plan the week in one view","family":"Montserrat","weight":600,"size":96,"y":50},"sound":"none","why":"one promise, said plainly"}]}]}
{"tool":"look","mode":"board"}
{"tool":"edit","ops":[{"op":"board","music":"none","shots":[{"cue":0,"dur":6,"pacing":"free","media":"none","in":"none","crop":"none","subject":"none","follow":"none","sound":"none","move":{"kind":"ui","name":"roll"},"why":"one card"}]}],"expect":"op_failed"}
```

The last is refused, every bad field named: no `text`, no `ref`.

## Storyboard: a board from footage

1080×1920, 4.4 s, the 384×216 clip's three shots, each subject marked at its `in`. Shot 2 is
flagged: the dragon is almost as wide as the crop (4% from its edge).

```json
{"tool":"edit","ops":[{"op":"board","music":"none","calls":["type set like the title in launch@0.5"],"shots":[{"cue":0,"dur":1.25,"pacing":"free","media":"/api/media/<clip>.mp4","in":0,"crop":[18,12,24,76],"subject":{"what":"the hero's face","box":[20,15,18,37],"eyes":29},"follow":"steady","text":{"text":"The dragon is back","family":"Montserrat","weight":700,"size":80,"y":60},"sound":"none","move":{"kind":"transition","name":"zoom-through","ref":"launch@0.5"},"why":"her face first: the story is hers"},{"cue":1.25,"dur":2.083,"pacing":"free","media":"/api/media/<clip>.mp4","in":1.25,"crop":[4,12,24,76],"subject":{"what":"the red dragon","box":[5,40,22,23]},"follow":"track","text":"none","sound":"none","why":"the threat, small over the city"},{"cue":3.333,"dur":1.067,"pacing":"free","media":"/api/media/<clip>.mp4","in":3.333,"crop":[13.5,12,24,76],"subject":{"what":"the dragon's head","box":[19,34,11,18]},"follow":"track","text":{"text":"Look up","family":"Montserrat","weight":700,"size":120,"y":20},"sound":"none","why":"end on the dragon coming at us"}]}]}
{"tool":"look","mode":"board"}
```
