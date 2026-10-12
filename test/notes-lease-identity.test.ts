import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The lease learns this process's start time from PowerShell; these tests
// play a PowerShell that times out, without starting one.
const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync,
}));

const timedOut = () => { throw Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mc-lease-identity-'));
  execFileSync.mockReset();
  // A fresh module per test: the remembered start time is module state.
  vi.resetModules();
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test.runIf(process.platform === 'win32')('a start-time lookup that times out once is retried', async () => {
  execFileSync.mockImplementationOnce(timedOut).mockReturnValue('638000000000000000\r\n');
  const { acquireNotesLease } = await import('../src/orchestrator/notes-lease.ts');
  const release = await acquireNotesLease(home);
  await release();
});

test.runIf(process.platform === 'win32')('a failed start-time lookup is not remembered for later leases', async () => {
  execFileSync.mockImplementationOnce(timedOut).mockImplementationOnce(timedOut).mockReturnValue('638000000000000000\r\n');
  const { acquireNotesLease } = await import('../src/orchestrator/notes-lease.ts');
  await expect(acquireNotesLease(home)).rejects.toThrow(/process start identity/);
  const release = await acquireNotesLease(home);
  await release();
});
