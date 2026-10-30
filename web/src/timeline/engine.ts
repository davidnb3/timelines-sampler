import {
  LEVELS, MAX_PPY, MIN_PPY, YEAR_MS, alignedTimes, clamp, clampTime, fitView, formatFocus, levelFor, tickLabel,
  type View,
} from './model.ts';

export interface NodeRef {
  key: string;
  t: number;
  el: HTMLElement | undefined;
}

export interface EngineOptions {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  nodes: () => NodeRef[];
  /** Called with the date under the playhead whenever its text changes. */
  onFocus: (text: string) => void;
  reducedMotion: () => boolean;
}

export interface Engine {
  dispose: () => void;
  invalidate: () => void;
  refreshColors: () => void;
  /** The view the camera is heading for (not the one currently drawn). */
  view: () => View;
  flyTo: (view: Partial<View> & { center: number }, ms?: number) => Promise<void>;
  /** Starts zoomed far out and settles on `target`: the opening shot. */
  intro: (target: View) => void;
  zoomBy: (factor: number) => void;
  /** Where the line sits as a fraction of the height; moves there smoothly. */
  setLineRatio: (ratio: number) => void;
  fit: (times: number[]) => Promise<void>;
  width: () => number;
  /** Screen position where time `t` lands for `view`, on the timeline's line. */
  screenPoint: (t: number, view: View) => { x: number; y: number };
}

interface Anim {
  start: number;
  dur: number;
  c0: number;
  c1: number;
  z0: number;
  z1: number;
  /** How far the camera pulls back in the middle of the flight, in ln(ppy). */
  dip: number;
  done: () => void;
}

const LN_MIN = Math.log(MIN_PPY);
const LN_MAX = Math.log(MAX_PPY);
/** The line sits below the middle: nodes stand above it, tick labels hang below. */
export const LINE_RATIO = 0.64;
/** How fast the line moves when its ratio changes, per second. */
const RATIO_RATE = 7;
const MONO = "'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const gauss = (d: number, spread: number) => Math.exp(-((d / spread) ** 2));

export function createEngine(o: EngineOptions): Engine {
  const { host, canvas } = o;
  const ctx = canvas.getContext('2d')!;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let center = Date.now();
  let ln = Math.log(60);
  let tCenter = center;
  let tLn = ln;
  let velPx = 0;
  let anim: Anim | null = null;
  let raf = 0;
  let last = 0;
  let dragging = false;
  let lastFocus = '';
  let ratio = LINE_RATIO;
  let targetRatio = LINE_RATIO;
  let ink = '236,236,232';
  let accent = '255,106,61';

  const ppyNow = () => Math.exp(ln);
  const lineY = () => Math.round(h * ratio);
  const xOf = (t: number) => w / 2 + ((t - center) / YEAR_MS) * ppyNow();

  function refreshColors() {
    const s = getComputedStyle(host);
    const triple = (name: string, fallback: string) => s.getPropertyValue(name).trim().replace(/\s+/g, ',') || fallback;
    ink = triple('--ink', ink);
    accent = triple('--accent', accent);
    invalidate();
  }

  /** Re-reads the host size; returns true if the canvas had to be resized. */
  function measure(): boolean {
    const nw = host.clientWidth;
    const nh = host.clientHeight;
    const nd = window.devicePixelRatio || 1;
    if (nw === w && nh === h && nd === dpr) return false;
    w = nw;
    h = nh;
    dpr = nd;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    host.style.setProperty('--line-y', `${lineY()}px`);
    return true;
  }

  function cancelAnim() {
    if (!anim) return;
    const { done } = anim;
    anim = null;
    done();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const ppy = ppyNow();
    const cx = w / 2;
    const ly = lineY();
    const span = (w / ppy) * YEAR_MS;
    const t0 = center - span / 2 - span * 0.05;
    const t1 = center + span / 2 + span * 0.05;
    const edge = (x: number) => 0.1 + 0.9 * gauss(x - cx, w * 0.3);
    const rgba = (c: string, a: number) => `rgba(${c},${a.toFixed(3)})`;

    // Soft light under the playhead, squashed into an ellipse.
    ctx.save();
    ctx.translate(cx, ly);
    ctx.scale(1, 0.55);
    const radius = Math.max(220, w * 0.3);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    glow.addColorStop(0, rgba(accent, 0.2));
    glow.addColorStop(0.45, rgba(accent, 0.07));
    glow.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();

    // The line: a hairline that fades toward both ends, with a hot core in the middle.
    const base = ctx.createLinearGradient(0, 0, w, 0);
    base.addColorStop(0, rgba(ink, 0));
    base.addColorStop(0.2, rgba(ink, 0.3));
    base.addColorStop(0.5, rgba(ink, 0.65));
    base.addColorStop(0.8, rgba(ink, 0.3));
    base.addColorStop(1, rgba(ink, 0));
    ctx.fillStyle = base;
    ctx.fillRect(0, ly, w, 1);
    const core = ctx.createLinearGradient(cx - w * 0.22, 0, cx + w * 0.22, 0);
    core.addColorStop(0, rgba(accent, 0));
    core.addColorStop(0.5, rgba(accent, 0.95));
    core.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = core;
    ctx.fillRect(cx - w * 0.22, ly - 0.5, w * 0.44, 2);

    // Ticks: the labelled level plus the next finer one as small marks.
    const major = levelFor(ppy);
    const at = LEVELS.indexOf(major);
    const minor = at > 0 ? LEVELS[at - 1]! : null;
    const majors = alignedTimes(major, t0, t1);
    const majorSet = new Set(majors);
    const tick = (x: number, half: number, alpha: number) => {
      ctx.fillStyle = rgba(ink, alpha);
      ctx.fillRect(Math.round(x), ly - half, 1, half * 2 + 1);
    };
    if (minor && minor.years * ppy >= 7) {
      for (const t of alignedTimes(minor, t0, t1)) {
        if (!majorSet.has(t)) tick(xOf(t), 3, 0.55 * edge(xOf(t)));
      }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    Reflect.set(ctx, 'letterSpacing', '0.08em');
    for (const t of majors) {
      const x = xOf(t);
      if (x < -60 || x > w + 60) continue;
      const a = edge(x);
      const { text, strong } = tickLabel(major, t);
      tick(x, strong ? 11 : 7, (strong ? 0.95 : 0.7) * a);
      const size = 10.5 + 3.5 * gauss(x - cx, 140);
      ctx.font = `${strong ? 600 : 500} ${size.toFixed(2)}px ${MONO}`;
      ctx.fillStyle = rgba(ink, (strong ? 0.92 : 0.62) * a);
      ctx.fillText(text, x, ly + 30);
    }
    Reflect.set(ctx, 'letterSpacing', '0px');
  }

  function placeNodes() {
    const cx = w / 2;
    for (const n of o.nodes()) {
      const el = n.el;
      if (!el) continue;
      const x = xOf(n.t);
      const visible = x > -240 && x < w + 240;
      const was = el.style.visibility;
      if (visible && was !== 'visible') el.style.visibility = 'visible';
      else if (!visible && was !== 'hidden') el.style.visibility = 'hidden';
      if (!visible) continue;
      el.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
      const prox = gauss(x - cx, 110);
      el.style.setProperty('--prox', prox.toFixed(3));
      const near = prox > 0.6 ? 'true' : 'false';
      if (el.dataset.near !== near) el.dataset.near = near;
    }
  }

  function frame(now: number) {
    raf = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    measure();
    let moving = false;

    if (ratio !== targetRatio) {
      ratio += (targetRatio - ratio) * (1 - Math.exp(-dt * RATIO_RATE));
      if (Math.abs(targetRatio - ratio) < 0.0005) ratio = targetRatio;
      host.style.setProperty('--line-y', `${lineY()}px`);
      moving = true;
    }

    if (anim) {
      const p = clamp((now - anim.start) / anim.dur, 0, 1);
      const e = easeInOut(p);
      center = anim.c0 + (anim.c1 - anim.c0) * e;
      ln = clamp(anim.z0 + (anim.z1 - anim.z0) * e - anim.dip * Math.sin(Math.PI * e), LN_MIN, LN_MAX);
      tCenter = center;
      tLn = ln;
      moving = true;
      if (p >= 1) {
        center = tCenter = anim.c1;
        ln = tLn = anim.z1;
        cancelAnim();
        moving = false;
      }
    } else if (!dragging) {
      const ppy = ppyNow();
      if (Math.abs(velPx) > 3) {
        tCenter = clampTime(tCenter - ((velPx * dt) / ppy) * YEAR_MS);
        velPx *= Math.exp(-dt * 3.8);
        moving = true;
      } else {
        velPx = 0;
      }
      const k = 1 - Math.exp(-dt * 16);
      center += (tCenter - center) * k;
      ln += (tLn - ln) * k;
      if (Math.abs(tCenter - center) / YEAR_MS * ppy > 0.05 || Math.abs(tLn - ln) > 0.0004) moving = true;
      else {
        center = tCenter;
        ln = tLn;
      }
    }

    draw();
    placeNodes();
    const text = formatFocus(center, ppyNow());
    if (text !== lastFocus) {
      lastFocus = text;
      o.onFocus(text);
    }
    if (moving) invalidate();
  }

  function invalidate() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function flyTo(view: Partial<View> & { center: number }, ms?: number): Promise<void> {
    cancelAnim();
    const c1 = clampTime(view.center);
    const z1 = clamp(Math.log(view.ppy ?? ppyNow()), LN_MIN, LN_MAX);
    velPx = 0;
    const distPx = (Math.abs(c1 - center) / YEAR_MS) * Math.exp(Math.min(ln, z1));
    if (o.reducedMotion() || (distPx < 0.5 && Math.abs(z1 - ln) < 0.001)) {
      center = tCenter = c1;
      ln = tLn = z1;
      invalidate();
      return Promise.resolve();
    }
    const width = Math.max(w, 1);
    const dip = clamp(Math.log1p(distPx / width) * 0.75, 0, 1.8);
    const dur = ms ?? clamp(650 + 260 * Math.log2(1 + distPx / width), 650, 1700);
    return new Promise<void>((resolve) => {
      anim = { start: performance.now(), dur, c0: center, c1, z0: ln, z1, dip, done: resolve };
      invalidate();
    });
  }

  // Pointer: drag to pan with inertia. A click (no real movement) is left alone for the nodes.
  let down: { x: number; y: number; lastX: number; lastT: number; moved: boolean; id: number } | null = null;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-no-pan]')) return;
    down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastT: performance.now(), moved: false, id: e.pointerId };
  }

  function onPointerMove(e: PointerEvent) {
    if (!down || e.pointerId !== down.id) return;
    if (!down.moved) {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) return;
      down.moved = true;
      dragging = true;
      cancelAnim();
      host.setPointerCapture(e.pointerId);
      host.classList.add('is-dragging');
    }
    const now = performance.now();
    const dx = e.clientX - down.lastX;
    const seconds = Math.max(1, now - down.lastT) / 1000;
    velPx = velPx * 0.6 + (dx / seconds) * 0.4;
    center = tCenter = clampTime(center - (dx / ppyNow()) * YEAR_MS);
    down.lastX = e.clientX;
    down.lastT = now;
    invalidate();
  }

  function onPointerUp(e: PointerEvent) {
    if (!down || e.pointerId !== down.id) return;
    if (down.moved) {
      if (performance.now() - down.lastT > 90) velPx = 0;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
    }
    dragging = false;
    host.classList.remove('is-dragging');
    down = null;
    invalidate();
  }

  // Wheel: vertical scroll and pinch zoom around the pointer, horizontal scroll pans.
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    cancelAnim();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? h : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    const ppyT = Math.exp(tLn);
    if (e.ctrlKey || Math.abs(dy) > Math.abs(dx)) {
      const px = e.clientX - host.getBoundingClientRect().left;
      const next = clamp(tLn - dy * (e.ctrlKey ? 0.012 : 0.0024), LN_MIN, LN_MAX);
      const anchor = tCenter + ((px - w / 2) / ppyT) * YEAR_MS;
      tLn = next;
      tCenter = clampTime(anchor - ((px - w / 2) / Math.exp(next)) * YEAR_MS);
    } else {
      tCenter = clampTime(tCenter + (dx / ppyT) * YEAR_MS);
    }
    velPx = 0;
    invalidate();
  }

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('wheel', onWheel, { passive: false });
  const ro = new ResizeObserver(() => invalidate());
  ro.observe(host);
  refreshColors();
  measure();

  return {
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      cancelAnim();
      ro.disconnect();
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('wheel', onWheel);
    },
    invalidate,
    refreshColors,
    view: () => ({ center: tCenter, ppy: Math.exp(tLn) }),
    flyTo,
    intro(target) {
      cancelAnim();
      if (o.reducedMotion()) {
        center = tCenter = clampTime(target.center);
        ln = tLn = Math.log(target.ppy);
        invalidate();
        return;
      }
      center = tCenter = clampTime(target.center);
      ln = tLn = LN_MIN;
      void flyTo(target, 2200);
    },
    setLineRatio(next) {
      targetRatio = next;
      invalidate();
    },
    zoomBy(factor) {
      cancelAnim();
      tLn = clamp(tLn + Math.log(factor), LN_MIN, LN_MAX);
      invalidate();
    },
    fit(times) {
      measure();
      return flyTo(fitView(times, w), undefined);
    },
    width: () => w,
    screenPoint(t, view) {
      const rect = host.getBoundingClientRect();
      measure();
      return { x: rect.left + w / 2 + ((t - view.center) / YEAR_MS) * view.ppy, y: rect.top + lineY() };
    },
  };
}
