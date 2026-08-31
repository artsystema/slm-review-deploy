<?php

declare(strict_types=1);

$rootFile = __DIR__ . '/app-root.php';
if (!is_file($rootFile)) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Remote review is not configured.\n";
    exit;
}

$applicationRoot = require $rootFile;
if (!is_string($applicationRoot) || !is_file($applicationRoot . '/app/bootstrap.php')) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Remote review application path is invalid.\n";
    exit;
}

require $applicationRoot . '/app/bootstrap.php';

try {
    \SlmReview\Application::run();
} catch (Throwable $exception) {
    error_log('SLM remote review unhandled error: ' . $exception->getMessage());
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'internal server error']);
}
