/**
 * Test: screenToLatLng math — rotating globe to Singapore's coordinates
 * (1°21′N 103°E) and sampling the canvas centre must decode back to those
 * same coordinates (within ±1°).
 *
 * Note: Singapore is absent from the 110m topojson, so we validate the
 * raw lat/lng returned by screenToLatLng rather than the hovered country name.
 *
 * Setup:
 *   1. Start a select game (which calls api.load, registering screenToLatLng).
 *   2. Instantly rotate the globe so Singapore's coordinates face the camera.
 *   3. Wait one render frame for matrixWorld to update.
 *   4. Sample screenToLatLng at the canvas centre.
 *   5. Assert lat ≈ 1.35 and lng ≈ 103.0 (within ±1°).
 */

const { test, expect } = require('@playwright/test');
const { startRoom, startSelectGame } = require('./helpers');

const SINGAPORE_LAT = 1.35;   // 1°21′00″N
const SINGAPORE_LNG = 103.0;  // 103°00′00″E
const TOLERANCE_DEG = 1.0;

test('screenToLatLng — canvas centre decodes to Singapore coordinates after rotation', async ({ page }) => {
  await startRoom(page);
  await startSelectGame(page);

  // Rotate globe so Singapore faces the camera (instant, no animation).
  await page.evaluate(([lat, lng]) => {
    window.__globeState.rotateToLatLng(lat, lng);
  }, [SINGAPORE_LAT, SINGAPORE_LNG]);

  // Wait two render frames (~32 ms) for matrixWorld to propagate.
  await page.waitForTimeout(100);

  // Sample the canvas centre via the exposed screenToLatLng hook.
  const box = await page.locator('#globe-3d').boundingBox();
  const cx = box.x + box.width  / 2;
  const cy = box.y + box.height / 2;

  const ll = await page.evaluate(([x, y]) => window.__globeState.screenToLatLngAt(x, y), [cx, cy]);

  expect(ll).not.toBeNull();
  expect(ll.lat).toBeGreaterThan(SINGAPORE_LAT - TOLERANCE_DEG);
  expect(ll.lat).toBeLessThan   (SINGAPORE_LAT + TOLERANCE_DEG);
  expect(ll.lng).toBeGreaterThan(SINGAPORE_LNG - TOLERANCE_DEG);
  expect(ll.lng).toBeLessThan   (SINGAPORE_LNG + TOLERANCE_DEG);
});
