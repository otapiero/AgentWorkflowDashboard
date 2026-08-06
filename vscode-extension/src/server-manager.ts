import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { HealthResponse } from '../../src/shared/types.ts';
import type { MissionControlClient } from './client/mission-control-client.ts';
import { acquireAtomicLease } from './storage/atomic-file.ts';

const readinessSchedule = [0, 100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000, 1_000] as const;
const startupLockStaleMs = 30_000;

type Spawn = (command: string, args: readonly string[], options: { cwd: string; detached: boolean; windowsHide: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface ServerManagerOptions {
  client: Pick<MissionControlClient, 'health'>;
  storagePath: string;
  serverUrl: string;
  installationPath: string | undefined;
  autoStart: boolean;
  expectedApiVersion: 1;
  process: { spawn: Spawn };
  kill: (pid: number) => void;
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
  acquireLease?: typeof acquireAtomicLease;
}

export type EnsureReadyResult =
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'incompatible'; health: HealthResponse }
  | { kind: 'configuration-error'; message: string }
  | { kind: 'unavailable'; message: string };

/** The stable identity returned by a healthy Mission Control server. */
export type ServerReady = HealthResponse;

interface ServerOwner { pid: number; startedAt: string }

export class ServerManager {
  private readonly controller = new AbortController();

  constructor(private readonly options: ServerManagerOptions) {}

  async ensureReady(): Promise<EnsureReadyResult> {
    this.throwIfAborted();
    const url = this.validateServerUrl();
    if (typeof url === 'string') return { kind: 'configuration-error', message: url };

    const current = await this.health();
    this.throwIfAborted();
    if (current) return this.fromHealth(current);
    if (!this.options.autoStart) return { kind: 'unavailable', message: 'Mission Control is unavailable and automatic startup is disabled.' };

    this.throwIfAborted();
    const lease = await (this.options.acquireLease ?? acquireAtomicLease)(join(this.options.storagePath, 'server-start.lock'), startupLockStaleMs);
    if (!lease) return this.waitForReadiness('Mission Control did not become ready while another VS Code window was starting it.');
    try {
      this.throwIfAborted();
      const afterLease = await this.health();
      this.throwIfAborted();
      if (afterLease) return this.fromHealth(afterLease);

      const installationError = await this.validateInstallation();
      this.throwIfAborted();
      if (installationError) return { kind: 'configuration-error', message: installationError };
      this.throwIfAborted();
      // We cannot recognise our own server by PID. `npm start` forks
      // cmd -> tsx -> node, so `child.pid` is the npm wrapper's while /health
      // reports the leaf node's — they never match, and the old equality check
      // meant ownership was never recorded and the server could never be
      // restarted. An injected id is the identity that survives the fork chain.
      const instanceId = randomUUID();
      const child = this.options.process.spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start'], {
        cwd: this.options.installationPath!, detached: true, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, MC_PORT: url.port || '4317', MC_INSTANCE_ID: instanceId },
      });
      child.unref();

      for (const wait of readinessSchedule) {
        this.throwIfAborted();
        try {
          await this.options.delay(wait, this.controller.signal);
        } catch {
          this.throwIfAborted();
          return { kind: 'unavailable', message: 'Mission Control startup was cancelled.' };
        }
        this.throwIfAborted();
        const ready = await this.health();
        this.throwIfAborted();
        if (ready) {
          // Record the server's own PID, not the wrapper's, so a later restart
          // signals the process actually holding the port. A server that came
          // up without our id is a stranger — most likely a manual `npm start`
          // that won the race — and we must not claim the right to kill it.
          if (ready.instanceId !== null && ready.instanceId === instanceId) {
            this.throwIfAborted();
            await this.writeOwner({ pid: ready.pid, startedAt: ready.startedAt });
          }
          return this.fromHealth(ready);
        }
      }
      return { kind: 'unavailable', message: 'Mission Control did not become ready in time.' };
    } finally {
      await lease.release();
    }
  }

  async restartOwned(): Promise<boolean> {
    const owner = await this.readOwner();
    const current = await this.health();
    if (owner && current && owner.pid === current.pid && owner.startedAt === current.startedAt) {
      this.options.kill(owner.pid);
      try { await unlink(this.ownerFile()); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return true;
    }
    return false;
  }

  dispose(): void { this.controller.abort(); }

  private validateServerUrl(): URL | string {
    try {
      const url = new URL(this.options.serverUrl);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
        || url.username !== '' || url.password !== '' || url.pathname !== '/'
        || url.search !== '' || url.hash !== '') return 'Mission Control server URL must be a credential-free loopback HTTP origin.';
      return url;
    } catch { return 'Mission Control server URL is malformed.'; }
  }

  private async validateInstallation(): Promise<string | null> {
    if (!this.options.installationPath) return 'Mission Control installation path is not configured.';
    try {
      const value: unknown = JSON.parse(await readFile(join(this.options.installationPath, 'package.json'), 'utf8'));
      const pkg = value as { name?: unknown; scripts?: { start?: unknown } };
      if (pkg.name !== 'mission-control' || typeof pkg.scripts?.start !== 'string') return 'Installation package.json is not a Mission Control installation.';
      return null;
    } catch { return 'Could not read the installation package.json.'; }
  }

  private async health(): Promise<HealthResponse | null> {
    try { return await this.options.client.health(this.controller.signal); } catch (error) {
      if (this.controller.signal.aborted) throw this.controller.signal.reason ?? error;
      throwIfAbortError(error);
      return null;
    }
  }
  private async waitForReadiness(message: string): Promise<EnsureReadyResult> {
    for (const wait of readinessSchedule) {
      this.throwIfAborted();
      try { await this.options.delay(wait, this.controller.signal); } catch { this.throwIfAborted(); return { kind: 'unavailable', message: 'Mission Control startup was cancelled.' }; }
      this.throwIfAborted();
      const ready = await this.health();
      if (ready) return this.fromHealth(ready);
    }
    return { kind: 'unavailable', message };
  }
  private throwIfAborted(): void { this.controller.signal.throwIfAborted(); }
  private fromHealth(health: HealthResponse): EnsureReadyResult { return health.apiVersion === this.options.expectedApiVersion ? { kind: 'ready', health } : { kind: 'incompatible', health }; }
  private ownerFile(): string { return join(this.options.storagePath, 'server-owner.json'); }
  private async readOwner(): Promise<ServerOwner | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.ownerFile(), 'utf8'));
      const owner = parsed as Partial<ServerOwner>;
      return typeof owner.pid === 'number' && typeof owner.startedAt === 'string' ? owner as ServerOwner : null;
    } catch { return null; }
  }
  private async writeOwner(owner: ServerOwner): Promise<void> {
    const temporaryFile = `${this.ownerFile()}.${randomUUID()}.tmp`;
    await writeFile(temporaryFile, JSON.stringify(owner));
    await rename(temporaryFile, this.ownerFile());
  }
}

function throwIfAbortError(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') throw error;
}
