const { expect } = require('@playwright/test');

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
}

/**
 * Click the center of the globe wrapper.
 * In proximity mode this always places a pin (projection.invert is valid at centre).
 */
async function clickGlobeCenter(page) {
  const box = await page.locator('#globe-wrapper').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
}

/**
 * Attempt to click a land area on the globe for select mode.
 *
 * Strategy: find a path.country element whose centre is inside the browser
 * viewport AND has a non-trivial d attribute (front-hemisphere countries have
 * real path data; back-hemisphere ones are clipped to empty strings by D3's
 * clipAngle(90)). Click its centre via page.mouse so we stay in SVG coords.
 *
 * Falls back to probing known-land offsets at default rotation [0, 0].
 */
async function clickCountryOnGlobe(page) {
  const pos = await page.evaluate(() => {
    for (const path of document.querySelectorAll('#globe-wrapper svg path.country')) {
      const d = path.getAttribute('d');
      if (!d || d.length < 20) continue; // empty = back hemisphere

      const rect = path.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue; // degenerate

      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      if (cx > 0 && cx < window.innerWidth && cy > 0 && cy < window.innerHeight) {
        return { x: cx, y: cy };
      }
    }
    return null;
  });

  if (pos) {
    await page.mouse.click(pos.x, pos.y);
    try {
      await expect(page.locator('#btn-confirm-select')).toBeEnabled({ timeout: 2000 });
      return;
    } catch {
      // path centre was ocean despite heuristics — fall through to probes
    }
  }

  // Fallback: probe known-land positions at default rotation [0, 0].
  // Centre = (lon 0°, lat 0°) — Atlantic. Shifting right hits Central Africa.
  const box = await page.locator('#globe-wrapper').boundingBox();
  const probeOffsets = [
    [0.58, 0.42], // ~lon 20°E, lat 5°N — Congo basin
    [0.52, 0.38], // ~Europe
    [0.62, 0.50], // East Africa
    [0.48, 0.46], // West Africa
  ];
  for (const [rx, ry] of probeOffsets) {
    await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
    try {
      await expect(page.locator('#btn-confirm-select')).toBeEnabled({ timeout: 1000 });
      return;
    } catch {
      // miss — try next offset
    }
  }
}

/**
 * Simulate a mouse drag on the globe SVG by (dx, dy) pixels from centre.
 */
async function dragGlobe(page, dx, dy) {
  const box = await page.locator('#globe-wrapper').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
  await page.mouse.up();
}

/**
 * Return the current r attribute of the globe's ocean circle (a proxy for zoom level).
 */
async function getOceanRadius(page) {
  return page.evaluate(() => {
    const circle = document.querySelector('#globe-wrapper svg circle.ocean');
    return circle ? parseFloat(circle.getAttribute('r')) : null;
  });
}

/**
 * Return the d attribute of the first front-hemisphere country path.
 * Waits until at least one path has a non-trivial d value (back-hemisphere
 * paths have empty d attributes due to D3's clipAngle(90)).
 */
async function getFirstCountryPathD(page) {
  await page.waitForFunction(
    () => [...document.querySelectorAll('#globe-wrapper svg path.country')]
      .some(p => (p.getAttribute('d') || '').length > 20),
    { timeout: 15000 }
  );
  return page.evaluate(() => {
    for (const path of document.querySelectorAll('#globe-wrapper svg path.country')) {
      const d = path.getAttribute('d');
      if (d && d.length > 20) return d;
    }
    return null;
  });
}

/**
 * Wheel-zoom in on the globe from its centre and return { before, after } ocean radii.
 */
async function zoomGlobe(page, deltaY = -300) {
  const box = await page.locator('#globe-wrapper').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await getOceanRadius(page);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(150); // allow D3 to redraw
  const after = await getOceanRadius(page);
  return { before, after };
}

module.exports = {
  startRoom,
  joinRoom,
  startHighlightGame,
  startSelectGame,
  startProximityGame,
  clickGlobeCenter,
  clickCountryOnGlobe,
  dragGlobe,
  getOceanRadius,
  getFirstCountryPathD,
  zoomGlobe,
};
