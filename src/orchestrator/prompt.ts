import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ArtifactRef } from '../shared/types.ts';
import {
  claudeCommandPath,
  claudeCommandsDir,
  markerPath,
  planPath,
  promptPath,
  taskDir,
  worktreePath,
} from './paths.ts';

/**
 * Prompt assembly.
 *
 * Claude Code 2.1.x surfaces user commands as skills chosen by the model
 * rather than expanding them as text, so passing "/mc-planner 3060" as an
 * initial prompt does not reliably run the command. Verified by probe on
 * 2026-07-21.
 *
 * The installed command file therefore stays the single, hand-editable source
 * of prompt text — it is read here, stripped of frontmatter, rendered with the
 * task's context, and passed to the agent verbatim, which is the delivery path
 * that does work.
 */

/** Remove a leading YAML frontmatter block, if the document opens with one. */
export function stripFrontmatter(markdown: string): string {
  if (!/^---\r?\n/.test(markdown)) return markdown;
  // Only a closing delimiter makes this frontmatter; otherwise it is content.
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? markdown.slice(match[0].length) : markdown;
}

/**
 * Substitute {{name}} and $ARGUMENTS placeholders.
 *
 * Unknown placeholders are deliberately left in place: a visibly broken prompt
 * in the terminal is easier to diagnose than a silently blanked one.
 */
export function render(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    const token = key === 'ARGUMENTS' ? '$ARGUMENTS' : `{{${key}}}`;
    // Split/join avoids String.replace's $-pattern interpretation in `value`.
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * The collected manifest as prompt text.
 *
 * Points at the stored copy rather than `originalPath` because the stored copy
 * is the one Mission Control guarantees exists — an original written into the
 * checkout can be moved, renamed or committed away between runs.
 */
export function renderArtifactList(
  refs: readonly ArtifactRef[],
  issue: number,
): string {
  if (refs.length === 0) return '(none)';
  return refs
    .map((ref) => `- ${ref.name} — ${join(taskDir(issue), ref.storedPath)}`)
    .join('\n');
}

export interface PromptTask {
  issue: number;
  title: string;
  branch: string;
}

export interface PromptOptions {
  customInstructions?: string;
  /** Standing rules to prepend, for agents with no system-prompt flag. */
  inlineInstructions?: string;
  /** Collected artifacts, rendered into {{artifacts}}. */
  artifacts?: readonly ArtifactRef[];
  /**
   * The marker this run signs off with, rendered into {{donePath}}. Each run
   * must own its own: a custom run pointed at 'plan.done' would satisfy the
   * Plan gate and move the card to Implement.
   */
  doneMarkerName?: string;
  /**
   * The repository this task belongs to, rendered into {{owner}}, {{repo}},
   * {{baseBranch}} and {{repoPath}}. Optional so the pure prompt tests can
   * omit it; every real spawn passes it from config.
   */
  repo?: { owner: string; name: string; baseBranch: string; path: string };
}

export function buildPrompt(
  command: string,
  task: PromptTask,
  options: PromptOptions,
): string {
  const file = claudeCommandPath(command);
  if (!existsSync(file)) {
    throw new Error(
      `Command file '${command}.md' not found in ${claudeCommandsDir()}. Run scripts/install.ps1 to install the mc-* commands.`,
    );
  }

  const vars: Record<string, string> = {
    ARGUMENTS: String(task.issue),
    issue: String(task.issue),
    title: task.title,
    branch: task.branch,
    planPath: planPath(task.issue),
    donePath: markerPath(task.issue, options.doneMarkerName ?? 'plan.done'),
    artifacts: renderArtifactList(options.artifacts ?? [], task.issue),
    worktree: worktreePath(task.issue),
    taskDir: taskDir(task.issue),
    customInstructions: options.customInstructions ?? '',
  };

  // Added only when known, so an omitted repo leaves {{owner}} visible in the
  // terminal rather than substituting an empty string into a `gh --repo` flag.
  if (options.repo) {
    vars.owner = options.repo.owner;
    vars.repo = options.repo.name;
    vars.baseBranch = options.repo.baseBranch;
    vars.repoPath = options.repo.path;
  }

  const body = render(stripFrontmatter(readFileSync(file, 'utf8')), vars).trim();

  return options.inlineInstructions
    ? `${options.inlineInstructions}\n\n${body}`
    : body;
}

export function writePromptFile(issue: number, text: string): string {
  mkdirSync(taskDir(issue), { recursive: true });
  const file = promptPath(issue);
  writeFileSync(file, text, 'utf8');
  return file;
}
