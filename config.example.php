<?php

declare(strict_types=1);

// Copy this file to private/config.php outside the web root. Keep all values
// out of source control and use the database names cPanel actually assigned.
return [
    'database' => [
        'host' => 'localhost',
        'port' => 3306,
        'name' => 'CPANEL_USER_slm_review',
        'username' => 'CPANEL_USER_slm_ingest',
        'password' => 'replace-with-a-long-database-password',
    ],
    'storage_dir' => '/home/CPANEL_USER/slm-review-storage',
    'ingest_token' => 'replace-with-a-long-random-ingest-token',
    // A custom token overrides the published default; this placeholder uses it.
    // Set a different token only when the operator will enter it in the browser.
    'review_token' => 'replace-with-a-different-long-random-review-token',
    // Optional destructive-action token. Keep separate from the browser review
    // token; session deletion stays disabled while this is null/placeholder.
    'session_delete_token' => null,
    // Optional HTTPS player URL on a separately protected video relay.
    // No credentials, tokens, query string, or fragment in this value.
    'chamber_stream_url' => null,
    // Share only with the NODE1 relay's separate viewer-signing-key file.
    // Generate a random 48+ character value; never expose it to the browser.
    'chamber_access_secret' => null,
    'max_manifest_bytes' => 262144,
    'max_media_bytes' => 5242880,
];
