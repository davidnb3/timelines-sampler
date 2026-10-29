import crypto from 'node:crypto';
import { USER_AGENT } from '../config.ts';

const BASE = 'https://api.podcastindex.org/api/1.0';

export interface PiFeed {
  id: number;
  title: string;
  url: string;
  link: string | null;
  categories: string[];
  language: string;
}

export interface PiEpisode {
  id: number;
  title: string;
  link: string | null;
  datePublished: number;
  enclosureUrl: string;
  /** Seconds. */
  duration: number;
  transcriptUrl: string | null;
}

async function call<T>(pathAndQuery: string): Promise<T> {
  const key = process.env.PODCAST_INDEX_API_KEY;
  const secret = process.env.PODCAST_INDEX_API_SECRET;
  if (!key || !secret) throw new Error('PODCAST_INDEX_API_KEY and PODCAST_INDEX_API_SECRET must be set in .env');
  const date = Math.floor(Date.now() / 1000).toString();
  const auth = crypto.createHash('sha1').update(key + secret + date).digest('hex');
  const res = await fetch(BASE + pathAndQuery, {
    headers: { 'User-Agent': USER_AGENT, 'X-Auth-Key': key, 'X-Auth-Date': date, Authorization: auth },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Podcast Index ${pathAndQuery.split('?')[0]}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function searchFeeds(term: string, max: number): Promise<PiFeed[]> {
  const r = await call<{ feeds: (Omit<PiFeed, 'categories'> & { categories: Record<string, string> | null })[] }>(
    `/search/byterm?q=${encodeURIComponent(term)}&max=${max}`,
  );
  return r.feeds.map((f) => ({ ...f, categories: Object.values(f.categories ?? {}) }));
}

export async function feedById(id: number): Promise<PiFeed> {
  const r = await call<{ feed: Omit<PiFeed, 'categories'> & { categories: Record<string, string> | null } }>(
    `/podcasts/byfeedid?id=${id}`,
  );
  return { ...r.feed, categories: Object.values(r.feed.categories ?? {}) };
}

export async function episodesByFeed(id: number, max: number): Promise<PiEpisode[]> {
  const r = await call<{ items: PiEpisode[] }>(`/episodes/byfeedid?id=${id}&max=${max}`);
  return r.items;
}
