/**
 * Tests #6 and #7: globe zoom and drag behaviour per game mode.
 *
 * Zoom is verified by checking that window.__globeState.cameraDistance
 * decreases after a wheel-in event (camera moves closer to globe).
 *
 * Drag is verified by checking window.__globeState.draggable:
 * - highlight mode: draggable === false
 * - select / proximity modes: draggable === true
 */

import { test, expect } from '@playwright/test';
import {
  startRoom,
  startHighlightGame,
  startSelectGame,
  startProximityGame,
  dragGlobe,
  zoomGlobe,
  getGlobeState,
} from './helpers.js';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

// ---------------------------------------------------------------------------
// Test #6 — "Name a country" (highlight): zoom works, drag is disabled
// ---------------------------------------------------------------------------

test.describe('#6 highlight mode — zoom enabled, drag disabled', () => {
  async function runTest(page) {
    await startRoom(page);
    await startHighlightGame(page);

    // --- Zoom: wheel in should decrease cameraDistance ---
    const { before, after } = await zoomGlobe(page, -300);
    expect(before).not.toBeNull();
    expect(after).toBeLessThan(before);

    // --- Drag: state should report draggable === false ---
    const state = await getGlobeState(page);
    expect(state.draggable).toBe(false);
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
  // --- Zoom: wheel in should decrease cameraDistance ---
  const { before, after } = await zoomGlobe(page, -300);
  expect(before).not.toBeNull();
  expect(after).toBeLessThan(before);

  // --- Drag: state should report draggable === true ---
  const state = await getGlobeState(page);
  expect(state.draggable).toBe(true);
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
