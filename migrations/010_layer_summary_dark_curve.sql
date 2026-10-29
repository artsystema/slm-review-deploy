-- Persist the dark-curve measurements needed by the whole-session chart.
--
-- Older rows are not bulk-updated here. ReviewRepository summary version 3
-- re-reads their immutable manifests in bounded batches and fills these fields
-- as sessions are opened, preserving missing as NULL rather than zero.
ALTER TABLE publications
    ADD COLUMN dark_curve_skeleton_pixels DOUBLE NULL AFTER renewal_unrenewed_frac,
    ADD COLUMN dark_curve_span_px DOUBLE NULL AFTER dark_curve_skeleton_pixels,
    ADD COLUMN dark_curve_severity TINYINT UNSIGNED NULL AFTER dark_curve_span_px;
