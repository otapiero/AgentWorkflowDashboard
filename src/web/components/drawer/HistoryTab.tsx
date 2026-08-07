import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import type { MissionUsage } from '../../api.ts';
import type { TabProps } from './types.ts';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function HistoryTab({ task }: TabProps) {
  const [usage, setUsage] = useState<MissionUsage | null>(null);

  useEffect(() => {
    setUsage(null);
    api.usage(task.issue).then(setUsage).catch(() => setUsage(null));
  }, [task.issue]);

  return (
    <section className="section">
      <div className="section-label">Sessions &amp; usage</div>
      {usage && usage.tracked ? (
        <>
          <div className="usage-total">
            <strong>{fmtTokens(usage.total.total)}</strong> tokens
            <span className="usage-breakdown">
              {' '}· in {fmtTokens(usage.total.input)} · out {fmtTokens(usage.total.output)} ·
              cache {fmtTokens(usage.total.cacheCreate + usage.total.cacheRead)}
            </span>
          </div>
          <div className="history">
            {usage.sessions.map((s) => (
              <div key={`${s.agent}-${s.sessionId}`}>
                {s.startedAt ? new Date(s.startedAt).toLocaleString() : 'session'} ·{' '}
                {s.agent} · {s.models.join(', ') || 'default model'} ·{' '}
                {fmtTokens(s.tokens.total)} tok
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="note">
          {usage
            ? 'No Claude Code or Codex CLI usage was found for this worktree.'
            : 'Loading usage…'}
        </p>
      )}
      {task.spawnHistory.length > 0 && (
        <div className="history" style={{ marginTop: 8 }}>
          {[...task.spawnHistory].reverse().map((s, i) => (
            <div key={`${s.startedAt}-${i}`}>
              spawn: {new Date(s.startedAt).toLocaleString()} · {s.phase} · {s.agent}
              {/*
                A copy button rather than a link: T3 Code is a desktop
                application with no documented URL scheme for opening a thread,
                so a deep link would be a guess.
              */}
              {s.threadId && (
                <>
                  {' · '}
                  <button
                    className="btn is-sm"
                    title="Copy this run's T3 thread id"
                    onClick={() => navigator.clipboard.writeText(s.threadId!)}
                  >
                    T3 thread
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
