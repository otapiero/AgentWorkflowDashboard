import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, subscribe } from './api.ts';
import type { BoardConfig, OpenIssue } from './api.ts';
import { Board } from './components/Board.tsx';
import { Drawer } from './components/Drawer.tsx';
import type { TaskWithDerived } from '../shared/types.ts';

export function App() {
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [tasks, setTasks] = useState<TaskWithDerived[]>([]);
  const [connected, setConnected] = useState(false);
  const [onlyNeedsYou, setOnlyNeedsYou] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [issues, setIssues] = useState<OpenIssue[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setConfig).catch((e: Error) => setError(e.message));
  }, []);

  // The board never polls; it renders whatever the last push contained.
  useEffect(() => subscribe(setTasks, setConnected), []);

  const refresh = useCallback(() => {
    api.reconcile().then(setTasks).catch((e: Error) => setError(e.message));
  }, []);

  const needsYouCount = useMemo(
    () => tasks.filter((t) => t.derived.needsYou).length,
    [tasks],
  );

  const visible = onlyNeedsYou ? tasks.filter((t) => t.derived.needsYou) : tasks;
  const selectedTask = tasks.find((t) => t.issue === selected) ?? null;

  async function openImport() {
    setImporting(true);
    setError(null);
    try {
      setIssues(await api.issues());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(false);
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

  if (!config) {
    return (
      <div className="app">
        <div className="statusbar">
          <span className="statusbar-brand">Mission Control</span>
        </div>
        <div style={{ padding: 20 }}>
          {error ? <p className="error">{error}</p> : <p className="note">Loading…</p>}
        </div>
      </div>
    );
  }

  const onBoard = new Set(tasks.map((t) => t.issue));

  return (
    <div className="app">
      <header className="statusbar">
        <span className="statusbar-brand">Mission Control</span>
        <span className="statusbar-repo">
          {config.repo.owner}/{config.repo.name} · {config.repo.baseBranch}
        </span>

        <span className="statusbar-spacer" />

        <div className="statusbar-group">
          <button
            className={`btn${onlyNeedsYou ? ' is-active' : ''}`}
            onClick={() => setOnlyNeedsYou((v) => !v)}
            aria-pressed={onlyNeedsYou}
          >
            Needs you {needsYouCount > 0 ? needsYouCount : ''}
          </button>
          <button className="btn" onClick={openImport}>
            Add task
          </button>
          <button className="btn" onClick={refresh}>
            Refresh
          </button>
          <span className={`lamp ${connected ? 'is-on' : 'is-off'}`}>
            {connected ? 'live' : 'offline'}
          </span>
        </div>
      </header>

      {error && (
        <div style={{ padding: '10px 16px' }}>
          <p className="error">{error}</p>
        </div>
      )}

      <Board
        pipeline={config.pipeline}
        tasks={visible}
        selectedIssue={selected}
        onOpen={setSelected}
      />

      {importing && (
        <>
          <button
            className="drawer-scrim"
            onClick={() => setImporting(false)}
            aria-label="Cancel"
          />
          <aside className="drawer" role="dialog" aria-label="Add a task">
            <header className="drawer-head">
              <div className="drawer-issue">
                <span>Add task</span>
                <span style={{ marginLeft: 'auto' }}>
                  <button className="btn" onClick={() => setImporting(false)}>
                    Close
                  </button>
                </span>
              </div>
              <h2 className="drawer-title">Open issues</h2>
            </header>
            <section className="drawer-section">
              <div className="stack">
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
              </div>
            </section>
          </aside>
        </>
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
