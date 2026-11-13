# Direction: the brief and the stops

Contents: When · Asking · Saving · Playing it back · Sketch rounds · Replies · Stops · Examples

## When

A new video, not a change to an existing one. If the request answers everything, skip the
questions and play the brief back. If no one can answer (a script runs you, or the request
says so), save the brief in one call (`ask:"none"`, the rest `guessed`) with
`no_playback:"no one can answer"` and go on. The stops still wait for the person: only their
answer or settings let one pass.

## Asking

1. First message, the path: "Up to 3 quick questions, then I play the brief back before I
   build. Say "just start" to skip the questions." Then the open question:
   "Who's it for, and what should they feel after watching?" No multiple choice.
2. Ask only what is still missing, one question per message, at most 3 in all, in this order
   (`next:` names the first one missing). Skip what the request answered; guess the rest:
   - `message`: who it is for and what it tells them.
   - `look_sound`: "If we don't set the look, I'll fall back on generic choices. What should
     it look and sound like?" (their words, or a video they like)
   - `never`: "What would make you wince?" A ban names an execution ("an invented dashboard over
     the real UI"), not a category ("maps"). Only their words ban (quote, scope); guesses: "none said".
   - `plays_on`: their words for the shape or place; none named: kino sets the footage's shape
     before a board saves (a stop asks; the brief's `shape:` line shows both).
   - `made_from`: footage, music, files.
   - `key_moment` (optional): "What's the one moment that should make someone stop scrolling?"
   - `idea` (optional, yours, not asked): the one idea (ideas reference); stops show it.
   Under 8 s: only the open question. A named length: `project create {duration}` plus
   `fields:{length:30}`, a gate (`{seconds, tolerance}`; default 2%, min 0.5 s).
3. Don't ask what they can't judge yet (loudness, colors). Before the playback, check
   for clashes ("dark and moody" against "faces readable on a phone").
4. "Just start": save what you have not heard as guessed, with `no_playback:"just start"`;
   say your main calls (and the treatment you picked) in one line and go on.

## Saving

- Save after each reply: `notes {action:"brief", fields, log}`. Lines merge by name; `null`
  removes one. Without fields and log, it reads the brief.
- First their message whole: `fields:{ask:"<what they typed>"}`, never edited. `missing:` names
  `ask`, then `about`, till saved. No person: `ask:"none"`.
- `by:"you"` needs `quote`: their exact words from their message (typos kept). Else
  `by:"guessed"`, no quote. A quote not in an ask, a stop answer or a note they typed is refused
  (`quote_not_said`); a `log` reply never counts (put each message they type in `ask`).
  `text` (your reading): 120 characters, idea 120; the `message` and `look_sound` lines take up
  to 120 too, and the refusal says how many to cut.
- `about` `{text, by:"you", quote}` (`guessed` only under `ask:"none"`): who or what it is about,
  in their words; the first reference search uses it, never the ask. `origin:` is kino's own
  search of it: say it in the playback; name its word in the idea.
- Never put a guess over their line or remove it: ask them, then save their new words.
- Log every reply `{q, a}` word for word (over 2,000 characters: the answering part). Words a
  lead passed on: `{a, kind:"passed_on"}`.
- Their answer to a playback: `kind:"playback"` and `rev`, the revision you played back (`brief
  r3 saved`). `confirmed:true` only when they said it is right; a yes to an older revision
  confirms nothing.

## Playing it back

Play it back in 5–8 lines, each starting `- `, then exactly `What's wrong or missing?`:

```
Here's the brief. Quotes are yours; "guess" is mine.
- message: you said "my skate crew, they should feel like going out to skate"
- plays on: guess: 16:9, 24 s (skate.mp4 is 16:9)
- made from: guess: skate.mp4, its own sound
- look and sound: you said "raw and bright, real street sound, no synth dings"
- never: you said "no meme text and don't crop our faces out"
What's wrong or missing?
```

A correction: save it and play it back again. No revision numbers in the chat. Then, before
building: 2 saved references, each studied (inspire reference); 5 treatments and the pick of
the 3 shown, and its signature (techniques reference). Earlier, edits are `order_needed`. A
studied reference prints a `skeleton:` line (its shots, holds, fast runs and change point);
`borrow_rhythm` lends it (inspire reference).

## Sketch rounds

- One small call per treatment, kino builds each 6 s sketch on a fresh copy:
  `notes {action:"try", options:[{treatment:"A", song:"music:<id>", font:"<family>"},
  {treatment:"B", song:"<title> by <artist>"}, ...], seconds?}`. song is a project
  file, `music:<id>` or a named song kino fetches (played from its measured drop); `line` the
  words (default: the treatment's quoted words); `clips:[{file, in?}]` project files (default:
  the files its source names). Cuts land on the song's beats; `ops` still apply after. A pick
  saves its song stretch and font with the treatment pick.
- With treatments saved, `notes {action:"try", from, to, options:[{treatment:"A", ops}]}` shows
  2 to 4 sketches of the shown treatments (A to C, D if listed). Each is its ops on a copy over
  2 to 10 s with sound; nothing is saved. `name` is optional (it defaults to the treatment's
  move).
- The person plays one on the dashboard and one click picks. The pick saves that treatment as
  theirs, as if they had typed it; the inbox line names it with the sketch's ops and `status`
  `next:` names the step after. Nothing waits on a round. Your own pick
  (`fields:{treatments:{pick, why}}`) still works. If you save the treatments again before they
  pick, the pick is not saved and the inbox line says which idea the sketch showed.
- With no treatments saved, `options:[{name, ops}]` over `from`, `to` makes named sketches with
  sound. A pick reaches the inbox with its ops.
- While someone is at the kino app, `status` `next:` after the treatments is this round, filled
  (letters, clips, lines), also under "just start": choose each `song` and `font`. One round per
  set of treatments; without a pick the pick is yours, with why.
- The receipt prints per sketch: render seconds per sketch second, picture changes, median
  shot, lettering share, LUFS and top colors, then the closest pair and their color overlap.
  They are facts: kino never warns on them. Details: `library {topic:"rules", name:"sketches"}`.

## Replies

At most 10 replies from the person per video: answers to a question ("just start" too), a
playback or a stop, not the first request or unasked messages. At 10, make the remaining calls
yourself and say "my call". `ask_limit` refuses more.

## Stops

The stops (board, rough, color, sound), asking one, reading the answer and how a turn ends:
the stops reference. The checkpoint and answer calls are in the examples below.

## Examples

```json
{"tool":"notes","action":"brief","fields":{"ask":"my skate crew, they should feel like going out to skate","about":{"text":"the skate crew","by":"you","quote":"my skate crew"},"message":{"text":"skate crew; make them want to skate now","by":"you","quote":"my skate crew, they should feel like going out to skate"},"plays_on":{"text":"16:9, 24 s","by":"guessed"}},"log":[{"q":"Who's it for, and what should they feel after watching?","a":"my skate crew, they should feel like going out to skate"}]}
{"tool":"notes","action":"brief","fields":{"never":{"text":"no meme text","by":"you"}},"expect":"quote_needed"}
{"tool":"notes","action":"brief","log":[{"q":"What's wrong or missing?","a":"looks right","kind":"playback","rev":1,"confirmed":true}]}
{"tool":"notes","action":"brief","fields":{"never":{"text":"no meme text","by":"guessed"}},"log":[{"q":"What would make you wince?","a":"just start"}],"no_playback":"just start"}
{"tool":"notes","action":"checkpoint","id":"rough"}
{"tool":"notes","action":"answer","id":"C9","rev":1,"words":"looks good","read_as":"approve","expect":"not_found"}
```
