import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { api } from '../api.ts';
import type { BoardConfig } from '../api.ts';
import { AgentChip } from './bits.tsx';
import { RunTab } from './drawer/RunTab.tsx';
import { PlanTab } from './drawer/PlanTab.tsx';
import { HistoryTab } from './drawer/HistoryTab.tsx';
import { SetupTab } from './drawer/SetupTab.tsx';
import type { DrawerTab, TabProps } from './drawer/types.ts';
import type { TaskWithDerived } from '../../shared/types.ts';
import type { Note } from '../../shared/notes.ts';
import type { NotesController } from '../use-notes.ts';
import { noteCounts } from '../notes-model.ts';
import { NotesTab } from './drawer/NotesTab.tsx';

interface Props {
  task: TaskWithDerived;
  config: BoardConfig;
  onClose: () => void;
  onChanged: () => void;
  initialTab?: DrawerTab;
  notes: NotesController;
  onNewNote: (issue: number) => void;
  onEditNote: (note: Note) => void;
  onOpenTaskNotes: (issue: number) => void;
  onViewTaskNotes: (issue: number) => void;
  revealedNote: Note | null;
}

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'run', label: 'Run' },
  { id: 'plan', label: 'Plan' },
  { id: 'notes', label: 'Notes' },
  { id: 'history', label: 'History' },
  { id: 'setup', label: 'Setup' },
];

const WIDTH_KEY = 'mc-drawer-width';
const MIN_W = 420;
const DEFAULT_W = 620;

function clampWidth(px: number): number {
  return Math.max(MIN_W, Math.min(px, Math.min(1100, window.innerWidth * 0.9)));
}

/**
 * Everything about one task, and every action on it.
 *
 * The header is permanent — status must never be a tab away — and the body
 * switches. Tabs reset to Run on every task switch: the drawer's job on open
 * is "launch something", and remembering you were last on History is not a
 * service.
 */
export function Drawer({ task, config, onClose, onChanged, initialTab = 'run', notes, onNewNote, onEditNote, onOpenTaskNotes, onViewTaskNotes, revealedNote }: Props) {
  const [tab, setTab] = useState<DrawerTab>(initialTab);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : DEFAULT_W;
  });

  // Drag from the left edge. Listeners live on window so the pointer can leave
  // the 6px handle mid-drag without the resize sticking.
  const startDrag = useCallback((down: ReactPointerEvent) => {
    down.preventDefault();
    const move = (e: PointerEvent) => setWidth(clampWidth(window.innerWidth - e.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  useEffect(() => {
    setTab(initialTab);
    setError(null);
    closeRef.current?.focus();
  }, [task.issue, initialTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // An overlay (document workbench, prompt preview, full-window compose)
      // owns Escape while it is up.
      if (document.querySelector('.plan-editor-scrim, .doc-scrim, .notes-editor-scrim')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = useCallback<TabProps['run']>(
    async (label, action) => {
      setBusy(label);
      setError(null);
      try {
        await action();
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  const issueUrl = `https://github.com/${config.repo.owner}/${config.repo.name}/issues/${task.issue}`;
  const tabProps: TabProps = { task, config, busy, run, onClose, onChanged };

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close details" />
      <aside
        className="drawer"
        role="dialog"
        aria-label={`Issue ${task.issue}`}
        style={{ width }}
      >
        <div
          className="drawer-grip"
          onPointerDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
        />
        <header className="drawer-head">
          <div className="drawer-eyebrow">
            <span>#{task.issue}</span>
            <a className="link" href={issueUrl} target="_blank" rel="noreferrer">
              issue
            </a>
            {task.prUrl && (
              <a className="link" href={task.prUrl} target="_blank" rel="noreferrer">
                PR #{task.prNumber}
              </a>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
              <button
                className="btn is-sm is-ghost"
                disabled={busy !== null}
                onClick={() => run('open-code', () => api.openCode(task.issue))}
              >
                {busy === 'open-code' ? 'Opening…' : '✎ VS Code'}
              </button>
              <button ref={closeRef} className="btn is-sm is-ghost" onClick={onClose}>
                Close
              </button>
            </span>
          </div>
          <h2 className="drawer-title">{task.title}</h2>
          <div className="drawer-branch">{task.branch}</div>
          <div className="badges" style={{ marginTop: 9 }}>
            {task.pinned.agent && (
              <AgentChip
                agent={task.pinned.agent}
                model={task.pinned.model}
                effort={task.pinned.effort}
              />
            )}
            {task.overrides?.instructions && (
              <span className="badge" title="This task has kept instructions">
                📌 kept
              </span>
            )}
            {task.derived.badges.length === 0 && !task.pinned.agent ? (
              <span className="badge">not started</span>
            ) : (
              task.derived.badges.map((b) => (
                <span key={`${b.kind}-${b.label}`} className={`badge tone-${b.tone}`}>
                  {b.label}
                </span>
              ))
            )}
          </div>
          {task.derived.needsYouReason && (
            <p className="card-status status-attention" style={{ marginTop: 10, marginBottom: 0 }}>
              {task.derived.needsYouReason}
            </p>
          )}
        </header>

        <nav className="drawer-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`drawer-tab${tab === t.id ? ' is-on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'notes' && <span className="drawer-tab-n">{noteCounts(notes.notes).tasks[task.issue] ?? 0}</span>}
              {t.id === 'history' && task.spawnHistory.length > 0 && (
                <span className="drawer-tab-n">{task.spawnHistory.length}</span>
              )}
            </button>
          ))}
        </nav>

        {error && (
          <div className="section">
            <p className="error">{error}</p>
          </div>
        )}

        <div className="drawer-body">
          {tab === 'run' && <RunTab {...tabProps} />}
          {tab === 'plan' && <PlanTab {...tabProps} />}
          {tab === 'notes' && <NotesTab key={task.issue} issue={task.issue} controller={notes} repoUrl={`https://github.com/${config.repo.owner}/${config.repo.name}`} onNew={onNewNote} onEdit={onEditNote} onOpenTask={onOpenTaskNotes} onViewAll={onViewTaskNotes} revealed={revealedNote} />}
          {tab === 'history' && <HistoryTab {...tabProps} />}
          {tab === 'setup' && <SetupTab {...tabProps} />}
        </div>
      </aside>
    </>
  );
}
