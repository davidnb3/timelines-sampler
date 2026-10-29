/** 83_000 ms becomes "01:23"; an hour or more becomes "1:01:23". */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Accepts "1950", "1950-07-14" or a full ISO timestamp; returns a short readable date. */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  if (/^\d{4}$/.test(iso)) return iso;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export interface TextPart {
  text: string;
  match: boolean;
}

/** Strips common English suffixes so "planet" also lights up "planets". */
function stem(term: string): string {
  return term.length > 4 ? term.replace(/(ing|ed|es|s)$/, '') : term;
}

/** Splits text into runs so the words the user searched for can be highlighted. */
export function highlightParts(text: string, terms: string[]): TextPart[] {
  const stems = terms.map(stem).filter((t) => t.length > 1);
  if (!stems.length) return [{ text, match: false }];
  const parts: TextPart[] = [];
  for (const piece of text.split(/(\s+)/)) {
    const word = piece.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '').replace(/'/g, '');
    // A few trailing letters cover plurals and verb endings; "radioactive" must not match "radio".
    const match = word.length > 0 && stems.some((s) => word.startsWith(s) && word.length - s.length <= 3);
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += piece;
    else parts.push({ text: piece, match });
  }
  return parts;
}

/** Deterministic pseudo-random envelope so the idle waveform looks alive but never jumps. */
export function idlePeaks(count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const x = i / (count - 1);
    const envelope = Math.sin(Math.PI * x) ** 1.6;
    const noise = 0.5 + 0.5 * Math.sin(i * 12.9898) * Math.cos(i * 4.1414);
    return 0.06 + 0.5 * envelope * (0.45 + 0.55 * noise);
  });
}
