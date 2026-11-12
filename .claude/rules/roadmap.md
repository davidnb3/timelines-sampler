# Timelines: status, decisions and what is still needed

Read this before starting work. It says what is finished (do not redo it), what the owner decided
(do not re-argue it), and what is still open, in priority order. Update it when something is
finished or decided, in the same change. Architecture and commands live in `CLAUDE.md`.

Last updated: 2026-11-09.

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
- **UI is finished and approved:** a dark room, a timeline of saved clips pinned by recording date, a prompt that moves up when you search, light theme as "lights on". Name: Timelines (renamed from Back then on 2026-11-12; before that telly), written in Instrument Serif italic. Logo: the symmetric nine-bar pulse with an orange centre bar. Do not redesign unless asked.
- **No whole-episode downloads for clipping.** It does not scale (tens or hundreds of episodes). Clips are cut from byte ranges (see below).
- **Web app first, then the Electron desktop app (built 2026-11-09).** Electron, not Tauri (reasons in `desktop-app.md`).
- **Timelines are saved on the server** (SQLite) as named collections; one timeline is one story. The browser only remembers which one is open.

## Done

- Ingest: Internet Archive audio and Podcast Index episodes, transcribed locally with whisper.cpp (CPU), stored in SQLite with FTS5. Library: 11 recordings, 2,169 segments (old-time radio, plus two podcasts). Only the first 10 minutes of each were transcribed.
- Search: phrase, then AND, then OR, ranked, topic filter, context expansion. Live GDELT TV caption search (National market only), stream-only playback through the Internet Archive embed.
- UI: idle and active phases, result cards with inline waveform, star or download flies a clip onto the timeline, pan, zoom, fit, popover per pinned clip, keyboard shortcuts, light and dark themes, phone-width layout.
- **Sampler features (2026-10-31):** trim on the waveform like an Ableton clip (edges drag outward too, middle slides, snap to sentence boundaries, Alt for free placement; the quote follows the selection), loop, a drag handle that drops the clip as a WAV into Finder or a DAW (Chromium `DownloadURL`), and **stories**: "Play story" on the timeline builds one waveform from the pinned library clips in date order (growing out from the middle while loading), plays it with the camera following, and downloads it as WAV or MP3 (`/api/bounce`).
- **People's Speech, stage 1 (2026-10-31):** `npm run ingest -- peoples-speech` indexes the 336-clip `microset` (one 79 minute recording: a 2016 forum meeting) into the library, searchable, playable, trimmable and pinnable like everything else. See `CLAUDE.md` for how it is stored.
- **People's Speech films (2026-10-31):** `npm run ingest -- peoples-speech-films` imports the 2,680 film items (73.7 hours: Prelinger shorts, public-domain features, sci-fi, horror, noir, comedy) of the `clean` set, picked by Internet Archive collection. Shows up as "Prelinger Archives" / "Public-domain film" with the film's title and year and the topics `film`, `prelinger`, `sci-fi`, `horror`, `film-noir`, `comedy`. Whole-shard downloads with the next two prefetched, about 1 minute per shard, 99 shards. Resumable (`data/peoples-speech/films-done.json`). Log: `data/logs/films-import.log`. **Finished 2026-11-01:** 2,821 recordings (2,680 films, 73.7 hours, 4.5 GB of FLAC) in the library, no warnings; the library is now 2,833 recordings and 30,068 segments. Running the command again does nothing (all shards are in `films-done.json`).
- **Desktop app and Add sources (2026-11-09):** see `.claude/rules/desktop-app.md` for status and what is untested (Windows). `npm run desktop` opens it. Background imports with pause and resume (`server/jobs.ts`), importers for files and folders, subtitles, podcasts, Internet Archive (audio and video), and the old films; a setup screen for ffmpeg, the speech engine and the model; the Add sources panel; the Electron shell; packaging config and GitHub workflows.
- **Sampler polish (2026-11-03):** a 5 ms declick fade on every cut (export and playback); same-day clips fan out on the timeline; trim and fade inside the pinned-clip popover (the clip keeps its key); story controls: reorder (drag the chips), leave clips out, set the gap, saved per timeline.
- **Timeline collections (2026-11-02):** timelines live in SQLite (`timelines`, `timeline_clips`), with a switcher in the dock (switch, new, rename, duplicate, delete) and a one-time import of the clips a browser had saved locally. The story and its downloads follow the open timeline and are named after it.
- **Fades (2026-11-01):** drag the square at the top of a trim edge to fade in or out (Ableton-style: diagonal gain line, tapered waveform, shaded corner). They are heard while editing, saved with the clip, applied to downloads, drag-out files and stories. The shrink button on the timeline now also closes the story, which fades out.
- Fast clip playback: redirects resolved once, then one HTTP Range request per clip (details below). Cuts take about 1 s on Internet Archive files and about 0.15 s on warm podcast files, at any position in the episode.

## Still needed, in priority order

### 1. Follow-ups to the sampler features

- **Renewing the story (the owner asked for this, "later"):** a timeline should not be limited to one story. When it holds a lot of content, the owner wants to start a new story from the same timeline: a selection and order of its clips, saved and replayable, with the timeline itself unchanged. The data model is ready for it: clips belong to a timeline, and a story is currently the timeline's library clips in the order, muting and gap saved on the timeline itself (its `story` column: `order`, `muted`, `gapMs`). Renewing would turn that column into separate story rows, several per timeline, plus a picker. Likely shape: a `stories` table (timeline id, name, ordered clip keys, gap) and a story picker in the story panel.
- **Fade curves:** fades are linear (like Ableton's default). Curve shapes (equal-power, exponential) are not done. Per-clip gain is not done either.
- **Native drag into the DAW** once wrapped in Tauri/Electron (browsers other than Chromium cannot do it).
- **Plugins the owner installed (not loaded in the session that built the sampler features, so unused):** *Audiorective* (Web Audio toolkit: reactive primitives, scheduling, parameter automation, DSP effects) fits per-clip effects (reverse, pitch, filter, reverb sends) and a proper scheduler for stories. *AudioPod* (cloud audio tools: speaker-labelled transcription, stem splitting, noise removal, speaker separation, format conversion) fits cleaning old-time-radio audio, isolating a voice from music, and speaker labels. AudioPod sends audio to an external service, so ask before using it.

### 2. More material

- **GPU transcription: the separate PC service below is dropped (owner, 2026-11-04).** The owner prefers to finish the Electron desktop app first and then use it the way any user would, dropping audio files or folders into it on his Windows PC (RTX 5070). So the work moves into the app: its bundled whisper build must be able to use an NVIDIA GPU (CUDA) on Windows and the Mac GPU where it works, and the owner's PC is the test case. The old plan, kept for the facts in it: (direction agreed 2026-10-31; the owner will set up the PC on another day, nothing is built).** The Mac transcribes at about 2.3x real time on CPU (100 hours of audio is about 43 hours of waiting). The owner has a Windows PC with an RTX 5070 and ComfyUI installed (so PyTorch with CUDA already works there; use a separate Python environment so ComfyUI is not disturbed) and some RunPod credit. Plan: a small transcription service on the PC (faster-whisper with `large-v3-turbo`) that takes an audio URL and returns timed segments; the ingest gets a transcriber address (for example an environment variable) and uses it instead of the local `whisper-cli`, so the same service can later run on a RunPod pod for big backfills. First step when the owner is ready: write the service and the setup steps, they run it on the PC, compare speed and text against the Mac on one episode, then wire ingest. Caveats to verify: RTX 50-series needs CUDA 12.8 and a recent driver, and CTranslate2 4.8.1 or newer (it dropped the cuDNN requirement); no official confirmation for the 5070 was found. A community benchmark of faster-whisper turbo on an RTX 2080 Ti was about 40x real time. RunPod sends audio to an outside service and spends the owner's money, so ask first. Once this exists: transcribe whole recordings instead of the first 10 minutes, then the "add this topic" button.
- **People's Speech, the rest (the owner wants this; stage 1 is done).** Facts checked on 2026-10-31: the parquet conversion lives at `https://huggingface.co/datasets/MLCommons/peoples_speech/resolve/refs%2Fconvert%2Fparquet/<config>/train/NNNN.parquet`; the `clean` config is 1.5 million clips (about 6,000 hours, 398 GB, 410+ shards of about 470 MB), `dirty` 5.5 million clips (1.5 TB); each shard has row groups of 100 clips (about 28 MB); columns are `id`, `audio` (FLAC bytes), `duration_ms`, `text` (lowercase, no punctuation); license CC-BY / CC-BY-SA. The text column is small next to the audio, so all of it can be searched without downloading the audio.
  - **What the `clean` set really contains (full scan of all 804 shards, 2026-10-31; the earlier "mostly audiobooks and talks" claim was wrong).** 57,646 recordings from about 54,000 Internet Archive items, 1,501,271 clips, 5,895 hours. About 60% of the hours are US federal court oral arguments (`gov.uscourts.*`), about 12% council and government meetings, and the rest mostly community media and public-affairs TV. The interesting part is small: about 945 recordings with title-plus-year names from the 1930s to 1960s (37 hours; 71 of 80 sampled are Prelinger Archives educational, industrial and civil-defense films, the rest feature films), plus about 1,460 feature-film items (about 27 hours: fragments of about a minute each) in the Archive's `feature_films*` and `moviesandfilms` collections, of which about 290 are in the `film_scifi` or `SciFi_Horror` collections (about 7 hours; for example Night of the Living Dead 1968, Carnival of Souls, Zontar the Thing From Venus, Attack From Space). These counts are estimates from random samples of 300 and 80 items, not exact. The dataset only has the parts of each film that already had a transcript.
  - **Recommended: a selective import, not the whole set.** Classify items with the Internet Archive metadata API (`https://archive.org/metadata/<item>`: `collection`, `mediatype`, `title`, `date`, `subject`; the item is the part of the recording id before `_SLASH_`), keep the film-like collections (`prelinger`, `feature_films*`, `moviesandfilms`, `film_scifi`, `SciFi_Horror`, `Film_Noir`, `Comedy_Films`, `classic_tv`), and import only those recordings' clips. About 65 hours is roughly 4 to 5 GB of FLAC at about 66 MB per hour, which fits the existing local design (one assembled FLAC per recording, `file:` audio), so no new storage shape is needed. Use the Archive's title and year for the title and date, and tag topics (`film`, `prelinger`, `sci-fi`, `horror`, decade). Find each recording's rows by its first shard in `data/peoples-speech/catalog-clean.json` (entries: recording id, clips, milliseconds, first shard; a recording can continue into the next shard) and read only the row groups that hold them.
  - **Built 2026-10-31: `npm run ingest -- peoples-speech-films`** (details in `CLAUDE.md`). It picks the films by Internet Archive collection and imports them shard by shard, deleting each shard after use, with a simple whole-shard download instead of the row-group range reads described above (one request per shard keeps clear of the rate limit; the parquet files have no page index, so a single clip would cost its whole 25 MB audio column chunk anyway). Measured selection: 2,680 items, 73.7 hours, 27,563 clips, spread over only 99 first shards, about 4.9 GB of FLAC afterwards.
  - **Hugging Face rate limit:** 3,000 `resolve` requests per 300 seconds. `asyncBufferFromUrl` makes many small range requests per shard, so scanning all 804 shards quickly gets rate limited (the first scan lost 661 shards); 3 shards at a time with a pause and a long backoff worked (about 45 minutes for the whole set). The catalog above exists so this is not repeated.
  - **Stage 2: index the text of the whole `clean` set without downloading audio.** Read only the `id`, `duration_ms` and `text` columns with remote range reads (`hyparquet` supports this) and store them as segments. The assembly in `ingest.ts` (one local FLAC per recording) cannot work here, because the audio is not local. Needs a new storage shape: segments that point at (shard, row group, row) instead of times in a local file, and the clip endpoint building a clip by fetching the row groups it needs (about 28 MB each) and caching them. Decide with the owner how much disk to give the cache (321 GB were free on 2026-10-31). Note that a recording can span shards; `extId` includes the shard, so such a recording becomes two episodes.
  - **Stage 3: audio on demand,** as above. Check first whether single clips can be read with page-level offsets instead of whole row groups.
  - Content: mostly forum recordings, talks and audiobooks, no dates beyond what a file name holds, no topics (the topic filter does not apply). Gives breadth, not sci-fi depth.

- **Public-domain films from the Internet Archive.** The owner said this is fine. Needs a video cut (ffmpeg) and a `<video>` player; `Hit.kind` already has `'video'`. Transcribe with Whisper like the radio shows. IA movie files are downloadable, unlike IA TV news files (401).
- **"Add this topic" in the UI:** done as part of Add sources (2026-11-09); the Internet Archive tile takes any search.
- **Podcasting 2.0 transcripts:** `PiEpisode.transcriptUrl` is already returned by the Podcast Index client but unused. Use a feed's own VTT/SRT instead of Whisper when present. None of the sci-fi feeds tried had one.
- **GDELT International market:** BBC News, Al Jazeera, DW, RT (2017 to 2024-10-10) and NHK (2014 to 2017). Small change in `server/sources/gdelt.ts` (the query currently hard-codes `market:"National"`). All news, stream-only. GDELT TV data ends 2024-10-10.
- Transcribe more than the first 10 minutes of recordings; ingest more sci-fi.

### 2a. Bulk imports of Internet Archive collections (the owner will not run these himself now; they become user-run, with pause)

Candidates measured 2026-11-04 (counts from the Archive, hours are rough samples): `classic_tv_commercials` 8,458 items of about 1 to 2 minutes (roughly 200 hours); public-domain films `moviesandfilms` 110,909 and `feature_films` 28,584 items (2,680 are already in through People's Speech, but only fragments); `classic_tv` 11,452 items of about 30 minutes (thousands of hours). None has transcripts, so each needs Whisper; at 2.3 times real time on a Mac CPU that is days, which is why GPU transcription comes first. In the desktop app these are offered as imports that run on the user's computer and can be paused and resumed: see `.claude/rules/desktop-app.md`. GDELT International (DW, RT, BBC, Al Jazeera, 2010 to 2024-07) was tested and works, but it is stream-only news.

### 2b. Desktop app for other people (built 2026-11-09; Windows untested)

Full plan in `.claude/rules/desktop-app.md`: users add their own files, podcasts and Internet Archive items through buttons; the People's Speech films come from an "Add old films" importer that runs on their computer, not from audio we host; Electron is the recommended wrapper; downloading from YouTube and streaming services is a later feature after a legal check. Remaining: test on Windows, the licence label (postponed), streaming-site downloads (later, after a legal check), native drag of a clip into a DAW (`webContents.startDrag`; Chromium's `DownloadURL` drag does not work in Electron), a size cap for the clip cache, signing if it ever matters.

### 3. Infrastructure and housekeeping

- **GDELT reliability (done 2026-11-04):** one retry and a clear message (`searchTv`). It still takes 10 to 25 s per search. The TV source is news only and stream-only (cannot be trimmed or saved), so the owner finds it the least interesting; it may become off by default.
- **Clip cache growth:** `data/clips/` has no eviction.
- Tauri or Electron wrapper: see `.claude/rules/desktop-app.md` (Electron recommended).
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
- **Some hosts serve different audio by User-Agent.** The Simplecast "injector" URL returned different bytes (a timeline shifted by about 7 s) for `curl` than for ffmpeg's `Lavf` or our `timelines/...` User-Agent (it was `back-then/...` when this was checked). Transcription (ffmpeg) and the Range fetch both see the same version, so clips line up with transcripts. If a feed's transcripts and clips ever disagree, check this first, and never validate podcast timing with curl-downloaded files.
- Internet Archive costs about 1 s per HTTP request (first byte 0.7 to 1 s), so about 1 s per cut is the floor there.
- ffmpeg misdetects some Internet Archive MP3s as WAV (an ID3 tag containing "RIFF"); always pass `-f mp3` (`inputFormatArgs`), also to `ffprobe`.

### Sampler features

- **Cache poisoning bug (fixed 2026-10-31):** concurrent identical clip requests raced on one temporary file and could leave a truncated mp3 in `data/clips/`, which the story then failed to decode. Reproduced with six simultaneous requests; fixed with `singleflight` plus unique temp names, and checked with 96 concurrent responses across two server processes (0 bad). If a clip ever fails to decode, scan the cache (`ffprobe` each file) and delete the broken ones: the cache is disposable.

- Trimming loads a window (clip ±8 s) as one decoded buffer and plays spans of it with Web Audio (`Voice`), so there is no `<audio>` element any more. Clip edges are applied on release: the region changes live while dragging and the card's `Hit` (range, text, segment indexes) is replaced on pointer-up.
- Selection text uses whisper segments, which are sentence-sized (some 17 s long): a selection inside one long segment returns that whole sentence. There is no word-level timing.
- The story joins clips client-side for playback and server-side (`/api/bounce`, ffmpeg concat of cached WAV cuts plus a generated silence file) for downloads; both use `STORY_GAP_MS`. TV clips cannot be cut and are left out of stories (the panel says how many).
- Same-day clips share an x position on the timeline; the story order between them is the order they were saved.

### Other

- Podcast Index auth is SHA1(key + secret + unix time) in the `Authorization` header, with `X-Auth-Key`, `X-Auth-Date` and a `User-Agent`.
- GDELT TV API needs `market:"National"`; clips play through `archive.org/embed/<id>?start=&end=`; the TV video files themselves return 401.
- Whisper must run on CPU (`-ng`): the Homebrew whisper.cpp 1.9.5 Metal backend aborts. About 2.3x real time with the large-v3-turbo q5_0 model.
- The old names were telly and Back then; `web/index.html` migrates old `telly.*` and `back-then.*` localStorage keys once (see `CLAUDE.md`).
