import { useEffect, useState } from 'react';
import type { JobDetail, JobSummary } from '../../../server/jobs.ts';
import type { SetupStatus, SetupTool } from '../../../server/setup.ts';

export type { JobDetail, JobSummary, SetupStatus, SetupTool };

/** What the desktop app's window adds (see desktop/preload.cjs). Absent in a normal browser. */
export interface DesktopBridge {
  desktop: true;
  platform: string;
  pickFiles(): Promise<string[]>;
  pickFolder(): Promise<string[]>;
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    timelinesApp?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | undefined => window.timelinesApp;

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

export interface PodcastFeed {
  id: number;
  title: string;
  author: string | null;
  description: string;
  image: string | null;
  episodeCount: number | null;
  language: string;
}

export interface FilmsInfo {
  films: number;
  hours: number;
  shards: number;
  downloadGb: number;
  diskGb: number;
}

export interface AppSettings {
  podcastIndexConfigured: boolean;
  whisperModel: string | null;
  transcribeSpeed: number | null;
}

export const createJob = (body: Record<string, unknown>) => send<JobSummary & { note: string | null }>('POST', '/api/jobs', body);
export const jobAction = (id: number, action: 'pause' | 'resume' | 'cancel') => send<JobSummary>('POST', `/api/jobs/${id}/${action}`, {});
export const removeJob = (id: number) => send<{ ok: true }>('DELETE', `/api/jobs/${id}`);
export const fetchJob = (id: number) => send<JobDetail>('GET', `/api/jobs/${id}`);
export const previewIa = (query: string) => send<{ count: number }>('POST', '/api/sources/ia/preview', { query });
export const previewFiles = (paths: string[]) => send<{ count: number; truncated: boolean; sample: string[] }>('POST', '/api/sources/files/preview', { paths });
export const searchPodcasts = (q: string) => send<PodcastFeed[]>('GET', `/api/sources/podcasts/search?${new URLSearchParams({ q })}`);
export const fetchFilmsInfo = () => send<FilmsInfo>('GET', '/api/sources/films');
export const fetchSettings = () => send<AppSettings>('GET', '/api/settings');
export const saveSettings = (body: { podcastIndexKey?: string; podcastIndexSecret?: string }) => send<AppSettings>('POST', '/api/settings', body);
export const installTool = (id: 'ffmpeg' | 'whisper' | 'model', model?: string) => send<SetupStatus>('POST', '/api/setup/install', { id, model });

export interface Events {
  jobs: JobSummary[];
  setup: SetupStatus | null;
  /** False until the server has answered, and while the connection is down. */
  live: boolean;
}

/** The jobs and the setup state, pushed by the server as they change. */
export function useEvents(): Events {
  const [state, setState] = useState<Events>({ jobs: [], setup: null, live: false });
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      const data = JSON.parse(e.data as string) as { jobs: JobSummary[]; setup: SetupStatus };
      setState({ jobs: data.jobs, setup: data.setup, live: true });
    };
    es.onerror = () => setState((s) => ({ ...s, live: false }));
    return () => es.close();
  }, []);
  return state;
}

/** A short sentence for a job's state. */
export function stateLabel(job: JobSummary): string {
  switch (job.state) {
    case 'running': return 'Importing';
    case 'queued': return 'Waiting';
    case 'paused': return 'Paused';
    case 'done': return job.failed ? 'Finished with problems' : 'Done';
    case 'cancelled': return 'Cancelled';
  }
}

export const jobActive = (j: JobSummary) => j.state === 'running' || j.state === 'queued';
