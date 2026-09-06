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
  clampWindow,
  decimate,
  defectRateSeries,
  elapsedSeries,
  elapsedTicks,
  formatElapsed,
  isWholeBuild,
  loadedColumns,
  longPauses,
  nextFinding,
  scrollOffsetFor,
  scrubScale,
  severityColumns,
  timeBasis,
  visibleWindow,
  windowAround,
  zoomWindow,
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
  const whole = layers => ({ from: 0, count: layers.length });
  const ticksOf = (layers, window, width = 800, gap = 20) =>
    elapsedTicks(elapsedSeries(layers), window ?? whole(layers), width, gap);

  it('picks an interval a person can read for the span it has', () => {
    const short = ticksOf(build(240, 30));
    assert.ok(short[1].elapsedMs - short[0].elapsedMs <= 30 * 60e3, 'two hours wants minutes');
    const long = ticksOf(build(3617, 52 * 3600 / 3617));
    assert.ok(long[1].elapsedMs - long[0].elapsedMs >= 3600e3, 'two days wants hours');
  });

  it('keeps the tick count readable however long the build ran', () => {
    for (const [n, stepS] of [[120, 20], [1000, 30], [3617, 52], [8000, 120]]) {
      const layers = build(n, stepS);
      assert.ok(ticksOf(layers).length <= 14, `${n} layers`);
    }
  });

  it('measures from the build, not from the edge of the window', () => {
    const layers = build(2000, 36);            // 20 hours
    const elapsed = elapsedSeries(layers);
    // Any window must place a given mark on the same layer.
    const wide = elapsedTicks(elapsed, { from: 0, count: 2000 }, 800, 20);
    const narrow = elapsedTicks(elapsed, { from: 600, count: 500 }, 800, 20);
    for (const tick of narrow) {
      assert.equal(tick.elapsedMs % (narrow[0].elapsedMs - 0), tick.elapsedMs % (narrow[0].elapsedMs),
        'marks are multiples of one interval');
    }
    // A mark common to both windows sits on the same layer in each.
    const shared = wide.find(w => narrow.some(n => n.elapsedMs === w.elapsedMs));
    if (shared) {
      const same = narrow.find(n => n.elapsedMs === shared.elapsedMs);
      assert.ok(Math.abs(same.index - shared.index) <= 1,
        `the same time landed on layer ${shared.index} and ${same.index}`);
    }
  });

  it('does not move its marks when the window slides, as playback slides it', () => {
    const layers = build(3000, 32);
    const elapsed = elapsedSeries(layers);
    const before = elapsedTicks(elapsed, { from: 1000, count: 400 }, 800, 20);
    const after = elapsedTicks(elapsed, { from: 1010, count: 400 }, 800, 20);
    const commonTimes = before.map(t => t.elapsedMs).filter(t => after.some(a => a.elapsedMs === t));
    assert.ok(commonTimes.length > 0, 'a ten-layer nudge threw every mark away');
    for (const time of commonTimes) {
      assert.equal(before.find(t => t.elapsedMs === time).index,
        after.find(t => t.elapsedMs === time).index,
        `the mark for ${time}ms moved to a different layer`);
    }
  });

  it('gives finer marks as the window narrows', () => {
    const layers = build(3617, 52 * 3600 / 3617);
    const elapsed = elapsedSeries(layers);
    const wide = elapsedTicks(elapsed, { from: 0, count: 3617 }, 800, 20);
    const tight = elapsedTicks(elapsed, { from: 1000, count: 120 }, 800, 20);
    const step = list => list[1].elapsedMs - list[0].elapsedMs;
    assert.ok(step(tight) < step(wide), 'zooming in did not buy a finer clock');
  });

  it('does not smear a stoppage into a wall of ticks', () => {
    const layers = build(600, 32, { 300: 14 * 3600 });
    const ticks = ticksOf(layers);
    assert.ok(ticks.filter(t => t.index === 300).length <= 1, 'ticks stacked on one column');
    for (let i = 1; i < ticks.length; i += 1) {
      const gap = ((ticks[i].index - ticks[i - 1].index) / 599) * 800;
      assert.ok(gap >= 20 - 1e-9, `ticks ${gap.toFixed(1)}px apart`);
    }
  });

  it('runs forward along the strip and stays inside the window', () => {
    const layers = build(1000, 30);
    const ticks = elapsedTicks(elapsedSeries(layers), { from: 200, count: 400 }, 800, 20);
    for (let i = 1; i < ticks.length; i += 1) {
      assert.ok(ticks[i].index > ticks[i - 1].index);
      assert.ok(ticks[i].elapsedMs > ticks[i - 1].elapsedMs);
    }
    assert.ok(ticks.every(t => t.index >= 200 && t.index < 600));
  });

  it('has nothing to say about a build with no time in it', () => {
    assert.deepEqual(ticksOf(build(1, 30)), []);
    assert.deepEqual(ticksOf(build(50, 0)), []);
    assert.deepEqual(elapsedTicks([], { from: 0, count: 0 }, 800, 20), []);
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

describe('timeBasis', () => {
  const run = (mode, n = 3) => Array.from({ length: n }, () => ({ ...completed('none'), run_mode: mode }));

  it('calls a watched build a print', () => {
    assert.equal(timeBasis(run('watch')), 'print');
  });

  it('calls a replay a replay', () => {
    assert.equal(timeBasis(run('batch')), 'replay');
  });

  it('refuses to call a session of both either one', () => {
    assert.equal(timeBasis([...run('watch'), ...run('batch')]), 'mixed');
  });

  it('says unknown for a monitor that never sent it', () => {
    assert.equal(timeBasis([{ ...completed('none') }]), 'unknown');
    // One layer without it is enough: the rest cannot vouch for that one.
    assert.equal(timeBasis([...run('watch'), { ...completed('none') }]), 'unknown');
  });

  it('says unknown for an empty session rather than guessing', () => {
    assert.equal(timeBasis([]), 'unknown');
  });
});

describe('scrubScale', () => {
  // 3,617 layers across a 370px phone strip, as session 0109-shell is.
  const phone = 3617 / 370;

  it('tracks the finger one for one while it stays on the strip', () => {
    assert.equal(scrubScale(0, phone).scale, 1);
    assert.equal(scrubScale(29, phone).scale, 1);
    assert.equal(scrubScale(29, phone).rung, 0);
  });

  it('gears down the further the finger goes', () => {
    const rungs = [30, 68, 116].map(away => scrubScale(away, phone));
    for (let i = 1; i < rungs.length; i += 1) {
      assert.ok(rungs[i].scale < rungs[i - 1].scale, `rung ${i} was not finer`);
    }
    assert.ok(rungs[0].layersPerPx <= 2.01);
    assert.ok(rungs[2].layersPerPx <= 0.16, 'the finest rung must reach single layers');
  });

  it('makes the worst case usable', () => {
    // A five pixel wobble threw the selection 49 layers; on the finest rung it
    // must move less than one.
    assert.ok(scrubScale(140, phone).layersPerPx * 5 < 1);
  });

  it('never gears a short build down past what it needs', () => {
    // 300 layers on a wide strip is already under a layer a pixel.
    const already = 300 / 1030;
    assert.equal(scrubScale(40, already).scale, 1, 'geared down a build that was already fine');
    assert.equal(scrubScale(40, already).rung, 0, 'reported fine mode it did not enter');
  });

  it('is symmetric: it is distance from the strip that matters, not which way', () => {
    assert.deepEqual(scrubScale(-80, phone), scrubScale(80, phone));
  });

  it('says nothing useful about a strip with no width', () => {
    assert.equal(scrubScale(200, 0).scale, 1);
  });
});

describe('nextFinding', () => {
  const build = flaggedAt => {
    const layers = Array.from({ length: 200 }, () => completed('none'));
    for (const index of flaggedAt) layers[index] = completed('warning');
    return layers;
  };

  it('finds the next thing worth looking at', () => {
    const layers = build([10, 50, 51, 180]);
    assert.equal(nextFinding(layers, 0, 1), 10);
    assert.equal(nextFinding(layers, 10, 1), 50);
    assert.equal(nextFinding(layers, 50, 1), 51);
  });

  it('goes back as readily as forward', () => {
    const layers = build([10, 50, 180]);
    assert.equal(nextFinding(layers, 180, -1), 50);
    assert.equal(nextFinding(layers, 51, -1), 50);
  });

  it('ends rather than wrapping', () => {
    const layers = build([10, 180]);
    assert.equal(nextFinding(layers, 180, 1), null);
    assert.equal(nextFinding(layers, 10, -1), null);
  });

  it('does not count a layer that was never analysed as a finding', () => {
    const layers = Array.from({ length: 50 }, () => pending());
    layers[20] = completed('critical');
    assert.equal(nextFinding(layers, 0, 1), 20);
    assert.equal(nextFinding(layers, 20, 1), null);
  });

  it('says nothing to find in a clean build', () => {
    assert.equal(nextFinding(build([]), 0, 1), null);
    assert.equal(nextFinding([], 0, 1), null);
  });
});

describe('the timeline window', () => {
  const total = 3617;

  it('slides back inside the build rather than shrinking', () => {
    const pushedPastTheEnd = clampWindow(total - 50, 400, total);
    assert.equal(pushedPastTheEnd.count, 400, 'the span the operator chose was taken from them');
    assert.equal(pushedPastTheEnd.from + pushedPastTheEnd.count, total);

    const pushedPastTheStart = clampWindow(-200, 400, total);
    assert.deepEqual(pushedPastTheStart, { from: 0, count: 400 });
  });

  it('will not zoom past the point of it', () => {
    let window = { from: 0, count: total };
    for (let i = 0; i < 40; i += 1) window = zoomWindow(window, 2, 0.5, total);
    assert.ok(window.count >= 24, `collapsed to ${window.count} layers`);
    assert.ok(window.from >= 0 && window.from + window.count <= total);
  });

  it('never shows more than there is', () => {
    const window = zoomWindow({ from: 100, count: 400 }, 0.001, 0.5, total);
    assert.deepEqual(window, { from: 0, count: total });
  });

  it('keeps the layer under the fingers where it is', () => {
    const before = { from: 1000, count: 800 };
    for (const at of [0, 0.25, 0.5, 1]) {
      const layerUnder = before.from + before.count * at;
      const after = zoomWindow(before, 3, at, total);
      const stillUnder = after.from + after.count * at;
      assert.ok(Math.abs(stillUnder - layerUnder) <= 1,
        `the layer under ${at} moved from ${layerUnder} to ${stillUnder}`);
    }
  });

  it('says when it is showing the whole build', () => {
    assert.equal(isWholeBuild({ from: 0, count: total }, total), true);
    assert.equal(isWholeBuild({ from: 0, count: 400 }, total), false);
  });

  it('nudges to follow a selection off its edge, rather than recentring', () => {
    const window = { from: 1000, count: 400 };
    // Well inside: left alone, so the strip does not crawl under the playhead.
    assert.deepEqual(windowAround(window, 1200, total), window);
    // Off the right edge: moved just far enough.
    const after = windowAround(window, 1420, total);
    assert.ok(after.from > window.from && after.from < 1200,
      `jumped to ${after.from} instead of nudging`);
    assert.ok(1420 >= after.from && 1420 < after.from + after.count);
    // Off the left edge.
    const back = windowAround(window, 980, total);
    assert.ok(980 >= back.from && back.from < window.from);
  });

  it('copes with a session that has nothing in it', () => {
    assert.deepEqual(clampWindow(0, 100, 0), { from: 0, count: 0 });
    assert.equal(isWholeBuild({ from: 0, count: 0 }, 0), true);
  });
});
