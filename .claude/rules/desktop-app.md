# Desktop app: plan and status

Written 2026-11-04 from a conversation with the owner; built 2026-11-09. Status and the general backlog
live in `roadmap.md`; architecture in `CLAUDE.md`. Update this file when a step is done or a decision changes.

## Status (2026-11-09)

Built and checked on a Mac (the owner's machine): the job runner with pause and resume, the importers
(files and folders, subtitles, podcasts, Internet Archive including video files, old films), the setup
screen (model download with progress verified end to end; ffmpeg and whisper hints), the "Add sources"
panel, the Electron shell (window, security cookie, file picker, drop, external links), a packaged Mac
app (`electron-builder --mac --dir`) that starts and serves the UI. **Not tested, because there is no
Windows machine in the build environment:** the Windows installer (`npm run dist:win`, the GitHub
workflow), the automatic downloads of ffmpeg and the whisper.cpp engine on Windows (the URLs and asset
names were checked against the live releases; the unpacking with Windows' `tar` was not run), the
CUDA build on the owner's RTX 5070 (the only CUDA builds on the release are 11.8 and 12.4, which may not
contain kernels for a 50-series card; `whisper.ts` then falls back to the processor for the session).
First thing to do on the Windows PC: install, open Add sources, install the three tools, import one
file, and report what fails.

## Why a desktop app

Anyone should be able to use Timelines without a developer toolchain, and without us hosting other
people's audio. The user brings their own sources, everything runs on their computer, and nothing
copyrighted is distributed by us. A public website was considered and rejected for now: serving
audio and WAV/MP3 downloads to the public is distribution, and the on-demand ffmpeg cutting is
expensive and abusable (see the hosting discussion in the roadmap's "Decisions").

## Decisions (owner, 2026-11-04)

- **Users add their own sources through buttons, no code.** Today's `npm run ingest` needs Node,
  ffmpeg and whisper-cli, so the desktop app must do all of that itself.
- **People's Speech films are not shipped as audio.** The app ships the recipe (`films.json`,
  `film-dates-proposed.json`, `catalog-clean.json`, about 7 MB) and an "Add old films" button that
  runs the import against Hugging Face on the user's own computer. We saw about 47 GB downloaded,
  4.5 GB kept, about 1.5 hours. Optimisation to do once: record each film's row-group positions
  per shard so only those parts are downloaded (probably a quarter of the traffic).
- **Downloading from YouTube and streaming services is a LATER planned feature, not forgotten.**
  The owner's view: it is the user's own responsibility. Known risks to check before building:
  downloaders (`yt-dlp`) break every few weeks as sites change and need constant updates; sites
  block automated downloads; distributing such a tool can create liability for the distributor
  (the 2020 `youtube-dl` takedown); app stores may reject it. Safest shape: a setting for a
  downloader the user installs themselves, off by default, nothing shipped by us, and the app
  works fully without it. Get a legal opinion before building.
- **Big collections are imported by the users themselves, on their own computers, and can be paused.**
  The owner will not run the Internet Archive commercials (`classic_tv_commercials`), public-domain
  films (`moviesandfilms`, `feature_films`) or classic TV shows (`classic_tv`) imports himself for
  now. The app offers them as "add this collection" imports instead (see the roadmap's section 2a
  for sizes). Requirements: show how many items and roughly how many hours it is and how long
  transcribing will take on this computer before starting; let the user set a limit (for example
  the first 200 items); show progress per item; **pause and resume at any time**, including after
  quitting and reopening the app.
- **Podcast Index key: the app shows the link** (api.podcastindex.org/signup) and the user pastes their
  own key and secret (kept in `settings.json`, never sent back to the page). No key ships with the app.
- **Packaging (owner, 2026-11-09): no paid developer accounts.** Windows: an unsigned installer from the
  GitHub release; Windows shows a "protected your PC" screen the first time (More info, Run anyway),
  which the README explains. Mac: no download; users clone the repo and run `npm run desktop`
  (README). An unsigned DMG is built by the workflow as a bonus (`continue-on-error`), but is not
  advertised: on a Mac it needs a right-click Open and may be blocked on newer macOS. Free option for
  Windows signing if it matters later: SignPath Foundation signs open-source projects for free.
- **The licence label per recording is postponed** (owner, 2026-11-09). Do it later.
- **The owner reopened "own-library upload"** (the roadmap said "maybe much later") for the desktop
  app: dragging in the user's own files is the main way to add sources.

## Goal (owner, 2026-11-09): every audio source is one click away

The "Add sources" screen shows one tile per source and nothing needs a terminal or an editor:
**My files** (drag in files or folders), **Podcasts** (search or paste a link), **Internet Archive**
(old-time radio, commercials, classic TV shows, public-domain films, or any search the user types),
**Old films** (the People's Speech importer), and **Live TV captions** (not an import: a live search,
stream-only). Streaming-site downloads come later (see decisions). Every tile that imports creates a
job that can be paused and resumed. Open question: Podcast Index needs an API key and secret per app
(today ours are in `.env`); decide whether the app ships one registered key, or each user enters their
own, before packaging. Internet Archive S3 keys are optional (higher rate limits only).

## Wrapper choice: Electron (chosen by the owner, 2026-11-09)

The owner has used Electron before. Reasons it fits this app better than Tauri:

- The server is Node (TypeScript run directly, `node:sqlite`) and shells out to ffmpeg and
  whisper-cli. Electron runs Node natively, so the server can run as is. Tauri's backend is Rust,
  so the Node server would be a bundled sidecar program.
- The UI depends on Web Audio (`Voice`, gain automation, decoded windows) and canvas. Electron ships
  one known Chromium. Tauri uses the system web view (WebKit on macOS, WebView2 on Windows,
  WebKitGTK on Linux), where Web Audio and drag behaviour differ. Cheap test before deciding
  anything: open the app in Safari and see if playback, fades and trimming still work.
- Native drag of a clip into a DAW (`webContents.startDrag`) is built into Electron; Tauri needs a
  plugin.
- Tauri's advantages (about 10 MB app instead of about 150 MB, lower memory, stricter security
  model) matter less because we bundle ffmpeg (about 80 MB) and download a speech model (about
  500 MB) anyway.

## Pieces to build, in order (1 to 7 are built, see Status; 8 is later)

1. **Job runner and progress, with pause and resume.** A `jobs` table and a queue in the server that runs ingest work in the
   background, with progress sent to the UI (server-sent events). Also unlocks the roadmap's "Add
   this topic" button in the web app, so it is useful before any wrapper exists.
   Design for pause: the unit of work is one recording. A job is a list of recordings in a `jobs` /
   `job_items` table with a state per item (waiting, running, done, failed). Pause lets the running
   item finish (or stops its whisper process and puts it back to waiting; do not leave half an
   episode in the index), then stops. Resume continues with the waiting items. Quitting the app
   counts as pausing; on the next start the job shows as paused and the user decides. Today's
   `films-done.json` is the same idea for one importer, done by hand. The collection importer
   itself is a generic "Internet Archive query -> download each file -> transcribe -> index" job
   (the existing `ia` ingest, minus the 10 minute limit and the per-run item caps).
2. **Import files and folders.** Drag in audio or video, the app transcribes and indexes it. Needs
   a place for the user's files and a transcribing path that does not assume a developer machine.
3. **Podcast and Internet Archive from the UI.** Paste a link, pick episodes, import. Uses the clients
   that exist (`podcastIndex.ts`, `internetArchive.ts`). Use a feed's own transcript when it has one
   (Podcasting 2.0 item in the roadmap).
4. **Import existing subtitles.** SRT or VTT next to the audio is indexed without transcribing.
5. **Library packs.** The "Add old films" importer first; packs prepared by us can follow, but only
   with material that is clearly licensed.
6. **Wrapper.** Electron shell, server started inside it on a localhost port.
7. **Packaging.** Bundled ffmpeg and whisper-cli per platform, first-run model download, app data
   directory instead of the repo's `data/`, code signing and notarising (Apple developer account,
   about 99 USD a year), auto-update.
8. **Streaming-site downloads** (see decisions), only after a legal check.

## GPU transcription (owner, 2026-11-04)

No separate transcription service on the owner's PC. He wants the app in its final form first and
will then transcribe by dropping audio or folders into it, as any user would. So the packaged app
needs a whisper build that uses the GPU where it can: CUDA on Windows with an NVIDIA card (his
RTX 5070 is the test case; RTX 50-series needs CUDA 12.8 or newer and a recent driver), and Metal
on Mac if a build is found that does not crash (see the Mac note in `CLAUDE.md`), with a CPU
fallback and a speed estimate shown before a big job.

## Things to settle before step 6

- **Local server security.** A server on 127.0.0.1 can be called by any web page the user opens.
  Writes already require `application/json`, but the packaged app needs a per-run token or an
  Origin check on every route, and the clip endpoint must stay limited to `ep:` refs.
- **Transcription speed on users' machines.** About 2.3 times real time on this Mac's CPU. Offer a
  faster, smaller model. Check whether a bundled whisper.cpp build can use the Mac GPU (the
  Homebrew build crashes in its Metal backend). Windows users with an NVIDIA GPU could use a CUDA
  build later.
- **A licence field on every recording,** shown in the UI, so users know what they may do with a
  clip. The `source` field exists; licence does not.
- **Disk use.** The clip cache has no eviction (roadmap, housekeeping): needs a size cap before it
  runs on other people's computers.
