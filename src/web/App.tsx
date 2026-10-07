import { useCallback, useEffect, useRef, useState } from 'react';

import { api, subscribe } from './api.ts';
import type { BoardConfig, PollMeta } from './api.ts';
import { needsYouIssues, newlyNeedsYou } from './notify.ts';
import { AttentionRail } from './components/AttentionRail.tsx';
import { Board, boardLanes } from './components/Board.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import type { PaletteItem } from './components/CommandPalette.tsx';
import { Drawer } from './components/Drawer.tsx';
import { ImportDrawer } from './components/ImportDrawer.tsx';
import { DoneList } from './components/Lane.tsx';
import { Settings } from './components/Settings.tsx';
import { ReviewRequests } from './components/ReviewRequests.tsx';
import {
  BrandMark,
  IconBell,
  IconBellOff,
  IconContrast,
  IconNote,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconTask,
} from './components/bits.tsx';
import { ThemePicker } from './components/ThemePicker.tsx';
import type { TaskWithDerived } from '../shared/types.ts';
import type { Note } from '../shared/notes.ts';
import { useNotes } from './use-notes.ts';
import { noteCounts, notesProjectId } from './notes-model.ts';
import type { NotesScope } from './notes-model.ts';
import { NotesPanel } from './components/notes/NotesPanel.tsx';
import { NoteEditor } from './components/notes/NoteEditor.tsx';
import type { DrawerTab } from './components/drawer/types.ts';
import { THEMES, useTheme } from './theme.ts';

/** Compact "Ns" / "Nm" for the last-checked heartbeat. */
function ago(from: string, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - Date.parse(from)) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'on';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    // Storage may be disabled; the choice still holds for this session.
  }
}

/** True when a keystroke belongs to a text field rather than to the app. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function noteHeading(note: Note): string {
  return note.title?.trim() || note.body.split(/\r?\n/).find((line) => line.trim()) || 'Untitled note';
}

export function App() {
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [tasks, setTasks] = useState<TaskWithDerived[]>([]);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<'board' | 'done'>('board');
  const [notesOpen, setNotesOpenState] = useState(() => readFlag('mc-notes-panel', true));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [reviewsRefresh, setReviewsRefresh] = useState(0);
  const [initialTab, setInitialTab] = useState<DrawerTab>('run');
  const [notesScope, setNotesScope] = useState<NotesScope>({ kind: 'all' });
  const [notesQuery, setNotesQuery] = useState('');
  const [editor, setEditor] = useState<{ note: Note | null; taskIssue: number | null } | null>(null);
  const [revealedNote, setRevealedNote] = useState<Note | null>(null);
  const theme = useTheme();
  const projectId = config ? notesProjectId(config.repo.owner, config.repo.name) : '';
  const notes = useNotes(projectId);
  const setNotesOpen = (open: boolean) => { setNotesOpenState(open); writeFlag('mc-notes-panel', open); };
  const openTask = (issue: number) => { setInitialTab('run'); setSelected(issue); };
  const openTaskNotes = (issue: number) => { setInitialTab('notes'); setSelected(issue); };
  const newNote = (taskIssue: number | null) => setEditor({ note: null, taskIssue });
  const editNote = (note: Note) => setEditor({ note, taskIssue: note.taskIssue });
  /** Show the panel scoped to one task, e.g. from the drawer's "View in all notes". */
  const viewTaskNotes = (issue: number) => { setSelected(null); setNotesOpen(true); setNotesScope({ kind: 'task', issue }); setNotesQuery(''); };
  /** Bring one note into view in the panel. */
  const revealNote = (note: Note) => { setNotesOpen(true); setNotesScope({ kind: 'all' }); setNotesQuery(''); setRevealedNote(note); };
  function savedNote(note: Note) {
    setEditor(null); setRevealedNote(note); setNotesQuery('');
    setNotesScope(note.taskIssue === null ? { kind: 'general' } : { kind: 'task', issue: note.taskIssue });
    // Saved from a task's own Notes tab: it is already in view there.
    if (selected !== note.taskIssue || selected === null) { setSelected(null); setNotesOpen(true); }
  }
  const [importing, setImporting] = useState(false);
  const [settingsPhase, setSettingsPhase] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollMeta, setPollMeta] = useState<PollMeta | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [notifyOn, setNotifyOn] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('mc-notify') === 'on',
  );

  const notifyOnRef = useRef(notifyOn);
  const prevNeedsYou = useRef<Set<number>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    notifyOnRef.current = notifyOn;
  }, [notifyOn]);

  const loadConfig = useCallback(() => {
    api.config().then(setConfig).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => loadConfig(), [loadConfig]);

  // Every board push: render it, then fire a desktop notification for any card
  // that just flipped into needs-you. The first push only sets the baseline.
  const handleTasks = useCallback((next: TaskWithDerived[]) => {
    setTasks(next);
    const current = needsYouIssues(next);
    if (!initialized.current) {
      initialized.current = true;
      prevNeedsYou.current = current;
      return;
    }
    const fired = newlyNeedsYou(prevNeedsYou.current, next);
    prevNeedsYou.current = current;
    if (
      notifyOnRef.current &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      for (const item of fired) {
        new Notification(`#${item.issue} needs you`, { body: item.reason });
      }
    }
  }, []);

  // The board never polls; it renders whatever the last push contained. `poll`
  // is the every-cycle heartbeat carrying freshness and the API budget.
  useEffect(
    () => subscribe({ onTasks: handleTasks, onPoll: setPollMeta, onStatus: online => { setConnected(online); notes.onConnection(online); }, onOpen: notes.onOpen, onNotes: notes.onNotes, onNotesStatus: notes.onNotesStatus }),
    [handleTasks, notes.onConnection, notes.onOpen, notes.onNotes, notes.onNotesStatus],
  );
  useEffect(() => { void notes.refreshTasks(); }, [tasks, notes.refreshTasks]);

  // A local clock so "checked Ns ago" advances between pushes.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Ctrl+K opens the palette from anywhere; N starts a note when no field or
  // dialog has the keyboard.
  const overlayOpen = Boolean(editor || importing || settingsOpen || paletteOpen || reviewsOpen);
  useEffect(() => {
    if (editor || importing || settingsOpen || paletteOpen || selected !== null) setReviewsOpen(false);
  }, [editor, importing, settingsOpen, paletteOpen, selected]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !overlayOpen && !isTyping(e.target)) {
        e.preventDefault();
        setEditor({ note: null, taskIssue: selected });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlayOpen, selected]);

  const toggleNotify = useCallback(async () => {
    if (notifyOn) {
      setNotifyOn(false);
      localStorage.setItem('mc-notify', 'off');
      return;
    }
    if (typeof Notification === 'undefined') return;
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') return; // denied: leave it off
    setNotifyOn(true);
    localStorage.setItem('mc-notify', 'on');
  }, [notifyOn]);

  const refresh = useCallback(() => {
    setReviewsRefresh(value => value + 1);
    api.reconcile().then(setTasks).catch((e: Error) => setError(e.message));
    api.config().then(setConfig).catch(() => {});
  }, []);

  // Kept rather than inlined as `tasks`: Board and the rail both read it, and
  // it stays the seam if filtering ever returns.
  const visible = tasks;
  const selectedTask = tasks.find((t) => t.issue === selected) ?? null;

  function editDefault(phaseId: string) {
    setSettingsPhase(phaseId);
    setSettingsOpen(true);
  }

  if (!config) {
    return (
      <div className="app">
        <div className="topbar">
          <div className="brand">
            <BrandMark />
            <span className="brand-name">Mission Control</span>
          </div>
        </div>
        <div style={{ padding: 24 }}>
          {error ? <p className="error">{error}</p> : <p className="note">Loading…</p>}
        </div>
      </div>
    );
  }

  const onBoard = new Set(tasks.map((t) => t.issue));
  const counts = noteCounts(notes.notes);
  const doneTasks = tasks.filter((t) => t.derived.displayPhase === 'done');
  const phaseLabel = new Map(boardLanes(config).map((p) => [p.id, p.label]));
  const repoUrl = `https://github.com/${config.repo.owner}/${config.repo.name}`;

  const paletteItems: PaletteItem[] = [
    { id: 'a-import', group: 'Actions', label: 'New task from issue', icon: <IconPlus />, run: () => setImporting(true) },
    { id: 'a-note', group: 'Actions', label: 'New note', hint: 'N', icon: <IconNote />, run: () => newNote(selected) },
    { id: 'a-notes', group: 'Actions', label: notesOpen ? 'Hide notes panel' : 'Show notes panel', icon: <IconSidebar />, run: () => setNotesOpen(!notesOpen) },
    { id: 'a-view', group: 'Actions', label: view === 'board' ? 'Show finished tasks' : 'Show board', icon: <IconTask />, run: () => setView(view === 'board' ? 'done' : 'board') },
    { id: 'a-agents', group: 'Actions', label: 'Agent settings', icon: <IconSettings />, run: () => { setSettingsPhase(null); setSettingsOpen(true); } },
    ...THEMES.map((t): PaletteItem => ({ id: `a-theme-${t.id}`, group: 'Actions', label: `Theme: ${t.label}`, hint: theme.choice === t.id ? 'current' : t.hint, icon: <IconContrast />, run: () => theme.choose(t.id) })),
    ...tasks.map((t): PaletteItem => ({ id: `t-${t.issue}`, group: 'Tasks', label: t.title, hint: `#${t.issue} · ${phaseLabel.get(t.derived.displayPhase) ?? t.derived.displayPhase}`, icon: <IconTask />, run: () => openTask(t.issue) })),
    ...notes.notes.filter((n) => n.status === 'active').map((n): PaletteItem => ({ id: `n-${n.id}`, group: 'Notes', label: noteHeading(n), hint: n.taskIssue === null ? 'General' : `#${n.taskIssue}`, icon: <IconNote />, run: () => revealNote(n) })),
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Mission Control</span>
          <span className="brand-repo" title={`${config.repo.owner}/${config.repo.name}`}>
            / {config.repo.name}
          </span>
        </div>

        <nav className="view-tabs" aria-label="Views">
          <button aria-current={view === 'board' ? 'page' : undefined} onClick={() => setView('board')}>
            Board <span className="count">{tasks.length - doneTasks.length}</span>
          </button>
          <button aria-current={view === 'done' ? 'page' : undefined} onClick={() => setView('done')}>
            Done <span className="count">{doneTasks.length}</span>
          </button>
        </nav>
        <span className="topbar-spacer" />

        <button type="button" className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <IconSearch /> <span>Jump to task or note</span> <kbd>Ctrl K</kbd>
        </button>

        <div className="topbar-actions">
          <ReviewRequests repo={config.repo} open={reviewsOpen} onOpenChange={setReviewsOpen} refreshKey={String(reviewsRefresh)} />
          <button
            type="button"
            className={`btn is-sm${notesOpen ? ' is-on' : ''}`}
            aria-pressed={notesOpen}
            onClick={() => setNotesOpen(!notesOpen)}
            title={notesOpen ? 'Hide notes' : 'Show notes'}
          >
            <IconNote /> Notes <span className="btn-count">{counts.all}</span>
          </button>
          <button
            className="btn is-sm is-ghost"
            onClick={() => {
              setSettingsPhase(null);
              setSettingsOpen(true);
            }}
          >
            Agents
          </button>
          <button
            className={`btn is-sm is-icon is-ghost${notifyOn ? ' is-on' : ''}`}
            onClick={() => void toggleNotify()}
            aria-pressed={notifyOn}
            title={
              notifyOn
                ? 'Desktop notifications on'
                : 'Notify me when a card needs me'
            }
          >
            {notifyOn ? <IconBell /> : <IconBellOff />}
          </button>
          <ThemePicker choice={theme.choice} onChoose={theme.choose} />
          <button className="btn is-sm is-primary" onClick={() => setImporting(true)}>
            <IconPlus /> New from issue
          </button>
          <button
            type="button"
            className="conn-status"
            onClick={refresh}
            title={
              pollMeta?.rateLimit
                ? `${connected ? 'Live' : 'Offline'}. Last checked GitHub ${ago(pollMeta.checkedAt, now)} ago; ${pollMeta.rateLimit.remaining} of ${pollMeta.rateLimit.limit} API calls left this hour. Click to re-check now.`
                : `${connected ? 'Live' : 'Offline'}. Click to re-check GitHub now.`
            }
          >
            <span className={`conn-dot${connected ? ' is-on' : ' is-off'}`} />
            {pollMeta ? (
              <>
                <span>{ago(pollMeta.checkedAt, now)}</span>
                {pollMeta.rateLimit && (
                  <span className={pollMeta.rateLimit.remaining < 500 ? 'is-low' : undefined}>
                    · {pollMeta.rateLimit.remaining.toLocaleString()} API
                  </span>
                )}
              </>
            ) : (
              <span>{connected ? 'live' : 'offline'}</span>
            )}
          </button>
        </div>
      </header>

      {error && (
        <div style={{ padding: '10px 16px' }}>
          <p className="error">{error}</p>
        </div>
      )}

      <div className={`workspace${notesOpen ? ' with-notes' : ''}`}>
        <div className="main-col">
          {view === 'board' ? (
            <Board
              config={config}
              tasks={visible}
              selectedIssue={selected}
              noteCounts={counts.tasks}
              onOpen={openTask}
              onOpenNotes={openTaskNotes}
              onEditDefault={editDefault}
              onShowDone={() => setView('done')}
            >
              <AttentionRail
                tasks={visible}
                notes={notes.notes}
                now={now}
                config={config}
                selectedIssue={selected}
                onOpen={openTask}
                onOpenNote={(note) => (note.taskIssue === null ? revealNote(note) : openTaskNotes(note.taskIssue))}
              />
            </Board>
          ) : (
            <div className="board-scroll">
              <section className="done-view">
                <header className="done-view-head">
                  <h1>Done</h1>
                  <span className="count">{doneTasks.length}</span>
                  <p>Finished tasks. Open one to see its history.</p>
                </header>
                {doneTasks.length ? (
                  <DoneList tasks={doneTasks} selectedIssue={selected} onOpen={openTask} />
                ) : (
                  <p className="board-empty">Nothing finished yet.</p>
                )}
              </section>
            </div>
          )}
        </div>

        {notesOpen && (
          <NotesPanel
            controller={notes}
            scope={notesScope}
            onScope={scope => { setNotesScope(scope); setRevealedNote(null); }}
            query={notesQuery}
            onQuery={query => { setNotesQuery(query); setRevealedNote(null); }}
            repoUrl={repoUrl}
            onNew={newNote}
            onEdit={editNote}
            onOpenTask={openTaskNotes}
            onClose={() => setNotesOpen(false)}
            revealed={revealedNote}
          />
        )}
      </div>

      {importing && (
        <ImportDrawer
          onBoard={onBoard}
          onImported={setTasks}
          onClose={() => setImporting(false)}
        />
      )}

      {settingsOpen && (
        <Settings
          config={config}
          focusPhase={settingsPhase}
          onClose={() => setSettingsOpen(false)}
          onChanged={refresh}
        />
      )}

      {selectedTask && (
        <Drawer
          task={selectedTask}
          config={config}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          initialTab={initialTab}
          notes={notes}
          onNewNote={newNote}
          onEditNote={editNote}
          onOpenTaskNotes={openTaskNotes}
          onViewTaskNotes={viewTaskNotes}
          revealedNote={revealedNote}
        />
      )}
      {editor && <NoteEditor controller={notes} note={editor.note} taskIssue={editor.taskIssue} onClose={() => setEditor(null)} onSaved={savedNote} />}
      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
