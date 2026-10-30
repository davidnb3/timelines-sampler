import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioContext, decodeUrl, Voice } from '../audio.ts';
import { rangeUrl, STORY_GAP_MS, type StoryClip } from '../api.ts';
import type { TimelineItem } from '../timeline/Timeline.tsx';
import { buildPeaks, fadeOf } from '../trim.ts';
import { clipAt, storyLayout } from './layout.ts';

export interface StorySlot {
  key: string;
  no: string;
  durationMs: number;
  /** Loudness of the clip once it has loaded, for drawing. */
  peaks: Float32Array | null;
}

export type StoryStatus = 'closed' | 'loading' | 'ready' | 'error';

/** Peaks per second for the story drawing; a story is minutes long at most, so this stays small. */
const STORY_PEAKS_PER_SEC = 100;
const PARALLEL = 3;

/** Decoded clips stay around so reopening or rebuilding a story does not fetch them again. */
const decoded = new Map<string, AudioBuffer>();

interface Built {
  buffer: AudioBuffer;
  starts: number[];
  durations: number[];
}

/** Joins decoded clips into one stereo buffer with silence between them. */
function stitch(buffers: AudioBuffer[]): Built {
  const ctx = audioContext();
  const rate = ctx.sampleRate;
  const gap = Math.round((STORY_GAP_MS / 1000) * rate);
  const durations = buffers.map((b) => (b.length / rate) * 1000);
  const { starts } = storyLayout(durations, STORY_GAP_MS);
  const length = buffers.reduce((sum, b, i) => sum + b.length + (i < buffers.length - 1 ? gap : 0), 0);
  const buffer = ctx.createBuffer(2, Math.max(1, length), rate);
  let at = 0;
  buffers.forEach((b, i) => {
    for (let ch = 0; ch < 2; ch++) buffer.getChannelData(ch).set(b.getChannelData(Math.min(ch, b.numberOfChannels - 1)), at);
    at += b.length + (i < buffers.length - 1 ? gap : 0);
  });
  return { buffer, starts, durations };
}

/**
 * The story: the library clips on the timeline, in date order, played one after the other. Opening
 * it fetches and decodes each clip (a few at a time) and joins them into one buffer; `loaded` counts
 * up while that happens, which the panel shows as a waveform growing out from the middle.
 */
export function useStory(items: TimelineItem[]) {
  const clips = useMemo(() => items.filter((i) => i.hit.source === 'library' && !i.leaving), [items]);
  const skipped = items.filter((i) => i.hit.source === 'tv' && !i.leaving).length;
  const signature = clips.map((c) => c.key).join('\n');

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StoryStatus>('closed');
  const [slots, setSlots] = useState<StorySlot[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [nowIndex, setNowIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [, redraw] = useState(0);

  const built = useRef<Built | null>(null);
  const voice = useRef<Voice | null>(null);
  const resumeAt = useRef(0); // seconds
  const autoplay = useRef(false);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  const stopVoice = useCallback(() => {
    voice.current?.stop('stopped');
    voice.current = null;
    setPlaying(false);
    setNowIndex(-1);
    resumeAt.current = 0;
  }, []);

  // Build the story whenever it is open and the set of clips changes.
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    const list = clipsRef.current;
    stopVoice();
    built.current = null;
    setError(null);
    setLoaded(0);
    setSlots(list.map((c) => ({ key: c.key, no: c.no, durationMs: c.hit.endMs - c.hit.startMs, peaks: null })));
    if (list.length === 0) {
      setStatus('ready');
      return;
    }
    setStatus('loading');

    (async () => {
      try {
        const buffers: AudioBuffer[] = new Array(list.length);
        let next = 0;
        let done = 0;
        const worker = async () => {
          while (next < list.length) {
            const i = next++;
            const { hit } = list[i]!;
            const fade = fadeOf(hit);
            const id = `${hit.ref}|${hit.startMs}|${hit.endMs}|${fade.inMs}|${fade.outMs}`;
            // The server applies the fades, so the story sounds like the clip does and like its download.
            const buffer = decoded.get(id) ?? (await decodeUrl(rangeUrl(hit.ref, hit.startMs, hit.endMs, 'mp3', fade), ctl.signal));
            decoded.set(id, buffer);
            if (ctl.signal.aborted) return;
            buffers[i] = buffer;
            const peaks = buildPeaks(Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)), buffer.sampleRate, STORY_PEAKS_PER_SEC);
            setSlots((cur) => cur.map((s, k) => (k === i ? { ...s, peaks } : s)));
            setLoaded(++done);
          }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
        if (ctl.signal.aborted) return;
        built.current = stitch(buffers);
        setStatus('ready');
        if (autoplay.current) {
          autoplay.current = false;
          void playRef.current();
        }
      } catch (err) {
        if (ctl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    })();
    return () => ctl.abort();
    // The clips themselves are read through `clipsRef`; only a change of the set rebuilds the story.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signature]);

  const playRef = useRef<() => Promise<void>>(async () => undefined);

  const position = useCallback((): number => {
    const v = voice.current;
    return v?.playing ? v.position() : resumeAt.current;
  }, []);

  const durationSec = built.current ? built.current.buffer.duration : 0;

  const play = useCallback(async () => {
    const b = built.current;
    if (!b) return;
    voice.current?.stop('stolen');
    const v = new Voice({
      buffer: b.buffer,
      from: 0,
      to: b.buffer.duration,
      loop: false,
      onEnd: (reason) => {
        if (voice.current !== v) return;
        if (reason === 'ended') {
          resumeAt.current = 0;
          setNowIndex(-1);
        }
        setPlaying(false);
      },
    });
    voice.current = v;
    const from = resumeAt.current >= b.buffer.duration - 0.05 ? 0 : resumeAt.current;
    await v.start(from);
    if (voice.current === v) setPlaying(true);
  }, []);

  playRef.current = play;

  const pause = useCallback(() => {
    const v = voice.current;
    if (!v?.playing) return;
    resumeAt.current = v.position();
    v.stop('stopped');
  }, []);

  const toggle = useCallback(() => {
    if (voice.current?.playing) pause();
    else void play();
  }, [pause, play]);

  /** Jumps to a fraction (0..1) of the story. */
  const seek = useCallback(
    (fraction: number) => {
      const b = built.current;
      if (!b) return;
      resumeAt.current = Math.min(1, Math.max(0, fraction)) * b.buffer.duration;
      if (voice.current?.playing) void play();
      else redraw((n) => n + 1); // paused: the clock and playhead still need to move
    },
    [play],
  );

  // While playing, follow which clip is current so the timeline can show and visit it.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = -2;
    const tick = () => {
      const b = built.current;
      if (b) {
        const index = clipAt(b.starts, b.durations, STORY_GAP_MS, position() * 1000);
        if (index !== last) {
          last = index;
          setNowIndex(index);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, position]);

  /** Opens the panel and, once the clips are loaded, starts playing: the user asked to play the story. */
  const openStory = useCallback(() => {
    autoplay.current = true;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    autoplay.current = false;
    stopVoice();
    setOpen(false);
    setStatus('closed');
  }, [stopVoice]);

  useEffect(() => () => voice.current?.stop('stopped'), []);

  const downloadClips: StoryClip[] = clips.map((c) => ({
    ref: c.hit.ref,
    start: c.hit.startMs,
    end: c.hit.endMs,
    ...(c.hit.fadeInMs ? { fi: c.hit.fadeInMs } : {}),
    ...(c.hit.fadeOutMs ? { fo: c.hit.fadeOutMs } : {}),
  }));

  return {
    open, status, slots, loaded, total: clips.length, skipped, error, playing, nowIndex,
    nowKey: nowIndex >= 0 ? (clips[nowIndex]?.key ?? null) : null,
    clips, downloadClips, durationSec,
    openStory, close, toggle, seek, position,
  };
}

export type Story = ReturnType<typeof useStory>;
