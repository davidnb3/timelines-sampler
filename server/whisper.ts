import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_PATH } from './config.ts';
import type { SegmentInput } from './db.ts';

export function run(cmd: string, args: string[], opts: { quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`${cmd} failed to start: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      reject(new Error(`${cmd} exited with ${code}${opts.quiet ? '' : `: ${err.slice(-600)}`}`));
    });
  });
}

/**
 * ffmpeg's probe can mistake an MP3 for WAV when its ID3 tag contains a RIFF string (seen on
 * Internet Archive uploads), so name the demuxer when the URL says it is an MP3.
 */
export function inputFormatArgs(source: string): string[] {
  let pathname = source;
  try {
    pathname = new URL(source).pathname;
  } catch {
    // Local paths are used as they are.
  }
  return /\.mp3$/i.test(pathname) ? ['-f', 'mp3'] : [];
}

/** Lines Whisper emits for music, applause and similar, which are useless to search. */
const NOISE = /^\s*[[(♪*].*[\])♪*]\s*$/;

/** Cleans raw Whisper segments: drops sound tags and collapses runaway repeats. */
export function cleanSegments(raw: SegmentInput[]): SegmentInput[] {
  const out: SegmentInput[] = [];
  let repeats = 0;
  for (const s of raw) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    if (!text || NOISE.test(text)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text.toLowerCase() === text.toLowerCase()) {
      if (++repeats >= 2) continue;
    } else {
      repeats = 0;
    }
    out.push({ startMs: s.startMs, endMs: s.endMs, text });
  }
  return out;
}

interface WhisperJson {
  transcription: { offsets: { from: number; to: number }; text: string }[];
}

/**
 * Transcribes remote or local audio with whisper.cpp. ffmpeg streams the source straight into a
 * 16 kHz mono WAV, so nothing is downloaded in full first; `maxSeconds` caps how much is read.
 */
export async function transcribe(source: string, maxSeconds: number): Promise<SegmentInput[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telly-'));
  const wav = path.join(tmp, 'audio.wav');
  try {
    await run('ffmpeg', ['-v', 'error', '-y', ...inputFormatArgs(source), '-i', source, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    const base = path.join(tmp, 'out');
    // The Homebrew whisper.cpp 1.9.5 Metal backend aborts on Apple Silicon (ggml scheduler assertion),
    // so run on CPU unless TELLY_WHISPER_GPU=1 says a working build is installed.
    const device = process.env.TELLY_WHISPER_GPU === '1' ? [] : ['-ng'];
    await run('whisper-cli', [
      '-m', MODEL_PATH, '-f', wav, '-l', 'en', '-oj', '-of', base, '-np', '-sns', ...device,
      '-t', String(Math.max(4, os.cpus().length - 2)),
    ]);
    const json = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')) as WhisperJson;
    return cleanSegments(
      json.transcription.map((t) => ({ startMs: t.offsets.from, endMs: t.offsets.to, text: t.text })),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function modelAvailable(): boolean {
  return fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size > 1_000_000;
}
