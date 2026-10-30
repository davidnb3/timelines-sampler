import { useCallback, useLayoutEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'telly.theme';

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** The room is dark by default; "lights on" (light theme) is remembered once chosen. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? 'dark');

  // A layout effect, so the attribute is set before children's effects read the theme's CSS variables
  // (the timeline canvas does, to pick its colours).
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Storage can be blocked; the theme still switches for this visit.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
