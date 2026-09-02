const state = {
  sessions: [],
  layers: [],
  selectedId: null,
  selectedMediaRole: null,
  nextBefore: null,
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
const loadEarlier = el('load-earlier');
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
const quietSeverities = new Set(['none', 'clear']);

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
function isFlagged(layer) { return layer.analysis.status === 'completed' && layer.analysis.severity !== 'none'; }
function eligible(layer) { return layer.analysis.status === 'completed'; }
function severityToken(value) { return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-'); }
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
  return added;
}

// ---------- image cache ----------
// Scrubbing swaps the stage image many times a second. Assigning a src that the
// browser has not decoded yet paints a blank frame first, which reads as a
// flicker, so decoded images are kept and only decoded ones are shown at once.

const imageCache = new Map();
const IMAGE_CACHE_LIMIT = 120;

function trimImageCache() {
  // Insertion-ordered, so the oldest entries are the front of the map. The
  // frame on screen is re-inserted by showImage and so is never evicted.
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (oldest === stageImage.dataset.pending) break;
    imageCache.delete(oldest);
  }
}

function cached(url) {
  if (!url) return null;
  let entry = imageCache.get(url);
  if (!entry) {
    const image = new Image();
    entry = { image, ready: false };
    imageCache.set(url, entry);
    image.decoding = 'async';
    image.addEventListener('load', () => {
      entry.ready = true;
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
    const layer = state.layers[index + offset];
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
    for (const layer of state.layers) {
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

const MAX_DEEP_LINK_PAGES = 8;

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

/** Page back until the addressed layer is loaded. A link may point deep into a
 *  build, and the opening window only holds the newest layers. */
async function focusHashLayer(parameters) {
  const run = Number(parameters.get('r'));
  const index = Number(parameters.get('l'));
  if (!parameters.get('r') || !parameters.get('l') || !Number.isFinite(run) || !Number.isFinite(index)) {
    return false;
  }
  for (let page = 0; page < MAX_DEEP_LINK_PAGES; page += 1) {
    const layer = state.layers.find(item => item.run_local_id === run && item.index === index);
    if (layer) {
      setFollow(false);
      activateLayer(layer, false);
      return true;
    }
    if (!state.nextBefore) break;
    await loadLayers(false);
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

function sessionParameters() {
  const chosen = currentSelection();
  if (chosen === null) return null;
  const parameters = new URLSearchParams({ monitor_instance_id: chosen.monitor, limit: '250' });
  if (chosen.session === null) parameters.set('unassigned', 'true');
  else parameters.set('session_id', chosen.session);
  return parameters;
}

// Selecting a session while the previous load is still in flight used to be
// dropped by the in-flight guard: the picker moved, the layers did not, and the
// viewer showed one session's frames under another's name. A reset always
// supersedes, and a superseded response is discarded when it lands.
let loadToken = 0;

async function loadLayers(reset = true) {
  if (!select.value) return;
  if (!reset && state.loading) return;
  const token = ++loadToken;
  state.loading = true;
  try {
    const parameters = sessionParameters();
    if (parameters === null) return;
    if (!reset && state.nextBefore) {
      parameters.set('before_run_local_id', state.nextBefore.run);
      parameters.set('before_layer_index', state.nextBefore.layer);
      parameters.set('before_id', state.nextBefore.id);
    }
    const payload = await api(`/api/v1/layers?${parameters}`);
    if (token !== loadToken) return;
    if (reset) {
      state.layers = [];
      state.stageAspect = null;
      state.selectedMediaRole = null;
      imageCache.clear();
      resetZoom();
    }
    mergeLayers(payload.layers);
    state.nextBefore = payload.next_before ?? null;
    state.latestId = reset
      ? (payload.latest_id || 0)
      : Math.max(state.latestId, payload.latest_id || 0);
    if (reset) {
      state.follow = true;
      state.unseen = 0;
      const last = state.layers.at(-1);
      state.selectedId = last?.id ?? null;
      state.selectedMediaRole = last ? preferredMedia(last)?.role ?? null : null;
    }
    loadEarlier.hidden = state.nextBefore == null;
    applyStageAspect();
    reportCounts();
    render();
    // The address bar is the share affordance, so it carries a usable link from
    // the first load rather than only after the operator touches something.
    writeHash();
    if (state.selectedId != null) requestAnimationFrame(() => revealLayerChip(state.selectedId, 'auto'));
  } finally {
    // A superseded load must not clear the flag out from under the newer one.
    if (token === loadToken) state.loading = false;
  }
}

function reportCounts(extra = '') {
  const completed = state.layers.filter(eligible).length;
  const flagged = state.layers.filter(isFlagged).length;
  const unavailable = state.layers.length - completed;
  const behind = state.unseen && !state.follow
    ? `  ${state.unseen} newer layer${state.unseen === 1 ? '' : 's'} arrived; press End or Live to catch up.`
    : '';
  setNotice(
    `${state.layers.length} loaded / ${completed} completed / ${flagged} flagged / `
    + `${unavailable} unavailable or uncertain.${behind}${extra}`,
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

function render() {
  renderSelector();
  renderStage();
  renderSidebar();
  renderScrubber();
  renderFilmstrip();
  renderDefectChart();
  renderArgonChart();
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
  render();
  revealLayerChip(layer.id, state.scrubbing ? 'auto' : 'smooth');
  writeHash();
}

function stepLayer(offset) {
  const next = state.layers[clamp(selectedIndex() + offset, 0, state.layers.length - 1)];
  if (next && next.id !== state.selectedId) activateLayer(next);
}

function renderSelector() {
  const selector = el('evidence-selector');
  const layer = selected();
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
  const layer = selected();
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
    showImage(null);
    stageEmpty.hidden = false;
    stageEmpty.textContent = 'No review image was published for this result.';
    caption.textContent = 'Raw and diagnostic evidence unavailable.';
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
  const layer = selected();
  const facts = el('layer-facts');
  const title = el('layer-title');
  const argon = el('argon-state');
  const severityBadge = el('layer-severity');
  const reason = el('analysis-reason');
  const combinedLabel = el('argon-combined');
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
  reason.textContent = layer.analysis.reason || 'No processor explanation was published for this layer.';
  const values = [
    ['Captured', new Date(layer.captured_at).toLocaleString()],
    ['Status', layer.analysis.status],
    ['State', layer.analysis.state],
    ['Deficit area', percent(layer.analysis.deficit_area_frac)],
    ['Confidence', numeric(layer.analysis.confidence)],
    ['Processor', layer.run ? `${layer.run.processor} ${layer.run.processor_version}` : 'unknown'],
    ['Rules', layer.run?.rules_version || 'unknown'],
    ['Profile', layer.run?.profile_name || 'unknown'],
    // Which build published this layer. Two monitors feeding the same reviewer
    // are otherwise indistinguishable, and a stale one shows up only as fewer
    // views than expected -- which reads as a fault in this page rather than in
    // the machine that sent the bundle.
    ['Monitor build', layer.monitor_software_version || 'unknown'],
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
    const label = document.createElement('span'); label.textContent = `Channel ${channel.channel} / ${ageLabel(channel.age_ms)}`;
    const value = document.createElement('strong');
    value.textContent = channel.value == null ? channel.reading_status : `${numeric(channel.value)} ${channel.units || ''}`;
    row.append(dot, label, value);
    argon.append(row);
  }
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

  const at = selectedIndex();
  timelineCount.textContent = total
    ? `Layer ${state.layers[at]?.index ?? '?'} · ${at + 1} of ${total}`
    : 'no layers';
  scrubber.setAttribute('aria-valuemax', String(Math.max(0, total - 1)));
  scrubber.setAttribute('aria-valuenow', String(total ? selectedIndex() : 0));
  const current = selected();
  scrubber.setAttribute('aria-valuetext', current
    ? `Layer ${current.index}, ${current.analysis.severity || 'unknown'}`
    : 'No layers');
  if (!total) { playhead.hidden = true; return; }

  // One column per layer, widened to stay visible when a session outruns the
  // pixel budget. Severity is the only thing the strip encodes.
  const columnWidth = Math.max(1, width / total);
  const barWidth = Math.max(1, columnWidth - (columnWidth > 3 ? 1 : 0));
  for (let index = 0; index < total; index += 1) {
    const layer = state.layers[index];
    const token = severityToken(layer.analysis.severity);
    const quiet = !eligible(layer) || quietSeverities.has(token);
    context.fillStyle = eligible(layer) ? (severityColors[token] || '#8b93a1') : '#333a47';
    const barHeight = quiet ? height * 0.42 : height;
    context.fillRect(x0(index), (height - barHeight) / 2, barWidth, barHeight);
  }

  function x0(index) { return index * width / total; }
  playhead.hidden = false;
  playhead.style.left = `${((selectedIndex() + 0.5) / total) * 100}%`;
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
      renderStage();
      renderScrubber();
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
  scrubTo(indexFromPointer(event.clientX), event.clientX);
});

scrubber.addEventListener('pointermove', event => {
  if (!state.scrubbing) {
    if (state.layers.length && event.pointerType === 'mouse') showBubble(indexFromPointer(event.clientX), event.clientX);
    return;
  }
  event.preventDefault();
  scrubTo(indexFromPointer(event.clientX), event.clientX);
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

function renderFilmstrip() {
  const scrollLeft = filmstrip.scrollLeft;
  filmstrip.replaceChildren();
  for (const layer of state.layers) {
    const chip = document.createElement('button');
    chip.className = `layer-chip ${layer.id === state.selectedId ? 'selected' : ''}`;
    chip.dataset.layerId = String(layer.id);
    chip.dataset.severity = severityToken(layer.analysis.severity);
    chip.type = 'button';
    chip.role = 'option';
    chip.ariaSelected = String(layer.id === state.selectedId);
    const preview = preferredMedia(layer);
    chip.innerHTML = preview
      ? `<img loading="lazy" src="${escaped(preview.url)}" alt="Layer ${layer.index} evidence preview">`
      : '<div class="chip-missing">NO KEY VIEW</div>';
    const deficit = typeof layer.analysis.deficit_area_frac === 'number'
      ? `${percent(layer.analysis.deficit_area_frac)} deficit`
      : layer.analysis.status;
    chip.insertAdjacentHTML('beforeend', `<span class="chip-copy">`
      + `<span><b>Layer ${layer.index}</b>`
      + `<span class="severity-label">${escaped(layer.analysis.severity || 'unknown')}</span></span>`
      + `<span class="chip-meta"><span>${escaped(shortStamp(layer.captured_at))}</span>`
      + `<span>${escaped(deficit || 'unknown')}</span></span></span>`);
    chip.addEventListener('click', () => activateLayer(layer));
    filmstrip.append(chip);
  }
  filmstrip.scrollLeft = scrollLeft;
}

function markSelectedChip() {
  for (const chip of filmstrip.children) {
    const isSelected = chip.dataset.layerId === String(state.selectedId);
    chip.classList.toggle('selected', isSelected);
    chip.ariaSelected = String(isSelected);
  }
}

function revealLayerChip(layerId, behavior) {
  const chip = filmstrip.querySelector(`[data-layer-id="${layerId}"]`);
  if (!chip) return;
  const chipBounds = chip.getBoundingClientRect();
  const stripBounds = filmstrip.getBoundingClientRect();
  const left = filmstrip.scrollLeft + chipBounds.left - stripBounds.left
    - (filmstrip.clientWidth - chipBounds.width) / 2;
  if (behavior === 'auto') filmstrip.scrollLeft = Math.max(0, left);
  else filmstrip.scrollTo({ left: Math.max(0, left), behavior });
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
  return { context, width, height };
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
  const { context, width, height } = canvasContext('#defect-chart');
  grid(context, width, height);
  const windowSize = Math.min(40, Math.max(1, state.layers.length));
  const points = state.layers.map((layer, index) => {
    const windowLayers = state.layers.slice(Math.max(0, index - windowSize + 1), index + 1).filter(eligible);
    return windowLayers.length ? windowLayers.filter(isFlagged).length / windowLayers.length : null;
  });
  const eligibleCount = state.layers.filter(eligible).length;
  const last = points.at(-1);
  el('defect-rate').textContent = last == null ? '--' : percent(last);
  el('defect-note').textContent = `${eligibleCount}/${state.layers.length} completed eligible layers in this loaded range. Window: ${windowSize} layers.`;
  drawLine(context, points, width, height, '#4da3ff', value => 1 - value);
  drawSelection(context, width, height);
}

function renderArgonChart() {
  const { context, width, height } = canvasContext('#argon-chart');
  grid(context, width, height);
  const byChannel = new Map();
  state.layers.forEach((layer, layerIndex) => {
    const current = new Map((layer.argon_snapshot.channels || []).map(channel => [channel.channel, channel]));
    for (const [channel, points] of byChannel) {
      const reading = current.get(channel);
      points.push(reading?.reading_status === 'ok' && typeof reading.value === 'number' ? reading.value : null);
    }
    for (const [channel, reading] of current) {
      if (byChannel.has(channel)) continue;
      byChannel.set(channel, [
        ...Array(layerIndex).fill(null),
        reading.reading_status === 'ok' && typeof reading.value === 'number' ? reading.value : null,
      ]);
    }
  });
  const values = [...byChannel.values()].flat().filter(value => value != null);
  const label = el('argon-label');
  const legend = el('argon-legend');
  legend.replaceChildren();
  if (!values.length) { label.textContent = 'unknown'; return; }
  const low = Math.min(...values);
  const high = Math.max(...values);
  const units = state.layers.flatMap(layer => layer.argon_snapshot.channels || []).find(channel => channel.units)?.units || '';
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
  drawSelection(context, width, height);
}

function drawLine(context, points, width, height, color, normalise, stepped = false) {
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.lineJoin = 'round';
  let open = false;
  let previousY = 0;
  points.forEach((value, index) => {
    if (value == null) { open = false; return; }
    const x = points.length === 1 ? width / 2 : index * width / (points.length - 1);
    const y = 12 + normalise(value) * (height - 28);
    if (!open) { context.beginPath(); context.moveTo(x, y); open = true; }
    else if (stepped) { context.lineTo(x, previousY); context.lineTo(x, y); }
    else { context.lineTo(x, y); }
    context.stroke();
    previousY = y;
  });
}

// ---------- wiring ----------

select.addEventListener('change', () => {
  writeHash();
  loadLayers().then(() => schedulePoll(POLL_MIN_MS)).catch(error => setNotice(error.message, true));
});
loadEarlier.addEventListener('click', () => loadLayers(false).catch(error => setNotice(error.message, true)));
followToggle.addEventListener('click', () => setFollow(!state.follow));
fillToggle.addEventListener('click', () => setFill(!state.fill));
gridToggle.addEventListener('click', () => setGrid(!state.grid));
// A link pasted into the open tab should move the viewer, not reload it.
window.addEventListener('hashchange', () => { applyHash().catch(error => setNotice(error.message, true)); });

new ResizeObserver(() => renderScrubber()).observe(scrubber);

window.addEventListener('resize', () => { if (state.layers.length) { renderScrubber(); renderDefectChart(); renderArgonChart(); } clampPan(); applyTransform(); });

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
loadSessions()
  .then(applyHash)
  .then(() => schedulePoll(POLL_MIN_MS))
  .catch(error => setNotice(`Could not load remote review: ${error.message}`, true));
// New sessions appear without a reload too, just on a lazier clock than layers.
window.setInterval(() => { if (!document.hidden) loadSessions(true).catch(() => {}); }, 60000);
