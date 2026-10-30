import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  clipUrl, expandHit, fetchHealth, fetchTopics, search,
  type Health, type Hit, type SourceId, type TopicCount,
} from './api.ts';
import { flyDot } from './fly.ts';
import { Moon, Sun } from './icons.tsx';
import { PinCard } from './PinCard.tsx';
import { ResultCard } from './ResultCard.tsx';
import { useTheme } from './theme.ts';
import { pinKey, pinTime } from './timeline/model.ts';
import { Timeline, type TimelineHandle, type TimelineItem } from './timeline/Timeline.tsx';
import { useSavedClips } from './timeline/useSavedClips.ts';
import { usePlayer } from './usePlayer.ts';

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

const SOURCE_LABEL: Record<SourceId, string> = { library: 'Library', tv: 'TV captions' };
const EXAMPLES = ['the planets are dying', 'contact has been lost', 'flying saucer', 'we are not alone'];

const SHORTCUTS: [string, string][] = [
  ['/', 'Search'],
  ['j  k', 'Next / previous result'],
  ['space', 'Play or pause'],
  ['s', 'Add to timeline'],
  ['e', 'More context'],
  ['d', 'Save WAV'],
  ['[  ]', 'Previous / next pinned clip'],
  ['f', 'Fit the timeline'],
  ['t', 'Enlarge timeline'],
  ['l', 'Lights on / off'],
  ['esc', 'Close, stop'],
];

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const FLIGHT_MS = 950;

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

/** Example searches that fade through the empty prompt, so the room hints at what to ask. */
function PromptHint({ visible }: { visible: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), 3600);
    return () => window.clearInterval(id);
  }, []);
  if (!visible) return null;
  return <span key={i} className="prompt-hint" aria-hidden>{EXAMPLES[i]}</span>;
}

function Logo({ playing }: { playing: boolean }) {
  return (
    <svg className={`logo${playing ? ' is-playing' : ''}`} width="20" height="18" viewBox="0 0 20 18" aria-hidden>
      {[2, 6.5, 11, 15.5].map((x, i) => (
        <rect key={x} className="logo-bar" style={{ '--d': `${i * 110}ms` } as CSSProperties} x={x} y="2" width="2.4" height="14" rx="1.2" />
      ))}
    </svg>
  );
}

export function App() {
  const { theme, toggle: toggleTheme } = useTheme();
  const player = usePlayer();
  const playerRef = useRef(player);
  playerRef.current = player;
  const saved = useSavedClips();

  const [input, setInput] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  const [submitted, setSubmitted] = useState('');
  const [runId, setRunId] = useState(0);
  const [results, setResults] = useState(EMPTY);
  const [sources, setSources] = useState<Record<SourceId, boolean>>(() => load('telly.sources', { library: true, tv: true }));
  const [topics, setTopics] = useState<string[]>(() => load('telly.topics', []));
  const [availableTopics, setAvailableTopics] = useState<TopicCount[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanding, setExpanding] = useState<string | null>(null);
  const [embedId, setEmbedId] = useState<string | null>(null);
  const [tall, setTall] = useState(false);
  const [openPin, setOpenPin] = useState<string | null>(null);
  const [flying, setFlying] = useState<Set<string>>(new Set());
  const [helpOpen, setHelpOpen] = useState(false);
  const [focused, setFocused] = useState(false);

  const roomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<TimelineHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const submittedRef = useRef('');
  const history = useRef<string[]>(load('telly.history', []));
  const historyPos = useRef(-1);

  useEffect(() => {
    fetchTopics().then(setAvailableTopics, () => undefined);
    fetchHealth().then(setHealth, () => undefined);
  }, []);

  // A soft light follows the pointer around the room.
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    let raf = 0;
    let x = 0;
    let y = 0;
    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        room.style.setProperty('--mx', `${x}px`);
        room.style.setProperty('--my', `${y}px`);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
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
      setRunId((n) => n + 1);
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

  // GDELT can return the same caption window twice; show it once.
  const hits = useMemo(
    () => [...new Map([...results.library.hits, ...results.tv.hits].map((h) => [h.id, h])).values()],
    [results],
  );
  const terms = useMemo(() => [...new Set([...results.library.terms, ...results.tv.terms])], [results]);
  const effectiveSelected = selectedId && hits.some((h) => h.id === selectedId) ? selectedId : (hits[0]?.id ?? null);
  const anyLoading = Object.values(results).some((r) => r.status === 'loading');
  const allDone = submitted !== '' && !anyLoading;
  const phase = submitted === '' ? 'idle' : 'active';

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

  // The timeline, in date order. Neighbours get different stem heights so labels do not collide.
  const items = useMemo<TimelineItem[]>(
    () =>
      saved.clips
        .map((c) => ({ c, t: pinTime(c.hit, c.savedAt) }))
        .sort((a, b) => a.t - b.t)
        .map(({ c, t }, i) => ({
          key: c.key,
          t,
          no: String(i + 1).padStart(2, '0'),
          tier: i % 3,
          hit: c.hit,
          entering: saved.entering.has(c.key),
          leaving: saved.leaving.has(c.key),
        })),
    [saved.clips, saved.entering, saved.leaving],
  );

  const isPinned = useCallback((hit: Hit) => {
    const key = pinKey(hit);
    return (saved.has(key) && !saved.leaving.has(key)) || flying.has(key);
  }, [saved, flying]);

  /** Adds a clip to the timeline: the camera moves to its date while a dot flies in from `from`. */
  const pin = useCallback(
    async (hit: Hit, from: HTMLElement | null) => {
      const key = pinKey(hit);
      if (saved.has(key) || flying.has(key)) return;
      const timeline = timelineRef.current;
      if (!timeline || !from || reducedMotion()) {
        saved.add(hit);
        timeline?.pulse();
        return;
      }
      setFlying((s) => new Set(s).add(key));
      const t = pinTime(hit, Date.now());
      const view = timeline.plan(t, items.map((i) => i.t));
      const target = timeline.screenPoint(t, view);
      await Promise.all([flyDot(from.getBoundingClientRect(), target, FLIGHT_MS), timeline.flyToView(view, FLIGHT_MS)]);
      saved.add(hit);
      timeline.pulse();
      setFlying((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    },
    [saved, flying, items],
  );

  const unpin = useCallback(
    (hit: Hit) => {
      const key = pinKey(hit);
      saved.remove(key);
      setOpenPin((cur) => (cur === key ? null : cur));
    },
    [saved],
  );

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
        document.querySelector(`[data-result-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      const current = hits[at];
      const pinButton = (hit: Hit) => document.querySelector<HTMLElement>(`[data-result-id="${CSS.escape(hit.id)}"] [data-pin]`);
      switch (e.key) {
        case '/': e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); break;
        case 'j': case 'ArrowDown': e.preventDefault(); move(at + 1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); move(at - 1); break;
        case ' ': case 'Enter': if (current) { e.preventDefault(); play(current); } break;
        case 's':
          if (current) {
            if (isPinned(current)) unpin(current);
            else void pin(current, pinButton(current));
          }
          break;
        case 'e': if (current) void expand(current); break;
        case 'd':
          if (current && current.source === 'library') {
            window.location.assign(clipUrl(current, 'wav', true));
            void pin(current, pinButton(current));
          }
          break;
        case '[': timelineRef.current?.step(-1); break;
        case ']': timelineRef.current?.step(1); break;
        case 'f': timelineRef.current?.fit(); break;
        case 't': setTall((v) => !v); break;
        case 'l': toggleTheme(); break;
        case '?': setHelpOpen((v) => !v); break;
        case 'Escape':
          if (helpOpen) setHelpOpen(false);
          else if (openPin) setOpenPin(null);
          else {
            playerRef.current.stop();
            setEmbedId(null);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hits, effectiveSelected, expand, play, pin, unpin, isPinned, toggleTheme, helpOpen, openPin]);

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
    ? 'Listening'
    : allDone
      ? `${hits.length} clip${hits.length === 1 ? '' : 's'}`
      : health
        ? `${health.library.episodes} recordings indexed`
        : '';

  const grounded = (Object.keys(SOURCE_LABEL) as SourceId[])
    .filter((s) => sources[s] && results[s].status !== 'idle')
    .map((s) => {
      const r = results[s];
      const detail =
        r.status === 'loading' ? 'searching'
        : r.status === 'error' ? `error: ${r.error}`
        : `${r.hits.length} hit${r.hits.length === 1 ? '' : 's'} · ${r.ms} ms`;
      return `${SOURCE_LABEL[s]} ${detail}`;
    })
    .join('   ·   ');

  return (
    <div ref={roomRef} className="room" data-phase={phase} data-dock={tall ? 'tall' : 'low'}>
      <div className="room-bg" aria-hidden />
      <div className="room-grain" aria-hidden />

      <header className="bar">
        <span className="brand"><Logo playing={player.playing} />telly</span>
        <span className="bar-right">
          <span className={`status${anyLoading ? ' is-busy' : ''}`} role="status" aria-live="polite">
            <i aria-hidden />{statusText}
          </span>
          <button type="button" className="bar-btn" onClick={() => setHelpOpen((v) => !v)} aria-label="Keyboard shortcuts" aria-expanded={helpOpen} title="Shortcuts (?)">?</button>
          <button
            type="button"
            className="bar-btn"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch the lights on' : 'Switch the lights off'}
            title={theme === 'dark' ? 'Lights on (l)' : 'Lights off (l)'}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </button>
        </span>
        {helpOpen && (
          <div className="help" role="dialog" aria-label="Keyboard shortcuts">
            {SHORTCUTS.map(([keys, what]) => (
              <p key={keys}><span>{keys.split('  ').map((k) => <kbd key={k}>{k}</kbd>)}</span>{what}</p>
            ))}
          </div>
        )}
      </header>

      <section className="ask" aria-label="Search">
        <p className="ask-eyebrow">What was said?</p>
        <label className="prompt">
          <span className="prompt-glyph">ask ›</span>
          <span className="prompt-field">
            <input
              ref={inputRef}
              className="prompt-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onInputKey}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-label="Search spoken audio"
            />
            <PromptHint visible={input === '' && !focused} />
          </span>
          <span className="scan" data-busy={anyLoading} aria-hidden />
        </label>

        <div className="filters">
          <div className="chip-group" role="group" aria-label="Topic filter">
            <span className="chip-label">Topics</span>
            {availableTopics.length === 0 && <span className="chip-none">none yet, run an ingest</span>}
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
          <div className="chip-group" role="group" aria-label="Sources">
            <span className="chip-label">Sources</span>
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

        <p className="tryline">
          <span className="chip-label">Try</span>
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="chip chip-ghost" onClick={() => { setInput(ex); run(ex); }}>
              {ex}
            </button>
          ))}
        </p>
      </section>

      <section className="results" aria-label="Results" aria-busy={anyLoading}>
        {grounded && <p className="grounded">{grounded}</p>}

        {anyLoading && hits.length === 0 && (
          <div aria-hidden>
            {[0, 1, 2].map((i) => <div key={i} className="card card-skel" style={{ '--i': i } as CSSProperties}><i /><i /><i /></div>)}
          </div>
        )}

        {allDone && hits.length === 0 && (
          <p className="empty">
            No clips found for “{submitted}”.
            {topics.length > 0 && sources.library ? ' Try clearing the topic filter, or ' : ' Try '}
            fewer or different words.
            {health && health.library.episodes === 0 && ' The library is empty: run `npm run ingest` to add recordings.'}
          </p>
        )}

        {hits.map((hit, i) => (
          <ResultCard
            key={`${runId}:${hit.id}`}
            hit={hit}
            terms={terms}
            index={i}
            selected={hit.id === effectiveSelected}
            player={player}
            theme={theme}
            embedOpen={embedId === hit.id}
            expanding={expanding === hit.id}
            pinned={isPinned(hit)}
            onSelect={() => setSelectedId(hit.id)}
            onPlay={() => { setSelectedId(hit.id); play(hit); }}
            onExpand={() => void expand(hit)}
            onPin={(from) => void pin(hit, from)}
            onUnpin={() => unpin(hit)}
          />
        ))}
      </section>

      <Timeline
        ref={timelineRef}
        items={items}
        theme={theme}
        tall={tall}
        onToggleTall={() => setTall((v) => !v)}
        openKey={openPin}
        onOpen={setOpenPin}
        renderPopover={(item) => (
          <PinCard
            hit={item.hit}
            no={item.no}
            player={player}
            theme={theme}
            embedOpen={embedId === item.hit.id}
            onPlay={() => play(item.hit)}
            onRemove={() => unpin(item.hit)}
            onClose={() => setOpenPin(null)}
          />
        )}
      />
      <audio {...player.audioProps} hidden />
    </div>
  );
}
