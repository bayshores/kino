# Blind picks (picks.jsonl)

The owner's blind A/B picks between two videos, made in the desktop app's pick box
(`backend/agent/picks.mjs`, `frontend/dashboard/picks.jsx`). The taste ladder and the judge's
calibration read them.

## Filling the queue

An agent or the command line queues pairs; nothing plays them for the agent:

```json
{"tool":"notes","action":"judge","videos":[["/abs/first.mp4","/abs/second.mp4"]]}
{"tool":"notes","action":"judge","videos":[{"a":"/abs/mix1.mp4","b":"/abs/mix2.mp4","audio":true}]}
```

- Paths are absolute (relative ones resolve in the media folder); mp4, m4v, mov or webm.
- Each pair gets a neutral id (`P1`, `P2`, ...) and a random side for `a`.
- The queue is `<data>/taste/queue.json`, at most 40 pairs; the same pair is not queued twice.
- `audio:true` shows black screens: the person picks on the sound alone (mix picks, T4).
- `picture:true` keeps both muted with no sound buttons: the person picks on the picture alone.

## The sitting

The app asks "which is better?" over the pairs as A (left) and B (right), muted, on one clock,
each paused past its opening (6 s into a long clip, 1 s into a short one) until play starts both
from 0. The person may turn one side's sound on with the toggle in its screen's corner. They pick "A is better", "B is better", "tie" or "both bad" (keys 1, 2, =, 0), with
optional word chips and a note under "why? (optional)". A sitting takes at most 5 picks; a new
one starts after 30 minutes without a pick. Esc ("skip for now") puts the box off; the
command line's `picks` brings it back.

## Format

`<data>/taste/picks.jsonl`, one JSON object a line, appended:

| field | meaning |
| --- | --- |
| `pair_id` | the queue's id, such as `P3` |
| `a`, `b` | the two video paths as queued |
| `shown_left` | `"a"` or `"b"`: which one played on the left (as A) |
| `pick` | the winner: `"a"`, `"b"`, `"same"` (tie) or `"neither"` (both bad), mapped from the side |
| `words` | chips the person chose: `story`, `directing`, `unique`, `impressive`, `quality`, `smooth`, `mix` |
| `note` | the person's words, at most 500 characters, or `""` |
| `at` | ISO time of the pick |
| `mode` | `"video"`, `"audio"` (sound only) or `"picture"` (no sound) |

Readers ignore fields they do not know. `"neither"` is no win for either side: the ladder counts
it as a tie (half a win each, never a decisive pick for judge agreement) and reports how many. A side bias check compares `pick` with `shown_left`.
