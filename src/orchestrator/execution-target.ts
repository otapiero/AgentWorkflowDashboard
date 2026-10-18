import { existsSync } from 'node:fs';
import { execaSync } from 'execa';
import { prKey } from '../shared/pr-stack.ts';
import type { Config, TaskRecord } from '../shared/types.ts';
import { worktreePath } from './paths.ts';
import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';

export interface ExecutionTarget { branch: string; baseBranch: string; worktreePath: string; layerKey?: string; prNumber?: number; headSha?: string }

/** PR targeting is opt-in. Preview and launch share the same validation. */
export function resolveExecutionTarget(config: Config, task: TaskRecord, layerKey?: string): ExecutionTarget {
  const layers = task.stack?.layers ?? [];
  if (layerKey === undefined) {
    const checkout = worktreePath(task.issue);
    // The shared checkout may have moved on to a new branch before its PR exists.
    const branch = existsSync(checkout)
      ? execaSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: checkout, timeout: SUBPROCESS_TIMEOUT_MS }).stdout.trim()
      : task.branch;
    return { branch, baseBranch: config.repo.baseBranch, worktreePath: checkout };
  }
  const key = layerKey;
  const layer = layers.find(p => prKey(p) === key);
  if (!layer) throw new Error('Selected PR does not belong to this issue');
  if (!layer.available || !layer.headBranch || !layer.baseBranch || !layer.headSha || !layer.checkedAt || Date.now() - Date.parse(layer.checkedAt) > 600_000 || !Number.isFinite(Date.parse(layer.checkedAt))) throw new Error('PR metadata is unavailable or stale. Refresh the board before launching');
  if (layer.state !== 'OPEN') throw new Error('Only an open PR can be an execution target');
  if (layer.headRepository.toLowerCase() !== `${config.repo.owner}/${config.repo.name}`.toLowerCase()) throw new Error('Launching against a fork PR is not supported. Open the fork checkout manually');
  return { branch: layer.headBranch, baseBranch: layer.baseBranch,
    worktreePath: worktreePath(task.issue),
    layerKey: key, prNumber: layer.number, headSha: layer.headSha };
}
