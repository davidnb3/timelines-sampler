import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioContext, decodeUrl, Voice } from '../audio.ts';
import { rangeUrl, type StoryClip } from '../api.ts';
import type { TimelineItem } from '../timeline/Timeline.tsx';
import { pinKey } from '../timeline/model.ts';
import { buildPeaks, fadeOf } from '../trim.ts';
import { clipAt, storyLayout } from './layout.ts';
import { applyOrder, type StorySettings } from './settings.ts';

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
const peaksCache = new Map<string, Float32Array>();

/** Identity of a clip's audio: range and fades, since the server bakes the fades in. */
const audioId = (c: TimelineItem) => {
  const fade = fadeOf(c.hit);
  return `${c.hit.ref}|${c.hit.startMs}|${c.hit.endMs}|${fade.inMs}|${fade.outMs}`;
};

interface Built {
  buffer: AudioBuffer;
  starts: number[];
  durations: number[];
}

/** Joins decoded clips into one stereo buffer with silence between them. */
function stitch(buffers: AudioBuffer[], gapMs: number): Built {
  const ctx = audioContext();
  const rate = ctx.sampleRate;
  const gap = Math.round((gapMs / 1000) * rate);
  const durations = buffers.map((b) => (b.length / rate) * 1000);
  const { starts } = storyLayout(durations, gapMs);
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
 * The story: the library clips on the timeline, in the saved order (date order until the user
 * rearranges), minus the muted ones, played one after the other with the saved gap. Opening it
 * fetches and decodes each clip (a few at a time) and joins them into one buffer; `loaded` counts
 * up while that happens, which the panel shows as a waveform growing out from the middle. Clips
 * that are already decoded rebuild at once, so rearranging does not replay that.
 */
export function useStory(items: TimelineItem[], settings: StorySettings) {
  const library = useMemo(() => items.filter((i) => i.hit.source === 'library' && !i.leaving), [items]);
  /** Every library clip in story order, muted ones included (the panel lists them all). */
  const all = useMemo(() => applyOrder(library, settings.order), [library, settings.order]);
  const mutedKeys = useMemo(() => new Set(settings.muted), [settings.muted]);
  /** The clips that actually play. */
  const clips = useMemo(() => all.filter((c) => !mutedKeys.has(c.key)), [all, mutedKeys]);
  const skipped = items.filter((i) => i.hit.source === 'tv' && !i.leaving).length;
  const gapMs = settings.gapMs;
  // The range and fades are part of it, so trimming a clip rebuilds the story.
  const signature = `${clips.map((c) => `${c.key}@${pinKey(c.hit)}`).join('\n')}#${gapMs}`;

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
  const gapRef = useRef(gapMs);
  gapRef.current = gapMs;

  const stopVoice = useCallback(() => {
    voice.current?.stop('stopped');
    voice.current = null;
    setPlaying(false);
    setNowIndex(-1);
    resumeAt.current = 0;
  }, []);

  const playRef = useRef<() => Promise<void>>(async () => undefined);

  // Build the story whenever it is open and the clips, their order, their fades or the gap change.
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    const list = clipsRef.current;
    const gap = gapRef.current;
    stopVoice();
    built.current = null;
    setError(null);
    const slotsFor = () =>
      list.map((c) => ({ key: c.key, no: c.no, durationMs: c.hit.endMs - c.hit.startMs, peaks: peaksCache.get(audioId(c)) ?? null }));

    const finish = (buffers: AudioBuffer[]) => {
      built.current = stitch(buffers, gap);
      setStatus('ready');
      if (autoplay.current) {
        autoplay.current = false;
        void playRef.current();
      }
    };

    if (list.length === 0) {
      setSlots([]);
      setLoaded(0);
      setStatus('ready');
      return;
    }
    if (list.every((c) => decoded.has(audioId(c)))) {
      // Everything is already decoded: rebuild in place, without the loading animation.
      setSlots(slotsFor());
      setLoaded(list.length);
      finish(list.map((c) => decoded.get(audioId(c))!));
      return;
    }

    setSlots(slotsFor());
    setLoaded(list.filter((c) => decoded.has(audioId(c))).length);
    setStatus('loading');
    (async () => {
      try {
        const buffers: AudioBuffer[] = new Array(list.length);
        let next = 0;
        let done = 0;
        const worker = async () => {
          while (next < list.length) {
            const i = next++;
            const c = list[i]!;
            const id = audioId(c);
            const { hit } = c;
            // The server applies the fades, so the story sounds like the clip does and like its download.
            const buffer = decoded.get(id) ?? (await decodeUrl(rangeUrl(hit.ref, hit.startMs, hit.endMs, 'mp3', fadeOf(hit)), ctl.signal));
            decoded.set(id, buffer);
            if (ctl.signal.aborted) return;
            buffers[i] = buffer;
            const peaks =
              peaksCache.get(id) ??
              buildPeaks(Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch)), buffer.sampleRate, STORY_PEAKS_PER_SEC);
            peaksCache.set(id, peaks);
            setSlots((cur) => cur.map((s, k) => (k === i ? { ...s, peaks } : s)));
            setLoaded(++done);
          }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
        if (ctl.signal.aborted) return;
        finish(buffers);
      } catch (err) {
        if (ctl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    })();
    return () => ctl.abort();
    // The clips and gap are read through refs; the signature says when they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signature]);

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

  /** Jumps to the start of a clip (by its key) and plays from there. */
  const seekToClip = useCallback(
    (key: string) => {
      const b = built.current;
      const index = clipsRef.current.findIndex((c) => c.key === key);
      if (!b || index < 0) return;
      resumeAt.current = (b.starts[index] ?? 0) / 1000;
      void play();
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
        const index = clipAt(b.starts, b.durations, gapRef.current, position() * 1000);
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
    clips, all, mutedKeys, gapMs, downloadClips, durationSec,
    openStory, close, toggle, seek, seekToClip, position,
  };
}

export type Story = ReturnType<typeof useStory>;
