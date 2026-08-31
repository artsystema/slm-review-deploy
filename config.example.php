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
    'max_manifest_bytes' => 262144,
    'max_media_bytes' => 5242880,
];
