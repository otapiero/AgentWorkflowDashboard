import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  stripFrontmatter,
  render,
  buildPrompt,
  renderArtifactList,
} from '../src/orchestrator/prompt.ts';
import { promptPath, claudeCommandsDir } from '../src/orchestrator/paths.ts';

let home: string;
let commands: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-prompt-'));
  commands = join(home, 'commands');
  mkdirSync(commands, { recursive: true });
  process.env.MC_HOME = home;
  process.env.MC_CLAUDE_COMMANDS = commands;
});

afterEach(() => {
  delete process.env.MC_HOME;
  delete process.env.MC_CLAUDE_COMMANDS;
  rmSync(home, { recursive: true, force: true });
});

describe('stripFrontmatter', () => {
  test('removes a yaml frontmatter block', () => {
    const md = '---\ndescription: Plan an issue.\n---\nDo the thing.';
    expect(stripFrontmatter(md)).toBe('Do the thing.');
  });

  test('leaves a document without frontmatter untouched', () => {
    expect(stripFrontmatter('Just a prompt.')).toBe('Just a prompt.');
  });

  test('does not strip a horizontal rule in the middle of a document', () => {
    // A --- separator later in the body is content, not frontmatter.
    const md = 'Intro.\n\n---\n\nMore.';
    expect(stripFrontmatter(md)).toBe(md);
  });

  test('handles windows line endings in the frontmatter delimiters', () => {
    const md = '---\r\ndescription: x\r\n---\r\nBody text.';
    expect(stripFrontmatter(md).trim()).toBe('Body text.');
  });

  test('an unterminated frontmatter block is left alone rather than eating the file', () => {
    const md = '---\ndescription: oops';
    expect(stripFrontmatter(md)).toBe(md);
  });
});

describe('render', () => {
  test('substitutes double-brace variables', () => {
    expect(render('Issue {{issue}} on {{branch}}.', { issue: '3060', branch: 'b' })).toBe(
      'Issue 3060 on b.',
    );
  });

  test('substitutes $ARGUMENTS with the issue number', () => {
    // Claude command files conventionally use $ARGUMENTS.
    expect(render('Read issue #$ARGUMENTS.', { ARGUMENTS: '3060' })).toBe(
      'Read issue #3060.',
    );
  });

  test('replaces every occurrence, not just the first', () => {
    expect(render('{{a}} and {{a}}', { a: 'x' })).toBe('x and x');
  });

  test('leaves unknown placeholders untouched rather than blanking them', () => {
    // Blanking would silently produce a broken prompt; leaving it visible
    // makes the mistake obvious in the terminal.
    expect(render('Hello {{nope}}', { a: 'x' })).toBe('Hello {{nope}}');
  });

  test('an empty value substitutes as empty', () => {
    expect(render('X{{custom}}Y', { custom: '' })).toBe('XY');
  });

  test('replacement text containing $& is inserted literally', () => {
    // A naive String.replace would treat $& as a backreference.
    expect(render('{{a}}', { a: 'cost $& fee' })).toBe('cost $& fee');
  });
});

describe('buildPrompt', () => {
  const task = {
    issue: 3060,
    title: 'Add audio playback mode',
    branch: 'ouriel/3060-add-audio-playback-mode',
  };

  function writeCommand(name: string, body: string) {
    writeFileSync(join(commands, `${name}.md`), body, 'utf8');
  }

  test('renders the installed command file with task context', () => {
    writeCommand(
      'mc-planner',
      '---\ndescription: Plan.\n---\nPlan issue #$ARGUMENTS ("{{title}}").\nWrite it to {{planPath}}.',
    );
    const text = buildPrompt('mc-planner', task, {});
    expect(text).toContain('Plan issue #3060 ("Add audio playback mode")');
    expect(text).toContain(promptPath(3060).replace('prompt.txt', 'plan.md'));
    expect(text).not.toContain('description: Plan.');
  });

  test('appends custom instructions when given', () => {
    writeCommand('mc-implementer', 'Implement #$ARGUMENTS.\n{{customInstructions}}');
    const text = buildPrompt('mc-implementer', task, {
      customInstructions: 'Focus on the audio toggle only.',
    });
    expect(text).toContain('Focus on the audio toggle only.');
  });

  test('omits the custom instruction placeholder when none is given', () => {
    writeCommand('mc-implementer', 'Implement #$ARGUMENTS.{{customInstructions}}');
    expect(buildPrompt('mc-implementer', task, {})).toBe('Implement #3060.');
  });

  test('fails with a clear error naming the missing command file', () => {
    expect(() => buildPrompt('mc-absent', task, {})).toThrow(/mc-absent/);
    expect(() => buildPrompt('mc-absent', task, {})).toThrow(
      new RegExp(claudeCommandsDir().replace(/\\/g, '\\\\')),
    );
  });

  test('prepends standing rules when the agent has no system-prompt flag', () => {
    // copilot has no --append-system-prompt, so the rules must ride inline.
    writeCommand('mc-planner', 'Plan #$ARGUMENTS.');
    const text = buildPrompt('mc-planner', task, { inlineInstructions: 'RULE: stay put.' });
    expect(text.startsWith('RULE: stay put.')).toBe(true);
    expect(text).toContain('Plan #3060.');
  });

  test('does not prepend rules when the agent takes them via a flag', () => {
    writeCommand('mc-planner', 'Plan #$ARGUMENTS.');
    expect(buildPrompt('mc-planner', task, {})).toBe('Plan #3060.');
  });

  test('substitutes the artifact list into {{artifacts}}', () => {
    writeCommand('mc-x', 'Prior work:\n{{artifacts}}');
    const text = buildPrompt('mc-x', task, {
      artifacts: [
        { name: 'research.md', storedPath: 'artifacts/research.md', origin: 'taskdir', originalPath: 'x' },
      ],
    });
    expect(text).toContain('research.md');
    expect(text).not.toContain('{{artifacts}}');
  });

  test('renders (none) into {{artifacts}} when nothing has been collected', () => {
    writeCommand('mc-x', 'Prior work:\n{{artifacts}}');
    expect(buildPrompt('mc-x', task, {})).toContain('(none)');
  });

  test('points {{donePath}} at the named marker, not always plan.done', () => {
    writeCommand('mc-x', 'Signal: {{donePath}}');
    const text = buildPrompt('mc-x', task, { doneMarkerName: 'custom.done' });
    expect(text).toContain('custom.done');
    expect(text).not.toContain('plan.done');
  });

  test('defaults {{donePath}} to plan.done', () => {
    writeCommand('mc-x', 'Signal: {{donePath}}');
    expect(buildPrompt('mc-x', task, {})).toContain('plan.done');
  });
});

describe('renderArtifactList', () => {
  test('renders one line per artifact, pointing at the stored copy', () => {
    const out = renderArtifactList(
      [
        { name: 'research.md', storedPath: 'artifacts/research.md', origin: 'taskdir', originalPath: 'x' },
        { name: 'design.md', storedPath: 'artifacts/design.md', origin: 'repo', originalPath: 'y' },
      ],
      3060,
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('research.md');
    expect(lines[0]).toMatch(/[\\/]3060[\\/]artifacts[\\/]research\.md$/);
    expect(lines[1]).toContain('design.md');
  });

  test('renders (none) for an empty manifest so the prompt has no dangling heading', () => {
    expect(renderArtifactList([], 3060)).toBe('(none)');
  });
});

describe('writing the prompt file', () => {
  test('the rendered prompt is written where the spawn script reads it', async () => {
    writeFileSync(join(commands, 'mc-planner.md'), 'Plan #$ARGUMENTS.', 'utf8');
    const { writePromptFile } = await import('../src/orchestrator/prompt.ts');
    writePromptFile(3060, 'Plan #3060.');
    expect(readFileSync(promptPath(3060), 'utf8')).toBe('Plan #3060.');
  });
});
