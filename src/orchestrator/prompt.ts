import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import {
  claudeCommandPath,
  claudeCommandsDir,
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

export interface PromptTask {
  issue: number;
  title: string;
  branch: string;
}

export interface PromptOptions {
  customInstructions?: string;
  /** Standing rules to prepend, for agents with no system-prompt flag. */
  inlineInstructions?: string;
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

  const body = render(stripFrontmatter(readFileSync(file, 'utf8')), {
    ARGUMENTS: String(task.issue),
    issue: String(task.issue),
    title: task.title,
    branch: task.branch,
    planPath: planPath(task.issue),
    worktree: worktreePath(task.issue),
    taskDir: taskDir(task.issue),
    customInstructions: options.customInstructions ?? '',
  }).trim();

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
