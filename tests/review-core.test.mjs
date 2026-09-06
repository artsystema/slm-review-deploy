/**
 * Run with:  node --test remote-review/tests/
 *
 * These cover the arithmetic the viewer uses to survive a build with thousands
 * of layers. The reductions are the risky part: each one throws information
 * away to fit the pixels available, and the tests pin down what is not allowed
 * to be thrown away -- a flagged layer, a spike, a gap.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  argonSeries,
  decimate,
  defectRateSeries,
  elapsedTicks,
  formatElapsed,
  loadedColumns,
  longPauses,
  scrollOffsetFor,
  severityColumns,
  visibleWindow,
} from '../public/assets/review-core.js';

const layer = (overrides = {}) => ({
  analysis: { status: 'completed', severity: 'none', ...(overrides.analysis || {}) },
  argon_snapshot: overrides.argon_snapshot ?? { channels: [] },
});

const completed = severity => layer({ analysis: { status: 'completed', severity } });
const pending = () => layer({ analysis: { status: 'pending', severity: 'none' } });

/** The shipped implementation, kept as the oracle the fast one must match. */
function naiveDefectRates(layers, windowSize) {
  const isEligible = l => l.analysis.status === 'completed';
  const flagged = l => l.analysis.status === 'completed' && l.analysis.severity !== 'none';
  return layers.map((_, index) => {
    const window = layers.slice(Math.max(0, index - windowSize + 1), index + 1).filter(isEligible);
    return window.length ? window.filter(flagged).length / window.length : null;
  });
}

describe('defectRateSeries', () => {
  it('matches the windowed definition it replaces', () => {
    const severities = ['none', 'warning', 'none', 'critical', 'none', 'none', 'info'];
    const layers = [];
    for (let index = 0; index < 200; index += 1) {
      layers.push(index % 11 === 0 ? pending() : completed(severities[index % severities.length]));
    }
    for (const windowSize of [1, 2, 5, 40, 250]) {
      assert.deepEqual(
        defectRateSeries(layers, windowSize),
        naiveDefectRates(layers, windowSize),
        `window ${windowSize}`,
      );
    }
  });

  it('reports no rate at all where the window holds nothing eligible', () => {
    const series = defectRateSeries([pending(), pending(), completed('none')], 2);
    assert.equal(series[0], null);
    assert.equal(series[1], null);
    assert.equal(series[2], 0);
  });

  it('stays linear on a build of thousands', () => {
    const layers = Array.from({ length: 20000 }, (_, index) => completed(index % 97 === 0 ? 'warning' : 'none'));
    const series = defectRateSeries(layers, 40);
    assert.equal(series.length, 20000);
    assert.deepEqual(series.slice(-3), naiveDefectRates(layers, 40).slice(-3));
  });
});

describe('argonSeries', () => {
  const reading = (channel, value, status = 'ok') => ({ channel, value, reading_status: status });
  const withChannels = (...channels) => layer({ argon_snapshot: { channels } });

  it('aligns every channel to the layer positions', () => {
    const series = argonSeries([
      withChannels(reading(1, 180)),
      withChannels(reading(1, 179), reading(2, 90)),
      withChannels(reading(1, 178), reading(2, 89)),
    ]);
    assert.deepEqual(series.get(1), [180, 179, 178]);
    assert.deepEqual(series.get(2), [null, 90, 89]);
  });

  it('never turns an unreliable reading into a value', () => {
    const series = argonSeries([
      withChannels(reading(1, 180)),
      withChannels(reading(1, null, 'unreadable')),
      withChannels(reading(1, 0, 'stale')),
      withChannels(reading(1, 177)),
    ]);
    assert.deepEqual(series.get(1), [180, null, null, 177]);
  });

  it('leaves layers with no snapshot as gaps', () => {
    const series = argonSeries([withChannels(reading(1, 180)), layer({ argon_snapshot: null })]);
    assert.deepEqual(series.get(1), [180, null]);
  });
});

describe('decimate', () => {
  it('passes short series through untouched', () => {
    const points = [1, 2, null, 4];
    assert.deepEqual(decimate(points, 100), [
      { index: 0, value: 1 },
      { index: 1, value: 2 },
      { index: 2, value: null },
      { index: 3, value: 4 },
    ]);
  });

  it('keeps a one-layer spike that subsampling would drop', () => {
    const points = new Array(4000).fill(0.1);
    points[2537] = 0.97;
    const samples = decimate(points, 400);
    assert.ok(
      samples.some(sample => sample.index === 2537 && sample.value === 0.97),
      'the spike must survive the reduction',
    );
  });

  it('keeps the trough as well as the peak', () => {
    const points = new Array(2000).fill(5);
    points[100] = 9;
    points[130] = 1;
    const values = decimate(points, 50).map(sample => sample.value);
    assert.ok(values.includes(9), 'peak kept');
    assert.ok(values.includes(1), 'trough kept');
  });

  it('emits samples in ascending layer order', () => {
    const points = Array.from({ length: 5000 }, (_, index) => Math.sin(index / 7));
    const samples = decimate(points, 300);
    for (let index = 1; index < samples.length; index += 1) {
      assert.ok(samples[index].index >= samples[index - 1].index, 'never runs backwards');
    }
  });

  it('bounds the drawn path by the pixels, not the build', () => {
    for (const length of [1000, 4000, 20000]) {
      const samples = decimate(new Array(length).fill(1), 400);
      assert.ok(samples.length <= 800, `${length} layers reduced to ${samples.length}`);
    }
  });

  it('breaks the line across a stretch with no readings', () => {
    const points = new Array(4000).fill(1);
    for (let index = 1000; index < 3000; index += 1) points[index] = null;
    const samples = decimate(points, 200);
    const gaps = samples.filter(sample => sample.value === null);
    assert.ok(gaps.length > 0, 'the gap is marked rather than bridged');
    assert.ok(gaps.every(sample => sample.index >= 1000 && sample.index < 3000));
  });
});

describe('severityColumns', () => {
  it('gives the column to the worst layer in it', () => {
    const layers = [completed('none'), completed('warning'), completed('critical'), completed('none')];
    const [column] = severityColumns(layers, 1);
    assert.equal(column.token, 'critical');
    assert.equal(column.quiet, false);
  });

  it('shows one flagged layer among thousands', () => {
    const layers = Array.from({ length: 4000 }, () => completed('none'));
    layers[3111] = completed('emergency');
    const strip = severityColumns(layers, 800);
    const loud = strip.filter(column => !column.quiet);
    assert.equal(loud.length, 1);
    assert.equal(loud[0].token, 'emergency');
  });

  it('marks a column of uncompleted layers as ineligible rather than clear', () => {
    const [column] = severityColumns([pending(), pending()], 1);
    assert.equal(column.eligible, false);
    assert.equal(column.token, 'unknown');
  });

  it('never returns more columns than layers', () => {
    assert.equal(severityColumns([completed('none'), completed('none')], 900).length, 2);
  });
});

describe('loadedColumns', () => {
  const build = n => Array.from({ length: n }, () => completed('none'));

  it('lights a column only when every layer under it is held', () => {
    const layers = build(10);
    const held = new Set([layers[0], layers[1], layers[2], layers[3], layers[4]]);
    // Five columns over ten layers: two layers each.
    const strip = loadedColumns(layers, 5, layer => held.has(layer));
    assert.deepEqual(strip, [true, true, false, false, false]);
  });

  it('does not promise a stretch is ready because one layer of it is', () => {
    const layers = build(100);
    const held = new Set([layers[42]]);
    const strip = loadedColumns(layers, 10, layer => held.has(layer));
    assert.deepEqual(strip.filter(Boolean), [], 'one layer in ten does not light the column');
  });

  it('lines up with the severity strip for the same arguments', () => {
    const layers = build(3631);
    for (const columns of [1, 7, 400, 660, 5000]) {
      assert.equal(
        loadedColumns(layers, columns, () => true).length,
        severityColumns(layers, columns).length,
        `columns ${columns}`,
      );
    }
  });

  it('holds nothing when nothing is loaded', () => {
    assert.deepEqual(loadedColumns(build(4), 4, () => false), [false, false, false, false]);
  });
});

describe('visibleWindow', () => {
  it('renders a screenful and its overscan, not the build', () => {
    const { first, count } = visibleWindow(0, 1200, 121, 4000, 4);
    assert.equal(first, 0);
    assert.ok(count < 25, `rendered ${count} chips for a 1200px strip`);
  });

  it('follows the scroll position', () => {
    const { first, count } = visibleWindow(121 * 500, 1200, 121, 4000, 4);
    assert.equal(first, 496);
    assert.ok(first + count <= 4000);
  });

  it('clamps at both ends of the build', () => {
    assert.equal(visibleWindow(-50, 1200, 121, 4000, 4).first, 0);
    const end = visibleWindow(121 * 3999, 1200, 121, 4000, 4);
    assert.equal(end.first + end.count, 4000);
  });

  it('renders nothing when there is nothing to render', () => {
    assert.deepEqual(visibleWindow(0, 1200, 121, 0, 4), { first: 0, count: 0 });
    assert.deepEqual(visibleWindow(0, 0, 121, 4000, 4), { first: 0, count: 0 });
  });
});

describe('scrollOffsetFor', () => {
  it('centres a chip in the window', () => {
    assert.equal(scrollOffsetFor(500, 121, 116, 1200, 4000), 500 * 121 - (1200 - 116) / 2);
  });

  it('does not scroll past either end', () => {
    assert.equal(scrollOffsetFor(0, 121, 116, 1200, 4000), 0);
    assert.equal(scrollOffsetFor(3999, 121, 116, 1200, 4000), 4000 * 121 - 5 - 1200);
  });
});

describe('elapsedTicks', () => {
  // A layer every `stepS` seconds, with optional stalls injected at an index.
  const build = (n, stepS, stalls = {}) => {
    let at = Date.UTC(2026, 8, 1);
    return Array.from({ length: n }, (_, index) => {
      if (index) at += (stalls[index] ?? stepS) * 1000;
      return { ...completed('none'), captured_at: new Date(at).toISOString() };
    });
  };

  it('picks an interval a person can read for the span it has', () => {
    // Two hours of layers: quarter hours, not seconds and not days.
    const short = elapsedTicks(build(240, 30), 800, 20);
    const shortStep = short[1].elapsedMs - short[0].elapsedMs;
    assert.ok(shortStep <= 30 * 60e3, `two-hour print ticked every ${shortStep / 60e3} min`);

    // Two days of layers: hours, not quarter hours.
    const long = elapsedTicks(build(3617, 52 * 3600 / 3617), 800, 20);
    const longStep = long[1].elapsedMs - long[0].elapsedMs;
    assert.ok(longStep >= 3600e3, `two-day print ticked every ${longStep / 60e3} min`);
  });

  it('keeps the tick count readable however long the build ran', () => {
    for (const [n, stepS] of [[120, 20], [1000, 30], [3617, 52], [8000, 120]]) {
      const ticks = elapsedTicks(build(n, stepS), 800, 20);
      assert.ok(ticks.length <= 14, `${n} layers gave ${ticks.length} ticks`);
    }
  });

  it('does not smear a stoppage into a wall of ticks', () => {
    // Fourteen hours between two adjacent layers, as session 0109-shell had.
    const layers = build(600, 32, { 300: 14 * 3600 });
    const ticks = elapsedTicks(layers, 800, 20);
    const atStall = ticks.filter(tick => tick.index === 300);
    assert.ok(atStall.length <= 1, `${atStall.length} ticks stacked on one column`);
    const span = Math.max(1, layers.length - 1);
    for (let i = 1; i < ticks.length; i += 1) {
      const gap = ((ticks[i].index - ticks[i - 1].index) / span) * 800;
      assert.ok(gap >= 20 - 1e-9, `ticks ${gap.toFixed(1)}px apart`);
    }
  });

  it('runs forward along the strip and stays inside it', () => {
    const layers = build(1000, 30);
    const ticks = elapsedTicks(layers, 800, 20);
    for (let i = 1; i < ticks.length; i += 1) {
      assert.ok(ticks[i].index > ticks[i - 1].index);
      assert.ok(ticks[i].elapsedMs > ticks[i - 1].elapsedMs);
    }
    assert.ok(ticks.at(-1).index < layers.length);
  });

  it('has nothing to say about a build with no time in it', () => {
    assert.deepEqual(elapsedTicks(build(1, 30), 800, 20), []);
    assert.deepEqual(elapsedTicks(build(50, 0), 800, 20), []);
    assert.deepEqual(elapsedTicks([], 800, 20), []);
  });
});

describe('longPauses', () => {
  const build = (n, stepS, stalls = {}) => {
    let at = Date.UTC(2026, 8, 1);
    return Array.from({ length: n }, (_, index) => {
      if (index) at += (stalls[index] ?? stepS) * 1000;
      return { ...completed('none'), captured_at: new Date(at).toISOString() };
    });
  };

  it('finds the stop and not the ordinary layer time', () => {
    const pauses = longPauses(build(600, 32, { 300: 14 * 3600, 450: 2.4 * 3600 }));
    assert.deepEqual(pauses.map(pause => pause.index), [300, 450]);
    assert.equal(Math.round(pauses[0].ms / 3600e3), 14);
  });

  it('measures against the build’s own rate, not the clock', () => {
    // Ninety seconds is a stop for a machine laying a layer a second, and
    // nothing at all for one taking two minutes a layer.
    const fast = longPauses(build(400, 1, { 200: 90 }), { floorMs: 0 });
    const slow = longPauses(build(400, 120, { 200: 90 }), { floorMs: 0 });
    assert.deepEqual(fast.map(p => p.index), [200]);
    assert.deepEqual(slow.map(p => p.index), []);
  });

  it('does not mark every gap in a replay that runs flat out', () => {
    // A batch replay: half a second a layer, with breaks between its runs.
    const pauses = longPauses(build(2000, 0.5, { 700: 400, 1400: 600 }));
    assert.ok(pauses.length <= 2, `${pauses.length} pauses marked in a replay`);
  });

  it('reports the worst stops in build order, bounded', () => {
    const stalls = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [10 + i * 20, 600 + i * 60]),
    );
    const pauses = longPauses(build(1000, 5, stalls), { limit: 5 });
    assert.equal(pauses.length, 5);
    for (let i = 1; i < pauses.length; i += 1) {
      assert.ok(pauses[i].index > pauses[i - 1].index, 'in build order');
    }
  });
});

describe('formatElapsed', () => {
  it('reads as a duration at every scale', () => {
    assert.equal(formatElapsed(0), '+0m');
    assert.equal(formatElapsed(45 * 60e3), '+45m');
    assert.equal(formatElapsed(6 * 3600e3), '+6h');
    assert.equal(formatElapsed((18 * 60 + 12) * 60e3), '+18h 12m');
    assert.equal(formatElapsed(52 * 3600e3), '+2d 4h');
    assert.equal(formatElapsed(48 * 3600e3), '+2d');
  });

  it('says nothing rather than something wrong', () => {
    assert.equal(formatElapsed(null), '');
    assert.equal(formatElapsed(NaN), '');
    assert.equal(formatElapsed(-1), '');
  });
});

describe('longPauses in a pixel budget', () => {
  const build = (n, stepS, stalls = {}) => {
    let at = Date.UTC(2026, 8, 1);
    return Array.from({ length: n }, (_, index) => {
      if (index) at += (stalls[index] ?? stepS) * 1000;
      return { ...completed('none'), captured_at: new Date(at).toISOString() };
    });
  };

  it('draws one mark where two stops share a column', () => {
    // As session 0109-shell has: a 20 minute stop and a 14 hour one, one layer apart.
    const layers = build(3617, 32, { 1885: 20 * 60, 1886: 13.9 * 3600 });
    const marks = longPauses(layers, { width: 370, minGapPx: 14 });
    const near = marks.filter(mark => Math.abs(mark.index - 1886) <= 2);
    assert.equal(near.length, 1, 'two stops on one column drew two marks');
    assert.equal(Math.round(near[0].ms / 3600e3), 14, 'the longer stop is the one kept');
  });

  it('keeps stops that are genuinely far apart', () => {
    const layers = build(3617, 32, { 500: 3600, 3000: 2.4 * 3600 });
    const marks = longPauses(layers, { width: 370, minGapPx: 14 });
    assert.deepEqual(marks.map(m => m.index), [500, 3000]);
  });
});
