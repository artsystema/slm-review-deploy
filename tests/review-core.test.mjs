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
  loadedColumns,
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
