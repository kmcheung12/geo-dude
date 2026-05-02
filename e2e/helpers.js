import { expect } from '@playwright/test';

const TIMEOUT = 15000;

/**
 * Navigate to landing, fill name, click "Start a Room", wait for lobby.
 */
async function startRoom(page, name = 'TestHost') {
  await page.goto('/');
  await page.locator('#landing-name').fill(name);
  await page.locator('#btn-start-room').click();
  await expect(page.locator('#screen-lobby')).toBeVisible({ timeout: TIMEOUT });
}

/**
 * Navigate to landing, open join screen, fill room ID + name, click Join,
 * wait for lobby.
 */
async function joinRoom(page, roomId, name = 'TestGuest') {
  await page.goto('/');
  await page.locator('#btn-join-room').click();
  await page.locator('#join-room-id').fill(roomId);
  await page.locator('#join-name').fill(name);
  await page.locator('#btn-join').click();
  await expect(page.locator('#screen-lobby')).toBeVisible({ timeout: TIMEOUT });
}

/**
 * From the lobby as host, select "Name the country" (highlight) mode,
 * click Start Round, and wait until the first question's answer buttons appear.
 */
async function startHighlightGame(page) {
  await expect(page.locator('#btn-start')).toBeVisible({ timeout: TIMEOUT });
  await page.locator('#setting-mode').selectOption('highlight');
  await page.locator('#btn-start').click();
  await expect(page.locator('#screen-game')).toBeVisible({ timeout: TIMEOUT });
  // Globe loads asynchronously; wait for answer buttons to be injected
  await expect(page.locator('#answer-panel .answer-btn').first()).toBeVisible({ timeout: TIMEOUT });
}

/**
 * From the lobby as host, select "Find a country" (select) mode,
 * click Start Round, and wait until the panel-select becomes visible.
 */
async function startSelectGame(page) {
  await expect(page.locator('#btn-start')).toBeVisible({ timeout: TIMEOUT });
  await page.locator('#setting-mode').selectOption('select');
  await page.locator('#btn-start').click();
  await expect(page.locator('#screen-game')).toBeVisible({ timeout: TIMEOUT });
  await expect(page.locator('#panel-select')).toBeVisible({ timeout: TIMEOUT });
  // Wait for the camera transition to finish so clicks land in the right place.
  await page.waitForFunction(
    () => window.__globeState && !window.__globeState.cameraTransitioning,
    { timeout: TIMEOUT }
  );
}

/**
 * From the lobby as host, select "Guess a country" (proximity) mode,
 * click Start Round, and wait until the panel-proximity becomes visible.
 */
async function startProximityGame(page) {
  await expect(page.locator('#btn-start')).toBeVisible({ timeout: TIMEOUT });
  await page.locator('#setting-mode').selectOption('proximity');
  await page.locator('#btn-start').click();
  await expect(page.locator('#screen-game')).toBeVisible({ timeout: TIMEOUT });
  await expect(page.locator('#panel-proximity')).toBeVisible({ timeout: TIMEOUT });
  // Wait for the camera transition to finish so interactions are accurate.
  await page.waitForFunction(
    () => window.__globeState && !window.__globeState.cameraTransitioning,
    { timeout: TIMEOUT }
  );
}

/**
 * Click the center of the 3D globe canvas.
 * In proximity mode this places a pin wherever the globe surface is at centre.
 */
async function clickGlobeCenter(page) {
  const box = await page.locator('#globe-3d').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
}

/**
 * Attempt to click a land area on the 3D globe canvas for select mode.
 *
 * The 3D globe is centred at (lon 0°, lat 0°) by default. Probes offsets
 * slightly right-of-centre to hit Central/West Africa (large land mass).
 * The click handler in globe3d.js uses geoContains to confirm a country hit.
 */
async function clickCountryOnGlobe(page) {
  const box = await page.locator('#globe-3d').boundingBox();
  // Probe offsets relative to canvas centre — right side hits Africa
  const probeOffsets = [
    [0.56, 0.42], // ~lon 15°E, lat 8°N — Central Africa (large land mass)
    [0.52, 0.38], // ~lon 5°E, lat 15°N — West Africa
    [0.60, 0.50], // ~lon 25°E, lat 0°N — East Africa
    [0.54, 0.46], // ~lon 10°E, lat 3°N — Congo basin
    [0.50, 0.35], // ~lon 0°E, lat 20°N — North Africa
  ];
  for (const [rx, ry] of probeOffsets) {
    await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
    try {
      await expect(page.locator('#btn-confirm-select')).toBeEnabled({ timeout: 1500 });
      return;
    } catch {
      // miss — try next offset
    }
  }
}

/**
 * Simulate a mouse drag on the 3D globe canvas by (dx, dy) pixels from centre.
 */
async function dragGlobe(page, dx, dy) {
  const box = await page.locator('#globe-3d').boundingBox();
  const cx = box.x + box.width  / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
  await page.mouse.up();
}

/**
 * Return window.__globeState from the page (camera distance, draggable, zoomable).
 */
async function getGlobeState(page) {
  return page.evaluate(() => ({
    cameraDistance: window.__globeState ? window.__globeState.cameraDistance : null,
    draggable:      window.__globeState ? window.__globeState.draggable      : null,
    zoomable:       window.__globeState ? window.__globeState.zoomable       : null,
  }));
}

/**
 * Wheel-zoom on the globe canvas and return { before, after } camera distances.
 */
async function zoomGlobe(page, deltaY = -300) {
  const box = await page.locator('#globe-3d').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await page.evaluate(() => window.__globeState ? window.__globeState.cameraDistance : null);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__globeState ? window.__globeState.cameraDistance : null);
  return { before, after };
}

export {
  startRoom,
  joinRoom,
  startHighlightGame,
  startSelectGame,
  startProximityGame,
  clickGlobeCenter,
  clickCountryOnGlobe,
  dragGlobe,
  zoomGlobe,
  getGlobeState,
};
