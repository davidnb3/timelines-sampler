# Back then: status, decisions and what is still needed

Read this before starting work. It says what is finished (do not redo it), what the owner decided
(do not re-argue it), and what is still open, in priority order. Update it when something is
finished or decided, in the same change. Architecture and commands live in `CLAUDE.md`.

Last updated: 2026-10-30.

## How to work in this repo

- Do only what was asked. A question gets an answer, not a code change. Propose a fix and wait for a yes. (Also in the owner's global `~/.claude/CLAUDE.md`.)
- Commit only when asked. There is no git remote; nothing has been pushed.
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
- **Saved clips are per browser** (localStorage) for now.

## Done

- Ingest: Internet Archive audio and Podcast Index episodes, transcribed locally with whisper.cpp (CPU), stored in SQLite with FTS5. Library: 11 recordings, 2,169 segments (old-time radio, plus two podcasts). Only the first 10 minutes of each were transcribed.
- Search: phrase, then AND, then OR, ranked, topic filter, context expansion. Live GDELT TV caption search (National market only), stream-only playback through the Internet Archive embed.
- UI: idle and active phases, result cards with inline waveform, star or download flies a clip onto the timeline, pan, zoom, fit, popover per pinned clip, keyboard shortcuts, light and dark themes, phone-width layout.
- Fast clip playback: redirects resolved once, then one HTTP Range request per clip (details below). Cuts take about 1 s on Internet Archive files and about 0.15 s on warm podcast files, at any position in the episode.

## Still needed, in priority order

### 1. Sampler features (the point of the app)

- **Trim handles on the waveform** and export of exactly that range (WAV/MP3). The cut endpoint already takes arbitrary start/end for `ep:` refs (10 minute maximum).
- **Drag a clip into a DAW or Finder** instead of using download buttons (HTML5 `DownloadURL` drag, or native drag once wrapped in Tauri/Electron).
- **Play the timeline as a sequence** in date order, with an option to bounce the pinned clips to one file (server-side ffmpeg concat, restricted to `ep:` refs like the clip endpoint). This is the original "quote remixer" idea.

### 2. More material

- **Public-domain films from the Internet Archive.** The owner said this is fine. Needs a video cut (ffmpeg) and a `<video>` player; `Hit.kind` already has `'video'`. Transcribe with Whisper like the radio shows. IA movie files are downloadable, unlike IA TV news files (401).
- **"Add this topic" in the UI** that queues ingest jobs. A server-side job runner does not exist; ingest is a CLI today (`npm run ingest`).
- **Podcasting 2.0 transcripts:** `PiEpisode.transcriptUrl` is already returned by the Podcast Index client but unused. Use a feed's own VTT/SRT instead of Whisper when present. None of the sci-fi feeds tried had one.
- **People's Speech** (Hugging Face `MLCommons/peoples_speech`, about 30,000 hours, CC-BY / CC-BY-SA). Transcripts are searchable without audio; audio sits in large parquet shards (read text columns remotely, range-read audio on play). Mostly audiobooks and talks, so low value for sci-fi dialogue.
- **GDELT International market:** BBC News, Al Jazeera, DW, RT (2017 to 2024-10-10) and NHK (2014 to 2017). Small change in `server/sources/gdelt.ts` (the query currently hard-codes `market:"National"`). All news, stream-only. GDELT TV data ends 2024-10-10.
- Transcribe more than the first 10 minutes of recordings; ingest more sci-fi.

### 3. Infrastructure and housekeeping

- **Server-side store for saved clips** (a SQLite table) with a one-time import from localStorage. Needed before the Tauri/Electron app.
- **GDELT reliability:** the API often fails with "fetch failed" or takes 10 to 20 s. Add one retry and a clearer message.
- **Clip cache growth:** `data/clips/` has no eviction.
- **Git remote and first push** (nothing is pushed anywhere).
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

### Other

- Podcast Index auth is SHA1(key + secret + unix time) in the `Authorization` header, with `X-Auth-Key`, `X-Auth-Date` and a `User-Agent`.
- GDELT TV API needs `market:"National"`; clips play through `archive.org/embed/<id>?start=&end=`; the TV video files themselves return 401.
- Whisper must run on CPU (`-ng`): the Homebrew whisper.cpp 1.9.5 Metal backend aborts. About 2.3x real time with the large-v3-turbo q5_0 model.
- The old name was telly; `web/index.html` migrates old `telly.*` localStorage keys once.
