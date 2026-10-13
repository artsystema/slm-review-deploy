import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '../../frontend/node_modules/playwright/index.mjs';

const browserPath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const publicRoot = resolve(import.meta.dirname, '../public');

test('chamber and build rail layouts work across widths; chamber access follows visible tabs', { skip: !existsSync(browserPath) }, async () => {
  const rendered = spawnSync('php', [join(import.meta.dirname, 'chamber-panel.test.php'), '--render'], { encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  const missing = [];
  let allowAccess = true;
  let accessRequests = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/api/v1/chamber/access' && request.method === 'POST') {
      accessRequests += 1;
      if (!allowAccess) { response.writeHead(403).end(); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ url: 'https://live.example.com/chamber/access#test-grant' }));
      return;
    }
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(rendered.stdout);
      return;
    }
    if (pathname.startsWith('/assets/') && /^\/assets\/[a-z0-9.-]+$/.test(pathname)) {
      try {
        const body = readFileSync(join(publicRoot, pathname));
        response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
        response.end(body);
      } catch { missing.push(request.url); response.writeHead(404).end(); }
      return;
    }
    missing.push(request.url);
    response.writeHead(404).end();
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    for (const width of [1600, 1480, 1479, 1000, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
      // Stands in for the relay player: announces itself, reports a live
      // picture, and records whether the review page took over the caption.
      const relayPage = `<script>
        addEventListener('message', (event) => { if (event.source === parent && event.data?.type === 'slm-chamber-host') document.body.dataset.hosted = '1'; });
        parent.postMessage({ type: 'slm-chamber-access', state: 'ready' }, '*');
        parent.postMessage({ type: 'slm-chamber-video', state: 'live', width: 640, height: 480, fps: 12, uploadedAt: new Date().toISOString() }, '*');
      </script><p>relay test page</p>`;
      await page.route('https://live.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: relayPage }));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const panel = page.locator('#chamber-live');
      const frame = page.locator('#chamber-live-player');
      const viewer = page.locator('.viewer-card');
      const details = page.locator('.evidence-card');
      const chamberBox = await panel.boundingBox();
      const viewerBox = await viewer.boundingBox();
      const detailsBox = await details.boundingBox();
      if (width > 760) {
        assert.ok(chamberBox.x < viewerBox.x && detailsBox.y > chamberBox.y, 'chamber and selected layer should stack beside the viewer');
        assert.ok(Math.abs(chamberBox.x - detailsBox.x) < 1 && Math.abs(chamberBox.width - detailsBox.width) < 1, 'side cards share one column');
        assert.ok(Math.abs(chamberBox.y - viewerBox.y) < 2, 'camera and viewer start level');
        const bottoms = [viewerBox.y + viewerBox.height, detailsBox.y + detailsBox.height];
        assert.ok(Math.abs(bottoms[0] - bottoms[1]) < 2, `the side column should end with the viewer: ${bottoms.join(', ')}`);
        if (width >= 1480) {
          assert.ok(chamberBox.width >= 539 && chamberBox.width <= 541, 'wide desktop should give the side column 540px');
          assert.ok(viewerBox.width >= width - 540 - 60, 'the viewer takes the rest of the width');
        }
      } else {
        assert.ok(chamberBox.y < viewerBox.y && viewerBox.y < detailsBox.y, 'phone cards should stack');
      }
      assert.equal(await panel.locator('summary').count(), 0);
      assert.equal(await page.locator('#chamber-live-open').count(), 0);
      await assertEventually(async () => assert.equal(await frame.getAttribute('src'), 'https://live.example.com/chamber/access#test-grant', `${pageErrors.join('\n')}\nMissing: ${missing.join(', ')}`));
      const frameBox = await frame.boundingBox();
      assert.ok(frameBox.width <= chamberBox.width && frameBox.width >= chamberBox.width - 3, 'player should span the card like the evidence stage');
      assert.ok(frameBox.height >= frameBox.width * 0.75 - 2, 'player should be at least 4:3, with no caption strip below the picture');
      await assertEventually(async () => assert.equal(await page.locator('#chamber-badge').getAttribute('data-state'), 'live'));
      assert.match(await page.locator('#chamber-caption').textContent(), /640 × 480 · 12 FPS · updated /);
      assert.equal(await page.locator('#chamber-live-status').isVisible(), false, 'no message is laid over a live picture');
      await assertEventually(async () => assert.equal(await page.frameLocator('#chamber-live-player').locator('body[data-hosted="1"]').count(), 1));
      const enlargeBox = await page.locator('#chamber-lightbox-open').boundingBox();
      assert.ok(enlargeBox.y > frameBox.y + frameBox.height / 2 && enlargeBox.x > frameBox.x + frameBox.width / 2, 'enlarge control belongs bottom-right, clear of the burned-in counter');
      assert.ok(Number(await page.locator('.chamber-media-controls').evaluate((node) => getComputedStyle(node).opacity)) < 1, 'enlarge control stays dimmed over the picture');
      await page.locator('#chamber-lightbox-open').hover();
      await assertEventually(async () => assert.equal(await page.locator('.chamber-media-controls').evaluate((node) => getComputedStyle(node).opacity), '1'));
      await page.evaluate(() => {
        document.querySelector('#build-rail').hidden = false;
        document.querySelector('#build-rail-name').textContent = 'Build 1310, extended print name';
        document.querySelector('#build-rail-count-value').textContent = '1,310 of 2,355';
        const eta = document.querySelector('#build-rail-eta');
        eta.textContent = '≈12h 35m left';
        eta.hidden = false;
      });
      const countValueBox = await page.locator('#build-rail-count-value').boundingBox();
      const etaBox = await page.locator('#build-rail-eta').boundingBox();
      const railTrackBox = await page.locator('#build-rail-track').boundingBox();
      assert.equal(await page.locator('#build-rail-eta').evaluate((node) => node.parentElement.id), 'build-rail-count');
      assert.ok(etaBox.x >= countValueBox.x + countValueBox.width, 'ETA label follows the count on its line');
      assert.ok(Math.abs((etaBox.y + etaBox.height / 2) - (countValueBox.y + countValueBox.height / 2)) < 3, 'ETA label is centred on the count');
      assert.ok(railTrackBox.y > etaBox.y + etaBox.height, 'the progress track should follow the count and ETA');
      assert.equal(await page.locator('#scrub-bubble').isVisible(), false, 'the scrub bubble must not show empty before any hover');
      assert.ok(await page.locator('#build-rail').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'build rail should not overflow');
      await page.locator('#chamber-lightbox-open').click();
      assert.equal(await panel.getAttribute('role'), 'dialog');
      assert.equal(await panel.getAttribute('aria-modal'), 'true');
      assert.equal(await page.locator('#chamber-lightbox-backdrop').isVisible(), true);
      assert.equal(await frame.getAttribute('src'), 'https://live.example.com/chamber/access#test-grant', 'enlarging keeps the same iframe');
      await page.keyboard.press('Escape');
      assert.equal(await panel.getAttribute('role'), null);
      assert.equal(await page.locator('#chamber-lightbox-backdrop').isVisible(), false);
      const beforeHide = accessRequests;
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await assertEventually(async () => assert.equal(await frame.getAttribute('src'), null));
      assert.match(await page.locator('#chamber-live-status').textContent(), /paused/i);
      assert.equal(await page.locator('#chamber-badge').getAttribute('data-state'), 'paused');
      assert.match(await page.locator('#chamber-caption').textContent(), /On demand/);
      assert.equal(accessRequests, beforeHide);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await assertEventually(async () => assert.equal(accessRequests, beforeHide + 1));
      await assertEventually(async () => assert.equal(await frame.getAttribute('src'), 'https://live.example.com/chamber/access#test-grant'));
      await page.close();
    }
    allowAccess = false;
    const denied = await browser.newPage();
    await denied.goto(`http://127.0.0.1:${server.address().port}/`);
    await assertEventually(async () => assert.match(await denied.locator('#chamber-live-status').textContent(), /retrying automatically/i));
    assert.equal(await denied.locator('#chamber-live-player').getAttribute('src'), null);
    const beforeRetry = accessRequests;
    allowAccess = true;
    await assertEventually(async () => assert.ok(accessRequests > beforeRetry), 6500);
    await assertEventually(async () => assert.equal(await denied.locator('#chamber-live-player').getAttribute('src'), 'https://live.example.com/chamber/access#test-grant'));
    await denied.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

async function assertEventually(check, timeoutMs = 2000) {
  let last;
  const deadline = Date.now() + timeoutMs;
  do {
    try { await check(); return; }
    catch (error) { last = error; await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
  } while (Date.now() < deadline);
  throw last;
}
