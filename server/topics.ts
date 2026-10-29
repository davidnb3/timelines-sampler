/** Maps the many spellings sources use onto one canonical topic name. */
const SYNONYMS: Record<string, string> = {
  'science fiction': 'sci-fi',
  'sci fi': 'sci-fi',
  'sci-fi': 'sci-fi',
  scifi: 'sci-fi',
  sf: 'sci-fi',
  'old time radio': 'old-time-radio',
  'old-time radio': 'old-time-radio',
  otr: 'old-time-radio',
  'radio drama': 'old-time-radio',
  'old time radio researchers group': 'old-time-radio',
  audiobook: 'audiobook',
  audiobooks: 'audiobook',
  fiction: 'fiction',
  fantasy: 'fantasy',
  horror: 'horror',
  mystery: 'mystery',
  science: 'science',
  space: 'space',
  news: 'news',
  history: 'history',
  comedy: 'comedy',
};

/** Subjects that describe a source's housekeeping rather than its content. */
const IGNORED = new Set(['otrr', 'otrr set', 'otrr maintained set', 'drama']);

export function normalizeTopic(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key || key.length > 40 || IGNORED.has(key) || /^\d{4}s?$/.test(key)) return null;
  return SYNONYMS[key] ?? null;
}

export function normalizeTopics(raws: Iterable<string>, forced: string[] = []): string[] {
  const out = new Set<string>();
  for (const raw of raws) {
    const t = normalizeTopic(raw);
    if (t) out.add(t);
  }
  for (const f of forced) {
    const t = normalizeTopic(f) ?? f.trim().toLowerCase();
    if (t) out.add(t);
  }
  return [...out].sort();
}
