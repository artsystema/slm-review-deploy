import { nextPending, reviewable } from './review-queue-core.js?v=20261003';

const el = id => document.getElementById(id);
const state = {
  sessions: [], layers: [], reviews: new Map(), session: null, selectedId: null,
  detail: null, history: [], latestId: 0, visibleCount: 80, loadToken: 0,
  busy: false, pendingSubmission: null, polling: false,
};
const basePath = location.pathname.replace(/\/review\/?$/, '').replace(/\/$/, '');
const sessionSelect = el('session-select');
const filterSelect = el('filter-select');
const search = el('layer-search');
const list = el('layer-list');
const notice = el('notice');
let reviewToken = '';

function lock() {
  reviewToken = '';
  state.loadToken += 1;
  state.sessions = [];
  state.layers = [];
  state.reviews.clear();
  state.selectedId = null;
  state.detail = null;
  state.history = [];
  state.session = null;
  el('unlock-form').hidden = false;
  el('queue-panel').hidden = true;
  el('lock-button').hidden = true;
  el('review-form').hidden = true;
  el('viewer-link').hidden = true;
  sessionSelect.replaceChildren(new Option('Unlock to load', ''));
  renderSelected();
}

function message(text, error = false) {
  notice.textContent = text;
  notice.classList.toggle('error', error);
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  if (path.startsWith('/api/v1/reviews')) {
    headers['X-SLM-Review-Authorization'] = `Bearer ${reviewToken}`;
  }
  const response = await fetch(`${basePath}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (path.startsWith('/api/v1/reviews') && [401, 403].includes(response.status)) lock();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function sessionKey(value) {
  return JSON.stringify({ monitor: value.monitor_instance_id, session: value.session_local_id });
}

function scope() {
  if (!state.session) return null;
  const query = new URLSearchParams({ monitor_instance_id: state.session.monitor_instance_id });
  if (state.session.session_local_id === null) query.set('unassigned', 'true');
  else query.set('session_id', String(state.session.session_local_id));
  return query;
}

function hashTarget() {
  const values = new URLSearchParams(location.hash.slice(1));
  return {
    monitor: values.get('m'), session: values.get('s'),
    run: Number(values.get('r')), layer: Number(values.get('l')),
  };
}

function writeHash(layer) {
  if (!state.session) return;
  const hash = new URLSearchParams({ m: state.session.monitor_instance_id });
  hash.set('s', state.session.session_local_id === null ? 'unassigned' : String(state.session.session_local_id));
  if (layer) {
    hash.set('r', String(layer.run_local_id));
    hash.set('l', String(layer.index));
  }
  history.replaceState(null, '', `${location.pathname}#${hash}`);
  const viewer = new URL(`${basePath || ''}/`, location.origin);
  viewer.hash = hash.toString();
  el('viewer-link').href = viewer.href;
  el('viewer-link').hidden = !layer;
}

function formatTime(value) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function selectedLayer() {
  return state.layers.find(layer => layer.id === state.selectedId) || null;
}

function statusText(layer) {
  const review = state.reviews.get(layer.id);
  if (review?.decision === 'approve') return 'Approved';
  if (review?.decision === 'reject') return 'Rejected';
  return 'Awaiting review';
}

function renderList() {
  const visible = reviewable(state.layers, state.reviews, filterSelect.value, search.value);
  const pending = state.layers.filter(layer => !state.reviews.has(layer.id)).length;
  el('queue-count').textContent = `${pending} awaiting review · ${state.layers.length} published · ${visible.length} shown by filter`;
  list.replaceChildren();
  for (const layer of visible.slice(0, state.visibleCount)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layer-row';
    button.dataset.severity = layer.analysis?.severity || 'unknown';
    button.classList.toggle('selected', layer.id === state.selectedId);
    button.setAttribute('role', 'listitem');
    button.setAttribute('aria-current', String(layer.id === state.selectedId));
    const heading = document.createElement('strong');
    heading.textContent = `Layer ${layer.index}`;
    const meta = document.createElement('span');
    meta.textContent = `Run ${layer.run_local_id} · CV ${layer.analysis?.status || 'unknown'} / ${layer.analysis?.severity || 'unknown'} · ${statusText(layer)}`;
    button.append(heading, meta);
    button.addEventListener('click', () => selectLayer(layer));
    list.append(button);
  }
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = state.layers.length ? 'No layers match this filter.' : 'No published layers in this session.';
    list.append(empty);
  }
  el('show-more').hidden = visible.length <= state.visibleCount;
}

function imageCard(role, label, media) {
  const card = document.createElement('figure');
  card.className = 'image-card';
  const title = document.createElement('figcaption');
  title.textContent = label;
  card.append(title);
  if (!media) {
    const missing = document.createElement('div');
    missing.className = 'image-missing';
    missing.textContent = 'Not published';
    card.append(missing);
    return card;
  }
  const url = new URL(media.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith(`${basePath}/api/v1/media/`)) {
    const bad = document.createElement('div');
    bad.className = 'image-missing';
    bad.textContent = 'Invalid media URL';
    card.append(bad);
    return card;
  }
  const anchor = document.createElement('a');
  anchor.href = url.href;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  anchor.title = `Open ${label.toLowerCase()} at full size`;
  const image = document.createElement('img');
  image.src = url.href;
  image.alt = `${label} for selected layer`;
  image.loading = role === 'raw_before' ? 'eager' : 'lazy';
  image.addEventListener('error', () => {
    anchor.replaceWith(Object.assign(document.createElement('div'), {
      className: 'image-missing', textContent: 'Image unavailable',
    }));
    message('A published image could not be loaded. Check the evidence before deciding.', true);
    el('approve-button').disabled = true;
    el('reject-button').disabled = true;
  });
  anchor.append(image);
  card.append(anchor);
  return card;
}

function renderHistory() {
  const details = el('history-details');
  details.hidden = !state.history.length;
  const list = el('review-history');
  list.replaceChildren();
  for (const review of state.history) {
    const item = document.createElement('li');
    item.textContent = `${review.decision === 'approve' ? 'Approved' : 'Rejected'} by ${review.reviewer} · ${formatTime(review.created_at)}${review.note ? ` · ${review.note}` : ''}`;
    list.append(item);
  }
}

function renderSelected() {
  const layer = selectedLayer();
  const detail = state.detail?.id === layer?.id ? state.detail : null;
  el('layer-title').textContent = layer ? `Layer ${layer.index} · Run ${layer.run_local_id}` : 'Select a layer';
  el('layer-time').textContent = layer ? `Captured ${formatTime(layer.captured_at)}` : '';
  const severity = layer?.analysis?.severity || 'unknown';
  el('cv-severity').textContent = severity;
  el('cv-severity').dataset.severity = severity;
  el('cv-reason').textContent = detail?.analysis?.reason || (layer ? 'Loading CV explanation…' : 'Choose a layer from the list.');
  el('cv-meta').textContent = detail ? `CV ${detail.analysis?.status || 'unknown'} · ${detail.run?.processor || 'processor unknown'} ${detail.run?.processor_version || ''}` : '';
  const media = new Map((detail?.media || []).map(item => [item.role, item]));
  if (layer && !detail) {
    const loading = document.createElement('p');
    loading.className = 'empty-list';
    loading.textContent = 'Loading this layer’s evidence…';
    el('image-grid').replaceChildren(loading);
  } else {
    el('image-grid').replaceChildren(
      imageCard('raw_before', 'Before recoat', media.get('raw_before')),
      imageCard('raw_after', 'After recoat', media.get('raw_after')),
      imageCard('diagnostic_overlay', 'CV analysis', media.get('diagnostic_overlay') || media.get('key_view')),
    );
  }
  const current = layer ? state.reviews.get(layer.id) : null;
  el('current-review').textContent = current
    ? `${current.decision === 'approve' ? 'Approved' : 'Rejected'} by ${current.reviewer} · ${formatTime(current.created_at)}`
    : 'Awaiting review';
  el('review-form').hidden = !detail;
  const canDecide = Boolean(detail && detail.media?.some(item => ['raw_before', 'raw_after', 'diagnostic_overlay', 'key_view'].includes(item.role))) && !state.busy;
  el('approve-button').disabled = !canDecide;
  el('reject-button').disabled = !canDecide;
  renderHistory();
}

async function selectLayer(layer) {
  if (!layer || state.busy) return;
  const token = ++state.loadToken;
  state.selectedId = layer.id;
  state.detail = null;
  state.history = [];
  el('review-note').value = '';
  el('save-status').textContent = '';
  writeHash(layer);
  renderList();
  renderSelected();
  message(`Loading layer ${layer.index} evidence…`);
  try {
    const query = scope();
    query.set('ids', String(layer.id));
    const [data, history] = await Promise.all([
      api(`/api/v1/layers?${query}`),
      api(`/api/v1/reviews/${layer.id}`),
    ]);
    if (token !== state.loadToken) return;
    state.detail = data.layers?.[0] || null;
    state.history = history.reviews || [];
    if (!state.detail) throw new Error('Layer detail was not published in this session');
    renderSelected();
    const hasImage = state.detail.media?.some(item => ['raw_before', 'raw_after', 'diagnostic_overlay', 'key_view'].includes(item.role));
    message(hasImage
      ? `Layer ${layer.index} ready. Compare before, after, and CV analysis.`
      : `Layer ${layer.index} has no review image; a decision cannot be saved.`, !hasImage);
  } catch (error) {
    if (token !== state.loadToken) return;
    renderSelected();
    message(`Could not load layer ${layer.index}: ${error.message}`, true);
  }
}

async function loadSession() {
  const value = sessionSelect.value;
  state.session = state.sessions.find(item => sessionKey(item) === value) || null;
  if (!state.session) return;
  const token = ++state.loadToken;
  state.layers = [];
  state.reviews.clear();
  state.selectedId = null;
  state.detail = null;
  state.history = [];
  state.visibleCount = 80;
  renderList();
  renderSelected();
  message('Loading published layers and decisions…');
  try {
    const query = scope();
    const [index, reviews] = await Promise.all([
      api(`/api/v1/layers/index?${query}`),
      api(`/api/v1/reviews?${query}`),
    ]);
    if (token !== state.loadToken) return;
    state.layers = index.layers || [];
    state.latestId = index.latest_id || 0;
    state.session.session_state = index.session?.state || state.session.session_state;
    state.reviews = new Map((reviews.reviews || []).map(item => [item.publication_id, item]));
    el('unlock-form').hidden = true;
    el('queue-panel').hidden = false;
    el('lock-button').hidden = false;
    renderList();
    const target = hashTarget();
    const linked = target.monitor === state.session.monitor_instance_id
      && target.session === String(state.session.session_local_id ?? 'unassigned')
      ? state.layers.find(item => item.run_local_id === target.run && item.index === target.layer)
      : null;
    const first = linked || reviewable(state.layers, state.reviews, filterSelect.value, search.value)[0] || state.layers.at(-1);
    writeHash(first);
    if (first) await selectLayer(first);
    else message('This session has no published layers.');
    if (index.truncated) message('The session index was truncated; older layers are not shown.', true);
  } catch (error) {
    if (token === state.loadToken || !reviewToken) {
      message(`Could not load session: ${error.message}`, true);
    }
  }
}

function newKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function decide(decision) {
  const layer = selectedLayer();
  if (!layer || state.busy || !state.detail) return;
  const current = state.reviews.get(layer.id);
  const payload = {
    publication_id: layer.id, decision,
    note: el('review-note').value.trim(),
    expected_review_id: current?.id ?? null,
  };
  if (new TextEncoder().encode(payload.note).length > 1000) {
    el('save-status').textContent = 'Observation is too long (1000 UTF-8 bytes maximum).';
    return;
  }
  const signature = JSON.stringify(payload);
  if (state.pendingSubmission?.signature !== signature) {
    state.pendingSubmission = { signature, key: newKey() };
  }
  payload.idempotency_key = state.pendingSubmission.key;
  state.busy = true;
  renderSelected();
  el('save-status').textContent = 'Saving decision…';
  try {
    const result = await api('/api/v1/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SLM-Review-Action': '1' },
      body: JSON.stringify(payload),
    });
    state.reviews.set(layer.id, result.review);
    state.history.unshift(result.review);
    state.pendingSubmission = null;
    state.busy = false;
    renderList();
    renderSelected();
    el('save-status').textContent = `${decision === 'approve' ? 'Approved' : 'Rejected'} and saved.`;
    if (el('advance-toggle').checked) {
      const next = nextPending(state.layers, state.reviews, layer.id);
      if (next) {
        filterSelect.value = 'pending';
        await selectLayer(next);
      }
      else message('All published layers in this session have a decision.');
    }
  } catch (error) {
    state.busy = false;
    renderSelected();
    el('save-status').textContent = `Decision was not confirmed: ${error.message}`;
    message(`Save failed: ${error.message}`, true);
    if (error.message.includes('review changed')) {
      try {
        const query = scope();
        const [reviews, history] = await Promise.all([
          api(`/api/v1/reviews?${query}`), api(`/api/v1/reviews/${layer.id}`),
        ]);
        state.reviews = new Map(reviews.reviews.map(item => [item.publication_id, item]));
        state.history = history.reviews;
        renderList();
        renderSelected();
      } catch (reloadError) {
        message(`Could not refresh changed review: ${reloadError.message}`, true);
      }
    }
  }
}

async function pollActive() {
  if (state.polling || !state.session || state.session.session_state !== 'active' || document.hidden) return;
  state.polling = true;
  try {
    const query = scope();
    query.set('since_id', String(state.latestId));
    query.set('limit', '100');
    const update = await api(`/api/v1/layers?${query}`);
    if (update.session?.state) state.session.session_state = update.session.state;
    state.latestId = update.latest_id || state.latestId;
    if (update.layers?.length) {
      const byId = new Map(state.layers.map(layer => [layer.id, layer]));
      for (const layer of update.layers) byId.set(layer.id, layer);
      state.layers = [...byId.values()];
      renderList();
      if (update.more) setTimeout(pollActive, 250);
    }
  } catch (error) {
    message(`Live update failed: ${error.message}. Retrying.`, true);
  } finally {
    state.polling = false;
  }
}

async function start() {
  if (!reviewToken) return;
  try {
    const data = await api('/api/v1/sessions?limit=100');
    state.sessions = data.sessions || [];
    sessionSelect.replaceChildren();
    if (!state.sessions.length) {
      sessionSelect.append(new Option('No published sessions', ''));
      message('No published sessions are available.');
      return;
    }
    for (const session of state.sessions) {
      sessionSelect.append(new Option(
        `${session.session_name || 'Unassigned'} · ${session.layer_count} layers · ${session.session_state}`,
        sessionKey(session),
      ));
    }
    const target = hashTarget();
    const deepSession = state.sessions.find(item => item.monitor_instance_id === target.monitor
      && String(item.session_local_id ?? 'unassigned') === target.session);
    if (deepSession) sessionSelect.value = sessionKey(deepSession);
    await loadSession();
  } catch (error) {
    message(`Could not load remote review: ${error.message}`, true);
  }
}

el('unlock-form').addEventListener('submit', event => {
  event.preventDefault();
  reviewToken = el('review-token').value;
  el('review-token').value = '';
  start();
});
el('lock-button').addEventListener('click', () => { lock(); message('Review decisions are locked.'); });
sessionSelect.addEventListener('change', () => { filterSelect.value = 'pending'; search.value = ''; loadSession(); });
el('refresh-button').addEventListener('click', loadSession);
filterSelect.addEventListener('change', () => { state.visibleCount = 80; renderList(); });
search.addEventListener('input', () => { state.visibleCount = 80; renderList(); });
el('show-more').addEventListener('click', () => { state.visibleCount += 80; renderList(); });
el('approve-button').addEventListener('click', () => decide('approve'));
el('reject-button').addEventListener('click', () => decide('reject'));
setInterval(pollActive, 30000);
message('Enter the private review token to load decisions.');
