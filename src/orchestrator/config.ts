import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';

import { configPath } from './paths.ts';
import { PHASES } from '../shared/types.ts';
import type { Config } from '../shared/types.ts';

/**
 * config.yaml is edited by hand, so every constraint is enforced here and
 * every failure names the field to fix. A bad config should be a clear
 * message at startup, never a confusing failure at spawn time.
 */

const agentProfileSchema = z
  .object({
    launch: z.string().min(1),
    promptMode: z.enum(['positional', 'flag']),
    promptFlag: z.string().min(1).optional(),
    promptPosition: z.enum(['first', 'last']).optional(),
    modelFlag: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    models: z.array(z.string()).optional(),
    effortFlag: z.string().min(1).optional(),
    effortValueTemplate: z.string().min(1).optional(),
    efforts: z.array(z.string()).optional(),
    effort: z.string().min(1).optional(),
    instructionMode: z.enum(['flag', 'inline']),
    instructionFlag: z.string().min(1).optional(),
    extraArgs: z.array(z.string()).optional(),
    t3Instance: z.string().min(1).optional(),
  })
  .superRefine((profile, ctx) => {
    if (profile.promptMode === 'flag' && !profile.promptFlag) {
      ctx.addIssue({
        code: 'custom',
        path: ['promptFlag'],
        message: "promptFlag is required when promptMode is 'flag'",
      });
    }
    if (profile.instructionMode === 'flag' && !profile.instructionFlag) {
      ctx.addIssue({
        code: 'custom',
        path: ['instructionFlag'],
        message: "instructionFlag is required when instructionMode is 'flag'",
      });
    }
  });

const gateSchema = z.union([
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('auto'),
    signal: z.enum([
      'pr_exists',
      'checks_green',
      'copilot_comments_resolved',
      'approved_and_threads_resolved',
    ]),
  }),
]);

const t3ModesSchema = z.object({
  runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  interactionMode: z.enum(['default', 'plan']),
});

const phaseSchema = z.object({
  id: z.enum(PHASES),
  label: z.string().min(1),
  actor: z.string().min(1),
  command: z.string().min(1).optional(),
  spawnable: z.boolean().optional(),
  repeatable: z.boolean().optional(),
  gate: gateSchema,
  onFail: z.object({ offerSpawnPhase: z.string() }).optional(),
  t3: t3ModesSchema.optional(),
});

const configSchema = z
  .object({
    repo: z.object({
      path: z.string().min(1),
      owner: z.string().min(1),
      name: z.string().min(1),
      baseBranch: z.string().min(1),
      branchPrefix: z.string().min(1),
    }),
    github: z.object({
      auth: z.literal('gh-cli'),
      pollIntervalSeconds: z.number().int().positive(),
      copilotReviewerLogin: z.string().min(1),
    }),
    agents: z.record(z.string(), agentProfileSchema),
    pipeline: z.array(phaseSchema).min(1),
    server: z.object({ port: z.number().int().positive() }),
    launcher: z.enum(['wt', 'vscode', 't3']).optional(),
    cleanup: z
      .object({
        onDone: z.boolean().optional(),
        deleteBranch: z.boolean().optional(),
      })
      .optional(),
    t3: z
      .object({
        projectTitle: z.string().min(1).optional(),
        pinnedVersion: z.string().min(1).optional(),
      })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const phase of cfg.pipeline) {
      if (seen.has(phase.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pipeline'],
          message: `duplicate phase id '${phase.id}'`,
        });
      }
      seen.add(phase.id);

      // A phase can only name an agent that actually has a profile.
      if (phase.actor !== 'none' && phase.actor !== 'you' && !cfg.agents[phase.actor]) {
        ctx.addIssue({
          code: 'custom',
          path: ['pipeline', phase.id, 'actor'],
          message: `phase '${phase.id}' uses actor '${phase.actor}' but no such agent profile is configured`,
        });
      }
    }
  });

export function parseConfig(source: string): Config {
  const raw = yaml.load(source);
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config.yaml:\n${details}`);
  }
  return result.data as Config;
}

export function loadConfig(): Config {
  const file = configPath();
  if (!existsSync(file)) {
    throw new Error(
      `No config.yaml found at ${file}. Run scripts/install.ps1 to create one from the example.`,
    );
  }
  return parseConfig(readFileSync(file, 'utf8'));
}
