import { test, expect } from '@playwright/test';
import { startRoom, startSpyGame } from './helpers.js';

test('#spy-1 spy mode appears in mode selector and shows spy-picking overlay on start', async ({ page }) => {
  await startRoom(page, 'SpyHost');

  // Mode option should exist
  await expect(page.locator('#setting-mode option[value="spy"]')).toHaveCount(1);

  // Settings rows: guesses + challenges visible, questions + listsize hidden
  await page.locator('#setting-mode').selectOption('spy');
  await expect(page.locator('#setting-row-guesses')).toBeVisible();
  await expect(page.locator('#setting-row-challenges')).toBeVisible();
  await expect(page.locator('#setting-row-questions')).not.toBeVisible();
  await expect(page.locator('#setting-row-listsize')).not.toBeVisible();

  // Start game — spy overlay should appear
  await startSpyGame(page);
  await expect(page.locator('#overlay-spy-picking')).toBeVisible({ timeout: 10000 });
});

test('#spy-2 spy picking UI shows wheel canvas and confirm button (disabled until wheel used)', async ({ page }) => {
  await startRoom(page, 'SpyHost');
  await startSpyGame(page);

  // Host is the only player so they are the spy
  await expect(page.locator('#spy-picking-ui')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#spy-wheel-canvas')).toBeVisible();
  await expect(page.locator('#btn-spy-confirm')).toBeDisabled();
  await expect(page.locator('#btn-spy-spin')).toBeEnabled();
});

test('#spy-3 clicking spin enables confirm button', async ({ page }) => {
  await startRoom(page, 'SpyHost');
  await startSpyGame(page);

  await expect(page.locator('#spy-picking-ui')).toBeVisible({ timeout: 10000 });
  await page.locator('#btn-spy-spin').click();

  // After spin animation settles, confirm should be enabled and label populated
  await expect(page.locator('#btn-spy-confirm')).toBeEnabled({ timeout: 5000 });
  const label = await page.locator('#spy-selected-label').textContent();
  expect(label.trim().length).toBeGreaterThan(0);
});
