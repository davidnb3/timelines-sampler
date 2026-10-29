import { USER_AGENT } from '../config.ts';
import type { Hit, SearchResponse } from '../types.ts';

const ENDPOINT = 'https://api.gdeltproject.org/api/v2/tv/tv';

/** Seconds of lead-in and tail around the matched caption line. */
const LEAD_S = 8;
const TAIL_S = 24;

interface GdeltClip {
  preview_url: string;
  ia_show_id: string;
  date: string;
  station: string;
  show: string;
  show_date: string;
  preview_thumb?: string;
  snippet: string;
}

/** GDELT needs a market or station; phrases must be quoted to match as phrases. */
export function buildGdeltQuery(q: string, market = 'National'): string {
  const trimmed = q.trim();
  const phrase = trimmed.includes('"') || !/\s/.test(trimmed) ? trimmed : `"${trimmed}"`;
  return `${phrase} market:"${market}"`;
}

export function clipFromGdelt(c: GdeltClip): Hit {
  const offset = Number(/offset=(\d+)/.exec(c.preview_url)?.[1] ?? 0);
  const startS = Math.max(0, offset - LEAD_S);
  const endS = offset + TAIL_S;
  const id = c.ia_show_id;
  return {
    id: `tv:${id}:${offset}`,
    source: 'tv',
    kind: 'video',
    show: c.station,
    title: c.show.replace(/_/g, ' '),
    date: c.date,
    startMs: startS * 1000,
    endMs: endS * 1000,
    text: c.snippet,
    ref: `ia:${id}`,
    pageUrl: `https://archive.org/details/${id}/start/${startS}/end/${endS}`,
    thumbUrl: c.preview_thumb ?? null,
    embedUrl: `https://archive.org/embed/${id}?start=${startS}&end=${endS}`,
    topics: [],
  };
}

export async function searchTv(q: string, limit: number): Promise<SearchResponse> {
  const t0 = performance.now();
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    query: buildGdeltQuery(q),
    mode: 'clipgallery',
    format: 'json',
    maxrecords: String(Math.min(limit, 50)),
  }).toString();

  // GDELT answers slowly (10 s and up is normal) and returns plain text for bad queries.
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(90_000) });
  const body = await res.text();
  let clips: GdeltClip[] = [];
  try {
    clips = (JSON.parse(body) as { clips?: GdeltClip[] }).clips ?? [];
  } catch {
    if (!res.ok || !/no (results|matching)/i.test(body)) throw new Error(`GDELT: ${body.slice(0, 160)}`);
  }
  return {
    source: 'tv',
    query: q,
    terms: q.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [],
    hits: clips.map(clipFromGdelt),
    ms: Math.round(performance.now() - t0),
  };
}
