import { test, expect } from '@playwright/test';
import { startRoom, joinRoom, startSpyGame } from './helpers.js';

// Helper: extract room ID from the host page URL after startRoom
async function getRoomId(page) {
  const url = new URL(page.url());
  return url.searchParams.get('room');
}

// Helper: open the settings <details> fold if it exists and is closed
async function openSettingsFold(page) {
  const settingsFold = page.locator('.settings-fold');
  if (await settingsFold.count() > 0) {
    const summary = settingsFold.locator('summary');
    if (await summary.count() > 0) await summary.click();
  }
}

test('#spy-1 spy mode appears in mode selector and settings rows toggle correctly', async ({ page }) => {
  await startRoom(page, 'SpyHost');

  // Mode option should exist
  await expect(page.locator('#setting-mode option[value="spy"]')).toHaveCount(1);

  // Open the settings details fold before checking row visibility
  await openSettingsFold(page);

  // Select spy mode — guesses + challenges should be visible, questions + listsize hidden
  await page.locator('#setting-mode').selectOption('spy');
  await expect(page.locator('#setting-row-guesses')).toBeVisible();
  await expect(page.locator('#setting-row-challenges')).toBeVisible();
  await expect(page.locator('#setting-row-questions')).not.toBeVisible();
  await expect(page.locator('#setting-row-listsize')).not.toBeVisible();
});

// Helper: wait for spy overlay to appear and return the page that is the spy
async function waitForSpyPage(hostPage, guestPage) {
  // The spy picking UI is only shown to the player who is the spy.
  // Either host or guest could be chosen. Race both and return the winner.
  const hostUi = hostPage.locator('#spy-picking-ui');
  const guestUi = guestPage.locator('#spy-picking-ui');
  await Promise.race([
    expect(hostUi).toBeVisible({ timeout: 10000 }),
    expect(guestUi).toBeVisible({ timeout: 10000 }),
  ]);
  // Return whichever page has the visible spy-picking-ui
  if (await hostUi.isVisible()) return hostPage;
  return guestPage;
}

test('#spy-2 spy picking UI shows wheel canvas and confirm button (disabled until wheel used)', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();

  try {
    await startRoom(hostPage, 'SpyHost');
    const roomId = await getRoomId(hostPage);
    await joinRoom(guestPage, roomId, 'SpyGuest');

    // Wait for guest to appear in host's player list before starting
    await expect(hostPage.locator('#lobby-player-list .player-item')).toHaveCount(2, { timeout: 10000 });

    await startSpyGame(hostPage);

    // The overlay must be visible on host (it shows on all players)
    await expect(hostPage.locator('#overlay-spy-picking')).toBeVisible({ timeout: 10000 });

    // The spy-picking-ui (wheel) is only visible on the spy's page
    const spyPage = await waitForSpyPage(hostPage, guestPage);
    await expect(spyPage.locator('#spy-wheel-canvas')).toBeVisible();
    await expect(spyPage.locator('#btn-spy-confirm')).toBeDisabled();
    await expect(spyPage.locator('#btn-spy-spin')).toBeEnabled();
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('#spy-3 clicking spin enables confirm button', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();

  try {
    await startRoom(hostPage, 'SpyHost');
    const roomId = await getRoomId(hostPage);
    await joinRoom(guestPage, roomId, 'SpyGuest');

    // Wait for guest to appear in host's player list before starting
    await expect(hostPage.locator('#lobby-player-list .player-item')).toHaveCount(2, { timeout: 10000 });

    await startSpyGame(hostPage);

    // Find the spy's page (the one with the wheel UI)
    const spyPage = await waitForSpyPage(hostPage, guestPage);
    await spyPage.locator('#btn-spy-spin').click();

    // After spin animation settles, confirm should be enabled and label populated
    await expect(spyPage.locator('#btn-spy-confirm')).toBeEnabled({ timeout: 5000 });
    const label = await spyPage.locator('#spy-selected-label').textContent();
    expect(label.trim().length).toBeGreaterThan(0);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
