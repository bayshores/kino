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
- While the board stop waits, send a revised board as an edit of `board` ops only (a refused
  one's `edit {retry, fix}` works too): it saves, and the receipt's `stop.ask` (with
  `stop.image`, the new style frame, when there is one) is the refreshed ask. Send it as written
  and end your turn; the person answers once, at `stop.rev`.
- A stop closes by itself only when the work it showed changed (`lapsed`: check, ask again),
  the video lost that stop, or their settings allow it.

## Their answer

- "ok", "yes", "looks good", "go", "C1 yes": approve. Approval plus a change ("yes, warmer"):
  approve with notes. Only problems: redo.
- Unclear ("hmm", "maybe?"): ask once what they meant. Silence or an unrelated message is
  never an answer.
- Record it word for word with the ask's `rev`: `notes {action:"answer", id:"C1", rev:4,
  words:"<their reply>", read_as:"approve"}`. `id` may be a stop's name (`id:"board"`) for the stop that waits; `not_found` lists the stops asked. Then one line, `Read as: approve`: a receipt,
  not a second question.
- "Your call" about the treatment pick or the board's open items: `notes {action:"answer", id:"treatments", words:"<their words>", read_as:"your call"}` (`id:"board"` for the board). No quote is needed, and the answer lists what is now yours to decide; after one on the pick, the next call is your own `{pick, why}`, never `{pick, quote}`.
- After a redo, fix only what they named, `check`, and ask that stop again (a new id).
- An answer in kino shows in your inbox (`answered`): do not record it again. `reopened`: your
  reading was wrong; ask that stop again. A later stop that waited closes.
- "stop asking" counts only on the stop whose ask offers it (the first of rough, color and
  sound): those three then pass for this video, never the storyboard or an approval.
- `Q…` ids are approvals: record a chat yes/no with `notes answer`. Each answer counts toward
  the 10 replies (direction reference). Refused: an answer under 5 s after the ask
  (`too_fast`), one for an unseen revision (`stale_rev`: ask again).

## Fresh-eyes check before the storyboard ask

Before you ask, if your app can start a second agent, give it only the brief's lines, the
project id and this: "Read the storyboard with look {project, mode:"board", page} (every page;
change nothing). List where you would have to guess, and the top 3 problems you can see." Fix
the small ones yourself and add each to `calls` (edit `board`; they show as "my calls"). Only
questions for the person go out, in one message. At most 2 rounds. Then ask with
`fresh:"ran"`, or `fresh:"skipped"` when your app cannot start one. (After superpowers' builder-check prompt, obra/superpowers, MIT.)

## After the storyboard is approved

Build it in one call, `edit {ops:[{op:"compose", from:"board"}]}`: a layer per shot in board
order, board music kept; sent again it replaces only its board-* layers. kino keeps a copy of the
approved board: build to it. These lapse the approval: media, text, sound, pacing, follow, move,
music (or its file), shot order, a shot added or removed, a new open item; a cut, in-point or end
moved over 6 frames; a crop changed over 5% of the frame width. `board.lapsed` and `status` say
so: ask again (only changed shots show). A gap lapses it until covered. Smaller changes are logged
(`board.revisions`), as is adding or changing a text's `until` ('shot 3 words held until 5.5 s');
the words, font, size, y or fill still lapse. "Approve with notes": make the changes. After the
person answers rough, color or sound, only another song, media or shot list lapses it. Approved
with only "your call": fix what a viewer finds (cut a repeat), never waive it.

## Finishing

End every turn with one of: `Done: <file>`, `Done, with open questions: …` or
`Waiting for you: the rough cut (C1)`.
