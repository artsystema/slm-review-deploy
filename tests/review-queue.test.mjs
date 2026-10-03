import assert from 'node:assert/strict';
import { it } from 'node:test';
import { nextPending, reviewable } from '../public/assets/review-queue-core.js';
import { canReviewLayer, hasWrittenOllamaResult } from '../public/assets/decision-panel.js';

const layer = (id, run, index, severity = 'none', status = 'completed') => ({
  id, run_local_id: run, index, analysis: { severity, status },
});

it('lists latest layers first and keeps uncertain results distinct from CV findings', () => {
  const layers = [layer(1, 1, 9), layer(2, 2, 1, 'critical'), layer(3, 2, 2, 'critical', 'uncertain')];
  const reviews = new Map([[2, { decision: 'approve' }]]);
  assert.deepEqual(reviewable(layers, reviews, 'pending').map(item => item.id), [3, 1]);
  assert.deepEqual(reviewable(layers, reviews, 'flagged').map(item => item.id), [2]);
  assert.deepEqual(reviewable(layers, reviews, 'approved').map(item => item.id), [2]);
});

it('can find the next pending layer after approving the selected layer', () => {
  const layers = [layer(1, 1, 1), layer(2, 1, 2), layer(3, 1, 3)];
  const reviews = new Map([[3, { decision: 'approve' }]]);
  assert.equal(nextPending(layers, reviews, 3)?.id, 2);
  reviews.set(2, { decision: 'reject' });
  assert.equal(nextPending(layers, reviews, 2)?.id, 1);
  reviews.set(1, { decision: 'approve' });
  assert.equal(nextPending(layers, reviews, 1), null);
});

it('searches an exact layer number across runs', () => {
  const layers = [layer(1, 1, 10), layer(2, 2, 10), layer(3, 2, 100)];
  assert.deepEqual(reviewable(layers, new Map(), 'all', '10').map(item => item.id), [2, 1]);
});

it('shows the inline decision block only after a separate Ollama observation was written', () => {
  const observation = { schema_version: 'large-gap-observation.v2', verdict: 'uncertain', cue: 'The panel is too dark.' };
  const vision_job = { schema_version: 'vision.job.v1', status: 'completed',
    result_schema_version: 'large-gap-observation.v2', observation };
  assert.equal(canReviewLayer(null), false);
  assert.equal(canReviewLayer({ analysis: { status: 'failed' } }), false);
  assert.equal(canReviewLayer({ analysis: { status: 'uncertain' } }), false);
  assert.equal(canReviewLayer({ analysis: { status: 'completed', severity: 'none' } }), false);
  assert.equal(canReviewLayer({ analysis: { status: 'failed' }, vision_job }), false);
  assert.equal(canReviewLayer({ analysis: { status: 'completed' }, vision_job }), true);
  assert.equal(hasWrittenOllamaResult({ vision_job: { ...vision_job, status: 'running' } }), false);
  assert.equal(hasWrittenOllamaResult({ vision_job: { ...vision_job, observation: null } }), false);
  assert.equal(hasWrittenOllamaResult({ vision_job: { ...vision_job,
    observation: { ...observation, cue: ' ' } } }), false);
  assert.equal(hasWrittenOllamaResult({ vision_job: { ...vision_job,
    observation: { ...observation, verdict: 'not_a_verdict' } } }), false);
});
