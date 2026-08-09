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
 * Recorded against T3 Code 0.0.31.
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
  models: z.array(z.object({ slug: z.string() }).loose()).default([]),
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

export const dispatchResultSchema = z.object({ sequence: z.number() });

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
