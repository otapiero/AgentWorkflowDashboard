import { z } from 'zod';

/**
 * What Mission Control is willing to believe from T3 Code.
 *
 * Every schema here covers only the fields this integration consumes, and
 * every object is non-strict, so an upstream release that *adds* a field is a
 * no-op. A release that *changes* one we depend on fails the parse, and
 * safeParseT3 turns that into `undefined` rather than a throw. That is the
 * whole degradation guarantee: an upstream change costs liveness, never
 * correctness.
 *
 * Discovery, auth and provider files originated with T3 Code 0.0.31. The
 * protocol 2 shell contract was verified against T3 Code 0.1.0.
 */

export const serverRuntimeSchema = z.object({
  version: z.number(),
  pid: z.number(),
  host: z.string().optional(),
  port: z.number(),
  origin: z.string().min(1),
  startedAt: z.string().optional(),
});
export type ServerRuntime = z.infer<typeof serverRuntimeSchema>;

export const environmentDescriptorSchema = z.object({
  environmentId: z.string(),
  label: z.string().optional(),
  serverVersion: z.string(),
  // Deliberately opaque: this is upstream's own statement of what the server
  // can do, it will grow, and doctor prints it verbatim.
  capabilities: z.record(z.string(), z.unknown()).default({}),
});
export type EnvironmentDescriptor = z.infer<typeof environmentDescriptorSchema>;

export const authSessionSchema = z.object({
  authenticated: z.boolean(),
  auth: z.object({
    policy: z.enum([
      'desktop-managed-local',
      'loopback-browser',
      'remote-reachable',
      'unsafe-no-auth',
    ]),
    bootstrapMethods: z.array(z.string()).default([]),
    sessionMethods: z.array(z.string()).default([]),
    sessionCookieName: z.string().optional(),
  }),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const accessTokenSchema = z.object({
  access_token: z.string().min(1),
  issued_token_type: z.string().optional(),
  token_type: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
});
export type AccessToken = z.infer<typeof accessTokenSchema>;

export const providerCacheSchema = z.object({
  displayName: z.string(),
  enabled: z.boolean(),
  installed: z.boolean(),
  status: z.string(),
  version: z.string().nullable().optional(),
  auth: z.object({ status: z.string() }).loose().optional(),
  message: z.string().optional(),
  models: z
    .array(
      z
        .object({
          slug: z.string(),
          capabilities: z
            .object({
              // Only 'select' descriptors matter here: the effort scale is one.
              // Boolean ones (fastMode) carry no options array, so they are
              // dropped rather than failing the parse.
              optionDescriptors: z
                .array(
                  z
                    .object({
                      id: z.string(),
                      type: z.string(),
                      options: z
                        .array(z.object({ id: z.string() }).loose())
                        .default([]),
                    })
                    .loose(),
                )
                .default([]),
            })
            .loose()
            .optional(),
        })
        .loose(),
    )
    .default([]),
});
export type ProviderCache = z.infer<typeof providerCacheSchema>;

/**
 * Session status is a closed set on purpose.
 *
 * Liveness is derived from it, so an unrecognised value must fail the parse and
 * drop us back to PID liveness. Silently treating an unknown status as "not
 * running" would show a working agent as dead.
 */
export const sessionStatusSchema = z.enum([
  'idle',
  'starting',
  'running',
  'ready',
  'interrupted',
  'stopped',
  'error',
]);
export type T3SessionStatus = z.infer<typeof sessionStatusSchema>;

const activitySchema = z.object({
  id: z.string(),
  tone: z.enum(['info', 'tool', 'approval', 'error']),
  kind: z.string().optional(),
  summary: z.string().optional(),
});

const sessionSchema = z.object({
  threadId: z.string(),
  status: sessionStatusSchema,
  activeTurnId: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
});

const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  branch: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  activities: z.array(activitySchema).default([]),
  session: sessionSchema.nullable().default(null),
  // The four ways a thread stops being something anyone is working on. A
  // thread keeps its last session state after any of them, so ignoring these
  // leaves a card showing "running" forever.
  deletedAt: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  settledAt: z.string().nullable().optional(),
  settledOverride: z.enum(['settled', 'active']).nullable().optional(),
});
export type T3SnapshotThread = z.infer<typeof threadSchema>;

export const snapshotSchema = z.object({
  snapshotSequence: z.number().optional(),
  projects: z
    .array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          workspaceRoot: z.string(),
          // Read because T3's one-project-per-workspace-root invariant applies
          // to *active* projects only; a soft-deleted one neither blocks a
          // create nor is safe to adopt.
          deletedAt: z.string().nullable().optional(),
        })
        .loose(),
    )
    .default([]),
  // Required, unlike `projects`, and that asymmetry is load-bearing: a real
  // snapshot always carries the array, so demanding it is what stops an error
  // body ({ error: 'unauthorized' }) from parsing as a snapshot with no
  // threads. Defaulted, an auth failure would read as "nothing is running"
  // and quietly mark every live session dead.
  threads: z.array(threadSchema),
});
export type T3Snapshot = z.infer<typeof snapshotSchema>;

const runStatusSchema = z.enum([
  'idle', 'preparing', 'queued', 'starting', 'running', 'waiting',
  'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back',
]);

const shellThreadSchema = threadSchema.omit({ activities: true, session: true }).extend({
  status: runStatusSchema,
  activeRunId: z.string().nullable(),
  activityRunStatus: z.enum(['preparing', 'starting', 'running', 'waiting']).nullable().optional(),
  pendingRuntimeRequest: z.object({ id: z.string(), kind: z.string() }).nullable(),
  lastError: z.string().nullable().optional(),
});

/** Protocol 2 exposes run state on the shell, rather than a V1 session. */
export const shellSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  snapshotSequence: z.number(),
  projects: snapshotSchema.shape.projects.removeDefault(),
  threads: z.array(shellThreadSchema),
  archivedThreads: z.array(shellThreadSchema),
}).transform((shell): T3Snapshot => ({
  snapshotSequence: shell.snapshotSequence,
  projects: shell.projects,
  threads: [...shell.threads, ...shell.archivedThreads].map((thread) => {
    const status = thread.activityRunStatus ?? thread.status;
    const sessionStatus: T3SessionStatus =
      status === 'preparing' || status === 'queued' || status === 'starting' ? 'starting' :
      status === 'running' || status === 'waiting' ? 'running' :
      status === 'failed' ? 'error' :
      status === 'interrupted' ? 'interrupted' :
      status === 'idle' ? 'idle' : 'stopped';
    return {
      ...thread,
      activities: thread.pendingRuntimeRequest
        ? [{ id: thread.pendingRuntimeRequest.id, tone: 'approval' as const }] : [],
      session: {
        threadId: thread.id,
        status: sessionStatus,
        activeTurnId: thread.activeRunId,
        lastError: thread.lastError ?? null,
      },
    };
  }),
}));

/**
 * Parse a T3 response, or give up quietly.
 *
 * Returning undefined rather than throwing is the load-bearing decision: every
 * caller is on the reconcile path, where a throw would take out the whole
 * board to report that one optional badge is unavailable.
 */
export function safeParseT3<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}
