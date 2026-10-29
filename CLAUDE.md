# telly

Personal tool for finding spoken dialogue to sample. Type words or a sentence into a terminal-style
search box, get clips with the matching line, source, date and timestamp, preview them, and save
them as WAV/MP3. Web app first; a Tauri or Electron wrapper is planned later.

## Commands

- `npm run dev`: API (http://127.0.0.1:4747) and UI (http://localhost:5273, strict port) together.
- `npm test`: unit tests (`server/**/*.test.ts`, Node's built-in runner, no extra deps).
- `npm run typecheck`: `tsc --noEmit` over `server/` and `web/src/`.
- `npm run build` then `npm start`: serves the built UI from the API server on :4747.
- `npm run ingest -- <ia|podcast|stats> ...`: add recordings to the index (see `server/ingest.ts` usage).
  Example: `npm run ingest -- ia --query 'collection:oldtimeradio AND subject:"science fiction"' --limit 4 --per-item 2 --topic sci-fi --max-minutes 10`

Node 24+ runs the TypeScript in `server/` directly (type stripping), so there is no server build step.
That means server code must use erasable syntax only (no enums, no parameter properties) and import
with `.ts` extensions.

## Layout

- `server/index.ts`: HTTP API (`/api/search`, `/api/topics`, `/api/context`, `/api/clip`, `/api/health`) and static serving of `web-dist/`.
- `server/db.ts`: SQLite (`node:sqlite`, file `data/telly.sqlite`): `episodes`, `episode_topics`, `segments` plus an FTS5 table `segments_fts` (porter stemming). External-content FTS: deleting an episode must also delete its FTS rows (see `deleteEpisode`).
- `server/sources/library.ts`: searches the local index. Query goes phrase, then AND, then OR; each hit is widened by one segment each side; `expandWindow` widens more.
- `server/sources/gdelt.ts`: live TV caption search (GDELT TV API, needs `market:"National"`, takes 10-20 s).
- `server/sources/internetArchive.ts`, `server/sources/podcastIndex.ts`: clients used by ingest.
- `server/ingest.ts`, `server/whisper.ts`: ffmpeg streams the source to 16 kHz WAV, `whisper-cli` (whisper.cpp) transcribes it, segments go into SQLite. Topics come from source metadata (`server/topics.ts` normalises spellings) plus `--topic`.
- `server/clip.ts`: cuts a clip with ffmpeg, cached in `data/clips/`. Only `ep:<id>` refs resolve, so the endpoint is not an open proxy.
- `web/src/`: React UI. `App.tsx` (state, search, shortcuts), `ResultCard.tsx`, `Waveform.tsx` (canvas), `usePlayer.ts` (clip blob + waveform peaks), `theme.ts` (light/dark, remembered in localStorage), `styles.css` (CSS variables for both themes).
- Shared types live in `server/types.ts` and are imported by the web code as types only.

## Secrets and data

- `.env` (git-ignored; template in `.env.example`): `PODCAST_INDEX_API_KEY`, `PODCAST_INDEX_API_SECRET`, `IA_S3_ACCESS_KEY`, `IA_S3_SECRET_KEY`. Never commit it or print its values. Values containing `$` or `^` must be single-quoted.
- `data/` is git-ignored: the SQLite index, Whisper model, cached clips, logs.
- Whisper model: `data/models/ggml-large-v3-turbo-q5_0.bin` (download from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`, override the path with `TELLY_WHISPER_MODEL`).
- External tools from Homebrew: `ffmpeg`, `whisper-cpp` (`whisper-cli`).

## Things that are not obvious

- **Whisper runs on CPU.** Homebrew whisper.cpp 1.9.5 aborts in its Metal backend on this Mac (ggml scheduler assertion, every model). `server/whisper.ts` passes `-ng`; set `TELLY_WHISPER_GPU=1` to try the GPU again after an upgrade. CPU speed is about 2.3x real time with the large-v3-turbo q5_0 model.
- **ffmpeg misdetects some Internet Archive MP3s as WAV** (an ID3 tag containing "RIFF"), so `.mp3` URLs are opened with `-f mp3` (`inputFormatArgs`).
- **TV clips are stream-only.** Internet Archive TV news video files return 401, so they cannot be cut, waveformed or saved. TV hits play in the archive's embedded player (`archive.org/embed/<id>?start=&end=`), and have no WAV/MP3 buttons.
- **Dates**: old-time-radio broadcast dates are parsed from file names (`server/naming.ts`) because IA's `date` is the upload date. The planned story timeline will pin saved clips by this date.
- **Port 5173 belongs to another project** on this machine, hence telly's UI uses 5273 with `strictPort`.
- Segment-level hits are intended: results are whole lines of dialogue plus context, not single words.

## Not built yet

- Story timeline: saved clips pinned on a horizontal timeline by recording date (the schema keeps `date`, source and link per clip so this can be added without reworking search).
- People's Speech (Hugging Face `MLCommons/peoples_speech`) as a source. Public and not gated, but audio is embedded in large parquet shards, so it needs remote column reads of the text only, then range reads for audio.
- Podcasting 2.0 `<podcast:transcript>` transcripts (skip Whisper when a feed provides one); none of the sci-fi feeds tried so far had one.
- Speaker labels (needs `pyannote`, i.e. a Python 3.12 environment via `uv`).
- Own-library upload, topic tagging beyond source metadata, Tauri/Electron wrapper.
