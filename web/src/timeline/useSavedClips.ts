import { useCallback, useEffect, useState } from 'react';
import type { Hit } from '../api.ts';
import { pinKey } from './model.ts';

export interface SavedClip {
  key: string;
  hit: Hit;
  savedAt: number;
}

const STORAGE_KEY = 'back-then.timeline';

/** How long a new clip keeps its "just landed" styling, and how long a removed one takes to fade. */
const ENTER_MS = 1400;
export const LEAVE_MS = 380;

function read(): SavedClip[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (c): c is SavedClip => !!c && typeof c.key === 'string' && typeof c.savedAt === 'number' && !!c.hit && typeof c.hit.ref === 'string',
    );
  } catch {
    return [];
  }
}

const withKey = (set: Set<string>, key: string, on: boolean) => {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
};

/**
 * Clips the user starred or downloaded, kept in this browser (localStorage) so the timeline is
 * still there next visit. `entering` and `leaving` drive the arrival and exit animations.
 */
export function useSavedClips() {
  const [clips, setClips] = useState<SavedClip[]>(read);
  const [entering, setEntering] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clips));
    } catch {
      // Storage can be blocked or full; the timeline still works for this visit.
    }
  }, [clips]);

  const has = useCallback((key: string) => clips.some((c) => c.key === key), [clips]);

  const add = useCallback((hit: Hit) => {
    const key = pinKey(hit);
    setClips((cur) => (cur.some((c) => c.key === key) ? cur : [...cur, { key, hit, savedAt: Date.now() }]));
    setEntering((s) => withKey(s, key, true));
    window.setTimeout(() => setEntering((s) => withKey(s, key, false)), ENTER_MS);
  }, []);

  const remove = useCallback((key: string) => {
    setLeaving((s) => withKey(s, key, true));
    window.setTimeout(() => {
      setClips((cur) => cur.filter((c) => c.key !== key));
      setLeaving((s) => withKey(s, key, false));
    }, LEAVE_MS);
  }, []);

  return { clips, entering, leaving, has, add, remove };
}
