import type { DatabaseSync } from 'node:sqlite';
import { isAbort } from './exec.ts';

/**
 * Background work that can be paused and resumed: a job is a list of items (one recording each), kept
 * in SQLite. One job runs at a time, its items one after another. Pausing aborts the item being worked
 * on and puts it back to "waiting", so no half-finished recording ever reaches the library; resuming
 * continues with the items that are still waiting. Closing the app counts as pausing.
 */

export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'cancelled';
export type ItemState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface ItemSpec {
  label: string;
  params: Record<string, unknown>;
}

export interface JobSummary {
  id: number;
  kind: string;
  title: string;
  state: JobState;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  /** What is being worked on right now, with its stage, while the job runs. */
  current: string | null;
  /** Why the job paused itself, or null. */
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobDetail extends JobSummary {
  /** Failed items with their messages (the others are only counted). */
  failures: { label: string; error: string }[];
}

export interface ProcessorContext {
  signal: AbortSignal;
  /** Shows what the item is doing ("Transcribing"). */
  progress(stage: string): void;
  /** Appends items to the running job (a film that continues in the next shard). */
  addItems(items: ItemSpec[]): void;
  /** The next waiting items of this job, so a processor can start fetching ahead. */
  peekWaiting(count: number): ItemSpec[];
  /** Whether the job already has an item with this label (to avoid adding one twice). */
  hasItem(label: string): boolean;
}

export type ItemResult = 'done' | 'skipped' | void;

export interface Processor {
  run(item: ItemSpec, ctx: ProcessorContext, jobParams: Record<string, unknown>): Promise<ItemResult>;
}

/** Thrown by a processor when going on is pointless (the speech model is missing): the job pauses with this message and the item stays waiting. */
export class JobStop extends Error {}

interface JobRow {
  id: number;
  kind: string;
  title: string;
  params: string;
  state: JobState;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export class JobRunner {
  private readonly conn: DatabaseSync;
  private readonly processors: Record<string, Processor>;
  private readonly listeners = new Set<() => void>();
  private readonly progress = new Map<number, string>();
  private busy = false;
  private active: { jobId: number; controller: AbortController; stop: 'pause' | 'cancel' | null } | null = null;

  constructor(conn: DatabaseSync, processors: Record<string, Processor>) {
    this.conn = conn;
    this.processors = processors;
  }

  /** Call once at start-up: work that was running when the app closed is paused, not lost. */
  start(): void {
    this.conn.prepare("UPDATE job_items SET state = 'waiting' WHERE state = 'running'").run();
    this.conn.prepare("UPDATE jobs SET state = 'paused', updated_at = ? WHERE state = 'running'").run(Date.now());
    this.kick();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  create(kind: string, title: string, params: Record<string, unknown>, items: ItemSpec[]): JobSummary {
    if (!this.processors[kind]) throw new Error(`Unknown job kind "${kind}"`);
    const now = Date.now();
    this.conn.exec('BEGIN');
    let id: number;
    try {
      id = Number(this.conn.prepare("INSERT INTO jobs (kind, title, params, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)").run(kind, title, JSON.stringify(params), now, now).lastInsertRowid);
      this.insertItems(id, items, 0);
      this.conn.exec('COMMIT');
    } catch (err) {
      this.conn.exec('ROLLBACK');
      throw err;
    }
    this.emit();
    this.kick();
    return this.get(id)!;
  }

  list(): JobSummary[] {
    return (this.conn.prepare('SELECT * FROM jobs ORDER BY id DESC').all() as unknown as JobRow[]).map((r) => this.summarize(r));
  }

  get(id: number): JobDetail | null {
    const row = this.row(id);
    if (!row) return null;
    const failures = this.conn.prepare("SELECT label, error FROM job_items WHERE job_id = ? AND state = 'failed' ORDER BY idx LIMIT 200").all(id) as unknown as { label: string; error: string }[];
    return { ...this.summarize(row), failures: failures.map((f) => ({ label: f.label, error: f.error })) };
  }

  pause(id: number): void {
    const row = this.mustGet(id);
    if (row.state === 'queued') this.setState(id, 'paused', null);
    else if (row.state === 'running') this.stopActive(id, 'pause');
  }

  resume(id: number): void {
    const row = this.mustGet(id);
    if (row.state !== 'paused') return;
    this.setState(id, 'queued', null);
    this.kick();
  }

  cancel(id: number): void {
    const row = this.mustGet(id);
    if (row.state === 'running') return this.stopActive(id, 'cancel');
    if (row.state === 'done' || row.state === 'cancelled') return;
    this.conn.prepare("UPDATE job_items SET state = 'skipped' WHERE job_id = ? AND state = 'waiting'").run(id);
    this.setState(id, 'cancelled', null);
  }

  remove(id: number): void {
    const row = this.mustGet(id);
    if (row.state === 'running') throw new Error('Pause or cancel the job before removing it');
    this.conn.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    this.emit();
  }

  /** Resolves when no job is running or queued; used by tests. */
  async idle(): Promise<void> {
    while (this.busy || this.conn.prepare("SELECT 1 FROM jobs WHERE state = 'queued'").get()) await new Promise((r) => setTimeout(r, 5));
  }

  // ---- internals ----

  private row(id: number): JobRow | undefined {
    return this.conn.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
  }

  private mustGet(id: number): JobRow {
    const row = this.row(id);
    if (!row) throw new Error('No such job');
    return row;
  }

  private summarize(r: JobRow): JobSummary {
    const counts = this.conn.prepare('SELECT state, COUNT(*) AS n FROM job_items WHERE job_id = ? GROUP BY state').all(r.id) as unknown as { state: ItemState; n: number }[];
    const n = (s: ItemState) => Number(counts.find((c) => c.state === s)?.n ?? 0);
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      state: r.state,
      total: counts.reduce((a, c) => a + Number(c.n), 0),
      done: n('done'),
      failed: n('failed'),
      skipped: n('skipped'),
      current: r.state === 'running' ? (this.progress.get(r.id) ?? null) : null,
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private insertItems(jobId: number, items: ItemSpec[], from: number): void {
    const add = this.conn.prepare("INSERT INTO job_items (job_id, idx, label, params, state) VALUES (?, ?, ?, ?, 'waiting')");
    items.forEach((it, i) => add.run(jobId, from + i, it.label, JSON.stringify(it.params)));
  }

  private setState(id: number, state: JobState, error: string | null): void {
    this.conn.prepare('UPDATE jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(state, error, Date.now(), id);
    if (state !== 'running') this.progress.delete(id);
    this.emit();
  }

  private stopActive(id: number, stop: 'pause' | 'cancel'): void {
    if (this.active?.jobId !== id) return;
    this.active.stop = stop;
    this.active.controller.abort();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private kick(): void {
    setImmediate(() => void this.drain());
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const next = this.conn.prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1").get() as unknown as JobRow | undefined;
        if (!next) break;
        await this.runJob(next);
      }
    } finally {
      this.busy = false;
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    const processor = this.processors[job.kind];
    const jobParams = JSON.parse(job.params) as Record<string, unknown>;
    this.setState(job.id, 'running', null);
    for (;;) {
      const item = this.conn.prepare("SELECT id, label, params FROM job_items WHERE job_id = ? AND state = 'waiting' ORDER BY idx LIMIT 1").get(job.id) as unknown as { id: number; label: string; params: string } | undefined;
      if (!item) return this.setState(job.id, 'done', null);

      const controller = new AbortController();
      this.active = { jobId: job.id, controller, stop: null };
      this.conn.prepare("UPDATE job_items SET state = 'running' WHERE id = ?").run(item.id);
      this.progress.set(job.id, item.label);
      this.emit();
      const spec: ItemSpec = { label: item.label, params: JSON.parse(item.params) as Record<string, unknown> };
      const ctx: ProcessorContext = {
        signal: controller.signal,
        progress: (stage) => {
          this.progress.set(job.id, `${item.label}: ${stage}`);
          this.emit();
        },
        addItems: (items) => {
          const last = this.conn.prepare('SELECT COALESCE(MAX(idx), -1) AS m FROM job_items WHERE job_id = ?').get(job.id) as unknown as { m: number };
          this.insertItems(job.id, items, Number(last.m) + 1);
          this.emit();
        },
        hasItem: (label) => this.conn.prepare('SELECT 1 FROM job_items WHERE job_id = ? AND label = ?').get(job.id, label) !== undefined,
        peekWaiting: (count) =>
          (this.conn.prepare("SELECT label, params FROM job_items WHERE job_id = ? AND state = 'waiting' ORDER BY idx LIMIT ?").all(job.id, count) as unknown as { label: string; params: string }[]).map((r) => ({
            label: r.label,
            params: JSON.parse(r.params) as Record<string, unknown>,
          })),
      };

      let outcome: ItemState = 'done';
      let message: string | null = null;
      let halt: { state: JobState; error: string | null } | null = null;
      try {
        const result = await processor!.run(spec, ctx, jobParams);
        if (result === 'skipped') outcome = 'skipped';
      } catch (err) {
        const stop = this.active?.stop ?? null;
        if (isAbort(err) && stop === 'pause') {
          outcome = 'waiting' as ItemState;
          halt = { state: 'paused', error: null };
        } else if (isAbort(err) && stop === 'cancel') {
          outcome = 'skipped';
          halt = { state: 'cancelled', error: null };
        } else if (err instanceof JobStop) {
          outcome = 'waiting' as ItemState;
          halt = { state: 'paused', error: err.message };
        } else {
          outcome = 'failed';
          message = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 300) : String(err);
        }
      }
      this.active = null;
      this.conn.prepare('UPDATE job_items SET state = ?, error = ?, finished_at = ? WHERE id = ?').run(outcome, message, outcome === 'waiting' ? null : Date.now(), item.id);
      if (halt) {
        if (halt.state === 'cancelled') this.conn.prepare("UPDATE job_items SET state = 'skipped' WHERE job_id = ? AND state = 'waiting'").run(job.id);
        return this.setState(job.id, halt.state, halt.error);
      }
      this.conn.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(Date.now(), job.id);
      this.progress.delete(job.id);
      this.emit();
    }
  }
}
