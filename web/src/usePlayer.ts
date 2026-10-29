import { useCallback, useEffect, useRef, useState } from 'react';
import { clipUrl, type Hit } from './api.ts';

export const PEAK_COUNT = 240;

/** Reduces decoded audio to PEAK_COUNT loudness peaks in 0..1 for drawing. */
async function computePeaks(data: ArrayBuffer): Promise<number[]> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(data);
  const samples = audio.getChannelData(0);
  const bucket = Math.max(1, Math.floor(samples.length / PEAK_COUNT));
  const peaks: number[] = [];
  for (let i = 0; i < PEAK_COUNT; i++) {
    let max = 0;
    const start = i * bucket;
    for (let j = start; j < Math.min(samples.length, start + bucket); j++) {
      const v = Math.abs(samples[j]!);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  const top = Math.max(...peaks, 0.001);
  return peaks.map((p) => p / top);
}

export interface Player {
  active: Hit | null;
  playing: boolean;
  loading: boolean;
  error: string | null;
  progress: number;
  peaks: number[] | null;
  toggle: (hit: Hit) => void;
  /** Reloads the active clip after its bounds changed. No-op for other hits. */
  replace: (hit: Hit) => void;
  stop: () => void;
  seek: (fraction: number) => void;
  audioProps: {
    ref: (el: HTMLAudioElement | null) => void;
    onPlay: () => void;
    onPause: () => void;
    onEnded: () => void;
  };
}

/**
 * One shared audio player for library clips. The server cuts the clip; it is fetched once as a
 * blob (instant seeking) and also decoded to draw the waveform.
 */
export function usePlayer(): Player {
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const [active, setActive] = useState<Hit | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback((hit: Hit) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setActive(hit);
    setSrc(null);
    setPeaks(null);
    setProgress(0);
    setPlaying(false);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(clipUrl(hit, 'mp3'), { signal: ctl.signal });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const buf = await res.arrayBuffer();
        if (ctl.signal.aborted) return;
        setSrc(URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' })));
        computePeaks(buf.slice(0)).then(
          (p) => !ctl.signal.aborted && setPeaks(p),
          () => undefined, // The clip still plays if the waveform cannot be decoded.
        );
      } catch (err) {
        if (ctl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!ctl.signal.aborted) setLoading(false);
      }
    })();
  }, []);

  // Start playback once the blob URL exists; release it when it is replaced.
  useEffect(() => {
    const el = audioEl.current;
    if (!src || !el) return;
    el.src = src;
    el.play().catch(() => setPlaying(false));
    return () => URL.revokeObjectURL(src);
  }, [src]);

  // Smooth playhead while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audioEl.current;
      if (el && Number.isFinite(el.duration) && el.duration > 0) setProgress(el.currentTime / el.duration);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = useCallback(
    (hit: Hit) => {
      const el = audioEl.current;
      if (active?.id === hit.id && src && el) {
        if (el.paused) void el.play();
        else el.pause();
        return;
      }
      el?.pause();
      load(hit);
    },
    [active, src, load],
  );

  const stop = useCallback(() => {
    abort.current?.abort();
    audioEl.current?.pause();
    setActive(null);
    setSrc(null);
    setPeaks(null);
    setPlaying(false);
    setLoading(false);
    setProgress(0);
  }, []);

  const seek = useCallback((fraction: number) => {
    const el = audioEl.current;
    if (!el || !Number.isFinite(el.duration)) return;
    const f = Math.min(1, Math.max(0, fraction));
    el.currentTime = f * el.duration;
    setProgress(f);
  }, []);

  const replace = useCallback(
    (hit: Hit) => {
      if (active?.id !== hit.id) return;
      audioEl.current?.pause();
      load(hit);
    },
    [active, load],
  );

  return {
    active, playing, loading, error, progress, peaks, toggle, replace, stop, seek,
    audioProps: {
      ref: (el) => { audioEl.current = el; },
      onPlay: () => setPlaying(true),
      onPause: () => setPlaying(false),
      onEnded: () => { setPlaying(false); setProgress(1); },
    },
  };
}
