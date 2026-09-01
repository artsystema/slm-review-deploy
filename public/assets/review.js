const state = { sessions: [], layers: [], selectedId: null, selectedMediaRole: null, nextBeforeId: null, loading: false };
const select = document.querySelector('#session-select');
const notice = document.querySelector('#notice');
const filmstrip = document.querySelector('#filmstrip');
const loadEarlier = document.querySelector('#load-earlier');
const basePath = window.location.pathname.replace(/\/$/, '');
const mediaOrder = ['diagnostic_overlay', 'raw_after', 'raw_before', 'key_view'];
const channelColors = ['#4fc3c8', '#e0a63a', '#b57af2', '#ef718a'];
const mediaLabels = {
  diagnostic_overlay: 'Analysis',
  raw_after: 'Raw after',
  raw_before: 'Raw before',
  key_view: 'Analysis',
};

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

function selected() { return state.layers.find(layer => layer.id === state.selectedId) || state.layers.at(-1); }
function escaped(value) { const element = document.createElement('span'); element.textContent = String(value); return element.innerHTML; }
function isFlagged(layer) { return layer.analysis.status === 'completed' && layer.analysis.severity !== 'none'; }
function eligible(layer) { return layer.analysis.status === 'completed'; }
function severityToken(value) { return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-'); }
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
  if (media.length) return media;
  return layer.key_view_url ? [{ role: 'key_view', stage: null, url: layer.key_view_url }] : [];
}
function preferredMedia(layer) {
  const media = layerMedia(layer);
  return mediaOrder.map(role => media.find(item => item.role === role)).find(Boolean) || media[0] || null;
}

async function loadSessions() {
  const payload = await api('/api/v1/sessions?limit=100');
  state.sessions = payload.sessions;
  select.replaceChildren();
  if (!state.sessions.length) {
    select.append(new Option('No committed sessions', ''));
    setNotice('No committed bundles yet. The sync agent may be offline or its queue is empty.');
    return;
  }
  for (const session of state.sessions) {
    const value = JSON.stringify({ monitor: session.monitor_instance_id, session: session.session_local_id });
    const title = session.session_name || `Unassigned monitor stream`;
    select.append(new Option(`${title} / ${session.layer_count} layers`, value));
  }
  await loadLayers();
}

async function loadLayers(reset = true) {
  if (!select.value) return;
  if (state.loading) return;
  state.loading = true;
  try {
    const chosen = JSON.parse(select.value);
    const parameters = new URLSearchParams({ monitor_instance_id: chosen.monitor, limit: '250' });
    if (chosen.session === null) parameters.set('unassigned', 'true'); else parameters.set('session_id', chosen.session);
    if (!reset && state.nextBeforeId) parameters.set('before_id', state.nextBeforeId);
    const payload = await api(`/api/v1/layers?${parameters}`);
    state.layers = reset ? payload.layers : [...payload.layers, ...state.layers];
    state.nextBeforeId = payload.next_before_id;
    if (reset) {
      state.selectedId = state.layers.at(-1)?.id ?? null;
      state.selectedMediaRole = state.layers.length ? preferredMedia(selected())?.role ?? null : null;
    }
    loadEarlier.hidden = state.nextBeforeId == null;
    const completed = state.layers.filter(eligible).length;
    const flagged = state.layers.filter(isFlagged).length;
    const unavailable = state.layers.length - completed;
    setNotice(`${state.layers.length} loaded / ${completed} completed / ${flagged} flagged / ${unavailable} unavailable or uncertain.`);
    render();
    if (reset && state.selectedId != null) {
      requestAnimationFrame(() => revealLayerChip(state.selectedId, 'auto'));
    }
  } finally {
    state.loading = false;
  }
}

function render() { renderFilmstrip(); renderSelected(); renderDefectChart(); renderArgonChart(); }

function renderFilmstrip() {
  filmstrip.replaceChildren();
  for (const layer of state.layers) {
    const chip = document.createElement('button');
    const severity = severityToken(layer.analysis.severity);
    chip.className = `layer-chip ${layer.id === state.selectedId ? 'selected' : ''}`;
    chip.dataset.layerId = String(layer.id);
    chip.dataset.severity = severity;
    chip.type = 'button'; chip.role = 'option'; chip.ariaSelected = String(layer.id === state.selectedId);
    const preview = preferredMedia(layer);
    chip.innerHTML = preview
      ? `<img loading="lazy" src="${escaped(preview.url)}" alt="Layer ${layer.index} evidence preview">`
      : '<div class="chip-missing">NO KEY VIEW</div>';
    const deficit = typeof layer.analysis.deficit_area_frac === 'number'
      ? `${percent(layer.analysis.deficit_area_frac)} deficit`
      : layer.analysis.status;
    chip.insertAdjacentHTML('beforeend', `<span class="chip-copy"><span><b>Layer ${layer.index}</b><span class="severity-label">${escaped(layer.analysis.severity || 'unknown')}</span></span><span class="chip-meta">${escaped(shortStamp(layer.captured_at))} / ${escaped(deficit || 'unknown')}</span></span>`);
    chip.addEventListener('click', () => {
      activateLayer(layer);
    });
    filmstrip.append(chip);
  }
}

function activateLayer(layer) {
  state.selectedId = layer.id;
  state.selectedMediaRole = preferredMedia(layer)?.role ?? null;
  render();
  revealLayerChip(layer.id, 'smooth');
}

function revealLayerChip(layerId, behavior) {
  const chip = filmstrip.querySelector(`[data-layer-id="${layerId}"]`);
  if (!chip) return;
  const chipBounds = chip.getBoundingClientRect();
  const stripBounds = filmstrip.getBoundingClientRect();
  const left = filmstrip.scrollLeft + chipBounds.left - stripBounds.left
    - (filmstrip.clientWidth - chipBounds.width) / 2;
  if (behavior === 'auto') {
    filmstrip.scrollLeft = Math.max(0, left);
  } else {
    filmstrip.scrollTo({ left: Math.max(0, left), behavior });
  }
}

function renderSelected() {
  const layer = selected();
  const wrap = document.querySelector('#image-wrap'); const facts = document.querySelector('#layer-facts');
  const title = document.querySelector('#layer-title'); const argon = document.querySelector('#argon-state');
  const selector = document.querySelector('#evidence-selector'); const caption = document.querySelector('#frame-caption');
  const severityBadge = document.querySelector('#layer-severity'); const reason = document.querySelector('#analysis-reason');
  const combinedLabel = document.querySelector('#argon-combined');
  if (!layer) {
    wrap.innerHTML = '<p>No layer data.</p>'; selector.replaceChildren(); caption.textContent = 'No evidence selected.';
    facts.innerHTML = ''; title.textContent = 'No layer'; argon.textContent = 'Argon context unavailable.';
    severityBadge.textContent = 'unknown'; severityBadge.className = 'severity-badge severity-unknown';
    reason.textContent = 'Select a committed layer to inspect its result.'; combinedLabel.textContent = '--'; return;
  }
  title.textContent = `Layer ${layer.index}`;
  const severity = severityToken(layer.analysis.severity);
  severityBadge.textContent = layer.analysis.severity || 'unknown';
  severityBadge.className = `severity-badge severity-${severity}`;
  reason.textContent = layer.analysis.reason || 'No processor explanation was published for this layer.';
  const media = layerMedia(layer).sort((left, right) => mediaOrder.indexOf(left.role) - mediaOrder.indexOf(right.role));
  const current = media.find(item => item.role === state.selectedMediaRole) || preferredMedia(layer);
  state.selectedMediaRole = current?.role ?? null;
  selector.replaceChildren();
  for (const item of media) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = item.role === state.selectedMediaRole ? 'selected' : '';
    button.setAttribute('aria-pressed', String(item.role === state.selectedMediaRole));
    button.textContent = mediaLabels[item.role] || item.role;
    button.addEventListener('click', () => { state.selectedMediaRole = item.role; renderSelected(); });
    selector.append(button);
  }
  wrap.replaceChildren();
  if (current) {
    const image = document.createElement('img');
    image.src = current.url;
    image.alt = `Layer ${layer.index} ${mediaLabels[current.role] || current.role}`;
    wrap.append(image);
    const dimensions = current.width && current.height ? `${current.width} x ${current.height}` : 'dimensions unavailable';
    caption.textContent = `${mediaLabels[current.role] || current.role} / ${dimensions}${current.stage ? ` / ${current.stage}` : ''}`;
  } else {
    wrap.innerHTML = '<p>No review image was published for this result.</p>';
    caption.textContent = 'Raw and diagnostic evidence unavailable.';
  }
  const values = [
    ['Captured', new Date(layer.captured_at).toLocaleString()],
    ['Status', layer.analysis.status],
    ['State', layer.analysis.state],
    ['Deficit area', percent(layer.analysis.deficit_area_frac)],
    ['Confidence', numeric(layer.analysis.confidence)],
    ['Processor', layer.run ? `${layer.run.processor} ${layer.run.processor_version}` : 'unknown'],
    ['Rules', layer.run?.rules_version || 'unknown'],
    ['Profile', layer.run?.profile_name || 'unknown'],
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
  } else {
    for (const channel of channels) {
      const row = document.createElement('div');
      row.className = `argon-row ${channel.value == null ? 'is-missing' : ''}`;
      row.style.setProperty('--channel-color', channelColors[(channel.channel - 1) % channelColors.length]);
      const dot = document.createElement('span'); dot.className = 'channel-dot';
      const label = document.createElement('span'); label.textContent = `Channel ${channel.channel} / ${ageLabel(channel.age_ms)}`;
      const value = document.createElement('strong');
      value.textContent = channel.value == null ? channel.reading_status : `${numeric(channel.value)} ${channel.units || ''}`;
      row.append(dot, label, value); argon.append(row);
    }
  }
}

function numeric(value) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'unknown'; }
function percent(value) { return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'unknown'; }

function canvasContext(id) { const canvas = document.querySelector(id); const ratio = window.devicePixelRatio || 1; const width = canvas.clientWidth; const height = canvas.clientHeight; canvas.width = width * ratio; canvas.height = height * ratio; const context = canvas.getContext('2d'); context.scale(ratio, ratio); context.clearRect(0, 0, width, height); return { context, width, height }; }
function grid(context, width, height) { context.strokeStyle = '#313846'; context.lineWidth = 1; for (let line = 1; line < 4; line += 1) { const y = 12 + ((height - 28) * line / 4); context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); } }
function drawSelection(context, width, height) {
  const index = state.layers.findIndex(layer => layer.id === state.selectedId);
  if (index < 0 || state.layers.length < 2) return;
  const x = index * width / (state.layers.length - 1);
  context.strokeStyle = 'rgba(77, 163, 255, .55)'; context.lineWidth = 1;
  context.beginPath(); context.moveTo(x, 5); context.lineTo(x, height - 8); context.stroke();
}

function renderDefectChart() {
  const { context, width, height } = canvasContext('#defect-chart'); grid(context, width, height);
  const windowSize = Math.min(40, Math.max(1, state.layers.length)); const points = state.layers.map((layer, index) => { const windowLayers = state.layers.slice(Math.max(0, index - windowSize + 1), index + 1).filter(eligible); return windowLayers.length ? windowLayers.filter(isFlagged).length / windowLayers.length : null; });
  const eligibleCount = state.layers.filter(eligible).length; const last = points.at(-1); document.querySelector('#defect-rate').textContent = last == null ? '--' : percent(last); document.querySelector('#defect-note').textContent = `${eligibleCount}/${state.layers.length} completed eligible layers in this loaded range. Window: ${windowSize} layers.`;
  drawLine(context, points, width, height, '#4da3ff', value => 1 - value);
  drawSelection(context, width, height);
}

function renderArgonChart() {
  const { context, width, height } = canvasContext('#argon-chart');
  grid(context, width, height);
  const byChannel = new Map();
  state.layers.forEach((layer, layerIndex) => {
    const current = new Map(
      (layer.argon_snapshot.channels || []).map(channel => [channel.channel, channel]),
    );
    for (const [channel, points] of byChannel) {
      const reading = current.get(channel);
      points.push(
        reading?.reading_status === 'ok' && typeof reading.value === 'number'
          ? reading.value
          : null,
      );
    }
    for (const [channel, reading] of current) {
      if (byChannel.has(channel)) continue;
      byChannel.set(channel, [
        ...Array(layerIndex).fill(null),
        reading.reading_status === 'ok' && typeof reading.value === 'number'
          ? reading.value
          : null,
      ]);
    }
  });
  const values = [...byChannel.values()].flat().filter(value => value != null);
  const label = document.querySelector('#argon-label');
  const legend = document.querySelector('#argon-legend');
  legend.replaceChildren();
  if (!values.length) {
    label.textContent = 'unknown';
    return;
  }
  const low = Math.min(...values);
  const high = Math.max(...values);
  const units = state.layers.flatMap(layer => layer.argon_snapshot.channels || []).find(channel => channel.units)?.units || '';
  label.textContent = `${numeric(low)}-${numeric(high)} ${units}`.trim();
  for (const [channel, points] of byChannel) {
    const color = channelColors[(channel - 1) % channelColors.length];
    const legendItem = document.createElement('span');
    const dot = document.createElement('i'); dot.className = 'channel-dot'; dot.style.setProperty('--channel-color', color);
    legendItem.append(dot, `CH ${channel}`); legend.append(legendItem);
    drawLine(
      context,
      points,
      width,
      height,
      color,
      value => high === low ? .5 : (high - value) / (high - low),
      true,
    );
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
    if (value == null) {
      open = false;
      return;
    }
    const x = points.length === 1 ? width / 2 : index * width / (points.length - 1);
    const y = 12 + normalise(value) * (height - 28);
    if (!open) {
      context.beginPath();
      context.moveTo(x, y);
      open = true;
    } else if (stepped) {
      context.lineTo(x, previousY);
      context.lineTo(x, y);
    } else {
      context.lineTo(x, y);
    }
    context.stroke();
    previousY = y;
  });
}

select.addEventListener('change', () => loadLayers().catch(error => setNotice(error.message, true)));
loadEarlier.addEventListener('click', () => { loadLayers(false).catch(error => setNotice(error.message, true)); });
window.addEventListener('resize', () => { if (state.layers.length) { renderDefectChart(); renderArgonChart(); } });
window.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLSelectElement) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const current = Math.max(0, state.layers.findIndex(layer => layer.id === state.selectedId));
    const offset = event.key === 'ArrowLeft' ? -1 : 1;
    const next = state.layers[Math.max(0, Math.min(state.layers.length - 1, current + offset))];
    if (next && next.id !== state.selectedId) { event.preventDefault(); activateLayer(next); }
  }
  if (/^[1-4]$/.test(event.key)) {
    const layer = selected(); const media = layer ? layerMedia(layer) : [];
    const role = mediaOrder[Number(event.key) - 1];
    if (media.some(item => item.role === role)) { state.selectedMediaRole = role; renderSelected(); }
  }
});
loadSessions().catch(error => setNotice(`Could not load remote review: ${error.message}`, true));
