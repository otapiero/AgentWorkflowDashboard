import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { existsSync, readFileSync } from 'node:fs';

import { mcHome } from '../src/orchestrator/paths.ts';
import {
  T3TokenStore,
  T3_SCOPES,
  hasCachedT3Token,
  readPairingCredential,
  t3CredentialPath,
  t3TokenCachePath,
} from '../src/orchestrator/t3/auth.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  process.env.MC_HOME = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

function writeCredential(value: string): void {
  mkdirSync(mcHome(), { recursive: true });
  writeFileSync(t3CredentialPath(), value, 'utf8');
}

/** Records every request so the exchange payload can be asserted. */
function recordingFetch(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const goodToken = {
  access_token: 'tok-1',
  issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: T3_SCOPES,
};

describe('pairing credential on disk', () => {
  test('the credential lives under MC_HOME, never in the project repo', () => {
    expect(t3CredentialPath().startsWith(mcHome())).toBe(true);
  });

  test('a written credential is read back with surrounding whitespace stripped', () => {
    writeCredential('  pair-abc123\n');
    expect(readPairingCredential()).toBe('pair-abc123');
  });

  test('no credential file reads as null, not a throw', () => {
    expect(readPairingCredential()).toBeNull();
  });

  test('an empty credential file reads as null rather than an empty token', () => {
    writeCredential('   \n');
    expect(readPairingCredential()).toBeNull();
  });

  test('a pairing URL from T3s Create link button yields just the token', () => {
    // Recorded verbatim from T3 0.0.31's "Create link" button on 2026-08-07.
    // The token is in the FRAGMENT, not the query string — a fragment never
    // reaches a server, so it stays out of logs. searchParams finds nothing
    // here, and sending the whole URL as a bearer token 401s in a way that
    // reads exactly like a revoked credential.
    writeCredential('http://127.0.0.1:3773/pair#token=QX7T5F72X89Q\n');
    expect(readPairingCredential()).toBe('QX7T5F72X89Q');
  });

  test('a query-string pairing URL works too', () => {
    writeCredential('http://192.168.110.1:3773/pair?token=pair-abc123');
    expect(readPairingCredential()).toBe('pair-abc123');
  });

  test('extra query parameters on the pairing URL do not confuse it', () => {
    writeCredential('http://127.0.0.1:3773/pair?token=pair-abc123&label=mc');
    expect(readPairingCredential()).toBe('pair-abc123');
  });

  test('a URL with no recognisable token is null, not the whole URL', () => {
    // Sending a URL as a bearer credential would 401 in a way that reads as
    // "your credential was revoked", sending you to re-mint a working one.
    writeCredential('http://127.0.0.1:3773/pair');
    expect(readPairingCredential()).toBeNull();
  });
});

describe('T3TokenStore', () => {
  test('exchanges the credential for a bearer token', async () => {
    const { impl, calls } = recordingFetch([{ status: 200, body: goodToken }]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    expect(await store.getToken()).toBe('tok-1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:3773/oauth/token');
  });

  test('sends the OAuth token-exchange grant form T3 expects', async () => {
    const { impl, calls } = recordingFetch([{ status: 200, body: goodToken }]);
    await new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl).getToken();

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('subject_token')).toBe('pair-abc');
    expect(body.get('subject_token_type')).toBe(
      'urn:t3:params:oauth:token-type:environment-bootstrap',
    );
    expect(body.get('requested_token_type')).toBe(
      'urn:ietf:params:oauth:token-type:access_token',
    );
    expect(body.get('scope')).toBe(T3_SCOPES);
    expect(body.get('client_label')).toBe('Mission Control');
  });

  test('caches the token instead of exchanging on every call', async () => {
    const { impl, calls } = recordingFetch([{ status: 200, body: goodToken }]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    await store.getToken();
    await store.getToken();
    await store.getToken();
    expect(calls).toHaveLength(1);
  });

  test('re-exchanges once the token is within a minute of expiring', async () => {
    const { impl, calls } = recordingFetch([
      { status: 200, body: { ...goodToken, expires_in: 120 } },
      { status: 200, body: { ...goodToken, access_token: 'tok-2' } },
    ]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    const t0 = Date.parse('2026-08-07T09:00:00.000Z');
    expect(await store.getToken(t0)).toBe('tok-1');
    // 70s later the 120s token has under a minute left.
    expect(await store.getToken(t0 + 70_000)).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  test('invalidate forces the next call to exchange again', async () => {
    const { impl, calls } = recordingFetch([
      { status: 200, body: goodToken },
      { status: 200, body: { ...goodToken, access_token: 'tok-2' } },
    ]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    await store.getToken();
    store.invalidate();
    expect(await store.getToken()).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  test('a rejected credential yields null and records why, rather than throwing', async () => {
    const { impl } = recordingFetch([
      { status: 401, body: { error: 'invalid_grant' } },
    ]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'revoked', impl);
    expect(await store.getToken()).toBeNull();
    expect(store.lastError).toContain('401');
  });

  test('a network failure yields null rather than throwing', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', failing);
    expect(await store.getToken()).toBeNull();
    expect(store.lastError).toContain('ECONNREFUSED');
  });

  test('a malformed token reply yields null rather than a bad Authorization header', async () => {
    const { impl } = recordingFetch([{ status: 200, body: { token_type: 'Bearer' } }]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    expect(await store.getToken()).toBeNull();
  });

  /**
   * The lifetime asymmetry this whole module exists for, verified against T3
   * 0.0.31 on 2026-08-07: the pairing token is single-use and expires about
   * three minutes after it is minted, while the access token it buys is good
   * for 30 days (expires_in 2591999). Caching the access token in memory only
   * would mean every board restart tried to re-exchange a spent token.
   */
  describe('the access token outlives the process that earned it', () => {
    test('a successful exchange persists the access token', async () => {
      const { impl } = recordingFetch([{ status: 200, body: goodToken }]);
      await new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl).getToken();

      expect(existsSync(t3TokenCachePath())).toBe(true);
      expect(JSON.parse(readFileSync(t3TokenCachePath(), 'utf8')).accessToken).toBe('tok-1');
    });

    test('a fresh store reuses the persisted token instead of exchanging', async () => {
      const first = recordingFetch([{ status: 200, body: goodToken }]);
      await new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', first.impl).getToken();

      // A new process, and the pairing token has been spent — so an exchange
      // here would fail. The persisted token must carry it.
      const second = recordingFetch([{ status: 401, body: { error: 'invalid_grant' } }]);
      const store = new T3TokenStore('http://127.0.0.1:3773', 'spent', second.impl);
      expect(await store.getToken()).toBe('tok-1');
      expect(second.calls).toHaveLength(0);
    });

    test('a spent pairing token is fine when a valid access token is on disk', async () => {
      const first = recordingFetch([{ status: 200, body: goodToken }]);
      await new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', first.impl).getToken();

      // null credential: the operator never replaced the spent pairing token.
      const { impl, calls } = recordingFetch([{ status: 401, body: {} }]);
      expect(await new T3TokenStore('http://127.0.0.1:3773', null, impl).getToken()).toBe('tok-1');
      expect(calls).toHaveLength(0);
    });

    test('no credential and no cached token says so rather than exchanging nothing', async () => {
      const { impl, calls } = recordingFetch([{ status: 200, body: goodToken }]);
      const store = new T3TokenStore('http://127.0.0.1:3773', null, impl);
      expect(await store.getToken()).toBeNull();
      expect(calls).toHaveLength(0);
      expect(store.lastError).toContain('Create link');
    });

    test('an expired persisted token is not reused', async () => {
      const first = recordingFetch([{ status: 200, body: { ...goodToken, expires_in: 120 } }]);
      const t0 = Date.parse('2026-08-07T09:00:00.000Z');
      await new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', first.impl).getToken(t0);

      const { impl, calls } = recordingFetch([
        { status: 200, body: { ...goodToken, access_token: 'tok-2' } },
      ]);
      const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-2', impl);
      expect(await store.getToken(t0 + 200_000)).toBe('tok-2');
      expect(calls).toHaveLength(1);
    });

    test('invalidate removes the persisted copy, so a dead token is not reloaded', async () => {
      const { impl } = recordingFetch([{ status: 200, body: goodToken }]);
      const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
      await store.getToken();
      store.invalidate();
      expect(existsSync(t3TokenCachePath())).toBe(false);
    });

    test('hasCachedT3Token reports whether a re-pair is needed', async () => {
      expect(hasCachedT3Token()).toBe(false);
      const { impl } = recordingFetch([{ status: 200, body: goodToken }]);
      await new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl).getToken();
      expect(hasCachedT3Token()).toBe(true);
    });
  });

  test('a successful exchange clears a previous error', async () => {
    const { impl } = recordingFetch([
      { status: 401, body: {} },
      { status: 200, body: goodToken },
    ]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    await store.getToken();
    expect(store.lastError).not.toBeNull();
    store.invalidate();
    await store.getToken();
    expect(store.lastError).toBeNull();
  });
});
