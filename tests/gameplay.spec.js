const { test, expect, devices } = require('@playwright/test');
const {
  startRoom,
  joinRoom,
  startHighlightGame,
  startSelectGame,
  startProximityGame,
  clickGlobeCenter,
  clickCountryOnGlobe,
} = require('./helpers');

// ---------------------------------------------------------------------------
// Test #1 — Start all 3 game modes after changing name
// ---------------------------------------------------------------------------

test('#1 can start all 3 game modes after changing name in lobby', async ({ page }) => {
  const modes = [
    { value: 'highlight', readyLocator: '#answer-panel .answer-btn' },
    { value: 'select',    readyLocator: '#panel-select' },
    { value: 'proximity', readyLocator: '#panel-proximity' },
  ];

  for (const mode of modes) {
    // Fresh room for each mode so we start from a clean lobby
    await startRoom(page, 'OriginalName');

    // Change name in lobby
    await page.locator('#change-name-input').fill('RenamedPlayer');
    await page.locator('#btn-change-name').click();

    // Start the round in the target mode
    await expect(page.locator('#btn-start')).toBeVisible({ timeout: 5000 });
    await page.locator('#setting-mode').selectOption(mode.value);
    await page.locator('#btn-start').click();

    // Verify game screen and mode-specific UI element appear
    await expect(page.locator('#screen-game')).toBeVisible({ timeout: 15000 });
    await expect(page.locator(mode.readyLocator).first()).toBeVisible({ timeout: 15000 });
  }
});

// ---------------------------------------------------------------------------
// Test #2 — "Name a country" (highlight): answer → overlay → Next
// ---------------------------------------------------------------------------

test('#2 highlight mode: selecting an answer shows overlay-card and Next skips to next question', async ({ page }) => {
  await startRoom(page);
  await startHighlightGame(page);

  // Click the first answer button
  await page.locator('#answer-panel .answer-btn').first().click();

  // Question-end overlay should appear
  await expect(page.locator('#overlay-question-end')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#overlay-question-end .overlay-card')).toBeVisible();

  // Click the qe-countdown spinner to fast-forward (host sends skipToNext)
  await page.locator('#qe-countdown').click();

  // Overlay should hide (next question incoming or round ends)
  await expect(page.locator('#overlay-question-end')).toBeHidden({ timeout: 10000 });
});

// ---------------------------------------------------------------------------
// Test #3 — "Find a country" (select): click globe → Confirm → overlay → Next
// ---------------------------------------------------------------------------

test('#3 select mode: confirming a selection shows overlay-card and Next skips to next question', async ({ page }) => {
  await startRoom(page);
  await startSelectGame(page);

  // Select a country on the globe
  await clickCountryOnGlobe(page);
  await expect(page.locator('#btn-confirm-select')).toBeEnabled({ timeout: 5000 });

  // Confirm the selection
  await page.locator('#btn-confirm-select').click();

  // Question-end overlay should appear (select mode uses the same overlay)
  await expect(page.locator('#overlay-question-end')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#overlay-question-end .overlay-card')).toBeVisible();

  // Skip to next
  await page.locator('#qe-countdown').click();
  await expect(page.locator('#overlay-question-end')).toBeHidden({ timeout: 10000 });
});

// ---------------------------------------------------------------------------
// Test #4 — "Guess a country" (proximity): place pin → Confirm → overlay → Next
// ---------------------------------------------------------------------------

test('#4 proximity mode: placing a pin and confirming shows overlay-card and Next skips to next', async ({ page }) => {
  await startRoom(page);
  await startProximityGame(page);

  // Click globe to place a pin (works anywhere on the visible globe face)
  await clickGlobeCenter(page);
  await expect(page.locator('#btn-lock-pin')).toBeEnabled({ timeout: 5000 });
  // The pin coordinates are sent to the server via a 300 ms debounce inside
  // onPinPlace. Wait for the debounce to fire before locking so the server
  // has player.pin set when lockPin arrives (otherwise the guard drops it).
  await page.waitForTimeout(500);

  // Lock the pin
  await page.locator('#btn-lock-pin').click();

  // Guess-end overlay should appear
  await expect(page.locator('#overlay-guess-end')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#overlay-guess-end .overlay-card')).toBeVisible();

  // Host sees the Skip button; click it to advance
  await expect(page.locator('#btn-skip-guess')).toBeVisible({ timeout: 5000 });
  await page.locator('#btn-skip-guess').click();

  // Overlay disappears (next guess or challenge-end follows)
  await expect(page.locator('#overlay-guess-end')).toBeHidden({ timeout: 10000 });
});

// ---------------------------------------------------------------------------
// Test #5 — Mobile versions of #2, #3, #4
// ---------------------------------------------------------------------------

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe('#5 mobile gameplay', () => {
  test.use({ viewport: MOBILE_VIEWPORT, hasTouch: true });

  test('#5a mobile — highlight mode: tap answer → overlay → tap Next', async ({ page }) => {
    await startRoom(page);
    await startHighlightGame(page);

    await page.locator('#answer-panel .answer-btn').first().tap();

    await expect(page.locator('#overlay-question-end')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#overlay-question-end .overlay-card')).toBeVisible();

    await page.locator('#qe-countdown').tap();
    await expect(page.locator('#overlay-question-end')).toBeHidden({ timeout: 10000 });
  });

  test('#5b mobile — select mode: tap country → tap Confirm → overlay → tap Next', async ({ page }) => {
    await startRoom(page);
    await startSelectGame(page);

    await clickCountryOnGlobe(page);
    await expect(page.locator('#btn-confirm-select')).toBeEnabled({ timeout: 5000 });

    await page.locator('#btn-confirm-select').tap();

    await expect(page.locator('#overlay-question-end')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#overlay-question-end .overlay-card')).toBeVisible();

    await page.locator('#qe-countdown').tap();
    await expect(page.locator('#overlay-question-end')).toBeHidden({ timeout: 10000 });
  });

  test('#5c mobile — proximity mode: tap globe → tap Confirm → overlay → tap Next', async ({ page }) => {
    await startRoom(page);
    await startProximityGame(page);

    await clickGlobeCenter(page);
    await expect(page.locator('#btn-lock-pin')).toBeEnabled({ timeout: 5000 });
    await page.waitForTimeout(500);

    await page.locator('#btn-lock-pin').tap();

    await expect(page.locator('#overlay-guess-end')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#overlay-guess-end .overlay-card')).toBeVisible();

    await expect(page.locator('#btn-skip-guess')).toBeVisible({ timeout: 5000 });
    await page.locator('#btn-skip-guess').tap();
    await expect(page.locator('#overlay-guess-end')).toBeHidden({ timeout: 10000 });
  });
});
