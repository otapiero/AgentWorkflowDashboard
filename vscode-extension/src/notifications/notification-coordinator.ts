import type { TaskWithDerived } from '../../../src/shared/types.ts';
import { DeliveryLedger } from './delivery-ledger.ts';
import { classifyTransitions, type NotificationEvent, type NotificationKind } from './notification-events.ts';

export type NotificationSettings = Record<NotificationKind, boolean>;
export type NotificationPresenter = (event: NotificationEvent) => void | Promise<void>;

export class NotificationCoordinator {
  private readonly previousByIssue = new Map<number, TaskWithDerived>();

  constructor(private readonly ledger: DeliveryLedger, private readonly present: NotificationPresenter, private readonly settings: NotificationSettings) {}

  prime(tasks: readonly TaskWithDerived[]): void {
    this.replacePrevious(tasks);
  }

  async apply(tasks: readonly TaskWithDerived[]): Promise<void> {
    const currentByIssue = new Map(tasks.map((task) => [task.issue, task]));
    const events: NotificationEvent[] = [];
    for (const [issue, current] of currentByIssue) {
      const previous = this.previousByIssue.get(issue);
      if (previous !== undefined) events.push(...classifyTransitions(previous, current));
    }
    this.replacePrevious(tasks);
    for (const event of events) {
      if (!this.settings[event.kind]) continue;
      if (await this.ledger.claim(event)) await this.present(event);
    }
  }

  private replacePrevious(tasks: readonly TaskWithDerived[]): void {
    this.previousByIssue.clear();
    for (const task of tasks) this.previousByIssue.set(task.issue, task);
  }
}
