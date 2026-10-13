import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '../../frontend/node_modules/playwright/index.mjs';

const browserPath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const publicRoot = resolve(import.meta.dirname, '../public');

test('chamber iframe follows visible tabs, retries access, and enlarges in place', { skip: !existsSync(browserPath) }, async () => {
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
      await page.route('https://live.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<script>parent.postMessage({type:"slm-chamber-access",state:"ready"},"*")</script><p>relay test page</p>' }));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const panel = page.locator('#chamber-live');
      const frame = page.locator('#chamber-live-player');
      const viewer = page.locator('.viewer-card');
      const details = page.locator('.evidence-card');
      if (width >= 1480) {
        await assertEventually(async () => {
          const heights = await Promise.all([panel, viewer, details].map((item) => item.evaluate((node) => node.getBoundingClientRect().height)));
          assert.ok(Math.max(...heights) - Math.min(...heights) < 2, `desktop card heights: ${heights.join(', ')}`);
        });
      }
      const chamberBox = await panel.boundingBox();
      const viewerBox = await viewer.boundingBox();
      const detailsBox = await details.boundingBox();
      if (width >= 1480) {
        assert.ok(chamberBox.x < viewerBox.x && viewerBox.x < detailsBox.x, 'desktop should have chamber, viewer, details columns');
        assert.ok(chamberBox.width >= 539 && chamberBox.width <= 541, 'wide desktop should give chamber a 540px column');
        assert.ok(viewerBox.width >= 540, 'wide desktop should keep evidence viewer readable');
        assert.ok(Math.abs(chamberBox.y - viewerBox.y) < 2 && Math.abs(viewerBox.y - detailsBox.y) < 2);
        assert.ok(Math.abs(chamberBox.height - viewerBox.height) < 2, 'chamber should match viewer height');
        assert.ok(Math.abs(detailsBox.height - viewerBox.height) < 2, `selected layer should match viewer height: ${JSON.stringify({ chamberBox, viewerBox, detailsBox })}`);
      } else if (width > 760) {
        assert.ok(chamberBox.x < viewerBox.x && detailsBox.y > chamberBox.y, 'tablet should keep chamber and details beside viewer');
      } else {
        assert.ok(chamberBox.y < viewerBox.y && viewerBox.y < detailsBox.y, 'phone cards should stack');
      }
      assert.equal(await panel.locator('summary').count(), 0);
      assert.equal(await page.locator('#chamber-live-open').count(), 0);
      await assertEventually(async () => assert.equal(await frame.getAttribute('src'), 'https://live.example.com/chamber/access#test-grant', `${pageErrors.join('\n')}\nMissing: ${missing.join(', ')}`));
      const frameBox = await frame.boundingBox();
      assert.ok(frameBox.width <= chamberBox.width);
      assert.ok(Math.abs(frameBox.height - frameBox.width) < 2, 'player frame should use a compact square in the sidebar');
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
