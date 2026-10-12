import { expect, test, type Page } from '@playwright/test';

import type { ReviewRequestsSnapshot } from '../src/shared/review-requests.ts';

/**
 * Smoke tests over the real app (see e2e/server.ts for the fixture board):
 * #101 waits in the inbox, #102 has a finished plan held in Plan for review,
 * #103 has an open PR with failing checks.
 */

test.beforeEach(async ({ page }) => {
  // The one GitHub call a page load makes. Answered here so nothing leaves the machine.
  const empty: ReviewRequestsSnapshot = { pullRequests: [], checkedAt: new Date().toISOString(), error: null, limitReached: false };
  await page.route('**/api/review-requests*', (route) => route.fulfill({ json: empty }));
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Pipeline' })).toBeVisible();
});

/** The notes side panel, opened if a previous visit left it closed. */
async function notesPanel(page: Page) {
  const panel = page.getByRole('complementary', { name: 'Notes' });
  if (!(await panel.isVisible())) await page.getByRole('button', { name: /^Notes \d+$/ }).click();
  await expect(panel).toBeVisible();
  return panel;
}

async function openTask(page: Page, issue: number) {
  await page.getByRole('button', { name: new RegExp(`^Issue ${issue},`) }).first().click();
  const drawer = page.getByRole('dialog', { name: `Issue ${issue}` });
  await expect(drawer).toBeVisible();
  return drawer;
}

test('cards sit in the lanes their facts derive, and blocked work needs you', async ({ page }) => {
  await expect(page.getByRole('region', { name: /^Plan, 1 task$/ }).getByRole('button', { name: /^Issue 102,/ })).toBeVisible();
  await expect(page.getByRole('region', { name: /^CI, 1 task$/ }).getByRole('button', { name: /^Issue 103,/ })).toBeVisible();

  // The plan awaiting review and the failing CI need you; the untouched inbox task does not.
  const rail = page.getByRole('region', { name: '2 items need you' });
  await expect(rail.getByRole('button', { name: /^#102 / })).toBeVisible();
  await expect(rail.getByRole('button', { name: /^#103 / })).toBeVisible();
});

test('a phase launch previews the prompt the agent would receive', async ({ page }) => {
  const drawer = await openTask(page, 102);
  await drawer.getByRole('tab', { name: 'Run' }).click();
  await drawer.getByRole('button', { name: 'Implement', exact: true }).click();
  await drawer.getByRole('button', { name: /Preview prompt/ }).click();

  const preview = page.getByRole('dialog', { name: 'Prompt for Implement' });
  await expect(preview).toContainText('Implement GitHub issue #102 ("Add progress bar")');
  await expect(preview).toContainText('alice/102-add-progress-bar');
});

test('the command palette finds a task by title and opens it', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox', { name: 'Search tasks, notes and commands' }).or(
    palette.getByLabel('Search tasks, notes and commands'),
  ).fill('progress');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');

  await expect(palette).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Issue 102' })).toBeVisible();
});

test('a note saved from the panel survives a reload', async ({ page }) => {
  const body = `Check the progress bar on narrow screens ${Date.now()}`;
  const panel = await notesPanel(page);
  await panel.getByRole('button', { name: /New note/ }).click();

  const editor = page.getByRole('dialog', { name: 'New note' });
  await editor.getByPlaceholder('What do you want to remember?').fill(body);
  await editor.getByPlaceholder('What do you want to remember?').press('Control+Enter');
  await expect(editor).toBeHidden();
  await expect(panel).toContainText(body);

  await page.reload();
  await expect(await notesPanel(page)).toContainText(body);
});

test('the document viewer covers the sticky pipeline bar', async ({ page }) => {
  // Regression: the workbench once rendered beneath the pinned board controls.
  const pipeline = page.getByRole('navigation', { name: 'Pipeline' });
  const box = (await pipeline.boundingBox())!;

  const drawer = await openTask(page, 102);
  await drawer.getByRole('tab', { name: 'Plan' }).click();
  await drawer.getByRole('button', { name: 'Open documents' }).click();
  await expect(page.getByRole('dialog', { name: 'Documents for #102' })).toBeVisible();

  const onTop = await page.evaluate(
    ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.doc-scrim'),
    { x: box.x + 20, y: box.y + box.height / 2 },
  );
  expect(onTop).toBe(true);
});

test('the notes task filter opens inside the window', async ({ page }) => {
  // Regression: the dropdown once opened off the right edge of the panel.
  const panel = await notesPanel(page);
  await panel.getByLabel(/^Filter by task:/).click();

  const options = panel.locator('.notes-task-options');
  await expect(options).toBeVisible();
  const box = (await options.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
});
