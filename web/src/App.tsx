import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  clipUrl, expandHit, fetchHealth, fetchTopics, search,
  type Health, type Hit, type SourceId, type TopicCount,
} from './api.ts';
import { ResultCard } from './ResultCard.tsx';
import { useTheme } from './theme.ts';
import { usePlayer } from './usePlayer.ts';
import { Waveform } from './Waveform.tsx';

interface SourceResult {
  status: 'idle' | 'loading' | 'done' | 'error';
  hits: Hit[];
  terms: string[];
  ms?: number;
  error?: string;
}

const EMPTY: Record<SourceId, SourceResult> = {
  library: { status: 'idle', hits: [], terms: [] },
  tv: { status: 'idle', hits: [], terms: [] },
};

const SOURCE_LABEL: Record<SourceId, string> = { library: 'library', tv: 'tv captions' };
const EXAMPLES = ['the planets are dying', 'contact has been lost', 'flying saucer', 'we are not alone'];

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be blocked; the app works without it.
  }
}

export function App() {
  const { theme, toggle: toggleTheme } = useTheme();
  const player = usePlayer();
  const playerRef = useRef(player);
  playerRef.current = player;

  const [input, setInput] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  const [submitted, setSubmitted] = useState('');
  const [results, setResults] = useState(EMPTY);
  const [sources, setSources] = useState<Record<SourceId, boolean>>(() => load('telly.sources', { library: true, tv: true }));
  const [topics, setTopics] = useState<string[]>(() => load('telly.topics', []));
  const [availableTopics, setAvailableTopics] = useState<TopicCount[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanding, setExpanding] = useState<string | null>(null);
  const [embedId, setEmbedId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const submittedRef = useRef('');
  const history = useRef<string[]>(load('telly.history', []));
  const historyPos = useRef(-1);

  useEffect(() => {
    fetchTopics().then(setAvailableTopics, () => undefined);
    fetchHealth().then(setHealth, () => undefined);
  }, []);

  const run = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (!q) return;
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      submittedRef.current = q;
      setSubmitted(q);
      setSelectedId(null);
      setEmbedId(null);
      historyPos.current = -1;
      history.current = [q, ...history.current.filter((h) => h !== q)].slice(0, 30);
      save('telly.history', history.current);
      window.history.replaceState(null, '', `?${new URLSearchParams({ q })}`);

      const enabled = (Object.keys(sources) as SourceId[]).filter((s) => sources[s]);
      setResults({
        ...EMPTY,
        ...Object.fromEntries(enabled.map((s) => [s, { status: 'loading', hits: [], terms: [] }])),
      });
      for (const s of enabled) {
        search(s, q, topics, ctl.signal).then(
          (r) => {
            if (!ctl.signal.aborted) setResults((p) => ({ ...p, [s]: { status: 'done', hits: r.hits, terms: r.terms, ms: r.ms } }));
          },
          (err: unknown) => {
            if (ctl.signal.aborted) return;
            setResults((p) => ({ ...p, [s]: { status: 'error', hits: [], terms: [], error: err instanceof Error ? err.message : String(err) } }));
          },
        );
      }
    },
    [sources, topics],
  );

  // Run the query from the URL once, and re-run when a filter changes. The key comparison also
  // keeps StrictMode's second effect pass from searching twice (GDELT is slow and rate-limited).
  const filterKey = JSON.stringify([topics, sources]);
  const lastFilterKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastFilterKey.current === null) {
      lastFilterKey.current = filterKey;
      if (input.trim()) run(input);
      return;
    }
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    if (submittedRef.current) run(submittedRef.current);
    // `run` is rebuilt exactly when the filters change, so the key is the only dependency needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const hits = useMemo(() => [...results.library.hits, ...results.tv.hits], [results]);
  const terms = useMemo(() => [...new Set([...results.library.terms, ...results.tv.terms])], [results]);
  const effectiveSelected = selectedId && hits.some((h) => h.id === selectedId) ? selectedId : (hits[0]?.id ?? null);
  const anyLoading = Object.values(results).some((r) => r.status === 'loading');
  const allDone = submitted !== '' && !anyLoading;

  /** Library clips play in the shared audio player; TV clips open the Internet Archive player. */
  const play = useCallback((hit: Hit) => {
    if (hit.source === 'tv') {
      playerRef.current.stop();
      setEmbedId((cur) => (cur === hit.id ? null : hit.id));
      return;
    }
    setEmbedId(null);
    playerRef.current.toggle(hit);
  }, []);

  const expand = useCallback(async (hit: Hit) => {
    if (hit.source !== 'library') return;
    setExpanding(hit.id);
    try {
      const wider = await expandHit(hit, 2, 2);
      setResults((p) => ({ ...p, library: { ...p.library, hits: p.library.hits.map((h) => (h.id === hit.id ? wider : h)) } }));
      playerRef.current.replace(wider);
    } catch {
      // Leave the hit as it was; the button re-enables below.
    } finally {
      setExpanding(null);
    }
  }, []);

  const toggleTopic = (topic: string) => {
    setTopics((cur) => {
      const next = cur.includes(topic) ? cur.filter((t) => t !== topic) : [...cur, topic];
      save('telly.topics', next);
      return next;
    });
  };

  const toggleSource = (source: SourceId) => {
    setSources((cur) => {
      const next = { ...cur, [source]: !cur[source] };
      if (!next.library && !next.tv) return cur;
      save('telly.sources', next);
      return next;
    });
  };

  // Keyboard shortcuts outside the input.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      // Space/Enter on a focused button or link must activate it, not trigger the play shortcut.
      if ((e.key === ' ' || e.key === 'Enter') && target?.closest('button, a')) return;
      const ids = hits.map((h) => h.id);
      const at = effectiveSelected ? ids.indexOf(effectiveSelected) : -1;
      const move = (to: number) => {
        const id = ids[Math.min(ids.length - 1, Math.max(0, to))];
        if (!id) return;
        setSelectedId(id);
        document.querySelector(`[data-result-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
      };
      const current = hits[at];
      switch (e.key) {
        case '/': e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); break;
        case 'j': case 'ArrowDown': e.preventDefault(); move(at + 1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); move(at - 1); break;
        case ' ': case 'Enter': if (current) { e.preventDefault(); play(current); } break;
        case 'e': if (current) void expand(current); break;
        case 'd': if (current && current.source === 'library') window.location.assign(clipUrl(current, 'wav', true)); break;
        case 't': toggleTheme(); break;
        case 'Escape': playerRef.current.stop(); setEmbedId(null); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hits, effectiveSelected, expand, play, toggleTheme]);

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      run(input);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const list = history.current;
      const next = Math.min(list.length - 1, Math.max(-1, historyPos.current + (e.key === 'ArrowUp' ? 1 : -1)));
      historyPos.current = next;
      setInput(next === -1 ? '' : (list[next] ?? ''));
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

  const statusText = anyLoading
    ? 'searching…'
    : allDone
      ? `${hits.length} clip${hits.length === 1 ? '' : 's'}`
      : 'ready';
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <main className="shell">
      <section className="term" aria-label="telly search">
        <header className="term-head">
          <span className="term-title">telly · search</span>
          <span className="term-right">
            <span className={`term-status${anyLoading ? ' is-busy' : ''}`} role="status" aria-live="polite">{statusText}</span>
            <button type="button" className="btn btn-ghost" onClick={toggleTheme} aria-label={`Switch to ${nextTheme} theme`} title="Toggle theme (t)">
              {theme === 'dark' ? '☀ light' : '☾ dark'}
            </button>
          </span>
        </header>

        <div className="term-body">
          <label className="prompt">
            <span className="prompt-label">ask ›</span>
            <input
              ref={inputRef}
              className="prompt-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="type words or a sentence, press Enter"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-label="Search spoken audio"
            />
          </label>

          <div className="filters">
            <div className="chip-row" role="group" aria-label="Topic filter">
              <span className="chip-label">topics</span>
              {availableTopics.length === 0 && <span className="muted">none yet, run an ingest</span>}
              {availableTopics.map((t) => (
                <button
                  key={t.topic}
                  type="button"
                  className={`chip${topics.includes(t.topic) ? ' is-on' : ''}`}
                  aria-pressed={topics.includes(t.topic)}
                  onClick={() => toggleTopic(t.topic)}
                >
                  {t.topic} <span className="chip-count">{t.episodes}</span>
                </button>
              ))}
            </div>
            <div className="chip-row" role="group" aria-label="Sources">
              <span className="chip-label">sources</span>
              {(Object.keys(SOURCE_LABEL) as SourceId[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip${sources[s] ? ' is-on' : ''}`}
                  aria-pressed={sources[s]}
                  onClick={() => toggleSource(s)}
                  title={s === 'tv' ? 'Live search of US TV closed captions (GDELT). Topic filters do not apply.' : 'Your local index of transcribed recordings'}
                >
                  {SOURCE_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <Waveform
            peaks={player.peaks}
            progress={player.progress}
            loading={player.loading}
            theme={theme}
            onSeek={player.seek}
          />

          <p className="grounded">
            Grounded in:{' '}
            {(Object.keys(SOURCE_LABEL) as SourceId[])
              .filter((s) => sources[s])
              .map((s) => {
                const r = results[s];
                const detail =
                  r.status === 'loading' ? 'searching…'
                  : r.status === 'error' ? `error: ${r.error}`
                  : r.status === 'done' ? `${r.hits.length} hit${r.hits.length === 1 ? '' : 's'}, ${r.ms} ms`
                  : s === 'library' && health ? `${health.library.episodes} recordings`
                  : 'ready';
                return `${SOURCE_LABEL[s]} (${detail})`;
              })
              .join(' + ')}
          </p>

          {allDone && hits.length === 0 && (
            <p className="empty">
              No clips found for “{submitted}”.
              {topics.length > 0 && sources.library ? ' Try clearing the topic filter, ' : ' Try '}
              fewer or different words.
              {health && health.library.episodes === 0 && ' The library is empty: run `npm run ingest` to add recordings.'}
            </p>
          )}

          {submitted === '' && (
            <div className="intro">
              <p>Search what people said, across the recordings you have indexed and live TV captions.</p>
              <p className="chip-row">
                <span className="chip-label">try</span>
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" className="chip" onClick={() => { setInput(ex); run(ex); }}>
                    {ex}
                  </button>
                ))}
              </p>
            </div>
          )}

          <div className="results">
            {hits.map((hit, i) => (
              <ResultCard
                key={hit.id}
                hit={hit}
                terms={terms}
                index={i}
                selected={hit.id === effectiveSelected}
                player={player}
                embedOpen={embedId === hit.id}
                expanding={expanding === hit.id}
                onSelect={() => setSelectedId(hit.id)}
                onPlay={() => { setSelectedId(hit.id); play(hit); }}
                onExpand={() => void expand(hit)}
              />
            ))}
          </div>
        </div>

        <footer className="term-foot">
          <kbd>/</kbd> search · <kbd>↑</kbd><kbd>↓</kbd> history in the box, results outside · <kbd>space</kbd> play · <kbd>e</kbd> more context ·{' '}
          <kbd>d</kbd> save wav · <kbd>esc</kbd> stop · <kbd>t</kbd> theme
        </footer>
      </section>
      <audio {...player.audioProps} hidden />
    </main>
  );
}
