import { describe, expect, test } from 'vitest';

import { formatT3Doctor } from '../src/orchestrator/t3/doctor.ts';

describe('formatT3Doctor', () => {
  test('reports a healthy integration with the version and capabilities', () => {
    const lines = formatT3Doctor({
      status: {
        ok: true,
        origin: 'http://127.0.0.1:3773',
        serverVersion: '0.0.31',
        capabilities: { serverSelfUpdate: 'desktop-managed' },
      },
      pinnedVersion: '0.0.31',
      instances: [{ agent: 'codex', instanceId: 'codex', ready: true, reason: null, models: [] }],
    }).join('\n');

    expect(lines).toContain('0.0.31');
    expect(lines).toContain('serverSelfUpdate');
    expect(lines).toMatch(/ok|✓/i);
  });

  test('warns on a version drift without failing', () => {
    // The desktop build updates itself without asking, so drift is expected
    // and must not block a spawn.
    const lines = formatT3Doctor({
      status: { ok: true, origin: 'http://x', serverVersion: '0.0.44', capabilities: {} },
      pinnedVersion: '0.0.31',
      instances: [],
    }).join('\n');
    expect(lines).toMatch(/warn/i);
    expect(lines).toContain('0.0.44');
    expect(lines).toContain('0.0.31');
  });

  test('a missing credential and a rejected one get different remedies', () => {
    const missing = formatT3Doctor({
      status: { ok: false, reason: 'no-credential', detail: 'no credential' },
      pinnedVersion: '0.0.31',
      instances: [],
    }).join('\n');
    const rejected = formatT3Doctor({
      status: { ok: false, reason: 'credential-rejected', detail: 'token exchange returned 401' },
      pinnedVersion: '0.0.31',
      instances: [],
    }).join('\n');

    expect(missing).toContain('Create link');
    expect(rejected).toContain('401');
    expect(missing).not.toBe(rejected);
  });

  test('T3 not running is reported as a normal state, not an error', () => {
    const lines = formatT3Doctor({
      status: { ok: false, reason: 'no-runtime-file', detail: 'C:\\Users\\x\\.t3\\...' },
      pinnedVersion: '0.0.31',
      instances: [],
    }).join('\n');
    expect(lines).toMatch(/not running/i);
  });

  test('names each unusable agent instance and why', () => {
    const lines = formatT3Doctor({
      status: { ok: true, origin: 'http://x', serverVersion: '0.0.31', capabilities: {} },
      pinnedVersion: '0.0.31',
      instances: [
        { agent: 'codex', instanceId: 'codex', ready: true, reason: null, models: ['gpt-5.6-sol'] },
        { agent: 'copilot', instanceId: 'opencode', ready: false, reason: 'not installed', models: [] },
      ],
    }).join('\n');
    expect(lines).toContain('copilot');
    expect(lines).toContain('opencode');
    expect(lines).toContain('not installed');
  });
});
