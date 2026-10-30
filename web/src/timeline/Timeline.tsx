import {
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode, type Ref,
} from 'react';
import type { Hit } from '../api.ts';
import { formatDate } from '../format.ts';
import { Chevron, Expand, Fit, Minus, Play, Plus } from '../icons.tsx';
import type { Theme } from '../theme.ts';
import { createEngine, type Engine } from './engine.ts';
import { fitView, planView, type View } from './model.ts';

export interface TimelineItem {
  key: string;
  /** Position on the timeline, ms since the epoch. */
  t: number;
  /** "01", "02", ... in date order. */
  no: string;
  /** 0-2: how tall the node's stem is, so neighbours do not overlap. */
  tier: number;
  hit: Hit;
  entering: boolean;
  leaving: boolean;
}

export interface TimelineHandle {
  /** Where the camera should go to show a clip dated `t`, given the dates already pinned. */
  plan: (t: number, existing: number[]) => View;
  flyToView: (view: View, ms?: number) => Promise<void>;
  /** Viewport position where a clip dated `t` will sit once the camera reaches `view`. */
  screenPoint: (t: number, view: View) => { x: number; y: number };
  /** A ripple from the playhead: a clip just landed. */
  pulse: () => void;
  /** Moves to the previous/next pinned clip and opens it. */
  step: (dir: 1 | -1) => void;
  fit: () => void;
  /** Flies the camera to a time, keeping the zoom. */
  focus: (t: number) => void;
}

interface Props {
  ref?: Ref<TimelineHandle>;
  items: TimelineItem[];
  theme: Theme;
  tall: boolean;
  onToggleTall: () => void;
  openKey: string | null;
  onOpen: (key: string | null) => void;
  renderPopover: (item: TimelineItem) => ReactNode;
  /** The line's height as a fraction of the panel; lower leaves room below it for the story. */
  lineRatio?: number;
  /** The clip the story is playing right now. */
  nowKey?: string | null;
  storyOpen?: boolean;
  onStory?: () => void;
  /** Shown below the line (the story panel). */
  footer?: ReactNode;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Timeline({ ref, items, theme, tall, onToggleTall, openKey, onOpen, renderPopover, lineRatio = 0.64, nowKey = null, storyOpen = false, onStory, footer }: Props) {
  const host = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [focusText, setFocusText] = useState('');
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    const eng = createEngine({
      host: host.current!,
      canvas: canvas.current!,
      nodes: () => itemsRef.current.map((i) => ({ key: i.key, t: i.t, el: nodeEls.current.get(i.key) })),
      onFocus: setFocusText,
      reducedMotion: reduced,
    });
    engine.current = eng;
    eng.intro(fitView(itemsRef.current.map((i) => i.t), eng.width() || window.innerWidth));
    return () => {
      eng.dispose();
      engine.current = null;
    };
  }, []);

  // New, removed or re-tiered nodes need a frame to get their position before they paint.
  useLayoutEffect(() => engine.current?.invalidate(), [items]);
  useEffect(() => engine.current?.refreshColors(), [theme]);
  useEffect(() => engine.current?.setLineRatio(lineRatio), [lineRatio]);

  const times = useCallback(() => itemsRef.current.map((i) => i.t), []);

  const openNode = useCallback(
    (item: TimelineItem) => {
      if (openKey === item.key) return onOpen(null);
      void engine.current?.flyTo({ center: item.t });
      onOpen(item.key);
    },
    [onOpen, openKey],
  );

  useImperativeHandle(
    ref,
    () => ({
      plan: (t, existing) => planView(t, existing, engine.current!.view(), engine.current!.width()),
      flyToView: (view, ms) => engine.current!.flyTo(view, ms),
      screenPoint: (t, view) => engine.current!.screenPoint(t, view),
      pulse: () => setPulseKey((k) => k + 1),
      step: (dir) => {
        const eng = engine.current;
        const list = itemsRef.current;
        if (!eng || list.length === 0) return;
        const c = eng.view().center;
        const eps = 1000 * 3600;
        const next = dir === 1 ? list.find((i) => i.t > c + eps) : [...list].reverse().find((i) => i.t < c - eps);
        const target = next ?? (dir === 1 ? list[0] : list[list.length - 1])!;
        void eng.flyTo({ center: target.t });
        onOpen(target.key);
      },
      fit: () => void engine.current?.fit(times()),
      focus: (t) => void engine.current?.flyTo({ center: t }, 900),
    }),
    [onOpen, times],
  );

  // A click anywhere outside the open clip (and its node) closes it.
  useEffect(() => {
    if (!openKey) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.node-pop, .node-dot')) onOpen(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [openKey, onOpen]);

  const count = items.filter((i) => !i.leaving).length;

  return (
    <section ref={host} className="tl" aria-label="Timeline of saved clips">
      <canvas ref={canvas} className="tl-canvas" aria-hidden />

      <div className="tl-marker" aria-hidden>
        <span className="tl-marker-line" />
        <span className="tl-puck"><Chevron size={11} /></span>
        <span key={pulseKey} className={pulseKey ? 'tl-ripple is-on' : 'tl-ripple'} />
      </div>
      <div className="tl-readout" aria-live="off">{focusText}</div>

      <ol className="tl-nodes">
        {items.map((item, i) => {
          const open = openKey === item.key;
          return (
            <li
              key={item.key}
              ref={(el) => {
                if (el) nodeEls.current.set(item.key, el);
                else nodeEls.current.delete(item.key);
              }}
              className={`node${item.entering ? ' is-entering' : ''}${item.leaving ? ' is-leaving' : ''}${open ? ' is-open' : ''}${item.key === nowKey ? ' is-now' : ''}`}
              style={{ '--tier': item.tier, '--i': Math.min(i, 12) } as CSSProperties}
            >
              <span className="node-stem" />
              <button
                type="button"
                className={`node-dot${item.hit.source === 'tv' ? ' is-tv' : ''}`}
                aria-expanded={open}
                aria-label={`${item.no}. ${item.hit.show}, ${formatDate(item.hit.date) ?? 'undated'}. ${open ? 'Close' : 'Open'} clip`}
                onClick={() => openNode(item)}
              />
              <span className="node-label">
                <span className="node-meta"><b>{item.no}</b>{formatDate(item.hit.date) ?? 'undated'}</span>
                <span className="node-name">{item.hit.show}</span>
              </span>
              {open && <div className="node-pop" role="dialog" aria-label={`${item.hit.show} clip`} data-no-pan>{renderPopover(item)}</div>}
            </li>
          );
        })}
      </ol>

      {footer}

      <p className={`tl-empty${items.length ? ' is-gone' : ''}`}>
        Star a clip and it lands here, on the day it was recorded.
      </p>

      <div className="tl-ui">
        <span className="tl-left">
          <span className="tl-title">Timeline{count > 0 && <em>{count} clip{count === 1 ? '' : 's'}</em>}</span>
          {onStory && (
            <button type="button" className={`tl-story${storyOpen ? ' is-on' : ''}`} onClick={onStory} data-no-pan aria-pressed={storyOpen} title="Play the pinned clips one after another (p)">
              <Play size={11} />{storyOpen ? 'Story' : 'Play story'}
            </button>
          )}
        </span>
        <span className="tl-controls" data-no-pan>
          <button type="button" className="tl-btn" onClick={() => engine.current?.zoomBy(1 / 1.7)} aria-label="Zoom out" title="Zoom out"><Minus /></button>
          <button type="button" className="tl-btn" onClick={() => engine.current?.zoomBy(1.7)} aria-label="Zoom in" title="Zoom in"><Plus /></button>
          <button type="button" className="tl-btn" onClick={() => void engine.current?.fit(times())} aria-label="Fit all clips" title="Fit all clips (f)"><Fit /></button>
          <button type="button" className="tl-btn" onClick={onToggleTall} aria-label={tall ? 'Shrink timeline' : 'Enlarge timeline'} aria-pressed={tall} title="Enlarge timeline (t)"><Expand up={!tall} /></button>
        </span>
      </div>
    </section>
  );
}
