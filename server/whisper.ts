import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineVariant, isAbort, run } from './exec.ts';
import { modelPath } from './models.ts';
import type { SegmentInput } from './db.ts';

export { run } from './exec.ts';

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

export interface TranscribeOptions {
  signal?: AbortSignal;
  /** Called as the work moves on: "Reading the audio", "Transcribing". */
  onStage?: (stage: string) => void;
}

export interface Transcription {
  segments: SegmentInput[];
  /** Seconds of audio that were transcribed. */
  audioSec: number;
  /** Seconds the transcription took. */
  wallSec: number;
}

/** Set when a GPU run fails, so the rest of the session stays on the processor. */
let gpuBroken = false;

/** Whether to let whisper use the graphics card. Off on this project's Macs (see CLAUDE.md); on when the app installed the CUDA build. */
function useGpu(): boolean {
  if (gpuBroken || process.env.TIMELINES_WHISPER_GPU === '0') return false;
  return process.env.TIMELINES_WHISPER_GPU === '1' || engineVariant() === 'cuda';
}

/**
 * Transcribes remote or local audio with whisper.cpp. ffmpeg streams the source straight into a
 * 16 kHz mono WAV, so nothing is downloaded in full first; `maxSeconds` caps how much is read.
 */
export async function transcribeTimed(source: string, maxSeconds: number, opts: TranscribeOptions = {}): Promise<Transcription> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timelines-'));
  const wav = path.join(tmp, 'audio.wav');
  try {
    opts.onStage?.('Reading the audio');
    await run('ffmpeg', ['-v', 'error', '-y', ...inputFormatArgs(source), '-i', source, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal: opts.signal });
    const audioSec = Math.max(0, fs.statSync(wav).size - 44) / 32000;
    const base = path.join(tmp, 'out');
    const model = modelPath();
    const args = (gpu: boolean) => [
      '-m', model, '-f', wav, '-l', 'en', '-oj', '-of', base, '-np', '-sns', ...(gpu ? [] : ['-ng']),
      '-t', String(Math.max(4, os.cpus().length - 2)),
    ];
    opts.onStage?.('Transcribing');
    const t0 = Date.now();
    if (useGpu()) {
      try {
        await run('whisper-cli', args(true), { signal: opts.signal });
      } catch (err) {
        if (isAbort(err)) throw err;
        gpuBroken = true;
        console.warn(`whisper on the GPU failed, using the processor instead: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        await run('whisper-cli', args(false), { signal: opts.signal });
      }
    } else {
      await run('whisper-cli', args(false), { signal: opts.signal });
    }
    const wallSec = (Date.now() - t0) / 1000;
    const json = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')) as WhisperJson;
    const segments = cleanSegments(json.transcription.map((t) => ({ startMs: t.offsets.from, endMs: t.offsets.to, text: t.text })));
    return { segments, audioSec, wallSec };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function transcribe(source: string, maxSeconds: number, opts: TranscribeOptions = {}): Promise<SegmentInput[]> {
  return (await transcribeTimed(source, maxSeconds, opts)).segments;
}

export { modelAvailable } from './models.ts';
