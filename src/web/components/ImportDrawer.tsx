import { useEffect, useState } from 'react';

import { api } from '../api.ts';
import type { IssueScope, OpenIssue } from '../api.ts';
import type { TaskWithDerived } from '../../shared/types.ts';

interface Props {
  onBoard: Set<number>;
  onImported: (tasks: TaskWithDerived[]) => void;
  onClose: () => void;
}

/**
 * Pick a GitHub issue to put on the board.
 *
 * Defaults to the current user's issues, since that is almost always what you
 * want and keeps the list short; a toggle widens it to every open issue. The
 * search box filters by number, title or assignee, and a bare number that
 * isn't in the list can be added directly — so you are never blocked from
 * importing an issue the filter happens to hide.
 */
export function ImportDrawer({ onBoard, onImported, onClose }: Props) {
  const [scope, setScope] = useState<IssueScope>('mine');
  const [query, setQuery] = useState('');
  const [issues, setIssues] = useState<OpenIssue[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setIssues(null);
    setError(null);
    api
      .issues(scope)
      .then((list) => live && setIssues(list))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [scope]);

  async function add(issue: number) {
    setBusy(issue);
    setError(null);
    try {
      onImported(await api.import(issue));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = (issues ?? []).filter(
    (i) =>
      q === '' ||
      String(i.number).includes(q) ||
      i.title.toLowerCase().includes(q) ||
      i.assignees.some((a) => a.toLowerCase().includes(q)),
  );

  const typedNumber = /^\d+$/.test(query.trim()) ? Number(query.trim()) : null;
  const canAddDirect =
    typedNumber !== null &&
    !onBoard.has(typedNumber) &&
    !filtered.some((i) => i.number === typedNumber);

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Cancel" />
      <aside className="drawer" role="dialog" aria-label="Add a task">
        <header className="drawer-head">
          <div className="drawer-eyebrow">
            <span>Add task</span>
            <span style={{ marginLeft: 'auto' }}>
              <button className="btn is-sm is-ghost" onClick={onClose}>
                Close
              </button>
            </span>
          </div>
          <h2 className="drawer-title">Add from issue</h2>
        </header>

        <section className="section">
          <div className="stack">
            <input
              className="field"
              autoFocus
              placeholder="Search by number, title or assignee…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="actions">
              <button
                className={`btn is-sm${scope === 'mine' ? ' is-on' : ''}`}
                onClick={() => setScope('mine')}
              >
                Assigned to me
              </button>
              <button
                className={`btn is-sm${scope === 'all' ? ' is-on' : ''}`}
                onClick={() => setScope('all')}
              >
                All open
              </button>
            </div>
          </div>
        </section>

        {error && (
          <div className="section">
            <p className="error">{error}</p>
          </div>
        )}

        <section className="section stack">
          {canAddDirect && (
            <button className="issue-row" onClick={() => void add(typedNumber)}>
              <div className="card-issue">Add directly</div>
              <div className="card-title">
                Import #{typedNumber}
              </div>
            </button>
          )}

          {issues === null && <p className="note">Reading issues from GitHub…</p>}

          {issues !== null && filtered.length === 0 && !canAddDirect && (
            <p className="note">
              {scope === 'mine'
                ? 'No issues assigned to you match. Try “All open”.'
                : 'No open issues match your search.'}
            </p>
          )}

          {filtered.map((issue) => {
            const already = onBoard.has(issue.number);
            return (
              <button
                key={issue.number}
                className="issue-row"
                disabled={already || busy !== null}
                onClick={() => void add(issue.number)}
              >
                <div className="card-issue">
                  #{issue.number}
                  {already ? ' · already on board' : ''}
                  {issue.assignees.length > 0 && !already
                    ? ` · ${issue.assignees.join(', ')}`
                    : ''}
                </div>
                <div className="card-title">
                  {busy === issue.number ? 'Adding…' : issue.title}
                </div>
              </button>
            );
          })}
        </section>
      </aside>
    </>
  );
}
