import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hit } from '../api.ts';
import { pinKey } from './model.ts';
import { timelinesApi, type SavedClip, type TimelineInfo } from './timelinesApi.ts';

export type { SavedClip, TimelineInfo };

/** The browser-only store this replaced. Its clips are imported once, the first time the server has no timelines. */
const LEGACY_KEY = 'back-then.timeline';
const ACTIVE_KEY = 'back-then.active-timeline';

/** How long a new clip keeps its "just landed" styling, and how long a removed one takes to fade. */
const ENTER_MS = 1400;
export const LEAVE_MS = 380;
const ERROR_MS = 6000;

function readLegacy(): SavedClip[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (c): c is SavedClip => !!c && typeof c.key === 'string' && typeof c.savedAt === 'number' && !!c.hit && typeof c.hit.ref === 'string',
    );
  } catch {
    return [];
  }
}

function rememberActive(id: number): void {
  try {
    localStorage.setItem(ACTIVE_KEY, String(id));
  } catch {
    // Storage can be blocked; the first timeline opens next time instead.
  }
}

function storedActive(): number | null {
  try {
    const id = Number(localStorage.getItem(ACTIVE_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

const withKey = (set: Set<string>, key: string, on: boolean) => {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
};

/** "Story 2", "Story 3", ...: the first of these that no timeline uses. */
export function nextName(timelines: TimelineInfo[]): string {
  const used = new Set(timelines.map((t) => t.name));
  for (let n = timelines.length + 1; ; n++) if (!used.has(`Story ${n}`)) return `Story ${n}`;
}

/**
 * The saved timelines (kept on the server, so they survive a browser change) and the clips of the
 * one that is open. `loaded` turns true once the open timeline's clips have arrived; `entering` and
 * `leaving` drive the arrival and exit animations of clips.
 */
export function useTimelines() {
  const [timelines, setTimelines] = useState<TimelineInfo[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [clips, setClips] = useState<SavedClip[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());

  const active = useRef<number | null>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const started = useRef(false);
  const errorTimer = useRef(0);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
    window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setError(null), ERROR_MS);
  }, []);

  const bump = useCallback((id: number, delta: number) => {
    setTimelines((list) => list.map((t) => (t.id === id ? { ...t, clipCount: Math.max(0, t.clipCount + delta) } : t)));
  }, []);

  /** Opens a timeline: fetches its clips, then shows them all at once. */
  const open = useCallback(async (id: number) => {
    const detail = await timelinesApi.get(id);
    active.current = id;
    rememberActive(id);
    setClips(detail.clips);
    setActiveId(id);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        let list = await timelinesApi.list();
        if (list.length === 0) {
          // First run with the server store: carry over what this browser had pinned.
          const legacy = readLegacy();
          const created = await timelinesApi.create(legacy.length ? 'My first story' : 'My story', legacy);
          if (legacy.length) {
            try {
              localStorage.removeItem(LEGACY_KEY);
            } catch {
              // Harmless: the server now has the clips.
            }
          }
          list = [created];
        }
        setTimelines(list);
        const wanted = storedActive();
        await open((list.find((t) => t.id === wanted) ?? list[0]!).id);
      } catch (err) {
        fail(err);
      }
    })();
  }, [open, fail]);

  const has = useCallback((key: string) => clips.some((c) => c.key === key), [clips]);

  const add = useCallback(
    (hit: Hit) => {
      const id = active.current;
      if (id === null) return;
      const key = pinKey(hit);
      if (clipsRef.current.some((c) => c.key === key)) return;
      const clip: SavedClip = { key, hit, savedAt: Date.now() };
      setClips((cur) => (cur.some((c) => c.key === key) ? cur : [...cur, clip]));
      setEntering((s) => withKey(s, key, true));
      window.setTimeout(() => setEntering((s) => withKey(s, key, false)), ENTER_MS);
      bump(id, 1);
      timelinesApi.addClip(id, clip).catch((err) => {
        // Not saved: take it off the timeline again so the screen matches the server.
        if (active.current === id) setClips((cur) => cur.filter((c) => c.key !== key));
        bump(id, -1);
        fail(err);
      });
    },
    [bump, fail],
  );

  const remove = useCallback(
    (key: string) => {
      const id = active.current;
      if (id === null) return;
      setLeaving((s) => withKey(s, key, true));
      bump(id, -1);
      timelinesApi.removeClip(id, key).catch((err) => {
        fail(err);
        void open(id); // show what the server really has
      });
      window.setTimeout(() => {
        setClips((cur) => (active.current === id ? cur.filter((c) => c.key !== key) : cur));
        setLeaving((s) => withKey(s, key, false));
      }, LEAVE_MS);
    },
    [bump, fail, open],
  );

  const switchTo = useCallback(
    (id: number) => {
      if (id === active.current) return;
      open(id).catch(fail);
    },
    [open, fail],
  );

  const createTimeline = useCallback(
    async (name?: string): Promise<{ id: number; name: string } | null> => {
      try {
        const created = await timelinesApi.create(name ?? nextName(timelines));
        setTimelines((list) => [...list, created]);
        await open(created.id);
        return { id: created.id, name: created.name };
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [timelines, open, fail],
  );

  const renameTimeline = useCallback(
    (id: number, name: string) => {
      const previous = timelines.find((t) => t.id === id)?.name;
      setTimelines((list) => list.map((t) => (t.id === id ? { ...t, name } : t)));
      timelinesApi
        .rename(id, name)
        .then((saved) => setTimelines((list) => list.map((t) => (t.id === id ? saved : t))))
        .catch((err) => {
          if (previous !== undefined) setTimelines((list) => list.map((t) => (t.id === id ? { ...t, name: previous } : t)));
          fail(err);
        });
    },
    [timelines, fail],
  );

  const duplicateTimeline = useCallback(
    async (id: number) => {
      try {
        const created = await timelinesApi.duplicate(id);
        setTimelines((list) => [...list, created]);
        await open(created.id);
      } catch (err) {
        fail(err);
      }
    },
    [open, fail],
  );

  const deleteTimeline = useCallback(
    async (id: number) => {
      if (timelines.length <= 1) return; // there is always at least one
      try {
        await timelinesApi.remove(id);
        const rest = timelines.filter((t) => t.id !== id);
        setTimelines(rest);
        if (active.current === id) await open(rest[0]!.id);
      } catch (err) {
        fail(err);
      }
    },
    [timelines, open, fail],
  );

  useEffect(() => () => window.clearTimeout(errorTimer.current), []);

  return {
    timelines, activeId, clips, loaded, error, entering, leaving, has,
    add, remove, switchTo, createTimeline, renameTimeline, duplicateTimeline, deleteTimeline,
  };
}
