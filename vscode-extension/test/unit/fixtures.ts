import type { BoardConfig, ChecksState, Phase, TaskWithDerived } from '../../../src/shared/types.ts';

export const config: BoardConfig = {
  repo: { path: 'C:\\repo', owner: 'acme', name: 'widgets', baseBranch: 'main', branchPrefix: 'alice/' },
  pipeline: [
    { id: 'plan', label: 'Plan', actor: 'codex', spawnable: true, gate: { type: 'manual' } },
    { id: 'implement', label: 'Implement', actor: 'codex', spawnable: true, gate: { type: 'manual' } },
    { id: 'ci', label: 'CI', actor: 'ci', gate: { type: 'auto', signal: 'checks_green' } },
  ],
  agents: [{ name: 'codex', models: ['gpt-5.6-sol'], efforts: ['medium', 'high'], hasEffort: true }],
  phaseDefaults: {},
  launcher: 'vscode',
};

export function task(options: {
  issue?: number;
  phase?: Phase;
  needsYou?: boolean;
  workspacePath?: string;
  worktreeExists?: boolean;
  checks?: ChecksState;
  lastReconciledAt?: string | null;
} = {}): TaskWithDerived {
  const issue = options.issue ?? 3060;
  const phase = options.phase ?? 'implement';
  const checks = options.checks ?? 'none';
  return {
    issue,
    title: `Task ${issue}`,
    slug: `task-${issue}`,
    branch: `alice/${issue}`,
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: [],
    lastReconciledAt: options.lastReconciledAt ?? '2026-08-03T10:00:00.000Z',
    derived: {
      issue,
      derivedPhase: phase,
      displayPhase: phase,
      gates: { inbox: true, plan: false, implement: false, publish: false, ci: checks === 'success', copilot_review: false, dev_review: false, merge: false, done: false },
      badges: [],
      artifacts: [],
      needsYou: options.needsYou ?? false,
      needsYouReason: options.needsYou ? 'Needs attention' : null,
    },
    pinned: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    integration: {
      workspacePath: options.workspacePath ?? `C:\\mc\\worktrees\\issue-${issue}`,
      worktreeExists: options.worktreeExists ?? true,
      liveSpawn: null,
      checks,
      review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
      approvalRequired: false,
    },
  };
}

export function taskWithPath(workspacePath: string): TaskWithDerived {
  return task({ workspacePath, worktreeExists: true });
}
