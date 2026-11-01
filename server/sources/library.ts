import type { DatabaseSync } from 'node:sqlite';
import { ftsQuery, getEpisode, getEpisodeTopics, getSegmentWindow, type LibraryRow } from '../db.ts';
import type { Hit, SearchResponse } from '../types.ts';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'it', 'at', 'for', 'as', 'by', 'be', 'we', 'i',
  'are', 'was', 'were',
]);

/** Splits free text into lowercase word tokens, dropping punctuation. */
export function tokenize(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((t) => t.replace(/'/g, ''));
}

/**
 * Builds FTS5 match strings from loosest-last: exact phrase, all words, any word.
 * Searching tries them in order until enough hits are found.
 */
export function buildMatches(q: string): string[] {
  const tokens = tokenize(q).filter(Boolean);
  if (!tokens.length) return [];
  const content = tokens.filter((t) => !STOPWORDS.has(t));
  const words = content.length ? content : tokens;
  const quote = (t: string) => `"${t.replace(/"/g, '')}"`;
  const matches = [`"${tokens.join(' ').replace(/"/g, '')}"`];
  if (words.length > 1) {
    matches.push(words.map(quote).join(' AND '));
    matches.push(words.map(quote).join(' OR '));
  } else {
    matches[0] = quote(words[0]!);
  }
  return [...new Set(matches)];
}

export function searchLibrary(
  conn: DatabaseSync,
  q: string,
  topics: string[],
  limit: number,
  context = 1,
): SearchResponse {
  const t0 = performance.now();
  const seen = new Set<number>();
  const rows: LibraryRow[] = [];
  for (const match of buildMatches(q)) {
    if (rows.length >= limit) break;
    for (const r of ftsQuery(conn, match, topics, limit * 2)) {
      if (seen.has(r.segId)) continue;
      seen.add(r.segId);
      rows.push(r);
      if (rows.length >= limit) break;
    }
  }

  const hits = rows.map((r) => hitFromRow(conn, r, context)).filter((h): h is Hit => h !== null);
  return {
    source: 'library',
    query: q,
    terms: tokenize(q).filter((t) => !STOPWORDS.has(t)),
    hits,
    ms: Math.round(performance.now() - t0),
  };
}

/** A matching segment at least this long is already a whole clip, so it is not widened with its neighbours. */
export const LONG_SEGMENT_MS = 8000;

function hitFromRow(conn: DatabaseSync, r: LibraryRow, context: number): Hit | null {
  const ep = getEpisode(conn, r.episodeId);
  if (!ep) return null;
  // Whisper's segments are a few seconds, so a hit gets its neighbours for context. People's Speech
  // clips are about 15 s each; three of them would make a 45 s hit.
  const around = r.endMs - r.startMs >= LONG_SEGMENT_MS ? 0 : context;
  const win = getSegmentWindow(conn, r.episodeId, r.idx - around, r.idx + around);
  if (!win.length) return null;
  return {
    id: `lib:${r.segId}`,
    source: 'library',
    kind: 'audio',
    show: ep.show,
    title: ep.title,
    date: ep.date,
    startMs: win[0]!.startMs,
    endMs: win[win.length - 1]!.endMs,
    text: win.map((w) => w.text).join(' '),
    ref: `ep:${ep.id}`,
    episodeId: ep.id,
    firstIdx: win[0]!.idx,
    lastIdx: win[win.length - 1]!.idx,
    pageUrl: ep.page_url,
    topics: getEpisodeTopics(conn, ep.id),
  };
}

/** Widens an existing hit by `before`/`after` segments on each side. */
export function expandWindow(
  conn: DatabaseSync,
  episodeId: number,
  firstIdx: number,
  lastIdx: number,
  before: number,
  after: number,
): Pick<Hit, 'startMs' | 'endMs' | 'text' | 'firstIdx' | 'lastIdx'> | null {
  const win = getSegmentWindow(conn, episodeId, firstIdx - before, lastIdx + after);
  if (!win.length) return null;
  return {
    startMs: win[0]!.startMs,
    endMs: win[win.length - 1]!.endMs,
    text: win.map((w) => w.text).join(' '),
    firstIdx: win[0]!.idx,
    lastIdx: win[win.length - 1]!.idx,
  };
}
