import type { Hit, SearchResponse, TopicCount } from '../../server/types.ts';

export type { Hit, SearchResponse, TopicCount };
export type SourceId = Hit['source'];
export type ClipFormat = 'mp3' | 'wav';

export interface Health {
  ok: boolean;
  library: { episodes: number; segments: number };
  whisperModel: boolean;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const search = (source: SourceId, q: string, topics: string[], signal?: AbortSignal) =>
  getJson<SearchResponse>(
    `/api/search?${new URLSearchParams({ source, q, topics: topics.join(','), limit: '20' })}`,
    signal,
  );

export const fetchTopics = () => getJson<TopicCount[]>('/api/topics');
export const fetchHealth = () => getJson<Health>('/api/health');

/** Widens a library hit by whole segments on each side. */
export async function expandHit(hit: Hit, before: number, after: number): Promise<Hit> {
  const w = await getJson<Pick<Hit, 'startMs' | 'endMs' | 'text' | 'firstIdx' | 'lastIdx'>>(
    `/api/context?${new URLSearchParams({
      episode: String(hit.episodeId),
      first: String(hit.firstIdx),
      last: String(hit.lastIdx),
      before: String(before),
      after: String(after),
    })}`,
  );
  return { ...hit, ...w };
}

export function clipUrl(hit: Hit, fmt: ClipFormat, download = false): string {
  const params = new URLSearchParams({
    ref: hit.ref,
    start: String(hit.startMs),
    end: String(hit.endMs),
    fmt,
    name: `${hit.show} - ${hit.title}`.slice(0, 60),
  });
  if (download) params.set('download', '1');
  return `/api/clip?${params}`;
}
