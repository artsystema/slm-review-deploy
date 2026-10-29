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
      dark_curve: {
        skeleton_pixels: flagged ? 180 + (position % 20) : 0,
        span_px: flagged ? 150 + (position % 12) : 0,
        severity: flagged ? 2 : 0,
      },
      reason: flagged ? 'deficit 0.60% at or above 0.40%' : 'deficit 0.03% below 2.00%',
      metrics: renewal ? {
        threshold_warn_area_frac: 0.004,
        threshold_critical_area_frac: 0.007,
        renewal_threshold_warn_area_frac: 0.004,
        renewal_threshold_critical_area_frac: 0.005,
        renewal_before_after_unrenewed_frac: flagged ? 0.006 : 0.0001,
        renewal_before_after_confidence: 0.9,
        dark_curve_skeleton_pixels: flagged ? 180 + (position % 20) : 0,
        dark_curve_span_px: flagged ? 150 + (position % 12) : 0,
        dark_curve_severity_reported: flagged ? 2 : 0,
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
  let suppliedLayers = layers;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(rendered.stdout);
      return;
    }
    if (url.pathname === '/api/v1/sessions') {
      json(response, { sessions: [{ monitor_instance_id: monitor, session_local_id: 4, session_name: 'Fixture build', session_state: 'ended', layer_count: layers.length }] });
      return;
    }
    if (url.pathname === '/api/v1/layers/index') {
      json(response, { layers: suppliedLayers.map(({ media, run, monitor_software_version, ...rest }) => ({ ...rest, analysis: { status: rest.analysis.status, severity: rest.analysis.severity, deficit_area_frac: rest.analysis.deficit_area_frac, renewal_unrenewed_frac: rest.analysis.renewal_unrenewed_frac, dark_curve: rest.analysis.dark_curve } })), truncated: false, latest_id: suppliedLayers.length, session: null, build: null });
      return;
    }
    if (url.pathname === '/api/v1/layers') {
      const ids = new Set((url.searchParams.get('ids') || '').split(',').filter(Boolean).map(Number));
      json(response, { layers: suppliedLayers.filter(layer => ids.has(layer.id)), session: null });
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
      await page.locator('#layer-stats .layer-stat').nth(4).waitFor();

      const stats = page.locator('#layer-stats .layer-stat');
      assert.equal(await stats.count(), 5);
      assert.deepEqual(await stats.locator('span').allTextContents(), ['Deficit area', 'Unrenewed', 'Confidence', 'State', 'Dark curve']);
      const statBoxes = await stats.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()));
      assert.ok(statBoxes.every(box => Math.abs(box.y - statBoxes[0].y) < 1), 'layer stats stay on one row');
      assert.equal(await page.locator('#layer-stats').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'the stats row fits its panel');
      assert.equal(await stats.nth(1).locator('b').textContent(), '0.01%');
      assert.equal(await stats.nth(1).locator('small').textContent(), 'conf 0.90');
      await page.locator('#delete-session-open').click();
      assert.match(await page.locator('#delete-session-description').textContent(), /Fixture build/);
      await page.locator('#delete-session-cancel').click();
      assert.deepEqual(await page.locator('#layer-summary dt').allTextContents(), ['Captured', 'Status']);
      const reasonBorders = await page.locator('#analysis-reason').evaluate(node => {
        const style = getComputedStyle(node);
        return [style.borderLeftWidth, style.borderTopWidth];
      });
      assert.deepEqual(reasonBorders, ['1px', '1px'], 'the reason box has an even border, no accent bar');

      assert.deepEqual(await page.locator('#defect-legend span').allTextContents(), ['Defect rate', 'Deficit area', 'Unrenewed']);
      assert.deepEqual(await page.locator('#curve-legend span').allTextContents(), ['Observed length', 'Span', 'Rule severity']);
      assert.equal(await page.locator('.quality-chart-card #curve-chart').count(), 0, 'curve chart is not nested in rolling quality');
      assert.equal(await page.locator('.metrics-grid > .curve-chart-card').count(), 1, 'curve chart has its own card');
      assert.equal(await page.locator('#curve-chart-card').isVisible(), true);
      assert.equal(await page.locator('#argon-chart-card').isVisible(), true);
      const defect = await page.locator('#defect-chart').boundingBox();
      const argon = await page.locator('#argon-chart').boundingBox();
      const curve = await page.locator('#curve-chart').boundingBox();
      if (width > 760) {
        assert.ok(Math.abs(defect.y - argon.y) < 1, `chart canvases start level: ${defect.y} vs ${argon.y}`);
        assert.ok(Math.abs(defect.height - argon.height) < 1, 'chart canvases are the same height');
        assert.ok(Math.abs(defect.x - curve.x) < 1, 'rolling and curve cards form the first desktop column');
        assert.ok(curve.y > defect.y + defect.height, 'curve card sits below rolling quality');
        assert.ok(argon.x > defect.x + defect.width, 'argon occupies the second desktop column');
      }
      // Something was drawn in the gutter (tick labels) and along the bottom (layer numbers).
      const inked = await page.evaluate(() => ['#defect-chart', '#argon-chart', '#curve-chart'].map(id => {
        const canvas = document.querySelector(id);
        const ratio = window.devicePixelRatio || 1;
        const context = canvas.getContext('2d');
        const gutter = context.getImageData(0, 0, Math.round(18 * ratio), canvas.height).data;
        const floor = context.getImageData(0, canvas.height - Math.round(12 * ratio), canvas.width, Math.round(12 * ratio)).data;
        const any = data => data.some((value, index) => index % 4 === 3 && value > 0);
        return [any(gutter), any(floor)];
      }));
      assert.deepEqual(inked, [[true, true], [true, true], [true, true]], 'all charts carry axis labels');
      await page.mouse.move(defect.x + defect.width * 0.55, defect.y + defect.height * 0.45);
      await page.locator('#defect-chart-tooltip:not([hidden])').waitFor();
      assert.match(await page.locator('#defect-chart-tooltip').textContent(), /Layer \d+.*Defect rate.*Deficit area.*Unrenewed/s);
      await page.mouse.move(argon.x + argon.width * 0.55, argon.y + argon.height * 0.45);
      await page.locator('#argon-chart-tooltip:not([hidden])').waitFor();
      assert.match(await page.locator('#argon-chart-tooltip').textContent(), /Layer \d+.*CH 1.*CH 2/s);
      await page.mouse.move(curve.x + curve.width * 0.55, curve.y + curve.height * 0.45);
      await page.locator('#curve-chart-tooltip:not([hidden])').waitFor();
      assert.match(await page.locator('#curve-chart-tooltip').textContent(), /Layer \d+.*Observed length.*Span.*Rule severity/s);
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.locator('#curve-chart-tooltip:not([hidden])').waitFor();
      assert.match(await page.locator('#curve-chart-tooltip').textContent(), /Observed length.*Rule severity/s, 'tooltip survives a live redraw');
      if (width === 390) {
        await page.mouse.move(1, 1);
        await page.locator('#curve-chart').dispatchEvent('pointerdown', {
          pointerId: 17, pointerType: 'touch', clientX: curve.x + curve.width * 0.6, clientY: curve.y + curve.height * 0.5,
        });
        await page.locator('#curve-chart').dispatchEvent('pointerup', {
          pointerId: 17, pointerType: 'touch', clientX: curve.x + curve.width * 0.6, clientY: curve.y + curve.height * 0.5,
        });
        await page.locator('#curve-chart-tooltip:not([hidden])').waitFor();
        assert.match(await page.locator('#curve-chart-tooltip').textContent(), /Observed length.*Rule severity/s);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll');
      if (process.env.REVIEW_SCREENSHOTS) {
        await page.screenshot({ path: join(process.env.REVIEW_SCREENSHOTS, `review-charts-${width}.png`), fullPage: true });
      }
      assert.deepEqual(pageErrors, []);
      await page.close();
    }
    const flaggedPage = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await flaggedPage.goto(`http://127.0.0.1:${server.address().port}/#m=${monitor}&s=4&r=4&l=2065`);
    await flaggedPage.locator('#layer-title', { hasText: 'Layer 2065' }).waitFor();
    await flaggedPage.locator('#layer-stats .layer-stat.is-critical').waitFor();
    assert.equal(await flaggedPage.locator('#layer-stats .layer-stat').nth(0).getAttribute('class'), 'layer-stat is-warning');
    assert.equal(await flaggedPage.locator('#layer-stats .layer-stat').nth(1).getAttribute('class'), 'layer-stat is-critical');
    assert.equal(await flaggedPage.locator('#layer-stats .layer-stat').nth(4).getAttribute('class'), 'layer-stat is-warning');
    await flaggedPage.close();

    suppliedLayers = layers.map(layer => ({
      ...layer,
      analysis: { ...layer.analysis, dark_curve: null },
      argon_snapshot: { channels: [], combined: {} },
    }));
    const oldPage = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
    await oldPage.goto(`http://127.0.0.1:${server.address().port}/`);
    await oldPage.locator('#layer-title', { hasText: 'Layer 2354' }).waitFor();
    assert.equal(await oldPage.locator('#argon-chart-card').isVisible(), false);
    assert.equal(await oldPage.locator('#curve-chart-card').isVisible(), false);
    assert.equal(await oldPage.locator('.argon-panel').isVisible(), false);
    assert.equal(await oldPage.locator('#metrics-grid').getAttribute('data-layout'), 'quality-only');
    assert.equal(await oldPage.locator('#layer-stats .layer-stat').count(), 4);
    await oldPage.close();
  } finally {
    await browser?.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
