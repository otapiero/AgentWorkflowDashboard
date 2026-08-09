import { describe, expect, test } from 'vitest';

import {
  findProjectForWorkspace,
  latestThreadId,
  toT3Fact,
} from '../src/orchestrator/t3/facts.ts';
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

  /**
   * A thread keeps its last session state after the operator closes it out, so
   * every one of these would otherwise leave a card reading "running" forever.
   * Field names and semantics read from OrchestrationThread in T3 0.0.32's
   * bundle on 2026-08-09.
   */
  describe('threads the operator has finished with', () => {
    test('a deleted thread is no information, not a dead session', () => {
      // Deleted is a soft delete: the thread stays in the snapshot carrying
      // whatever session it last had. Returning undefined falls back to marker
      // liveness rather than asserting something about a thread that is gone.
      expect(toT3Fact(snapshotWith({ deletedAt: '2026-08-09T05:36:48.611Z' }), 'thread-1')).toBeUndefined();
    });

    test('a settled thread is reported, but marked settled', () => {
      const fact = toT3Fact(snapshotWith({ settledAt: '2026-08-09T05:45:00.000Z' }), 'thread-1');
      expect(fact?.settled).toBe(true);
      // The status itself is still reported verbatim; interpreting it is
      // reconcile's job, not this function's.
      expect(fact?.sessionStatus).toBe('running');
    });

    test('an archived thread counts as settled too', () => {
      expect(
        toT3Fact(snapshotWith({ archivedAt: '2026-08-09T05:45:00.000Z' }), 'thread-1')?.settled,
      ).toBe(true);
    });

    test('settledOverride settles a thread with no settledAt', () => {
      expect(
        toT3Fact(snapshotWith({ settledOverride: 'settled' }), 'thread-1')?.settled,
      ).toBe(true);
    });

    test("settledOverride 'active' un-settles a thread that has a settledAt", () => {
      // The override is exactly that — an override. Reading settledAt alone
      // would call a deliberately reopened thread finished.
      expect(
        toT3Fact(
          snapshotWith({ settledAt: '2026-08-09T05:45:00.000Z', settledOverride: 'active' }),
          'thread-1',
        )?.settled,
      ).toBe(false);
    });

    test('an ordinary working thread is not settled', () => {
      expect(toT3Fact(snapshotWith({}), 'thread-1')?.settled).toBe(false);
    });
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

/**
 * T3 enforces one active project per workspace root. Creating a second one
 * fails the whole spawn with a 500:
 *
 *   OrchestrationCommandInvariantError, commandType 'project.create',
 *   "Active project 'd0a5b45c-…' already exists for workspace root
 *    'c:\src\widgets'."
 *
 * Recorded from T3 0.0.31's own server trace on 2026-08-09. Adopting the
 * existing project is the same discipline pickBranchForIssue already applies
 * to a branch that exists before Mission Control would have generated one.
 */
describe('findProjectForWorkspace', () => {
  const ROOT = 'C:\\src\\widgets';

  const project = (over: Record<string, unknown> = {}) => ({
    id: 'proj-1',
    title: 'widgets',
    workspaceRoot: ROOT,
    ...over,
  });

  const snap = (projects: unknown[]) =>
    ({ projects, threads: [] }) as unknown as T3Snapshot;

  test('adopts the project already rooted at the repo', () => {
    expect(findProjectForWorkspace(snap([project()]), ROOT)).toBe('proj-1');
  });

  test('matches regardless of case, because T3 compares normalised paths', () => {
    // T3's own error reported the root lowercased while the API returns it
    // cased. An exact comparison would miss the project and then be refused
    // permission to create the replacement.
    expect(
      findProjectForWorkspace(
        snap([project()]),
        'c:\\src\\WIDGETS',
      ),
    ).toBe('proj-1');
  });

  test('matches regardless of slash direction or a trailing separator', () => {
    expect(
      findProjectForWorkspace(
        snap([project()]),
        'C:/src/widgets\\',
      ),
    ).toBe('proj-1');
  });

  test('ignores a soft-deleted project, which does not hold the invariant', () => {
    // T3 says "Active project ... already exists". A deleted one does not
    // block creation, so adopting it would bind threads to a dead project.
    expect(
      findProjectForWorkspace(
        snap([project({ deletedAt: '2026-08-08T00:00:00.000Z' })]),
        ROOT,
      ),
    ).toBeNull();
  });

  test('a project for a different repo is not adopted', () => {
    expect(
      findProjectForWorkspace(snap([project({ workspaceRoot: 'C:\\other\\repo' })]), ROOT),
    ).toBeNull();
  });

  test('no snapshot means no answer — the caller must not assume "create"', () => {
    expect(findProjectForWorkspace(undefined, ROOT)).toBeNull();
  });

  test('an empty project list is null', () => {
    expect(findProjectForWorkspace(snap([]), ROOT)).toBeNull();
  });
});
