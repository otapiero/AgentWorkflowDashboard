import { T3_TIMEOUT_MS } from './paths.ts';
import { discoverT3, t3Url } from './discovery.ts';
import { T3TokenStore, hasCachedT3Token, readPairingCredential } from './auth.ts';
import {
  dispatchResultSchema,
  safeParseT3,
  snapshotSchema,
  type T3Snapshot,
} from './schemas.ts';

/**
 * Everything Mission Control asks of T3 Code, over REST only.
 *
 * Two calls carry the whole integration: one snapshot per reconcile interval
 * for liveness, and one dispatch per spawn. Neither ever throws — both are on
 * paths where a throw would take out the board to report that an optional
 * signal is unavailable.
 *
 * T3 also publishes a WebSocket that streams the same orchestration events
 * live. It is deliberately unused: a socket is a second lifecycle to own
 * (reconnect, backoff, replay after a T3 restart) bought for a signal the
 * poller already refreshes on its own cadence. One snapshot per reconcile is
 * the same budget discipline the batched GitHub call follows.
 *
 * The 401 policy is deliberately not a loop: one re-exchange and one retry,
 * then give up until the next interval. A credential that has been revoked
 * cannot be fixed by trying harder.
 */

export type T3Status =
  | { ok: true; origin: string; serverVersion: string; capabilities: Record<string, unknown> }
  | { ok: false; reason: string; detail: string };

export interface T3ClientOptions {
  fetchImpl?: typeof fetch;
  /** Overrides the on-disk credential; tests pass it explicitly. */
  credential?: string | null;
}

export class T3Client {
  private readonly fetchImpl: typeof fetch;
  private readonly credential: string | null;
  private tokens: T3TokenStore | null = null;
  private tokensOrigin: string | null = null;
  private loggedValidationFailure = false;

  constructor(options: T3ClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.credential =
      options.credential !== undefined ? options.credential : readPairingCredential();
  }

  /**
   * A store is worth building when there is *either* a pairing token to
   * exchange or an access token already on disk. Requiring the pairing token
   * would lock the board out the moment that single-use token was spent, even
   * though the 30-day access token it bought is sitting right there.
   */
  private tokenStore(origin: string): T3TokenStore | null {
    if (!this.credential && !hasCachedT3Token()) return null;
    // Rebuild if T3 restarted on a different port; a token is origin-scoped.
    if (!this.tokens || this.tokensOrigin !== origin) {
      this.tokens = new T3TokenStore(origin, this.credential, this.fetchImpl);
      this.tokensOrigin = origin;
    }
    return this.tokens;
  }

  async status(): Promise<T3Status> {
    const discovery = await discoverT3(this.fetchImpl);
    if (!discovery.ok) {
      return { ok: false, reason: discovery.reason, detail: discovery.detail };
    }
    const tokens = this.tokenStore(discovery.origin);
    if (!tokens) {
      return {
        ok: false,
        reason: 'no-credential',
        detail:
          'T3 is running but Mission Control has no credential. In T3, go to Settings -> This environment -> Authorized clients -> Create link, copy the "This machine" pairing URL, and save it to ~/.mission-control/t3-credential. The link is single-use and expires within minutes, so save it straight away.',
      };
    }
    if (!(await tokens.getToken())) {
      return {
        ok: false,
        reason: 'credential-rejected',
        detail: tokens.lastError ?? 'the pairing credential was not accepted',
      };
    }
    return {
      ok: true,
      origin: discovery.origin,
      serverVersion: discovery.serverVersion,
      capabilities: discovery.capabilities,
    };
  }

  /**
   * One authenticated request, with a single 401 re-exchange and retry.
   * Returns the Response, or null when T3 is unavailable for any reason.
   */
  private async request(path: string, init: RequestInit = {}): Promise<Response | null> {
    const discovery = await discoverT3(this.fetchImpl);
    if (!discovery.ok) return null;

    const tokens = this.tokenStore(discovery.origin);
    if (!tokens) return null;

    const send = async (token: string): Promise<Response> =>
      this.fetchImpl(t3Url(discovery.origin, path), {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(T3_TIMEOUT_MS),
      });

    try {
      const token = await tokens.getToken();
      if (!token) return null;

      let res = await send(token);
      if (res.status === 401) {
        // The token went stale. Exchange once more and retry once. A second
        // 401 means the credential itself is bad, which retrying cannot fix.
        tokens.invalidate();
        const fresh = await tokens.getToken();
        if (!fresh) return null;
        res = await send(fresh);
      }
      return res;
    } catch {
      return null;
    }
  }

  async fetchSnapshot(): Promise<T3Snapshot | undefined> {
    const res = await this.request('/api/orchestration/snapshot');
    if (!res || !res.ok) return undefined;

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return undefined;
    }

    const parsed = safeParseT3(snapshotSchema, body);
    if (!parsed && !this.loggedValidationFailure) {
      // Once per client, not once per task: a schema drift would otherwise
      // print a line for every card on every poll.
      this.loggedValidationFailure = true;
      console.error(
        "[mc] T3's orchestration snapshot did not match the expected shape; session liveness is unavailable until this is fixed. Check the pinned T3 version.",
      );
    }
    return parsed;
  }

  async dispatch(
    command: unknown,
  ): Promise<{ ok: true; sequence: number } | { ok: false; error: string }> {
    const res = await this.request('/api/orchestration/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });

    if (!res) {
      const status = await this.status();
      return {
        ok: false,
        error: status.ok ? 'T3 Code could not be reached.' : status.detail,
      };
    }

    const text = await res.text();
    if (!res.ok) {
      // Surface T3's own message verbatim — it names the real problem far
      // better than anything this layer could infer from a status code.
      let message = text;
      try {
        const parsed = JSON.parse(text);
        message = parsed.message ?? parsed.error ?? text;
      } catch {
        // Not JSON; the raw text is the best available message.
      }
      return { ok: false, error: `T3 rejected the command (${res.status}): ${message}` };
    }

    let parsed;
    try {
      parsed = safeParseT3(dispatchResultSchema, JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    // A 2xx with an unrecognised body still means the command was accepted.
    return { ok: true, sequence: parsed?.sequence ?? 0 };
  }
}
