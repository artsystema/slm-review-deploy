-- The unrenewed bed area beside the deficit area, so the defect chart can plot
-- it across a whole build from the session index.
--
-- Until now the value lived only in the manifest's `analysis.metrics` dict,
-- which the index deliberately does not send (see 004). The viewer could show
-- it for the one layer being looked at but not as a series.
--
-- Nullable for the same reasons as 004's columns: a layer where the renewal
-- channel did not run, or a monitor that predates it, has no measurement, and
-- missing is never zero. Rows summarised before this column existed carry
-- `summary_version = 1`; the read path re-summarises those from the stored
-- manifest a bounded number per request and marks them version 2, so no
-- backfill statement is needed here.
ALTER TABLE publications
    ADD COLUMN renewal_unrenewed_frac DOUBLE NULL AFTER deficit_area_frac;
