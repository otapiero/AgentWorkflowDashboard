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

/** A configured agent name, or one of the two non-agent pipeline actors. */
export type Actor = string;

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

/** A spawn believed to be running, from a pwsh PID or from a T3 session. */
export interface LiveSpawn {
  phase: Phase;
  /** The pwsh PID for wt/vscode launches; null when T3 supplies liveness. */
  pid: number | null;
  startedAt: string;
  /** Which signal established this. 't3' means a live orchestration session. */
  source: 'marker' | 't3';
}

/** One artifact a planning run produced, copied into the task's own folder. */
export interface ArtifactRef {
  name: string;
  /** Path relative to the task dir, e.g. 'artifacts/2026-foo-design.md'. */
  storedPath: string;
  /** 'taskdir' = written beside plan.md; 'repo' = written into the checkout. */
  origin: 'taskdir' | 'repo';
  /** Absolute path the artifact was first found at. */
  originalPath: string;
}

/** The "before" picture captured at plan spawn, used to attribute artifacts. */
export interface PlanSnapshot {
  takenAt: string;
  /** File names present in the task dir (excluding MC's own bookkeeping). */
  taskDirFiles: string[];
  /** `git status --porcelain` paths in the worktree at spawn time. */
  repoStatus: string[];
  /** Extra watched roots: absolute root path -> file names present. */
  extraRoots: Record<string, string[]>;
}

export interface Facts {
  issue: number;
  worktreeExists: boolean;
  branchExists: boolean;
  /** Marker file names present, e.g. ['plan.done', 'implement.running']. */
  markers: string[];
  planMdExists: boolean;
  /** Artifacts a plan run produced, from artifacts.json. Empty when none. */
  artifacts: ArtifactRef[];
  /** Branch has commits that exist on the remote. */
  hasPushedCommits: boolean;
  /** Uncommitted files in the worktree. Surfaced as a badge, never a gate. */
  dirtyFileCount: number;
  /** Local commits not yet on the remote. Surfaced as a badge, never a gate. */
  unpushedCommits: number;
  /** Non-null only when a `<phase>.running` marker names a live process. */
  liveSpawn: LiveSpawn | null;
  /**
   * Live session state from T3 Code, when the task has a recorded thread and
   * T3 is reachable. Absent means "no information", never "not running" —
   * which is why every consumer must fall back rather than conclude.
   */
  t3?: {
    threadId: string;
    sessionStatus:
      | 'idle'
      | 'starting'
      | 'running'
      | 'ready'
      | 'interrupted'
      | 'stopped'
      | 'error';
    activeTurnId: string | null;
    awaitingApproval: boolean;
    lastError: string | null;
    /**
     * The operator has closed this thread out in T3 — settled or archived.
     * A thread keeps its last session state afterwards, so this is what stops
     * a finished run from reading as live forever.
     */
    settled: boolean;
  };
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

export interface EditorIntegrationState {
  workspacePath: string;
  worktreeExists: boolean;
  liveSpawn: LiveSpawn | null;
  checks: ChecksState;
  review: Facts['review'];
  approvalRequired: boolean;
}

export interface HealthResponse {
  status: 'ok';
  apiVersion: number;
  serverVersion: string;
  pid: number;
  startedAt: string;
  /**
   * Echo of `MC_INSTANCE_ID`, the token a spawner injected when it launched this
   * server; null when nobody claimed it (a manual `npm start`).
   *
   * A spawner cannot recognise its own server by PID: it launches `npm start`,
   * which forks cmd -> tsx -> node, so the PID it holds is the wrapper's while
   * `pid` above is the server's. This is the identity that survives the chain.
   */
  instanceId: string | null;
}

/** A configured agent with the launch choices exposed to the dashboard. */
export interface AgentInfo {
  name: string;
  models: string[];
  efforts: string[];
  hasEffort: boolean;
  /** Configured defaults used when no task or phase override applies. */
  defaultModel?: string;
  defaultEffort?: string;
}

/** Configuration DTO returned by the local Mission Control API. */
export interface BoardConfig {
  repo: { path: string; owner: string; name: string; baseBranch: string; branchPrefix: string };
  pipeline: PhaseConfig[];
  agents: AgentInfo[];
  phaseDefaults: PhaseDefaults;
  launcher: LauncherKind;
}

export type BadgeKind =
  | 'live'
  | 'stale-spawn'
  | 't3-error'
  | 'plan-ready'
  | 'dirty'
  | 'unpushed'
  | 'ci'
  | 'copilot'
  | 'review'
  | 'approved'
  | 'artifacts-in-repo'
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
  artifacts: ArtifactRef[];
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
  /** The T3 thread this spawn created, when the launcher was 't3'. */
  threadId?: string;
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
  /** Last observed PR state; persisted so merged tasks can be frozen. */
  prState?: PrState | null;
  /** ISO time merge was first observed; enables the done-freeze. */
  mergedAt?: string | null;
  manualPhase: Phase | null;
  overrides?: TaskOverrides;
  spawnHistory: SpawnRecord[];
  lastReconciledAt: string | null;
  notes?: string;
}

export interface TaskWithDerived extends TaskRecord {
  derived: DerivedState;
  integration: EditorIntegrationState;
  /** Agent + model + effort that a spawn at the current phase would use. */
  pinned: { agent: string | null; model: string | null; effort: string | null };
  /**
   * True when the last reconcile could not reach GitHub for this task. The
   * derived state is then the last good one, held in place rather than blanked.
   */
  unreachable?: boolean;
}

/** GitHub API budget, surfaced so a spawn storm is visible before it bites. */
export interface RateLimit {
  remaining: number;
  limit: number;
  /** ISO time the window resets. */
  resetAt: string;
}

/**
 * The per-cycle heartbeat, sent on every poll even when the board is unchanged,
 * so freshness and budget update without re-pushing the whole board.
 */
export interface PollMeta {
  checkedAt: string;
  rateLimit: RateLimit | null;
}

/** Per-phase default agent/model/effort, layered over config.yaml, not editing it. */
export type PhaseDefaults = Record<
  string,
  { agent?: string; model?: string; effort?: string }
>;

export type LauncherKind = 'wt' | 'vscode' | 't3';

/** T3's per-thread permission level. */
export type T3RuntimeMode =
  | 'approval-required'
  | 'auto-accept-edits'
  | 'auto'
  | 'full-access';

/** T3's per-thread interaction style. 'plan' is its native planning mode. */
export type T3InteractionMode = 'default' | 'plan';

export interface T3PhaseModes {
  runtimeMode: T3RuntimeMode;
  interactionMode: T3InteractionMode;
}

/**
 * Per-phase modes used when config.yaml does not set them.
 *
 * Chosen to match each phase's intent, not validated by use — which is exactly
 * why they are configuration. Note that none of them is 'full-access': T3's own
 * decoding default is, so falling through to T3 would silently grant more than
 * any phase here asks for.
 */
export const DEFAULT_T3_MODES: Record<string, T3PhaseModes> = {
  plan: { runtimeMode: 'approval-required', interactionMode: 'plan' },
  implement: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
  publish: { runtimeMode: 'approval-required', interactionMode: 'default' },
  copilot_review: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
  dev_review: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
};

/** The safe floor for a phase nobody configured. Never 'full-access'. */
const T3_MODE_FLOOR: T3PhaseModes = {
  runtimeMode: 'approval-required',
  interactionMode: 'default',
};

export function t3ModesForPhase(phase: PhaseConfig): T3PhaseModes {
  return phase.t3 ?? DEFAULT_T3_MODES[phase.id] ?? T3_MODE_FLOOR;
}

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
  /** The T3 project id, created once lazily and reused by later spawns. */
  t3ProjectId?: string;
}

// --- config.yaml ---------------------------------------------------------

/**
 * How to drive one agent CLI. Profiles describe invocation differences rather
 * than baking provider names into the orchestrator.
 */
export interface AgentProfile {
  launch: string;
  /** 'positional' => `agent "<prompt>"`; 'flag' => `agent -i "<prompt>"`. */
  promptMode: 'positional' | 'flag';
  promptFlag?: string;
  /** Where prompt arguments appear relative to all other args. Default 'first'. */
  promptPosition?: 'first' | 'last';
  modelFlag?: string;
  model?: string;
  /** Models offered in the picker. Falls back to a built-in list per agent. */
  models?: string[];
  /** Flag that sets reasoning effort, e.g. '--effort'. Omit if unsupported. */
  effortFlag?: string;
  /** Optional argument template, e.g. `model_reasoning_effort="{{effort}}"`. */
  effortValueTemplate?: string;
  /** Effort levels offered in the picker. Falls back to a built-in list. */
  efforts?: string[];
  effort?: string;
  /** 'flag' => pass via instructionFlag; 'inline' => prepend into the prompt body. */
  instructionMode: 'flag' | 'inline';
  instructionFlag?: string;
  /** Extra args; {{taskDir}} and {{worktree}} are expanded at spawn time. */
  extraArgs?: string[];
  /**
   * The T3 provider instance that runs this agent on the 't3' launcher, e.g.
   * 'claudeAgent'. An agent without one is not launchable through T3.
   */
  t3Instance?: string;
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
  /** Per-phase T3 modes. Both fields required together; see t3ModesForPhase. */
  t3?: T3PhaseModes;
}

export interface Config {
  repo: {
    path: string;
    owner: string;
    name: string;
    baseBranch: string;
    branchPrefix: string;
    /** Extra absolute dirs to also diff for artifacts. Ships empty. */
    artifactRoots?: string[];
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
  /** T3 Code integration settings. Absent means the 't3' launcher is unconfigured. */
  t3?: {
    /** Title of the T3 project Mission Control creates. Default 'Acme'. */
    projectTitle?: string;
    /** T3 version the recorded fixtures were captured against. */
    pinnedVersion?: string;
  };
}
