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
export const QUIET_SEVERITIES = new Set(['none', 'clear']);

export function severityToken(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

export function severityRank(token) {
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
  const budget = Math.max(1, Math.min(Math.floor(columns), layers.length));
  const strip = [];
  const perColumn = layers.length / budget;
  for (let column = 0; column < budget; column += 1) {
    const start = Math.floor(column * perColumn);
    const end = column === budget - 1 ? layers.length : Math.floor((column + 1) * perColumn);
    let token = 'unknown';
    let rank = -1;
    let anyEligible = false;
    for (let index = start; index < end; index += 1) {
      const layer = layers[index];
      const layerEligible = eligible(layer);
      if (!layerEligible) continue;
      anyEligible = true;
      const layerToken = severityToken(layer.analysis.severity);
      const layerRank = severityRank(layerToken);
      if (layerRank > rank) {
        rank = layerRank;
        token = layerToken;
      }
    }
    strip.push({
      token: anyEligible ? token : 'unknown',
      eligible: anyEligible,
      quiet: !anyEligible || QUIET_SEVERITIES.has(token),
    });
  }
  return strip;
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
