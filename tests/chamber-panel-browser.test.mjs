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
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
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
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
    await page.route('https://live.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>relay test page</p>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const panel = page.locator('#chamber-live');
    const frame = page.locator('#chamber-live-player');
    assert.equal(await panel.getAttribute('open'), null);
    assert.equal(await frame.getAttribute('src'), null);
    await panel.locator('summary').click();
    await assertEventually(async () => assert.equal(await frame.getAttribute('src'), 'https://live.example.com/chamber_remote/', `${pageErrors.join('\n')}\nMissing: ${missing.join(', ')}`));
    assert.equal(await page.locator('#chamber-live-open').isVisible(), true);
    await panel.locator('summary').click();
    await assertEventually(async () => assert.equal(await frame.getAttribute('src'), null));
    assert.equal(await page.locator('#chamber-live-open').isVisible(), false);
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
