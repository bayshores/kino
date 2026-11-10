# Footage: finding clips the person did not send

Read when the brief is an edit of something that exists (a series, a sport, a trip, a game) and
the person sent no clips, or too few. kino finds videos, scans them for their best shots and
imports only the shots you pick. The person's own clips always lead; found clips fill the gaps.

Contents: Three calls · Visual words, not names · Reading a scan · Note a video · Sources · Limits

## Three calls

```json
{"tool":"library","topic":"footage","search":"stub series fight","want":"bright, fast motion, close up"}
{"tool":"library","topic":"footage","scan":"top"}
{"tool":"project","action":"import","file":"F1","options":{"shots":[1,2]}}
```

1. `search`: the series or subject and the scene. Up to 10 videos, best first (the person's
   pasted link, verified channels, big channels), each `F1`, `F2`... for this video. Other
   people's edits, reactions, reviews, live and members-only videos are dropped. `want` is saved.
2. `scan` (`"top"`, `"F2"` or `"yt:<id>"`): downloads a 360p copy of the parts worth seeing
   (the whole video up to 8 min; else its most replayed parts and the chapters your words name,
   8 min in all; `from`/`to` for one stretch; `whole:true` up to 30 min), then lists the 12 best
   shots. It waits about 50 s; a longer scan answers with progress: send the same call again.
3. `import`: the shots you pick become H.264 clips (1080p at most), each with its credit, ready
   for `compose {footage:[...]}` or `add_layer`. `F1.37` alone imports one shot; `from`/`to` a
   stretch of 60 s at most. Only scanned videos import; 5 min a call, 15 min a project.

`library {topic:"footage"}` lists this video's found videos again. `look {mode:"source",
ref:"F1"}` shows a scan's stills labeled `F1.<shot>`; look at them before you pick.

## Visual words, not names

The image model never learned character names: `want:"<character>"` matches nothing. Turn names
into what the camera sees: hair color, clothes, a mask or blindfold, the setting, the action
("white hair, blindfold, dark coat, fight, close up"). Put the names in `search` instead, where
YouTube's titles carry them. A match shows only when the best shot clearly beats the rest; else
the answer says "no visual match" and shots rank on motion, faces and clean frames.

## Reading a scan

`F1.37 3:17.2-3:19.0 1.8s motion 82 face 40 match +3.1`: shot 37 of F1, its time in the video,
length, motion and face (0 to 100), match (how far above the others it fits `want`). Dark shots,
shots full of text or subtitles and shots under 0.4 s go last; `logo` marks a fixed channel
logo. Skipped counts say what was left out. With a song in the video, the answer says how many
shots it needs (a cut every 2 beats on the drop, 4 on builds) and the import call names up to
1.5 times that. The answer's `next:` is that import call: change the shots after looking.

## Note a video

```json
{"tool":"library","topic":"footage","note":{"id":"F1","verdict":"pick","why":"clean frames, no logo, the fight is in the first 4 minutes"}}
```

verdict is `pick`, `maybe` or `no`; a `no` moves on to the next video. Scanned, noted and
imported videos are never dropped from the list (24 kept).

## Sources

- Each clip keeps its creator and link as metadata. Put no credits on screen unless the person asks.
- A final render's answer has one `Sources` line: pass it on only when the person says they will publish.
- `source:"commons"` searches Wikimedia Commons (needs the web search switch in Settings). No anime there.

## Limits

- No cookies are ever sent. When YouTube asks for a bot check, kino pauses YouTube for 15
  minutes: use the person's clips or Commons meanwhile.
- A video that cannot play here (region, members only, age) is dropped; the answer names the next.
- Nothing for the words: try the English title, a character name or `source:"commons"`.
- Found clips never stand in for a real moment of the person's story (needs reference: ask).
