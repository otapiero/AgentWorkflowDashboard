import { useState } from 'react';
import { api } from '../../api.ts';
import { buildStack, prKey, type TaskStack } from '../../../shared/pr-stack.ts';
import type { TaskWithDerived } from '../../../shared/types.ts';
import type { StackOperation } from '../../../server/stack-routes.ts';

export function StackLayers({ task, baseBranch, repository, onStack }: { task: TaskWithDerived; baseBranch: string; repository: string; onStack: (stack: TaskStack) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stack = task.stack;
  const view = buildStack(stack?.layers ?? [], baseBranch, stack?.discoveryComplete ?? false);
  const selected = stack?.selectedKey ?? null;
  async function change(operation: StackOperation) {
    const previous = stack;
    if (operation.action === 'select' && stack) onStack({ ...stack, selectedKey: operation.key });
    setBusy(true); setError(null);
    try { const updated = await api.stack(task.issue, operation); if (updated.stack) onStack(updated.stack); if ('url' in operation) setUrl(''); }
    catch (e) { if (operation.action === 'select' && previous) onStack(previous); setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <details className="stack-panel" open={view.layers.length > 1 || undefined}>
    <summary>Pull requests{view.layers.length > 0 ? ` (${view.layers.length})` : ''}</summary>
    {stack && !stack.discoveryComplete && <p className="hint">Discovering stack layers. Existing PRs stay visible until discovery finishes.</p>}
    {(view.layers.length > 0 || selected !== null) && <label className="stack-select">
      <input type="radio" name={`layer-${task.issue}`} checked={selected === null} disabled={busy} onChange={() => void change({ action: 'select', key: null })} />Issue worktree
    </label>}
    <ol className="stack-layers" aria-label="PR layers">
      {view.layers.map(p => <li key={prKey(p)} className={selected === prKey(p) ? 'is-selected' : ''}>
        <label className="stack-select">
          <input type="radio" name={`layer-${task.issue}`} checked={selected === prKey(p)} disabled={busy} onChange={() => void change({ action: 'select', key: prKey(p) })} />
          <span><a href={p.url} target="_blank" rel="noreferrer">#{p.number}</a> {p.title}</span>
        </label>
        <div className="stack-meta">{p.headBranch || 'Branch unknown'} → {p.baseBranch || 'Base unknown'}</div>
        <div className="stack-meta">{p.state.toLowerCase()} · {p.available ? `${p.phase === 'merge' && p.warning ? 'waiting for parent' : p.phase.replaceAll('_', ' ')} · CI ${p.checks} · ${p.review.decision.toLowerCase().replaceAll('_', ' ')}` : 'Status pending refresh'}</div>
        {p.warning && <p className="stack-warning">{p.warning}</p>}
        <button className="btn is-sm is-ghost" disabled={busy} onClick={() => void change({ action: 'detach', key: prKey(p) })}>Detach #{p.number}</button>
      </li>)}
    </ol>
    {(stack?.manualNumbers ?? []).filter(n => !view.layers.some(p => p.number === n)).map(n => <p className="hint" key={n}>PR #{n} pending validation. Failed lookups retry every five minutes. <button className="btn is-sm is-ghost" disabled={busy} onClick={() => void change({ action: 'detach', key: prKey({ host: 'github.com', repository, number: n }) })}>Remove pending #{n}</button></p>)}
    {(stack?.companionUrls ?? []).map(u => <div className="stack-companion" key={u}><a href={u} target="_blank" rel="noreferrer">Companion {u.split('/').slice(-4).join('/')}</a><button className="btn is-sm is-ghost" disabled={busy} onClick={() => void change({ action: 'remove-companion', url: u })}>Remove link</button></div>)}
    <form className="stack-attach" onSubmit={e => { e.preventDefault(); void change({ action: 'attach', url }); }}>
      <label>PR URL<input className="field" value={url} onChange={e => setUrl(e.target.value)} type="url" placeholder="https://github.com/acme/widgets/pull/10" required /></label>
      <div className="actions"><button className="btn is-sm" disabled={busy || !url.trim()}>Attach PR</button><button type="button" className="btn is-sm is-ghost" disabled={busy || !url.trim()} onClick={() => void change({ action: 'add-companion', url })}>Add companion link</button></div>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </details>;
}
