import { expect, test } from '@playwright/test';
import type { TaskWithDerived } from '../src/shared/types.ts';

test('clock ticks and note search leave unchanged board cards idle', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    // Observe our component inputs at the renderer boundary. This catches
    // lifting the seconds clock back into App or invalidating every card's props.
    type Fiber = { memoizedProps?: Record<string, unknown>; child?: Fiber; sibling?: Fiber };
    const state = { board: 0, cards: 0 };
    const previous = new Map<string | number, unknown>();
    Object.assign(window, {
      renderCounts: state,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        inject: () => 1,
        onCommitFiberUnmount() {},
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          const visit = (node: Fiber | undefined) => {
            if (!node) return;
            const props = node.memoizedProps && typeof node.memoizedProps === 'object' ? node.memoizedProps : undefined;
            const task = props?.task as { issue: number } | undefined;
            const key = props && 'onShowDone' in props && 'noteCounts' in props && !('phase' in props) ? 'board'
              : props && 'noteCount' in props && task ? task.issue : null;
            if (key !== null && props !== previous.get(key)) {
              if (key === 'board') state.board++;
              else state.cards++;
              previous.set(key, props);
            }
            visit(node.child); visit(node.sibling);
          };
          visit(root.current);
        },
      },
    });
  });
  await page.route('**/api/review-requests*', route => route.fulfill({ json: {
    pullRequests: [], worktrees: [], checkedAt: new Date().toISOString(), error: null, limitReached: false,
  } }));
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Pipeline' })).toBeVisible();
  await expect(page.locator('.notes-list')).toHaveAttribute('aria-busy', 'false');
  await page.clock.runFor(100);
  const counts = () => page.evaluate(() => (window as unknown as { renderCounts: { board: number; cards: number } }).renderCounts);
  const baseline = await counts();
  expect(baseline.board).toBeGreaterThan(0);
  expect(baseline.cards).toBeGreaterThan(0);
  await page.clock.runFor(3100);
  expect(await counts()).toEqual(baseline);
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('widget');
  expect((await counts()).cards).toBe(baseline.cards);
});

test('settled history reveals an edited off-page note and clamps after reopening it', async ({ page }) => {
  const projectId = 'acme__widgets';
  for (let index = 0; index < 21; index++) {
    const created = await page.request.post('/api/notes', { data: {
      projectId, clientRequestId: crypto.randomUUID(), title: `Settled widget ${String(index).padStart(2, '0')}`,
      body: `Archived widget findings ${index}`,
    } });
    expect(created.ok()).toBe(true);
    const { note } = await created.json();
    const settled = await page.request.patch(`/api/notes/${note.id}`, { data: {
      projectId, expectedRevision: note.revision, status: 'settled',
    } });
    expect(settled.ok()).toBe(true);
  }
  await page.goto('/');
  const panel = page.getByRole('complementary', { name: 'Notes' });
  await panel.getByRole('searchbox', { name: 'Search notes' }).fill('Settled widget');
  await panel.getByRole('button', { name: /Settled notes/ }).click();
  await expect(panel.locator('.notes-settled .notes-card')).toHaveCount(20);
  await panel.getByRole('navigation', { name: 'Settled note pages' }).getByRole('button', { name: 'Next', exact: true }).click();
  const oldest = panel.locator('.notes-card').filter({ has: page.getByRole('heading', { name: 'Settled widget 00', exact: true }) });
  await expect(oldest).toBeVisible();
  await oldest.getByRole('button', { name: 'Open', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note' });
  await editor.getByLabel('Title', { exact: false }).fill('Edited settled widget 00');
  await editor.getByPlaceholder('What do you want to remember?').press('Control+Enter');
  await expect(editor).toBeHidden();
  const edited = panel.locator('.notes-card').filter({ has: page.getByRole('heading', { name: 'Edited settled widget 00', exact: true }) });
  await expect(edited).toBeVisible();
  await expect(panel.locator('.notes-settled .notes-card')).toHaveCount(1);
  await edited.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(panel.locator('.notes-settled .notes-card')).toHaveCount(20);
  await expect(panel.locator('.notes-settled')).not.toContainText('Edited settled widget 00');
  await expect(edited).toBeVisible();
});

test('finished task history renders one page at a time', async ({ page }) => {
  const baseline = await (await page.request.get('/api/tasks')).json() as TaskWithDerived[];
  const tasks = Array.from({ length: 55 }, (_, index) => ({ ...baseline[0]!,
    issue: 200 + index, title: `Completed widget ${index}`,
    derived: { ...baseline[0]!.derived, displayPhase: 'done', derivedPhase: 'done' },
  }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream',
    body: `event: tasks\ndata: ${JSON.stringify(tasks)}\n\n`,
  }));
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Done 55$/ }).click();
  await expect(page.locator('.done-view .done-item')).toHaveCount(50);
  const pages = page.getByRole('navigation', { name: 'Finished task pages' });
  await pages.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.done-view .done-item')).toHaveCount(5);
  await expect(page.locator('.done-view')).toContainText('Completed widget 54');
  await pages.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.locator('.done-view .done-item')).toHaveCount(50);
});

test('note pages preserve full-text search, off-page reveal, and complete editor text', async ({ page }) => {
  const projectId = 'acme__widgets';
  for (let index = 0; index < 21; index++) {
    const response = await page.request.post('/api/notes', { data: {
      projectId, clientRequestId: crypto.randomUUID(), title: `Widget note ${String(index).padStart(2, '0')}`,
      body: `Widget details ${'x'.repeat(1800)} full-search-tail-${index}`,
    } });
    expect(response.ok()).toBe(true);
  }
  await page.goto('/');
  const panel = page.getByRole('complementary', { name: 'Notes' });
  await panel.getByRole('searchbox', { name: 'Search notes' }).fill('Widget note');
  await expect(panel.locator('.notes-card')).toHaveCount(20);
  const pages = panel.getByRole('navigation', { name: 'Active note pages' });
  await pages.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.locator('.notes-card')).toHaveCount(1);
  const oldest = panel.locator('.notes-card').filter({ has: page.getByRole('heading', { name: 'Widget note 00', exact: true }) });
  await expect(oldest).toBeVisible();
  expect((await oldest.locator('.notes-preview').textContent())!.length).toBeLessThan(600);
  await oldest.getByRole('button', { name: 'Open', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note' });
  await expect(editor.getByPlaceholder('What do you want to remember?')).toHaveValue(/full-search-tail-0$/);
  await editor.getByRole('button', { name: 'Close note editor' }).click();
  await pages.getByRole('button', { name: 'Previous', exact: true }).click();
  await panel.getByRole('button', { name: 'Hide notes', exact: true }).click();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByLabel('Search tasks, notes and commands').fill('Widget note 00');
  await page.keyboard.press('Enter');
  await expect(oldest).toBeVisible();
  await panel.getByRole('searchbox', { name: 'Search notes' }).fill('full-search-tail-20');
  await expect(panel.locator('.notes-card')).toHaveCount(1);
  await expect(panel.getByRole('heading', { name: 'Widget note 20', exact: true })).toBeVisible();
});

test('an attention-rail note opens on its page in the task drawer', async ({ page }) => {
  const projectId = 'acme__widgets';
  for (let index = 0; index < 21; index++) {
    const created = await page.request.post('/api/notes', { data: {
      projectId, clientRequestId: crypto.randomUUID(), taskIssue: 101,
      title: `Linked reminder ${String(index).padStart(2, '0')}`, body: 'Review widget behavior.',
    } });
    expect(created.ok()).toBe(true);
  }
  await page.clock.install({ time: new Date(Date.now() + 3 * 86_400_000) });
  await page.goto('/');
  const rail = page.getByRole('region', { name: /items need you/ });
  await rail.getByRole('button', { name: 'Linked reminder 00', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Issue 101' });
  await expect(drawer.getByRole('heading', { name: 'Linked reminder 00', exact: true })).toBeVisible();
});

test('saving a filtered settled task note reveals it after clearing the filter', async ({ page }) => {
  const projectId = 'acme__widgets';
  for (let index = 0; index < 21; index++) {
    const created = await page.request.post('/api/notes', { data: {
      projectId, clientRequestId: crypto.randomUUID(), taskIssue: 102,
      title: `Linked archive ${String(index).padStart(2, '0')}`, body: 'Archived widget findings.',
    } });
    expect(created.ok()).toBe(true);
    const { note } = await created.json();
    const settled = await page.request.patch(`/api/notes/${note.id}`, { data: {
      projectId, expectedRevision: note.revision, status: 'settled',
    } });
    expect(settled.ok()).toBe(true);
  }
  await page.goto('/');
  await page.getByRole('button', { name: /^Issue 102,/ }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Issue 102' });
  await drawer.getByRole('tab', { name: /^Notes/ }).click();
  const search = drawer.getByRole('searchbox', { name: 'Search task notes' });
  await search.fill('Linked archive 00');
  await drawer.getByRole('button', { name: /Settled notes/ }).click();
  await drawer.locator('.notes-card').getByRole('button', { name: 'Open', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note' });
  await editor.getByPlaceholder('What do you want to remember?').fill('Updated archived widget findings.');
  await editor.getByPlaceholder('What do you want to remember?').press('Control+Enter');
  await expect(editor).toBeHidden();
  await expect(search).toHaveValue('');
  await expect(drawer.getByRole('heading', { name: 'Linked archive 00', exact: true })).toBeVisible();
});
