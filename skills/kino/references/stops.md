# Stops: showing the work and waiting

The brief comes first (direction reference); its examples include a checkpoint and an answer.

## Stops

At a stop you show the person the work and wait. In order: `board` (the storyboard: from 8 s,
footage or graphics only), `rough`, `color` and `sound` (from 15 s). The person sets each to ask
or allow, and those lengths. Ask the storyboard before you build, the others when that pass is
done: `notes {action:"checkpoint", id:"rough"}`. kino answers one of:
- `skipped`, `allowed` (their settings let it pass: say in one line what you checked) or
  `passed` (unchanged since it passed): go on.
- `waiting_for_you` with `id` (C1) and `ask`: the person decides (even if their settings
  allow it, while the ask holds a treatment pick or guessed bans).
- refused: `brief_first`, `check_first`, `out_of_order` (ask the stop it names first),
  `ask_limit`; for the storyboard `board_first`, `board_gap` or `open_items` (storyboard reference).

Before you ask (not the storyboard): a full `check` (no `scene`, no rule list) of this
revision with 0 errors, and your own `look`. "It looks right" is not a check.

## Asking

- Send `ask` as written, plus up to 3 lines (what changed, where to look). Attach
  `look {mode:"sheet"}` (storyboard: `look {mode:"board"}`) when your app can send files.
- End your turn: `Waiting for you: the rough cut (C1)`. Until they answer, writes answer
  `{waiting:"C1"}`; reads, `look`, `check` and `notes` work.
- A stop closes by itself only when the work it showed changed (`lapsed`: check, ask again),
  the video lost that stop, or their settings allow it.

## Their answer

- "ok", "yes", "looks good", "go", "C1 yes": approve. Approval plus a change ("yes, warmer"):
  approve with notes. Only problems: redo.
- Unclear ("hmm", "maybe?"): ask once what they meant. Silence or an unrelated message is
  never an answer.
- Record it word for word with the ask's `rev`: `notes {action:"answer", id:"C1", rev:4,
  words:"<their reply>", read_as:"approve"}`. Then one line, `Read as: approve`: a receipt,
  not a second question.
- After a redo, fix only what they named, `check`, and ask that stop again (a new id).
- An answer in kino shows in your inbox (`answered`): do not record it again. `reopened`: your
  reading was wrong; ask that stop again. A later stop that waited closes.
- "stop asking" counts only on the stop whose ask offers it (the first of rough, color and
  sound): those three then pass for this video, never the storyboard or an approval.
- `Q…` ids are approvals: record a chat yes/no with `notes answer`. Each answer counts toward
  the 10 replies (direction reference). Refused: an answer under 5 s after the ask
  (`too_fast`), one for an unseen revision (`stale_rev`: ask again).

## Finishing

End every turn with one of: `Done: <file>`, `Done, with open questions: …` or
`Waiting for you: the rough cut (C1)`.
