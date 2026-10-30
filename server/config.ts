import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const MODEL_PATH =
  process.env.BACK_THEN_WHISPER_MODEL ?? path.join(DATA_DIR, 'models', 'ggml-large-v3-turbo-q5_0.bin');
/** `BACK_THEN_DB` points the server at another database file, e.g. a copy to test against. */
export const DB_PATH = process.env.BACK_THEN_DB ?? path.join(DATA_DIR, 'back-then.sqlite');
export const CLIP_DIR = path.join(DATA_DIR, 'clips');
export const WEB_DIST = path.join(ROOT, 'web-dist');
export const PORT = Number(process.env.BACK_THEN_PORT ?? 4747);

export const USER_AGENT = 'back-then/0.1 (personal audio search)';

/** Internet Archive S3-style keys raise rate limits on metadata and search calls. */
export function iaAuthHeader(): Record<string, string> {
  const access = process.env.IA_S3_ACCESS_KEY;
  const secret = process.env.IA_S3_SECRET_KEY;
  return access && secret ? { Authorization: `LOW ${access}:${secret}` } : {};
}
