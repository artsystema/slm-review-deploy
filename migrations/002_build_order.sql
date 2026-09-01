-- The layer timeline is ordered by build position, not arrival. A bundle whose
-- first upload failed is retried by the monitor's reconciler and lands with a
-- later auto-increment id than layers captured after it, so ordering the strip
-- by id showed those layers out of sequence.
--
-- This index serves the windowed timeline query and its (run, layer, id)
-- keyset pagination. The existing idx_publications_session still serves the
-- arrival-ordered poll, which continues to key on id.
ALTER TABLE publications
    ADD KEY idx_publications_build_order
        (monitor_instance_id, session_local_id, status, run_local_id, layer_index, id);
