import { expect, test, type Page } from '@playwright/test';

import type { ReviewDashboardSnapshot } from '../src/shared/review-requests.ts';

/**
 * Smoke tests over the real app (see e2e/server.ts for the fixture board):
 * #101 waits in the inbox, #102 has a finished plan held in Plan for review,
 * #103 has an open PR with failing checks.
 */

test.beforeEach(async ({ page }) => {
  // The one GitHub call a page load makes. Answered here so nothing leaves the machine.
  const empty: ReviewDashboardSnapshot = { pullRequests: [], worktrees: [], checkedAt: new Date().toISOString(), error: null, limitReached: false };
  await page.route('**/api/review-requests*', (route) => route.fulfill({ json: empty }));
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Pipeline' })).toBeVisible();
});

/** The notes side panel, opened if a previous visit left it closed. */
async function notesPanel(page: Page) {
  const panel = page.getByRole('complementary', { name: 'Notes' });
  const toggle = page.getByRole('button', { name: /^Notes \d+$/ });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
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

test('stack selection targets the child PR without changing the issue phase or refreshing GitHub', async ({ page }) => {
  const drawer = await openTask(page, 103);
  await expect(drawer.getByRole('list', { name: 'PR layers' }).getByRole('listitem')).toHaveCount(3);
  await drawer.getByRole('button', { name: 'Implement', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Launch Implement', exact: true })).toBeDisabled();
  await drawer.getByRole('radio', { name: 'Issue worktree', exact: true }).check();
  await expect(drawer.getByRole('button', { name: 'Launch Implement', exact: true })).toBeEnabled();
  await drawer.getByRole('button', { name: /Preview prompt/ }).click();
  const preview = page.getByRole('dialog', { name: 'Prompt for Implement' });
  await expect(preview).toContainText('alice/103-fix-sign-in-redirect');
  await expect(preview).not.toContainText('Work on this PR only');
  await preview.getByRole('button', { name: /Back to editing/ }).click();
  let reconciles = 0;
  page.on('request', request => { if (/\/api\/(reconcile|tasks)$/.test(request.url())) reconciles++; });
  await drawer.getByRole('radio', { name: '#8 Complete redirect flow', exact: true }).check();
  await expect(drawer.getByRole('radio', { name: '#8 Complete redirect flow', exact: true })).toBeChecked();
  expect(reconciles).toBe(0);
  await expect(drawer).toContainText('Target PR #8: alice/layer-8');
  await drawer.getByRole('button', { name: /Preview prompt/ }).click();
  await expect(preview).toContainText('alice/layer-8');
  await expect(preview).toContainText('alice/layer-7');
  await expect(preview).toContainText('issue-103');
  await expect(page.getByRole('region', { name: /^CI, 1 task$/ }).getByRole('button', { name: /^Issue 103,/ })).toBeVisible();
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

test('moving a task uses the returned board without a second reconcile', async ({ page }) => {
  const drawer = await openTask(page, 101);
  await drawer.getByRole('tab', { name: 'Setup' }).click();
  const reconciles: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/reconcile')) reconciles.push(request.url()); });
  try {
    const response = page.waitForResponse(response => response.url().endsWith('/api/tasks/101/move'));
    await drawer.locator('select').filter({ has: page.getByRole('option', { name: 'Follow real status', exact: true }) }).selectOption('plan');
    await response;
    await expect(page.getByRole('region', { name: /^Plan, 2 tasks$/ }).getByRole('button', { name: /^Issue 101,/ })).toBeVisible();
    expect(reconciles).toEqual([]);
  } finally {
    await page.request.post('/api/tasks/101/move', { data: { phase: null } });
  }
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
