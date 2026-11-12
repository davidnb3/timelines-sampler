# Timelines

Search spoken audio the way you search text. Type words or a sentence, get clips of people saying
them, with source, date and timestamp. Preview, trim, fade, extend with surrounding lines, save as WAV or MP3,
drag clips onto a timeline and play them as one story.

Everything runs on your own computer. You add the recordings you want to search:

- **Your own files and folders**: audio or video, transcribed on your computer (or use subtitle files).
- **Podcasts**: search by name, pick how many episodes.
- **Internet Archive**: old-time radio, vintage TV commercials, public-domain films, classic TV shows, or any search you type.
- **Old films**: about 2,700 old films and shorts (Prelinger, sci-fi, horror, noir) with ready-made transcripts, no waiting.
- **Live TV captions**: US TV news, searched live (stream only).

## The desktop app

### Windows

Download the installer from the [Releases](https://github.com/davidnb3/back-then/releases) page and run it.
The installer is not signed, so Windows shows "Windows protected your PC" the first time: choose **More info**, then **Run anyway**.
On first start open **Add sources**; the app downloads what it needs for transcription (ffmpeg, the speech engine, a speech model) with one click each.
With an NVIDIA graphics card it uses the card, which is much faster.

### Mac (and Linux)

The Mac app is not distributed as a download (that would need a paid Apple developer account). Run it from source instead:

```bash
brew install ffmpeg whisper-cpp     # Linux: install ffmpeg and build whisper.cpp
git clone https://github.com/davidnb3/back-then.git
cd back-then
npm install                          # needs Node 24 or newer
npm run desktop
```

Open **Add sources**, download a speech model (one click), and import something.

Your library lives in the app's data folder (on a Mac `~/Library/Application Support/Timelines/data`, on Windows `%APPDATA%\Timelines\data`).

## The web version (for developers)

```bash
npm install
npm run dev     # http://localhost:5273
```

The command line can add recordings too (`npm run ingest`, see `server/ingest.ts`), and a `.env` file (template: `.env.example`)
can hold the Podcast Index key. `CLAUDE.md` describes the architecture and the known limits; `.claude/rules/` holds the roadmap and the desktop app plan.

## Keyboard

`/` search, `j`/`k` move, `space` play, `s` add to timeline, `e` more context, `d` save WAV, `a` add sources,
`[` `]` step through pinned clips, `f` fit the timeline, `t` enlarge it, `l` lights on/off, `?` help, `esc` close/stop.
