import { useEffect, useRef } from 'react';
import { idlePeaks } from './format.ts';
import type { Theme } from './theme.ts';

interface Props {
  /** Loudness peaks in 0..1, or null to show the idle envelope. */
  peaks: number[] | null;
  /** Playhead position in 0..1; bars before it are drawn in the "played" colour. */
  progress: number;
  loading: boolean;
  theme: Theme;
  onSeek?: (fraction: number) => void;
}

const BAR = 3;
const GAP = 2;
const HEIGHT = 120;

export function Waveform({ peaks, progress, loading, theme, onSeek }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = el.clientWidth;
      el.width = Math.round(width * dpr);
      el.height = Math.round(HEIGHT * dpr);
      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, HEIGHT);

      const css = getComputedStyle(el);
      const color = (name: string) => css.getPropertyValue(name).trim();
      const mid = HEIGHT / 2;

      // Dashed baseline, visible where there is no signal.
      ctx.strokeStyle = color('--wave-baseline');
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(width, mid);
      ctx.stroke();
      ctx.setLineDash([]);

      const count = Math.max(8, Math.floor((width + GAP) / (BAR + GAP)));
      const source = peaks ?? idlePeaks(count);
      const playedColor = color('--wave-played');
      const restColor = peaks ? color('--wave-rest') : color('--wave-idle');
      for (let i = 0; i < count; i++) {
        const lo = Math.floor((i / count) * source.length);
        const hi = Math.max(lo + 1, Math.floor(((i + 1) / count) * source.length));
        let v = 0;
        for (let j = lo; j < hi; j++) v = Math.max(v, source[j] ?? 0);
        const h = Math.max(2, v * (HEIGHT - 8));
        ctx.fillStyle = peaks && (i + 0.5) / count <= progress ? playedColor : restColor;
        ctx.beginPath();
        ctx.roundRect(i * (BAR + GAP), mid - h / 2, BAR, h, 1.5);
        ctx.fill();
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [peaks, progress, theme]);

  return (
    <canvas
      ref={canvas}
      className={`waveform${loading ? ' is-loading' : ''}`}
      style={{ height: HEIGHT }}
      role="img"
      aria-label={peaks ? 'Waveform of the selected clip' : 'No clip loaded'}
      onClick={(e) => {
        if (!peaks || !onSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek((e.clientX - rect.left) / rect.width);
      }}
    />
  );
}
