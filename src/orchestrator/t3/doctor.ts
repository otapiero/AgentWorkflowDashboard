import type { T3Status } from './client.ts';

/**
 * The T3 section of `mc doctor`, as lines.
 *
 * Pure so the wording is testable. The three authentication failures are kept
 * distinct on purpose: "T3 is not running", "no credential" and "credential
 * rejected" need three different actions, and collapsing them into one
 * "T3 unavailable" line would send the operator looking in the wrong place.
 */

export interface T3DoctorInstance {
  agent: string;
  instanceId: string;
  ready: boolean;
  reason: string | null;
  models: string[];
}

export interface T3DoctorInput {
  status: T3Status;
  pinnedVersion: string | undefined;
  instances: T3DoctorInstance[];
}

export function formatT3Doctor(input: T3DoctorInput): string[] {
  const lines: string[] = ['T3 Code'];
  const { status } = input;

  if (!status.ok) {
    switch (status.reason) {
      case 'no-runtime-file':
      case 'dead-server':
        lines.push(
          '  - T3 Code is not running. The t3 launcher is unavailable; wt and vscode are unaffected.',
        );
        lines.push(`    ${status.detail}`);
        break;
      case 'no-credential':
        lines.push('  - T3 is running but Mission Control has no credential.');
        lines.push('    Fix: in T3, Settings -> This environment -> Authorized clients -> Create link.');
        lines.push('    Take the "This machine" pairing URL and save it to ~/.mission-control/t3-credential.');
        lines.push('    The link is single-use and expires within minutes, so save it straight away.');
        break;
      case 'credential-rejected':
        lines.push('  - T3 rejected the credential.');
        lines.push(`    ${status.detail}`);
        lines.push('    Fix: Settings -> This environment -> Authorized clients -> Create link,');
        lines.push('    then replace ~/.mission-control/t3-credential with the new "This machine" URL.');
        break;
      case 'snapshot-unavailable':
        lines.push(`  - T3 session status is unavailable: ${status.detail}`);
        break;
      default:
        lines.push(`  - T3 is unreachable: ${status.detail}`);
    }
    return lines;
  }

  lines.push(`  - ok: reachable at ${status.origin}, server version ${status.serverVersion}`);

  if (input.pinnedVersion && input.pinnedVersion !== status.serverVersion) {
    // A warning, never a block: the desktop build self-updates, so drift is
    // the normal case rather than a fault.
    lines.push(
      `  - warn: running ${status.serverVersion} but fixtures were recorded against ${input.pinnedVersion}.`,
    );
    lines.push('    Re-record the T3 fixtures, run the suite, then bump t3.pinnedVersion.');
  }

  lines.push(`  - capabilities: ${JSON.stringify(status.capabilities)}`);

  for (const instance of input.instances) {
    lines.push(
      instance.ready
        ? `  - ok: agent '${instance.agent}' -> instance '${instance.instanceId}' (${instance.models.length} models)`
        : `  - warn: agent '${instance.agent}' -> instance '${instance.instanceId}' is not usable: ${instance.reason}`,
    );
  }

  return lines;
}
