import { worktreePath } from './paths.ts';
import type { EditorIntegrationState, Facts } from '../shared/types.ts';

export function toEditorIntegration(facts: Facts): EditorIntegrationState {
  return {
    workspacePath: worktreePath(facts.issue),
    worktreeExists: facts.worktreeExists,
    liveSpawn: facts.liveSpawn,
    checks: facts.checks,
    review: { ...facts.review },
    approvalRequired: facts.pr.exists && facts.review.decision === 'REVIEW_REQUIRED',
  };
}
