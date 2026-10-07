import type { BoardConfig } from '../../api.ts';
import type { TaskWithDerived } from '../../../shared/types.ts';

export interface TabProps {
  task: TaskWithDerived;
  config: BoardConfig;
  /** Label of the action currently in flight, or null. Disables buttons. */
  busy: string | null;
  /** Runs an action with busy/error bookkeeping handled by the shell. */
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
  onChanged: () => void;
}

export type DrawerTab = 'run' | 'plan' | 'notes' | 'history' | 'setup';
