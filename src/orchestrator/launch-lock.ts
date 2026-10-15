import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskDir } from './paths.ts';
import { readLiveSpawn } from './markers.ts';
import { latestThreadId, toT3Fact } from './t3/facts.ts';
import { T3Client } from './t3/client.ts';
import type { TaskRecord } from '../shared/types.ts';
import { randomUUID } from 'node:crypto';

interface Reservation { token: string; expires: number; handedOff?: boolean; threadId?: string }
const reservationFile = (issue: number) => join(taskDir(issue), 'launch-pending.json');
export function cancelPendingLaunch(issue: number): void {
  const file = reservationFile(issue);
  if (!existsSync(file)) return;
  if (readLiveSpawn(issue)) throw new Error('The run has already started; close its agent session to stop it');
  const pending = JSON.parse(readFileSync(file, 'utf8')) as Reservation;
  if (!pending.handedOff && Date.now() < pending.expires) throw new Error('The launch is still being prepared');
  // A script claims this file with FileShare.None while installing its live marker.
  rmSync(file);
}
export function assertLaunchReservation(issue: number, token: string): void {
  const pending = JSON.parse(readFileSync(reservationFile(issue), 'utf8')) as Reservation;
  if (pending.token !== token) throw new Error('This launch was cancelled');
}

/** Cross-process reservation covers the gap before a detached launcher writes its PID. */
export async function withIssueLaunch<T>(task: TaskRecord, launch: (token: string) => Promise<T>): Promise<T> {
  const file = reservationFile(task.issue);
  mkdirSync(taskDir(task.issue), { recursive: true });
  if (existsSync(file)) {
    const pending = JSON.parse(readFileSync(file, 'utf8')) as Reservation;
    if (pending.handedOff) {
      if (!pending.threadId) throw new Error('An issue run is already starting. Use Cancel pending launch if its terminal did not open');
      const snapshot = await new T3Client().fetchSnapshot();
      const live = toT3Fact(snapshot, pending.threadId);
      if (!snapshot || (live && !live.settled && (live.activeTurnId || live.sessionStatus === 'running' || live.sessionStatus === 'starting'))) throw new Error('An issue run is already active in T3');
      assertLaunchReservation(task.issue, pending.token);
      rmSync(file);
    } else {
    if (Date.now() < pending.expires) throw new Error('An issue run is already starting');
    rmSync(file);
    }
  }
  let fd: number;
  try { fd = openSync(file, 'wx'); } catch { throw new Error('An issue run is already starting'); }
  const token = randomUUID();
  writeFileSync(fd, JSON.stringify({ token, expires: Date.now() + 60_000 })); closeSync(fd);
  const heartbeat = setInterval(() => {
    try {
      assertLaunchReservation(task.issue, token);
      writeFileSync(file, JSON.stringify({ token, expires: Date.now() + 60_000 }));
    } catch { /* A terminal may already have claimed its reservation. */ }
  }, 10_000);
  heartbeat.unref();
  try {
    if (readLiveSpawn(task.issue)) throw new Error('An issue run is already active');
    const thread = latestThreadId(task);
    if (thread) {
      const snapshot = await new T3Client().fetchSnapshot();
      const live = toT3Fact(snapshot, thread);
      if (!snapshot) throw new Error('Cannot establish whether the existing T3 run is active. Reconnect T3 before launching');
      if (live && !live.settled && (live.activeTurnId || live.sessionStatus === 'running' || live.sessionStatus === 'starting')) throw new Error('An issue run is already active in T3');
    }
    const result = await launch(token);
    if (existsSync(file)) {
      try {
        assertLaunchReservation(task.issue, token);
        writeFileSync(file, JSON.stringify({ token, handedOff: true, expires: Date.now() + 60_000,
          threadId: (result as { threadId?: string } | undefined)?.threadId }));
      } catch { /* A terminal already claimed the file and wrote its live marker. */ }
    }
    return result;
  } catch (error) {
    try { assertLaunchReservation(task.issue, token); rmSync(file, { force: true }); } catch { /* Never remove a successor's reservation. */ }
    throw error;
  }
  finally { clearInterval(heartbeat); }
}
