# Needs: when the material is not enough

Read when the footage, sound or facts you have cannot carry the story: a blurry clip for the key
moment, no face at the payoff, a song that fights the cut, a claim with no proof on screen. Do
not quietly make do. Say it, ask the person, and let them choose what happens.

## When to look

- Before building: once the brief is settled and the references are saved, `status` says
  `check material: notes needs`. Hold each story beat against what you actually have. Its call
  is drafted from your pick (footage of its who, for its tension, with what kino can make now and
  telling it with what exists). Look through the material first: kino refuses the draft until you
  fill what to make now from the files you found; or send `items:[]` when it is enough.
- With web search on, the draft also offers finding it: `library {topic:"footage", search,
  want}`, then scan and import (cost: found clips, not your own shots). Fill its search and want words, or leave it out. Their
  files still lead: found clips fill the gap. Their clips without the pick's who: this is the path.
- After the viewer test: a story bug the material cannot fix (the viewer never sees his face,
  so the payoff does not land) becomes a need, not a caption that explains it away.

## Look around first

The person may not have it, and some moments cannot be shot again. Before you ask, search what
exists for a substitute and put what you found into the options:

- other shots and takes, the screen recording, stills and frame grabs (`look {mode:"source"}`)
- for an edit of something that exists (a series, a sport, a trip): found clips,
  `library {topic:"footage", search}` (footage guide); they fill gaps, never fake a real moment
- the transcript: a line said elsewhere that carries the beat
- other parts of the song (`library sounds`, the song's sections), or no music for a beat
- your saved references: how other edits solved the same gap (`library inspire`)
- what you can make well: a graphic, a title card, a map, a cleaned recording

A need whose options were not searched is the failure to avoid: it hands the person a problem
instead of a choice.

## Ask, with ready answers

A need is a question the person can say no to ("Do you have ...?", never "Get ..."), with 1 to 3
things you can do without it, each with its cost, and one you recommend:

```json
{"tool":"notes","action":"needs","items":[{"what":"a front shot of his face when he arrives","why":"the payoff lands on his reaction; from behind it reads as nothing","ask":"Do you have any clip of his face when he arrives, even from a phone?","options":[{"do":"Hold the wide shot and cut on the door opening","cost":"no reaction, the payoff is the place","recommended":true},{"do":"Freeze on the blurry selfie at 0:42 with a slow push","cost":"soft image, but you see him"}],"from":"you"}]}
```

Then say it plainly in the chat: what is missing, why the video loses it, and the options. The
dashboard shows the same question with a button for each option, "I have it" and "do without"
(the found footage option reads "find footage" there). An item may carry `file:"<name, src or source address>"`: a clip the person already imported is not asked for, and the answer names the import that matched.

## Their answer

Only the person answers. When they answer in the chat, save their words:

```json
{"tool":"notes","action":"needs","id":"M1","answer":"drop","expect":"bad_input"}
{"tool":"notes","action":"needs","id":"M1","answer":"option 1","by":"you","quote":"go with the wide shot"}
```

- `"have"`: they will send it; it waits until you use it: `{id, status:"sent", media}` (the
  src `project import` returned) or `layers`.
- `"option 1"`: you do that option, then mark it made with the layers that do it.
- `"drop"`: do without. `"your call"` from them takes your recommended option.
- `"other"` with `plan`: they asked for something none of the options does ("mute only that
  word"). `plan` says what you will make; then mark it made like an option.
- You never answer for them, and never drop a need alone: that would lower the bar quietly.

```json
{"op":"add_layer","layerType":"text","name":"door-card","properties":{"text":"He made it.","x":160,"y":460,"width":1600,"height":160,"fontSize":120,"fill":"#ffffff"}}
```

```json
{"tool":"notes","action":"needs","id":"M1","status":"made","layers":["door-card"]}
{"tool":"notes","action":"needs","items":[]}
```

`items:[]` records that the material is enough. Say it only when it is.

## Never fake it

No made-up footage of real events, no invented facts, quotes or numbers, no stock clip passed
off as theirs. A graphic that says what happened is fine; a fake of it happening is not.

## The gate

A final render waits while a need is unanswered, a "have" is not sent or a picked option is not
made (`needs_open`), and a 15 s+ video with a brief and footage or speech waits until its
material was checked (`needs_unchecked`). A deliberate skip: `waive_check {code:"needs", target:"*", reason}`.

## Found clips: sources and limits

- Each found clip keeps its creator and link as metadata. Put no credits on screen unless the
  person asks. A final render's answer has one `Sources` line: pass it on only when the person
  says they will publish.
- `source:"commons"` searches Wikimedia Commons (needs the web search switch in Settings).
- No cookies are ever sent. When YouTube asks for a bot check, kino pauses YouTube for 15
  minutes: use the person's clips or Commons meanwhile.
- A video that cannot play here (region, members only, age) is dropped.
- Nothing for the words: try the English title or `source:"commons"`.
- Found clips never stand in for a real moment of the person's story: ask.
