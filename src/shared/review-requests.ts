export interface ReviewRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
}

export const REVIEW_REQUEST_LIMIT = 1000;

export interface ReviewRequestsSnapshot {
  pullRequests: ReviewRequest[];
  /** Timestamp of the last successful read, retained on failure. */
  checkedAt: string | null;
  error: string | null;
  limitReached: boolean;
}

export interface ReviewWorktree extends ReviewRequest {
  openedAt: string;
  workspacePath: string;
  worktreeExists: boolean;
}

export interface ReviewDashboardSnapshot extends ReviewRequestsSnapshot {
  worktrees: ReviewWorktree[];
}

export interface ReviewCleanupResult {
  rescued: string[];
  rescuePath: string;
}
