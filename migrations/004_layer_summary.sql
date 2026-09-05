-- The fields the timeline actually reads, beside the manifest rather than
-- inside it.
--
-- The layers window sends every layer's whole `analysis` block, of which a
-- 51-key `metrics` dict is roughly a third and is read by nothing in the
-- viewer. Measured against this monitor's own published manifests that is
-- 4,517 bytes per layer where the strip, the severity scrubber, the defect
-- chart and the argon runway between them read about 161 -- so a 3,600-layer
-- build cost 15.6 MiB over fifteen "Load earlier" presses, and the defect rate
-- and the argon runway were computed over however many pages the operator
-- happened to have loaded rather than over the build.
--
-- These columns let one request carry a whole session's timeline. They are all
-- nullable because they are all legitimately absent: a layer whose analysis did
-- not complete has no deficit, a gauge that could not be read has no value, and
-- a bundle may carry no preview image at all. Missing is never zero here.
--
-- `summary_version` is the marker, not the values: every value may be NULL for
-- honest reasons, so it cannot say whether a row has been summarised. NULL
-- means "not summarised in this shape yet"; the read path fills those rows in
-- from the manifest it already stores, a bounded number per request, and
-- answers correctly whether or not that has happened yet.
ALTER TABLE publications
    ADD COLUMN summary_version TINYINT UNSIGNED NULL AFTER key_view_state,
    ADD COLUMN deficit_area_frac DOUBLE NULL AFTER summary_version,
    ADD COLUMN argon_combined_value DOUBLE NULL AFTER deficit_area_frac,
    ADD COLUMN argon_combined_state VARCHAR(30) NULL AFTER argon_combined_value,
    ADD COLUMN argon_units VARCHAR(20) NULL AFTER argon_combined_state,
    -- One [channel, value, reading_status] triple per enabled gauge, the value
    -- null wherever the status is not `ok`. The channel number is kept rather
    -- than the position because a channel can appear part way through a build,
    -- and the status is kept rather than collapsed to "missing" because why a
    -- gauge could not be read is the operator's information, not noise.
    ADD COLUMN argon_channels_json VARCHAR(512) NULL AFTER argon_units,
    -- The image the filmstrip chip shows: the published thumbnail where the
    -- monitor sent one, otherwise the same view the viewer would have picked.
    ADD COLUMN preview_sha256 CHAR(64) NULL AFTER argon_channels_json;
