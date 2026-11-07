# Storyboard

Contents: Build it · Look at it · Fresh-eyes check · Ask · After the approval · Examples · Storyboard: a board from footage

Read before building a video from footage (the `board` stop), or to plan any video shot by shot.

## Build it

- Put the clip in the scene first, one video layer from 0 s, so scene time is file time
  (`look source` needs it; the storyboard stop asks only when the video has footage). When
  you build the shots, delete it (or make it shot 1), so the clip's sound plays once.
- One `board` op holds the whole storyboard; each call replaces it (undo, `rev`). Shots in
  time order, no gap and no overlap: from the music layer's start to its end, or the whole
  video when `music` is `"none"` (voice-over, silent motion design).
- Every layer of every shot is given, `"none"` when empty: `media` (an imported video or
  picture, or a video layer) and `in` (file seconds), `crop`, `subject`, `follow`, `text`,
  `sound`. `library {topic:"op", name:"board"}` has them all.
- `crop` is `[x, y, w, h]` in % of the source, x, y top-left, at the video's shape: for 9:16
  from 16:9, w = h × 0.316; `"whole"`: shown whole (a phone screen as a card). Place it from
  the subject: `look {mode:"source", layer, t}` (t: the shot's `in`) has a % grid. `subject` is
  `{what, box, eyes?}` in % of the source as the frame at `in` shows it; `eyes` is the eye
  line's y. Cut where import lists the shots.
- `follow`: `steady` (the crop holds still), `track` (it follows the subject) or `sweep` (one
  straight pan). A subject that crosses the frame needs `track` or `sweep`.
- `text` is `{text, family, weight?, size?, y?, fill?}` in a font kino has (`y`: its center,
  % from the top). Keep it off faces; no meme or novelty fonts unless the brief asks for them.
- `sound` is `"none"` or `{what}`, a concrete effect ("phone buzz on the table"): from the
  person's files, or kino's own (`library sounds`, sound-library reference). Never a
  made-up synth sound.
- `pacing`: `beat_cut` (cuts on beats), `phrase_flow` (with the music's phrases or the voice)
  or `free`. `why`: one line. `calls` (at most 6): your own choices, so an approval covers
  them. `open` (at most 3): questions only the person can answer.
- `move`: `{kind, name, ref}`, `kind` type, transition, camera or ui; `name` a move,
  transition, recipe, preset, `frame` or `drift`, else `planned:true`; `ref` the moment it
  copies, `"<key>@<seconds>"` (a saved reference's key, id or title; `look versus` pairs
  it). Else `{none:"cut"}`: a plain cut, right for most shots.
- Send the whole board again to change it, each shot with the `id` `look board` prints after
  its number (`2 (S5)`); a shot without one keeps the id of the shot it continues.
- Refused (`op_failed`; its `boardError` says which): `missing_layer` (say "none"), `gap` or
  `overlap` (the answer names the shot to change), `bad_shot` (every bad field named).

## Look at it

`look {mode:"board", page}` shows 4 shots a page: the source frame at `in` with the crop and the
subject boxes, the app's covered areas shaded on 9:16, the cropped still with the real text,
kino's numbers (subject % in the crop and from its edge, eyes % from the top), the move and
your reason; its text, each shot's number, id, numbers and `look:` flags.
Fix every `look:` flag you can before asking: the subject whole and 5% or more from the crop
edge, eyes 20–45% from the top, nothing under the app's captions.

## Fresh-eyes check

Before you ask, when your app can start a second agent, give it only the brief's
lines, the project id and this: "Read the storyboard with look {project, mode:"board", page}
(every page; change nothing). List where you would have to guess, and the top 3 problems you
can see." Fix the small ones yourself and add each to `calls` (edit `board`): they show as
"my calls". Only questions for the person go out, in one message. At most 2 check rounds.
Then ask with `fresh:"ran"`; when your app cannot start one, with `fresh:"skipped"`. (After superpowers' builder-check prompt, obra/superpowers, MIT.)

## Ask

- Open items first: ask them in one message, log each reply word for word
  (`notes {action:"brief", log}`), fold the answers into the board, empty `open`. If they say "your call", send their words: `notes {action:"checkpoint",
  id:"board", words:"<their reply>"}` (kino logs them: do not log them again;
  "not your call" is not one). It answers `your_call`: decide each item, write your decisions
  in `calls` and empty `open` (edit `board`), then ask again with the fresh-eyes answer:
  `notes {action:"checkpoint", id:"board", fresh:"ran"}` (or `"skipped"`). Every ask carries
  `fresh` (else "Fresh-eyes check: not reported").
- `notes {action:"checkpoint", id:"board"}`: kino writes the ask (your calls, plain then flagged
  shots first, at most 8 shots). Send it as written, with the `look board` pages
  when your app can send files, and end your turn. "All shots": the same call with `all:true`.
  After a redo or approve with notes, kino lists what changed (asked or not), what they named
  but did not change, and a new shot order or music: send it as written.
- No `check` first: the board comes before building.
- Refused: `board_first` (save one first), `board_gap` (it no longer covers the music or
  video), `open_items` (above), `move_needed` (no designed move on the hook,
  reveal or payoff; it names moves that fit those).
- Sound: `none` when no shot has one; the first ask offers their files or kino's built-in
  library (`library sounds`, no switch needed).
- Record their reply with `notes answer` (direction reference).

## After the approval

kino keeps a copy of the approved board: build to it. These lapse the approval: media, text,
sound, pacing, follow, move, music (or its file), shot order, a shot added or removed, a new open
item; a cut, in-point or end moved over 6 frames; a crop edge or width changed over 5% of the
frame width. `board.lapsed` and `status` say so: ask again;
kino lists only the changed shots.
A gap the video or music made lapses it until the board covers it again within those limits.
Smaller changes are only logged (`board.revisions`, such as `revision: shot 5 cut moved 3
frames onto a beat`). "Approve with notes": make the changes. Once the person answers rough,
color or sound, only another song, media or shot list lapses it; fixes are logged
(`after C2 rough: ...`).

A shot as one video layer (W × H the video, `[x, y, w, h]` the crop): `height` = H × 100 / h,
`width` = `height` × the source's width / height, `x` = −x / 100 × `width`, `y` = −y / 100 ×
`height`, `mediaStart` = `cue`, `mediaOffset` = `in`, `mediaDuration` = `dur`, `mediaSpeed` = `speed`.

## Examples

```json
{"tool":"edit","ops":[{"op":"board","music":"none","shots":[{"cue":0,"dur":2.5,"pacing":"free","media":"none","in":"none","crop":"none","subject":"none","follow":"none","text":{"text":"Orbit","family":"Inter","weight":700,"size":160,"y":45},"sound":"none","move":{"kind":"type","name":"wordmark-type","ref":"launch@6"},"why":"the name alone first"},{"cue":2.5,"dur":3.5,"pacing":"free","media":"none","in":"none","crop":"none","subject":"none","follow":"none","text":{"text":"Plan the week in one view","family":"Montserrat","weight":600,"size":96,"y":50},"sound":"none","why":"one promise, said plainly"}]}]}
{"tool":"look","mode":"board"}
{"tool":"edit","ops":[{"op":"board","music":"none","shots":[{"cue":0,"dur":6,"pacing":"free","media":"none","in":"none","crop":"none","subject":"none","follow":"none","sound":"none","move":{"kind":"ui","name":"roll"},"why":"one card"}]}],"expect":"op_failed"}
```

The last is refused, every bad field named at once: no `text`, no `ref`.

## Storyboard: a board from footage

1080×1920, 4.4 s, the 384×216 clip's three shots, each subject marked at its `in`. Shot 2 is
flagged: the dragon is almost as wide as the crop (4% from its edge).

```json
{"tool":"edit","ops":[{"op":"board","music":"none","calls":["Inter 700 for every line"],"shots":[{"cue":0,"dur":1.25,"pacing":"free","media":"/api/media/<clip>.mp4","in":0,"crop":[18,12,24,76],"subject":{"what":"the hero's face","box":[20,15,18,37],"eyes":29},"follow":"steady","text":{"text":"The dragon is back","family":"Inter","weight":700,"size":80,"y":60},"sound":"none","move":{"kind":"transition","name":"zoom-through","ref":"launch@0.5"},"why":"her face first: the story is hers"},{"cue":1.25,"dur":2.083,"pacing":"free","media":"/api/media/<clip>.mp4","in":1.25,"crop":[4,12,24,76],"subject":{"what":"the red dragon","box":[5,40,22,23]},"follow":"track","text":"none","sound":"none","why":"the threat, small over the city"},{"cue":3.333,"dur":1.067,"pacing":"free","media":"/api/media/<clip>.mp4","in":3.333,"crop":[13.5,12,24,76],"subject":{"what":"the dragon's head","box":[19,34,11,18]},"follow":"track","text":{"text":"Look up","family":"Inter","weight":700,"size":120,"y":20},"sound":"none","why":"end on the dragon coming at us"}]}]}
{"tool":"look","mode":"board"}
```
