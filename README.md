# telly

Search spoken audio the way you search text. Type words or a sentence, get clips of people saying
them, with source, date and timestamp. Preview, extend with surrounding lines, save as WAV or MP3.

Two sources:

- **library**: recordings you index yourself (Internet Archive audio, podcasts via Podcast Index),
  transcribed locally with whisper.cpp and searched with SQLite full-text search.
- **tv captions**: live search of US TV closed captions through GDELT, played in the Internet
  Archive's own player (stream only).

## Setup

```bash
brew install ffmpeg whisper-cpp
npm install
cp .env.example .env        # then fill in your keys
mkdir -p data/models
curl -L -o data/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

## Use

```bash
# add recordings (runs on CPU, roughly 2.3x real time)
npm run ingest -- ia --query 'collection:oldtimeradio AND subject:"science fiction"' --limit 4 --per-item 2 --topic sci-fi --max-minutes 10
npm run ingest -- podcast --term "science fiction" --episodes 2 --topic sci-fi

npm run dev     # http://localhost:5273
```

Keyboard: `/` search, `j`/`k` or arrows move, `space` play, `e` more context, `d` save WAV, `esc` stop, `t` theme.

See `CLAUDE.md` for architecture and known limits.
