# The viewer test

Contents: Intents first · The packet · The fresh viewer · Match it and record it · Fix the story, then ask again · The gate

Read before the final render of a video that tells something (footage, speech, a story), or
when a cut "feels off" and the checks pass. The viewer test checks the story, not the looks:
whether a first-time viewer understands who this is about, what they want, what stands in the
way and how it ends. Checks and `look review` cover type, framing and polish.

You made the video, so you cannot see it fresh: you know what every shot is for. A fresh agent
that never saw the brief can. kino makes what it watches and keeps what it says; kino never
calls a model itself. You start the fresh viewer, as with the storyboard's fresh-eyes check.

## 1. Intents first

Before any viewer watches, write what each beat should leave the viewer knowing or feeling:

```json
{"tool":"notes","action":"intents","beats":[{"from":0,"to":3,"intent":"the viewer knows a judge called this the best project of the hackathon"},{"from":3,"to":6,"intent":"a bike blocks his way; the viewer worries, then is relieved when the app steers him around it"}]}
```

- One beat per idea: hook, goal, obstacle, turn, payoff, end. Times are the video's seconds.
- Say what the viewer gets, not what you put on screen ("the viewer feels relief", not "show
  the bike").
- Intents saved after a packet make that packet stale: write them first, then look.

## 2. The packet

`look {mode:"viewer"}` writes a folder: a frame every 0.5 s, 9 to a sheet with its time on
each, and `heard.txt`, what is heard and when. Its answer prints the prompt for the viewer.

```json
{"tool":"look","mode":"viewer"}
```


- each voice's lines, tagged with its layer's name; a line your captions cover uses the
  caption's words (a machine transcript mishears names);
- each song's stretches: muffled while its low-pass filter is on, full after it opens.

Nothing from the brief, the plan, the intents or other layer names is in it. Name voice layers
for who speaks (`judge`, `app`, `street`), never for what they are for (`hook-line`).

## 3. The fresh viewer

Start a subagent that never saw the brief, the plan or this chat. Give it only the prompt the
answer prints (the folder's paths and the protocol below). Do not add hints, the title or
what to look for: a viewer told what to see sees it.

The protocol: for each sheet, what is happening, who this is about and what they want, what
they expect next, what they could not follow or what pulled their attention away, and every
text they had time to read. At the end: the story in one sentence, the moment they cared
most, where it dragged, what felt unfinished, and how much they wanted to keep watching
(0 to 10) at the start, the middle and the end. It ends with `KEEP start= middle= end=`,
`DRAG <from>-<to>s` lines and `CARED t=<s>`, which kino reads from the report.

With a bar (the person's best earlier cut, `notes {action:"verdict", of, rev, words, best:true}`),
the packet holds two cuts at the same density, blind: a bar frame at the same story point as each
frame of this cut (shared beats, else the same fraction), and heard.txt for each. Which one is A
changes from packet to packet. The report must end with `PREFER A|B · <why>`; preferring the bar
is a warning only (blind viewers can prefer either cut in both orders): the critic's BAR
line is what blocks.

When your app cannot start a subagent, say so to the person and waive the gate (step 6);
never write the report yourself.

## 4. Match it and record it

Compare the report with each intent: `got` is `yes` (the report shows they got it, about
then), `partly` (late, vague or only half) or `no`. Do it yourself, or give a second fresh
agent the intents and the report. With an `idea`, the look answer prints it and the signature:
check the moment they cared most lands on it. Then record the whole report and the match:

```json
{"tool":"notes","action":"viewer","rev":1,"report":"Sheet 1: a judge says this is the best project they saw. Sheet 2: a man walks; the app says a bike is ahead, but I never see one. Story: an app guides a man to a store.","matches":[{"beat":1,"got":"yes","note":"names the judge's line"},{"beat":2,"got":"no","note":"never sees the bike; the warning feels made up"}],"bugs":[{"at":1.5,"what":"three texts at once; could not read them"}]}
```

`rev` is the revision the packet showed. A beat they did not get (`no`) and every bug are open
story bugs, each with its time. A middle or end score under the start score, and a drag over
5 s, are story warnings with their times: fix them before the final render (they hold nothing).
With signatures, a cared-most moment outside them is a direction miss (one line).

What counts as a story bug:

- confusion: they could not say who, what or why at a point where the intent says they should;
- a missed beat: the obstacle never shown, a payoff with no reaction, a win only implied;
- a drag: "nothing new" over a stretch, the keep-watching score falling;
- overload: more text than they had time to read, a caption that disagrees with the voice;
- an ending that feels unfinished.

Tension is in the guesses: a viewer always right about what comes next is bored (flat), one
never right is lost (unclear). Aim for guesses that are sometimes wrong and then make sense.

## 5. Fix the story, then ask again

Fix the cause, not the symptom: show the obstacle instead of a caption saying it, hold on a
face after the payoff, cut the repeated shot, say one thing per beat. A caption is the last
resort, and it never names what the ending reveals: a caption before the last beat with a word
only the last intent says ("Target") holds the final render as `viewer_needed`, unless the voice
says it then. A false hit: `waive_check {code:"spoiler", target:<caption>}`. Then make a new packet
and give it to a **new** fresh viewer (one who read the first report is no longer fresh).
Bugs on the cut it watched ask for a fix first (`step:` names the edit). At most two rounds
a scene: after the second, one edit for its bugs and the gate stops waiting on them. A cut
changed over 10 revisions since the last report is watched again.

## 6. The gate

A final render of a whole video 15 s or longer with footage or speech answers
`viewer_needed` until a viewer report on a recent revision (the last 10) has no open story
bugs, or its second round's bugs had an edit after them. Drafts, stills, cut-short renders, renders the person starts or allows in the app, and
scenes with `waive_check {code:"viewer", target, reason}` go ahead. Waive only for a reason
the person would agree with (they watched it themselves, no subagent is available).
