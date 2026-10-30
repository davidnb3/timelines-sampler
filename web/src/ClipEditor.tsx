import { useEffect, useRef, useState } from 'react';
import { formatTime } from './format.ts';
import type { Theme } from './theme.ts';
import { boundaries, clampFade, dragEdge, dragFade, fadeGain, moveRegion, peakBetween, snapTime, type Fade, type Region } from './trim.ts';
import type { ClipWindow } from './usePlayer.ts';

interface Edit {
  region: Region;
  fades: Fade;
}

interface Props {
  win: ClipWindow;
  region: Region;
  fades: Fade;
  playing: boolean;
  loading?: boolean;
  theme: Theme;
  /** Absolute playback position in ms. */
  position: () => number;
  /** False shows the clip as it is (click to play from a point) with no trimming. */
  editable?: boolean;
  height?: number;
  onChange?: (edit: Edit, commit: boolean) => void;
  onSeek: (ms: number) => void;
}

type Target = 'a' | 'b' | 'fi' | 'fo' | 'body' | 'outside';
type Grab = 'a' | 'b' | 'fi' | 'fo' | 'body';

const RULER = 16;
const EDGE_GRAB_PX = 8;
const SNAP_PX = 8;
/** The fade handles sit in the top strip of the clip, like Ableton's corner handles. */
const FADE_ZONE_PX = 18;
const FADE_GRAB_PX = 9;

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
function stamp(ms: number): string {
  const tenths = Math.floor((ms % 1000) / 10);
  return `${formatTime(ms)}.${String(tenths).padStart(2, '0')}`;
}
const fadeLabel = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`);

/**
 * The waveform of a clip and the audio around it, with the clip's region highlighted. Like a clip
 * in Ableton's arrangement view: drag an edge to trim (outward too, the audio is already loaded),
 * drag the square at the top of an edge to fade in or out, drag the middle to slide the region, click
 * inside it to play from there. Edges snap to sentence boundaries from the transcript; hold Alt to
 * place them freely.
 */
export function ClipEditor({ win, region, fades, playing, loading = false, theme, position, editable = true, height = 96, onChange, onSeek }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Target>('outside');
  const [dragging, setDragging] = useState<Grab | null>(null);
  const drag = useRef<{ target: Grab; startX: number; start: Edit; moved: boolean; pending: Edit } | null>(null);
  const latest = useRef({ win, region, fades, playing, position, hover, dragging, height, loading, theme });
  latest.current = { win, region, fades, playing, position, hover, dragging, height, loading, theme };
  const colors = useRef({ ink: '238 237 232', accent: '255 106 61' });
  const targets = useRef<number[]>([]);
  targets.current = boundaries(win.segments);

  const draw = () => {
    const el = canvas.current;
    if (!el) return;
    const { win: w, region: r, fades: f, playing: isPlaying, position: pos, hover: over, dragging: active, height: h, loading: busy, theme: mode } = latest.current;
    const width = el.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(width * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(width * dpr);
      el.height = Math.round(h * dpr);
    }
    const ctx = el.getContext('2d');
    if (!ctx || width === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const { ink, accent } = colors.current;
    const rgb = (c: string, a: number) => `rgb(${c} / ${a})`;
    const mono = getComputedStyle(el).getPropertyValue('--font-mono') || 'monospace';
    const span = w.endMs - w.startMs;
    const xOf = (ms: number) => ((ms - w.startMs) / span) * width;
    const mid = RULER + (h - RULER) / 2;
    const maxHalf = (h - RULER) / 2 - 3;
    const bottom = h - 2;
    const xa = xOf(r.a);
    const xb = xOf(r.b);
    const fadeInPx = (f.inMs / span) * width;
    const fadeOutPx = (f.outMs / span) * width;
    const now = pos();

    // Region tint, then the bars: bright inside the region (and thinner where a fade lowers them),
    // dim outside, accent where already played.
    ctx.fillStyle = rgb(accent, 0.07);
    ctx.fillRect(xa, RULER, xb - xa, h - RULER);
    for (let x = 0; x < width; x += 2) {
      const t0 = w.startMs + (x / width) * span;
      const t1 = w.startMs + ((x + 2) / width) * span;
      const peak = busy ? 0.06 : peakBetween(w.peaks, t0 - w.startMs, t1 - w.startMs);
      const inside = t0 >= r.a - 1 && t1 <= r.b + 1;
      const played = inside && isPlaying && t1 <= now;
      ctx.fillStyle = played ? rgb(accent, 0.95) : inside ? rgb(ink, 0.78) : rgb(ink, 0.2);
      const gain = inside ? fadeGain((t0 + t1) / 2, r, f) : 1;
      const half = Math.max(0.75, peak * gain * maxHalf);
      ctx.fillRect(x, mid - half, 1.4, half * 2);
    }

    // Fade shapes: the diagonal is the gain curve, the shaded corner is what the fade takes away.
    const shade = mode === 'dark' ? 'rgb(0 0 0 / 0.38)' : 'rgb(255 255 255 / 0.6)';
    if (fadeInPx > 0.5) {
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.moveTo(xa, RULER);
      ctx.lineTo(xa + fadeInPx, RULER);
      ctx.lineTo(xa, bottom);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgb(accent, 0.95);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xa, bottom);
      ctx.lineTo(xa + fadeInPx, RULER);
      ctx.stroke();
    }
    if (fadeOutPx > 0.5) {
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.moveTo(xb - fadeOutPx, RULER);
      ctx.lineTo(xb, RULER);
      ctx.lineTo(xb, bottom);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgb(accent, 0.95);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xb - fadeOutPx, RULER);
      ctx.lineTo(xb, bottom);
      ctx.stroke();
    }

    // Sentence boundaries from the transcript: the places edges snap to.
    ctx.fillStyle = rgb(ink, 0.14);
    for (const t of targets.current) {
      if (t <= w.startMs || t >= w.endMs) continue;
      for (let y = RULER + 2; y < h - 2; y += 6) ctx.fillRect(Math.round(xOf(t)), y, 1, 3);
    }

    // Ruler.
    ctx.font = `500 10px ${mono}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const pxPerSecond = (width / span) * 1000;
    const step = [1, 2, 5, 10, 30, 60].find((s) => s * pxPerSecond >= 64) ?? 60;
    for (let t = Math.ceil(w.startMs / 1000 / step) * step; t * 1000 <= w.endMs; t += step) {
      const x = Math.round(xOf(t * 1000));
      ctx.fillStyle = rgb(ink, 0.3);
      ctx.fillRect(x, RULER - 5, 1, 5);
      ctx.fillStyle = rgb(ink, 0.5);
      ctx.fillText(formatTime(t * 1000), x + 4, RULER / 2 - 1);
    }

    // Region edges: a line and a grip, brighter when hovered or dragged.
    for (const edge of ['a', 'b'] as const) {
      const x = edge === 'a' ? xa : xb;
      const hot = over === edge || active === edge || active === 'body';
      ctx.fillStyle = rgb(accent, hot ? 1 : 0.85);
      ctx.fillRect(Math.round(x) - (edge === 'b' ? 2 : 0), RULER, 2, h - RULER);
      if (editable) {
        ctx.fillStyle = rgb(accent, 1);
        ctx.beginPath();
        ctx.roundRect(Math.round(x) - (edge === 'a' ? 1 : 5), mid - 10, 6, 20, 3);
        ctx.fill();
        ctx.fillStyle = 'rgb(255 255 255 / 0.85)';
        ctx.fillRect(Math.round(x) - (edge === 'a' ? -1 : 3), mid - 5, 1, 10);
      }
    }

    // Fade handles: small squares at the top of each edge, sliding inward as the fade grows.
    if (editable) {
      for (const which of ['fi', 'fo'] as const) {
        const x = which === 'fi' ? xa + fadeInPx : xb - fadeOutPx;
        const hot = over === which || active === which;
        ctx.fillStyle = hot ? '#fff' : rgb(accent, 1);
        ctx.strokeStyle = hot ? rgb(accent, 1) : 'rgb(255 255 255 / 0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(Math.round(x) - 4, RULER + 1, 8, 8, 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Playhead.
    if (isPlaying) {
      const x = Math.round(xOf(now));
      ctx.fillStyle = rgb(ink, 0.95);
      ctx.fillRect(x, RULER, 1.5, h - RULER);
      ctx.beginPath();
      ctx.moveTo(x - 4, RULER);
      ctx.lineTo(x + 5.5, RULER);
      ctx.lineTo(x + 0.75, RULER + 6);
      ctx.fill();
    }

    // Readouts: the region's length, and the value being dragged (an edge time or a fade length).
    const pill = (text: string, cx: number, y: number) => {
      ctx.font = `600 10.5px ${mono}`;
      const wText = ctx.measureText(text).width + 12;
      const x = Math.min(width - wText - 2, Math.max(2, cx - wText / 2));
      ctx.fillStyle = rgb(accent, 0.95);
      ctx.beginPath();
      ctx.roundRect(x, y, wText, 17, 8.5);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(text, x + wText / 2, y + 9);
    };
    if (xb - xa > 56 && active !== 'fi' && active !== 'fo') pill(seconds(r.b - r.a), (xa + xb) / 2, RULER + 4);
    if (active === 'a' || active === 'b') pill(stamp(active === 'a' ? r.a : r.b), active === 'a' ? xa : xb, h - 22);
    if (active === 'fi') pill(`fade in ${fadeLabel(f.inMs)}`, xa + fadeInPx, RULER + 14);
    if (active === 'fo') pill(`fade out ${fadeLabel(f.outMs)}`, xb - fadeOutPx, RULER + 14);
  };

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const css = getComputedStyle(el);
    colors.current = {
      ink: css.getPropertyValue('--ink').trim().replace(/\s+/g, ' ') || colors.current.ink,
      accent: css.getPropertyValue('--accent').trim().replace(/\s+/g, ' ') || colors.current.accent,
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
    // `draw` reads everything it needs from `latest`, so it does not belong in the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win, region, fades, theme, hover, dragging, height, loading]);

  // While playing, redraw every frame so the playhead moves.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const timeAt = (clientX: number) => {
    const rect = canvas.current!.getBoundingClientRect();
    return win.startMs + ((clientX - rect.left) / rect.width) * (win.endMs - win.startMs);
  };
  const pxToMs = (px: number) => (px / canvas.current!.clientWidth) * (win.endMs - win.startMs);

  const hitTest = (clientX: number, clientY: number): Target => {
    const rect = canvas.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const span = win.endMs - win.startMs;
    const xa = ((region.a - win.startMs) / span) * rect.width;
    const xb = ((region.b - win.startMs) / span) * rect.width;
    if (editable) {
      // The top strip belongs to the fade handles, the rest of the edge line to trimming.
      if (y >= RULER - 2 && y <= RULER + FADE_ZONE_PX) {
        const dIn = Math.abs(x - (xa + (fades.inMs / span) * rect.width));
        const dOut = Math.abs(x - (xb - (fades.outMs / span) * rect.width));
        if (Math.min(dIn, dOut) <= FADE_GRAB_PX) return dIn <= dOut ? 'fi' : 'fo';
      }
      const da = Math.abs(x - xa);
      const db = Math.abs(x - xb);
      if (Math.min(da, db) <= EDGE_GRAB_PX) return da <= db ? 'a' : 'b';
    }
    return x > xa && x < xb ? 'body' : 'outside';
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const target = hitTest(e.clientX, e.clientY);
    if (target === 'outside') return;
    if (target === 'body' && !editable) return onSeek(timeAt(e.clientX));
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = { region, fades };
    drag.current = { target: target as Grab, startX: e.clientX, start, moved: false, pending: start };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return setHover(hitTest(e.clientX, e.clientY));
    const dx = e.clientX - d.startX;
    if (!d.moved) {
      if (Math.abs(dx) < 3) return;
      d.moved = true;
      setDragging(d.target);
    }
    const delta = pxToMs(dx);
    const free = e.altKey;
    const near = (t: number) => (free ? { t, snapped: false } : snapTime(t, targets.current, pxToMs(SNAP_PX)));
    const { region: r0, fades: f0 } = d.start;
    let next: Edit;
    if (d.target === 'fi' || d.target === 'fo') {
      const t = d.target === 'fi' ? r0.a + f0.inMs + delta : r0.b - f0.outMs + delta;
      next = { region: r0, fades: dragFade(d.target === 'fi' ? 'in' : 'out', r0, f0, t) };
    } else if (d.target === 'body') {
      // Slide the region; whichever of its edges is closer to a sentence boundary snaps to it.
      const moved = moveRegion(r0, delta, win);
      const sa = near(moved.a);
      const sb = near(moved.b);
      const useA = sa.snapped && (!sb.snapped || Math.abs(sa.t - moved.a) <= Math.abs(sb.t - moved.b));
      const slid = useA ? moveRegion(r0, sa.t - r0.a, win) : sb.snapped ? moveRegion(r0, sb.t - r0.b, win) : moved;
      next = { region: slid, fades: f0 };
    } else {
      const raw = (d.target === 'a' ? r0.a : r0.b) + delta;
      const trimmed = dragEdge(r0, d.target, near(raw).t, win);
      // Fades keep their length when they still fit; a shorter region shortens them.
      next = { region: trimmed, fades: clampFade(f0.inMs, f0.outMs, trimmed.b - trimmed.a) };
    }
    d.pending = next;
    onChange?.(next, false);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (canvas.current?.hasPointerCapture(e.pointerId)) canvas.current.releasePointerCapture(e.pointerId);
    setDragging(null);
    if (d.moved) onChange?.(d.pending, true);
    else if (d.target === 'body') onSeek(timeAt(e.clientX));
  };

  const cursor =
    dragging === 'body' ? 'grabbing'
    : hover === 'a' || hover === 'b' || hover === 'fi' || hover === 'fo' || dragging !== null ? 'ew-resize'
    : hover === 'body' ? (editable ? 'grab' : 'pointer')
    : 'default';

  return (
    <canvas
      ref={canvas}
      className={`editor${loading ? ' is-loading' : ''}`}
      style={{ height, cursor }}
      role="img"
      aria-label={editable ? 'Clip waveform. Drag the orange edges to trim, the squares at the top to fade, the middle to slide, and click to play from a point.' : 'Clip waveform. Click to play from a point.'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => !drag.current && setHover('outside')}
    />
  );
}
