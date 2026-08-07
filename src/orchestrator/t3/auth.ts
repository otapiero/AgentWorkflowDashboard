import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome } from '../paths.ts';
import { T3_TIMEOUT_MS } from './paths.ts';
import { t3Url } from './discovery.ts';
import { accessTokenSchema, safeParseT3 } from './schemas.ts';

/**
 * Getting authorized to talk to T3 Code.
 *
 * Being on loopback buys nothing: the orchestration endpoints return 401 from
 * 127.0.0.1 with no credential, and Mission Control cannot bootstrap itself —
 * `desktop-bootstrap` is a handoff reserved for T3's own renderer.
 *
 * The credential is therefore minted by hand in T3, under
 * Settings -> This environment -> Authorized clients -> Create link, which
 * yields a URL of the form `http://host:3773/pair#token=XXXX`.
 *
 * Two credentials, with very different lifetimes, and conflating them is the
 * trap this module exists to avoid (all verified against T3 0.0.31 on
 * 2026-08-07):
 *
 *  - The **pairing token** from that link is `one-time-token` in T3's own
 *    vocabulary: single use, and it expires about three minutes after it is
 *    minted. It is a bootstrap method — T3's bundle is explicit that bootstrap
 *    methods "are not the long-lived credential used for ordinary
 *    authenticated traffic after pairing succeeds".
 *  - Exchanging it returns an **access token** good for 30 days
 *    (`expires_in: 2591999`), which is the credential for steady-state use.
 *
 * So the access token is persisted to ~/.mc/t3-token.json rather than
 * held in memory. Holding it in memory would mean every board restart tried to
 * re-exchange a pairing token that was spent minutes after it was created, and
 * the integration would demand a fresh pairing link on every launch.
 *
 * That file is a 30-day bearer token, so it is written under MC_HOME with the
 * rest of Mission Control's private state and never into the checkout.
 */

export const T3_SCOPES = 'orchestration:read orchestration:operate';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:t3:params:oauth:token-type:environment-bootstrap';
const REQUESTED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** Re-exchange this far before expiry, so a token never dies mid-request. */
const REFRESH_MARGIN_MS = 60_000;

export function t3CredentialPath(): string {
  return join(mcHome(), 't3-credential');
}

/** The exchanged access token, kept so a spent pairing token is never needed twice. */
export function t3TokenCachePath(): string {
  return join(mcHome(), 't3-token.json');
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

function readCachedToken(): CachedToken | null {
  try {
    const parsed = JSON.parse(readFileSync(t3TokenCachePath(), 'utf8'));
    return typeof parsed?.accessToken === 'string' &&
      parsed.accessToken.length > 0 &&
      typeof parsed?.expiresAtMs === 'number'
      ? { accessToken: parsed.accessToken, expiresAtMs: parsed.expiresAtMs }
      : null;
  } catch {
    return null;
  }
}

function writeCachedToken(token: CachedToken, scope: string | undefined): void {
  try {
    mkdirSync(mcHome(), { recursive: true });
    writeFileSync(
      t3TokenCachePath(),
      JSON.stringify({ ...token, scope, savedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch {
    // A token that cannot be persisted still works for this process. Losing
    // the cache costs a re-pair later, never the run in flight.
  }
}

/**
 * Pull the credential out of whatever T3's UI put on the clipboard.
 *
 * "Create link" hands you a pairing *URL*, not a bare token, and the token
 * lives in the **fragment**: `http://127.0.0.1:3773/pair#token=QX7T5F72X89Q`
 * (observed 2026-08-07). The fragment is deliberate on T3's part — a fragment
 * is never transmitted to a server, so the token stays out of access logs and
 * referrers. It also means `searchParams` finds nothing, which is exactly the
 * kind of near-miss that yields a 401 indistinguishable from a revoked
 * credential.
 *
 * Both the query and fragment forms are read, and a value that is not a URL is
 * passed through untouched, since "Copy code" gives a bare token.
 */
export function extractPairingCredential(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!/^https?:\/\//i.test(value)) return value;

  try {
    const url = new URL(value);
    // The fragment is where T3 actually puts it; the query string is checked
    // too because it is free and costs nothing to be wrong about.
    const sources = [
      new URLSearchParams(url.hash.replace(/^#/, '')),
      url.searchParams,
    ];
    for (const params of sources) {
      for (const name of ['token', 'code', 'credential']) {
        const found = params.get(name)?.trim();
        if (found) return found;
      }
    }
    return null;
  } catch {
    // Looked like a URL and was not one. Nothing safe to extract.
    return null;
  }
}

export function readPairingCredential(): string | null {
  try {
    return extractPairingCredential(readFileSync(t3CredentialPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** True when a previously exchanged access token is on disk and still valid. */
export function hasCachedT3Token(now: number = Date.now()): boolean {
  const cached = readCachedToken();
  return cached !== null && now < cached.expiresAtMs - REFRESH_MARGIN_MS;
}

export class T3TokenStore {
  lastError: string | null = null;

  private token: string | null = null;
  private expiresAtMs = 0;

  constructor(
    private readonly origin: string,
    /**
     * The pairing token, when one has been saved. Null is legitimate: once a
     * one-time token has been spent, the persisted access token is the only
     * credential left, and it is good for another 30 days.
     */
    private readonly credential: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
    // The persisted copy is the same dead token, so leaving it would make
    // every later call reload it and 401 again.
    try {
      rmSync(t3TokenCachePath(), { force: true });
    } catch {
      // Best effort; an unremovable cache is caught by the expiry check.
    }
  }

  async getToken(now: number = Date.now()): Promise<string | null> {
    if (this.token && now < this.expiresAtMs - REFRESH_MARGIN_MS) return this.token;

    // A token earned by an earlier process. This is what makes a board restart
    // free rather than a demand for a fresh pairing link.
    const cached = readCachedToken();
    if (cached && now < cached.expiresAtMs - REFRESH_MARGIN_MS) {
      this.token = cached.accessToken;
      this.expiresAtMs = cached.expiresAtMs;
      this.lastError = null;
      return this.token;
    }

    if (!this.credential) {
      this.lastError =
        'no usable T3 access token, and no pairing token to exchange. Create a new link in T3 under Settings -> This environment -> Authorized clients -> Create link.';
      return null;
    }

    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: this.credential,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      requested_token_type: REQUESTED_TOKEN_TYPE,
      scope: T3_SCOPES,
      client_label: 'Mission Control',
      client_device_type: 'bot',
      client_os: 'windows',
    });

    try {
      const res = await this.fetchImpl(t3Url(this.origin, '/oauth/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(T3_TIMEOUT_MS),
      });

      if (!res.ok) {
        this.invalidate();
        // Named precisely, because a pairing token is single-use and lives
        // about three minutes: "expired" here almost always means "you took
        // longer than three minutes", not "something is misconfigured".
        this.lastError = `token exchange returned ${res.status}. A T3 pairing token is single-use and expires within minutes of being created, so this one is most likely spent. Create a fresh link in T3 under Settings -> This environment -> Authorized clients -> Create link, and save it to ~/.mc/t3-credential.`;
        return null;
      }

      const parsed = safeParseT3(accessTokenSchema, await res.json());
      if (!parsed) {
        this.invalidate();
        this.lastError = 'token exchange returned a body Mission Control could not understand.';
        return null;
      }

      this.token = parsed.access_token;
      this.expiresAtMs = now + parsed.expires_in * 1000;
      this.lastError = null;
      // Persist before returning: the pairing token that bought this is now
      // spent, so this response is the only credential left.
      writeCachedToken(
        { accessToken: this.token, expiresAtMs: this.expiresAtMs },
        parsed.scope,
      );
      return this.token;
    } catch (err) {
      this.invalidate();
      this.lastError = String(err);
      return null;
    }
  }
}
