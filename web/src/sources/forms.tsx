import { useCallback, useEffect, useState, type DragEvent, type ReactNode } from 'react';
import {
  createJob, desktop, fetchFilmsInfo, fetchSettings, previewFiles, previewIa, saveSettings, searchPodcasts,
  type AppSettings, type FilmsInfo, type PodcastFeed, type SetupStatus,
} from './sourcesApi.ts';
import { estimateTranscription, formatCount, formatDuration, IA_PRESETS, MINUTE_CHOICES } from './presets.ts';

/** The forms behind the tiles of the "Add sources" screen. Each starts one background job. */

export interface FormProps {
  setup: SetupStatus | null;
  /** Called with a sentence after a job was started. */
  onStarted: (message: string) => void;
}

const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="sp-field">
    <span className="sp-label">{label}</span>
    {children}
    {hint && <span className="sp-hint">{hint}</span>}
  </label>
);

const MinutesSelect = ({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) => (
  <select className="sp-input" value={value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
    {MINUTE_CHOICES.map((c) => <option key={String(c.value)} value={c.value === null ? '' : String(c.value)}>{c.label}</option>)}
  </select>
);

const notReady = (setup: SetupStatus | null) => (setup && !setup.ready ? 'Set up transcription first (see the top of this panel).' : null);

/** Starts a job and reports the result; shared by all forms. */
function useStarter(onStarted: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(async (body: Record<string, unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      const job = await createJob(body);
      onStarted(job.note ? `${message} ${job.note}` : message);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [onStarted]);
  return { busy, error, start };
}

const topicList = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean);

/* ───────────────────────── My files ───────────────────────── */

export function FilesForm({ setup, onStarted, initialPaths }: FormProps & { initialPaths: string[] }) {
  const bridge = desktop();
  const [paths, setPaths] = useState<string[]>(initialPaths);
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState<{ count: number; truncated: boolean } | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [topics, setTopics] = useState('');
  const [over, setOver] = useState(false);
  const { busy, error, start } = useStarter(onStarted);

  useEffect(() => {
    if (initialPaths.length) setPaths((p) => [...new Set([...p, ...initialPaths])]);
  }, [initialPaths]);

  const all = [...paths, ...typed.split('\n').map((l) => l.trim()).filter(Boolean)];
  const key = JSON.stringify(all);
  useEffect(() => {
    if (!all.length) return setPreview(null);
    const t = setTimeout(() => previewFiles(all).then(setPreview, () => setPreview(null)), 300);
    return () => clearTimeout(t);
    // `key` stands for the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const add = async (pick: () => Promise<string[]>) => {
    const got = await pick();
    if (got.length) setPaths((p) => [...new Set([...p, ...got])]);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!bridge) return;
    const got = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter(Boolean);
    if (got.length) setPaths((p) => [...new Set([...p, ...got])]);
  };
  const blocked = notReady(setup);

  return (
    <div className="sp-form">
      {bridge ? (
        <div className={`sp-drop${over ? ' is-over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <p>Drop audio or video files, or whole folders, here</p>
          <div className="sp-row">
            <button type="button" className="act" onClick={() => void add(bridge.pickFiles)}>Choose files…</button>
            <button type="button" className="act" onClick={() => void add(bridge.pickFolder)}>Choose a folder…</button>
          </div>
        </div>
      ) : (
        <Field label="Paths of files or folders on this computer, one per line" hint="In the desktop app you can pick files and drop them here instead.">
          <textarea className="sp-input" rows={3} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="/Users/you/Music/radio" spellCheck={false} />
        </Field>
      )}
      {paths.length > 0 && (
        <p className="sp-note">
          {paths.length} chosen{preview ? `: ${formatCount(preview.count)} audio or video ${preview.count === 1 ? 'file' : 'files'} found${preview.truncated ? ' (only the first 5,000 are taken)' : ''}` : ''}.{' '}
          <button type="button" className="sp-link" onClick={() => setPaths([])}>Clear</button>
        </p>
      )}
      {!bridge && preview && <p className="sp-note">{formatCount(preview.count)} audio or video files found.</p>}
      <Field label="Transcribe" hint="Subtitle files next to a recording (talk.srt, talk.vtt) are used instead of transcribing.">
        <MinutesSelect value={minutes} onChange={setMinutes} />
      </Field>
      <Field label="Topics (optional, separated by commas)">
        <input className="sp-input" value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="interviews, 1970s" />
      </Field>
      {blocked && <p className="sp-warn">{blocked}</p>}
      {error && <p className="sp-error">{error}</p>}
      <button
        type="button"
        className="act act-primary sp-start"
        disabled={busy || !preview || preview.count === 0 || Boolean(blocked)}
        onClick={() => void start({ kind: 'files', paths: all, maxMinutes: minutes, topics: topicList(topics) }, `Importing ${preview?.count ?? 0} files.`).then((ok) => ok && (setPaths([]), setTyped('')))}
      >
        Import {preview ? `${formatCount(preview.count)} ${preview.count === 1 ? 'file' : 'files'}` : ''}
      </button>
    </div>
  );
}

/* ───────────────────────── Podcasts ───────────────────────── */

export function PodcastForm({ setup, onStarted }: FormProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [term, setTerm] = useState('');
  const [feeds, setFeeds] = useState<PodcastFeed[] | null>(null);
  const [chosen, setChosen] = useState<PodcastFeed | null>(null);
  const [episodes, setEpisodes] = useState(5);
  const [minutes, setMinutes] = useState<number | null>(30);
  const [topics, setTopics] = useState('');
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, start } = useStarter(onStarted);

  useEffect(() => {
    fetchSettings().then(setSettings, () => undefined);
  }, []);

  const saveKeys = async () => {
    setProblem(null);
    try {
      setSettings(await saveSettings({ podcastIndexKey: key, podcastIndexSecret: secret }));
      setKey('');
      setSecret('');
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const search = async () => {
    if (!term.trim()) return;
    setSearching(true);
    setProblem(null);
    setChosen(null);
    try {
      setFeeds(await searchPodcasts(term.trim()));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  if (!settings) return <div className="sp-form"><p className="sp-note">Loading…</p></div>;
  if (!settings.podcastIndexConfigured) {
    return (
      <div className="sp-form">
        <p className="sp-note">Searching podcasts uses the free Podcast Index directory, which asks every app for a key. It takes a minute and costs nothing:</p>
        <ol className="sp-steps">
          <li>Create an account at <a href="https://api.podcastindex.org/signup" target="_blank" rel="noreferrer">api.podcastindex.org/signup</a>.</li>
          <li>They email you an API key and a secret.</li>
          <li>Paste both here. They are kept on this computer only.</li>
        </ol>
        <Field label="API key"><input className="sp-input" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" /></Field>
        <Field label="API secret"><input className="sp-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="off" /></Field>
        {problem && <p className="sp-error">{problem}</p>}
        <button type="button" className="act act-primary sp-start" disabled={!key.trim() || !secret.trim()} onClick={() => void saveKeys()}>Save key</button>
      </div>
    );
  }

  const blocked = notReady(setup);
  return (
    <div className="sp-form">
      <form className="sp-row sp-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input className="sp-input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search podcasts, for example: radio drama" aria-label="Search podcasts" />
        <button type="submit" className="act" disabled={searching || !term.trim()}>{searching ? 'Searching…' : 'Search'}</button>
      </form>
      {problem && <p className="sp-error">{problem}</p>}
      {feeds && feeds.length === 0 && <p className="sp-note">Nothing found. Try other words.</p>}
      {feeds && !chosen && (
        <ul className="sp-list">
          {feeds.map((f) => (
            <li key={f.id}>
              <button type="button" className="sp-pick" onClick={() => setChosen(f)}>
                <strong>{f.title}</strong>
                <span>{[f.author, f.episodeCount ? `${formatCount(f.episodeCount)} episodes` : null].filter(Boolean).join(' · ')}</span>
                {f.description && <em>{f.description}</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {chosen && (
        <>
          <p className="sp-note"><strong>{chosen.title}</strong>{' '}<button type="button" className="sp-link" onClick={() => setChosen(null)}>Choose another</button></p>
          <Field label="Latest episodes to import">
            <input className="sp-input" type="number" min={1} max={500} value={episodes} onChange={(e) => setEpisodes(Number(e.target.value))} />
          </Field>
          <Field label="Transcribe"><MinutesSelect value={minutes} onChange={setMinutes} /></Field>
          <Field label="Topics (optional, separated by commas)"><input className="sp-input" value={topics} onChange={(e) => setTopics(e.target.value)} /></Field>
          {blocked && <p className="sp-warn">{blocked}</p>}
          {error && <p className="sp-error">{error}</p>}
          <button
            type="button"
            className="act act-primary sp-start"
            disabled={busy || Boolean(blocked) || !(episodes >= 1)}
            onClick={() => void start({ kind: 'podcast', feedId: chosen.id, episodes, maxMinutes: minutes, topics: topicList(topics) }, `Importing ${chosen.title}.`)}
          >
            Import {episodes} {episodes === 1 ? 'episode' : 'episodes'}
          </button>
        </>
      )}
      <p className="sp-hint"><button type="button" className="sp-link" onClick={() => void saveSettings({ podcastIndexKey: '', podcastIndexSecret: '' }).then(setSettings)}>Remove my Podcast Index key</button></p>
    </div>
  );
}

/* ───────────────────────── Internet Archive ───────────────────────── */

export function ArchiveForm({ setup, onStarted }: FormProps) {
  const [presetId, setPresetId] = useState(IA_PRESETS[0]!.id);
  const preset = IA_PRESETS.find((p) => p.id === presetId)!;
  const [query, setQuery] = useState(preset.query);
  const [limit, setLimit] = useState(preset.defaultLimit);
  const [minutes, setMinutes] = useState<number | null>(preset.defaultMinutes);
  const [topics, setTopics] = useState('');
  const [found, setFound] = useState<number | null | 'error'>(null);
  const { busy, error, start } = useStarter(onStarted);

  const choose = (id: string) => {
    const p = IA_PRESETS.find((x) => x.id === id)!;
    setPresetId(id);
    setQuery(p.query);
    setLimit(p.defaultLimit);
    setMinutes(p.defaultMinutes);
  };

  useEffect(() => {
    if (!query.trim()) return setFound(null);
    setFound(null);
    const t = setTimeout(() => previewIa(query.trim()).then((r) => setFound(r.count), () => setFound('error')), 500);
    return () => clearTimeout(t);
  }, [query]);

  const count = typeof found === 'number' ? Math.min(limit, found) : limit;
  const est = estimateTranscription(count, preset.avgMinutes, minutes, setup?.speed ?? null);
  const blocked = notReady(setup);

  return (
    <div className="sp-form">
      <Field label="What to import">
        <select className="sp-input" value={presetId} onChange={(e) => choose(e.target.value)}>
          {IA_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </Field>
      <p className="sp-hint">{preset.description}</p>
      {preset.id === 'custom' ? (
        <Field label="Internet Archive search"><input className="sp-input" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} placeholder="collection:… AND subject:…" /></Field>
      ) : (
        <p className="sp-code">{preset.query}</p>
      )}
      <p className="sp-note">{found === null ? 'Counting…' : found === 'error' ? 'Could not reach the Internet Archive.' : `${formatCount(found)} recordings found.`}</p>
      <Field label="How many to import" hint="The most popular ones come first.">
        <input className="sp-input" type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
      </Field>
      <Field label="Transcribe"><MinutesSelect value={minutes} onChange={setMinutes} /></Field>
      <Field label="Extra topics (optional, separated by commas)"><input className="sp-input" value={topics} onChange={(e) => setTopics(e.target.value)} /></Field>
      <p className="sp-estimate">
        About <strong>{formatDuration(est.audioHours)}</strong> of audio, roughly <strong>{formatDuration(est.workHours)}</strong> of work on this computer
        {est.assumedSpeed ? ' (a guess until it has transcribed something here)' : ''}. You can pause at any time.
      </p>
      {blocked && <p className="sp-warn">{blocked}</p>}
      {error && <p className="sp-error">{error}</p>}
      <button
        type="button"
        className="act act-primary sp-start"
        disabled={busy || Boolean(blocked) || !query.trim() || !(limit >= 1) || found === 0}
        onClick={() =>
          void start(
            { kind: 'ia', query: query.trim(), limit, maxMinutes: minutes, topics: [...preset.topics, ...topicList(topics)], show: preset.show, title: preset.id === 'custom' ? undefined : preset.label },
            `Importing ${count} recordings.`,
          )
        }
      >
        Import {formatCount(count)} {count === 1 ? 'recording' : 'recordings'}
      </button>
    </div>
  );
}

/* ───────────────────────── Old films ───────────────────────── */

export function FilmsForm({ setup, onStarted }: FormProps) {
  const [info, setInfo] = useState<FilmsInfo | null>(null);
  const [confirm, setConfirm] = useState(false);
  const { busy, error, start } = useStarter(onStarted);
  useEffect(() => {
    fetchFilmsInfo().then(setInfo, () => undefined);
  }, []);
  const ffmpeg = setup?.tools.find((t) => t.id === 'ffmpeg');
  const missing = ffmpeg && !ffmpeg.ok ? 'ffmpeg is needed to put the films together. Install it first (top of this panel).' : null;
  if (!info) return <div className="sp-form"><p className="sp-note">Loading…</p></div>;
  return (
    <div className="sp-form">
      <p className="sp-note">
        <strong>{formatCount(info.films)} old films and shorts</strong>, {info.hours} hours of speech: Prelinger educational and industrial films, public-domain features, science fiction, horror, film noir and comedy.
        They come with transcripts from the People's Speech dataset, so nothing has to be transcribed. Only the parts of each film that the dataset has are included, usually a few minutes of dialogue.
      </p>
      <p className="sp-note">
        The data is downloaded from Hugging Face in {info.shards} pieces of about 470 MB, <strong>about {info.downloadGb} GB in total</strong>; <strong>{info.diskGb} GB</strong> stay on this computer. With a fast connection it takes one to two hours. You can pause at any time and continue later.
      </p>
      {missing && <p className="sp-warn">{missing}</p>}
      {error && <p className="sp-error">{error}</p>}
      {!confirm ? (
        <button type="button" className="act act-primary sp-start" disabled={Boolean(missing)} onClick={() => setConfirm(true)}>Add the old films…</button>
      ) : (
        <div className="sp-confirm">
          <p>This downloads about {info.downloadGb} GB. Start?</p>
          <div className="sp-row">
            <button type="button" className="act act-primary" disabled={busy} onClick={() => void start({ kind: 'films' }, 'Adding the old films.').then((ok) => ok && setConfirm(false))}>Yes, start</button>
            <button type="button" className="act" onClick={() => setConfirm(false)}>Not now</button>
          </div>
        </div>
      )}
    </div>
  );
}
