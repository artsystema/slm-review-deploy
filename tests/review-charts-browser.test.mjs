/**
 * The selected-layer stat tiles and the two build charts, in a real browser.
 *
 * Run with:  node --test remote-review/tests/review-charts-browser.test.mjs
 * Set REVIEW_SCREENSHOTS to a directory to keep a screenshot per width.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '../../frontend/node_modules/playwright/index.mjs';

const browserPath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const publicRoot = resolve(import.meta.dirname, '../public');
const monitor = 'efa4fcd0-3c9c-4a17-a892-a85875b6fd61';

// A development fixture, not printer data: a 600-layer build numbered from
// 1755 with a run of flagged layers, renewal reported only after layer 1900,
// and two argon channels.
const layers = Array.from({ length: 600 }, (_, position) => {
  const index = 1755 + position;
  const flagged = position > 300 && position < 330;
  const renewal = index > 1900;
  return {
    id: position + 1,
    run_local_id: 4,
    run_mode: 'watch',
    index,
    captured_at: new Date(Date.UTC(2026, 9, 16, 8) + position * 60e3).toISOString(),
    analysis: {
      status: 'completed',
      severity: flagged ? 'warning' : 'none',
      state: flagged ? 'deficit' : 'clear',
      confidence: flagged ? 0.82 : 0,
      deficit_area_frac: flagged ? 0.004 + (position % 5) * 0.001 : 0.0002 + (position % 7) * 0.00004,
      renewal_unrenewed_frac: renewal ? (flagged ? 0.006 : 0.0001) : null,
      reason: flagged ? 'deficit 0.60% at or above 0.40%' : 'deficit 0.03% below 2.00%',
      metrics: renewal ? {
        renewal_before_after_unrenewed_frac: flagged ? 0.006 : 0.0001,
        renewal_before_after_confidence: 0.9,
      } : {},
    },
    argon_snapshot: {
      channels: [
        { channel: 1, value: 7.45 - position * 0.0006, units: 'MPa', reading_status: 'ok', age_ms: 7000 },
        { channel: 2, value: position % 97 === 0 ? null : 0.05, units: 'MPa', reading_status: position % 97 === 0 ? 'unreadable' : 'ok', age_ms: 6700 },
      ],
      combined: { value: 7.5, state: 'ok', units: 'MPa' },
    },
    media: [],
    preview_url: null,
    run: { processor: 'layer.coverage', processor_version: '1.4.0', rules_version: '1', profile_name: 'dev' },
    monitor_software_version: 'test',
  };
});

function json(response, body) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

test('selected-layer stats are tiles and the build charts line up with labelled axes', { skip: !existsSync(browserPath) }, async () => {
  const rendered = spawnSync('php', [join(import.meta.dirname, 'chamber-panel.test.php'), '--render'], { encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(rendered.stdout);
      return;
    }
    if (url.pathname === '/api/v1/sessions') {
      json(response, { sessions: [{ monitor_instance_id: monitor, session_local_id: 4, session_name: 'Fixture build', session_state: 'active', layer_count: layers.length }] });
      return;
    }
    if (url.pathname === '/api/v1/layers/index') {
      json(response, { layers: layers.map(({ media, run, monitor_software_version, ...rest }) => ({ ...rest, analysis: { status: rest.analysis.status, severity: rest.analysis.severity, deficit_area_frac: rest.analysis.deficit_area_frac, renewal_unrenewed_frac: rest.analysis.renewal_unrenewed_frac } })), truncated: false, latest_id: layers.length, session: null, build: null });
      return;
    }
    if (url.pathname === '/api/v1/layers') {
      const ids = new Set((url.searchParams.get('ids') || '').split(',').filter(Boolean).map(Number));
      json(response, { layers: layers.filter(layer => ids.has(layer.id)), session: null });
      return;
    }
    if (url.pathname.startsWith('/assets/') && /^\/assets\/[a-z0-9.-]+$/.test(url.pathname)) {
      try {
        response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
        response.end(readFileSync(join(publicRoot, url.pathname)));
      } catch { response.writeHead(404).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    for (const width of [1600, 1200, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.route('https://live.example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.locator('#layer-title', { hasText: 'Layer 2354' }).waitFor();
      await page.locator('.layer-stat small').waitFor();

      const stats = page.locator('#layer-stats .layer-stat');
      assert.equal(await stats.count(), 4);
      assert.deepEqual(await stats.locator('span').allTextContents(), ['Deficit area', 'Unrenewed', 'Confidence', 'State']);
      assert.equal(await stats.nth(1).locator('b').textContent(), '0.01%');
      assert.equal(await stats.nth(1).locator('small').textContent(), 'conf 0.90');
      assert.deepEqual(await page.locator('#layer-summary dt').allTextContents(), ['Captured', 'Status']);
      const reasonBorders = await page.locator('#analysis-reason').evaluate(node => {
        const style = getComputedStyle(node);
        return [style.borderLeftWidth, style.borderTopWidth];
      });
      assert.deepEqual(reasonBorders, ['1px', '1px'], 'the reason box has an even border, no accent bar');

      assert.deepEqual(await page.locator('#defect-legend span').allTextContents(), ['Defect rate', 'Deficit area', 'Unrenewed']);
      const defect = await page.locator('#defect-chart').boundingBox();
      const argon = await page.locator('#argon-chart').boundingBox();
      if (width > 760) {
        assert.ok(Math.abs(defect.y - argon.y) < 1, `chart canvases start level: ${defect.y} vs ${argon.y}`);
        assert.ok(Math.abs(defect.height - argon.height) < 1, 'chart canvases are the same height');
      }
      // Something was drawn in the gutter (tick labels) and along the bottom (layer numbers).
      const inked = await page.evaluate(() => ['#defect-chart', '#argon-chart'].map(id => {
        const canvas = document.querySelector(id);
        const ratio = window.devicePixelRatio || 1;
        const context = canvas.getContext('2d');
        const gutter = context.getImageData(0, 0, Math.round(18 * ratio), canvas.height).data;
        const floor = context.getImageData(0, canvas.height - Math.round(12 * ratio), canvas.width, Math.round(12 * ratio)).data;
        const any = data => data.some((value, index) => index % 4 === 3 && value > 0);
        return [any(gutter), any(floor)];
      }));
      assert.deepEqual(inked, [[true, true], [true, true]], 'both charts carry axis labels');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll');
      if (process.env.REVIEW_SCREENSHOTS) {
        await page.screenshot({ path: join(process.env.REVIEW_SCREENSHOTS, `review-charts-${width}.png`), fullPage: true });
      }
      assert.deepEqual(pageErrors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
