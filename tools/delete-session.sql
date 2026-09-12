-- Remove one session's layers from the remote reviewer.
--
-- There is no endpoint for this and there is not meant to be: the service is
-- read-only by design, so deletion is a deliberate operator act run against the
-- database with the account that owns it, not something the site can be talked
-- into doing. Run it in phpMyAdmin as the database owner. The runtime user has
-- DELETE, but give it no reason to use it.
--
-- Three things make the order below non-negotiable:
--
--   1. `publication_media` references `publications` with ON DELETE RESTRICT,
--      so the media rows must go first or the publication delete simply fails.
--   2. Media is content-addressed and SHARED. Two layers photographing the same
--      unchanged bed store one `media_objects` row and one file on disk. Never
--      delete a session's files by listing its own hashes -- another session may
--      still reference them. Only rows no publication references at all are safe,
--      which is what the orphan query below asks for.
--   3. The files themselves live outside the database, under the private storage
--      directory, and SQL cannot remove them. Step 5 prints their paths for the
--      File Manager.
--
-- Deletion is final. The sync agent keeps its own delivery ledger, and a
-- publication it has already committed is in a terminal state there -- it will
-- not notice the server forgot and will not send it again. Restoring a deleted
-- session means clearing that publication's ledger entry on the monitor host.
--
-- Run the steps ONE AT A TIME, not as one paste. Steps 3 and 4 exist so you can
-- read a number and decide, and phpMyAdmin executing the whole file in one go
-- takes that decision away -- it would commit before you saw the count. Each
-- step is separated below; select one, run it, read it, move on.

-- ---------------------------------------------------------------------------
-- Name the session. Both values come from the viewer's URL:
--   #m=<monitor_instance_id>&s=<session_local_id>
-- ---------------------------------------------------------------------------
SET @monitor := 'f2c8ea59-a7ec-4b7b-8ce8-a24313ec6cd4';
SET @session := 24;

-- Step 1. Look before you leap. Confirm this is the session you mean, and note
-- the layer count so you can check the deletion removed exactly that many.
SELECT p.session_local_id,
       MAX(p.session_name)   AS session_name,
       COUNT(*)              AS layers,
       MIN(p.captured_at)    AS first_layer,
       MAX(p.captured_at)    AS last_layer
  FROM publications p
 WHERE p.monitor_instance_id = @monitor
   AND p.session_local_id <=> @session
 GROUP BY p.session_local_id;

-- Step 2. Take everything out in one transaction, so a failure at the second
-- delete cannot leave the media rows gone and their publications behind.
START TRANSACTION;

DELETE pm
  FROM publication_media pm
  JOIN publications p ON p.id = pm.publication_id
 WHERE p.monitor_instance_id = @monitor
   AND p.session_local_id <=> @session;

DELETE FROM publications
 WHERE monitor_instance_id = @monitor
   AND session_local_id <=> @session;

-- Step 3. The row count here must match the layer count from step 1. If it does
-- not, ROLLBACK instead and work out why before trying again.
SELECT ROW_COUNT() AS publications_deleted;

-- Step 4. Commit once you are satisfied. ROLLBACK is still available until you do.
COMMIT;

-- Step 5. List the media that nothing references any more. This is deliberately
-- a global question rather than a per-session one, because a file is only
-- unreachable once the LAST publication using it is gone -- and it also sweeps
-- up orphans left by any earlier deletion.
--
-- Copy `storage_path` and delete those files under the private storage
-- directory, e.g. /home/CPANEL_USER/public_html/slm-review-storage/<storage_path>.
-- Delete the files FIRST, then run step 6, so a failure leaves rows pointing at
-- missing files (harmless, and re-listed next time) rather than files no row
-- names (invisible, and orphaned forever).
SELECT mo.sha256,
       mo.storage_path,
       mo.size_bytes
  FROM media_objects mo
  LEFT JOIN publication_media pm ON pm.media_sha256 = mo.sha256
 WHERE pm.media_sha256 IS NULL
 ORDER BY mo.size_bytes DESC;

-- How much disk that frees. Kept as its own statement rather than a window
-- function, which MySQL 5.6 does not have and this host may still be running.
SELECT COUNT(*) AS orphan_files,
       ROUND(SUM(mo.size_bytes) / 1048576, 1) AS mb_to_free
  FROM media_objects mo
  LEFT JOIN publication_media pm ON pm.media_sha256 = mo.sha256
 WHERE pm.media_sha256 IS NULL;

-- Step 6. Only after the files are gone from disk.
DELETE mo
  FROM media_objects mo
  LEFT JOIN publication_media pm ON pm.media_sha256 = mo.sha256
 WHERE pm.media_sha256 IS NULL;
