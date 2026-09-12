-- Remove one session's layers from the remote reviewer, via phpMyAdmin.
--
-- There is no endpoint for this and there is not meant to be: the service is
-- read-only by design, so deletion is a deliberate operator act run against the
-- database, not something the site can be talked into doing.
--
-- HOW TO RUN
--   cPanel -> Databases -> phpMyAdmin, pick the review database in the left
--   sidebar, open the SQL tab, then paste and run ONE BLOCK BELOW AT A TIME.
--   Read each result before moving on.
--
--   Every block repeats the two SET lines on purpose. phpMyAdmin does not
--   promise that user variables or an open transaction survive between separate
--   Go clicks -- it may hand the next query a different connection -- so a block
--   that relied on an earlier block's state could silently delete with @session
--   unset. Each block below stands alone and commits on its own.
--
-- WHAT MAKES THIS FIDDLIER THAN IT LOOKS
--   * `publication_media` references `publications` with ON DELETE RESTRICT, so
--     the media rows must go first or the publication delete simply fails.
--   * Media is content-addressed and SHARED. Two layers photographing an
--     unchanged bed keep one row and one file, so deleting a session's files by
--     listing its own hashes would take images other sessions still display.
--     Block 3 asks which media nothing references AT ALL, which is the only
--     safe question.
--   * The files live outside the database. SQL frees rows and leaves the bytes
--     on disk; block 3 prints the paths for the File Manager.
--
-- DELETION IS FINAL. The sync agent's ledger puts a delivered publication in a
-- terminal state, so it will not notice the server forgot and will not send it
-- again. Getting a session back means clearing its ledger entry on the monitor
-- host.


-- ===========================================================================
-- BLOCK 1 -- PREVIEW. Changes nothing. Run this first and keep the layer count.
-- ===========================================================================
-- Both values come from the viewer's URL: #m=<monitor>&s=<session>.
-- For the "unassigned" pseudo-session, use  SET @session := NULL;
SET @monitor := 'f2c8ea59-a7ec-4b7b-8ce8-a24313ec6cd4';
SET @session := 24;

SELECT p.session_local_id,
       MAX(p.session_name) AS session_name,
       COUNT(*)            AS layers_to_delete,
       MIN(p.captured_at)  AS first_layer,
       MAX(p.captured_at)  AS last_layer
  FROM publications p
 WHERE p.monitor_instance_id = @monitor
   AND p.session_local_id <=> @session
 GROUP BY p.session_local_id;


-- ===========================================================================
-- BLOCK 2 -- DELETE. Run only once block 1 named the session you meant.
-- Run the whole block in one Go: the transaction is what stops a failure on the
-- second delete stranding media rows whose publications are already gone, and
-- it only protects you if both deletes and the COMMIT arrive together.
-- phpMyAdmin should report two result sets; the second count must equal
-- `layers_to_delete` from block 1.
-- ===========================================================================
SET @monitor := 'f2c8ea59-a7ec-4b7b-8ce8-a24313ec6cd4';
SET @session := 24;

START TRANSACTION;

DELETE pm
  FROM publication_media pm
  JOIN publications p ON p.id = pm.publication_id
 WHERE p.monitor_instance_id = @monitor
   AND p.session_local_id <=> @session;

DELETE FROM publications
 WHERE monitor_instance_id = @monitor
   AND session_local_id <=> @session;

COMMIT;


-- ===========================================================================
-- BLOCK 3 -- FIND THE FREED FILES. Changes nothing.
-- Deliberately a global question, not a per-session one: a file is unreachable
-- only once the LAST publication using it is gone. It also sweeps up orphans
-- left by any earlier deletion.
-- ===========================================================================
SELECT COUNT(*) AS orphan_files,
       ROUND(SUM(mo.size_bytes) / 1048576, 1) AS mb_to_free
  FROM media_objects mo
  LEFT JOIN publication_media pm ON pm.media_sha256 = mo.sha256
 WHERE pm.media_sha256 IS NULL;

SELECT mo.sha256, mo.storage_path, mo.size_bytes
  FROM media_objects mo
  LEFT JOIN publication_media pm ON pm.media_sha256 = mo.sha256
 WHERE pm.media_sha256 IS NULL
 ORDER BY mo.size_bytes DESC;

-- Export that list (Export -> CSV) if it is long. Each `storage_path` is
-- relative to the private storage directory, so the file to remove is
--   /home/CPANEL_USER/public_html/slm-review-storage/<storage_path>
-- Delete the FILES first, then run block 4. That order fails safe: rows naming
-- a missing file are harmless and get re-listed next time, whereas a file no
-- row names is invisible and orphaned for good.


-- ===========================================================================
-- BLOCK 4 -- FORGET THE FREED FILES. Run only after the files are gone.
-- ===========================================================================
DELETE mo
  FROM media_objects mo
  LEFT JOIN publication_media pm ON pm.media_sha256 = mo.sha256
 WHERE pm.media_sha256 IS NULL;
