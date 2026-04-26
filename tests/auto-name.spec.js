const { test, expect } = require('@playwright/test');

test('empty name auto-assigns PlayerN and can start a round', async ({ page }) => {
  await page.goto('/');

  // Clear the name field and start a room
  await page.locator('#landing-name').clear();
  await page.getByRole('button', { name: 'Start a Room' }).click();

  // Should land on lobby screen — auto-assigned name shown in input
  await expect(page.locator('#screen-lobby')).toBeVisible({ timeout: 10000 });
  const nameInput = page.locator('#change-name-input');
  await expect(nameInput).toHaveValue(/^Player\d+$/);

  // Start Round button should be enabled and clickable
  const startBtn = page.locator('#btn-start');
  await expect(startBtn).toBeVisible();
  await startBtn.click();

  // Should advance to game screen
  await expect(page.locator('#screen-game')).toBeVisible();
});
