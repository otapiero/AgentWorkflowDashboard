import type { BoardConfig, Phase, PollMeta, TaskWithDerived } from '../../src/shared/types.ts';

export type ConnectionState = 'starting' | 'connected' | 'disconnected' | 'incompatible';

export type StoreChange = {
  kind: 'targeted';
  issues: ReadonlySet<number>;
  sections: ReadonlySet<'current' | 'attention' | 'all' | Phase>;
} | {
  kind: 'full';
  reason: 'baseline' | 'config';
};

export interface TaskStoreSnapshot {
  config: BoardConfig | null;
  tasks: readonly TaskWithDerived[];
  attentionTransitions: ReadonlyMap<number, string>;
  poll: PollMeta | null;
  connection: ConnectionState;
  isBaselineReady: boolean;
}

type ChangeListener = (change: StoreChange) => void;

export class TaskStore {
  private readonly tasksByIssue = new Map<number, TaskWithDerived>();
  private readonly signatures = new Map<number, string>();
  private readonly attentionSignatures = new Map<number, string>();
  private readonly attentionTransitions = new Map<number, string>();
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
    const firstBaseline = !this.baselineReady;
    const pipelineChanged = this.config !== null && pipelineSignature(this.config) !== pipelineSignature(config);
    this.config = config;
    this.baselineReady = true;
    const targeted = this.replaceTasks(tasks);
    if (firstBaseline) this.emit({ kind: 'full', reason: 'baseline' });
    else if (pipelineChanged) this.emit({ kind: 'full', reason: 'config' });
    else if (targeted) this.emit(targeted);
  }

  applyTasks(tasks: readonly TaskWithDerived[]): void {
    const change = this.replaceTasks(tasks);
    if (change) this.emit(change);
  }

  applyPoll(poll: PollMeta): void {
    this.poll = poll;
  }

  setConnection(connection: ConnectionState): void {
    if (this.connection === connection) return;
    this.connection = connection;
    this.emit({
      kind: 'targeted',
      issues: new Set(),
      sections: new Set(['current', 'attention', 'all']),
    });
  }

  snapshot(): TaskStoreSnapshot {
    return {
      config: this.config,
      tasks: this.orderedTasks,
      attentionTransitions: this.attentionTransitions,
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

  private replaceTasks(tasks: readonly TaskWithDerived[]): Extract<StoreChange, { kind: 'targeted' }> | null {
    const incoming = new Map<number, TaskWithDerived>();
    for (const task of tasks) incoming.set(task.issue, task);

    const issues = new Set<number>();
    const sections = new Set<'current' | 'attention' | 'all' | Phase>();

    for (const [issue, previous] of this.tasksByIssue) {
      if (incoming.has(issue)) continue;
      this.tasksByIssue.delete(issue);
      this.signatures.delete(issue);
      this.attentionSignatures.delete(issue);
      this.attentionTransitions.delete(issue);
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
        this.updateAttentionTransition(undefined, next);
        continue;
      }

      const attentionChanged = this.updateAttentionTransition(previous, next);
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
      if (attentionChanged) sections.add('attention');
    }

    this.orderedTasks = Object.freeze([...this.tasksByIssue.values()].sort((left, right) => left.issue - right.issue));
    return issues.size > 0 ? { kind: 'targeted', issues, sections } : null;
  }

  private emit(change: StoreChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private updateAttentionTransition(previous: TaskWithDerived | undefined, next: TaskWithDerived): boolean {
    const issue = next.issue;
    const previousSignature = this.attentionSignatures.get(issue);
    if (!next.derived.needsYou) {
      this.attentionSignatures.delete(issue);
      this.attentionTransitions.delete(issue);
      return previous?.derived.needsYou === true;
    }

    const nextSignature = attentionSignature(next);
    const changed = previous?.derived.needsYou !== true || previousSignature !== nextSignature;
    if (changed) this.attentionTransitions.set(issue, next.lastReconciledAt ?? '');
    this.attentionSignatures.set(issue, nextSignature);
    return changed;
  }
}

function pipelineSignature(config: BoardConfig): string {
  return JSON.stringify(config.pipeline);
}

function signature(task: TaskWithDerived): string {
  const { lastReconciledAt: _lastReconciledAt, ...stableTask } = task;
  return JSON.stringify(stableTask);
}

function attentionSignature(task: TaskWithDerived): string {
  return JSON.stringify({
    needsYou: task.derived.needsYou,
    severity: task.integration.checks === 'failure' || task.integration.review.decision === 'CHANGES_REQUESTED' ? 'bad' : 'warn',
    approvalRequired: task.integration.approvalRequired,
    reviewDecision: task.integration.review.decision,
    unresolvedThreads: task.integration.review.unresolvedThreads,
    copilotUnresolved: task.integration.review.copilotUnresolved,
  });
}
