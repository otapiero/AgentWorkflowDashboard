import type {
  LauncherKind,
  Phase,
  PhaseConfig,
  PhaseDefaults,
  PollMeta,
  TaskWithDerived,
} from '../shared/types.ts';

export type { PollMeta, RateLimit } from '../shared/types.ts';
export type { MissionUsage, SessionUsage, TokenTotals } from '../orchestrator/usage.ts';

export interface AgentInfo {
  name: string;
  models: string[];
  efforts: string[];
  hasEffort: boolean;
}

export interface BoardConfig {
  repo: { path: string; owner: string; name: string; baseBranch: string; branchPrefix: string };
  pipeline: PhaseConfig[];
  agents: AgentInfo[];
  phaseDefaults: PhaseDefaults;
  launcher: LauncherKind;
}

export interface OpenIssue {
  number: number;
  title: string;
  assignees: string[];
}

export type IssueScope = 'mine' | 'all';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const post = <T>(url: string, body?: unknown) =>
  request<T>(url, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

export const api = {
  config: () => request<BoardConfig>('/api/config'),
  tasks: () => request<TaskWithDerived[]>('/api/tasks'),
  issues: (scope: IssueScope = 'mine') =>
    request<OpenIssue[]>(`/api/issues?scope=${scope}`),
  plan: (issue: number) => request<{ content: string }>(`/api/tasks/${issue}/plan`),
  usage: (issue: number) =>
    request<import('../orchestrator/usage.ts').MissionUsage>(`/api/tasks/${issue}/usage`),
  savePlan: (issue: number, content: string) =>
    request<{ ok: true }>(`/api/tasks/${issue}/plan`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  import: (issue: number) => post<TaskWithDerived[]>('/api/tasks/import', { issue }),
  reconcile: () => post<TaskWithDerived[]>('/api/reconcile'),

  spawn: (
    issue: number,
    phase: Phase,
    opts: {
      customInstructions?: string;
      agent?: string;
      model?: string;
      effort?: string;
    } = {},
  ) => post<{ spawned: unknown }>(`/api/tasks/${issue}/spawn`, { phase, ...opts }),

  markDone: (issue: number, phase: Phase) =>
    post<TaskWithDerived[]>(`/api/tasks/${issue}/mark-done`, { phase }),
  unmarkDone: (issue: number, phase: Phase) =>
    post<TaskWithDerived[]>(`/api/tasks/${issue}/unmark-done`, { phase }),
  move: (issue: number, phase: Phase | null) =>
    post<TaskWithDerived[]>(`/api/tasks/${issue}/move`, { phase }),
  overrides: (
    issue: number,
    o: { agent?: string; model?: string; effort?: string; instructions?: string },
  ) => post<TaskWithDerived[]>(`/api/tasks/${issue}/overrides`, o),
  phaseDefault: (phase: string, o: { agent?: string; model?: string; effort?: string }) =>
    post<TaskWithDerived[]>('/api/phase-defaults', { phase, ...o }),
  setLauncher: (launcher: LauncherKind) =>
    post<TaskWithDerived[]>('/api/settings', { launcher }),
  openCode: (issue: number) => post<{ ok: true }>(`/api/tasks/${issue}/open-code`),
  cleanup: (issue: number) => post<TaskWithDerived[]>(`/api/tasks/${issue}/cleanup`),
  forget: (issue: number) =>
    request<TaskWithDerived[]>(`/api/tasks/${issue}`, { method: 'DELETE' }),
};

/** Subscribe to reconciled board state. Returns an unsubscribe function. */
export function subscribe(
  handlers: {
    onTasks: (tasks: TaskWithDerived[]) => void;
    onPoll: (meta: PollMeta) => void;
    onStatus: (connected: boolean) => void;
  },
): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('tasks', (event) => {
    handlers.onTasks(JSON.parse((event as MessageEvent<string>).data) as TaskWithDerived[]);
  });
  source.addEventListener('poll', (event) => {
    handlers.onPoll(JSON.parse((event as MessageEvent<string>).data) as PollMeta);
  });
  source.addEventListener('open', () => handlers.onStatus(true));
  source.addEventListener('error', () => handlers.onStatus(false));
  return () => source.close();
}
