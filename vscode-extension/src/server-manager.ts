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
    const url = this.validateServerUrl();
    if (typeof url === 'string') return { kind: 'configuration-error', message: url };

    const current = await this.health();
    if (current) return this.fromHealth(current);
    if (!this.options.autoStart) return { kind: 'unavailable', message: 'Mission Control is unavailable and automatic startup is disabled.' };

    const lease = await acquireAtomicLease(join(this.options.storagePath, 'server-start.lock'), startupLockStaleMs);
    if (!lease) return { kind: 'unavailable', message: 'Mission Control is starting in another VS Code window.' };
    try {
      const afterLease = await this.health();
      if (afterLease) return this.fromHealth(afterLease);

      const installationError = await this.validateInstallation();
      if (installationError) return { kind: 'configuration-error', message: installationError };
      const child = this.options.process.spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start'], {
        cwd: this.options.installationPath!, detached: true, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, MC_PORT: url.port || '4317' },
      });
      child.unref();

      for (const wait of readinessSchedule) {
        try {
          await this.options.delay(wait, this.controller.signal);
        } catch {
          return { kind: 'unavailable', message: 'Mission Control startup was cancelled.' };
        }
        const ready = await this.health();
        if (ready) {
          if (ready.pid === child.pid) await this.writeOwner({ pid: ready.pid, startedAt: ready.startedAt });
          return this.fromHealth(ready);
        }
      }
      return { kind: 'unavailable', message: 'Mission Control did not become ready in time.' };
    } finally {
      await lease.release();
    }
  }

  async restartOwned(): Promise<void> {
    const owner = await this.readOwner();
    const current = await this.health();
    if (owner && current && owner.pid === current.pid && owner.startedAt === current.startedAt) {
      this.options.kill(owner.pid);
      try { await unlink(this.ownerFile()); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  dispose(): void { this.controller.abort(); }

  private validateServerUrl(): URL | string {
    try {
      const url = new URL(this.options.serverUrl);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return 'Mission Control server URL must use loopback HTTP.';
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
    try { return await this.options.client.health(this.controller.signal); } catch { return null; }
  }
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
