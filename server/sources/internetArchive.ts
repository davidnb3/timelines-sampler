import { USER_AGENT, iaAuthHeader } from '../config.ts';

export interface IaItem {
  identifier: string;
  title: string;
  date: string | null;
  subjects: string[];
  creator: string | null;
}

export interface IaFile {
  name: string;
  format: string;
  size: number;
}

const headers = () => ({ 'User-Agent': USER_AGENT, ...iaAuthHeader() });

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

export async function searchItems(query: string, rows: number): Promise<IaItem[]> {
  const url = new URL('https://archive.org/advancedsearch.php');
  url.search = new URLSearchParams({ q: query, rows: String(rows), output: 'json', sort: 'downloads desc' }).toString();
  for (const f of ['identifier', 'title', 'date', 'subject', 'creator']) url.searchParams.append('fl[]', f);
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Internet Archive search failed: HTTP ${res.status}`);
  const json = (await res.json()) as { response: { docs: Record<string, unknown>[] } };
  return json.response.docs.map((d) => ({
    identifier: String(d.identifier),
    title: String(d.title ?? d.identifier),
    date: d.date ? String(d.date).slice(0, 10) : null,
    subjects: asArray(d.subject),
    creator: d.creator ? asArray(d.creator).join(', ') : null,
  }));
}

export async function itemFiles(identifier: string): Promise<IaFile[]> {
  const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}/files`, {
    headers: headers(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Internet Archive metadata failed: HTTP ${res.status}`);
  const json = (await res.json()) as { result?: { name: string; format: string; size?: string }[] };
  return (json.result ?? []).map((f) => ({ name: f.name, format: f.format, size: Number(f.size ?? 0) }));
}

/** One playable MP3 per recording: IA stores VBR and 64Kbps derivatives of the same upload. */
export function pickMp3s(files: IaFile[]): IaFile[] {
  const rank = (f: IaFile) => (f.format === 'VBR MP3' ? 0 : f.format === '128Kbps MP3' ? 1 : f.format === '64Kbps MP3' ? 2 : 3);
  const byBase = new Map<string, IaFile>();
  for (const f of files.filter((f) => /\.mp3$/i.test(f.name))) {
    const base = f.name.replace(/\.mp3$/i, '').replace(/_64kb$/i, '');
    const cur = byBase.get(base);
    if (!cur || rank(f) < rank(cur)) byBase.set(base, f);
  }
  return [...byBase.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const VIDEO = /\.(mp4|m4v|ogv|webm|mpg|mpeg|avi|mov)$/i;

/**
 * What to transcribe from an item: its MP3 when it has one, else the smallest ordinary video file
 * (commercials, films and TV episodes are videos; ffmpeg takes the sound track and ignores the picture).
 */
export function pickPlayable(files: IaFile[]): IaFile[] {
  const mp3s = pickMp3s(files);
  if (mp3s.length) return mp3s;
  const rank = (f: IaFile) => (/512kb mpeg4/i.test(f.format) ? 0 : /h\.264/i.test(f.format) ? 1 : /mpeg4/i.test(f.format) ? 2 : 3);
  const videos = files.filter((f) => VIDEO.test(f.name) && !/\b(thumbnail|metadata|archive bittorrent)\b/i.test(f.format) && f.size > 0);
  videos.sort((a, b) => rank(a) - rank(b) || a.size - b.size);
  return videos.slice(0, 1);
}

/** How many items a search finds, without fetching them. */
export async function countItems(query: string): Promise<number> {
  const url = new URL('https://archive.org/advancedsearch.php');
  url.search = new URLSearchParams({ q: query, rows: '0', output: 'json' }).toString();
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Internet Archive search failed: HTTP ${res.status}`);
  return Number(((await res.json()) as { response: { numFound: number } }).response.numFound);
}

export const downloadUrl = (identifier: string, file: string) =>
  `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(file)}`;

export const detailsUrl = (identifier: string) => `https://archive.org/details/${encodeURIComponent(identifier)}`;
