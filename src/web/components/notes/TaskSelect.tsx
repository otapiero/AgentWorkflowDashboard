import { useEffect, useId, useRef, useState } from 'react';
import type { NoteTask } from '../../../shared/notes.ts';

interface Props {
  tasks: (NoteTask & { retained?: boolean })[];
  value: number | null;
  onChange: (issue: number | null) => void;
  label: string;
  nullLabel?: string;
  disabled?: boolean;
}
export function TaskSelect({ tasks, value, onChange, label, nullLabel = 'General, no task', disabled }: Props) {
  const [query, setQuery] = useState('');
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (disabled && details.current) details.current.open = false; }, [disabled]);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false; };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  const searchId = useId();
  const selected = tasks.find(t => t.issue === value);
  const matches = tasks.filter(task => `#${task.issue} ${task.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function choose(issue: number | null) { if (disabled) return; onChange(issue); setQuery(''); if (details.current) { details.current.open = false; details.current.querySelector('summary')?.focus(); } }
  return <details className={`notes-task-select${disabled ? ' is-disabled' : ''}`} ref={details} onKeyDown={event => {
    if (event.key === 'Escape' && details.current?.open) { event.preventDefault(); event.stopPropagation(); details.current.open = false; details.current.querySelector('summary')?.focus(); }
  }}>
    <summary aria-label={`${label}: ${value === null ? nullLabel : `#${value} ${selected?.title ?? ''}`}`} onClick={event => { if (disabled) event.preventDefault(); }} aria-disabled={disabled}>
      <span>{value === null ? nullLabel : <><span className="notes-issue">#{value}</span> {selected?.title ?? 'No longer on board'}</>}</span><span aria-hidden="true">⌄</span>
    </summary>
    <div className="notes-task-options">
      <label className="notes-field-label" htmlFor={searchId}>{label}</label>
      <input id={searchId} type="search" placeholder="Search number or title" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} autoComplete="off" />
      <div className="notes-task-results">
        <button type="button" aria-pressed={value === null} onClick={() => choose(null)}>{nullLabel}</button>
        {matches.map(task => <button type="button" key={task.issue} aria-pressed={value === task.issue} onClick={() => choose(task.issue)}><span className="notes-issue">#{task.issue}</span> <span dir="auto">{task.title}</span>{task.retained && <small>No longer on board</small>}</button>)}
        {!matches.length && <p className="notes-hint">No matching tasks.</p>}
      </div>
    </div>
  </details>;
}
