import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import lockfile from 'proper-lockfile';

interface Owner { token: string; pid: number; processStart: string }
function queryProcessStart(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return /^\d+$/.test(value) ? value : null;
    }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}
let ownProcessStart: string | undefined;
function processStart(pid: number): string | null {
  // This process cannot change its PID/start identity. Foreign processes still
  // require a fresh query because a PID may have been reused between checks.
  if (pid === process.pid && ownProcessStart !== undefined) return ownProcessStart;
  const value = queryProcessStart(pid);
  // Only a real answer is remembered: a cold PowerShell that timed out once
  // must not leave notes unavailable for the rest of this process's life.
  if (pid === process.pid && value !== null) ownProcessStart = value;
  return value;
}
function readOwner(path: string): Owner | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || !value) return null;
    const owner = value as Owner;
    return typeof owner.token === 'string' && owner.token.length > 0 && Number.isSafeInteger(owner.pid)
      && owner.pid > 0 && typeof owner.processStart === 'string' && owner.processStart.length > 0 ? owner : null;
  } catch { return null; }
}
function isDead(owner: Owner): boolean {
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  const currentStart = processStart(owner.pid);
  return currentStart !== null && currentStart !== owner.processStart;
}
function locked(): Error & { code: string } {
  return Object.assign(new Error('Notes are already open for this project. Use the existing Mission Control server. If ownership metadata is damaged or recovery was interrupted, close all servers before repairing notes.json.lock and notes.json.lock.recovery.'), { code: 'NOTES_ALREADY_OPEN' });
}

/** proper-lockfile supplies the atomic directory lock and heartbeat. Ownership
 * checks override time-only abandonment: a paused live process is never evicted.
 * A sibling directory serializes recovery without changing the heartbeat
 * directory's mtime. Ownership is rechecked before removing a successor lock.
 */
export async function acquireNotesLease(home: string, onCompromised?: (error: Error) => void): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true });
  const target = join(home, 'notes.json');
  const directory = `${target}.lock`;
  const metadata = join(directory, 'owner.json');
  // The first PowerShell of a session can be slow enough to time out; the
  // second starts warm.
  const start = processStart(process.pid) ?? processStart(process.pid);
  if (!start) throw new Error('Cannot establish the notes lease process start identity');
  const owner: Owner = { token: randomUUID(), pid: process.pid, processStart: start };
  let compromised = false;
  const leaseFs = {
    ...fs,
    mkdir(path: string, callback: (error: NodeJS.ErrnoException | null) => void) {
      fs.mkdir(path, error => {
        if (error) return callback(error);
        try {
          fs.writeFileSync(metadata, JSON.stringify(owner), { flag: 'wx' });
          callback(null);
        } catch (failure) { callback(failure as NodeJS.ErrnoException); }
      });
    },
    stat(path: string, callback: (error: NodeJS.ErrnoException | null, stat?: fs.Stats) => void) {
      fs.stat(path, (error, stat) => {
        if (error) return callback(error);
        const found = readOwner(metadata);
        // Only foreign-owner acquisition checks need a synthetic timestamp.
        // Preserve our actual mtime for proper-lockfile heartbeat verification.
        if (found?.token !== owner.token) {
          stat.mtime = found && isDead(found) ? new Date(0) : new Date();
        }
        callback(null, stat);
      });
    },
    rmdir(path: string, callback: (error: NodeJS.ErrnoException | null) => void) {
      const guard = `${path}.recovery`;
      let held = false;
      try {
        // Atomic guard creation elects one remover, including normal release.
        // Keep this outside path: a delayed contender must not disturb the
        // winning lease's mtime when it discovers that owner is now alive.
        fs.mkdirSync(guard);
        held = true;
        const found = readOwner(metadata);
        if (!found || (found.token !== owner.token && !isDead(found))) throw locked();
        fs.unlinkSync(metadata);
        fs.rmdirSync(guard);
        held = false;
        fs.rmdirSync(path);
        callback(null);
      } catch (error) {
        if (held) { try { fs.rmdirSync(guard); } catch { /* Fail closed if removal was interrupted. */ } }
        callback(error as NodeJS.ErrnoException);
      }
    },
    // proper-lockfile's process-exit cleanup must obey the same ownership rule.
    rmdirSync(path: string) {
      const found = readOwner(metadata);
      if (found?.token !== owner.token) return;
      fs.unlinkSync(metadata);
      fs.rmdirSync(path);
    },
  };
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, { realpath: false, fs: leaseFs, stale: 10000, update: 2000,
      onCompromised: error => { compromised = true; onCompromised?.(error); } });
  } catch (error) {
    if (['ELOCKED', 'EEXIST', 'NOTES_ALREADY_OPEN'].includes((error as NodeJS.ErrnoException).code ?? '')) throw locked();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (!compromised) await release();
  };
}
