/**
 * Flies a glowing dot (with a short trail) along an arc from `from` to `to`, both in viewport
 * coordinates. Resolves when the dot arrives; it then dissolves into the destination.
 */
export function flyDot(from: DOMRect, to: { x: number; y: number }, ms = 950): Promise<void> {
  const x0 = from.left + from.width / 2;
  const y0 = from.top + from.height / 2;
  // Control point of a quadratic curve: above both ends, so the dot rises and then drops in.
  const cx = (x0 + to.x) / 2 + (to.x - x0) * 0.12;
  const cy = Math.min(y0, to.y) - 110 - Math.abs(to.x - x0) * 0.08;
  const steps = 20;
  const path = Array.from({ length: steps + 1 }, (_, i) => {
    const s = i / steps;
    const u = 1 - s;
    return { s, x: u * u * x0 + 2 * u * s * cx + s * s * to.x, y: u * u * y0 + 2 * u * s * cy + s * s * to.y };
  });

  const make = (size: number, opacity: number, delay: number) => {
    const el = document.createElement('div');
    el.className = 'fly-dot';
    el.style.width = el.style.height = `${size}px`;
    el.style.opacity = String(opacity);
    document.body.append(el);
    const anim = el.animate(
      path.map((p) => ({
        offset: p.s,
        transform: `translate(${p.x - size / 2}px, ${p.y - size / 2}px) scale(${1 - p.s * 0.3})`,
      })),
      { duration: ms, delay, easing: 'cubic-bezier(0.45, 0.05, 0.25, 1)', fill: 'both' },
    );
    return { el, anim, size };
  };

  const lead = make(16, 1, 0);
  const trail = [make(11, 0.55, 45), make(8, 0.3, 90)];
  const end = path[steps]!;

  return lead.anim.finished.then(() => {
    const absorb = lead.el.animate(
      [
        { transform: `translate(${end.x - 8}px, ${end.y - 8}px) scale(0.7)`, opacity: 1 },
        { transform: `translate(${end.x - 8}px, ${end.y - 8}px) scale(2.6)`, opacity: 0 },
      ],
      { duration: 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' },
    );
    void absorb.finished.then(() => lead.el.remove());
    Promise.all(trail.map((t) => t.anim.finished)).then(() => trail.forEach((t) => t.el.remove()), () => undefined);
  });
}
