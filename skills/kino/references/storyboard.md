# Storyboard

Read before building from footage (the `board` stop) or planning shot by shot.

## Build it

- Put the clip in the scene first, one video layer from 0 s, so scene time is file time (`look source` needs it). Building the shots, delete it (or make it shot 1): its sound plays once.
- One `board` op holds the whole storyboard; each call replaces it. Shots in time order, no gap, no overlap: the music layer's span, or the whole video when `music` is `"none"`. `music:"<imported sound's src or id>"` adds the song's audio layer itself (0 s to the shots' end), so the board has its cues before anything is built (`fit_music` after a board: sound-library reference); it saves on a briefed video even when `fit_music` fades the song.
- A shot whose file span crosses a cut of that file by under 0.25 s is slid off it (`in` moves; cue, length and speed stay; the answer says `in a to b`). A longer crossing, or a shot sent as the saved board has it, is only stated (the cut's file second, scene second, trim).
- A shot needing more clip than the file has is refused with fixes: speed S (slower), in I when the file is long enough, or dur D with the next shot starting earlier and running longer.
- Every shot gives every field, `"none"` when empty: `media` and `in` (file seconds), `crop`, `subject`, `follow`, `text`, `sound`, `pacing`, `move`, `why`. Exact shapes: `library {topic:"op", name:"board"}`.
- `crop` `[x, y, w, h]` % of the source at the video's shape (9:16 from 16:9: w = h × 0.316), placed from the subject: `look {mode:"source", layer, t}` (t: the shot's `in`) has a % grid. `subject` `{what, box, eyes?}`. `follow`: `steady`, `track` or `sweep`; a subject that crosses the frame needs `track` or `sweep`.
- `text` in the face your references chose (example faces are placeholders); no meme or novelty fonts unless asked. `{text}` alone is enough: family, weight, size and fill left out follow the words' job (a payoff on the spine's payoff beat, else a subtitle line); the answer prints the values taken and the `text.<field>` that changes each. A family with no size is sized to fit.
- `sound`: an effect to add `{media, what}` ("phone buzz on the table") from the person's files or kino's library (never a synth), and/or the clip's own sound `{keep:"all"}` or `{keep:[from, to]}` (file seconds). `"sound":{"keep":[1.5,2.5]}`: placing the shot's layer, even at volume 0, runs `keep_line` on that stretch and dips the board's music.
- `text` may take `until`: the id of the shot the words stay until, or a second of the video; `compose {from:"board"}` adds such words last, so they stay above later footage. An earlier or unknown id, or a second past the video, is refused with the valid ids.
- `lift: true` (or a mean luma 1 to 255) runs `lift_dark` on that shot when built.
- `pacing`: `beat_cut`, `phrase_flow` or `free`. `calls` (at most 6): your own choices; an approval covers them. `open` (at most 3): questions only the person can answer.
- `move`: `{kind, name, ref}`, `ref` the reference moment copied (`"<key>@<seconds>"`; `look versus` pairs it). Else `{none:"cut"}`: a plain cut, right for most shots. Names slow-push, push-in and zoom-in are saved as `push` (the receipt says so): a frame op from the crop to 90% of it, toward the subject box, over the shot. `impact-accent` lands on the song seam (flash), a rest (dip) or a top accent (flash) within 0.1 s of the cue, else a hit there.
- Send the whole board again to change it, each shot with its `look board` `id`. Refusals (`op_failed`, `boardError`) name the shot and every bad field.

## Look at it

`look {mode:"board", page}` shows 4 shots a page: source frame with crop and subject boxes, the app's covered areas shaded on 9:16, the cropped still with the real text, kino's numbers, the move, your reason, and each shot's number, id and `look:` flags. Fix every flag before asking: the subject whole and 5%+ from the crop edge, eyes 20–45% from the top, nothing under the app's captions.

The board answer, `look board` page 1 and `check` (after `made:`; built video layers by file time, speed and reverse counted, groups on their own clock) print one line per song drop or section start (the board's music, else the scene's first audio layer with a saved shape) and, even with no song, 'on the payoff beat at 10.95 s' ('on the last shot' with no spine) and 'on the longest shot (<n> s) at <t> s'. Each names the shot, then `new`, `repeats X s of file a-b s shown at t1-t2 s`, `continues the file ...` or `on screen since T s (no cut on it)`; a picture shown twice reads 'shows again the still shown at 0-2 s'; a picture or a layer hidden by Hide counts only while on screen. `check` reads those times off the layers compose built (`board-<id>`), so a later edit moves them. A repeat or on-screen line lists up to 3 unused scanned shots (F code, shot) whose light, face or subject size differ most; import one with `project import {file, options:{shots}}`. 'one take fills N% of the edit': a file over half the runtime.

## Ask

- Fresh-eyes check first (stops reference). No `check`. Open items: ask them in one message, log each reply word for word (`notes {action:"brief", log}`), fold the answers into the board, empty `open`. If they say "your call", send their words: `notes {action:"checkpoint", id:"board", words:"<their reply>"}`. It answers `your_call`: decide each item, write your decisions in `calls` and empty `open` (edit `board`), then ask again with the fresh-eyes answer: `notes {action:"checkpoint", id:"board", fresh:"ran"}` (or `"skipped"`).
- `notes {action:"checkpoint", id:"board"}`: kino writes the ask (your calls, plain then flagged shots first, at most 8 shots). Send it as written with the `look board` pages if your app sends files; end your turn. "All shots": the same call with `all:true`. After a redo or approve with notes, kino lists what changed, what they named but did not, and a new shot order or music: send it as written.
- Shot notes from the board screen ("use option B: <why>" is `alts[0]`, C `alts[1]`; "make it 1.8 s"; "remove this shot"): edit `board` to match.
- With a picked `style.type` and footage, the answer has a style frame (the type over the first shot): send it too.
- Refused: `board_first`, `board_gap` (music or video not covered), `open_items`, `move_needed` (none on the hook, reveal or payoff; it names moves that fit).
- Record their reply with `notes answer`. Placing a second shot, the first build and drafts wait for the board (`board_needed`).

- Board approved: build it in one call, `edit {ops:[{op:"compose", from:"board"}]}`, to the approved copy kino keeps. What lapses the approval: stops reference.

## Examples

```json
{"tool":"edit","ops":[{"op":"board","music":"none","shots":[{"cue":0,"dur":2.5,"pacing":"free","media":"none","in":"none","crop":"none","subject":"none","follow":"none","text":{"text":"Orbit","family":"Noto Serif","weight":700,"size":160,"y":45},"sound":"none","move":{"kind":"type","name":"wordmark-type","ref":"launch@6"},"why":"the name alone first"},{"cue":2.5,"dur":3.5,"pacing":"free","media":"none","in":"none","crop":"none","subject":"none","follow":"none","text":{"text":"Plan the week in one view","family":"Montserrat","weight":600,"size":96,"y":50},"sound":"none","why":"one promise, said plainly"}]}]}
{"tool":"look","mode":"board"}
{"tool":"edit","ops":[{"op":"board","music":"none","shots":[{"cue":0,"dur":6,"pacing":"free","media":"none","in":"none","crop":"none","subject":"none","follow":"none","sound":"none","move":{"kind":"ui","name":"roll"},"why":"one card"}]}],"expect":"op_failed"}
```

The last is refused, naming every bad field: no `text`, no `ref`.

## Storyboard: a board from footage

1080×1920, 4.4 s, the 384×216 clip's three shots, each subject marked at its `in`. Shot 2 is flagged: the dragon is almost as wide as the crop (4% from its edge).

```json
{"tool":"edit","ops":[{"op":"board","music":"none","calls":["type set like the title in launch@0.5"],"shots":[{"cue":0,"dur":1.25,"pacing":"free","media":"/api/media/<clip>.mp4","in":0,"crop":[18,12,24,76],"subject":{"what":"the hero's face","box":[20,15,18,37],"eyes":29},"follow":"steady","text":{"text":"The dragon is back","family":"Montserrat","weight":700,"size":80,"y":60},"sound":"none","move":{"kind":"transition","name":"zoom-through","ref":"launch@0.5"},"why":"her face first: the story is hers"},{"cue":1.25,"dur":2.083,"pacing":"free","media":"/api/media/<clip>.mp4","in":1.25,"crop":[4,12,24,76],"subject":{"what":"the red dragon","box":[5,40,22,23]},"follow":"track","text":"none","sound":"none","why":"the threat, small over the city"},{"cue":3.333,"dur":1.067,"pacing":"free","media":"/api/media/<clip>.mp4","in":3.333,"crop":[13.5,12,24,76],"subject":{"what":"the dragon's head","box":[19,34,11,18]},"follow":"track","text":{"text":"Look up","family":"Montserrat","weight":700,"size":120,"y":20},"sound":"none","why":"end on the dragon coming at us"}]}]}
{"tool":"look","mode":"board"}
```
