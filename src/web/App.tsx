import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, subscribe } from './api.ts';
import type { BoardConfig, OpenIssue } from './api.ts';
import { Board } from './components/Board.tsx';
import { Drawer } from './components/Drawer.tsx';
import { Settings } from './components/Settings.tsx';
import { BrandMark } from './components/bits.tsx';
import type { TaskWithDerived } from '../shared/types.ts';

export function App() {
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [tasks, setTasks] = useState<TaskWithDerived[]>([]);
  const [connected, setConnected] = useState(false);
  const [onlyNeedsYou, setOnlyNeedsYou] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [issues, setIssues] = useState<OpenIssue[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [settingsPhase, setSettingsPhase] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(() => {
    api.config().then(setConfig).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => loadConfig(), [loadConfig]);

  // The board never polls; it renders whatever the last push contained.
  useEffect(() => subscribe(setTasks, setConnected), []);

  const refresh = useCallback(() => {
    api.reconcile().then(setTasks).catch((e: Error) => setError(e.message));
    api.config().then(setConfig).catch(() => {});
  }, []);

  const needsYouCount = useMemo(
    () => tasks.filter((t) => t.derived.needsYou).length,
    [tasks],
  );

  const visible = onlyNeedsYou ? tasks.filter((t) => t.derived.needsYou) : tasks;
  const selectedTask = tasks.find((t) => t.issue === selected) ?? null;

  async function openImport() {
    setImporting(true);
    setIssues(null);
    setError(null);
    try {
      setIssues(await api.issues());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function addIssue(issue: number) {
    try {
      setTasks(await api.import(issue));
      setImporting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Mission Control</span>
          <span className="brand-repo">
            {config.repo.owner}/{config.repo.name}
          </span>
        </div>

        <span className="topbar-spacer" />

        <div className="topbar-actions">
          <button
            className={`btn is-sm${onlyNeedsYou ? ' is-on' : ''}`}
            onClick={() => setOnlyNeedsYou((v) => !v)}
            aria-pressed={onlyNeedsYou}
          >
            Needs you{needsYouCount > 0 ? ` · ${needsYouCount}` : ''}
          </button>
          <button className="btn is-sm is-primary" onClick={openImport}>
            + New from issue
          </button>
          <button
            className="btn is-sm"
            onClick={() => {
              setSettingsPhase(null);
              setSettingsOpen(true);
            }}
          >
            Agents
          </button>
          <button className="btn is-sm is-ghost" onClick={refresh}>
            Refresh
          </button>
          <span className={`lamp ${connected ? 'is-on' : 'is-off'}`}>
            {connected ? 'live' : 'offline'}
          </span>
        </div>
      </header>

      {error && (
        <div style={{ padding: '10px 18px' }}>
          <p className="error">{error}</p>
        </div>
      )}

      <Board
        config={config}
        tasks={visible}
        selectedIssue={selected}
        onOpen={setSelected}
        onEditDefault={editDefault}
      />

      {importing && (
        <>
          <button className="scrim" onClick={() => setImporting(false)} aria-label="Cancel" />
          <aside className="drawer" role="dialog" aria-label="Add a task">
            <header className="drawer-head">
              <div className="drawer-eyebrow">
                <span>Add task</span>
                <span style={{ marginLeft: 'auto' }}>
                  <button className="btn is-sm is-ghost" onClick={() => setImporting(false)}>
                    Close
                  </button>
                </span>
              </div>
              <h2 className="drawer-title">Open issues</h2>
            </header>
            <section className="section stack">
              {issues === null && <p className="note">Reading issues from GitHub…</p>}
              {issues?.length === 0 && <p className="note">No open issues found.</p>}
              {issues?.map((issue) => (
                <button
                  key={issue.number}
                  className="card"
                  disabled={onBoard.has(issue.number)}
                  onClick={() => void addIssue(issue.number)}
                >
                  <div className="card-issue">
                    #{issue.number}
                    {onBoard.has(issue.number) ? ' · already on board' : ''}
                  </div>
                  <div className="card-title" style={{ marginBottom: 0 }}>
                    {issue.title}
                  </div>
                </button>
              ))}
            </section>
          </aside>
        </>
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
        />
      )}
    </div>
  );
}
