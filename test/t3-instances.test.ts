import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { t3ProviderCachePath } from '../src/orchestrator/t3/paths.ts';
import { readInstanceReadiness } from '../src/orchestrator/t3/instances.ts';

let home: string;

function writeCache(instanceId: string, body: unknown): void {
  mkdirSync(join(home, 'caches'), { recursive: true });
  writeFileSync(
    t3ProviderCachePath(instanceId),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  process.env.T3_HOME = home;
});

afterEach(() => {
  delete process.env.T3_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('readInstanceReadiness', () => {
  test('a ready, installed, enabled instance is launchable', () => {
    // Recorded from ~/.t3/caches/codex.json.
    writeCache('codex', {
      displayName: 'Codex',
      enabled: true,
      installed: true,
      status: 'ready',
      version: '0.146.0',
      auth: { status: 'authenticated' },
      models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }],
    });
    const readiness = readInstanceReadiness('codex');
    expect(readiness.ready).toBe(true);
    expect(readiness.reason).toBeNull();
    expect(readiness.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  test("reads each model's select knobs, keeping only the ones with values", () => {
    // Recorded from ~/.t3/caches/codex.json on 2026-08-23. 'fastMode' is a
    // boolean descriptor and carries no options array.
    writeCache('codex', {
      displayName: 'Codex',
      enabled: true,
      installed: true,
      status: 'ready',
      models: [
        {
          slug: 'gpt-5.6-sol',
          capabilities: {
            optionDescriptors: [
              {
                id: 'reasoningEffort',
                label: 'Reasoning',
                type: 'select',
                options: [{ id: 'low', label: 'Low' }, { id: 'xhigh', label: 'Extra High' }],
                currentValue: 'low',
              },
              { id: 'fastMode', label: 'Fast', type: 'boolean' },
            ],
          },
        },
      ],
    });
    expect(readInstanceReadiness('codex').options).toEqual({
      'gpt-5.6-sol': [{ id: 'reasoningEffort', values: ['low', 'xhigh'] }],
    });
  });

  test('an instance whose CLI is not installed is not launchable, and says so', () => {
    // Recorded from ~/.t3/caches/opencode.json on 2026-08-07.
    writeCache('opencode', {
      displayName: 'OpenCode',
      enabled: true,
      installed: false,
      status: 'error',
      version: null,
      auth: { status: 'unknown' },
      models: [],
    });
    const readiness = readInstanceReadiness('opencode');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('OpenCode');
    expect(readiness.reason).toContain('not installed');
  });

  test('a disabled instance is not launchable', () => {
    writeCache('grok', {
      displayName: 'Grok',
      enabled: false,
      installed: false,
      status: 'disabled',
      version: null,
      models: [],
    });
    const readiness = readInstanceReadiness('grok');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('disabled');
  });

  test('an installed but unauthenticated instance is not launchable', () => {
    writeCache('claudeAgent', {
      displayName: 'Claude',
      enabled: true,
      installed: true,
      status: 'unauthenticated',
      version: '2.1.224',
      auth: { status: 'unauthenticated' },
      models: [{ slug: 'claude-opus-5' }],
    });
    const readiness = readInstanceReadiness('claudeAgent');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('unauthenticated');
  });

  test('an unknown instance id is not launchable and names the file it looked for', () => {
    const readiness = readInstanceReadiness('nonexistent');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('nonexistent');
  });

  test('a corrupt cache file is not launchable rather than a crash', () => {
    writeCache('codex', '{ not json');
    expect(() => readInstanceReadiness('codex')).not.toThrow();
    expect(readInstanceReadiness('codex').ready).toBe(false);
  });

  test('a path-traversing instance id cannot escape the caches directory', () => {
    // Instance ids come from config.yaml, which is hand-edited; a typo must
    // not turn into a read of an arbitrary file.
    const readiness = readInstanceReadiness('../../userdata/server-runtime');
    expect(readiness.ready).toBe(false);
  });
});
