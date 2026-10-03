import { DEFAULT_REVIEW_TOKEN } from './review-default-token.js?v=20261003';

/** Require a published, completed NODE1 observation before showing this section. */
export function hasWrittenOllamaResult(layer) {
  const job = layer?.vision_job;
  return job?.schema_version === 'vision.job.v1'
    && job.status === 'completed'
    && job.result_schema_version === 'large-gap-observation.v2'
    && job.observation?.schema_version === 'large-gap-observation.v2'
    && ['likely_gap', 'no_clear_gap', 'uncertain'].includes(job.observation.verdict)
    && typeof job.observation.cue === 'string'
    && job.observation.cue.trim().length > 0;
}

/** CV decisions remain distinct from the independent Ollama observation. */
export function canReviewLayer(layer) {
  return layer?.analysis?.status === 'completed' && hasWrittenOllamaResult(layer);
}

export function createDecisionPanel({ basePath, getLayer, getDetail, isMoving, translate, locale }) {
  const el = id => document.getElementById(id);
  const details = el('decision-details');
  const summary = el('decision-summary');
  const badge = el('decision-badge');
  const unlock = el('decision-unlock');
  const tokenInput = el('decision-token');
  const lockButton = el('decision-lock');
  const controls = el('decision-controls');
  const status = el('decision-status');
  const note = el('decision-note');
  const approve = el('decision-approve');
  const reject = el('decision-reject');
  const historyDetails = el('decision-history');
  const historyList = el('decision-history-list');
  const state = {
    token: DEFAULT_REVIEW_TOKEN, layerId: null, loadedId: null, loadingId: null, failedId: null,
    history: [], serial: 0, busy: false, pending: null,
    statusKey: 'review.open', statusValues: {}, statusError: false,
  };

  function setStatus(key, values = {}, error = false) {
    state.statusKey = key;
    state.statusValues = values;
    state.statusError = error;
    status.textContent = translate(key, values);
    status.classList.toggle('error', error);
  }

  function current() { return state.history[0] || null; }

  function sync() {
    const layer = getLayer();
    const id = layer?.id ?? null;
    if (id !== state.layerId) {
      state.layerId = id;
      state.loadedId = null;
      state.loadingId = null;
      state.failedId = null;
      state.history = [];
      state.pending = null;
      state.serial += 1;
      note.value = '';
      setStatus('review.open');
    } else {
      setStatus(state.statusKey, state.statusValues, state.statusError);
    }
    const available = canReviewLayer(getDetail());
    details.hidden = !available;
    summary.setAttribute('aria-disabled', String(!available));
    summary.tabIndex = available ? 0 : -1;
    summary.title = available ? '' : translate('review.unavailable_detail');
    if (!available) details.open = false;
    const latest = state.loadedId === id ? current() : null;
    badge.textContent = !available ? translate('review.unavailable')
      : latest ? translate(latest.decision === 'approve' ? 'review.approved' : 'review.rejected')
        : state.token ? translate('review.awaiting') : translate('review.locked');
    unlock.hidden = !available || Boolean(state.token);
    lockButton.hidden = !state.token;
    controls.hidden = !available || !state.token || state.loadedId !== id;
    const evidence = getDetail()?.media?.some(item =>
      ['raw_before', 'raw_after', 'diagnostic_overlay', 'key_view'].includes(item.role));
    approve.disabled = reject.disabled = !evidence || state.busy;
    if (controls.hidden === false && getDetail() && !evidence
        && state.statusKey === 'review.ready') {
      setStatus('review.no_evidence', {}, true);
    }
    historyDetails.hidden = !state.history.length || controls.hidden;
    historyList.replaceChildren();
    for (const review of state.history) {
      const item = document.createElement('li');
      const at = new Date(review.created_at);
      const time = Number.isNaN(at.valueOf()) ? review.created_at : at.toLocaleString(locale());
      item.textContent = `${translate(review.decision === 'approve' ? 'review.approved' : 'review.rejected')} · ${review.reviewer} · ${time}${review.note ? ` · ${review.note}` : ''}`;
      historyList.append(item);
    }
    if (available && details.open && state.token && id !== null && !isMoving()
        && !state.busy && state.loadedId !== id && state.loadingId !== id && state.failedId !== id) {
      void load(id);
    }
  }

  async function request(path, options = {}) {
    const response = await fetch(`${basePath}${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-SLM-Review-Authorization': `Bearer ${state.token}`,
        ...options.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function failed(error, fallback) {
    if ([401, 403, 503].includes(error.status)) {
      state.token = '';
      state.loadedId = null;
      state.history = [];
    }
    if (error.status === 503) setStatus('review.not_configured', {}, true);
    else if ([401, 403].includes(error.status)) setStatus('review.invalid_token', {}, true);
    else setStatus(fallback, { error: error.message }, true);
  }

  async function load(id) {
    state.loadingId = id;
    const serial = ++state.serial;
    setStatus('review.loading');
    try {
      const data = await request(`/api/v1/reviews/${id}`);
      if (serial !== state.serial || state.layerId !== id) return;
      state.history = data.reviews || [];
      state.loadedId = id;
      state.failedId = null;
      setStatus('review.ready');
    } catch (error) {
      if (serial !== state.serial || state.layerId !== id) return;
      state.failedId = id;
      failed(error, 'review.load_error');
    } finally {
      if (serial === state.serial) {
        state.loadingId = null;
        sync();
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
    const layer = getLayer();
    if (!layer || state.busy || state.loadedId !== layer.id || approve.disabled) return;
    const payload = {
      publication_id: layer.id, decision, note: note.value.trim(),
      expected_review_id: current()?.id ?? null,
    };
    if (new TextEncoder().encode(payload.note).length > 1000) {
      setStatus('review.note_too_long', {}, true);
      return;
    }
    const signature = JSON.stringify(payload);
    if (state.pending?.signature !== signature) state.pending = { signature, key: newKey() };
    payload.idempotency_key = state.pending.key;
    state.busy = true;
    setStatus('review.saving');
    sync();
    try {
      const data = await request('/api/v1/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SLM-Review-Action': '1' },
        body: JSON.stringify(payload),
      });
      if (state.pending?.signature === signature) state.pending = null;
      if (state.layerId === layer.id) {
        state.history.unshift(data.review);
        setStatus('review.saved');
      }
    } catch (error) {
      if (state.layerId === layer.id) {
        failed(error, 'review.save_error');
        if (error.status === 409) {
          state.loadedId = null;
          state.failedId = null;
        }
      }
    } finally {
      state.busy = false;
      sync();
    }
  }

  summary.addEventListener('click', event => {
    if (summary.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });
  details.addEventListener('toggle', () => { if (details.open) state.failedId = null; sync(); });
  unlock.addEventListener('submit', event => {
    event.preventDefault();
    state.token = tokenInput.value;
    tokenInput.value = '';
    state.failedId = null;
    state.loadedId = null;
    sync();
  });
  lockButton.addEventListener('click', () => {
    state.token = '';
    state.loadedId = null;
    state.history = [];
    state.serial += 1;
    setStatus('review.locked');
    sync();
  });
  approve.addEventListener('click', () => { void decide('approve'); });
  reject.addEventListener('click', () => { void decide('reject'); });

  return { sync };
}
