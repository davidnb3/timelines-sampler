import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** `TIMELINES_DATA` moves everything the app stores (index, models, clips, imported audio): the desktop app points it at the user's app data folder. */
export const DATA_DIR = process.env.TIMELINES_DATA ?? path.join(ROOT, 'data');
/** Folder with bundled `ffmpeg`, `ffprobe` and `whisper-cli`, when the app ships them. */
export const BIN_DIR = process.env.TIMELINES_BIN_DIR ?? '';
/** Files that ship with the app and are read-only (the list of films People's Speech holds). */
export const SEED_DIR = process.env.TIMELINES_SEED ?? path.join(ROOT, 'seed');
/** `TIMELINES_DB` points the server at another database file, e.g. a copy to test against. */
/** The index file. A library made under the old name (Back then) keeps its `back-then.sqlite`; new ones get `timelines.sqlite`. */
function defaultDbFile(): string {
  const current = path.join(DATA_DIR, 'timelines.sqlite');
  const legacy = path.join(DATA_DIR, 'back-then.sqlite');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}
export const DB_PATH = process.env.TIMELINES_DB ?? defaultDbFile();
export const CLIP_DIR = path.join(DATA_DIR, 'clips');
export const WEB_DIST = process.env.TIMELINES_WEB ?? path.join(ROOT, 'web-dist');
export const PORT = Number(process.env.TIMELINES_PORT ?? 4747);

export const USER_AGENT = 'timelines/0.1 (personal audio search)';

/** Internet Archive S3-style keys raise rate limits on metadata and search calls. */
export function iaAuthHeader(): Record<string, string> {
  const access = process.env.IA_S3_ACCESS_KEY;
  const secret = process.env.IA_S3_SECRET_KEY;
  return access && secret ? { Authorization: `LOW ${access}:${secret}` } : {};
}
