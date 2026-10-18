import { T3_TIMEOUT_MS } from './paths.ts';
import { discoverT3, t3Url } from './discovery.ts';
import { T3TokenStore, hasCachedT3Token, readPairingCredential } from './auth.ts';
import { callT3Rpc } from './rpc.ts';
import type { ThreadLaunchInput } from './commands.ts';
import {
  safeParseT3,
  shellSnapshotSchema,
  type T3Snapshot,
} from './schemas.ts';

/**
 * Protocol 2 uses HTTP shell snapshots and project mutations. Thread launch
 * uses a short-lived authenticated RPC socket, closed after its one response.
 * Polling remains HTTP; no live subscription or reconnect loop is needed.
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

/** The request may already have created a run, even when its reply was lost. */
export class UnconfirmedT3LaunchError extends Error {
  constructor(readonly threadId: string, cause: unknown) {
    super(`${cause instanceof Error ? cause.message : String(cause)} (T3 thread ${threadId})`, { cause });
    this.name = 'UnconfirmedT3LaunchError';
  }
}

export class T3Client {
  private readonly fetchImpl: typeof fetch;
  private readonly credential: string | null;
  private tokens: T3TokenStore | null = null;
  private tokensOrigin: string | null = null;
  private loggedValidationFailure = false;
  private snapshotError = 'T3 session status is unavailable';

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
    if (!(await this.fetchSnapshot())) {
      return { ok: false, reason: 'snapshot-unavailable', detail: this.snapshotError };
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
    if (!discovery.ok) {
      this.snapshotError = `T3 is unavailable (${discovery.reason}): ${discovery.detail}`;
      return null;
    }

    const tokens = this.tokenStore(discovery.origin);
    if (!tokens) {
      this.snapshotError = 'Mission Control has no T3 credential. Run npm run mc -- doctor for pairing instructions.';
      return null;
    }

    const send = async (token: string): Promise<Response> =>
      this.fetchImpl(t3Url(discovery.origin, path), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}`,
          'x-t3-orchestration-protocol': '2' },
        signal: AbortSignal.timeout(T3_TIMEOUT_MS),
      });

    try {
      const token = await tokens.getToken();
      if (!token) {
        this.snapshotError = tokens.lastError ?? 'T3 authorization failed';
        return null;
      }

      let res = await send(token);
      if (res.status === 401) {
        // The token went stale. Exchange once more and retry once. A second
        // 401 means the credential itself is bad, which retrying cannot fix.
        tokens.invalidate();
        const fresh = await tokens.getToken();
        if (!fresh) {
          this.snapshotError = tokens.lastError ?? 'T3 authorization failed';
          return null;
        }
        res = await send(fresh);
      }
      return res;
    } catch {
      this.snapshotError = 'T3 could not be reached before the request timed out';
      return null;
    }
  }

  async fetchSnapshot(): Promise<T3Snapshot | undefined> {
    const res = await this.request('/api/orchestration/shell');
    if (!res) return undefined;
    if (!res.ok) {
      this.snapshotError = await responseError(res);
      return undefined;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      this.snapshotError = 'T3 /api/orchestration/shell returned non-JSON content. This T3 version does not provide the expected protocol 2 API; update T3 or Mission Control.';
      return undefined;
    }

    const parsed = safeParseT3(shellSnapshotSchema, body);
    if (!parsed) this.snapshotError = "T3's protocol 2 shell snapshot has an unsupported shape. Update Mission Control for this T3 version.";
    if (!parsed && !this.loggedValidationFailure) {
      // Once per client, not once per task: a schema drift would otherwise
      // print a line for every card on every poll.
      this.loggedValidationFailure = true;
      console.error(
        `[mc] ${this.snapshotError}`,
      );
    }
    return parsed;
  }

  async requireSnapshot(): Promise<T3Snapshot> {
    const snapshot = await this.fetchSnapshot();
    if (!snapshot) throw new Error(`Cannot check the existing T3 run: ${this.snapshotError}`);
    return snapshot;
  }

  async createProject(
    command: unknown,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = await this.request('/api/projects/mutate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });

    if (!res) {
      return { ok: false, error: this.snapshotError };
    }

    if (!res.ok) {
      return { ok: false, error: await responseError(res) };
    }

    try {
      const body = await res.json();
      if (typeof body?.id === 'string' && body.id.length > 0) return { ok: true };
    } catch {
      return { ok: false, error: 'T3 project mutation returned non-JSON content; check API compatibility.' };
    }
    return { ok: false, error: 'T3 project mutation returned an unsupported response.' };
  }

  async launchThread(input: ThreadLaunchInput): Promise<string> {
    const res = await this.request('/api/auth/websocket-ticket', { method: 'POST' });
    if (!res) throw new Error(this.snapshotError);
    if (!res.ok) throw new Error(await responseError(res));
    let ticket: unknown;
    try { ticket = (await res.json()).ticket; } catch { /* Validated below. */ }
    if (typeof ticket !== 'string' || !ticket || !this.tokensOrigin) {
      throw new Error('T3 returned an unsupported WebSocket ticket response.');
    }
    const url = new URL('/ws', this.tokensOrigin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('wsTicket', ticket);
    url.searchParams.set('orchestrationProtocol', '2');
    try {
      const result = await callT3Rpc(url, 'orchestration.launchThread', input) as { threadId?: unknown } | null;
      if (result?.threadId !== input.threadId) {
        throw new Error('T3 returned an unexpected thread id; check the thread in T3 before retrying the launch.');
      }
    } catch (error) {
      throw new UnconfirmedT3LaunchError(input.threadId, error);
    }
    return input.threadId;
  }
}

async function responseError(res: Response): Promise<string> {
  let text: string;
  try { text = await res.text(); } catch {
    return `T3 rejected the request (${res.status}); its error response could not be read.`;
  }
  let message = text;
  try {
    const body = JSON.parse(text);
    message = body.message ?? body.reason ?? body.error ?? body.code ?? text;
  } catch { /* Preserve an upstream plain-text error. */ }
  return `T3 rejected the request (${res.status}): ${message}`;
}
