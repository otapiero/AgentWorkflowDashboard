import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { acquireNotesLease } from '../src/orchestrator/notes-lease.ts';
import { NotesService } from '../src/orchestrator/notes.ts';

let home: string;
const releases: (() => Promise<void>)[] = [];
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'mc-notes-lease-')); });
afterEach(async () => { for (const release of releases.splice(0)) await release(); await rm(home, { recursive: true, force: true }); });
test('excludes another owner even with an old heartbeat and releases only once', async () => {
  const release = await acquireNotesLease(home);
  releases.push(release);
  await utimes(join(home, 'notes.json.lock'), new Date(0), new Date(0));
  await expect(acquireNotesLease(home)).rejects.toMatchObject({ code: 'NOTES_ALREADY_OPEN' });
  await release();
  await release();
  releases.push(await acquireNotesLease(home));
});
test('serializes competing abandoned-owner recoveries', async () => {
  const lock = join(home, 'notes.json.lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ token: 'abandoned', pid: 2147483647, processStart: 'dead' }));
  const results = await Promise.allSettled([acquireNotesLease(home), acquireNotesLease(home), acquireNotesLease(home)]);
  const winners = results.filter(result => result.status === 'fulfilled');
  expect(winners).toHaveLength(1);
  for (const result of winners) if (result.status === 'fulfilled') releases.push(result.value);
});
test('does not guess ownership when metadata is missing', async () => {
  await mkdir(join(home, 'notes.json.lock'));
  await utimes(join(home, 'notes.json.lock'), new Date(0), new Date(0));
  await expect(acquireNotesLease(home)).rejects.toMatchObject({ code: 'NOTES_ALREADY_OPEN' });
});
test('recovers an abruptly killed process and excludes that process while it is alive', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/orchestrator/notes-lease.ts')).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { acquireNotesLease } from ${JSON.stringify(moduleUrl)}; await acquireNotesLease(${JSON.stringify(home)}); console.log('owned'); setInterval(() => {}, 1000);`],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Lease owner exited before acquisition: ${code}`)));
      child.stdout.once('data', chunk => String(chunk).includes('owned') ? resolve() : reject(new Error(String(chunk))));
    });
    await utimes(join(home, 'notes.json.lock'), new Date(0), new Date(0));
    await expect(acquireNotesLease(home)).rejects.toMatchObject({ code: 'NOTES_ALREADY_OPEN' });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    releases.push(await acquireNotesLease(home));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}, 15000);
test('allows only one independent process to recover an abandoned lease', async () => {
  const lock = join(home, 'notes.json.lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ token: 'abandoned', pid: 2147483647, processStart: 'dead' }));
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/orchestrator/notes-lease.ts')).href;
  const children = Array.from({ length: 3 }, () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { acquireNotesLease } from ${JSON.stringify(moduleUrl)}; try { await acquireNotesLease(${JSON.stringify(home)}); console.log('owned'); setInterval(() => {}, 1000); } catch (error) { console.log(error.code); process.exit(2); }`],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    const outcomes = await Promise.all(children.map(child => new Promise<string>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', chunk => resolve(String(chunk).trim()));
      child.once('exit', code => { if (code !== 2) reject(new Error(`Contender exited: ${code}`)); });
    })));
    expect(outcomes.filter(value => value === 'owned')).toHaveLength(1);
    expect(outcomes.filter(value => value === 'NOTES_ALREADY_OPEN')).toHaveLength(2);
  } finally {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    })));
  }
}, 15000);
test('recognizes a reused PID by its different start time', async () => {
  const lock = join(home, 'notes.json.lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ token: 'old-process', pid: process.pid, processStart: 'different-start-time' }));
  releases.push(await acquireNotesLease(home));
});
test('a release cannot remove another ownership token', async () => {
  const release = await acquireNotesLease(home);
  const metadata = join(home, 'notes.json.lock', 'owner.json');
  const { readFile } = await import('node:fs/promises');
  const owner = JSON.parse(await readFile(metadata, 'utf8'));
  await writeFile(metadata, JSON.stringify({ ...owner, token: 'different-owner' }));
  await expect(release()).rejects.toMatchObject({ code: 'NOTES_ALREADY_OPEN' });
  expect(JSON.parse(await readFile(metadata, 'utf8')).token).toBe('different-owner');
});
test('a delayed stale contender cannot compromise a successor heartbeat', async () => {
  const directory = join(home, 'notes.json.lock');
  await mkdir(directory);
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ token: 'abandoned', pid: 2147483647, processStart: 'dead' }));
  let resumeContender!: () => void;
  let contenderPaused!: () => void;
  const paused = new Promise<void>(resolve => { contenderPaused = resolve; });
  let observeHeartbeat!: (result: string) => void;
  const heartbeat = new Promise<string>(resolve => { observeHeartbeat = resolve; });
  const originalLock = lockfile.lock;
  let attempts = 0;
  const spy = vi.spyOn(lockfile, 'lock').mockImplementation((file, options) => {
    attempts++;
    if (attempts === 1) {
      const remove = options!.fs.rmdir;
      options!.fs.rmdir = (path: string, callback: (error: NodeJS.ErrnoException | null) => void) => {
        resumeContender = () => remove(path, callback);
        contenderPaused();
      };
    } else {
      const touch = options!.fs.utimes;
      let touches = 0;
      options!.fs.utimes = (path: string, atime: Date, mtime: Date, callback: (error: NodeJS.ErrnoException | null) => void) => {
        touch(path, atime, mtime, (error: NodeJS.ErrnoException | null) => {
          callback(error);
          if (++touches > 1 && !error) observeHeartbeat('healthy');
        });
      };
      const compromised = options!.onCompromised;
      options!.onCompromised = error => { compromised?.(error); observeHeartbeat('compromised'); };
    }
    return originalLock(file, options);
  });
  const winner = new NotesService({ home, projectId: 'acme__app', tasks: () => [] });
  try {
    const contender = acquireNotesLease(home).then(
      release => { releases.push(release); return 'acquired'; },
      error => (error as NodeJS.ErrnoException).code,
    );
    await paused;
    await winner.start();
    expect((await winner.snapshot()).revision).toBe(0);
    resumeContender();
    expect(await contender).toBe('NOTES_ALREADY_OPEN');
    expect(await heartbeat).toBe('healthy');
    expect((await winner.create({ projectId: 'acme__app', body: 'Lease survived', clientRequestId: randomUUID() })).note.body).toBe('Lease survived');
  } finally { spy.mockRestore(); await winner.close(); }
}, 10000);
