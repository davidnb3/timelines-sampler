import type { Hit } from '../api.ts';

export interface TimelineInfo {
  id: number;
  name: string;
  clipCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavedClip {
  key: string;
  hit: Hit;
  savedAt: number;
}

export interface TimelineDetail extends TimelineInfo {
  clips: SavedClip[];
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

const base = '/api/timelines';

export const timelinesApi = {
  list: () => request<TimelineInfo[]>('GET', base),
  get: (id: number) => request<TimelineDetail>('GET', `${base}/${id}`),
  create: (name: string, clips: SavedClip[] = []) => request<TimelineInfo>('POST', base, { name, clips }),
  rename: (id: number, name: string) => request<TimelineInfo>('PATCH', `${base}/${id}`, { name }),
  remove: (id: number) => request<{ ok: true }>('DELETE', `${base}/${id}`),
  duplicate: (id: number) => request<TimelineInfo>('POST', `${base}/${id}/duplicate`),
  addClip: (id: number, clip: SavedClip) => request<TimelineInfo>('POST', `${base}/${id}/clips`, clip),
  removeClip: (id: number, key: string) => request<TimelineInfo>('DELETE', `${base}/${id}/clips?${new URLSearchParams({ key })}`),
};
