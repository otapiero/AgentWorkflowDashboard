import { useCallback, useEffect, useRef, useState } from 'react';

import { api, subscribe } from './api.ts';
import type { BoardConfig, PollMeta } from './api.ts';
import { needsYouIssues, newlyNeedsYou } from './notify.ts';
import { AttentionRail } from './components/AttentionRail.tsx';
import { Board } from './components/Board.tsx';
import { Drawer } from './components/Drawer.tsx';
import { ImportDrawer } from './components/ImportDrawer.tsx';
import { Settings } from './components/Settings.tsx';
import { BrandMark } from './components/bits.tsx';
import type { TaskWithDerived } from '../shared/types.ts';

/** Compact "Ns ago" / "Nm ago" for the last-checked heartbeat. */
function ago(from: string, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - Date.parse(from)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function App() {
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [tasks, setTasks] = useState<TaskWithDerived[]>([]);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
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
    () => subscribe({ onTasks: handleTasks, onPoll: setPollMeta, onStatus: setConnected }),
    [handleTasks],
  );

  // A local clock so "checked Ns ago" advances between pushes.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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
          <button className="btn is-sm is-primary" onClick={() => setImporting(true)}>
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
          <button
            className={`btn is-sm is-icon${notifyOn ? ' is-on' : ''}`}
            onClick={() => void toggleNotify()}
            aria-pressed={notifyOn}
            title={
              notifyOn
                ? 'Desktop notifications on'
                : 'Notify me when a card needs me'
            }
          >
            {notifyOn ? '🔔' : '🔕'}
          </button>
          {pollMeta && (
            <button
              className="poll-status"
              onClick={refresh}
              title="Click to re-check GitHub now"
            >
              <span className="poll-checked">checked {ago(pollMeta.checkedAt, now)}</span>
              {pollMeta.rateLimit && (
                <span
                  className={`poll-budget${
                    pollMeta.rateLimit.remaining < 500 ? ' is-low' : ''
                  }`}
                  title={`GitHub GraphQL API: ${pollMeta.rateLimit.remaining} of ${pollMeta.rateLimit.limit} calls left this hour`}
                >
                  {pollMeta.rateLimit.remaining.toLocaleString()} API
                </span>
              )}
            </button>
          )}
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

      <AttentionRail
        tasks={visible}
        config={config}
        selectedIssue={selected}
        onOpen={setSelected}
      />

      <Board
        config={config}
        tasks={visible}
        selectedIssue={selected}
        onOpen={setSelected}
        onEditDefault={editDefault}
      />

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
        />
      )}
    </div>
  );
}
