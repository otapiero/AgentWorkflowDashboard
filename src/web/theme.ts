import { useCallback, useEffect, useState } from 'react';

/**
 * The colour theme. "system" follows the OS: graphite when it is dark,
 * daylight when it is light. The resolved name goes on <html data-theme>,
 * which is all styles/theme.css reads. index.html applies the stored choice before
 * first paint so a light-theme user never sees a dark flash.
 */
export type ThemeChoice = 'system' | 'graphite' | 'midnight' | 'daylight';
export type ResolvedTheme = Exclude<ThemeChoice, 'system'>;

const STORAGE_KEY = 'mc-theme';
const CHOICES: ThemeChoice[] = ['system', 'graphite', 'midnight', 'daylight'];

export const THEMES: { id: ThemeChoice; label: string; hint: string; swatch: string[] }[] = [
  { id: 'system', label: 'System', hint: 'Match OS', swatch: ['#0b0b0d', '#f4f4f2', '#8b7cff'] },
  { id: 'graphite', label: 'Graphite', hint: 'Dark', swatch: ['#0b0b0d', '#1b1b20', '#8b7cff'] },
  { id: 'midnight', label: 'Midnight', hint: 'Dark', swatch: ['#0d1117', '#1b2430', '#3d9cff'] },
  { id: 'daylight', label: 'Daylight', hint: 'Light', swatch: ['#f4f4f2', '#ffffff', '#5b4cf0'] },
];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (CHOICES as string[]).includes(value);
}

export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ResolvedTheme {
  if (choice !== 'system') return choice;
  return prefersLight ? 'daylight' : 'graphite';
}

function storedChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isThemeChoice(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

const lightQuery = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(storedChoice);

  useEffect(() => {
    const query = lightQuery();
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(choice, query?.matches ?? false);
    };
    apply();
    if (choice !== 'system' || !query) return;
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [choice]);

  const choose = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage may be disabled; the choice still holds for this session.
    }
  }, []);

  return { choice, choose };
}
