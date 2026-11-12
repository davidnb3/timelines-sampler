import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.ts';

export interface EpisodeRow {
  id: number;
  source: string;
  ext_id: string;
  show: string;
  title: string;
  date: string | null;
  audio_url: string;
  page_url: string | null;
  duration_ms: number | null;
}

export interface SegmentInput {
  startMs: number;
  endMs: number;
  text: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  ext_id TEXT NOT NULL UNIQUE,
  show TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT,
  audio_url TEXT NOT NULL,
  page_url TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS episode_topics (
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  PRIMARY KEY (episode_id, topic)
);
CREATE INDEX IF NOT EXISTS episode_topics_topic ON episode_topics(topic);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (episode_id, idx)
);
CREATE TABLE IF NOT EXISTS timelines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS timeline_clips (
  timeline_id INTEGER NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  hit TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (timeline_id, key)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  label TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  error TEXT,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS job_items_job ON job_items(job_id, state, idx);
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  text, content='segments', content_rowid='id', tokenize='porter unicode61'
);
`;

let db: DatabaseSync | undefined;

/** Adds columns that older databases do not have yet. Only ever additive. */
function migrate(conn: DatabaseSync): void {
  const columns = conn.prepare('PRAGMA table_info(timelines)').all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === 'story')) conn.exec('ALTER TABLE timelines ADD COLUMN story TEXT');
}

export function openDb(file: string = DB_PATH): DatabaseSync {
  if (db && file === DB_PATH) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  conn.exec(SCHEMA);
  migrate(conn);
  if (file === DB_PATH) db = conn;
  return conn;
}

export function hasEpisode(conn: DatabaseSync, extId: string): boolean {
  return conn.prepare('SELECT 1 FROM episodes WHERE ext_id = ?').get(extId) !== undefined;
}

export interface NewEpisode {
  source: string;
  extId: string;
  show: string;
  title: string;
  date: string | null;
  audioUrl: string;
  pageUrl: string | null;
  durationMs: number | null;
  topics: string[];
}

/** Stores an episode with its segments and topics in one transaction. Replaces any previous copy. */
export function saveEpisode(conn: DatabaseSync, ep: NewEpisode, segments: SegmentInput[]): number {
  conn.exec('BEGIN');
  try {
    const old = conn.prepare('SELECT id FROM episodes WHERE ext_id = ?').get(ep.extId) as
      | { id: number }
      | undefined;
    if (old) deleteEpisode(conn, old.id);
    const res = conn
      .prepare(
        `INSERT INTO episodes (source, ext_id, show, title, date, audio_url, page_url, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ep.source, ep.extId, ep.show, ep.title, ep.date, ep.audioUrl, ep.pageUrl, ep.durationMs);
    const episodeId = Number(res.lastInsertRowid);
    const addTopic = conn.prepare('INSERT OR IGNORE INTO episode_topics (episode_id, topic) VALUES (?, ?)');
    for (const t of ep.topics) addTopic.run(episodeId, t);
    const addSeg = conn.prepare(
      'INSERT INTO segments (episode_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
    );
    const addFts = conn.prepare('INSERT INTO segments_fts (rowid, text) VALUES (?, ?)');
    segments.forEach((s, idx) => {
      const r = addSeg.run(episodeId, idx, s.startMs, s.endMs, s.text);
      addFts.run(Number(r.lastInsertRowid), s.text);
    });
    conn.exec('COMMIT');
    return episodeId;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

function deleteEpisode(conn: DatabaseSync, id: number): void {
  // External-content FTS tables need the old text to drop their index entries.
  const rows = conn.prepare('SELECT id, text FROM segments WHERE episode_id = ?').all(id) as {
    id: number;
    text: string;
  }[];
  const del = conn.prepare(
    "INSERT INTO segments_fts (segments_fts, rowid, text) VALUES ('delete', ?, ?)",
  );
  for (const r of rows) del.run(r.id, r.text);
  conn.prepare('DELETE FROM episodes WHERE id = ?').run(id);
}

export interface LibraryRow {
  segId: number;
  episodeId: number;
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  rank: number;
}

/** Runs one FTS5 query, optionally limited to episodes carrying any of the given topics. */
export function ftsQuery(
  conn: DatabaseSync,
  match: string,
  topics: string[],
  limit: number,
): LibraryRow[] {
  const topicClause = topics.length
    ? `AND s.episode_id IN (SELECT episode_id FROM episode_topics WHERE topic IN (${topics.map(() => '?').join(',')}))`
    : '';
  const sql = `
    SELECT s.id AS segId, s.episode_id AS episodeId, s.idx, s.start_ms AS startMs, s.end_ms AS endMs,
           s.text, bm25(segments_fts) AS rank
    FROM segments_fts
    JOIN segments s ON s.id = segments_fts.rowid
    WHERE segments_fts MATCH ? ${topicClause}
    ORDER BY rank
    LIMIT ?`;
  return conn.prepare(sql).all(match, ...topics, limit) as unknown as LibraryRow[];
}

export function getEpisode(conn: DatabaseSync, id: number): EpisodeRow | undefined {
  return conn.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as unknown as EpisodeRow | undefined;
}

export function getEpisodeTopics(conn: DatabaseSync, id: number): string[] {
  const rows = conn.prepare('SELECT topic FROM episode_topics WHERE episode_id = ? ORDER BY topic').all(id) as {
    topic: string;
  }[];
  return rows.map((r) => r.topic);
}

/** Segments idx-before … idx+after around a hit, clamped to the episode. */
export function getSegmentWindow(
  conn: DatabaseSync,
  episodeId: number,
  fromIdx: number,
  toIdx: number,
): { idx: number; startMs: number; endMs: number; text: string }[] {
  return conn
    .prepare(
      `SELECT idx, start_ms AS startMs, end_ms AS endMs, text FROM segments
       WHERE episode_id = ? AND idx BETWEEN ? AND ? ORDER BY idx`,
    )
    .all(episodeId, Math.max(0, fromIdx), toIdx) as unknown as {
    idx: number;
    startMs: number;
    endMs: number;
    text: string;
  }[];
}

/** Segments that overlap the time range [fromMs, toMs], in order. */
export function getSegmentsBetween(
  conn: DatabaseSync,
  episodeId: number,
  fromMs: number,
  toMs: number,
): { idx: number; startMs: number; endMs: number; text: string }[] {
  return conn
    .prepare(
      `SELECT idx, start_ms AS startMs, end_ms AS endMs, text FROM segments
       WHERE episode_id = ? AND end_ms > ? AND start_ms < ? ORDER BY idx`,
    )
    .all(episodeId, fromMs, toMs) as unknown as { idx: number; startMs: number; endMs: number; text: string }[];
}

export function listTopics(conn: DatabaseSync): { topic: string; episodes: number }[] {
  return conn
    .prepare('SELECT topic, COUNT(*) AS episodes FROM episode_topics GROUP BY topic ORDER BY episodes DESC, topic')
    .all() as unknown as { topic: string; episodes: number }[];
}

export function libraryStats(conn: DatabaseSync): { episodes: number; segments: number } {
  const e = conn.prepare('SELECT COUNT(*) AS n FROM episodes').get() as { n: number };
  const s = conn.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number };
  return { episodes: e.n, segments: s.n };
}
