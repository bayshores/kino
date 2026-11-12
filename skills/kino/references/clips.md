# Found clips: cuts, edge frames and burned-in text

Read before you place a found or scanned clip. These checks are facts: none blocks a render.

## Cuts and edge frames

- An edge frame is a whip, flash, black or card frame (under 6 frames) at a shot's start or end. The shot finder marks them; a found-footage import of a scanned shot leaves them out and says `left out N edge frames at its start` (or `end`).
- `look {mode:"source", layer:"<file>"}` lists a file's edge frames in file seconds and labels their tiles `edge`.
- `check` names a `source_cut` (info) for every video layer whose shown span holds a cut of its file or a shot's edge frames: the scene second, the file second, the frames of the other picture shown, and the layer fields (`mediaOffset`, `mediaStart`, `mediaDuration`) that keep the longer side. Frames held by `mediaFreeze` count.
- A board shot that runs into a cut and the edge frames beside it by under 0.25 s slides past both (storyboard reference).

## Burned-in text

- `look {mode:"source"}` prints a `burned-in text` line per clip, on a Mac only. A mark is the same words in one place near an edge (a site name top-left, held on half the frames read); a subtitle is a low middle line, with file seconds and boxes. Elsewhere it prints `burned-in text: not read on this system`. Screen recordings get no `burned_text`.
- `check` adds `burned_text` (info) when a kino text sits beside a burned-in subtitle, or a mark shows in the frame. Each names one crop call (`update_layers` for every layer of that file in the same box), its zoom and the share of the subject it cuts.
- `library {topic:"burned-text"}` explains how the text is read and reported.

## Marks on another file

- `check`'s `crop_no_subject` reads the marked subject first. A mark made on another file does not count, and the check says so: `mark_subject` again on this file.
