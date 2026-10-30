# Back then: status, decisions and what is still needed

Read this before starting work. It says what is finished (do not redo it), what the owner decided
(do not re-argue it), and what is still open, in priority order. Update it when something is
finished or decided, in the same change. Architecture and commands live in `CLAUDE.md`.

Last updated: 2026-11-02.

## How to work in this repo

- Do only what was asked. A question gets an answer, not a code change. Propose a fix and wait for a yes. (Also in the owner's global `~/.claude/CLAUDE.md`.)
- Commit only when asked, and push only when asked. The remote is `origin` = https://github.com/davidnb3/back-then (branch `main`).
- After structural changes, update `CLAUDE.md` (and this file) so they match the code.
- Do not work around a host that blocks the app (no browser User-Agent spoofing). A Buzzsprout feed returned 403 for the default ffmpeg User-Agent; the owner chose to skip that feed instead.
- Never print or commit `.env` values.

## Decisions already made (do not re-open)

- **Personal use.** Licensing and clearance are not handled. If other people ever use it, the movie source gets removed or locked to the owner (the `source` field on every hit makes that easy; an "owner only" flag does not exist yet).
- **No own-library upload for now.** Maybe much later. Sources are open ones: Internet Archive, Podcast Index feeds, GDELT TV captions, later People's Speech.
- **Segment-level results are fine.** No word-level cuts.
- **Favourite topic is sci-fi, but any topic must work.** The topic filter exists; broaden by ingesting.
- **UI is finished and approved:** a dark room, a timeline of saved clips pinned by recording date, a prompt that moves up when you search, light theme as "lights on". Name: Back then. Logo: the symmetric nine-bar pulse with an orange centre bar. Do not redesign unless asked.
- **No whole-episode downloads for clipping.** It does not scale (tens or hundreds of episodes). Clips are cut from byte ranges (see below).
- **Web app first.** A Tauri or Electron wrapper comes later and should need minimal work.
- **Timelines are saved on the server** (SQLite) as named collections; one timeline is one story. The browser only remembers which one is open.

## Done

- Ingest: Internet Archive audio and Podcast Index episodes, transcribed locally with whisper.cpp (CPU), stored in SQLite with FTS5. Library: 11 recordings, 2,169 segments (old-time radio, plus two podcasts). Only the first 10 minutes of each were transcribed.
- Search: phrase, then AND, then OR, ranked, topic filter, context expansion. Live GDELT TV caption search (National market only), stream-only playback through the Internet Archive embed.
- UI: idle and active phases, result cards with inline waveform, star or download flies a clip onto the timeline, pan, zoom, fit, popover per pinned clip, keyboard shortcuts, light and dark themes, phone-width layout.
- **Sampler features (2026-10-31):** trim on the waveform like an Ableton clip (edges drag outward too, middle slides, snap to sentence boundaries, Alt for free placement; the quote follows the selection), loop, a drag handle that drops the clip as a WAV into Finder or a DAW (Chromium `DownloadURL`), and **stories**: "Play story" on the timeline builds one waveform from the pinned library clips in date order (growing out from the middle while loading), plays it with the camera following, and downloads it as WAV or MP3 (`/api/bounce`).
- **Timeline collections (2026-11-02):** timelines live in SQLite (`timelines`, `timeline_clips`), with a switcher in the dock (switch, new, rename, duplicate, delete) and a one-time import of the clips a browser had saved locally. The story and its downloads follow the open timeline and are named after it.
- **Fades (2026-11-01):** drag the square at the top of a trim edge to fade in or out (Ableton-style: diagonal gain line, tapered waveform, shaded corner). They are heard while editing, saved with the clip, applied to downloads, drag-out files and stories. The shrink button on the timeline now also closes the story, which fades out.
- Fast clip playback: redirects resolved once, then one HTTP Range request per clip (details below). Cuts take about 1 s on Internet Archive files and about 0.15 s on warm podcast files, at any position in the episode.

## Still needed, in priority order

### 1. Follow-ups to the sampler features

- **Renewing the story (the owner asked for this, "later"):** a timeline should not be limited to one story. When it holds a lot of content, the owner wants to start a new story from the same timeline: a selection and order of its clips, saved and replayable, with the timeline itself unchanged. The data model is ready for it: clips belong to a timeline, and a story is currently just all library clips of the timeline in date order (`useStory`, `/api/bounce`). Likely shape: a `stories` table (timeline id, name, ordered clip keys, gap) and a story picker in the story panel. Reordering and muting clips (below) belong with it.
- **Trim inside the pinned-clip popover.** Trimming works in result cards only; the popover waveform is read-only. Editing a pinned clip would update the saved clip's range (its key includes the range, so keep the original key to avoid re-triggering the arrival animation).
- **Clips from the same day sit on top of each other** on the timeline (same x). Spread them a little or stack them.
- **Fade curves and defaults:** fades are linear (like Ableton's default). Curve shapes (equal-power, exponential) and a tiny automatic fade on every cut, to avoid clicks when a cut lands mid-waveform, are not done.
- **Reorder or mute clips inside a story** (today the order is the date order and every library clip plays), per-clip gain, and a settable gap (it is the fixed `STORY_GAP_MS`, 400 ms).
- **Native drag into the DAW** once wrapped in Tauri/Electron (browsers other than Chromium cannot do it).
- **Plugins the owner installed (not loaded in the session that built the sampler features, so unused):** *Audiorective* (Web Audio toolkit: reactive primitives, scheduling, parameter automation, DSP effects) fits per-clip effects (reverse, pitch, filter, reverb sends) and a proper scheduler for stories. *AudioPod* (cloud audio tools: speaker-labelled transcription, stem splitting, noise removal, speaker separation, format conversion) fits cleaning old-time-radio audio, isolating a voice from music, and speaker labels. AudioPod sends audio to an external service, so ask before using it.

### 2. More material

- **Public-domain films from the Internet Archive.** The owner said this is fine. Needs a video cut (ffmpeg) and a `<video>` player; `Hit.kind` already has `'video'`. Transcribe with Whisper like the radio shows. IA movie files are downloadable, unlike IA TV news files (401).
- **"Add this topic" in the UI** that queues ingest jobs. A server-side job runner does not exist; ingest is a CLI today (`npm run ingest`).
- **Podcasting 2.0 transcripts:** `PiEpisode.transcriptUrl` is already returned by the Podcast Index client but unused. Use a feed's own VTT/SRT instead of Whisper when present. None of the sci-fi feeds tried had one.
- **People's Speech** (Hugging Face `MLCommons/peoples_speech`, about 30,000 hours, CC-BY / CC-BY-SA). Transcripts are searchable without audio; audio sits in large parquet shards (read text columns remotely, range-read audio on play). Mostly audiobooks and talks, so low value for sci-fi dialogue.
- **GDELT International market:** BBC News, Al Jazeera, DW, RT (2017 to 2024-10-10) and NHK (2014 to 2017). Small change in `server/sources/gdelt.ts` (the query currently hard-codes `market:"National"`). All news, stream-only. GDELT TV data ends 2024-10-10.
- Transcribe more than the first 10 minutes of recordings; ingest more sci-fi.

### 3. Infrastructure and housekeeping

- **GDELT reliability:** the API often fails with "fetch failed" or takes 10 to 20 s. Add one retry and a clearer message.
- **Clip cache growth:** `data/clips/` has no eviction.
- Tauri or Electron wrapper.
- Speaker labels (needs `pyannote`, a Python 3.12 environment via `uv`). Optional.

## Explicitly not needed

- Accounts, auth, payments, hosting for other users.
- Own-library upload (for now), mobile apps, word-level cuts.
- Audioscrape itself (paid). This app is the free alternative.
- Downloading whole episodes to cut clips.

## Verified facts the next agent should know

### Clip cutting (`server/clip.ts`, `server/mp3.ts`)

- The slowness had two causes: podcast links go through up to 5 redirects (about 1.5 s each time, and ffmpeg repeated them on every cut), and for constant-bitrate MP3 without a seek table ffmpeg reads the file from the start up to the clip (cost grows with position: 3.2 MB read to reach 6:40).
- Now: the first request for an episode fetches its first 16 KB with a Range request, which also resolves the redirects; the final URL, the first audio frame offset and the byte rate are cached for 15 minutes. A clip is then one Range request for just its bytes (plus 1 s before and 0.5 s after), written to a temp file; ffmpeg trims to the exact start. `/api/search` warms this for the top 3 hit episodes.
- **The byte rate must be measured, not nominal.** One Internet Archive file is "64 kbps" but its encoder never pads frames, so it really runs at 7962.5 bytes/s; using 8000 put clips 1.9 s off at minute 7. `cbrLayout` measures bytes per frame and reads the padding bits.
- The fast path only applies to constant-bitrate MP3 (every frame the same bitrate, no Xing or VBRI tag, server answers 206). Anything else falls back to ffmpeg on the resolved URL (correct, slower). All 11 current episodes take the fast path.
- Accuracy checks: model byte positions matched ffprobe packet positions to 0 ms at five points on two files; cuts matched a sequential decode within 10 ms on the Internet Archive file, and matched the old ffmpeg cut within 0 to 70 ms on five other episodes (the small gap is probably LAME encoder-delay handling in ffmpeg's own seek).
- **Some hosts serve different audio by User-Agent.** The Simplecast "injector" URL returned different bytes (a timeline shifted by about 7 s) for `curl` than for ffmpeg's `Lavf` or our `back-then/...` User-Agent. Transcription (ffmpeg) and the Range fetch both see the same version, so clips line up with transcripts. If a feed's transcripts and clips ever disagree, check this first, and never validate podcast timing with curl-downloaded files.
- Internet Archive costs about 1 s per HTTP request (first byte 0.7 to 1 s), so about 1 s per cut is the floor there.
- ffmpeg misdetects some Internet Archive MP3s as WAV (an ID3 tag containing "RIFF"); always pass `-f mp3` (`inputFormatArgs`), also to `ffprobe`.

### Sampler features

- Trimming loads a window (clip ±8 s) as one decoded buffer and plays spans of it with Web Audio (`Voice`), so there is no `<audio>` element any more. Clip edges are applied on release: the region changes live while dragging and the card's `Hit` (range, text, segment indexes) is replaced on pointer-up.
- Selection text uses whisper segments, which are sentence-sized (some 17 s long): a selection inside one long segment returns that whole sentence. There is no word-level timing.
- The story joins clips client-side for playback and server-side (`/api/bounce`, ffmpeg concat of cached WAV cuts plus a generated silence file) for downloads; both use `STORY_GAP_MS`. TV clips cannot be cut and are left out of stories (the panel says how many).
- Same-day clips share an x position on the timeline; the story order between them is the order they were saved.

### Other

- Podcast Index auth is SHA1(key + secret + unix time) in the `Authorization` header, with `X-Auth-Key`, `X-Auth-Date` and a `User-Agent`.
- GDELT TV API needs `market:"National"`; clips play through `archive.org/embed/<id>?start=&end=`; the TV video files themselves return 401.
- Whisper must run on CPU (`-ng`): the Homebrew whisper.cpp 1.9.5 Metal backend aborts. About 2.3x real time with the large-v3-turbo q5_0 model.
- The old name was telly; `web/index.html` migrates old `telly.*` localStorage keys once.
