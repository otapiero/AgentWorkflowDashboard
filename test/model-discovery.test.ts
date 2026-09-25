import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';

import { agentCapabilities } from '../src/orchestrator/agents.ts';
import { discoverModels } from '../src/orchestrator/model-discovery.ts';
import type { AgentProfile } from '../src/shared/types.ts';

function writeCache(instance: string, slugs: string[], status = 'ready'): void {
  const dir = join(process.env.T3_HOME!, 'caches');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${instance}.json`),
    JSON.stringify({
      displayName: instance,
      enabled: true,
      installed: true,
      status,
      models: slugs.map((slug) => ({ slug })),
    }),
  );
}

const profile = (extra: Partial<AgentProfile> = {}) =>
  ({ launch: 'x', promptMode: 'positional', instructionMode: 'inline', ...extra }) as AgentProfile;

describe('discoverModels', () => {
  beforeEach(() => {
    process.env.T3_HOME = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  });

  test('lists copilot models from OpenCode, bare, behind auto', () => {
    writeCache('opencode', [
      'opencode/big-pickle',
      'github-copilot/claude-opus-5.5',
      'github-copilot/gpt-6-sol',
    ]);
    expect(discoverModels('copilot')).toEqual(['auto', 'claude-opus-5.5', 'gpt-6-sol']);
  });

  test('keeps the CLI aliases in front of the released claude slugs', () => {
    writeCache('claudeAgent', ['claude-opus-5-5', 'claude-sonnet-5']);
    expect(discoverModels('claude')).toEqual([
      'default', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5',
    ]);
  });

  test("honours the profile's t3Instance", () => {
    writeCache('codex-work', ['gpt-6-astra']);
    expect(discoverModels('codex', 'codex-work')).toEqual(['default', 'gpt-6-astra']);
  });

  test('is null with no cache, a provider that is not ready, or an unknown agent', () => {
    expect(discoverModels('codex')).toBeNull();
    writeCache('codex', ['gpt-6-astra'], 'error');
    expect(discoverModels('codex')).toBeNull();
    expect(discoverModels('mystery')).toBeNull();
  });

  test('capabilities prefer discovery over the built-in list, and config over both', () => {
    writeCache('opencode', ['github-copilot/gpt-6-luna']);
    expect(agentCapabilities('copilot', profile()).models).toEqual(['auto', 'gpt-6-luna']);
    expect(agentCapabilities('copilot', profile({ models: ['pinned'] })).models).toEqual(['pinned']);
  });
});
