# Found clips: cuts, edge frames and burned-in text

Read before you place a found or scanned clip. These checks are facts: none blocks a render.

## Cuts and edge frames

- An edge frame is a whip, flash, black or card frame (under 6 frames) at a shot's start or end. The shot finder marks them; a found-footage import of a scanned shot leaves them out and says `left out N edge frames at its start` (or `end`).
- `look {mode:"source", layer:"<file>"}` lists a file's edge frames in file seconds and labels their tiles `edge`.
- `check` names a `source_cut` (info) for every video layer whose shown span holds a cut of its file or a shot's edge frames: the scene second, the file second, the frames of the other picture shown, and the layer fields (`mediaOffset`, `mediaStart`, `mediaDuration`) that keep the longer side. Frames held by `mediaFreeze` count.
- `source_cut` also names picture changes inside one saved shot (a found clip's montage or short cutaway) as runs: `a run of 10 changes file 0.61-1.02 s (scene 11.76-12.17 s)`. Its fix moves `mediaOffset` to a clean stretch of the same shot that holds the layer's length; when none is that long it trims the layer, and the trimmed time shows whatever is under it (a held frame or the background), so look at frames before applying it. A file scanned before the current shot version gets its changes after one `look source` on its layer.
- In a dim found clip (median 32x18 spread under 16 of 255) the shot finder compares frames with the shot's own average frame taken out, so cuts under a fixed vignette or grain are saved as `shot.changes` too.
- A board shot that runs into a cut and the edge frames beside it by under 0.25 s slides past both (storyboard reference).
- `update_layer` with `mediaFreeze:null` reads as `"none"`.

## Burned-in text

- `look {mode:"source"}` prints a `burned-in text` line per clip, on a Mac only. A mark is the same words in one place near an edge (a site name top-left, held on half the frames read); a subtitle is a low middle line, with file seconds and boxes. Elsewhere it prints `burned-in text: not read on this system`. Screen recordings get no `burned_text`.
- On any system it also names a static overlay found without reading letters: `a static overlay (8-29% across, 77-94% down) on 7 of 7 frames, text not read`. Its box can be a still wall's edge (a black bar is not one): look at the source picture before cropping to it.
- `check` adds `burned_text` (info) when a kino text sits beside a burned-in subtitle, or a mark shows in the frame. Each names one crop call (`update_layers` for every layer of that file in the same box), its zoom and the share of the subject it cuts.
- `library {topic:"burned-text"}` explains how the text is read and reported.

## Marks on another file

- `check`'s `crop_no_subject` reads the marked subject first. A mark made on another file does not count, and the check says so: `mark_subject` again on this file.
- The `mark_subject` receipt ends with where `crop_no_subject` stands for that layer: `not flagged`, or `still error` with the second it fails at, what the mark lacks and the call to send again with `part`. No second check is needed.
