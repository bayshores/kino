# History, notes and the dashboard

Contents: History and notes · Approvals, hold and undo · The crew · Try options

The person watches in the kino app. They approve some calls, can hold your writes, undo your
turns and leave notes. They see each call as it happens, under a name and color kino gives
your session (such as Nova), in plain words (`look at 1.0–2.0 s`), and a striped "building"
outline on layers you changed until a `look` covers them. When they point at layers or a time
range, `status` says `pointing …`.

Every tool also takes `why` (the reason for this call) and `next` (what you do after it), a few
words each. The agent pane shows them under the call, so the person can follow your plan
without reading the ops. With two or more agents at work it shows one card per agent (its
`why` or your plan's step now when you set the plan, and the call running). While you `look`,
the frames you get show under the video; a render shows its progress on the stage. A note
the person addresses to one agent starts `for <name>:`. They change nothing in the project:

```json
{"tool":"check","why":"see what blocks a final render","next":"fix the title's contrast"}
```

In a shell: `kino check why="see what blocks a final render" next="fix the title's contrast"`.

## History and notes

- Your edits are grouped into turns. `history` lists them; `history {action:"revert", turn}`
  undoes one turn and keeps everything after it; `{action:"restore", rev}` brings back a
  saved revision.
- `notes {action:"set_plan", steps:[…]}` sets your plan (a list, or one line split at commas);
  `set_plan {done:[2]}` marks step 2 done.
- The brief (`notes {action:"brief"}`) shows read only on the dashboard; its quotes are
  labeled recorded by the agent.
- `notes {action:"reply", id, text}` when you fixed a person's note: they see it as fixed and
  answer "Looks good" (resolved) or "Not yet" (inbox `N2 not fixed yet: …`, the note is new
  again). A note may carry `@t`, a layer, a scene, an `area x,y w×h` (scene pixels) or `URGENT`.
- Not connected through a Claude Code channel? Run `kino watch` in the background: it prints the
  person's new notes as they leave them, one line per batch (notes written close together come
  as one line). `kino watch pending` exits 2 while any note is unread, for a stop hook.
- An **always** note (status `always ▸`) holds for the whole video. Link the layers it keeps
  with `notes {action:"keep", id, layers}`; an edit that removes one is refused (`kept`, nothing
  saved) and the person decides. Keep working on other things; the answer arrives in your inbox.
  Example: `notes {action:"keep", id:"N2", layers:["logo"]}`.

## Approvals, hold and undo

- Some calls need the person's approval: a final render over 600 frames (counted with
  `options.duration`, fps and boomerang), overwriting an existing file, deleting a scene,
  archiving a project, an import over the person's import limit and share links
  (`project {action:"share", id, role:"view"}`). Files over 100 MB are refused; the import
  limit is 200 MB by default, so an import asks only when the person sets it under 100 MB.
  The person can change these limits.
- They answer at once with `{status:"awaiting_approval", id:"Q1"}`. Keep working; do not send
  it again. A yes or no in the chat counts: `notes {action:"answer", id:"Q1", words, read_as}`.
  The answer arrives in your inbox (`Q1 allowed: …` or `Q1 denied …`), and `render {action:"wait", job:"Q1"}` shows it (for a render, it follows
  the approved job). `render {action:"cancel", job:"Q1"}` withdraws a request still waiting.
- A render request names the revision it draws (`rev`): allowing it renders that revision,
  and if you edit before the person answers it asks again. Starting the same render after an
  edit replaces the waiting request (`replaced:"Q1"`). So render final once your edits are done.
- An allowed import says "send the same import again": do that once. An allowed share link's
  URL is never in the inbox: the first `render {action:"wait", job:"Q1"}` gives it, once, and
  it is not kept after a restart. If it is lost, list that project's links with
  `project {action:"manage", id, options:{resource:"shares", action:"list"}}`, revoke that
  link, and ask again.
- `{held:true}` means the person paused your writes. Nothing was changed. Keep reading
  (`status`, `look`, `check`) and retry after the inbox says "hold released".
- `{waiting:"C1"}` means a stop you asked waits for the person: nothing changed; end your turn
  (the direction guide). Stops are not approvals: only `Q…` ids are. The person's answer in
  kino, or a reopen of yours, comes in your inbox.
- `you reverted T3` in the inbox means the person undid that turn. Do not redo it; read
  their note, if any, and `status` again.

## The crew

kino can start Claude Code or Codex agents itself, within the person's start rules (the crew
screen, F2). Each agent kino starts gets its own name, a task, what it may do (`all`, or
`look`: look and search only) and a budget of calls and minutes.

- A lead (an agent the person started) asks for a helper with `notes {action:"helper", text,
  may?}`. kino starts one of your kind on this project; keep working. Its final message comes
  in your inbox as `◆ Juno (k3) handed back: …`. The person's rules set how many helpers each
  lead may have and how many agents work at once; past them it is refused (`not_allowed`,
  `at_limit`). A helper cannot start helpers.
- When you edit a layer or group, you hold that top-level part (sound layers are `music`, a
  render is `render`) until you have been quiet 2 minutes. Another agent's edit of it answers
  `{crew:"waiting", waiting:"<part>", holder}` and saves nothing: work on another part or try
  later. `notes {action:"release"}` frees what you hold in this project at once. The person's
  own changes never wait.
- `{crew:"denied"}`: you may only look and search. `{crew:"held"}`: the person held you;
  reads still work. `{crew:"budget"}`: your budget is spent and the person was asked; every
  call waits for their answer. `{crew:"stopped"}`: end your turn now.

```json
{"tool":"notes","action":"helper","text":"look at the title and say what to change","may":"look"}
{"tool":"notes","action":"release"}
```

- `notes {action:"judge"}` starts a blind round for this revision (up to 10 pairs: your frame vs a
  saved reference's at the same point, same size, random sides). It answers at once; the result
  arrives in your inbox as `judged rev 147: references 7 · same 2 · yours 1` and the times where a
  reference won. kino starts one by itself when a final render asks for approval. Only the person
  picks. With `videos:[[a, b]], audio?|picture?` it queues videos for blind A/B picks (`evals/taste/picks.md`).

## Try options

`notes {action:"try", question, at, options:[{name, ops}], scene?, topic?, later?}` asks the
person to pick one version of a moment (2 to 4 options; `ops` are edit ops, `[]` keeps it as it
is; `later` lists the topics you plan next). Each option's ops are checked on a copy, then kino
renders the 2 s around `at` once per option; the person picks on the dashboard and your inbox
gets the picked option's ops to apply (or none of these, or skip). One question a round.

```json
{"tool":"edit","ops":[{"op":"add_layer","layerType":"rectangle","name":"card","properties":{"x":0,"y":0,"width":400,"height":300,"fill":"#C8935A"}}]}
{"tool":"notes","action":"try","question":"which color for the card?","at":1,"topic":"color","later":["sound"],"options":[{"name":"as made","ops":[]},{"name":"film","ops":[{"op":"color_filter","layer":"card","filter":"film"}]}]}
```
