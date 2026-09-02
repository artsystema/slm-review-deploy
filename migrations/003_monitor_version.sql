-- Which build published each layer.
--
-- Every manifest already carried `monitor.software_version`, and the validator
-- already checked it, but nothing stored it -- so two monitors publishing into
-- the same reviewer were indistinguishable. One of them ran 35 commits behind
-- for weeks, still stitching its analysis evidence into one image and sending
-- three media roles where the other sent five, and the only visible symptom was
-- a reviewer that showed three views instead of four. That read as a website
-- bug for as long as it took to go looking at the publisher.
--
-- Nullable because it is: rows written before this column existed have no value
-- of their own. The backfill below recovers what the stored manifest already
-- knows, which is every row -- but a NULL after it is still meaningful rather
-- than an error, so nothing here depends on the backfill having succeeded.
ALTER TABLE publications
    ADD COLUMN monitor_software_version VARCHAR(100) NULL AFTER monitor_instance_id;

-- The version was in the manifest all along. Recover it rather than leaving
-- history blank; a monitor that was behind should be visible on the layers it
-- actually published, not only on the ones it publishes next.
UPDATE publications
   SET monitor_software_version =
       JSON_UNQUOTE(JSON_EXTRACT(manifest_json, '$.monitor.software_version'))
 WHERE monitor_software_version IS NULL
   AND JSON_VALID(manifest_json);
