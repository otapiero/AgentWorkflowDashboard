import { useEffect, useState } from 'react';
import type { PollMeta } from '../api.ts';

function ago(from: string, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - Date.parse(from)) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
}

/** Only this indicator needs a seconds clock; the rest of the app stays idle. */
export function ConnectionStatus({ connected, pollMeta, onRefresh }: {
  connected: boolean; pollMeta: PollMeta | null; onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <button type="button" className="conn-status" onClick={onRefresh}
      title={pollMeta?.rateLimit
        ? `${connected ? 'Live' : 'Offline'}. Last checked GitHub ${ago(pollMeta.checkedAt, now)} ago; ${pollMeta.rateLimit.remaining} of ${pollMeta.rateLimit.limit} API calls left this hour. Click to re-check now.`
        : `${connected ? 'Live' : 'Offline'}. Click to re-check GitHub now.`}>
      <span className={`conn-dot${connected ? ' is-on' : ' is-off'}`} />
      {pollMeta ? <>
        <span>{ago(pollMeta.checkedAt, now)}</span>
        {pollMeta.rateLimit && <span className={pollMeta.rateLimit.remaining < 500 ? 'is-low' : undefined}>
          · {pollMeta.rateLimit.remaining.toLocaleString()} API
        </span>}
      </> : <span>{connected ? 'live' : 'offline'}</span>}
    </button>
  );
}
