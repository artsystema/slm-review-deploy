-- Import before deploying the review queue API. These are operator decisions
-- about an immutable publication, never edits to the monitor's analysis.
CREATE TABLE layer_reviews (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    publication_id BIGINT UNSIGNED NOT NULL,
    decision VARCHAR(16) NOT NULL,
    note TEXT NOT NULL,
    reviewer VARCHAR(255) NOT NULL,
    idempotency_key CHAR(36) NOT NULL,
    expected_review_id BIGINT UNSIGNED NULL,
    created_at VARCHAR(35) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_layer_reviews_idempotency (idempotency_key),
    KEY idx_layer_reviews_publication (publication_id, id),
    CONSTRAINT fk_layer_reviews_publication
        FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
