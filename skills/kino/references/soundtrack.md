# Soundtrack

Pick music for the story's emotional shape, not for a genre alone: pros pick the tone and the lane
first (driving electronic, hip-hop beat, cinematic...), then the song whose shape fits the cut.
kino finds songs, measures them, gives each a lane and lines it up against the video's story
beats; you decide which fits and say why. Real released songs are the default (named, searched or
explored, from YouTube; no switch). kino's own tracks are a fallback (sound-library guide).

Contents: Principles · Named song · Search · Measure and compare · Note your verdict · No music · Hear the mix · More like a song · Brief and lanes

## Principles

- Lane first: write the brief from the person's words (want, and what not), search 3 to 5
  different lanes, then narrow to the lane they pick. Two "no"s in one lane close it.
- Then the story: where tension builds, where the payoff lands, where speech needs room.
  Write the beats first (`notes {action:"intents"}`); without them kino treats the scene as one beat.
- Compare a few (three to five), and measure before choosing: a title and a mood tag say little,
  a loudness curve against your beats says a lot.
- The drop belongs on the payoff. A song whose drop lands 4 s early pulls the climax forward.
- Speech needs room: under a spoken line, quieter is better (lower energy numbers in that beat).
- Prefer cutting the song to the edit's beats (start it later, end on a section change) when the
  story needs its own timing; cut the edit to the song only when the music is the story.
- Real songs from YouTube are normal: `project {action:"import", file:"yt:<id>"}` brings one in
  whole (WAV). kino keeps each credit with the file as metadata; the final render lists sources.
  Never ask about rights and never add credit cards unless the person asks.

## Named song

A song the person names is the song: `library {topic:"soundtrack", song:"Melatonin by Tinashe"}`
("Artist - Title", a YouTube link or `yt:<id>` too) finds the upload ("- Topic" first), marks it
picked and measures it in the background; then import it.

## Search

YouTube songs come first (yt-dlp). Openverse and the Internet Archive (Creative Commons music)
follow when the person's web search switch in kino Settings is on. Answers are cached for a day.
All are asked at once; once one answers, the others get 8 s more.

```json
{"tool":"library","topic":"soundtrack","search":"tense cinematic build, 120 bpm"}
```

`source:"openverse"`, `"archive"` or `"youtube"` asks only one. Ids are `openverse:<id>`,
`archive:<item>/<file>` or `yt:<id>`.
YouTube answers skip reviews, live sets, lyric, slowed and mix uploads (unless your words ask for
one), repeats, and junk always: type beats, [FREE] beats, BPM practice tracks, game videos, royalty
free stock and hour-long mixes. Genre words alone ("french house") find mostly mixes: use explore. A video keeps 24 candidates; measured, noted and picked songs are never dropped.

## Measure and compare

```json
{"tool":"library","topic":"soundtrack","measure":"<id from the search>"}
```

kino downloads one song at a time (4 minutes at most), finds its tempo and beat grid ("130 bpm
(or 65)" names the other octave), a loudness curve (0 to 100 a second), its sections (intro, build,
drop, break, outro), a `sound:` fingerprint (groove; bass, brightness, density, dynamics, vocals 0
to 100) and the spans where a voice sings (whisper.cpp; a guess without it), then deletes the file.
It keeps a small preview (the whole song, or 90 s from build through drop) for the music tab. The
answer lines it up against the beats: where to start the song so its first drop lands on the
payoff, how far off it lands, the energy under each beat, breaks inside the video, and how short
the song is. `library {topic:"soundtrack"}` lists every candidate with these numbers again.

Each measured song also gets `fit` 0 to 100, its lane and a few words why. Taste, lane and the
brief decide first; story fit only orders songs inside that (fit = 75% preference, 25% story):
- measure keeps the song's sound as a LAION-CLAP embedding (3 windows of 10 s). Its lane is the
  closest of 10 lane prompts (electronic pop, house, guitar, hip-hop, lo-fi, cinematic, synthwave,
  ambient, folk, trap), compared after subtracting the pool's average song.
- taste: how close the song is to the nearest liked song minus half its closeness to the nearest
  rejected one. Two or more rejects in one lane (and no like there) exclude the lane: those songs
  rank last with "you said no to 2 cinematic songs". The person's own "use" is 90 or more, "no" 15
  or less. Songs without an embedding compare by tempo and the 5 features instead.
- brief: closeness to `want` minus closeness to each `not` (see below).
- Taste and brief are spread over the candidates, so fits differ; story: drop near the payoff,
  energy rising to the payoff beat, the song long enough; sung vocals over spoken lines count against.
- Without the model (no network on first use) the answer says so once.

`library {topic:"soundtrack"}` lists measured songs as a varied shortlist: the best fit first, then
the best song least like those above it, so the top 3 cover several lanes until the person has liked
2 songs. Fit ranks; you still decide.

## Note your verdict

```json
{"tool":"library","topic":"soundtrack","note":{"id":"<id>","why":"drop lands 0.4 s after the reveal; low under the voice in beat 2","verdict":"pick"}}
```

verdict is `pick`, `maybe` or `no`. The person sees the candidates on the inspire screen (source,
tempo, fit, the energy curve over the beats, your verdict and why) and marks songs "use" or "no";
you hear it in your inbox. Only the person can. Both are kept as their taste across projects. Then import it like any media:
`project {action:"import", file:"<yt:, openverse: or archive: id>"}`. The credit stays with the file.

## No music, and the sound stop

A video of 10 s or more with no song under it is never silent by accident:
- `check` warns `no_music` (no audio layer kino hears a beat in, and none playing 30% of the
  video that is not a transcribed voice). Its fix is the next call: a named song, a search or explore.
- The sound stop refuses (`music_first`) until you found and measured 2 songs (YouTube needs no
  switch). Where kino has no song search, its ask says "No music yet: name a song or artist, send
  a track, or keep it silent." A plain approval ("your call", "ok") passes it as
  "silent by the person's call": say exactly that in your final message, never that they asked for silence.
- Search found nothing: `waive_check {code:"no_music", target:"*", reason}`. The person asked
  for silence: add `quote` (their words). Your own waiver never skips measuring found songs.

## Hear the mix in numbers

`look {mode:"motion", ref:"sound"}` (the CLI also takes `mode:"sound"`) measures the mix (FFmpeg
ebur128; nothing is played): short-term loudness every 0.5 s (`st:`), each beat's level (spine,
else intents), each spoken line in LU over the music (under 6 is flagged; 8 to 10 is good), the
songs' sections in video time and the ducking dips, with one graph.

## More like a song the person likes

When the person names or picks a song, start from it: YouTube's own mix for that song finds songs
in the same lane far better than mood words.

```json
{"tool":"library","topic":"soundtrack","like":"yt:L2_yy-B2eC4"}
```

It adds up to 12 songs from the mix (filtered like a search, without the seed or
songs the person said no to). `like:""` uses the person's liked YouTube songs (up to 3) as seeds.
Measure the likely ones; they rank by fit.

## Brief and lanes

Write the brief before searching, from the person's words: `want` is the sound (lane, mood,
instruments), each `not` one thing to avoid. Each is scored on its own (CLAP has no "no", so never
write "no vocals" in want). It is saved with the project's soundtrack and shown in its answer.

```json
{"tool":"library","topic":"soundtrack","brief":{"want":"upbeat, playful, confident, modern electronic","not":["cinematic","vocals"]}}
```

`brief:null` clears it. Then explore.

## Explore by lanes

Real songs by genre, without naming artists: kino picks 5 lanes from the brief (skipping lanes its
`not` names and lanes the person closed with two rejects; with no brief, clearly different lanes),
takes songs for each lane's genre tags from ListenBrainz (an open music catalog, no key), finds each
on YouTube by artist and title ("Artist - Topic" uploads first) and measures them in the background.

```json
{"tool":"library","topic":"soundtrack","explore":true}
```

`explore:{lanes:4..6, per:2..3}` sets how many. The answer lists each queued song with its lane and
tag; it takes about a minute. Measuring runs one song at a time (about 20 s each): wait, then
`library {topic:"soundtrack"}` ranks them (a song still "not measured" is not done). Exploring again
skips songs already kept. Let the person pick the lane on the music tab.
