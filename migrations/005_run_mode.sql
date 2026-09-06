-- Whether a layer was analysed as the machine made it, or replayed from disk.
--
-- The viewer shows elapsed time along its timeline, and `captured_at` is the
-- analysis timestamp: on a live `watch` run that is the frame's own time, and
-- on a `batch` replay it is when the replay ran. Of the sessions this monitor
-- has published, two are replays -- one averaging half a second a layer -- so
-- without this column the reviewer would present a forty-minute replay of a
-- twenty-hour print as a forty-minute build.
--
-- Nullable because it is genuinely unknown for everything published before the
-- monitor sent it. The viewer says "elapsed" for those rather than guessing,
-- and no backfill can invent it: the manifests do not carry it either.
ALTER TABLE publications
    ADD COLUMN run_mode VARCHAR(20) NULL AFTER run_local_id;
