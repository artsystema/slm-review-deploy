CREATE TABLE publications (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    publication_key VARCHAR(71) NOT NULL,
    monitor_instance_id CHAR(36) NOT NULL,
    session_local_id BIGINT UNSIGNED NULL,
    session_name VARCHAR(255) NULL,
    session_state VARCHAR(50) NOT NULL,
    run_local_id BIGINT UNSIGNED NOT NULL,
    layer_analysis_id BIGINT UNSIGNED NOT NULL,
    layer_index BIGINT UNSIGNED NOT NULL,
    captured_at VARCHAR(64) NOT NULL,
    analysis_status VARCHAR(50) NOT NULL,
    severity VARCHAR(50) NOT NULL,
    analysis_state VARCHAR(100) NOT NULL,
    key_view_state VARCHAR(20) NOT NULL,
    manifest_sha256 CHAR(64) NOT NULL,
    manifest_json LONGTEXT NOT NULL,
    status VARCHAR(20) NOT NULL,
    received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    committed_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_publications_publication_key (publication_key),
    UNIQUE KEY uq_publications_monitor_publication (monitor_instance_id, publication_key),
    KEY idx_publications_session (monitor_instance_id, session_local_id, status, id),
    KEY idx_publications_captured (captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE media_objects (
    sha256 CHAR(64) NOT NULL,
    media_type VARCHAR(100) NOT NULL,
    storage_path VARCHAR(255) NOT NULL,
    size_bytes BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE publication_media (
    publication_id BIGINT UNSIGNED NOT NULL,
    role VARCHAR(50) NOT NULL,
    media_sha256 CHAR(64) NOT NULL,
    media_type VARCHAR(100) NOT NULL,
    width INT UNSIGNED NOT NULL,
    height INT UNSIGNED NOT NULL,
    PRIMARY KEY (publication_id, role),
    KEY idx_publication_media_sha (media_sha256),
    CONSTRAINT fk_publication_media_publication
        FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
