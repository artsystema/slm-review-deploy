import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '../../frontend/node_modules/playwright/index.mjs';

const browserPath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const publicRoot = resolve(import.meta.dirname, '../public');

test('chamber iframe loads only while the remote review panel is open', { skip: !existsSync(browserPath) }, async () => {
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
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
      await page.route('https://live.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<script>parent.postMessage({type:"slm-chamber-access",state:"ready"},"*")</script><p>relay test page</p>' }));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const panel = page.locator('#chamber-live');
      const frame = page.locator('#chamber-live-player');
      assert.equal(await panel.getAttribute('open'), null);
      assert.equal(await frame.getAttribute('src'), null);
      await panel.locator('summary').click();
      await assertEventually(async () => assert.equal(await frame.getAttribute('src'), 'https://live.example.com/chamber/access#test-grant', `${pageErrors.join('\n')}\nMissing: ${missing.join(', ')}`));
      await assertEventually(async () => assert.equal(await page.locator('#chamber-live-open').isVisible(), true));
      assert.ok((await frame.boundingBox()).width <= width);
      const beforeHide = accessRequests;
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await assertEventually(async () => assert.equal(await frame.getAttribute('src'), null));
      assert.equal(await page.locator('#chamber-live-open').isVisible(), false);
      assert.equal(accessRequests, beforeHide);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await assertEventually(async () => assert.equal(accessRequests, beforeHide + 1));
      await assertEventually(async () => assert.equal(await frame.getAttribute('src'), 'https://live.example.com/chamber/access#test-grant'));
      await panel.locator('summary').click();
      await assertEventually(async () => assert.equal(await frame.getAttribute('src'), null));
      assert.equal(await page.locator('#chamber-live-open').isVisible(), false);
      await page.close();
    }
    allowAccess = false;
    const denied = await browser.newPage();
    await denied.goto(`http://127.0.0.1:${server.address().port}/`);
    await denied.locator('#chamber-live summary').click();
    await assertEventually(async () => assert.match(await denied.locator('#chamber-live-status').textContent(), /access is unavailable/i));
    assert.equal(await denied.locator('#chamber-live-player').getAttribute('src'), null);
    await denied.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

async function assertEventually(check) {
  let last;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await check(); return; }
    catch (error) { last = error; await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
  }
  throw last;
}
