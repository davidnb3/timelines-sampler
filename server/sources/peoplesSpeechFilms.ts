import { USER_AGENT, iaAuthHeader } from '../config.ts';
import { normalizeTopics } from '../topics.ts';
import { decodeRecording } from './peoplesSpeech.ts';

/**
 * The film part of People's Speech. The dataset has no labels, but nearly every recording is cut from
 * an Internet Archive item, and the Archive knows which collections an item is in. Films (Prelinger
 * educational and industrial shorts, public-domain features) are picked by those collections.
 */

/** Internet Archive collections that count as films, with the topics each one adds. */
export const FILM_COLLECTIONS: Record<string, string[]> = {
  prelinger: ['film', 'prelinger'],
  feature_films: ['film'],
  moviesandfilms: ['film'],
  film_scifi: ['film', 'sci-fi'],
  SciFi_Horror: ['film', 'sci-fi', 'horror'],
  Film_Noir: ['film', 'film-noir'],
  Comedy_Films: ['film', 'comedy'],
};

/** A recording as the catalog (`data/peoples-speech/catalog-clean.json`) lists it: id, clips, milliseconds, first shard. */
export type CatalogEntry = [recording: string, clips: number, ms: number, shard: number];

export interface FilmRecording {
  recording: string;
  clips: number;
  ms: number;
  shard: number;
}

export interface FilmItem {
  item: string;
  title: string;
  date: string | null;
  collections: string[];
  topics: string[];
  recordings: FilmRecording[];
}

/** The Internet Archive item a recording id was cut from: the part before the first "/". */
export function itemOf(recording: string): string {
  return decodeRecording(recording).split('/')[0]!;
}

/** Groups catalog entries by Internet Archive item. */
export function recordingsByItem(catalog: CatalogEntry[]): Map<string, FilmRecording[]> {
  const out = new Map<string, FilmRecording[]>();
  for (const [recording, clips, ms, shard] of catalog) {
    const item = itemOf(recording);
    const list = out.get(item) ?? [];
    list.push({ recording, clips, ms, shard });
    out.set(item, list);
  }
  return out;
}

/** The year, month or day an item gives for itself: "1958", "ca. 1941", "1941-03-12T00:00:00Z"; falls back to a year at the end of the item name. */
export function filmDate(date: string | null | undefined, item: string): string | null {
  const ok = (year: number) => year >= 1880 && year <= 2010;
  const full = /(\d{4})-(\d{2})-(\d{2})/.exec(date ?? '');
  if (full && ok(Number(full[1])) && Number(full[2]) >= 1 && Number(full[2]) <= 12 && Number(full[3]) >= 1 && Number(full[3]) <= 31) {
    // Archive dates of "1950-01-01" usually only mean the year.
    return full[2] === '01' && full[3] === '01' ? full[1]! : `${full[1]}-${full[2]}-${full[3]}`;
  }
  const month = /(\d{4})-(\d{2})\b/.exec(date ?? '');
  if (month && ok(Number(month[1])) && Number(month[2]) >= 1 && Number(month[2]) <= 12) return `${month[1]}-${month[2]}`;
  const year = /\b(1[89]\d{2}|20[01]\d)\b/.exec(date ?? '');
  if (year && ok(Number(year[1]))) return year[1]!;
  const named = /(1[89]\d{2}|20[01]\d)$/.exec(item);
  return named && ok(Number(named[1])) ? named[1]! : null;
}

/** "Snob, The" is shown as "The Snob". */
export function filmTitle(title: string | null | undefined, item: string): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return item;
  const m = /^(.+), (The|A|An)$/i.exec(t);
  return m ? `${m[2]} ${m[1]}` : t;
}

/** Topics for an item: the ones its film collections add, plus the Archive's own subject tags we know (sci-fi, horror, comedy ...). */
export function filmTopics(collections: string[], subjects: string[]): string[] {
  const forced = collections.flatMap((c) => FILM_COLLECTIONS[c] ?? []);
  return normalizeTopics(subjects, forced.length ? forced : ['film']);
}

/** What the library shows above the title. */
export function filmShow(collections: string[]): string {
  return collections.includes('prelinger') ? 'Prelinger Archives' : 'Public-domain film';
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

const headers = () => ({ 'User-Agent': USER_AGENT, ...iaAuthHeader() });

export interface ItemMeta {
  title: string | null;
  date: string | null;
  collections: string[];
  subjects: string[];
}

/**
 * Every item of one Internet Archive collection with its title, date, collections and subjects; the
 * scrape API pages through 10,000 items at a time, which is far quicker than one metadata call per
 * item. `keep` filters items as they arrive, so a 110,000 item collection is never held in memory.
 */
export async function collectionItems(collection: string, keep: (identifier: string) => boolean): Promise<{ listed: number; items: Map<string, ItemMeta> }> {
  const items = new Map<string, ItemMeta>();
  let listed = 0;
  let cursor = '';
  for (let attempt = 0; ; ) {
    const url = new URL('https://archive.org/services/search/v1/scrape');
    url.searchParams.set('q', `collection:${collection}`);
    url.searchParams.set('fields', 'identifier,title,date,year,subject,collection');
    url.searchParams.set('count', '10000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(300_000) }).catch(() => null);
    if (!res?.ok) {
      const busy = !res || res.status === 429 || res.status >= 500;
      if (!busy || ++attempt > 4) throw new Error(`Internet Archive scrape of ${collection} failed: ${res ? `HTTP ${res.status}` : 'no answer'}`);
      await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
      continue;
    }
    attempt = 0;
    const json = (await res.json()) as { items: Record<string, unknown>[]; cursor?: string };
    for (const m of json.items) {
      listed++;
      const identifier = String(m.identifier);
      if (!keep(identifier)) continue;
      items.set(identifier, {
        title: m.title ? String(Array.isArray(m.title) ? m.title[0] : m.title) : null,
        date: m.date ? String(m.date) : m.year ? String(m.year) : null,
        collections: asArray(m.collection),
        subjects: asArray(m.subject).flatMap((x) => x.split(/\s*;\s*/)),
      });
    }
    if (!json.cursor) return { listed, items };
    cursor = json.cursor;
  }
}
