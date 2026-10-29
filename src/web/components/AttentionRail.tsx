import { useEffect, useMemo, useState } from 'react';

import { attentionTasks, type BoardTask } from '../board-model.ts';
import type { BoardConfig } from '../api.ts';
import { noteAgeDays, staleNotes } from '../notes-model.ts';
import { IconAlert, IconChevron, IconClock, IconNote } from './bits.tsx';
import type { Note } from '../../shared/notes.ts';

interface Props {
  tasks: BoardTask[];
  notes: Note[];
  config: BoardConfig;
  selectedIssue: number | null;
  onOpen: (issue: number) => void;
  onOpenNote: (note: Note) => void;
}

/**
 * What needs you, above everything else.
 *
 * The rail's emptiness is the signal: from across the room, no orange means
 * nothing is waiting. That is the whole reason it is permanent rather than a
 * filter you have to remember to click. Notes left unsettled for two days or
 * more wait here too, after the tasks.
 *
 * Collapsed by default to one row of pills: the cards repeat what the lanes
 * below already show, so the full view is opt-in and remembered.
 */
const EXPANDED_KEY = 'mc-rail-expanded';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === 'on';
  } catch {
    return false;
  }
}

export function AttentionRail({ tasks, notes, config, selectedIssue, onOpen, onOpenNote }: Props) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 60_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const needing = useMemo(() => attentionTasks(tasks), [tasks]);
  const stale = useMemo(() => staleNotes(notes, now), [notes, now]);
  const total = needing.length + stale.length;
  const [expanded, setExpandedState] = useState(readExpanded);
  if (total === 0) return null;

  const setExpanded = (next: boolean) => {
    setExpandedState(next);
    try {
      localStorage.setItem(EXPANDED_KEY, next ? 'on' : 'off');
    } catch {
      // Storage may be disabled; the choice still holds for this session.
    }
  };
  const heading = (note: Note) =>
    note.title?.trim() || note.body.split(/\r?\n/).find((line) => line.trim()) || 'Untitled note';

  const label = (id: string) =>
    id === 'inbox' ? 'Inbox' : (config.pipeline.find((p) => p.id === id)?.label ?? id);

  return (
    <section className={`rail${expanded ? ' is-expanded' : ''}`} aria-label={`${total} items need you`}>
      <div className="rail-head">
        <button
          type="button"
          className="rail-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          title={expanded ? 'Collapse to one row' : 'Show as cards'}
        >
          <IconChevron className="icon rail-chevron" />
          Needs you <span className="rail-count">{total}</span>
        </button>
        {!expanded && (
          <div className="rail-pills">
            {needing.map((task) => (
              <button
                key={task.issue}
                type="button"
                className={`rail-pill${task.issue === selectedIssue ? ' is-selected' : ''}`}
                onClick={() => onOpen(task.issue)}
                title={`#${task.issue} ${task.title}: ${task.derived.needsYouReason ?? ''}`}
              >
                <span className="status-dot" />
                <span className="card-issue">#{task.issue}</span>
                <span className="rail-pill-title" dir="auto">{task.title}</span>
              </button>
            ))}
            {stale.map((note) => (
              <button
                key={note.id}
                type="button"
                className="rail-pill is-note"
                onClick={() => onOpenNote(note)}
                title={`Note unsettled for ${noteAgeDays(note, now)} days: ${heading(note)}`}
              >
                <IconNote />
                <span className="rail-pill-title" dir="auto">{heading(note)}</span>
              </button>
            ))}
          </div>
        )}
        {expanded && (
          <span className="rail-caption">
            {stale.length > 0 ? 'Tasks waiting on you, then notes left open 2+ days' : 'Tasks waiting on you'}
          </span>
        )}
      </div>
      {expanded && <div className="rail-row">
        {needing.map((task) => (
          <button
            key={task.issue}
            type="button"
            className={`rail-card${task.issue === selectedIssue ? ' is-selected' : ''}`}
            onClick={() => onOpen(task.issue)}
            aria-label={`Issue ${task.issue}, ${task.title}. ${task.derived.needsYouReason ?? ''}`}
          >
            <div className="rail-top">
              <span className="card-issue">#{task.issue}</span>
              <span>· {label(task.derived.displayPhase)}</span>
            </div>
            <div className="card-title" dir="auto">
              {task.title}
            </div>
            <div className="card-status status-attention">
              <IconAlert /> {task.derived.needsYouReason}
            </div>
          </button>
        ))}
        {stale.map((note) => {
          const days = noteAgeDays(note, now);
          const title = heading(note);
          return (
            <button
              key={note.id}
              type="button"
              className="rail-card is-note"
              onClick={() => onOpenNote(note)}
              aria-label={`Note: ${title}. Unsettled for ${days} days`}
            >
              <div className="rail-top">
                <IconNote />
                {note.taskIssue === null ? (
                  <span>General note</span>
                ) : (
                  <span>
                    Note on <span className="card-issue">#{note.taskIssue}</span>
                  </span>
                )}
              </div>
              <div className="card-title" dir="auto">
                {title}
              </div>
              <div className="card-status">
                <IconClock /> Unsettled for {days} days
              </div>
            </button>
          );
        })}
      </div>}
    </section>
  );
}
