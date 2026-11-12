import type { DatabaseSync } from 'node:sqlite';
import { hasEpisode, saveEpisode, type SegmentInput } from '../db.ts';
import { JobStop } from '../jobs.ts';
import { recordSpeed } from '../settings.ts';
import { transcriptionBlocker } from '../setup.ts';
import { normalizeTopics } from '../topics.ts';
import { transcribeTimed } from '../whisper.ts';

export interface RecordingInput {
  source: string;
  extId: string;
  show: string;
  title: string;
  date: string | null;
  audioUrl: string;
  pageUrl: string | null;
  durationMs: number | null;
  /** Subjects and categories as the source gives them; known spellings become topics. */
  rawTopics: string[];
  /** Topics the user asked for. */
  topics?: string[];
}

export interface RecordingOptions {
  /** Longest stretch of audio to transcribe, in seconds. */
  maxSeconds: number;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  /** Transcribe again even when the recording is already indexed. */
  force?: boolean;
}

/** Longest recording the app tries to transcribe in one go. */
export const WHOLE_RECORDING_SECONDS = 8 * 3600;

/** `null` or a missing value means "the whole recording". */
export function maxSecondsFor(maxMinutes: unknown): number {
  const m = Number(maxMinutes);
  return Number.isFinite(m) && m > 0 ? Math.min(m * 60, WHOLE_RECORDING_SECONDS) : WHOLE_RECORDING_SECONDS;
}

/** Transcribes a recording and adds it to the library. Returns "skipped" when it is already there or holds no speech. */
export async function transcribeAndSave(conn: DatabaseSync, r: RecordingInput, opts: RecordingOptions): Promise<'done' | 'skipped'> {
  if (!opts.force && hasEpisode(conn, r.extId)) return 'skipped';
  const blocker = transcriptionBlocker();
  if (blocker) throw new JobStop(blocker);
  const { segments, audioSec, wallSec } = await transcribeTimed(r.audioUrl, opts.maxSeconds, { signal: opts.signal, onStage: opts.onStage });
  recordSpeed(audioSec, wallSec);
  if (!segments.length) return 'skipped';
  opts.onStage?.('Adding to the library');
  saveRecording(conn, r, segments);
  return 'done';
}

/** Adds a recording with ready-made segments (from a transcription or from subtitles) to the library. */
export function saveRecording(conn: DatabaseSync, r: RecordingInput, segments: SegmentInput[]): void {
  saveEpisode(
    conn,
    {
      source: r.source,
      extId: r.extId,
      show: r.show,
      title: r.title,
      date: r.date,
      audioUrl: r.audioUrl,
      pageUrl: r.pageUrl,
      durationMs: r.durationMs,
      topics: normalizeTopics(r.rawTopics, r.topics ?? []),
    },
    segments,
  );
}

/** A list of words or comma separated names from the user, cleaned for use as topics. */
export function cleanTopics(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter((t) => t && t.length <= 40))].slice(0, 10);
}

export const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
