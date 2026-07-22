/**
 * Shared vocabulary for Mission Control.
 *
 * The split that matters here: `Facts` are gathered fresh from disk and GitHub
 * on every reconcile and are never persisted as truth; `TaskRecord` is a cache
 * plus the handful of things only the user can tell us (which issues are on the
 * board, manual overrides, spawn history); `DerivedState` is what the reconciler
 * computes from Facts alone.
 */

export const PHASES = [
  'inbox',
  'plan',
  'implement',
  'publish',
  'ci',
  'copilot_review',
  'dev_review',
  'merge',
  'done',
] as const;

export type Phase = (typeof PHASES)[number];

export type Actor = 'claude' | 'copilot' | 'none' | 'you';

export type GateSignal =
  | 'pr_exists'
  | 'checks_green'
  | 'copilot_comments_resolved'
  | 'approved_and_threads_resolved';

export type ChecksState = 'none' | 'pending' | 'success' | 'failure';

export type ReviewDecision =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'REVIEW_REQUIRED'
  | 'NONE';

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

/** A spawn that is currently believed to be running, identified by its pwsh PID. */
export interface LiveSpawn {
  phase: Phase;
  pid: number;
  startedAt: string;
}

export interface Facts {
  issue: number;
  worktreeExists: boolean;
  branchExists: boolean;
  /** Marker file names present, e.g. ['plan.done', 'implement.running']. */
  markers: string[];
  planMdExists: boolean;
  /** Branch has commits that exist on the remote. */
  hasPushedCommits: boolean;
  /** Uncommitted files in the worktree. Surfaced as a badge, never a gate. */
  dirtyFileCount: number;
  /** Local commits not yet on the remote. Surfaced as a badge, never a gate. */
  unpushedCommits: number;
  /** Non-null only when a `<phase>.running` marker names a live process. */
  liveSpawn: LiveSpawn | null;
  pr: {
    exists: boolean;
    number: number | null;
    url: string | null;
    state: PrState | null;
  };
  checks: ChecksState;
  review: {
    decision: ReviewDecision;
    unresolvedThreads: number;
    /** Unresolved threads whose first comment is by the Copilot review bot. */
    copilotUnresolved: number;
  };
}

export type BadgeKind =
  | 'live'
  | 'stale-spawn'
  | 'plan-ready'
  | 'dirty'
  | 'unpushed'
  | 'ci'
  | 'copilot'
  | 'review'
  | 'approved'
  | 'pr';

export type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad' | 'busy';

export interface Badge {
  kind: BadgeKind;
  label: string;
  tone: BadgeTone;
}

export interface DerivedState {
  issue: number;
  derivedPhase: Phase;
  displayPhase: Phase;
  gates: Record<Phase, boolean>;
  badges: Badge[];
  needsYou: boolean;
  /** Why the card needs attention, for the drawer and future notifications. */
  needsYouReason: string | null;
}

export interface SpawnRecord {
  phase: Phase;
  agent: string;
  startedAt: string;
  /** The full command line used, kept purely for debugging a bad spawn. */
  command: string;
}

export interface TaskOverrides {
  agent?: string;
  model?: string;
  effort?: string;
  instructions?: string;
}

export interface TaskRecord {
  issue: number;
  title: string;
  slug: string;
  branch: string;
  worktreePath: string | null;
  prNumber: number | null;
  prUrl: string | null;
  manualPhase: Phase | null;
  overrides?: TaskOverrides;
  spawnHistory: SpawnRecord[];
  lastReconciledAt: string | null;
  notes?: string;
}

export interface TaskWithDerived extends TaskRecord {
  derived: DerivedState;
  /** Agent + model + effort that a spawn at the current phase would use. */
  pinned: { agent: string | null; model: string | null; effort: string | null };
}

/** Per-phase default agent/model/effort, layered over config.yaml, not editing it. */
export type PhaseDefaults = Record<
  string,
  { agent?: string; model?: string; effort?: string }
>;

export type LauncherKind = 'wt' | 'vscode';

/** UI-adjustable preferences that layer over config.yaml. */
export interface Settings {
  launcher?: LauncherKind;
}

/** The persisted cache. Deleting this file loses board membership, nothing more. */
export interface StateFile {
  version: 1;
  tasks: TaskRecord[];
  phaseDefaults?: PhaseDefaults;
  settings?: Settings;
}

// --- config.yaml ---------------------------------------------------------

/**
 * How to drive one agent CLI. Verified differences the schema must express:
 * `claude` takes its prompt positionally and supports --append-system-prompt;
 * `copilot` takes `-i <prompt>` and has no system-prompt flag at all.
 */
export interface AgentProfile {
  launch: string;
  /** 'positional' => `claude "<prompt>"`; 'flag' => `copilot -i "<prompt>"`. */
  promptMode: 'positional' | 'flag';
  promptFlag?: string;
  modelFlag?: string;
  model?: string;
  /** Models offered in the picker. Falls back to a built-in list per agent. */
  models?: string[];
  /** Flag that sets reasoning effort, e.g. '--effort'. Omit if unsupported. */
  effortFlag?: string;
  /** Effort levels offered in the picker. Falls back to a built-in list. */
  efforts?: string[];
  effort?: string;
  /** 'flag' => pass via instructionFlag; 'inline' => prepend into the prompt body. */
  instructionMode: 'flag' | 'inline';
  instructionFlag?: string;
  extraArgs?: string[];
}

export interface PhaseConfig {
  id: Phase;
  label: string;
  actor: Actor;
  /** User command name (without slash) whose body is rendered into the prompt. */
  command?: string;
  spawnable?: boolean;
  repeatable?: boolean;
  gate: { type: 'manual' } | { type: 'auto'; signal: GateSignal };
  onFail?: { offerSpawnPhase: string };
}

export interface Config {
  repo: {
    path: string;
    owner: string;
    name: string;
    baseBranch: string;
    branchPrefix: string;
  };
  github: {
    auth: 'gh-cli';
    pollIntervalSeconds: number;
    /** Verified login of the Copilot PR review bot. */
    copilotReviewerLogin: string;
  };
  agents: Record<string, AgentProfile>;
  pipeline: PhaseConfig[];
  server: { port: number };
  /** How a spawn opens its terminal. Default 'wt'. */
  launcher?: LauncherKind;
}
