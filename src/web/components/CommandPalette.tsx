import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { IconNote, IconSearch } from './bits.tsx';

export interface PaletteItem {
  id: string;
  group: 'Tasks' | 'Notes' | 'Actions';
  label: string;
  /** Extra text that matches the search but is shown dimmed, e.g. "#3131" or a phase. */
  hint?: string;
  icon?: ReactNode;
  run: () => void;
}

interface Props {
  items: PaletteItem[];
  onClose: () => void;
}

const GROUPS: PaletteItem['group'][] = ['Actions', 'Tasks', 'Notes'];
const LIMIT_PER_GROUP = 8;

/** Ctrl+K: jump to any task or note, or run an action, from the keyboard. */
export function CommandPalette({ items, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  const groups = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = (item: PaletteItem) => {
      const text = `${item.label} ${item.hint ?? ''}`.toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    };
    // With no query, lead with actions and tasks; notes join once you type.
    return GROUPS.map((group) => ({
      group,
      items: items
        .filter((item) => item.group === group && (words.length > 0 || group !== 'Notes') && matches(item))
        .slice(0, LIMIT_PER_GROUP),
    })).filter((g) => g.items.length > 0);
  }, [items, query]);

  const flat = groups.flatMap((g) => g.items);
  const current = Math.min(active, Math.max(0, flat.length - 1));

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  function run(item: PaletteItem | undefined) {
    if (!item) return;
    onClose();
    item.run();
  }

  return (
    <div className="palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <IconSearch />
          <input
            ref={input}
            value={query}
            placeholder="Jump to a task or note, or type a command"
            aria-label="Search tasks, notes and commands"
            aria-controls="palette-list"
            aria-activedescendant={flat[current] ? `palette-${flat[current].id}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((current + 1) % Math.max(1, flat.length));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((current - 1 + flat.length) % Math.max(1, flat.length));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(flat[current]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {flat.length === 0 && <p className="palette-empty">Nothing matches “{query}”.</p>}
          {groups.map(({ group, items: groupItems }) => (
            <div key={group} role="group" aria-label={group}>
              <div className="palette-group">{group}</div>
              {groupItems.map((item) => {
                const selected = flat[current]?.id === item.id;
                return (
                  <div
                    key={item.id}
                    id={`palette-${item.id}`}
                    role="option"
                    aria-selected={selected}
                    className="palette-item"
                    onPointerMove={() => setActive(flat.indexOf(item))}
                    onClick={() => run(item)}
                  >
                    <span className="palette-icon">{item.icon ?? <IconNote />}</span>
                    <span className="palette-label" dir="auto">
                      {item.label}
                    </span>
                    {item.hint && <span className="palette-hint">{item.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
        </div>
      </div>
    </div>
  );
}
