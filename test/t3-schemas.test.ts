import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  t3Home,
  t3ServerRuntimePath,
  t3ProviderCachePath,
} from '../src/orchestrator/t3/paths.ts';
import {
  serverRuntimeSchema,
  environmentDescriptorSchema,
  authSessionSchema,
  accessTokenSchema,
  providerCacheSchema,
  snapshotSchema,
  dispatchResultSchema,
  safeParseT3,
} from '../src/orchestrator/t3/schemas.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  process.env.T3_HOME = home;
});

afterEach(() => {
  delete process.env.T3_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('t3 paths', () => {
  test('T3_HOME overrides the location so tests never touch the real ~/.t3', () => {
    expect(t3Home()).toBe(home);
  });

  test('the runtime file sits under userdata, where T3 writes it', () => {
    expect(t3ServerRuntimePath()).toBe(join(home, 'userdata', 'server-runtime.json'));
  });

  test('provider readiness is one file per instance under caches', () => {
    expect(t3ProviderCachePath('codex')).toBe(join(home, 'caches', 'codex.json'));
  });
});

describe('serverRuntimeSchema', () => {
  // Captured verbatim from a running T3 Code 0.0.31 desktop instance.
  const real = {
    version: 1,
    pid: 5132,
    host: '127.0.0.1',
    port: 3773,
    origin: 'http://127.0.0.1:3773',
    startedAt: '2026-08-07T09:09:13.504Z',
  };

  test('accepts the real recorded shape', () => {
    expect(safeParseT3(serverRuntimeSchema, real)).toEqual(real);
  });

  test('tolerates fields we do not consume being added upstream', () => {
    const parsed = safeParseT3(serverRuntimeSchema, { ...real, devUrl: 'http://x' });
    expect(parsed?.origin).toBe('http://127.0.0.1:3773');
  });

  test('rejects a runtime file with no origin, rather than guessing one', () => {
    const { origin, ...withoutOrigin } = real;
    expect(safeParseT3(serverRuntimeSchema, withoutOrigin)).toBeUndefined();
  });

  test('rejects a non-numeric pid, since liveness depends on it', () => {
    expect(safeParseT3(serverRuntimeSchema, { ...real, pid: 'nope' })).toBeUndefined();
  });
});

describe('environmentDescriptorSchema', () => {
  const real = {
    environmentId: '9e975bfc-a60a-48f1-8544-a3541aa16287',
    label: 'DESKTOP-BU3FRL8',
    platform: { os: 'windows', arch: 'x64' },
    serverVersion: '0.0.31',
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
      threadSettlement: true,
      threadSnooze: true,
      serverSelfUpdate: 'desktop-managed',
    },
  };

  test('accepts the real recorded shape and exposes the version pin', () => {
    expect(safeParseT3(environmentDescriptorSchema, real)?.serverVersion).toBe('0.0.31');
  });

  test('keeps capabilities as an opaque record so new ones do not break it', () => {
    const parsed = safeParseT3(environmentDescriptorSchema, {
      ...real,
      capabilities: { ...real.capabilities, somethingNew: 42 },
    });
    expect(parsed?.capabilities.somethingNew).toBe(42);
  });
});

describe('authSessionSchema', () => {
  const real = {
    authenticated: false,
    auth: {
      policy: 'desktop-managed-local',
      bootstrapMethods: ['desktop-bootstrap'],
      sessionMethods: ['browser-session-cookie', 'bearer-access-token', 'dpop-access-token'],
      sessionCookieName: 't3_session_3773',
    },
  };

  test('accepts the real recorded shape', () => {
    expect(safeParseT3(authSessionSchema, real)?.auth.policy).toBe('desktop-managed-local');
  });

  test('accepts an authenticated session too', () => {
    expect(safeParseT3(authSessionSchema, { ...real, authenticated: true })?.authenticated).toBe(true);
  });
});

describe('accessTokenSchema', () => {
  test('accepts the OAuth token-exchange reply', () => {
    const parsed = safeParseT3(accessTokenSchema, {
      access_token: 'abc123',
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'orchestration:read orchestration:operate',
    });
    expect(parsed?.access_token).toBe('abc123');
    expect(parsed?.expires_in).toBe(3600);
  });

  test('rejects a reply with no access token', () => {
    expect(safeParseT3(accessTokenSchema, { token_type: 'Bearer', expires_in: 60 })).toBeUndefined();
  });
});

describe('providerCacheSchema', () => {
  // Captured verbatim from ~/.t3/caches/codex.json.
  const codex = {
    displayName: 'Codex',
    enabled: true,
    installed: true,
    status: 'ready',
    version: '0.146.0',
    auth: { status: 'authenticated', type: 'chatgpt' },
    models: [{ slug: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
  };

  test('accepts a ready, authenticated instance', () => {
    expect(safeParseT3(providerCacheSchema, codex)?.status).toBe('ready');
  });

  test('accepts an errored instance — not-installed is data, not a parse failure', () => {
    const parsed = safeParseT3(providerCacheSchema, {
      displayName: 'OpenCode',
      enabled: true,
      installed: false,
      status: 'error',
      version: null,
      auth: { status: 'unknown' },
      models: [],
    });
    expect(parsed?.installed).toBe(false);
    expect(parsed?.status).toBe('error');
  });

  test('defaults a missing models array to empty rather than failing', () => {
    const { models, ...withoutModels } = codex;
    expect(safeParseT3(providerCacheSchema, withoutModels)?.models).toEqual([]);
  });
});

describe('snapshotSchema', () => {
  const thread = {
    id: 'thread-1',
    projectId: 'project-1',
    title: '#3060 plan',
    branch: 'ouriel/3060-thing',
    worktreePath: 'C:\\Users\\ouriel\\.mc\\worktrees\\issue-3060',
    activities: [{ id: 'e1', tone: 'info', kind: 'turn.started', summary: 'started' }],
    session: {
      threadId: 'thread-1',
      status: 'running',
      activeTurnId: 'turn-1',
      lastError: null,
    },
  };

  test('accepts a snapshot and exposes threads', () => {
    const parsed = safeParseT3(snapshotSchema, {
      snapshotSequence: 7,
      projects: [],
      threads: [thread],
      updatedAt: '2026-08-07T09:00:00.000Z',
    });
    expect(parsed?.threads).toHaveLength(1);
    expect(parsed?.threads[0]?.session?.status).toBe('running');
  });

  test('accepts a thread with no session — a thread that never ran is normal', () => {
    const parsed = safeParseT3(snapshotSchema, {
      snapshotSequence: 1,
      projects: [],
      threads: [{ ...thread, session: null }],
      updatedAt: '2026-08-07T09:00:00.000Z',
    });
    expect(parsed?.threads[0]?.session).toBeNull();
  });

  test('rejects an unknown session status rather than inventing liveness', () => {
    // If upstream adds a status we do not know, we must degrade, not guess
    // whether it means running.
    expect(
      safeParseT3(snapshotSchema, {
        snapshotSequence: 1,
        projects: [],
        threads: [{ ...thread, session: { ...thread.session, status: 'hibernating' } }],
        updatedAt: '2026-08-07T09:00:00.000Z',
      }),
    ).toBeUndefined();
  });

  test('rejects a body that is not a snapshot at all', () => {
    expect(safeParseT3(snapshotSchema, { error: 'unauthorized' })).toBeUndefined();
  });

  test('rejects null and undefined without throwing', () => {
    expect(safeParseT3(snapshotSchema, null)).toBeUndefined();
    expect(safeParseT3(snapshotSchema, undefined)).toBeUndefined();
  });
});

describe('dispatchResultSchema', () => {
  test('accepts the sequence T3 returns on a successful dispatch', () => {
    expect(safeParseT3(dispatchResultSchema, { sequence: 12 })?.sequence).toBe(12);
  });
});
