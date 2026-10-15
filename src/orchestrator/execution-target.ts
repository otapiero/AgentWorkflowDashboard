import { join } from 'node:path';
import { prKey } from '../shared/pr-stack.ts';
import type { Config, TaskRecord } from '../shared/types.ts';
import { worktreePath, worktreesDir } from './paths.ts';

export interface ExecutionTarget { branch: string; baseBranch: string; worktreePath: string; layerKey?: string; prNumber?: number; headSha?: string }

/** Resolve once for preview and launch. Never silently fall back from an invalid PR. */
export function resolveExecutionTarget(config: Config, task: TaskRecord, layerKey?: string, issueOnly = false): ExecutionTarget {
  const layers = task.stack?.layers ?? [];
  if ((issueOnly && !layerKey) || (!layers.length && !layerKey)) return { branch: task.branch, baseBranch: config.repo.baseBranch, worktreePath: worktreePath(task.issue) };
  const key = layerKey ?? task.stack?.selectedKey ?? (layers.length === 1 ? prKey(layers[0]!) : null);
  if (!key) throw new Error('Select a PR layer before launching this phase');
  const layer = layers.find(p => prKey(p) === key);
  if (!layer) throw new Error('Selected PR does not belong to this issue');
  if (!layer.available || !layer.headBranch || !layer.baseBranch || !layer.headSha || !layer.checkedAt || Date.now() - Date.parse(layer.checkedAt) > 600_000 || !Number.isFinite(Date.parse(layer.checkedAt))) throw new Error('PR metadata is unavailable or stale. Refresh the board before launching');
  if (layer.state !== 'OPEN') throw new Error('Only an open PR can be an execution target');
  if (layer.headRepository.toLowerCase() !== `${config.repo.owner}/${config.repo.name}`.toLowerCase()) throw new Error('Launching against a fork PR is not supported. Open the fork checkout manually');
  return { branch: layer.headBranch, baseBranch: layer.baseBranch,
    worktreePath: task.branch === layer.headBranch ? worktreePath(task.issue) : join(worktreesDir(), `${task.issue}-pr-${layer.number}`),
    layerKey: key, prNumber: layer.number, headSha: layer.headSha };
}
