import type { Hit, SearchResponse, TopicCount } from '../../server/types.ts';
import type { Segment } from './trim.ts';

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
  if (hit.fadeInMs) params.set('fi', String(hit.fadeInMs));
  if (hit.fadeOutMs) params.set('fo', String(hit.fadeOutMs));
  if (download) params.set('download', '1');
  return `/api/clip?${params}`;
}

/** The same clip endpoint with explicit bounds: the editor loads a window wider than the clip. */
export function rangeUrl(
  ref: string,
  startMs: number,
  endMs: number,
  fmt: ClipFormat = 'mp3',
  fade?: { inMs: number; outMs: number },
  /** The audio as it is, without the automatic declick fade (what the editor loads). */
  raw = false,
): string {
  const params = new URLSearchParams({ ref, start: String(Math.round(startMs)), end: String(Math.round(endMs)), fmt });
  if (raw) params.set('raw', '1');
  if (fade?.inMs) params.set('fi', String(fade.inMs));
  if (fade?.outMs) params.set('fo', String(fade.outMs));
  return `/api/clip?${params}`;
}

/** Transcript segments that overlap a time range of an episode. */
export const fetchSegments = (episodeId: number, fromMs: number, toMs: number, signal?: AbortSignal) =>
  getJson<Segment[]>(
    `/api/segments?${new URLSearchParams({ episode: String(episodeId), from: String(Math.round(fromMs)), to: String(Math.round(toMs)) })}`,
    signal,
  );

/** Clips of a story as the bounce endpoint expects them. */
export interface StoryClip {
  ref: string;
  start: number;
  end: number;
  fi?: number;
  fo?: number;
}

/** The default silence between clips of a story; each timeline can set its own. */
export const STORY_GAP_MS = 400;

export function bounceUrl(clips: StoryClip[], fmt: ClipFormat, name = 'Back then story', gapMs = STORY_GAP_MS, download = true): string {
  const params = new URLSearchParams({ clips: JSON.stringify(clips), gap: String(gapMs), fmt, name });
  if (download) params.set('download', '1');
  return `/api/bounce?${params}`;
}
