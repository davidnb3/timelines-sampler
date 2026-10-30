import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeUrl, Voice, type EndReason } from './audio.ts';
import { fetchSegments, rangeUrl, type Hit } from './api.ts';
import { buildPeaks, clampFade, clampNumber, fadeOf, windowFor, MIN_REGION_MS, NO_FADE, type Fade, type Region, type Segment } from './trim.ts';

/** The audio around a clip that is loaded for playing and trimming. */
export interface ClipWindow {
  startMs: number;
  endMs: number;
  buffer: AudioBuffer;
  peaks: Float32Array;
  segments: Segment[];
}

export interface Player {
  /** The clip whose window is loaded (playing, paused or loading). */
  active: Hit | null;
  playing: boolean;
  loading: boolean;
  error: string | null;
  loop: boolean;
  win: ClipWindow | null;
  /** The part that plays and gets saved. Changes live while an edge is dragged. */
  region: Region | null;
  /** Plays, pauses or resumes this clip; loads its window first if needed. */
  toggle: (hit: Hit) => void;
  stop: () => void;
  /** Plays from `ms` (absolute, inside the region). */
  seek: (ms: number) => void;
  /** Fade in and out of the region, drawn and heard (and exported) with it. */
  fades: Fade;
  /** `commit` is false while an edge or fade handle is being dragged and true when it is let go. */
  setEdit: (edit: { region: Region; fades: Fade }, commit: boolean) => void;
  setLoop: (loop: boolean) => void;
  /** After the clip's range changed elsewhere (more context): follow it, reloading if it left the window. */
  replace: (hit: Hit) => void;
  /** Absolute playback position in ms; meaningful while a window is loaded. */
  position: () => number;
}

/**
 * One shared player for library clips. It loads the clip plus some audio on each side and decodes
 * it, so the clip's edges can be moved (outward too) and heard before anything is saved.
 */
export function usePlayer(): Player {
  const [active, setActive] = useState<Hit | null>(null);
  const [win, setWin] = useState<ClipWindow | null>(null);
  const [region, setRegionState] = useState<Region | null>(null);
  const [fades, setFadesState] = useState<Fade>(NO_FADE);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loop, setLoopState] = useState(false);

  const voice = useRef<Voice | null>(null);
  const abort = useRef<AbortController | null>(null);
  const resumeAt = useRef(0); // absolute ms to continue from after a pause
  const live = useRef({ win, region, loop, fades });
  live.current = { win, region, loop, fades };

  const onEnd = useCallback((reason: EndReason) => {
    setPlaying(false);
    if (reason === 'ended') resumeAt.current = live.current.region?.a ?? 0;
  }, []);

  /** Starts a voice over `r` from `from` (absolute ms), replacing the current one. */
  const play = useCallback(
    async (w: ClipWindow, r: Region, from: number, looping: boolean, f: Fade) => {
      voice.current?.stop('stolen');
      const next = new Voice({
        buffer: w.buffer,
        from: (r.a - w.startMs) / 1000,
        to: Math.min((r.b - w.startMs) / 1000, w.buffer.duration),
        loop: looping,
        fadeIn: f.inMs / 1000,
        fadeOut: f.outMs / 1000,
        onEnd,
      });
      voice.current = next;
      await next.start((from - w.startMs) / 1000);
      if (voice.current === next) setPlaying(true);
    },
    [onEnd],
  );

  const position = useCallback((): number => {
    const w = live.current.win;
    if (!w) return 0;
    const v = voice.current;
    return v?.playing ? w.startMs + v.position() * 1000 : resumeAt.current;
  }, []);

  const load = useCallback(
    (hit: Hit) => {
      abort.current?.abort();
      voice.current?.stop('stolen');
      const ctl = new AbortController();
      abort.current = ctl;
      setActive(hit);
      setWin(null);
      setRegionState(null);
      setFadesState(fadeOf(hit));
      setPlaying(false);
      setError(null);
      setLoading(true);
      (async () => {
        try {
          const span = windowFor(hit.startMs, hit.endMs);
          const [buffer, segments] = await Promise.all([
            decodeUrl(rangeUrl(hit.ref, span.startMs, span.endMs), ctl.signal),
            hit.episodeId != null ? fetchSegments(hit.episodeId, span.startMs, span.endMs, ctl.signal).catch(() => []) : [],
          ]);
          if (ctl.signal.aborted) return;
          const w: ClipWindow = {
            startMs: span.startMs,
            // The recording may end before the padded window does.
            endMs: Math.min(span.endMs, span.startMs + buffer.duration * 1000),
            buffer,
            peaks: buildPeaks(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate),
            segments,
          };
          const r: Region = { a: hit.startMs, b: Math.min(hit.endMs, w.endMs) };
          setWin(w);
          setRegionState(r);
          resumeAt.current = r.a;
          await play(w, r, r.a, live.current.loop, fadeOf(hit));
        } catch (err) {
          if (ctl.signal.aborted) return;
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (!ctl.signal.aborted) setLoading(false);
        }
      })();
    },
    [play],
  );

  const toggle = useCallback(
    (hit: Hit) => {
      const { win: w, region: r, loop: looping, fades: f } = live.current;
      if (active?.id === hit.id && w && r) {
        const v = voice.current;
        if (v?.playing) {
          resumeAt.current = position();
          v.stop('stopped');
        } else {
          const from = resumeAt.current >= r.a && resumeAt.current < r.b - 20 ? resumeAt.current : r.a;
          void play(w, r, from, looping, f);
        }
        return;
      }
      load(hit);
    },
    [active, load, play, position],
  );

  const stop = useCallback(() => {
    abort.current?.abort();
    voice.current?.stop('stopped');
    voice.current = null;
    setActive(null);
    setWin(null);
    setRegionState(null);
    setPlaying(false);
    setLoading(false);
  }, []);

  const seek = useCallback(
    (ms: number) => {
      const { win: w, region: r, loop: looping, fades: f } = live.current;
      if (!w || !r) return;
      const at = clampNumber(ms, r.a, r.b - 20);
      resumeAt.current = at;
      void play(w, r, at, looping, f);
    },
    [play],
  );

  const setEdit = useCallback(
    (edit: { region: Region; fades: Fade }, commit: boolean) => {
      const w = live.current.win;
      if (!w) return;
      const next = { a: edit.region.a, b: Math.max(edit.region.b, edit.region.a + MIN_REGION_MS) };
      const nextFades = clampFade(edit.fades.inMs, edit.fades.outMs, next.b - next.a);
      setRegionState(next);
      setFadesState(nextFades);
      // Retarget the sound only when a handle is let go, so dragging does not stutter.
      if (commit && voice.current?.playing) {
        const here = position();
        void play(w, next, here >= next.a && here < next.b ? here : next.a, live.current.loop, nextFades);
      } else if (commit) {
        resumeAt.current = next.a;
      }
    },
    [play, position],
  );

  const setLoop = useCallback(
    (looping: boolean) => {
      setLoopState(looping);
      const { win: w, region: r, fades: f } = live.current;
      if (w && r && voice.current?.playing) void play(w, r, position(), looping, f);
    },
    [play, position],
  );

  const replace = useCallback(
    (hit: Hit) => {
      const { win: w, region: r } = live.current;
      if (active?.id !== hit.id) return;
      const inside = w && hit.startMs >= w.startMs && hit.endMs <= w.endMs;
      if (!w || !inside) return load(hit);
      const f = fadeOf(hit);
      const now = live.current.fades;
      if (r && (r.a !== hit.startMs || r.b !== hit.endMs || f.inMs !== now.inMs || f.outMs !== now.outMs)) {
        setEdit({ region: { a: hit.startMs, b: hit.endMs }, fades: f }, true);
      }
    },
    [active, load, setEdit],
  );

  useEffect(() => () => {
    abort.current?.abort();
    voice.current?.stop('stopped');
  }, []);

  return { active, playing, loading, error, loop, win, region, fades, toggle, stop, seek, setEdit, setLoop, replace, position };
}
