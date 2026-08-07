import { describe, expect, test } from 'vitest';

import { latestThreadId, toT3Fact } from '../src/orchestrator/t3/facts.ts';
import type { T3Snapshot } from '../src/orchestrator/t3/schemas.ts';
import type { TaskRecord } from '../src/shared/types.ts';

function task(spawnHistory: TaskRecord['spawnHistory']): TaskRecord {
  return {
    issue: 3060,
    title: 'thing',
    slug: 'thing',
    branch: 'ouriel/3060-thing',
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory,
    lastReconciledAt: null,
  };
}

function snapshotWith(thread: Partial<T3Snapshot['threads'][number]>): T3Snapshot {
  return {
    projects: [],
    threads: [
      {
        id: 'thread-1',
        projectId: 'p1',
        title: '#3060 plan',
        activities: [],
        session: {
          threadId: 'thread-1',
          status: 'running',
          activeTurnId: 'turn-1',
          lastError: null,
        },
        ...thread,
      } as T3Snapshot['threads'][number],
    ],
  } as T3Snapshot;
}

describe('latestThreadId', () => {
  test('finds the thread id of the most recent T3 spawn', () => {
    const id = latestThreadId(
      task([
        { phase: 'plan', agent: 'codex', startedAt: '2026-08-07T09:00:00Z', command: 't3', threadId: 'thread-a' },
        { phase: 'implement', agent: 'codex', startedAt: '2026-08-07T10:00:00Z', command: 't3', threadId: 'thread-b' },
      ]),
    );
    expect(id).toBe('thread-b');
  });

  test('ignores wt and vscode spawns, which have no thread', () => {
    const id = latestThreadId(
      task([
        { phase: 'plan', agent: 'codex', startedAt: '2026-08-07T09:00:00Z', command: 't3', threadId: 'thread-a' },
        { phase: 'implement', agent: 'claude', startedAt: '2026-08-07T10:00:00Z', command: 'wt ...' },
      ]),
    );
    expect(id).toBe('thread-a');
  });

  test('a task that never used T3 has no thread', () => {
    expect(latestThreadId(task([]))).toBeNull();
  });
});

describe('toT3Fact', () => {
  test('reports a running session', () => {
    const fact = toT3Fact(snapshotWith({}), 'thread-1');
    expect(fact).toMatchObject({
      threadId: 'thread-1',
      sessionStatus: 'running',
      activeTurnId: 'turn-1',
      awaitingApproval: false,
      lastError: null,
    });
  });

  test('no snapshot means no information at all, not "not running"', () => {
    // The distinction matters: undefined makes reconcile fall back to PID
    // liveness, whereas a fabricated 'stopped' would show a live agent as dead.
    expect(toT3Fact(undefined, 'thread-1')).toBeUndefined();
  });

  test('a task with no recorded thread has no T3 fact', () => {
    expect(toT3Fact(snapshotWith({}), null)).toBeUndefined();
  });

  test('a thread that is not in the snapshot has no T3 fact', () => {
    // Deleted inside T3. Markers still hold the history; only liveness is lost.
    expect(toT3Fact(snapshotWith({}), 'thread-gone')).toBeUndefined();
  });

  test('a thread with no session reports idle rather than vanishing', () => {
    const fact = toT3Fact(snapshotWith({ session: null }), 'thread-1');
    expect(fact?.sessionStatus).toBe('idle');
    expect(fact?.activeTurnId).toBeNull();
  });

  test('an approval-toned latest activity means the thread is blocked on you', () => {
    const fact = toT3Fact(
      snapshotWith({
        activities: [
          { id: 'e1', tone: 'info' },
          { id: 'e2', tone: 'approval' },
        ],
      }),
      'thread-1',
    );
    expect(fact?.awaitingApproval).toBe(true);
  });

  test('an approval that is no longer the latest activity is not still blocking', () => {
    const fact = toT3Fact(
      snapshotWith({
        activities: [
          { id: 'e1', tone: 'approval' },
          { id: 'e2', tone: 'tool' },
        ],
      }),
      'thread-1',
    );
    expect(fact?.awaitingApproval).toBe(false);
  });

  test('a session error is carried through for the card to show', () => {
    const fact = toT3Fact(
      snapshotWith({
        session: { threadId: 'thread-1', status: 'error', activeTurnId: null, lastError: 'provider exited 1' },
      }),
      'thread-1',
    );
    expect(fact?.sessionStatus).toBe('error');
    expect(fact?.lastError).toBe('provider exited 1');
  });
});
