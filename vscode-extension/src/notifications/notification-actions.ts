import type { TaskWithDerived } from '../../../src/shared/types.ts';
import type { NotificationEvent } from './notification-events.ts';

export function notificationActions(event: NotificationEvent, task: TaskWithDerived | undefined, current: TaskWithDerived | null | undefined, canMutate = false): string[] {
  const actions: string[] = [];
  if (event.prUrl) actions.push('View PR');
  if (task?.integration.worktreeExists) actions.push('Open Worktree');
  if (canMutate && event.kind === 'approvalRequired' && task?.integration.worktreeExists) actions.push('Run Phase');
  if (current?.issue === event.issue && task?.integration.liveSpawn) actions.push('View Session');
  actions.push('Open Dashboard');
  return actions;
}
