import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

/** What the app remembers between runs, in `settings.json` inside the data folder. */
export interface Settings {
  podcastIndexKey?: string;
  podcastIndexSecret?: string;
  /** Id of the chosen speech model (see `models.ts`). */
  whisperModel?: string;
  /** How fast this computer transcribes: seconds of audio per second of work, a running average. */
  transcribeSpeed?: number;
}

const file = () => path.join(DATA_DIR, 'settings.json');

export function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

/** Merges `patch` into the saved settings; an empty string or undefined removes a value. */
export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Record<string, unknown> = { ...readSettings() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') delete next[k];
    else next[k] = v;
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file());
  return next as Settings;
}

/** Podcast Index credentials: the ones saved in the app, else the environment (the `.env` of a developer). */
export function podcastIndexKeys(): { key: string; secret: string } | null {
  const s = readSettings();
  const key = s.podcastIndexKey || process.env.PODCAST_INDEX_API_KEY;
  const secret = s.podcastIndexSecret || process.env.PODCAST_INDEX_API_SECRET;
  return key && secret ? { key, secret } : null;
}

/** Folds one finished transcription into the speed average that time estimates use. */
export function recordSpeed(audioSeconds: number, wallSeconds: number): void {
  if (!(audioSeconds >= 20 && wallSeconds > 0)) return;
  const sample = audioSeconds / wallSeconds;
  const previous = readSettings().transcribeSpeed;
  updateSettings({ transcribeSpeed: previous ? Math.round((previous * 0.7 + sample * 0.3) * 100) / 100 : Math.round(sample * 100) / 100 });
}
