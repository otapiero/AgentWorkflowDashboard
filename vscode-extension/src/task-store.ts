import type { BoardConfig, Phase, PollMeta, TaskWithDerived } from '../../src/shared/types.ts';

export type ConnectionState = 'starting' | 'connected' | 'disconnected' | 'incompatible';

export interface StoreChange {
  issues: ReadonlySet<number>;
  sections: ReadonlySet<'current' | 'attention' | 'all' | Phase>;
}

export interface TaskStoreSnapshot {
  config: BoardConfig | null;
  tasks: readonly TaskWithDerived[];
  poll: PollMeta | null;
  connection: ConnectionState;
  isBaselineReady: boolean;
}

type ChangeListener = (change: StoreChange) => void;

export class TaskStore {
  private readonly tasksByIssue = new Map<number, TaskWithDerived>();
  private readonly signatures = new Map<number, string>();
  private readonly listeners = new Set<ChangeListener>();
  private orderedTasks: readonly TaskWithDerived[] = Object.freeze([]);
  private config: BoardConfig | null = null;
  private poll: PollMeta | null = null;
  private connection: ConnectionState = 'starting';
  private baselineReady = false;

  onDidChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyBaseline(config: BoardConfig, tasks: readonly TaskWithDerived[]): void {
    this.config = config;
    this.baselineReady = true;
    this.replaceTasks(tasks);
  }

  applyTasks(tasks: readonly TaskWithDerived[]): void {
    this.replaceTasks(tasks);
  }

  applyPoll(poll: PollMeta): void {
    this.poll = poll;
  }

  setConnection(connection: ConnectionState): void {
    if (this.connection === connection) return;
    this.connection = connection;
    this.emit({
      issues: new Set(),
      sections: new Set(['current', 'attention', 'all']),
    });
  }

  snapshot(): TaskStoreSnapshot {
    return {
      config: this.config,
      tasks: this.orderedTasks,
      poll: this.poll,
      connection: this.connection,
      isBaselineReady: this.baselineReady,
    };
  }

  tasks(): readonly TaskWithDerived[] {
    return this.orderedTasks;
  }

  task(issue: number): TaskWithDerived | undefined {
    return this.tasksByIssue.get(issue);
  }

  attentionTasks(): readonly TaskWithDerived[] {
    return Object.freeze(this.orderedTasks.filter((task) => task.derived.needsYou));
  }

  phaseTasks(phase: Phase): readonly TaskWithDerived[] {
    return Object.freeze(this.orderedTasks.filter((task) => task.derived.displayPhase === phase));
  }

  private replaceTasks(tasks: readonly TaskWithDerived[]): void {
    const incoming = new Map<number, TaskWithDerived>();
    for (const task of tasks) incoming.set(task.issue, task);

    const issues = new Set<number>();
    const sections = new Set<'current' | 'attention' | 'all' | Phase>();

    for (const [issue, previous] of this.tasksByIssue) {
      if (incoming.has(issue)) continue;
      this.tasksByIssue.delete(issue);
      this.signatures.delete(issue);
      issues.add(issue);
      sections.add('all');
      sections.add(previous.derived.displayPhase);
      if (previous.derived.needsYou) sections.add('attention');
    }

    for (const [issue, next] of incoming) {
      const previous = this.tasksByIssue.get(issue);
      const nextSignature = signature(next);
      if (!previous) {
        this.tasksByIssue.set(issue, next);
        this.signatures.set(issue, nextSignature);
        issues.add(issue);
        sections.add('all');
        sections.add(next.derived.displayPhase);
        if (next.derived.needsYou) sections.add('attention');
        continue;
      }

      if (this.signatures.get(issue) === nextSignature) {
        this.tasksByIssue.set(issue, next);
        continue;
      }

      this.tasksByIssue.set(issue, next);
      this.signatures.set(issue, nextSignature);
      issues.add(issue);
      if (previous.derived.displayPhase !== next.derived.displayPhase) {
        sections.add(previous.derived.displayPhase);
        sections.add(next.derived.displayPhase);
      }
      if (previous.derived.needsYou !== next.derived.needsYou) sections.add('attention');
    }

    this.orderedTasks = Object.freeze([...this.tasksByIssue.values()].sort((left, right) => left.issue - right.issue));
    if (issues.size > 0) this.emit({ issues, sections });
  }

  private emit(change: StoreChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

function signature(task: TaskWithDerived): string {
  const { lastReconciledAt: _lastReconciledAt, ...stableTask } = task;
  return JSON.stringify(stableTask);
}
