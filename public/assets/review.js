import {
  argonSeries,
  decimate,
  defectRateSeries,
  eligible,
  isFlagged,
  scrollOffsetFor,
  severityColumns,
  severityToken,
  visibleWindow,
} from './review-core.js';

const state = {
  sessions: [],
  layers: [],
  selectedId: null,
  selectedMediaRole: null,
  // The session index is the timeline; detail arrives per layer looked at.
  detail: new Map(),
  detailPending: new Set(),
  truncated: false,
  latestId: 0,
  loading: false,
  follow: true,
  scrubbing: false,
  stageAspect: null,
  pollDelay: 0,
  pollTimer: null,
  unseen: 0,
  fill: false,
  grid: false,
};

// Zoom and pan survive both layer and view changes on purpose: the whole point
// of this viewer is to magnify one defect and then scrub layers, or flip
// between raw and analysis, watching that same spot.
const view = { scale: 1, x: 0, y: 0 };

const el = id => document.querySelector(`#${id}`);
const select = el('session-select');
const notice = el('notice');
const filmstrip = el('filmstrip');
const followToggle = el('follow-toggle');
const stage = el('stage');
const viewport = el('stage-viewport');
const stageImage = el('stage-image');
const stageEmpty = el('stage-empty');
const stageHint = el('stage-hint');
const scrubber = el('scrubber');
const scrubCanvas = el('scrub-canvas');
const playhead = el('scrub-playhead');
const bubble = el('scrub-bubble');
const timelineCount = el('timeline-count');
const fillToggle = el('fill-toggle');
const gridToggle = el('grid-toggle');
const stageGrid = el('stage-grid');

const basePath = window.location.pathname.replace(/\/$/, '');
const POLL_MIN_MS = 10000;
const POLL_MAX_MS = 60000;
const MAX_SCALE = 8;
const PREFETCH_RADIUS = 6;
// Detail for the selection and its neighbours, so stepping and scrubbing find
// the next frame's facts already here. Kept under the API's own id cap.
const DETAIL_RADIUS = 12;
// How close the selection may get to unfetched detail before the next window is
// asked for. Smaller than the radius so one request covers several steps.
const DETAIL_CORE = 3;
// A rise of at least this much in the combined reserve is a bottle being
// changed, not the needle wandering. Mirrors the monitor's argon.TANK_CHANGE_RISE.
const TANK_CHANGE_RISE = 1.0;
// The runway fit needs a real span to divide by; below this it would turn layer
// scatter into a dramatic figure. Mirrors argon.MIN_HOURS_FOR_RATE.
const RUNWAY_MIN_HOURS = 0.25;
const RUNWAY_MIN_POINTS = 5;
const RUNWAY_WINDOW = 40;
// Short enough to read as a tick, long enough that the motor actually renders
// it: an 8 ms pulse is below the spin-up time of most phone vibrators and is
// felt as nothing.
const SCRUB_HAPTIC_MS = 20;
const SCRUB_HAPTIC_INTERVAL_MS = 40;

// Toggle order reads as a pipeline: what the camera saw, then the verdict, then
// the intermediate evidence behind it.
const mediaOrder = [
  'raw_before',
  'raw_after',
  'diagnostic_overlay',
  'key_view',
  'underfill_residual',
  'renewal_unrenewed',
  'underfill_mask',
  'underfill_texture',
  'underfill_baseline',
];
const defaultRoles = ['diagnostic_overlay', 'key_view', 'raw_after', 'raw_before'];
const mediaLabels = {
  raw_before: 'Before',
  raw_after: 'After',
  diagnostic_overlay: 'Analysis',
  key_view: 'Analysis',
  renewal_unrenewed: 'Renewal',
  underfill_mask: 'Deficit mask',
  underfill_residual: 'Residual',
  underfill_texture: 'Texture',
  underfill_baseline: 'Baseline',
};
const channelColors = ['#4fc3c8', '#e0a63a', '#b57af2', '#ef718a'];
const severityColors = {
  none: '#2f5b46',
  clear: '#2f5b46',
  info: '#4da3ff',
  warning: '#e0a63a',
  critical: '#e0523a',
  emergency: '#e0523a',
};

// ---------- helpers ----------

function setNotice(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle('error', error);
}

async function api(path) {
  const response = await fetch(`${basePath}${path}`, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function selected() { return state.layers.find(layer => layer.id === state.selectedId) || state.layers.at(-1) || null; }
function selectedIndex() { const i = state.layers.findIndex(layer => layer.id === state.selectedId); return i < 0 ? state.layers.length - 1 : i; }
function escaped(value) { const element = document.createElement('span'); element.textContent = String(value); return element.innerHTML; }
function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
function numeric(value) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'unknown'; }
function percent(value) { return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'unknown'; }

function shortStamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'time unknown' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ageLabel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'age unknown';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value / 60000)} min`;
}

/**
 * How long the argon lasts, from the committed layers alone.
 *
 * The monitor cannot tell the reviewer a runway without a schema change, so it
 * is fitted here from the same per-layer combined reserve the argon chart
 * already plots: a least-squares slope of reserve against time over the trailing
 * window, restarted at any bottle change, then latest reserve / that rate. It is
 * hours to empty at the recent draw, in the gauge's own pressure units -- never
 * a volume, and never projected past what the layers actually show.
 */
function argonRunway() {
  const points = [];
  for (const layer of state.layers) {
    const combined = layer.argon_snapshot?.combined;
    const value = combined && combined.state === 'complete' ? combined.value : null;
    const at = Date.parse(layer.captured_at);
    if (typeof value !== 'number' || !Number.isFinite(value) || Number.isNaN(at)) continue;
    // A refill resets the level; the fit must not read the jump as a gain.
    if (points.length && value - points[points.length - 1].value >= TANK_CHANGE_RISE) {
      points.length = 0;
    }
    points.push({ value, at });
  }
  const recent = points.slice(-RUNWAY_WINDOW);
  if (recent.length < RUNWAY_MIN_POINTS) {
    return { hours: null, ratePerHour: null, reason: 'not enough committed layers with a combined reading' };
  }
  const hoursOf = (ms) => (ms - recent[0].at) / 3_600_000;
  const spanHours = hoursOf(recent[recent.length - 1].at);
  if (spanHours < RUNWAY_MIN_HOURS) {
    return { hours: null, ratePerHour: null, reason: 'not enough elapsed time to measure a rate' };
  }
  const n = recent.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const point of recent) {
    const x = hoursOf(point.at);
    sx += x; sy += point.value; sxx += x * x; sxy += x * point.value;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { hours: null, ratePerHour: null, reason: 'readings do not span any time' };
  const slope = (n * sxy - sx * sy) / denom;
  const ratePerHour = -slope;
  if (ratePerHour <= 0) {
    return { hours: null, ratePerHour, reason: 'argon steady over these layers' };
  }
  const latest = recent[recent.length - 1].value;
  return { hours: latest > 0 ? latest / ratePerHour : 0, ratePerHour, reason: null };
}

function layerMedia(layer) {
  const media = Array.isArray(layer.media)
    ? layer.media.filter(item => item && typeof item.role === 'string' && typeof item.url === 'string')
    : [];
  if (media.length) {
    return [...media].sort((left, right) => mediaOrder.indexOf(left.role) - mediaOrder.indexOf(right.role));
  }
  return layer.key_view_url ? [{ role: 'key_view', stage: null, url: layer.key_view_url }] : [];
}

function preferredMedia(layer) {
  const media = layerMedia(layer);
  return defaultRoles.map(role => media.find(item => item.role === role)).find(Boolean) || media[0] || null;
}

/** Media for the role the operator is holding, falling back only when this layer lacks it. */
function currentMedia(layer) {
  if (!layer) return null;
  const media = layerMedia(layer);
  return media.find(item => item.role === state.selectedMediaRole) || preferredMedia(layer);
}

/** Build order, not arrival order: the same key the server sorts on. */
function byBuildOrder(left, right) {
  return (left.run_local_id ?? 0) - (right.run_local_id ?? 0)
    || left.index - right.index
    || left.id - right.id;
}

function mergeLayers(incoming) {
  const byId = new Map(state.layers.map(layer => [layer.id, layer]));
  let added = 0;
  for (const layer of incoming) {
    if (!byId.has(layer.id)) added += 1;
    byId.set(layer.id, layer);
  }
  state.layers = [...byId.values()].sort(byBuildOrder);
  invalidateSeries();
  return added;
}

// ---------- derived series ----------
// Everything here is a function of the loaded layers and nothing else -- the
// plotted series, the counts in the notice, how long the argon lasts, the units
// it is measured in. So it is computed when layers arrive rather than when the
// selection moves. Refitting a build's argon runway on every arrow press is
// both slow and a statement about the code that is not true: the runway is a
// property of the build, not of which layer is being looked at.

let seriesCache = null;

function invalidateSeries() { seriesCache = null; }

function series() {
  if (seriesCache) return seriesCache;
  const windowSize = Math.min(40, Math.max(1, state.layers.length));
  let eligibleCount = 0;
  let flaggedCount = 0;
  for (const layer of state.layers) {
    if (eligible(layer)) eligibleCount += 1;
    if (isFlagged(layer)) flaggedCount += 1;
  }
  seriesCache = {
    windowSize,
    defect: defectRateSeries(state.layers, windowSize),
    argon: argonSeries(state.layers),
    eligibleCount,
    flaggedCount,
    runway: argonRunway(),
    units: argonUnits(),
  };
  return seriesCache;
}

// ---------- image cache ----------
// Scrubbing swaps the stage image many times a second. Assigning a src that the
// browser has not decoded yet paints a blank frame first, which reads as a
// flicker, so decoded images are kept and only decoded ones are shown at once.

const imageCache = new Map();
// Budgeted in pixels rather than frames, because the frames are not small: a
// 1280x960 evidence frame is about five megabytes once decoded, so a cache of
// a hundred and twenty of them is most of a gigabyte on the phone that is
// meant to be reviewing a build in a corridor. This budget is roughly twenty
// full frames -- comfortably more than the prefetch radius and the all-views
// grid ask for at once.
const IMAGE_CACHE_PIXELS = 24e6;
const ASSUMED_PIXELS = 1280 * 960;
let cachedPixels = 0;

function trimImageCache() {
  // Insertion-ordered, so the oldest entries are the front of the map. The
  // frame on screen is re-inserted by showImage and so is never evicted.
  for (const [url, entry] of imageCache) {
    if (cachedPixels <= IMAGE_CACHE_PIXELS) break;
    if (url === stageImage.dataset.pending) continue;
    cachedPixels -= entry.pixels;
    imageCache.delete(url);
  }
}

function cached(url) {
  if (!url) return null;
  let entry = imageCache.get(url);
  if (!entry) {
    const image = new Image();
    entry = { image, ready: false, pixels: ASSUMED_PIXELS };
    imageCache.set(url, entry);
    cachedPixels += entry.pixels;
    image.decoding = 'async';
    image.addEventListener('load', () => {
      entry.ready = true;
      if (imageCache.get(url) === entry) {
        cachedPixels += (image.naturalWidth * image.naturalHeight) - entry.pixels;
        entry.pixels = image.naturalWidth * image.naturalHeight;
      }
      if (stageImage.dataset.pending === url) showImage(url);
    });
    image.addEventListener('error', () => { entry.failed = true; });
    image.src = url;
    trimImageCache();
  }
  return entry;
}

function showImage(url) {
  if (!url) {
    stageImage.removeAttribute('src');
    stageImage.dataset.pending = '';
    return;
  }
  const entry = cached(url);
  stageImage.dataset.pending = url;
  if (entry.ready) {
    if (stageImage.getAttribute('src') !== url) stageImage.src = url;
    stage.classList.remove('is-loading');
    return;
  }
  if (entry.failed) { stage.classList.remove('is-loading'); return; }
  // Hold the previous frame rather than blanking the stage.
  stage.classList.add('is-loading');
  if (!stageImage.getAttribute('src')) stageImage.src = url;
}

function prefetchAround(index) {
  const role = state.selectedMediaRole;
  for (let offset = -PREFETCH_RADIUS; offset <= PREFETCH_RADIUS; offset += 1) {
    const layer = detailed(state.layers[index + offset]);
    if (!layer) continue;
    const media = layerMedia(layer).find(item => item.role === role) || preferredMedia(layer);
    if (media) cached(media.url);
  }
}

// ---------- stage geometry ----------

/**
 * One aspect ratio for every view, held for the whole session.
 *
 * Detector renderings and raw frames do not share a shape — renewal stages are
 * cropped to the bed — so letting each image size the stage made the panel jump
 * on every toggle. The box is fixed and images are contained inside it.
 */
function resolveStageAspect() {
  if (state.stageAspect) return state.stageAspect;
  for (const role of ['raw_after', 'diagnostic_overlay', 'raw_before', 'key_view']) {
    for (const layer of state.detail.values()) {
      const media = layerMedia(layer).find(item => item.role === role);
      if (media && media.width > 0 && media.height > 0) {
        state.stageAspect = media.width / media.height;
        return state.stageAspect;
      }
    }
  }
  return null;
}

function applyStageAspect() {
  const aspect = resolveStageAspect();
  stage.style.setProperty('--stage-aspect', aspect ? String(aspect) : '4 / 3');
}

function applyTransform() {
  stageImage.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
  stage.classList.toggle('is-zoomed', view.scale > 1.001);
  viewport.style.touchAction = view.scale > 1.001 ? 'none' : 'pan-y';
  el('zoom-reset').textContent = `${view.scale.toFixed(view.scale < 10 ? 1 : 0)}×`;
}

function clampPan() {
  const bounds = viewport.getBoundingClientRect();
  const slackX = Math.max(0, (bounds.width * view.scale - bounds.width) / 2);
  const slackY = Math.max(0, (bounds.height * view.scale - bounds.height) / 2);
  view.x = clamp(view.x, -slackX, slackX);
  view.y = clamp(view.y, -slackY, slackY);
}

/** Zoom about a viewport point so the pixel under the finger stays under it. */
function zoomAt(nextScale, clientX, clientY) {
  const bounds = viewport.getBoundingClientRect();
  const target = clamp(nextScale, 1, MAX_SCALE);
  const originX = clientX - bounds.left - bounds.width / 2;
  const originY = clientY - bounds.top - bounds.height / 2;
  const ratio = target / view.scale;
  view.x = originX - (originX - view.x) * ratio;
  view.y = originY - (originY - view.y) * ratio;
  view.scale = target;
  if (view.scale <= 1.001) { view.scale = 1; view.x = 0; view.y = 0; }
  clampPan();
  applyTransform();
}

function resetZoom() { view.scale = 1; view.x = 0; view.y = 0; applyTransform(); }

function setGrid(showing) {
  state.grid = showing;
  stage.classList.toggle('is-grid', showing);
  stageGrid.hidden = !showing;
  gridToggle.setAttribute('aria-pressed', String(showing));
  gridToggle.title = showing ? 'Back to the single view' : 'Show every view at once';
  renderStage();
  writeHash();
}

function renderGrid(layer) {
  stageGrid.replaceChildren();
  const media = layerMedia(layer);
  for (const item of media) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `grid-tile ${item.role === state.selectedMediaRole ? 'is-current' : ''}`;
    tile.setAttribute('role', 'listitem');
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.src = item.url;
    image.alt = `Layer ${layer.index} ${mediaLabels[item.role] || item.role}`;
    const label = document.createElement('span');
    label.textContent = mediaLabels[item.role] || item.role;
    tile.append(image, label);
    // Tapping a tile is how you go from comparing to inspecting.
    tile.addEventListener('click', () => {
      state.selectedMediaRole = item.role;
      setGrid(false);
      renderSelector();
    });
    stageGrid.append(tile);
  }
}

function setFill(filling) {
  state.fill = filling;
  stage.classList.toggle('is-filled', filling);
  fillToggle.setAttribute('aria-pressed', String(filling));
  fillToggle.title = filling ? 'Fit the whole frame in the panel' : 'Crop the frame to fill the panel';
}

// ---------- deep links ----------
// State lives in the fragment, not the query, so a shared link costs no round
// trip and cannot collide with the PHP router under a base-path install.
// A followed session is addressed as `live` rather than by whichever layer
// happened to be newest when the link was copied.


// Opening a shared link runs loads that would each write the hash, overwriting
// the link before it has been read. Writes are held until the link is applied.
let applyingHash = window.location.hash.length > 1;

function hashParams() {
  return new URLSearchParams(window.location.hash.replace(/^#/, ''));
}

function writeHash() {
  const chosen = currentSelection();
  if (chosen === null || applyingHash) return;
  const parameters = new URLSearchParams();
  parameters.set('m', chosen.monitor);
  parameters.set('s', chosen.session === null ? 'unassigned' : String(chosen.session));
  if (state.follow) {
    parameters.set('live', '1');
  } else {
    const layer = selected();
    if (layer) {
      parameters.set('r', String(layer.run_local_id));
      parameters.set('l', String(layer.index));
    }
  }
  if (state.selectedMediaRole) parameters.set('v', state.selectedMediaRole);
  if (state.grid) parameters.set('grid', '1');
  const next = `#${parameters}`;
  // replaceState does not fire hashchange, so this never re-enters applyHash.
  if (next !== window.location.hash) history.replaceState(null, '', next);
}

/** Select the session a link names, comparing parsed values rather than
 *  rebuilt JSON: the session id's type depends on the driver behind the API. */
function selectSessionFromHash(parameters) {
  const monitor = parameters.get('m');
  const session = parameters.get('s');
  if (!monitor || !session) return false;
  const option = [...select.options].find(item => {
    if (!item.value) return false;
    const chosen = JSON.parse(item.value);
    return String(chosen.monitor) === monitor
      && String(chosen.session ?? 'unassigned') === session;
  });
  if (!option || select.value === option.value) return Boolean(option);
  select.value = option.value;
  return true;
}

/**
 * Open the layer a link addresses.
 *
 * The session index carries the whole build, so this is a lookup rather than
 * the paging walk it used to be: a link into layer 3,000 of a long build no
 * longer costs a dozen round trips before it can answer, and a layer that is
 * genuinely absent is now known to be absent rather than merely not reached.
 */
function focusHashLayer(parameters) {
  const run = Number(parameters.get('r'));
  const index = Number(parameters.get('l'));
  if (!parameters.get('r') || !parameters.get('l') || !Number.isFinite(run) || !Number.isFinite(index)) {
    return false;
  }
  const layer = state.layers.find(item => item.run_local_id === run && item.index === index);
  if (layer) {
    setFollow(false);
    activateLayer(layer, false);
    return true;
  }
  setNotice(`Layer ${index} of run ${run} is not among the published layers for this session.`, true);
  return false;
}

async function applyHash() {
  const parameters = hashParams();
  applyingHash = true;
  try {
    if (parameters.get('m')) {
      if (selectSessionFromHash(parameters)) await loadLayers();
      const role = parameters.get('v');
      if (role) state.selectedMediaRole = role;
      await focusHashLayer(parameters);
      if (parameters.get('grid') === '1') setGrid(true);
      else { renderSelector(); renderStage(); }
    }
  } catch (error) {
    // A deep link is a convenience, and a stale one must cost nothing. The
    // session it names may be gone, the layer id may have been republished
    // under a different number, the network may simply have blinked. Failing
    // here used to take the whole live loop down with it, because the poll was
    // scheduled after this step rather than independently of it.
    setNotice(`Could not open that link: ${error.message}. Showing the latest instead.`, true);
  } finally {
    applyingHash = false;
  }
  writeHash();
}

// ---------- data loading ----------

async function loadSessions(preserve = false) {
  const payload = await api('/api/v1/sessions?limit=100');
  state.sessions = payload.sessions;
  const previous = select.value;
  select.replaceChildren();
  if (!state.sessions.length) {
    select.append(new Option('No committed sessions', ''));
    setNotice('No committed bundles yet. The sync agent may be offline or its queue is empty.');
    return;
  }
  for (const session of state.sessions) {
    const value = JSON.stringify({ monitor: session.monitor_instance_id, session: session.session_local_id });
    const title = session.session_name || 'Unassigned monitor stream';
    select.append(new Option(`${title} / ${session.layer_count} layers`, value));
  }
  if (preserve && [...select.options].some(option => option.value === previous)) {
    select.value = previous;
    return;
  }
  await loadLayers();
}

/** The chosen session, or null while the picker still holds its placeholder. */
function currentSelection() {
  if (!select.value) return null;
  try {
    return JSON.parse(select.value);
  } catch {
    return null;
  }
}

function sessionParameters(limit = '250') {
  const chosen = currentSelection();
  if (chosen === null) return null;
  const parameters = new URLSearchParams({ monitor_instance_id: chosen.monitor });
  if (limit !== null) parameters.set('limit', limit);
  if (chosen.session === null) parameters.set('unassigned', 'true');
  else parameters.set('session_id', chosen.session);
  return parameters;
}

// Selecting a session while the previous load is still in flight used to be
// dropped by the in-flight guard: the picker moved, the layers did not, and the
// viewer showed one session's frames under another's name. A reset always
// supersedes, and a superseded response is discarded when it lands.
let loadToken = 0;

/**
 * Load the whole session's timeline in one request.
 *
 * The index carries only what the strip, the severity scrubber, the charts and
 * the argon runway read -- about 161 bytes a layer against the 4,517 the full
 * row costs, most of which is a metrics dict nothing here displays. A build of
 * thousands used to arrive fifteen pages at a time, and the operator had to
 * keep pressing for them; worse, the defect rate and the hours of argon left
 * were fitted over however many pages had been pressed for, so the figures
 * moved when the button was pressed. Over the whole build they are properties
 * of the build.
 *
 * Per-layer detail -- the media, the metrics, the processor, the reading ages
 * -- is fetched for the layers actually being looked at. See ensureDetail().
 */
async function loadLayers() {
  if (!select.value) return;
  const token = ++loadToken;
  state.loading = true;
  try {
    const parameters = sessionParameters(null);
    if (parameters === null) return;
    const payload = await api(`/api/v1/layers/index?${parameters}`);
    if (token !== loadToken) return;
    state.layers = [];
    state.detail.clear();
    state.stageAspect = null;
    state.selectedMediaRole = null;
    imageCache.clear();
    cachedPixels = 0;
    resetZoom();
    mergeLayers(payload.layers);
    state.truncated = Boolean(payload.truncated);
    state.latestId = payload.latest_id || 0;
    state.follow = true;
    state.unseen = 0;
    state.selectedId = state.layers.at(-1)?.id ?? null;
    reportCounts();
    render();
    // The address bar is the share affordance, so it carries a usable link from
    // the first load rather than only after the operator touches something.
    writeHash();
    if (state.selectedId != null) {
      requestAnimationFrame(() => revealLayerChip(state.selectedId, 'auto'));
      await ensureDetail(selectedIndex());
    }
  } finally {
    // A superseded load must not clear the flag out from under the newer one.
    if (token === loadToken) state.loading = false;
  }
}

// ---------- per-layer detail ----------

// Detail rows are the heavy ones -- the metrics dict alone is a third of a
// layer -- so what has been fetched is bounded like the image cache is. A drag
// across a long build would otherwise pull the whole thing back in behind the
// index that exists precisely to avoid that.
const DETAIL_CACHE_LIMIT = 400;

function rememberDetail(layer) {
  state.detail.delete(layer.id);
  state.detail.set(layer.id, layer);
  // Insertion-ordered, so the front is the least recently fetched. The layer on
  // screen was just re-inserted and so is never the one dropped.
  while (state.detail.size > DETAIL_CACHE_LIMIT) {
    state.detail.delete(state.detail.keys().next().value);
  }
}

/**
 * Fetch the detail for the selection and the layers either side of it.
 *
 * Called when the selection settles, not while it is moving: a drag passes
 * hundreds of layers the operator is not stopping on, and asking for each of
 * them put a hundred requests on the uplink for frames nobody looked at. The
 * neighbours come in the same request as the selection, so stepping and
 * releasing a drag find the next layer's facts already here.
 *
 * Requests in flight are not repeated, and a failure leaves the timeline alone
 * -- the strip and the charts are drawn from the index, which is already here.
 */
async function ensureDetail(index) {
  if (state.scrubbing) return;
  const known = offset => {
    const layer = state.layers[index + offset];
    return !layer || state.detail.has(layer.id) || state.detailPending.has(layer.id);
  };
  // Only go back to the server when the layers about to be stepped onto are
  // missing, not whenever the edge of the window is. Asking on every keypress
  // would put one request per arrow press on a plant uplink to fetch one layer.
  let atEdge = false;
  for (let offset = -DETAIL_CORE; offset <= DETAIL_CORE; offset += 1) {
    if (!known(offset)) { atEdge = true; break; }
  }
  if (!atEdge) return;
  const wanted = [];
  for (let offset = -DETAIL_RADIUS; offset <= DETAIL_RADIUS; offset += 1) {
    const layer = state.layers[index + offset];
    if (!layer || state.detail.has(layer.id) || state.detailPending.has(layer.id)) continue;
    wanted.push(layer.id);
  }
  if (!wanted.length) return;
  const parameters = sessionParameters(null);
  if (parameters === null) return;
  parameters.set('ids', wanted.join(','));
  for (const id of wanted) state.detailPending.add(id);
  try {
    const payload = await api(`/api/v1/layers?${parameters}`);
    for (const layer of payload.layers) rememberDetail(layer);
    applyStageAspect();
    // Only the parts that read detail; the timeline did not change.
    renderSelector();
    renderStage();
    renderSidebar();
  } catch (error) {
    setNotice(`Layer detail could not be loaded: ${error.message}.`, true);
  } finally {
    for (const id of wanted) state.detailPending.delete(id);
  }
}

/**
 * The layer with its detail where that has arrived.
 *
 * A detail row is a superset of an index row, so this is the index row until
 * the fetch lands and the full row afterwards. Callers that need media must
 * check `detailLoaded` rather than an empty media list: not loaded yet and
 * nothing was published are different answers, and the second one is a fault.
 */
function detailed(layer) {
  if (!layer) return null;
  return state.detail.get(layer.id) ?? layer;
}

function detailLoaded(layer) {
  return Boolean(layer && state.detail.has(layer.id));
}

function reportCounts(extra = '') {
  const { eligibleCount: completed, flaggedCount: flagged } = series();
  const unavailable = state.layers.length - completed;
  const behind = state.unseen && !state.follow
    ? `  ${state.unseen} newer layer${state.unseen === 1 ? '' : 's'} arrived; press End or Live to catch up.`
    : '';
  // A build past the index cap is said out loud. Every figure on this page is
  // computed over the layers named here, so a timeline that is quietly missing
  // its start would make the defect rate and the argon runway quietly wrong.
  const capped = state.truncated
    ? '  This build is longer than one index request carries; the figures cover the layers listed here only.'
    : '';
  setNotice(
    `${state.layers.length} loaded / ${completed} completed / ${flagged} flagged / `
    + `${unavailable} unavailable or uncertain.${behind}${capped}${extra}`,
    state.truncated,
  );
}

// ---------- live updates ----------

function schedulePoll(delay = POLL_MIN_MS) {
  window.clearTimeout(state.pollTimer);
  state.pollDelay = delay;
  state.pollTimer = window.setTimeout(poll, delay);
}

async function poll() {
  if (document.hidden || !select.value || state.loading || state.scrubbing) {
    schedulePoll(POLL_MIN_MS);
    return;
  }
  try {
    const parameters = sessionParameters();
    if (parameters === null) { schedulePoll(POLL_MIN_MS); return; }
    parameters.set('since_id', String(state.latestId));
    const payload = await api(`/api/v1/layers?${parameters}`);
    // The poll returns full rows, so a layer that arrives live is already
    // detailed: following a build never waits for a second request.
    for (const layer of payload.layers) rememberDetail(layer);
    const added = mergeLayers(payload.layers);
    state.latestId = Math.max(state.latestId, payload.latest_id || 0);
    if (added) {
      applyStageAspect();
      const last = state.layers.at(-1);
      if (state.follow && last) {
        state.unseen = 0;
        state.selectedId = last.id;
        render();
        revealLayerChip(last.id, 'smooth');
      } else {
        state.unseen += added;
        render();
      }
      updateFollowLabel();
    }
    // Recovering from a failed poll has to clear the error text, not just its
    // styling, even on a tick that brought nothing new.
    if (added || notice.classList.contains('error')) reportCounts();
    // A full page means the viewer is behind; drain it before idling again.
    schedulePoll(payload.more ? 250 : POLL_MIN_MS);
  } catch (error) {
    setNotice(`Live update failed: ${error.message}. Retrying.`, true);
    schedulePoll(Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, state.pollDelay * 2)));
  }
}

function updateFollowLabel() {
  const label = state.follow
    ? 'Live'
    : state.unseen
      ? `${state.unseen} new`
      : 'Paused';
  followToggle.querySelector('.follow-text').textContent = label;
  followToggle.classList.toggle('has-backlog', !state.follow && state.unseen > 0);
}

function setFollow(following) {
  state.follow = following;
  if (following) state.unseen = 0;
  followToggle.setAttribute('aria-pressed', String(following));
  followToggle.classList.toggle('is-following', following);
  updateFollowLabel();
  if (following) {
    const last = state.layers.at(-1);
    if (last && last.id !== state.selectedId) activateLayer(last, false);
    schedulePoll(500);
  }
  writeHash();
}

// ---------- rendering ----------

/**
 * Everything that depends on which layer is selected, and nothing that does not.
 *
 * Stepping a layer moves a highlight, a frame and a playhead. It does not
 * change the timeline, the severity strip or either chart, so those are left
 * alone: redrawing them per keystroke cost most of a second on a long build.
 */
function renderSelection() {
  renderSelector();
  renderStage();
  renderSidebar();
  markSelectedChip();
  positionPlayhead();
  drawChartSelection();
}

/** Everything above, plus the parts that change only when layers arrive. */
function render() {
  renderScrubber();
  renderFilmstrip();
  renderDefectChart();
  renderArgonChart();
  renderSelection();
}

function activateLayer(layer, userDriven = true) {
  if (!layer) return;
  state.selectedId = layer.id;
  if (state.layers.at(-1)?.id === layer.id) state.unseen = 0;
  updateFollowLabel();
  if (userDriven) {
    const isLast = state.layers.at(-1)?.id === layer.id;
    if (state.follow !== isLast) setFollow(isLast);
  }
  renderSelection();
  ensureDetail(selectedIndex());
  revealLayerChip(layer.id, state.scrubbing ? 'auto' : 'smooth');
  writeHash();
}

function stepLayer(offset) {
  const next = state.layers[clamp(selectedIndex() + offset, 0, state.layers.length - 1)];
  if (next && next.id !== state.selectedId) activateLayer(next);
}

function renderSelector() {
  const selector = el('evidence-selector');
  const layer = detailed(selected());
  const media = layer ? layerMedia(layer) : [];
  const current = currentMedia(layer);
  const shown = current?.role ?? null;
  selector.replaceChildren();
  for (const item of media) {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.className = item.role === shown ? 'selected' : '';
    button.setAttribute('aria-selected', String(item.role === shown));
    button.textContent = mediaLabels[item.role] || item.role;
    button.addEventListener('click', () => {
      state.selectedMediaRole = item.role;
      renderSelector();
      renderStage();
      writeHash();
    });
    selector.append(button);
  }
  // Keep the held view reachable: number keys and narrow phones both leave it
  // outside the visible run of the row.
  selector.classList.toggle('is-scrollable', selector.scrollWidth > selector.clientWidth + 1);
  selector.querySelector('button.selected')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function renderStage() {
  const chosen = selected();
  const layer = detailed(chosen);
  const caption = el('frame-caption');
  if (!layer) {
    showImage(null);
    stageEmpty.hidden = false;
    stageEmpty.textContent = 'No layer data.';
    caption.textContent = 'No evidence selected.';
    return;
  }
  const current = currentMedia(layer);
  if (!current) {
    // Frames follow the finger along the timeline, and a drag crosses hundreds
    // of layers whose detail is deliberately not fetched. The index names a
    // chip image for every layer, so the drag shows that and says it is doing
    // so; the evidence itself loads when the drag stops. It is captioned as a
    // preview because with a published thumbnail role it is a small image shown
    // large, and nobody should read a verdict off a softened picture.
    const preview = state.scrubbing ? chosen?.preview_url : null;
    if (preview) {
      stageEmpty.hidden = true;
      stageHint.textContent = `Layer ${layer.index}`;
      stageImage.alt = `Layer ${layer.index} scrub preview`;
      showImage(preview);
      caption.textContent = `Scrub preview / layer ${layer.index} / release to load the evidence`;
      return;
    }
    // Waiting for this layer's detail and having none published are different
    // answers, and only the second is a fault worth reporting as one.
    const waiting = !detailLoaded(chosen);
    showImage(null);
    stageEmpty.hidden = false;
    stageEmpty.textContent = waiting
      ? 'Loading this layer’s evidence…'
      : 'No review image was published for this result.';
    caption.textContent = waiting
      ? `Layer ${layer.index}`
      : 'Raw and diagnostic evidence unavailable.';
    return;
  }
  stageEmpty.hidden = true;
  stageHint.textContent = `Layer ${layer.index}`;
  if (state.grid) {
    renderGrid(layer);
    const views = layerMedia(layer).length;
    caption.textContent = `All views / ${views} view${views === 1 ? '' : 's'} / layer ${layer.index}`;
    return;
  }
  stageImage.alt = `Layer ${layer.index} ${mediaLabels[current.role] || current.role}`;
  showImage(current.url);
  prefetchAround(selectedIndex());
  const dimensions = current.width && current.height ? `${current.width} x ${current.height}` : 'dimensions unavailable';
  caption.textContent = `${mediaLabels[current.role] || current.role} / ${dimensions}${current.stage ? ` / ${current.stage}` : ''}`;
}

function renderSidebar() {
  const chosen = selected();
  const layer = detailed(chosen);
  const waiting = Boolean(chosen) && !detailLoaded(chosen);
  const facts = el('layer-facts');
  const title = el('layer-title');
  const argon = el('argon-state');
  const severityBadge = el('layer-severity');
  const reason = el('analysis-reason');
  const combinedLabel = el('argon-combined');
  renderRunway();
  if (!layer) {
    facts.innerHTML = '';
    title.textContent = 'No layer';
    argon.textContent = 'Argon context unavailable.';
    severityBadge.textContent = 'unknown';
    severityBadge.className = 'severity-badge severity-unknown';
    reason.textContent = 'Select a committed layer to inspect its result.';
    combinedLabel.textContent = '--';
    return;
  }
  title.textContent = `Layer ${layer.index}`;
  severityBadge.textContent = layer.analysis.severity || 'unknown';
  severityBadge.className = `severity-badge severity-${severityToken(layer.analysis.severity)}`;
  // The session index answers the verdict; the explanation and the provenance
  // come with the detail. Saying "unknown" for a field that is merely still in
  // flight would read as the monitor having failed to record it.
  const pending = value => (waiting ? 'loading...' : value);
  reason.textContent = waiting
    ? 'Loading this layer’s analysis...'
    : layer.analysis.reason || 'No processor explanation was published for this layer.';
  const values = [
    ['Captured', new Date(layer.captured_at).toLocaleString()],
    ['Status', layer.analysis.status],
    ['State', pending(layer.analysis.state)],
    ['Deficit area', percent(layer.analysis.deficit_area_frac)],
    ['Confidence', pending(numeric(layer.analysis.confidence))],
    ['Processor', pending(layer.run ? `${layer.run.processor} ${layer.run.processor_version}` : 'unknown')],
    ['Rules', pending(layer.run?.rules_version || 'unknown')],
    ['Profile', pending(layer.run?.profile_name || 'unknown')],
    // Which build published this layer. Two monitors feeding the same reviewer
    // are otherwise indistinguishable, and a stale one shows up only as fewer
    // views than expected -- which reads as a fault in this page rather than in
    // the machine that sent the bundle.
    ['Monitor build', pending(layer.monitor_software_version || 'unknown')],
  ];
  facts.innerHTML = values.map(([key, value]) => `<dt>${escaped(key)}</dt><dd>${escaped(value ?? 'unknown')}</dd>`).join('');
  const channels = layer.argon_snapshot.channels || [];
  const combined = layer.argon_snapshot.combined || {};
  combinedLabel.textContent = combined.value == null
    ? String(combined.state || 'unknown')
    : `${numeric(combined.value)} ${combined.units || ''}`;
  argon.replaceChildren();
  if (!channels.length) {
    argon.textContent = 'No enabled channels were recorded with this layer.';
    return;
  }
  for (const channel of channels) {
    const row = document.createElement('div');
    row.className = `argon-row ${channel.value == null ? 'is-missing' : ''}`;
    row.style.setProperty('--channel-color', channelColors[(channel.channel - 1) % channelColors.length]);
    const dot = document.createElement('span'); dot.className = 'channel-dot';
    const label = document.createElement('span');
    // The index knows the reading; how old it was arrives with the detail.
    label.textContent = `Channel ${channel.channel} / ${waiting ? 'age loading...' : ageLabel(channel.age_ms)}`;
    const value = document.createElement('strong');
    const units = channel.units || combined.units || '';
    value.textContent = channel.value == null ? channel.reading_status : `${numeric(channel.value)} ${units}`.trimEnd();
    row.append(dot, label, value);
    argon.append(row);
  }
}

function renderRunway() {
  const node = el('argon-runway');
  if (!node) return;
  const { hours, ratePerHour, reason } = series().runway;
  if (hours == null) {
    node.textContent = `Argon left: ${reason}.`;
    node.dataset.state = 'muted';
    return;
  }
  const units = series().units;
  node.dataset.state = 'ok';
  const left = hours < 10 ? hours.toFixed(1) : Math.round(hours);
  node.textContent = `Argon left: ~${left} h at ${ratePerHour.toFixed(2)} ${units}/h`.trimEnd();
}

// ---------- scrubber ----------

function renderScrubber() {
  const total = state.layers.length;
  const ratio = window.devicePixelRatio || 1;
  const width = scrubber.clientWidth;
  const height = scrubber.clientHeight;
  if (width <= 0 || height <= 0) return;
  scrubCanvas.width = Math.max(1, Math.round(width * ratio));
  scrubCanvas.height = Math.max(1, Math.round(height * ratio));
  const context = scrubCanvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  scrubber.setAttribute('aria-valuemax', String(Math.max(0, total - 1)));
  if (!total) { positionPlayhead(); return; }

  // One column per device pixel rather than one per layer: a build of thousands
  // has more layers than the strip has columns, and each column is given to the
  // worst layer that falls in it. The reduction is chosen so that a single
  // flagged layer still paints -- losing it in an average is the one outcome
  // this strip may not have.
  const columns = severityColumns(state.layers, Math.max(1, Math.round(width * ratio)));
  const columnWidth = width / columns.length;
  const barWidth = Math.max(1, columnWidth - (columnWidth > 3 ? 1 : 0));
  for (let column = 0; column < columns.length; column += 1) {
    const { token, eligible: measured, quiet } = columns[column];
    context.fillStyle = measured ? (severityColors[token] || '#8b93a1') : '#333a47';
    const barHeight = quiet ? height * 0.42 : height;
    context.fillRect(column * columnWidth, (height - barHeight) / 2, barWidth, barHeight);
  }
  positionPlayhead();
}

/** The parts of the timeline that move with the selection alone. */
function positionPlayhead() {
  const total = state.layers.length;
  const at = selectedIndex();
  timelineCount.textContent = total
    ? `Layer ${state.layers[at]?.index ?? '?'} · ${at + 1} of ${total}`
    : 'no layers';
  scrubber.setAttribute('aria-valuenow', String(total ? at : 0));
  const current = selected();
  scrubber.setAttribute('aria-valuetext', current
    ? `Layer ${current.index}, ${current.analysis.severity || 'unknown'}`
    : 'No layers');
  if (!total) { playhead.hidden = true; return; }
  playhead.hidden = false;
  playhead.style.left = `${((at + 0.5) / total) * 100}%`;
}

function indexFromPointer(clientX) {
  const bounds = scrubber.getBoundingClientRect();
  if (bounds.width <= 0 || !state.layers.length) return 0;
  const fraction = clamp((clientX - bounds.left) / bounds.width, 0, 0.999999);
  return clamp(Math.floor(fraction * state.layers.length), 0, state.layers.length - 1);
}

function showBubble(index, clientX) {
  const layer = state.layers[index];
  if (!layer) { bubble.hidden = true; return; }
  const bounds = scrubber.getBoundingClientRect();
  bubble.hidden = false;
  bubble.textContent = `L${layer.index} · ${shortStamp(layer.captured_at)}`;
  bubble.dataset.severity = severityToken(layer.analysis.severity);
  const offset = clamp(clientX - bounds.left, 28, Math.max(28, bounds.width - 28));
  bubble.style.left = `${offset}px`;
}

let scrubFrame = 0;
let scrubTarget = null;
let lastScrubHapticAt = -Infinity;

function tickScrubber(pointerType) {
  if (pointerType !== 'touch'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    || typeof navigator.vibrate !== 'function') return;
  const now = performance.now();
  if (now - lastScrubHapticAt < SCRUB_HAPTIC_INTERVAL_MS) return;
  lastScrubHapticAt = now;
  // Call it straight from the pointer handler, not a deferred callback: the
  // Vibration API is gated on the page having been activated by a gesture, and
  // a call made inside requestAnimationFrame has tripped that check on some
  // Chrome builds. vibrate() returns false rather than throwing when the
  // platform declines (no motor, battery saver, permission) -- nothing to do
  // about that here, but the try/catch stays for engines that do throw.
  try {
    navigator.vibrate(SCRUB_HAPTIC_MS);
  } catch {
    // Some browsers expose the API but reject vibration in the current context.
  }
}

function scrubTo(index, clientX) {
  scrubTarget = { index, clientX };
  if (scrubFrame) return;
  scrubFrame = requestAnimationFrame(() => {
    scrubFrame = 0;
    const target = scrubTarget;
    if (!target) return;
    const layer = state.layers[target.index];
    showBubble(target.index, target.clientX);
    if (layer && layer.id !== state.selectedId) {
      state.selectedId = layer.id;
      // Only the parts that change per frame; the sidebar and charts follow on
      // release so a fast drag is not re-laying out the whole page each frame.
      // The severity strip is a function of the layers, not of the selection,
      // so the drag moves the playhead over a bitmap that is already drawn.
      renderStage();
      positionPlayhead();
      markSelectedChip();
    }
  });
}

scrubber.addEventListener('pointerdown', event => {
  if (!state.layers.length) return;
  scrubber.setPointerCapture(event.pointerId);
  state.scrubbing = true;
  scrubber.classList.add('is-scrubbing');
  // preventDefault stops the drag selecting text, and takes the focus with it,
  // so the slider is focused explicitly and keeps its arrow-key stepping.
  event.preventDefault();
  scrubber.focus({ preventScroll: true });
  const index = indexFromPointer(event.clientX);
  if (index !== selectedIndex()) tickScrubber(event.pointerType);
  scrubTo(index, event.clientX);
});

scrubber.addEventListener('pointermove', event => {
  if (!state.scrubbing) {
    if (state.layers.length && event.pointerType === 'mouse') showBubble(indexFromPointer(event.clientX), event.clientX);
    return;
  }
  event.preventDefault();
  const index = indexFromPointer(event.clientX);
  // Against the last committed selection, not the pending one: the visual
  // update is throttled to one per frame, but a fast drag still crosses layer
  // boundaries between frames and each one should tick (rate-limited inside).
  if (index !== selectedIndex()) tickScrubber(event.pointerType);
  scrubTo(index, event.clientX);
});

function endScrub(event) {
  if (!state.scrubbing) return;
  state.scrubbing = false;
  scrubber.classList.remove('is-scrubbing');
  if (event && scrubber.hasPointerCapture?.(event.pointerId)) scrubber.releasePointerCapture(event.pointerId);
  bubble.hidden = true;
  const layer = selected();
  if (layer) activateLayer(layer);
}

scrubber.addEventListener('pointerup', endScrub);
scrubber.addEventListener('pointercancel', endScrub);
scrubber.addEventListener('pointerleave', () => { if (!state.scrubbing) bubble.hidden = true; });

// ---------- filmstrip ----------

/**
 * The filmstrip renders a window, not a build.
 *
 * A rail as wide as the whole session gives the scrollbar its true length, and
 * only the chips over the viewport are in the document -- about thirty of them,
 * reused in place as the strip scrolls. Building a chip per layer put 36,000
 * nodes and 4,000 thumbnail decodes on the page for a long build, which is what
 * made loading the earlier batches feel like the tab had stopped.
 *
 * Each chip stays a real focusable option; `aria-setsize` and `aria-posinset`
 * tell assistive technology where it sits in the build, which is how a listbox
 * that renders a window is expected to describe itself.
 */
const CHIP_OVERSCAN = 6;
const chipPool = [];
let chipRail = null;
let scrollFrame = 0;
let renderedFirst = -1;
let renderedCount = 0;
// Where the strip has been told to go but has not arrived yet. A smooth scroll
// takes several frames, and until it lands the scroll position still describes
// where the operator was, not the layer now selected -- so the window covers
// both and the selected chip is never missing from the document.
let targetScrollLeft = null;

function chipMetrics() {
  const styles = getComputedStyle(filmstrip);
  const width = Number.parseFloat(styles.getPropertyValue('--chip-width')) || 116;
  const gap = Number.parseFloat(styles.getPropertyValue('--chip-gap')) || 5;
  return { width, pitch: width + gap };
}

function ensureRail() {
  if (chipRail) return chipRail;
  chipRail = document.createElement('div');
  chipRail.className = 'filmstrip-rail';
  filmstrip.append(chipRail);
  return chipRail;
}

function buildChip() {
  const chip = document.createElement('button');
  chip.className = 'layer-chip';
  chip.type = 'button';
  chip.role = 'option';
  chip.innerHTML = '<img alt="" decoding="async"><div class="chip-missing" hidden>NO KEY VIEW</div>'
    + '<span class="chip-copy"><span><b></b><span class="severity-label"></span></span>'
    + '<span class="chip-meta"><span></span><span></span></span></span>';
  return chip;
}

/** Point an already-built chip at a different layer. No nodes are created. */
function fillChip(chip, layer, position, pitch, total) {
  chip.style.transform = `translateX(${position * pitch}px)`;
  chip.dataset.layerId = String(layer.id);
  chip.dataset.severity = severityToken(layer.analysis.severity);
  chip.ariaSetSize = String(total);
  chip.ariaPosInSet = String(position + 1);
  const isSelected = layer.id === state.selectedId;
  chip.classList.toggle('selected', isSelected);
  chip.ariaSelected = String(isSelected);
  // The index names the chip's image directly -- a published thumbnail where
  // the monitor sent one, otherwise the same view the chip would have chosen.
  // The chip does not wait for the layer's detail to know what to show.
  const preview = layer.preview_url ?? null;
  const image = chip.querySelector('img');
  const missing = chip.querySelector('.chip-missing');
  if (preview) {
    if (image.getAttribute('src') !== preview) image.src = preview;
    image.alt = `Layer ${layer.index} evidence preview`;
    image.hidden = false;
    missing.hidden = true;
  } else {
    image.removeAttribute('src');
    image.hidden = true;
    missing.hidden = false;
  }
  const deficit = typeof layer.analysis.deficit_area_frac === 'number'
    ? `${percent(layer.analysis.deficit_area_frac)} deficit`
    : layer.analysis.status;
  const [title, severityLabel] = chip.querySelectorAll('.chip-copy b, .severity-label');
  title.textContent = `Layer ${layer.index}`;
  severityLabel.textContent = layer.analysis.severity || 'unknown';
  const [stamp, measure] = chip.querySelectorAll('.chip-meta span');
  stamp.textContent = shortStamp(layer.captured_at);
  measure.textContent = deficit || 'unknown';
}

/** The chips on screen, plus the ones a scroll in flight is heading for. */
function chipWindow(total, pitch) {
  const live = visibleWindow(filmstrip.scrollLeft, filmstrip.clientWidth, pitch, total, CHIP_OVERSCAN);
  if (targetScrollLeft === null) return live;
  const target = visibleWindow(targetScrollLeft, filmstrip.clientWidth, pitch, total, CHIP_OVERSCAN);
  if (!live.count || !target.count) return live.count ? live : target;
  const first = Math.min(live.first, target.first);
  const count = Math.max(live.first + live.count, target.first + target.count) - first;
  // A manual scroll during a programmed one could stretch the union across the
  // build; past a few screenfuls the destination is abandoned rather than
  // rendered, since the operator has taken the strip somewhere else.
  if (count > live.count * 4) {
    targetScrollLeft = null;
    return live;
  }
  return { first, count };
}

function renderFilmstrip(force = true) {
  const total = state.layers.length;
  const rail = ensureRail();
  const { width, pitch } = chipMetrics();
  rail.style.width = `${Math.max(0, total * pitch - (pitch - width))}px`;
  const { first, count } = chipWindow(total, pitch);
  if (!force && first === renderedFirst && count === renderedCount) return;
  for (let offset = 0; offset < count; offset += 1) {
    let chip = chipPool[offset];
    if (!chip) {
      chip = buildChip();
      chipPool[offset] = chip;
      rail.append(chip);
    } else if (chip.parentNode !== rail) {
      rail.append(chip);
    }
    fillChip(chip, state.layers[first + offset], first + offset, pitch, total);
  }
  for (let offset = count; offset < chipPool.length; offset += 1) {
    // Left in the pool but out of the document, so the browser can drop the
    // decoded thumbnail behind it rather than holding a build's worth of them.
    chipPool[offset].remove();
    chipPool[offset].querySelector('img').removeAttribute('src');
  }
  renderedFirst = first;
  renderedCount = count;
}

// One listener on the strip instead of one per layer: a chip is identified by
// the layer id it is currently pointed at, and the pool reuses the nodes.
filmstrip.addEventListener('click', event => {
  const chip = event.target.closest?.('.layer-chip');
  if (!chip || !filmstrip.contains(chip)) return;
  const layer = state.layers.find(item => String(item.id) === chip.dataset.layerId);
  if (layer) activateLayer(layer);
});

filmstrip.addEventListener('scroll', () => {
  if (targetScrollLeft !== null && Math.abs(filmstrip.scrollLeft - targetScrollLeft) <= 1) {
    targetScrollLeft = null;
  }
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; renderFilmstrip(false); });
}, { passive: true });

function markSelectedChip() {
  for (const chip of chipPool) {
    if (!chip.parentNode) continue;
    const isSelected = chip.dataset.layerId === String(state.selectedId);
    chip.classList.toggle('selected', isSelected);
    chip.ariaSelected = String(isSelected);
  }
}

function revealLayerChip(layerId, behavior) {
  const index = state.layers.findIndex(layer => layer.id === layerId);
  if (index < 0) return;
  const { width, pitch } = chipMetrics();
  const left = scrollOffsetFor(index, pitch, width, filmstrip.clientWidth, state.layers.length);
  targetScrollLeft = left;
  // Gliding across a build the strip is not rendering would run over blanks,
  // and after a scrubber drag the destination is usually a long way off. Past a
  // screenful the strip jumps, which is what "take me there" means anyway.
  const far = Math.abs(left - filmstrip.scrollLeft) > filmstrip.clientWidth;
  if (behavior === 'auto' || far) filmstrip.scrollLeft = left;
  else filmstrip.scrollTo({ left, behavior });
  // The scroll event settles the window, but a chip revealed without moving the
  // strip -- the selection was already on screen -- would never fire one.
  renderFilmstrip(false);
}

// ---------- stage gestures ----------

const pointers = new Map();
let pinchStart = null;
let swipe = null;
let lastTap = 0;

viewport.addEventListener('pointerdown', event => {
  viewport.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
    swipe = null;
    return;
  }
  swipe = { x: event.clientX, y: event.clientY, axis: null, panX: view.x, panY: view.y };
  if (event.pointerType === 'mouse') return;
  const now = performance.now();
  if (now - lastTap < 300) { toggleZoomAt(event.clientX, event.clientY); lastTap = 0; }
  else lastTap = now;
});

viewport.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size >= 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchStart.distance > 0) {
      event.preventDefault();
      zoomAt(pinchStart.scale * (distance / pinchStart.distance), (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    return;
  }
  if (!swipe) return;
  const deltaX = event.clientX - swipe.x;
  const deltaY = event.clientY - swipe.y;

  if (view.scale > 1.001) {
    event.preventDefault();
    view.x = swipe.panX + deltaX;
    view.y = swipe.panY + deltaY;
    clampPan();
    applyTransform();
    return;
  }
  // Unzoomed, a horizontal drag steps layers and a vertical one is left to the
  // page so the viewer never traps a scroll.
  if (!swipe.axis && Math.hypot(deltaX, deltaY) > 8) {
    swipe.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y';
  }
  if (swipe.axis === 'x') {
    event.preventDefault();
    stage.classList.add('is-swiping');
    stageImage.style.transform = `translate3d(${deltaX * 0.35}px, 0, 0) scale(1)`;
  }
});

function endPointer(event) {
  pointers.delete(event.pointerId);
  if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  if (pointers.size === 1 && pinchStart) {
    const [remaining] = [...pointers.values()];
    swipe = { x: remaining.x, y: remaining.y, axis: null, panX: view.x, panY: view.y };
  }
  if (pointers.size < 2) pinchStart = null;
  if (!swipe) return;
  const deltaX = event.clientX - swipe.x;
  stage.classList.remove('is-swiping');
  if (swipe.axis === 'x' && view.scale <= 1.001) {
    const threshold = Math.max(40, viewport.clientWidth * 0.12);
    if (Math.abs(deltaX) > threshold) stepLayer(deltaX < 0 ? 1 : -1);
    applyTransform();
  }
  swipe = null;
}

viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);

function toggleZoomAt(clientX, clientY) {
  if (view.scale > 1.001) resetZoom();
  else zoomAt(2.5, clientX, clientY);
}

viewport.addEventListener('dblclick', event => { event.preventDefault(); toggleZoomAt(event.clientX, event.clientY); });
viewport.addEventListener('wheel', event => {
  if (!event.ctrlKey && view.scale <= 1.001) return;
  event.preventDefault();
  zoomAt(view.scale * Math.exp(-event.deltaY * 0.0022), event.clientX, event.clientY);
}, { passive: false });
viewport.addEventListener('contextmenu', event => { if (view.scale > 1.001) event.preventDefault(); });

el('zoom-in').addEventListener('click', () => zoomCentre(view.scale * 1.6));
el('zoom-out').addEventListener('click', () => zoomCentre(view.scale / 1.6));
el('zoom-reset').addEventListener('click', resetZoom);

function zoomCentre(nextScale) {
  const bounds = viewport.getBoundingClientRect();
  zoomAt(nextScale, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
}

// ---------- charts ----------

function canvasContext(id) {
  const canvas = document.querySelector(id);
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  return { canvas, context, width, height, ratio };
}

// The plotted series change only when layers arrive; the marker moves with
// every keystroke. Keeping the drawn series on an offscreen copy means moving
// the marker costs one blit rather than replotting a build.
const chartBases = new Map();

function keepChartBase(id, surface) {
  let base = chartBases.get(id);
  if (!base) { base = document.createElement('canvas'); chartBases.set(id, base); }
  base.width = surface.canvas.width;
  base.height = surface.canvas.height;
  if (base.width && base.height) base.getContext('2d').drawImage(surface.canvas, 0, 0);
  drawSelection(surface.context, surface.width, surface.height);
}

function drawChartSelection() {
  for (const id of ['#defect-chart', '#argon-chart']) {
    const base = chartBases.get(id);
    const canvas = document.querySelector(id);
    if (!base || !canvas || !base.width || !base.height) continue;
    const context = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(base, 0, 0);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawSelection(context, canvas.clientWidth, canvas.clientHeight);
  }
}

function grid(context, width, height) {
  context.strokeStyle = '#313846';
  context.lineWidth = 1;
  for (let line = 1; line < 4; line += 1) {
    const y = 12 + ((height - 28) * line / 4);
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function drawSelection(context, width, height) {
  const index = state.layers.findIndex(layer => layer.id === state.selectedId);
  if (index < 0 || state.layers.length < 2) return;
  const x = index * width / (state.layers.length - 1);
  context.strokeStyle = 'rgba(77, 163, 255, .55)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x, 5);
  context.lineTo(x, height - 8);
  context.stroke();
}

function renderDefectChart() {
  const surface = canvasContext('#defect-chart');
  const { context, width, height } = surface;
  grid(context, width, height);
  const { defect, windowSize, eligibleCount } = series();
  const last = defect.at(-1);
  el('defect-rate').textContent = last == null ? '--' : percent(last);
  el('defect-note').textContent = `${eligibleCount}/${state.layers.length} completed eligible layers in this loaded range. Window: ${windowSize} layers.`;
  drawLine(context, defect, width, height, '#4da3ff', value => 1 - value);
  keepChartBase('#defect-chart', surface);
}

function renderArgonChart() {
  const surface = canvasContext('#argon-chart');
  const { context, width, height } = surface;
  grid(context, width, height);
  const byChannel = series().argon;
  const label = el('argon-label');
  const legend = el('argon-legend');
  legend.replaceChildren();
  let low = Infinity;
  let high = -Infinity;
  for (const points of byChannel.values()) {
    for (const value of points) {
      if (value == null) continue;
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }
  if (low === Infinity) { label.textContent = 'unknown'; keepChartBase('#argon-chart', surface); return; }
  const units = series().units;
  label.textContent = `${numeric(low)}-${numeric(high)} ${units}`.trim();
  for (const [channel, points] of byChannel) {
    const color = channelColors[(channel - 1) % channelColors.length];
    const legendItem = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = 'channel-dot';
    dot.style.setProperty('--channel-color', color);
    legendItem.append(dot, `CH ${channel}`);
    legend.append(legendItem);
    drawLine(context, points, width, height, color, value => (high === low ? 0.5 : (high - value) / (high - low)), true);
  }
  keepChartBase('#argon-chart', surface);
}

/**
 * The units the gauges report in, from the first layer that states them.
 *
 * The session index carries them once per layer beside the combined reserve
 * rather than on every channel, so both places are looked at; a chart labelled
 * with a bare number would not say what it is a number of.
 */
function argonUnits() {
  for (const layer of state.layers) {
    for (const channel of layer.argon_snapshot?.channels || []) {
      if (channel.units) return channel.units;
    }
    const combined = layer.argon_snapshot?.combined;
    if (combined?.units) return combined.units;
  }
  return '';
}

/**
 * Plot a per-layer series into the width available.
 *
 * Two things keep this bounded on a long build. The series is first reduced to
 * the chart's own columns, keeping each column's extremes so a single-layer
 * spike still shows. Then each unbroken run is stroked once, rather than once
 * per point: stroking inside the loop re-rasterises the whole path every time,
 * which turned a four-thousand-layer argon chart into half a second of work.
 */
function drawLine(context, points, width, height, color, normalise, stepped = false) {
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.lineJoin = 'round';
  const span = Math.max(1, points.length - 1);
  const samples = decimate(points, Math.max(1, Math.round(width)));
  let open = false;
  let previousY = 0;
  for (const { index, value } of samples) {
    if (value == null) {
      if (open) context.stroke();
      open = false;
      continue;
    }
    const x = points.length === 1 ? width / 2 : index * width / span;
    const y = 12 + normalise(value) * (height - 28);
    if (!open) { context.beginPath(); context.moveTo(x, y); open = true; }
    else if (stepped) { context.lineTo(x, previousY); context.lineTo(x, y); }
    else { context.lineTo(x, y); }
    previousY = y;
  }
  if (open) context.stroke();
}

// ---------- wiring ----------

select.addEventListener('change', () => {
  writeHash();
  loadLayers().then(() => schedulePoll(POLL_MIN_MS)).catch(error => setNotice(error.message, true));
});
followToggle.addEventListener('click', () => setFollow(!state.follow));
fillToggle.addEventListener('click', () => setFill(!state.fill));
gridToggle.addEventListener('click', () => setGrid(!state.grid));
// A link pasted into the open tab should move the viewer, not reload it.
window.addEventListener('hashchange', () => { applyHash().catch(error => setNotice(error.message, true)); });

new ResizeObserver(() => renderScrubber()).observe(scrubber);

window.addEventListener('resize', () => {
  if (state.layers.length) { renderScrubber(); renderFilmstrip(); renderDefectChart(); renderArgonChart(); drawChartSelection(); }
  clampPan();
  applyTransform();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(300); });

window.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLSelectElement) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    stepLayer(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    activateLayer(event.key === 'Home' ? state.layers[0] : state.layers.at(-1));
    return;
  }
  if (event.key === '0') { resetZoom(); return; }
  if (event.key === 'e' || event.key === 'E') { setFill(!state.fill); return; }
  if (event.key === 'g' || event.key === 'G') { setGrid(!state.grid); return; }
  if (event.key === 'f' || event.key === 'F') { setFollow(!state.follow); return; }
  if (/^[1-9]$/.test(event.key)) {
    const media = layerMedia(selected() || { media: [] });
    const item = media[Number(event.key) - 1];
    if (item) { state.selectedMediaRole = item.role; renderSelector(); renderStage(); writeHash(); }
  }
});

setFollow(true);
setFill(false);
setGrid(false);
applyTransform();
// The live loop starts whatever else happened. It is the one thing that can
// recover the page on its own -- a failed first load fixes itself on the next
// tick -- so nothing it does not depend on may prevent it starting.
loadSessions()
  .then(applyHash)
  .catch(error => setNotice(`Could not load remote review: ${error.message}`, true))
  .finally(() => schedulePoll(POLL_MIN_MS));
// New sessions appear without a reload too, just on a lazier clock than layers.
window.setInterval(() => { if (!document.hidden) loadSessions(true).catch(() => {}); }, 60000);
