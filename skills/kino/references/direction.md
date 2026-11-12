# Direction: the brief and the stops

Contents: When · Asking · Saving · Playing it back · Replies · Stops · Finishing · Examples

## When

A new video, not a change to an existing one. If the request answers everything, skip the
questions and play the brief back. If no one can answer (a script runs you, or the request says so), save the brief
in one call (`ask:"none"`, the rest `guessed`) with `no_playback:"no one can answer"` and go
on. The stops still wait for the person: only their answer or settings let one pass.

## Asking

1. First message, the path: "Up to 3 quick questions, then I play the brief back before I
   build. Say "just start" to skip the questions." Then the open question:
   "Who's it for, and what should they feel after watching?" No multiple choice.
2. Ask only what is still missing, one question per message, at most 3 questions in all, in
   this order (`next:` names the first one missing). Skip what the request answered; guess the
   rest:
   - `message`: who it is for and what it tells them.
   - `look_sound`: "If we don't set the look, I'll fall back on generic choices. What should
     it look and sound like?" (their words, or a video they like)
   - `never`: "What would make you wince?" A ban names an execution ("an invented dashboard over
     the real UI"), not a category ("maps"). Only their words ban (quote, scope); guesses: "none said".
   - `plays_on`: their words for the shape or place; none named: the footage's shape (a stop asks)
     (the brief's `shape:` line shows both).
   - `made_from`: footage, music, files.
   - `key_moment` (optional): "What's the one moment that should make someone stop scrolling?"
   - `idea` (optional, yours, not asked): the one idea (ideas reference); stops show it.
   Under 8 s: only the open question. A named length: `project create {duration}` plus the
   brief's `fields:{length:30}`, a gate (`{seconds, tolerance}`; default 2%, min 0.5 s).
3. Don't ask what they can't judge yet (loudness, colors). Before the playback, check
   for clashes ("dark and moody" against "faces readable on a phone").
4. "Just start": save what you have not heard as guessed, with `no_playback:"just start"`;
   say your main calls (and the treatment you picked) in one line and go on.

## Saving

- Save at once, after each reply: `notes {action:"brief", fields, log}`. Lines merge by name;
  `null` removes one. Without fields and log, it reads the brief.
- First save their message whole: `fields:{ask:"<what they typed>"}`; kept as typed, never edited.
  `missing:` names `ask`, then `about`, till saved. No person: `ask:"none"`.
- `by:"you"` needs `quote`: their exact words, copied from their message (no fixed
  typos). Not their words: `by:"guessed"`, no quote. A quote (style's too) not in an ask, a stop
  answer or a note they typed is refused (`quote_not_said`); a `log` reply never counts (put
  each message or reply they type in `ask`).
  `text` (your reading): 80 characters, idea 120.
- `about` `{text, by:"you", quote}` (`by:"guessed"` only under `ask:"none"`): who or what it is
  about, in their words; the first reference search uses it, never the ask. `origin:` is kino's
  own search of it (not yours to save): say it in the playback; name its word in the idea.
- Never put a guess over their line or remove it: ask them, then save their new words.
- Log every reply `{q, a}` word for word (over 2,000 characters: the answering part). Words a
  lead passed on: `{a, kind:"passed_on"}`, not a reply.
- Their answer to a playback: `kind:"playback"` and `rev`, the revision you played back (the
  save answer names it: `brief r3 saved`). Add `confirmed:true` only when they said it is
  right; a yes to an older revision confirms nothing.

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
the 3 shown, and its signature (techniques reference). Earlier, edits are `order_needed`.

## Replies

At most 10 replies from the person per video: answers to a question ("just start" too), a
playback or a stop, not the first request or unasked messages. At 10,
make the remaining calls yourself and say "my call".

## Stops

At a stop you show the person the work and wait for their answer. In order: `board` (the
storyboard: from 8 s, footage or graphics only), `rough`, `color` and `sound` (from
15 s). The person sets each to ask or allow, and those lengths. Ask the storyboard before you
build (`status` says `next: … ask board, then build`), the others when that pass is done
(`next: … then ask rough`): `notes {action:"checkpoint", id:"rough"}`. kino decides; it
answers one of:
- `skipped` (no such stop here), `allowed` (their settings let it pass: say in one
  line what you checked) or `passed` (nothing changed since it passed): go on.
- `waiting_for_you` with `id` (C1) and `ask`: the person decides (even if their settings
  allow it, while the ask holds a treatment pick or guessed bans).
- refused: `brief_first`, `check_first`, `out_of_order` (ask the earlier stop it names
  first) or `ask_limit`; for the storyboard `board_first`, `board_gap` or `open_items` (the
  storyboard reference).

Before you ask (not the storyboard): a full `check` (no `scene`, no rule list) of this
revision with 0 errors, and your own `look`. "It looks right" is not a check.

Asking:
- Send `ask` as written. After its first line you may add up to 3 lines (what changed, where
  to look); the storyboard's ask already lists its shots. Attach `look {mode:"sheet"}` (for the
  storyboard, `look {mode:"board"}`) when your app can send files.
- Then end your turn: `Waiting for you: the rough cut (C1)`. Until they answer, that project's
  writes answer `{waiting:"C1"}` and change nothing; reads, `look`, `check` and `notes` work.
- A stop closes by itself only when the work it showed changed (`lapsed`: check, ask again),
  the video lost that stop, or their settings allow it.

Their answer:
- "ok", "yes", "looks good", "go", "C1 yes": approve. An approval plus a change ("yes,
  warmer"): approve with notes. Only problems: redo.
- Unclear ("hmm", "maybe?"): ask once what they meant. Silence or an unrelated message is
  never an answer.
- Record it word for word with the `rev` of the ask: `notes {action:"answer", id:"C1", rev:4,
  words:"<their reply>", read_as:"approve"}`. Then one line, `Read as: approve`: a receipt,
  not a second question.
- After a redo, fix only what they named, `check`, and ask that stop again (a new id).
- They may answer in kino: your inbox says so (`answered`); do not record it again. `reopened`:
  your reading was wrong; ask the stop the inbox names again. A later stop that waited closes.
- "stop asking" counts only on the stop whose ask offers it (the first of rough, color and
  sound): those three then pass for this video, never the storyboard or an approval.
- `Q…` ids are approvals: record a chat yes/no with `notes answer`.
- Each answer counts toward the 10 replies (`ask_limit` at 10: see Replies).
- kino refuses an answer under 5 s after the ask (`too_fast`) and one for an unseen revision
  (`stale_rev`: ask again).

## Finishing

End every turn with one of: `Done: <file>`, `Done, with open questions: …` or
`Waiting for you: the rough cut (C1)`.

## Examples

```json
{"tool":"notes","action":"brief","fields":{"ask":"my skate crew, they should feel like going out to skate","about":{"text":"the skate crew","by":"you","quote":"my skate crew"},"message":{"text":"skate crew; make them want to skate now","by":"you","quote":"my skate crew, they should feel like going out to skate"},"plays_on":{"text":"16:9, 24 s","by":"guessed"}},"log":[{"q":"Who's it for, and what should they feel after watching?","a":"my skate crew, they should feel like going out to skate"}]}
{"tool":"notes","action":"brief","fields":{"never":{"text":"no meme text","by":"you"}},"expect":"quote_needed"}
{"tool":"notes","action":"brief","log":[{"q":"What's wrong or missing?","a":"looks right","kind":"playback","rev":1,"confirmed":true}]}
{"tool":"notes","action":"brief","fields":{"never":{"text":"no meme text","by":"guessed"}},"log":[{"q":"What would make you wince?","a":"just start"}],"no_playback":"just start"}
{"tool":"notes","action":"checkpoint","id":"rough"}
{"tool":"notes","action":"answer","id":"C9","rev":1,"words":"looks good","read_as":"approve","expect":"not_found"}
```
