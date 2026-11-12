# The fresh-eyes critic

kino cannot start an agent; you can. Before a final render of a video of 10 s or more (a real
edit: a brief and over 30 layers, or 10+ in 15 s+), `step:` names `look {mode:"critique"}` once. A fresh critic that never saw your chat reads the packet and
answers in short lines; you record them, fix the P0s and try its UP lines.

## The loop

1. After `look {mode:"review"}`: `look {mode:"critique", scene?, from?, to?}`. It writes
   `packet.txt` and the pages (`sheet-01.jpg`, ...) beside the look images, and answers the prompt to give
   the critic. One page comes inline; `page:n` shows another (the saved page of this rev).
2. Start a fresh subagent with only that prompt (brief below). It never edits.
3. `notes {action:"critique", rev, lines:[...]}` with its lines exactly as written.
4. A line (P0, P1 or P2) whose change cuts, shrinks or flattens a designed moment (one
   continuous take, slower, hold each shot longer, no pop), or something inside a signature
   range (its time), is a question, not a fix: a designed moment is a set piece, a signature
   move, a reveal, the payoff (or its slam), a transition, flash, freeze, typed text, rewind,
   fast cut run, or one of the style bible's `moves`, named in the line's where or problem. A real defect there (unreadable
   or too fast to read, clipped, covered, out of sync, frozen, a typo) stays a P0. kino marks it `ask`
   and `notes {action:"checkpoint", id:"critique"}` asks the person.
   Any other P0 is on the fix list: make the changes you agree with. The final render does not wait on it; its receipt lists open P0s and drops one about a deleted shot.
   A fix-list line that moves, trims or cuts the shot the ask points to ends `changes the shot the
   ask points to ("<word>")`: a label, not a gate. Weigh it, then make or skip it.
5. One round a scene per story. A line that would cut a designed moment still goes to the person: `notes {action:"checkpoint", id:"critique"}`, then `notes answer`.
6. A round with no P0 (`none`, or only P1/P2) must be about the video as it is: on a packet
   the video was edited past it is refused.
7. When the viewer gate is due too (intents written, no bar), the packet carries its sheets and
   heard.txt: one subagent writes part 1 (the viewer) to viewer.txt; only then does packet.txt
   appear, so it never sees the brief first. It answers part 2. One `notes critique` takes the
   lines plus `matches`, `bugs` (the report comes from viewer.txt). A P0 or a story bug is a fix list.

## The bar and the person's verdicts

A critic judging a cut alone can rate a cut the person called sloppy and jarring level with
their best. Save the person's verdicts on past cuts, in their words: `notes {action:"verdict", of:"<project>", rev, words, wrong?}`; `best:true` makes one
the bar. Every packet lists the verdicts as anchors. With a bar, the first two pages are this cut
and the bar at the same story points (shared spine beats, else even fractions), and the critic's
first line is `BAR better|worse · <what, at which times>`. A round without it is refused;
`BAR worse` is a P0 on the fix list; the final render names it on its receipt and does not wait for a round that compares.

Every critic also answers the anti-AI-edit questions: is each device from the story or
decoration; do captions break as spoken phrases timed to the voice; do cuts land on an action
or the voice; do the title and end card feel designed or templated; at each hit, does the picture change as much as your saved references do at theirs, or is the hit decoration? Principles, not a house style.

## The packet

- The idea and its signature (what, source, time), then the story spine and style bible (fonts,
  accent, moves, wants and avoids), or the brief.
- The person's open notes and the rejected lines.
- The gates and brief-tied findings at their times (triaged as in `check`).
- The motion trace (as `look motion`) for the stretch.
- Pages: seam strips (5 frames from -0.2 s to +0.2 s across each cut, 4 cuts a page), then the
  frames at each finding and beat boundary (9 a page). Each page has its own questions.

## The line form

`P0|P1|P2 t=<seconds> · <where> · <problem> → <exact change> · <what stays>`

- P0 breaks the video: story unclear, jarring motion, unreadable, off the brief or a rejected line.
- P1 weakens it. P2 is polish. No scores; `none` when nothing is wrong.
- First line: `OWN t=<seconds> · <the moment only this product could have>`, or
  `GENERIC · <why it could be any product> → <that moment, from its real material>`. GENERIC
  is a P0 on the fix list: find that moment.
- `->` and `|` are accepted for `→` and `·`; a span (`t=19-25.7`) counts from its start. A line in
  another form, or a score, is refused.

Then the elevation pass, `UP t=<seconds> · add <what> · serves <the idea or beat>`: the most
forgettable 10 s and what makes it the best moment, the poster frame, what a top editor would
add, where the music drops out or hits. UP lines never block; the answer lists them under "To
raise it"; they stay in the round's record and the critique stop shows them to the person.
Signatures may be polished, never cut: an UP that cuts one becomes a question.

## Brief for the critic (paste as the subagent's whole prompt)

Claude Code (Agent tool) or Codex: start a new agent with no history and send:

```
<the prompt look critique answered, between the --- lines>
Read only the files named above. Do not open other files, do not run kino, do not edit.
Answer only with P0/P1/P2 lines in the form given, worst first (or: none), then the UP lines
```

With the viewer's sheets, its answer is the lines only; part 1 is in viewer.txt.

Paste its answer into `notes critique` unchanged; do not soften or drop lines.

## Example

```
P0 t=4.2 · cut to shot 3 · the eye has nowhere to land → start the title 0.2 s after the cut, centered · the cut time
P1 t=8.0 · phone bezel · hangs at the right edge for 0.6 s → push it out by 9.0 s · the push speed
P2 t=12.5 · end card · logo small → scale the logo to 160 px · its color
UP t=14 · add a slow push into the reply box with the rest dimmed · serves the payoff beat
```
