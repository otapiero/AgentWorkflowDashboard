import { useEffect, useRef, useState } from 'react';

import { IconCheck, IconContrast } from './bits.tsx';
import { THEMES } from '../theme.ts';
import type { ThemeChoice } from '../theme.ts';

export function ThemePicker({ choice, onChoose: choose }: { choice: ThemeChoice; onChoose: (choice: ThemeChoice) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="theme-picker" ref={root}>
      <button
        type="button"
        className="btn is-sm is-icon is-ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Theme"
        onClick={() => setOpen((v) => !v)}
      >
        <IconContrast />
      </button>
      {open && (
        <div className="theme-menu" role="menu" aria-label="Theme">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="menuitemradio"
              aria-checked={choice === theme.id}
              className="theme-option"
              onClick={() => {
                choose(theme.id);
                setOpen(false);
              }}
            >
              <span className="theme-swatch" aria-hidden>
                {theme.swatch.map((color) => (
                  <i key={color} style={{ background: color }} />
                ))}
              </span>
              {theme.label}
              {choice === theme.id ? <IconCheck className="icon theme-check" /> : <small>{theme.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
