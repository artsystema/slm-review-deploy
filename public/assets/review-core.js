/**
 * Pure timeline arithmetic for the review viewer.
 *
 * Everything here is a function of the loaded layers and the pixel budget it
 * has to draw into. None of it touches the DOM, so it can be tested with
 * `node --test` without a browser or a build step, and so the viewer can call
 * it from a render path that must stay inside a frame.
 *
 * The theme throughout is that a build has far more layers than the screen has
 * columns: a session runs to thousands of layers and the chart it is drawn in
 * is a few hundred pixels wide. Work is therefore bounded by the pixels, not
 * by the layers, and every reduction keeps the extremes rather than a sample,
 * because a single flagged layer is exactly what the operator is looking for.
 */

const SEVERITY_RANK = {
  none: 0,
  clear: 0,
  unknown: 1,
  info: 2,
  warning: 3,
  critical: 4,
  emergency: 5,
};

/** Severities that describe a layer with nothing wrong with it. */
const QUIET_SEVERITIES = new Set(['none', 'clear']);

export function severityToken(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function severityRank(token) {
  return SEVERITY_RANK[token] ?? 1;
}

export function eligible(layer) {
  return layer.analysis.status === 'completed';
}

export function isFlagged(layer) {
  return layer.analysis.status === 'completed' && layer.analysis.severity !== 'none';
}

/**
 * Rolling defect rate, one point per layer, in a single pass.
 *
 * flagged eligible layers / completed eligible layers over the trailing
 * window. `null` where the window holds nothing eligible: an unmeasured
 * stretch is not a rate of zero, and the line is broken there rather than
 * drawn along the floor.
 */
export function defectRateSeries(layers, windowSize) {
  const width = Math.max(1, windowSize);
  const series = [];
  let eligibleCount = 0;
  let flaggedCount = 0;
  for (let index = 0; index < layers.length; index += 1) {
    if (eligible(layers[index])) {
      eligibleCount += 1;
      if (isFlagged(layers[index])) flaggedCount += 1;
    }
    const leaving = index - width;
    if (leaving >= 0 && eligible(layers[leaving])) {
      eligibleCount -= 1;
      if (isFlagged(layers[leaving])) flaggedCount -= 1;
    }
    series.push(eligibleCount ? flaggedCount / eligibleCount : null);
  }
  return series;
}

/**
 * One array of readings per argon channel, aligned to the layer list.
 *
 * A channel that first appears part way through a build is back-filled with
 * nulls to the start, so every series indexes by layer position. Only readings
 * the monitor marked `ok` become values; anything else is a gap, never a zero.
 *
 * @returns {Map<number, Array<number|null>>} channel number to readings
 */
export function argonSeries(layers) {
  const byChannel = new Map();
  for (let index = 0; index < layers.length; index += 1) {
    const channels = layers[index].argon_snapshot?.channels || [];
    for (const reading of channels) {
      let points = byChannel.get(reading.channel);
      if (points === undefined) {
        points = Array.from({ length: layers.length }, () => null);
        byChannel.set(reading.channel, points);
      }
      if (reading.reading_status === 'ok' && typeof reading.value === 'number') {
        points[index] = reading.value;
      }
    }
  }
  return byChannel;
}

/**
 * Reduce a per-layer series to at most `columns` pixel columns.
 *
 * Each column keeps both the minimum and the maximum reading that falls in it,
 * emitted in the order they occur, so a one-layer spike survives a build that
 * is five times longer than the chart is wide. Plain subsampling would drop
 * exactly the layer worth looking at.
 *
 * Columns holding no reliable reading emit a single null, which breaks the
 * line there instead of bridging the gap.
 *
 * @returns {Array<{index: number, value: number|null}>} ascending by index
 */
export function decimate(points, columns) {
  const budget = Math.max(1, Math.floor(columns));
  if (points.length <= budget * 2) {
    return points.map((value, index) => ({ index, value }));
  }
  const samples = [];
  const perColumn = points.length / budget;
  for (let column = 0; column < budget; column += 1) {
    const start = Math.floor(column * perColumn);
    const end = column === budget - 1 ? points.length : Math.floor((column + 1) * perColumn);
    let lowIndex = -1;
    let highIndex = -1;
    for (let index = start; index < end; index += 1) {
      const value = points[index];
      if (value == null) continue;
      if (lowIndex < 0 || value < points[lowIndex]) lowIndex = index;
      if (highIndex < 0 || value > points[highIndex]) highIndex = index;
    }
    if (lowIndex < 0) {
      samples.push({ index: start, value: null });
      continue;
    }
    const first = Math.min(lowIndex, highIndex);
    const second = Math.max(lowIndex, highIndex);
    samples.push({ index: first, value: points[first] });
    if (second !== first) samples.push({ index: second, value: points[second] });
  }
  return samples;
}

/**
 * Bucket a layer list into pixel columns and reduce each one.
 *
 * Everything drawn on the severity strip goes through here, so the tracks drawn
 * on top of each other cannot drift apart: a column means the same run of
 * layers whichever of them is asking.
 *
 * @param {(start: number, end: number) => unknown} reduce over `[start, end)`
 */
function byColumn(layers, columns, reduce) {
  const budget = Math.max(1, Math.min(Math.floor(columns), layers.length));
  const perColumn = layers.length / budget;
  const strip = [];
  for (let column = 0; column < budget; column += 1) {
    const start = Math.floor(column * perColumn);
    const end = column === budget - 1 ? layers.length : Math.floor((column + 1) * perColumn);
    strip.push(reduce(start, end));
  }
  return strip;
}

/**
 * Reduce the severity strip to one entry per pixel column.
 *
 * The worst layer in a column wins it. A flagged layer therefore always paints
 * its column however long the build gets, which is the property the strip is
 * read for; averaging or sampling would let a single bad layer disappear among
 * its neighbours.
 *
 * @returns {Array<{token: string, eligible: boolean, quiet: boolean}>}
 */
export function severityColumns(layers, columns) {
  return byColumn(layers, columns, (start, end) => {
    let token = 'unknown';
    let rank = -1;
    let anyEligible = false;
    for (let index = start; index < end; index += 1) {
      const layer = layers[index];
      if (!eligible(layer)) continue;
      anyEligible = true;
      const layerToken = severityToken(layer.analysis.severity);
      const layerRank = severityRank(layerToken);
      if (layerRank > rank) {
        rank = layerRank;
        token = layerToken;
      }
    }
    return {
      token: anyEligible ? token : 'unknown',
      eligible: anyEligible,
      quiet: !anyEligible || QUIET_SEVERITIES.has(token),
    };
  });
}

/**
 * Which columns of the strip are wholly held locally.
 *
 * A column counts only when *every* layer under it is loaded. The opposite
 * choice -- lighting the column when any one of them is -- would promise the
 * operator a stretch is ready to look at when most of it is not, and this mark
 * is only worth drawing if it can be believed. Understating readiness costs
 * nothing; overstating it wastes somebody's time on a slow link.
 *
 * @param {(layer: object) => boolean} isLoaded
 * @returns {boolean[]} aligned with severityColumns for the same arguments
 */
export function loadedColumns(layers, columns, isLoaded) {
  return byColumn(layers, columns, (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (!isLoaded(layers[index])) return false;
    }
    return end > start;
  });
}

/**
 * Which filmstrip chips are worth having in the document.
 *
 * The strip is a fixed-pitch row, so the window is arithmetic rather than
 * measurement: a build of four thousand layers is a 480,000 pixel scroller of
 * which about a screenful is ever visible. `overscan` chips either side keep a
 * flick scroll from showing holes.
 */
export function visibleWindow(scrollLeft, viewportWidth, pitch, total, overscan) {
  if (total <= 0 || pitch <= 0 || viewportWidth <= 0) return { first: 0, count: 0 };
  const firstVisible = Math.floor(scrollLeft / pitch);
  const visible = Math.ceil(viewportWidth / pitch) + 1;
  const first = Math.max(0, firstVisible - overscan);
  const last = Math.min(total - 1, firstVisible + visible + overscan);
  return { first, count: Math.max(0, last - first + 1) };
}

/**
 * Where the strip must be scrolled to put a chip in the middle of the window.
 *
 * Index arithmetic rather than a DOM lookup, because the chip being scrolled
 * to is usually not rendered yet -- that is the point of rendering a window.
 */
export function scrollOffsetFor(index, pitch, chipWidth, viewportWidth, total) {
  const railWidth = Math.max(0, total * pitch - (pitch - chipWidth));
  const centred = index * pitch - (viewportWidth - chipWidth) / 2;
  return Math.max(0, Math.min(centred, Math.max(0, railWidth - viewportWidth)));
}

// ---------- elapsed time along the strip ----------

/** Coarse-to-fine ladder of round intervals a human reads without arithmetic. */
const TICK_INTERVALS_MS = [
  60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3,
  3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3,
  86400e3, 2 * 86400e3, 7 * 86400e3,
];

/** Milliseconds since the first layer that carries a usable timestamp. */
export function elapsedSeries(layers) {
  let start = null;
  return layers.map(layer => {
    const at = Date.parse(layer.captured_at);
    if (Number.isNaN(at)) return null;
    if (start === null) start = at;
    return at - start;
  });
}

/**
 * Where round elapsed times fall along a strip indexed by layer.
 *
 * The x axis counts layers, not seconds, so time runs along it at whatever pace
 * the machine managed: ticks spread out where layers came quickly and crowd
 * where they did not. That is the point -- it is the only thing on this page
 * that shows the build's pace -- but it means a stoppage stacks many ticks on
 * one column, so ticks closer together than `minGapPx` are dropped rather than
 * drawn as a smear that reads as detail.
 *
 * The interval is chosen for the span: a two-hour print gets quarter hours, a
 * two-day one gets six-hour marks.
 *
 * @returns {Array<{index: number, elapsedMs: number}>}
 */
export function elapsedTicks(layers, width, minGapPx, maxTicks = 14) {
  const elapsed = elapsedSeries(layers);
  const last = [...elapsed].reverse().find(value => value != null);
  if (layers.length < 2 || last == null || last <= 0 || width <= 0) return [];
  const interval = TICK_INTERVALS_MS.find(step => last / step <= maxTicks)
    ?? TICK_INTERVALS_MS[TICK_INTERVALS_MS.length - 1];
  const span = Math.max(1, layers.length - 1);
  const ticks = [];
  let cursor = 0;
  let lastX = -Infinity;
  for (let mark = interval; mark <= last; mark += interval) {
    // Monotonic sweep: the strip is in build order, which for a live run is
    // also time order, and a cursor that never rewinds keeps this linear.
    while (cursor < elapsed.length && (elapsed[cursor] == null || elapsed[cursor] < mark)) {
      cursor += 1;
    }
    if (cursor >= elapsed.length) break;
    const x = (cursor / span) * width;
    if (x - lastX < minGapPx) continue;
    lastX = x;
    ticks.push({ index: cursor, elapsedMs: mark });
  }
  return ticks;
}

/**
 * Stretches where the machine stopped, as gaps against its own layer rate.
 *
 * A threshold in minutes would be meaningless across machines and materials, so
 * it is a multiple of this build's own median gap, floored so a fast replay
 * does not report every pause between its runs. These are the events the
 * severity strip cannot show: nothing is wrong with the layers either side, the
 * time between them is the finding.
 *
 * Given a pixel budget, stops closer together than `minGapPx` are one mark
 * carrying the longest of them: two stoppages a layer apart are the same column
 * of the strip, and drawing both stacks a mark on a mark.
 *
 * @returns {Array<{index: number, ms: number}>} index is the layer after the stop
 */
export function longPauses(
  layers,
  { multiple = 20, floorMs = 300e3, limit = 12, width = 0, minGapPx = 0 } = {},
) {
  const elapsed = elapsedSeries(layers);
  const gaps = [];
  for (let index = 1; index < elapsed.length; index += 1) {
    if (elapsed[index] == null || elapsed[index - 1] == null) continue;
    gaps.push({ index, ms: elapsed[index] - elapsed[index - 1] });
  }
  if (!gaps.length) return [];
  const sorted = gaps.map(gap => gap.ms).sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(floorMs, multiple * median);
  const found = gaps
    .filter(gap => gap.ms > threshold)
    .sort((left, right) => right.ms - left.ms)
    .slice(0, limit)
    .sort((left, right) => left.index - right.index);
  if (!(width > 0 && minGapPx > 0) || found.length < 2) return found;
  const span = Math.max(1, layers.length - 1);
  const kept = [];
  for (const pause of found) {
    const previous = kept[kept.length - 1];
    const apart = previous
      ? ((pause.index - previous.index) / span) * width
      : Infinity;
    if (apart >= minGapPx) kept.push(pause);
    else if (pause.ms > previous.ms) kept[kept.length - 1] = pause;
  }
  return kept;
}

/** "+6h", "+45m", "+2d 3h" -- short enough for a strip, exact enough to act on. */
export function formatElapsed(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60e3);
  if (minutes < 60) return `+${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `+${hours}h ${restMinutes}m` : `+${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `+${days}d ${restHours}h` : `+${days}d`;
}
