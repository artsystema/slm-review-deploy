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
 * Where round elapsed times fall along the strip, for the window it is showing.
 *
 * The marks are absolute: multiples of the interval counted from the build's
 * own first layer, not from whichever layer happens to be leftmost. Measuring
 * from the window's edge made a mark mean a different thing at every zoom
 * level, and slide along the strip as playback pushed the window forward --
 * which is no use as a clock.
 *
 * The x axis counts layers, not seconds, so time runs along it at whatever pace
 * the machine managed: marks spread where layers came quickly and crowd where
 * they did not. That is the point, and it is also why marks closer together
 * than `minGapPx` are dropped rather than drawn as a smear that reads as
 * detail. The interval is chosen for the span actually on screen, so zooming in
 * gives finer marks rather than the same ones further apart.
 *
 * @param {Array<number|null>} elapsed whole-build series, from elapsedSeries()
 * @param {{from: number, count: number}} window the layers on screen
 * @returns {Array<{index: number, elapsedMs: number}>} index is a build position
 */
export function elapsedTicks(elapsed, window, width, minGapPx, maxTicks = 14) {
  const from = Math.max(0, window.from);
  const end = Math.min(elapsed.length, from + window.count);
  if (end - from < 2 || width <= 0) return [];
  let firstAt = null;
  let lastAt = null;
  for (let index = from; index < end; index += 1) {
    if (elapsed[index] == null) continue;
    if (firstAt === null) firstAt = elapsed[index];
    lastAt = elapsed[index];
  }
  if (firstAt === null || lastAt === null || lastAt <= firstAt) return [];
  const span = lastAt - firstAt;
  const interval = TICK_INTERVALS_MS.find(step => span / step <= maxTicks)
    ?? TICK_INTERVALS_MS[TICK_INTERVALS_MS.length - 1];
  const ticks = [];
  const denominator = Math.max(1, window.count - 1);
  let cursor = from;
  let lastX = -Infinity;
  const firstMark = Math.max(interval, Math.ceil(firstAt / interval) * interval);
  for (let mark = firstMark; mark <= lastAt; mark += interval) {
    // Monotonic sweep: the strip is in build order, which for a live run is
    // also time order, and a cursor that never rewinds keeps this linear.
    while (cursor < end && (elapsed[cursor] == null || elapsed[cursor] < mark)) {
      cursor += 1;
    }
    if (cursor >= end) break;
    const x = ((cursor - from) / denominator) * width;
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

/**
 * What the elapsed figures on this timeline are actually measuring.
 *
 * `captured_at` is the analysis timestamp. On a live `watch` run that is the
 * frame's own time, so elapsed along the strip is the print's own elapsed time.
 * On a `batch` replay it is when the replay ran, and a forty-minute replay of a
 * twenty-hour print would otherwise be presented as a forty-minute build.
 *
 * A session may hold runs of both kinds, and one that does cannot be called
 * either. Monitors that predate the field send nothing, which is `unknown` --
 * an answer, not a failure.
 *
 * @returns {'print'|'replay'|'mixed'|'unknown'}
 */
export function timeBasis(layers) {
  let watch = false;
  let batch = false;
  for (const layer of layers) {
    if (layer.run_mode === 'watch') watch = true;
    else if (layer.run_mode === 'batch') batch = true;
    else return 'unknown';
  }
  if (watch && batch) return 'mixed';
  if (watch) return 'print';
  if (batch) return 'replay';
  return 'unknown';
}

// ---------- fine scrubbing ----------

/**
 * How many layers a pixel of drag should cover, as the finger moves away.
 *
 * A build of thousands on a phone puts ten layers under every pixel, so a five
 * pixel wobble throws the selection fifty layers and no amount of care lands on
 * the one being looked for. Rather than zooming the strip -- which costs the
 * whole-build view, the thing the strip is for -- the drag itself gets slower
 * the further the finger moves off it, the way a video scrubber does. The strip
 * keeps showing the entire build; only the gearing changes.
 *
 * The rungs are stated as layers per pixel rather than as ratios, so they mean
 * the same thing on a four-thousand-layer build and a three-hundred one, and a
 * short build is never geared down past what it needs.
 */
const SCRUB_RUNGS = [
  { awayPx: 30, layersPerPx: 2 },
  { awayPx: 68, layersPerPx: 0.5 },
  { awayPx: 116, layersPerPx: 0.15 },
];

/**
 * @param {number} awayPx how far the pointer is from where the drag began
 * @param {number} naturalLayersPerPx the strip's own scale
 * @returns {{scale: number, layersPerPx: number, rung: number}} scale <= 1
 */
export function scrubScale(awayPx, naturalLayersPerPx) {
  const natural = naturalLayersPerPx > 0 ? naturalLayersPerPx : 0;
  let rung = 0;
  for (let index = 0; index < SCRUB_RUNGS.length; index += 1) {
    if (Math.abs(awayPx) >= SCRUB_RUNGS[index].awayPx) rung = index + 1;
  }
  if (rung === 0 || natural === 0) return { scale: 1, layersPerPx: natural, rung: 0 };
  // Never gear up: a build already finer than the rung asks for is left alone.
  const scale = Math.min(1, SCRUB_RUNGS[rung - 1].layersPerPx / natural);
  return { scale, layersPerPx: natural * scale, rung: scale < 1 ? rung : 0 };
}

/**
 * The next layer with something wrong with it, in the direction asked.
 *
 * A build of thousands carries a few dozen findings -- session 0109-shell has
 * 55 among 3,617 -- and reaching them by scrubbing means hunting for a bar a
 * pixel wide. What the operator wants from this timeline is almost never a
 * particular layer number; it is the next thing worth looking at.
 *
 * Ends rather than wraps: arriving back at the first finding after the last one
 * would read as there being more of them than there are.
 *
 * @returns {number|null} layer position, or null when there are none that way
 */
export function nextFinding(layers, from, direction) {
  const step = direction < 0 ? -1 : 1;
  for (let index = from + step; index >= 0 && index < layers.length; index += step) {
    if (isFlagged(layers[index])) return index;
  }
  return null;
}

// ---------- the timeline's visible window ----------

/** Fewer layers than this under the strip and zooming further buys nothing. */
const MIN_WINDOW_LAYERS = 24;

/**
 * Hold a window inside the build, and stop it collapsing.
 *
 * The window is a half-open range of layer positions. Clamping keeps it whole:
 * a window pushed past either end slides back rather than shrinking, so the
 * span the operator chose is the span they keep while panning.
 *
 * @returns {{from: number, count: number}}
 */
export function clampWindow(from, count, total) {
  if (total <= 0) return { from: 0, count: 0 };
  const span = Math.max(Math.min(MIN_WINDOW_LAYERS, total), Math.min(Math.round(count), total));
  const start = Math.max(0, Math.min(Math.round(from), total - span));
  return { from: start, count: span };
}

/**
 * Zoom about a point, keeping the layer under it where it is.
 *
 * `at` is where the gesture is anchored, as a fraction of the window's width --
 * the midpoint between two fingers, or the pointer. Keeping that layer still is
 * what makes a pinch feel attached to the strip rather than to the viewport.
 *
 * @param factor >1 zooms in, <1 out
 */
export function zoomWindow(window, factor, at, total) {
  const anchor = window.from + window.count * Math.min(1, Math.max(0, at));
  const count = window.count / (factor > 0 ? factor : 1);
  return clampWindow(anchor - count * Math.min(1, Math.max(0, at)), count, total);
}

/** Whether the window is showing everything there is. */
export function isWholeBuild(window, total) {
  return total <= 0 || window.count >= total;
}

/**
 * Move the window so a layer is inside it, nudging rather than recentring.
 *
 * Stepping off the edge should scroll the strip by a little, the way a text
 * cursor does; recentring on every step would make the whole build slide under
 * a stationary playhead and lose the sense of where you are.
 */
export function windowAround(window, index, total, margin = 0.15) {
  if (index >= window.from + window.count * margin
    && index < window.from + window.count * (1 - margin)) {
    return window;
  }
  if (index < window.from + window.count * margin) {
    return clampWindow(index - window.count * margin, window.count, total);
  }
  return clampWindow(index - window.count * (1 - margin), window.count, total);
}


// ---------- the build behind the layers ----------
//
// Every other figure on the page is derived from the layers this service holds,
// so none of them can say what is missing. These three work against the job
// descriptor's own layer total, published with each bundle, which is the only
// number here that did not come from the rows being counted.

/**
 * The build facts from the API, or null when there is no usable total.
 *
 * Defensive about every field because this object crosses a version boundary:
 * an older service sends no `build` at all, and a total that is absent, zero,
 * negative or not a number has to leave the rail hidden rather than become a
 * denominator.
 */
export function normalizeBuild(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = Number(raw.layers_total);
  if (!Number.isFinite(total) || total < 1) return null;
  const thickness = Number(raw.layer_thickness_mm);
  return {
    total: Math.round(total),
    name: typeof raw.name === 'string' ? raw.name : '',
    material: typeof raw.material === 'string' ? raw.material : '',
    thickness: Number.isFinite(thickness) && thickness > 0 ? thickness : null,
  };
}

/**
 * The highest layer number held: how far into the build this service can see.
 *
 * Not the same as how many layers it holds. A build still printing is ahead of
 * its uploads, and a bundle that failed its first attempt lands minutes later,
 * so the count and the frontier disagree and each answers a different question.
 */
export function highestReceived(layers) {
  let top = 0;
  for (const layer of layers) if (layer.index > top) top = layer.index;
  return top;
}

/**
 * The held layer closest to a position in the whole build.
 *
 * The rail spans layers that may not exist here, so a click has to land on
 * something real. Nearest rather than next: clicking into a gap should select
 * whichever side of it is closer, not always skip forward past the gap.
 */
export function layerNearestBuildFraction(layers, total, fraction) {
  if (!layers.length || !Number.isFinite(total) || total < 1) return null;
  const target = fraction * total;
  let best = layers[0];
  let bestGap = Math.abs(best.index - target);
  for (const layer of layers) {
    const gap = Math.abs(layer.index - target);
    if (gap < bestGap) { bestGap = gap; best = layer; }
  }
  return best;
}
