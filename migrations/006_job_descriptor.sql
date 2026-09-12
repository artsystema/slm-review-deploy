-- What the printer's job descriptor said each build would be.
--
-- This service receives layers one at a time and has never known what they
-- count towards. It could say "2,150 layers received" and nothing more: not
-- whether that is most of the build or a tenth of it, and not whether a gap in
-- the filmstrip is a layer still in flight or a layer that was never made. The
-- monitor now reads the job descriptor the operator loaded and publishes its
-- layer total with every bundle, which is what lets the viewer draw progress
-- against the build rather than against itself.
--
-- Stored per publication rather than in a runs table because that is how
-- `run_mode` and `monitor_software_version` are already kept: a publication is
-- the only row this service owns, and the values simply repeat across a run's
-- layers. The viewer takes MAX() per run, so a run whose early layers predate
-- the monitor upgrade still gets its total from the later ones.
--
-- All nullable, and there is deliberately no backfill. Unlike the monitor
-- version, this was never in the older manifests, so nothing can recover it for
-- layers already published; those rows stay NULL and the viewer shows them the
-- count-only presentation it showed before.
ALTER TABLE publications
    ADD COLUMN job_layers_total BIGINT UNSIGNED NULL AFTER run_mode,
    ADD COLUMN job_name VARCHAR(120) NULL AFTER job_layers_total,
    ADD COLUMN job_material VARCHAR(120) NULL AFTER job_name,
    ADD COLUMN job_layer_thickness_mm DOUBLE NULL AFTER job_material;

-- A run's progress is read as MAX(job_layers_total) and MAX(layer_index) for
-- one run, filtered to committed rows. The existing session index already
-- covers (monitor, session, status, id); this covers the per-run rollup so the
-- viewer's progress query does not scan a session's whole history of layers.
CREATE INDEX idx_publications_run_progress
    ON publications (monitor_instance_id, session_local_id, run_local_id, status, layer_index);
