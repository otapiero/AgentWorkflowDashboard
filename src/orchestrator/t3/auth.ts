import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome } from '../paths.ts';
import { T3_TIMEOUT_MS } from './paths.ts';
import { t3Url } from './discovery.ts';
import { accessTokenSchema, safeParseT3 } from './schemas.ts';

/**
 * Getting authorized to talk to T3 Code.
 *
 * Being on loopback buys nothing: the orchestration endpoints return 401 from
 * 127.0.0.1 with no credential. And Mission Control cannot bootstrap itself —
 * the desktop server advertises `desktop-bootstrap` as its only bootstrap
 * method (a handoff reserved for T3's own renderer), and the endpoint that
 * mints credentials for other clients sits behind the authenticated middleware.
 *
 * So the pairing credential is minted once, by hand, from T3's own
 * "Create pairing link" UI, and stored at ~/.mc/t3-credential. This
 * module exchanges it for a short-lived scoped bearer token.
 *
 * The access token is cached in memory only and never written to disk: it
 * expires on its own, and a file would outlive the process that earned it.
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

export function readPairingCredential(): string | null {
  try {
    const value = readFileSync(t3CredentialPath(), 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export class T3TokenStore {
  lastError: string | null = null;

  private token: string | null = null;
  private expiresAtMs = 0;

  constructor(
    private readonly origin: string,
    private readonly credential: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
  }

  async getToken(now: number = Date.now()): Promise<string | null> {
    if (this.token && now < this.expiresAtMs - REFRESH_MARGIN_MS) return this.token;

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
        this.lastError = `token exchange returned ${res.status}. The pairing credential may be expired or revoked — mint a new pairing link in T3's settings.`;
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
      return this.token;
    } catch (err) {
      this.invalidate();
      this.lastError = String(err);
      return null;
    }
  }
}
