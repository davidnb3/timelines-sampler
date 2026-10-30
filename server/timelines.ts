import type { DatabaseSync } from 'node:sqlite';

/**
 * Saved timelines: named collections of starred clips. Today one timeline is one story (the clips
 * in date order). A timeline is a row of its own, and clips belong to it, so that several stories
 * could later be made from the same timeline without changing where the clips live.
 */

export class TimelineError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface TimelineInfo {
  id: number;
  name: string;
  clipCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A starred clip: the key identifies it within the timeline, `hit` is the client's snapshot of it. */
export interface TimelineClip {
  key: string;
  hit: Record<string, unknown> & { ref: string; startMs: number; endMs: number };
  savedAt: number;
}

export interface TimelineDetail extends TimelineInfo {
  clips: TimelineClip[];
}

export const MAX_NAME = 60;
export const MAX_CLIPS = 500;
const MAX_HIT_JSON = 20_000;
const MAX_KEY = 300;

const notFound = () => new TimelineError(404, 'Timeline not found');

/** A display name: trimmed, inner whitespace collapsed, 1 to 60 characters. */
export function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new TimelineError(400, 'A timeline needs a name');
  return name.slice(0, MAX_NAME);
}

/** Checks one clip from a request. The hit is stored as the client sent it, so only what the server relies on is verified. */
export function validateClip(raw: unknown): TimelineClip {
  const c = (raw ?? {}) as Record<string, unknown>;
  const hit = c.hit as Record<string, unknown> | undefined;
  if (typeof c.key !== 'string' || !c.key || c.key.length > MAX_KEY) throw new TimelineError(400, 'Clip needs a key');
  if (!hit || typeof hit !== 'object' || typeof hit.ref !== 'string' || !Number.isFinite(hit.startMs) || !Number.isFinite(hit.endMs)) {
    throw new TimelineError(400, 'Clip needs a hit with ref, startMs and endMs');
  }
  if (JSON.stringify(hit).length > MAX_HIT_JSON) throw new TimelineError(413, 'Clip is too large');
  const savedAt = Number.isFinite(c.savedAt) ? (c.savedAt as number) : Date.now();
  return { key: c.key, hit: hit as TimelineClip['hit'], savedAt };
}

function tx<T>(conn: DatabaseSync, fn: () => T): T {
  conn.exec('BEGIN');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

const INFO = `SELECT t.id, t.name, t.created_at AS createdAt, t.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM timeline_clips c WHERE c.timeline_id = t.id) AS clipCount FROM timelines t`;

export function listTimelines(conn: DatabaseSync): TimelineInfo[] {
  return conn.prepare(`${INFO} ORDER BY t.id`).all() as unknown as TimelineInfo[];
}

function info(conn: DatabaseSync, id: number): TimelineInfo {
  const row = conn.prepare(`${INFO} WHERE t.id = ?`).get(id) as TimelineInfo | undefined;
  if (!row) throw notFound();
  return row;
}

/** ISO timestamps, so created and updated times look the same. */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const touch = (conn: DatabaseSync, id: number) => conn.prepare(`UPDATE timelines SET updated_at = ${NOW} WHERE id = ?`).run(id);

export function createTimeline(conn: DatabaseSync, rawName: unknown, rawClips: unknown[] = []): TimelineInfo {
  const name = cleanName(rawName);
  if (rawClips.length > MAX_CLIPS) throw new TimelineError(400, `At most ${MAX_CLIPS} clips`);
  const clips = rawClips.map(validateClip);
  return tx(conn, () => {
    const { lastInsertRowid } = conn.prepare(`INSERT INTO timelines (name, created_at, updated_at) VALUES (?, ${NOW}, ${NOW})`).run(name);
    const id = Number(lastInsertRowid);
    const insert = conn.prepare('INSERT OR IGNORE INTO timeline_clips (timeline_id, key, hit, saved_at) VALUES (?, ?, ?, ?)');
    for (const c of clips) insert.run(id, c.key, JSON.stringify(c.hit), c.savedAt);
    return info(conn, id);
  });
}

export function getTimeline(conn: DatabaseSync, id: number): TimelineDetail {
  const head = info(conn, id);
  const rows = conn
    .prepare('SELECT key, hit, saved_at AS savedAt FROM timeline_clips WHERE timeline_id = ? ORDER BY saved_at, key')
    .all(id) as unknown as { key: string; hit: string; savedAt: number }[];
  return { ...head, clips: rows.map((r) => ({ key: r.key, hit: JSON.parse(r.hit) as TimelineClip['hit'], savedAt: r.savedAt })) };
}

export function renameTimeline(conn: DatabaseSync, id: number, rawName: unknown): TimelineInfo {
  const name = cleanName(rawName);
  info(conn, id);
  conn.prepare('UPDATE timelines SET name = ? WHERE id = ?').run(name, id);
  touch(conn, id);
  return info(conn, id);
}

export function deleteTimeline(conn: DatabaseSync, id: number): void {
  info(conn, id);
  tx(conn, () => {
    conn.prepare('DELETE FROM timeline_clips WHERE timeline_id = ?').run(id);
    conn.prepare('DELETE FROM timelines WHERE id = ?').run(id);
  });
}

/** A copy with its own clips, to start a different story from the same material. */
export function duplicateTimeline(conn: DatabaseSync, id: number): TimelineInfo {
  const source = getTimeline(conn, id);
  return createTimeline(conn, `${source.name} copy`.slice(0, MAX_NAME), source.clips);
}

/** Adds a clip; adding one that is already there changes nothing. */
export function addClip(conn: DatabaseSync, id: number, rawClip: unknown): TimelineInfo {
  const clip = validateClip(rawClip);
  const head = info(conn, id);
  if (head.clipCount >= MAX_CLIPS) throw new TimelineError(400, `A timeline holds at most ${MAX_CLIPS} clips`);
  conn
    .prepare('INSERT OR IGNORE INTO timeline_clips (timeline_id, key, hit, saved_at) VALUES (?, ?, ?, ?)')
    .run(id, clip.key, JSON.stringify(clip.hit), clip.savedAt);
  touch(conn, id);
  return info(conn, id);
}

export function removeClip(conn: DatabaseSync, id: number, key: string): TimelineInfo {
  info(conn, id);
  conn.prepare('DELETE FROM timeline_clips WHERE timeline_id = ? AND key = ?').run(id, key);
  touch(conn, id);
  return info(conn, id);
}
