/** Pure list rules shared by the browser and its tests. */
export function reviewable(layers, reviews, filter, layerNumber = '') {
  const number = layerNumber === '' ? null : Number(layerNumber);
  return layers.filter(layer => {
    if (number !== null && layer.index !== number) return false;
    const decision = reviews.get(layer.id)?.decision;
    if (filter === 'pending') return !decision;
    if (filter === 'approved') return decision === 'approve';
    if (filter === 'rejected') return decision === 'reject';
    if (filter === 'flagged') {
      return layer.analysis?.status === 'completed' && layer.analysis?.severity !== 'none';
    }
    return true;
  }).sort((left, right) => (right.run_local_id - left.run_local_id)
    || (right.index - left.index) || (right.id - left.id));
}

export function nextPending(layers, reviews, selectedId) {
  const pending = reviewable(layers, reviews, 'pending');
  if (!pending.length) return null;
  const at = pending.findIndex(layer => layer.id === selectedId);
  if (at >= 0) return pending[(at + 1) % pending.length];
  const all = reviewable(layers, reviews, 'all');
  const selectedAt = all.findIndex(layer => layer.id === selectedId);
  return pending.find(layer => all.indexOf(layer) > selectedAt) || pending[0];
}
