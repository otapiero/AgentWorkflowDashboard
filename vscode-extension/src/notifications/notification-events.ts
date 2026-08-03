import type { TaskWithDerived } from '../../../src/shared/types.ts';

export type NotificationKind = 'agentFinished' | 'ciFailed' | 'ciPassed' | 'reviewComments' | 'approvalRequired';

export interface NotificationEvent {
  kind: NotificationKind;
  issue: number;
  title: string;
  message: string;
  fingerprint: string;
  prUrl: string | null;
}

export function classifyTransitions(previous: TaskWithDerived, current: TaskWithDerived): NotificationEvent[] {
  if (current.lastReconciledAt === null) return [];
  const events: NotificationEvent[] = [];
  if (previous.integration.liveSpawn !== null && current.integration.liveSpawn === null) {
    events.push(event(current, 'agentFinished', 'agent-finished'));
  }
  if (current.integration.checks === 'failure' && previous.integration.checks !== 'failure') {
    events.push(event(current, 'ciFailed', `ci-${current.integration.checks}`));
  }
  if (current.integration.checks === 'success' && previous.integration.checks !== 'success' && current.derived.gates.ci === true) {
    events.push(event(current, 'ciPassed', `ci-${current.integration.checks}`));
  }
  const previousReview = previous.integration.review;
  const currentReview = current.integration.review;
  if (currentReview.unresolvedThreads > previousReview.unresolvedThreads || currentReview.copilotUnresolved > previousReview.copilotUnresolved) {
    events.push(event(current, 'reviewComments', `review-${currentReview.unresolvedThreads}-${currentReview.copilotUnresolved}`));
  }
  if (!previous.integration.approvalRequired && current.integration.approvalRequired) {
    events.push(event(current, 'approvalRequired', 'approval-required'));
  }
  return events;
}

function event(task: TaskWithDerived, kind: NotificationKind, state: string): NotificationEvent {
  const timestamp = task.lastReconciledAt!;
  const titles: Record<NotificationKind, string> = {
    agentFinished: 'Agent finished', ciFailed: 'CI failed', ciPassed: 'CI passed', reviewComments: 'Review comments added', approvalRequired: 'Approval required',
  };
  return {
    kind,
    issue: task.issue,
    title: titles[kind],
    message: `${task.title} (#${task.issue})`,
    fingerprint: `${task.issue}:${kind}:${timestamp}:${state}`,
    prUrl: task.prUrl,
  };
}
