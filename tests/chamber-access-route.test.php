<?php

declare(strict_types=1);

require dirname(__DIR__) . '/app/bootstrap.php';

use SlmReview\Application;
use SlmReview\Config;
use SlmReview\HttpError;
use SlmReview\Request;
use SlmReview\Response;

if (($argv[1] ?? '') === '--dispatch') {
    $case = $argv[2] ?? '';
    $configType = new ReflectionClass(Config::class);
    $config = $configType->newInstanceWithoutConstructor();
    $configType->getProperty('values')->setValue($config, [
        'chamber_stream_url' => 'https://chamber.example.com/chamber/player.html',
        'chamber_access_secret' => $case === 'missing-key' ? null : str_repeat('v', 48),
    ]);
    $applicationType = new ReflectionClass(Application::class);
    $application = $applicationType->newInstanceWithoutConstructor();
    $applicationType->getProperty('config')->setValue($application, $config);
    $requestType = new ReflectionClass(Request::class);
    $request = $requestType->newInstanceWithoutConstructor();
    $server = [
        'REQUEST_METHOD' => 'POST',
        'REQUEST_URI' => '/api/v1/chamber/access',
        'SCRIPT_NAME' => '/index.php',
        'HTTP_X_SLM_CHAMBER_ACCESS' => $case === 'missing-header' ? '' : '1',
        'HTTP_SEC_FETCH_SITE' => $case === 'cross-site' ? 'cross-site' : 'same-origin',
    ];
    if ($case !== 'anonymous' && $case !== 'header-only-user') {
        $server['REMOTE_USER'] = 'reviewer-1';
    }
    if ($case === 'header-only-user') {
        $server['PHP_AUTH_USER'] = 'unverified';
    }
    $requestType->getProperty('server')->setValue($request, $server);
    try {
        $applicationType->getMethod('dispatch')->invoke($application, $request);
    } catch (HttpError $error) {
        Response::json($error->status, ['error' => $error->getMessage()]);
    }
    exit(1);
}

function runCase(string $case): array
{
    $process = proc_open([PHP_BINARY, __FILE__, '--dispatch', $case], [
        0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w'],
    ], $pipes);
    if (!is_resource($process)) {
        throw new RuntimeException('could not start route test');
    }
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    $error = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    if (proc_close($process) !== 0 || $error !== '') {
        throw new RuntimeException('route test failed: ' . $error);
    }
    $value = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($value)) {
        throw new RuntimeException('route returned invalid JSON');
    }
    return $value;
}

if (!str_starts_with(runCase('ok')['url'] ?? '', 'https://chamber.example.com/chamber/access#')) {
    throw new RuntimeException('authenticated browser did not get a handoff');
}
foreach (['anonymous', 'header-only-user', 'missing-header', 'cross-site'] as $case) {
    if ((runCase($case)['error'] ?? '') !== 'authenticated same-origin reviewer is required') {
        throw new RuntimeException("{$case} was granted chamber access");
    }
}
if ((runCase('missing-key')['error'] ?? '') !== 'chamber access is not configured') {
    throw new RuntimeException('missing signing key did not fail closed');
}
echo "chamber access route passed\n";
