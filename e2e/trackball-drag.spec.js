/**
 * Globe drag behaviour tests.
 *
 * Verifies that horizontal drags always follow the mouse:
 * dragging right always decreases viewLng (surface moves with the cursor).
 */

import { test, expect } from '@playwright/test';
import { startRoom, startSelectGame } from './helpers.js';

const DRAG_PX = 120;   // horizontal drag distance in pixels — large enough to be unambiguous

/**
 * Set the globe to a known lat/lng orientation and return viewLng before drag.
 */
async function setOrientation(page, lat, lng) {
  await page.evaluate(([la, ln]) => window.__globeState.rotateToLatLng(la, ln), [lat, lng]);
  // Allow one animation frame for globe.updateMatrixWorld to propagate
  await page.waitForTimeout(50);
}

/**
 * Drag the globe horizontally by DRAG_PX starting from (startX, startY) in
 * viewport coordinates, then return { before, after } viewLng values.
 */
async function dragHorizontalAndReadLng(page, startX, startY) {
  const before = await page.evaluate(() => window.__globeState.viewLng);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + DRAG_PX, startY, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.__globeState.viewLng);
  return { before, after };
}

test.describe('globe drag — always follows mouse', () => {
  let page;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    await startRoom(page);
    await startSelectGame(page);
  });

  test.afterEach(async () => {
    await page.close();
  });

  test('equatorial view: drag right from centre → viewLng decreases (westward)', async () => {
    await setOrientation(page, 0, 90);   // Asia at centre, equatorial view

    const box = await page.locator('#globe-3d').boundingBox();
    const cx = box.x + box.width  / 2;
    const cy = box.y + box.height / 2;

    const { before, after } = await dragHorizontalAndReadLng(page, cx, cy);
    expect(after).toBeLessThan(before);  // surface follows mouse rightward
  });

  test('north-facing: drag right from below north pole → viewLng decreases', async () => {
    await setOrientation(page, 70, 0);   // north pole strongly toward camera

    const box    = await page.locator('#globe-3d').boundingBox();
    const poleY  = await page.evaluate(() => window.__globeState.poleScreenY);
    const startX = box.x + box.width / 2;
    const startY = box.y + poleY + 150;

    const { before, after } = await dragHorizontalAndReadLng(page, startX, startY);
    expect(after).toBeLessThan(before);
  });

  test('north-facing: drag right from above north pole → viewLng decreases', async () => {
    await setOrientation(page, 70, 0);   // north pole strongly toward camera

    const box    = await page.locator('#globe-3d').boundingBox();
    const poleY  = await page.evaluate(() => window.__globeState.poleScreenY);
    const startX = box.x + box.width / 2;
    const startY = box.y + poleY - 80;

    const { before, after } = await dragHorizontalAndReadLng(page, startX, startY);
    expect(after).toBeLessThan(before);
  });

  test('south-facing: drag right from above south pole → viewLng decreases', async () => {
    await setOrientation(page, -70, 0);  // south pole strongly toward camera

    const box    = await page.locator('#globe-3d').boundingBox();
    const poleY  = await page.evaluate(() => window.__globeState.poleScreenY);
    const startX = box.x + box.width / 2;
    const startY = box.y + poleY - 150;

    const { before, after } = await dragHorizontalAndReadLng(page, startX, startY);
    expect(after).toBeLessThan(before);
  });

  test('south-facing: drag right from below south pole → viewLng decreases', async () => {
    await setOrientation(page, -70, 0);  // south pole strongly toward camera

    const box    = await page.locator('#globe-3d').boundingBox();
    const poleY  = await page.evaluate(() => window.__globeState.poleScreenY);
    const startX = box.x + box.width / 2;
    const startY = box.y + poleY + 60;

    const { before, after } = await dragHorizontalAndReadLng(page, startX, startY);
    expect(after).toBeLessThan(before);
  });
});
