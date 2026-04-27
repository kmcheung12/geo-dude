/**
 * Tests #6 and #7: globe zoom and drag behaviour per game mode.
 *
 * Zoom is verified by checking that the ocean circle's `r` attribute
 * changes after a mouse-wheel event (D3 updates it on every zoom).
 *
 * Drag is verified by checking whether the first country path's `d`
 * attribute changes after a mouse drag gesture.
 * - highlight mode: drag is disabled → `d` must NOT change.
 * - select / proximity modes: drag is enabled → `d` MUST change.
 */

const { test, expect } = require('@playwright/test');
const {
  startRoom,
  startHighlightGame,
  startSelectGame,
  startProximityGame,
  dragGlobe,
  getFirstCountryPathD,
  zoomGlobe,
} = require('./helpers');

const MOBILE_VIEWPORT = { width: 390, height: 844 };

// ---------------------------------------------------------------------------
// Test #6 — "Name a country" (highlight): zoom works, drag is disabled
// ---------------------------------------------------------------------------

test.describe('#6 highlight mode — zoom enabled, drag disabled', () => {
  async function runTest(page) {
    await startRoom(page);
    await startHighlightGame(page);

    // --- Zoom: wheel up should increase the ocean radius ---
    const { before: rBefore, after: rAfter } = await zoomGlobe(page, -300);
    expect(rBefore).not.toBeNull();
    expect(rAfter).toBeGreaterThan(rBefore);

    // --- Drag: drag gesture must NOT rotate the globe ---
    const dBefore = await getFirstCountryPathD(page);
    await dragGlobe(page, 120, 0);
    await page.waitForTimeout(150);
    const dAfter = await getFirstCountryPathD(page);
    expect(dAfter).toBe(dBefore); // rotation did not change
  }

  test('#6 desktop — highlight zoom works and drag is disabled', async ({ page }) => {
    await runTest(page);
  });

  test.describe('mobile', () => {
    test.use({ viewport: MOBILE_VIEWPORT, hasTouch: true });

    test('#6 mobile — highlight zoom works and drag is disabled', async ({ page }) => {
      await runTest(page);
    });
  });
});

// ---------------------------------------------------------------------------
// Test #7 — "Find a country" and "Guess a country": zoom AND drag both work
// ---------------------------------------------------------------------------

async function verifyZoomAndDragEnabled(page) {
  // --- Zoom ---
  const { before: rBefore, after: rAfter } = await zoomGlobe(page, -300);
  expect(rBefore).not.toBeNull();
  expect(rAfter).toBeGreaterThan(rBefore);

  // --- Drag: drag gesture MUST rotate the globe ---
  const dBefore = await getFirstCountryPathD(page);
  await dragGlobe(page, 120, 0);
  await page.waitForTimeout(150);
  const dAfter = await getFirstCountryPathD(page);
  expect(dAfter).not.toBe(dBefore); // rotation changed
}

test.describe('#7 select mode — zoom and drag both enabled', () => {
  async function runTest(page) {
    await startRoom(page);
    await startSelectGame(page);
    await verifyZoomAndDragEnabled(page);
  }

  test('#7a desktop — select mode: zoom and drag work', async ({ page }) => {
    await runTest(page);
  });

  test.describe('mobile', () => {
    test.use({ viewport: MOBILE_VIEWPORT, hasTouch: true });

    test('#7a mobile — select mode: zoom and drag work', async ({ page }) => {
      await runTest(page);
    });
  });
});

test.describe('#7 proximity mode — zoom and drag both enabled', () => {
  async function runTest(page) {
    await startRoom(page);
    await startProximityGame(page);
    await verifyZoomAndDragEnabled(page);
  }

  test('#7b desktop — proximity mode: zoom and drag work', async ({ page }) => {
    await runTest(page);
  });

  test.describe('mobile', () => {
    test.use({ viewport: MOBILE_VIEWPORT, hasTouch: true });

    test('#7b mobile — proximity mode: zoom and drag work', async ({ page }) => {
      await runTest(page);
    });
  });
});
