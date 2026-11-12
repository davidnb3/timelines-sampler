import { useEffect, useState } from 'react';
import { ArchiveForm, FilesForm, FilmsForm, PodcastForm } from './forms.tsx';
import { formatCount } from './presets.ts';
import {
  fetchJob, installTool, jobAction, jobActive, removeJob, stateLabel,
  type Events, type JobSummary, type SetupStatus, type SetupTool,
} from './sourcesApi.ts';

type Tile = 'files' | 'podcasts' | 'ia' | 'films';

const TILES: { id: Tile; title: string; text: string }[] = [
  { id: 'files', title: 'My files', text: 'Audio or video on this computer' },
  { id: 'podcasts', title: 'Podcasts', text: 'Search by name, pick episodes' },
  { id: 'ia', title: 'Internet Archive', text: 'Old radio, commercials, films, TV shows' },
  { id: 'films', title: 'Old films', text: 'Ready-made transcripts, no waiting' },
];

const mb = (n: number) => `${formatCount(Math.round(n / 1e6))} MB`;

function ToolRow({ tool, model }: { tool: SetupTool; model: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const progress = tool.install?.state === 'installing' ? tool.install : null;
  const pct = progress && progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;
  return (
    <li className={`sp-tool${tool.ok ? ' is-ok' : ''}`}>
      <span className="sp-tool-state" aria-hidden>{tool.ok ? '✓' : '·'}</span>
      <span className="sp-tool-main">
        <strong>{tool.label}</strong>
        <em>{tool.ok ? tool.detail : progress ? `Downloading${progress.total ? `… ${mb(progress.done)} of ${mb(progress.total)}` : '…'}` : tool.detail}</em>
        {progress && <span className="sp-bar"><i style={{ width: `${pct ?? 100}%` }} className={pct === null ? 'is-wait' : ''} /></span>}
        {tool.install?.state === 'error' && <span className="sp-error">{tool.install.error}</span>}
        {error && <span className="sp-error">{error}</span>}
        {!tool.ok && tool.hint && (
          <span className="sp-cmd">
            Run in a terminal: <code>{tool.hint}</code>
            <button type="button" className="sp-link" onClick={() => void navigator.clipboard?.writeText(tool.hint!)}>Copy</button>
          </span>
        )}
      </span>
      {tool.installable && !progress && (
        <button type="button" className="act" onClick={() => installTool(tool.id, tool.id === 'model' ? (model ?? undefined) : undefined).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>
          {tool.install?.state === 'error' ? 'Try again' : 'Install'}
        </button>
      )}
    </li>
  );
}

function SetupCard({ setup }: { setup: SetupStatus }) {
  const [model, setModel] = useState<string | null>(null);
  const chosen = model ?? setup.models.find((m) => m.selected)?.id ?? setup.models[0]!.id;
  const modelNeeded = setup.tools.some((t) => t.id === 'model' && !t.ok);
  return (
    <section className="sp-card" aria-label="Set up transcription">
      <h3>Set up transcription</h3>
      <p className="sp-note">Recordings from podcasts, radio and your own files are turned into searchable text on this computer. It needs three things.</p>
      <ul className="sp-tools">
        {setup.tools.map((t) => <ToolRow key={t.id} tool={t} model={chosen} />)}
      </ul>
      {modelNeeded && (
        <fieldset className="sp-models">
          <legend>Speech model</legend>
          {setup.models.map((m) => (
            <label key={m.id} className={chosen === m.id ? 'is-on' : ''}>
              <input type="radio" name="model" checked={chosen === m.id} onChange={() => setModel(m.id)} />
              <span><strong>{m.label}</strong> · {m.sizeMb} MB<em>{m.note}</em></span>
            </label>
          ))}
        </fieldset>
      )}
      {setup.platform === 'win32' && setup.nvidia && <p className="sp-hint">An NVIDIA graphics card was found: the speech engine will use it, which is much faster.</p>}
    </section>
  );
}

/** The items that failed, loaded when the list is opened. */
function Failures({ jobId }: { jobId: number }) {
  const [list, setList] = useState<{ label: string; error: string }[] | null>(null);
  return (
    <details className="sp-failures" onToggle={(e) => e.currentTarget.open && fetchJob(jobId).then((j) => setList(j.failures), () => setList([]))}>
      <summary>What failed</summary>
      {list === null ? <p className="sp-hint">Loading…</p> : <ul>{list.map((f) => <li key={f.label}><strong>{f.label}</strong> {f.error}</li>)}</ul>}
    </details>
  );
}

function JobRow({ job }: { job: JobSummary }) {
  const [error, setError] = useState<string | null>(null);
  const finished = job.done + job.skipped + job.failed;
  const pct = job.total ? Math.round((finished / job.total) * 100) : 0;
  const act = (fn: () => Promise<unknown>) => fn().then(() => setError(null), (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  return (
    <li className={`sp-job is-${job.state}`}>
      <div className="sp-job-head">
        <strong title={job.title}>{job.title}</strong>
        <span className="sp-badge">{stateLabel(job)}</span>
      </div>
      <span className="sp-bar"><i style={{ width: `${pct}%` }} /></span>
      <p className="sp-job-line">
        {formatCount(job.done)} added{job.skipped ? ` · ${formatCount(job.skipped)} skipped` : ''}{job.failed ? ` · ${formatCount(job.failed)} failed` : ''} · {formatCount(job.total)} in all
      </p>
      {job.current && <p className="sp-job-now" title={job.current}>{job.current}</p>}
      {job.error && <p className="sp-warn">{job.error}</p>}
      {job.failed > 0 && <Failures jobId={job.id} />}
      {error && <p className="sp-error">{error}</p>}
      <div className="sp-row">
        {jobActive(job) && <button type="button" className="act" onClick={() => void act(() => jobAction(job.id, 'pause'))}>Pause</button>}
        {job.state === 'paused' && <button type="button" className="act act-primary" onClick={() => void act(() => jobAction(job.id, 'resume'))}>Resume</button>}
        {(jobActive(job) || job.state === 'paused') && <button type="button" className="act" onClick={() => void act(() => jobAction(job.id, 'cancel'))}>Cancel</button>}
        {!jobActive(job) && <button type="button" className="act" onClick={() => void act(() => removeJob(job.id))}>Remove from list</button>}
      </div>
    </li>
  );
}

export interface SourcesPanelProps {
  open: boolean;
  onClose: () => void;
  events: Events;
  /** Files dropped onto the window; the panel opens on "My files" with them. */
  droppedPaths: string[];
}

/** The "Add sources" screen: one tile per kind of source, the setup it needs, and the imports that are running. */
export function SourcesPanel({ open, onClose, events, droppedPaths }: SourcesPanelProps) {
  const [tile, setTile] = useState<Tile | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (droppedPaths.length) setTile('files');
  }, [droppedPaths]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const { setup, jobs } = events;
  const onStarted = (m: string) => {
    setMessage(m);
    setTile(null);
  };
  const form = (id: Tile) => {
    const props = { setup, onStarted };
    if (id === 'files') return <FilesForm {...props} initialPaths={droppedPaths} />;
    if (id === 'podcasts') return <PodcastForm {...props} />;
    if (id === 'ia') return <ArchiveForm {...props} />;
    return <FilmsForm {...props} />;
  };

  return (
    <div className="sp-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="sp-panel" role="dialog" aria-label="Add sources">
        <header className="sp-head">
          <h2>Add sources</h2>
          <button type="button" className="bar-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="sp-body">
          {!events.live && <p className="sp-warn">Connecting to the app…</p>}
          {setup && !setup.ready && <SetupCard setup={setup} />}
          {message && <p className="sp-ok" role="status">{message} Progress is shown below.</p>}

          <section aria-label="Sources">
            <h3>Where from?</h3>
            <div className="sp-tiles">
              {TILES.map((t) => (
                <button key={t.id} type="button" className={`sp-tile${tile === t.id ? ' is-on' : ''}`} aria-expanded={tile === t.id} onClick={() => setTile(tile === t.id ? null : t.id)}>
                  <strong>{t.title}</strong>
                  <span>{t.text}</span>
                </button>
              ))}
            </div>
            {tile && <div className="sp-formwrap">{form(tile)}</div>}
            <p className="sp-hint">Live TV captions need no import: they are searched live, with the “TV captions” switch next to the search box.</p>
          </section>

          <section aria-label="Imports">
            <h3>Imports</h3>
            {jobs.length === 0 ? <p className="sp-note">Nothing has been imported yet.</p> : <ul className="sp-jobs">{jobs.map((j) => <JobRow key={j.id} job={j} />)}</ul>}
          </section>

          {setup?.ready && (
            <section aria-label="Transcription">
              <h3>Transcription</h3>
              <ul className="sp-tools">{setup.tools.map((t) => <ToolRow key={t.id} tool={t} model={null} />)}</ul>
              {setup.speed && <p className="sp-hint">This computer transcribes about {setup.speed}× faster than real time.</p>}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
