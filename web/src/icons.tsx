import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const base = (size: number): P => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
});

export const Play = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.6-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z" fill="currentColor" stroke="none" /></svg>
);

export const Pause = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" /></svg>
);

export const Star = ({ size = 16, filled = false, ...p }: P & { size?: number; filled?: boolean }) => (
  <svg {...base(size)} {...p}>
    <path d="m12 3.2 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6-4.5-4.2 6.1-.8L12 3.2Z" fill={filled ? 'currentColor' : 'none'} />
  </svg>
);

export const Download = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" /></svg>
);

export const Plus = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><path d="M12 5v14M5 12h14" /></svg>
);

export const Minus = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><path d="M5 12h14" /></svg>
);

export const External = ({ size = 13, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><path d="M14 5h5v5M19 5l-8 8M10 6H6.5A1.5 1.5 0 0 0 5 7.5v10A1.5 1.5 0 0 0 6.5 19h10a1.5 1.5 0 0 0 1.5-1.5V14" /></svg>
);

export const Close = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><path d="m6 6 12 12M18 6 6 18" /></svg>
);

export const Chevron = ({ size = 12, ...p }: P & { size?: number }) => (
  <svg {...base(size)} strokeWidth={2.6} {...p}><path d="m6 15 6-6 6 6" /></svg>
);

export const Fit = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /></svg>
);

export const Expand = ({ size = 14, up = false, ...p }: P & { size?: number; up?: boolean }) => (
  <svg {...base(size)} {...p}><path d={up ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
);

export const Sun = ({ size = 15, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" /></svg>
);

export const Moon = ({ size = 15, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>
);

export const Grip = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}>
    <circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const Loop = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg {...base(size)} {...p}><path d="M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4" /></svg>
);
