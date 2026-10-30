import { useEffect, useRef, useState, type DragEvent } from 'react';
import { bounceUrl } from '../api.ts';
import { formatTime } from '../format.ts';
import { Close, Download, Eye, EyeOff, Minus, Pause, Play, Plus } from '../icons.tsx';
import type { Theme } from '../theme.ts';
import { peakBetween } from '../trim.ts';
import { approach, storyLayout } from './layout.ts';
import { dropIndex, moveInOrder, stepGap, toggleKey, type StorySettings } from './settings.ts';
import type { Story } from './useStory.ts';

const STORY_PEAKS_PER_SEC = 100;

/**
 * The story as one waveform. While the clips load it grows outward from the middle of the screen,
 * as the app's logo does, and reaches both ends when everything is ready. Each clip owns the slice
 * of the width that its length takes; a slice that has not loaded yet shimmers until it does.
 */
function StoryWave({ story, theme }: { story: Story; theme: Theme }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef(story);
  live.current = story;
  const reveal = useRef(0);
  const colors = useRef({ ink: '238 237 232', accent: '255 106 61' });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const css = getComputedStyle(el);
    colors.current = {
      ink: css.getPropertyValue('--ink').trim().replace(/\s+/g, ' ') || colors.current.ink,
      accent: css.getPropertyValue('--accent').trim().replace(/\s+/g, ' ') || colors.current.accent,
    };
  }, [theme]);

  // One animation loop for the lifetime of the panel: it only does work while something is moving.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let raf = 0;
    let last = performance.now();
    let idleFrames = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = live.current;
      const HEIGHT = Math.max(48, el.clientHeight);
      const width = el.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      if (el.width !== Math.round(width * dpr) || el.height !== Math.round(HEIGHT * dpr)) {
        el.width = Math.round(width * dpr);
        el.height = Math.round(HEIGHT * dpr);
      }
      const ctx = el.getContext('2d');
      if (!ctx || width === 0) {
        raf = requestAnimationFrame(frame);
        return;
      }

      const target = s.status === 'ready' || s.status === 'closed' ? 1 : s.status === 'error' ? 0.04 : 0.05 + 0.9 * (s.total ? s.loaded / s.total : 0);
      const before = reveal.current;
      reveal.current = approach(before, target, dt, 3);
      if (Math.abs(target - reveal.current) < 0.002) reveal.current = target;
      const moving = reveal.current !== before || s.status === 'loading' || s.playing;
      idleFrames = moving ? 0 : idleFrames + 1;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, HEIGHT);
      const { ink, accent } = colors.current;
      const rgb = (c: string, a: number) => `rgb(${c} / ${a})`;
      const cx = width / 2;
      const mid = HEIGHT / 2;
      const maxHalf = mid - 6;
      const durations = s.slots.map((x) => x.durationMs);
      const { starts, total } = storyLayout(durations, s.gapMs);
      const reach = reveal.current * cx;
      const playedMs = s.status === 'ready' ? s.position() * 1000 : -1;
      const seconds = now / 1000;

      // A faint line where the waveform will be, so the space reads as a track while it fills.
      ctx.fillStyle = rgb(ink, 0.08);
      ctx.fillRect(0, mid, width, 1);

      if (total > 0) {
        for (let x = 0; x < width; x += 3) {
          const away = Math.abs(x + 1 - cx);
          if (away > reach) continue;
          const ms = ((x + 1) / width) * total;
          let slot = -1;
          for (let i = starts.length - 1; i >= 0; i--) {
            if (ms >= starts[i]!) {
              slot = i;
              break;
            }
          }
          const inClip = slot >= 0 && ms <= starts[slot]! + durations[slot]!;
          if (!inClip) continue; // the silence between clips
          const peaks = s.slots[slot]!.peaks;
          let half: number;
          let color: string;
          if (peaks) {
            half = Math.max(1, peakBetween(peaks, ms - starts[slot]!, ms - starts[slot]! + (total / width) * 3, STORY_PEAKS_PER_SEC) * maxHalf);
            color = ms <= playedMs ? rgb(accent, 0.95) : rgb(ink, 0.62);
          } else {
            half = (0.1 + 0.16 * (0.5 + 0.5 * Math.sin(x * 0.31 + seconds * 4))) * maxHalf;
            color = rgb(ink, 0.18);
          }
          // The leading edge of the growing waveform glows in the accent colour.
          const edge = reach - away;
          if (s.status === 'loading' && edge < 36) color = rgb(accent, 0.95 - (edge / 36) * 0.55);
          ctx.fillStyle = color;
          ctx.fillRect(x, mid - half, 2, half * 2);
        }
      }

      // At the very start: one orange bar in the middle, like the logo's centre bar.
      if (reveal.current < 0.12 || total === 0) {
        const pulse = 0.5 + 0.5 * Math.sin(seconds * 5);
        ctx.fillStyle = rgb(accent, 0.7 + 0.3 * pulse);
        ctx.fillRect(cx - 1.5, mid - maxHalf * (0.35 + 0.15 * pulse), 3, maxHalf * (0.7 + 0.3 * pulse));
      }

      // Clip numbers and dividers, once the waveform has grown over them.
      ctx.font = `600 10px ${getComputedStyle(el).getPropertyValue('--font-mono') || 'monospace'}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      s.slots.forEach((slot, i) => {
        const x = (starts[i]! / total) * width;
        if (!(Math.abs(x - cx) < reach)) return;
        if (i > 0) {
          ctx.fillStyle = rgb(ink, 0.14);
          ctx.fillRect(Math.round(x - ((s.gapMs / 2) / total) * width), 4, 1, HEIGHT - 8);
        }
        ctx.fillStyle = i === s.nowIndex ? rgb(accent, 1) : rgb(ink, 0.42);
        ctx.fillText(slot.no, x + 4, 3);
      });

      // Playhead.
      if (playedMs >= 0 && total > 0 && (s.playing || playedMs > 0)) {
        const x = Math.round((playedMs / total) * width);
        ctx.fillStyle = rgb(ink, 0.95);
        ctx.fillRect(x, 0, 1.5, HEIGHT);
      }

      if (idleFrames < 3) raf = requestAnimationFrame(frame);
      else raf = 0;
    };

    const wake = () => {
      if (!raf) {
        last = performance.now();
        idleFrames = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    wakeRef.current = wake;
    wake();
    const ro = new ResizeObserver(wake);
    ro.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      wakeRef.current = null;
    };
  }, []);

  const wakeRef = useRef<(() => void) | null>(null);
  // Anything that changes what is drawn restarts the loop if it had gone idle.
  useEffect(() => wakeRef.current?.());

  return (
    <canvas
      ref={canvas}
      className="story-canvas"
      role="img"
      aria-label="Waveform of the whole story. Click to jump."
      onPointerDown={(e) => {
        if (story.status !== 'ready' || story.total === 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        story.seek((e.clientX - rect.left) / rect.width);
      }}
    />
  );
}

/** The clock next to the play button; ticks only while the story plays. */
function StoryTime({ story }: { story: Story }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!story.playing) return;
    const id = window.setInterval(() => tick((n) => n + 1), 200);
    return () => window.clearInterval(id);
  }, [story.playing]);
  const ready = story.status === 'ready' && story.total > 0;
  return (
    <span className="story-time">
      {ready ? `${formatTime(story.position() * 1000)} / ${formatTime(story.durationSec * 1000)}` : '--:-- / --:--'}
    </span>
  );
}

/** The story's clips as chips: drag to reorder, the eye leaves one out, click to play from it. */
function StoryClips({ story, settings, onChange }: { story: Story; settings: StorySettings; onChange: (s: StorySettings) => void }) {
  const row = useRef<HTMLUListElement>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const keys = story.all.map((c) => c.key);
  const others = keys.filter((k) => k !== dragKey);

  const over = (e: DragEvent) => {
    if (dragKey === null || !row.current) return;
    e.preventDefault();
    const mids = [...row.current.querySelectorAll<HTMLElement>('li[data-key]')]
      .filter((li) => li.dataset.key !== dragKey)
      .map((li) => {
        const r = li.getBoundingClientRect();
        return r.left + r.width / 2;
      });
    setDropAt(dropIndex(mids, e.clientX));
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    if (dragKey !== null && dropAt !== null) onChange({ ...settings, order: moveInOrder(keys, dragKey, dropAt) });
    setDragKey(null);
    setDropAt(null);
  };

  if (story.all.length === 0) return null;
  const marker = (before: string | undefined) => (dropAt !== null && others[dropAt] === before ? <li key={`drop-${before ?? 'end'}`} className="story-drop" aria-hidden /> : null);

  return (
    <ul className="story-clips" ref={row} onDragOver={over} onDrop={drop} aria-label="Clips in the story. Drag to reorder.">
      {story.all.map((c) => {
        const muted = story.mutedKeys.has(c.key);
        return (
          <li key={c.key} data-key={c.key}>
            {marker(c.key)}
            <span
              className={`story-chip${muted ? ' is-muted' : ''}${story.nowKey === c.key ? ' is-now' : ''}${dragKey === c.key ? ' is-dragging' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', c.key);
                setDragKey(c.key);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setDropAt(null);
              }}
              title="Drag to reorder"
            >
              <button
                type="button"
                className="story-chip-main"
                disabled={muted || story.status !== 'ready'}
                onClick={() => story.seekToClip(c.key)}
                title={muted ? 'Left out of the story' : 'Play from this clip'}
              >
                <b>{c.no}</b>
                <span>{c.hit.show}</span>
              </button>
              <button
                type="button"
                className="story-chip-eye"
                onClick={() => onChange({ ...settings, muted: toggleKey(settings.muted, c.key) })}
                aria-label={muted ? `Put ${c.hit.show} back in the story` : `Leave ${c.hit.show} out of the story`}
                aria-pressed={muted}
                title={muted ? 'Put back in the story' : 'Leave out of the story'}
              >
                {muted ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </span>
          </li>
        );
      })}
      {marker(undefined)}
    </ul>
  );
}

export function StoryPanel({
  story, theme, leaving = false, title, settings, onSettings,
}: { story: Story; theme: Theme; leaving?: boolean; title?: string; settings: StorySettings; onSettings: (s: StorySettings) => void }) {
  const ready = story.status === 'ready' && story.total > 0;
  const status =
    story.status === 'error' ? `Could not build the story: ${story.error}`
    : story.status === 'loading' ? `Loading clip ${Math.min(story.loaded + 1, story.total)} of ${story.total}`
    : story.total === 0 ? (story.all.length > 0 ? 'Every clip is left out of the story.' : 'Pin clips from the library to build a story.')
    : story.nowIndex >= 0 ? `Clip ${story.nowIndex + 1} of ${story.total}`
    : `${story.total} clip${story.total === 1 ? '' : 's'}, ${settings.order.length > 0 ? 'in your order' : 'in date order'}`;
  // Downloads are named after the timeline, so stories from different timelines do not overwrite each other.
  const name = title ? `Back then - ${title}` : 'Back then story';

  return (
    <div className={`story${leaving ? ' is-leaving' : ''}`} role="region" aria-label="Story" aria-hidden={leaving}>
      <div className="story-wave">
        <StoryWave story={story} theme={theme} />
      </div>
      <StoryClips story={story} settings={settings} onChange={onSettings} />
      <div className="story-bar">
        <button type="button" className="story-play" onClick={story.toggle} disabled={!ready} aria-label={story.playing ? 'Pause story' : 'Play story'}>
          {story.playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <StoryTime story={story} />
        <span className="story-status" role="status" aria-live="polite">
          {status}
          {story.skipped > 0 && ` · ${story.skipped} TV clip${story.skipped === 1 ? '' : 's'} left out (stream only)`}
        </span>
        <span className="story-gap" title="Silence between clips">
          <span>Gap</span>
          <button type="button" onClick={() => onSettings({ ...settings, gapMs: stepGap(settings.gapMs, -1) })} disabled={settings.gapMs <= 0} aria-label="Shorter gap"><Minus size={12} /></button>
          <output>{(settings.gapMs / 1000).toFixed(1)} s</output>
          <button type="button" onClick={() => onSettings({ ...settings, gapMs: stepGap(settings.gapMs, 1) })} aria-label="Longer gap"><Plus size={12} /></button>
        </span>
        <span className="story-actions">
          <a className={`act${ready ? '' : ' is-disabled'}`} href={ready ? bounceUrl(story.downloadClips, 'wav', name, story.gapMs) : undefined} download aria-disabled={!ready} title="Save the story as WAV">
            <Download size={13} />wav
          </a>
          <a className={`act${ready ? '' : ' is-disabled'}`} href={ready ? bounceUrl(story.downloadClips, 'mp3', name, story.gapMs) : undefined} download aria-disabled={!ready} title="Save the story as MP3">
            <Download size={13} />mp3
          </a>
          <button type="button" className="act act-icon" onClick={story.close} aria-label="Close story" title="Close story (esc)"><Close size={13} /></button>
        </span>
      </div>
    </div>
  );
}

