-- Terminal print-session state is delivered independently of immutable layer bundles.
CREATE TABLE session_ends (
    monitor_instance_id CHAR(36) NOT NULL,
    session_local_id BIGINT UNSIGNED NOT NULL,
    ended_at VARCHAR(64) NOT NULL,
    received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (monitor_instance_id, session_local_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
