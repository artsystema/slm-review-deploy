<?php

declare(strict_types=1);

require dirname(__DIR__) . '/app/bootstrap.php';

use SlmReview\Application;
use SlmReview\Config;

function renderChamberPage(?string $url): string
{
    $configType = new ReflectionClass(Config::class);
    $config = $configType->newInstanceWithoutConstructor();
    $configType->getProperty('values')->setValue($config, ['chamber_stream_url' => $url]);

    $applicationType = new ReflectionClass(Application::class);
    $application = $applicationType->newInstanceWithoutConstructor();
    $applicationType->getProperty('config')->setValue($application, $config);
    $html = $applicationType->getMethod('page')->invoke($application);
    if (!is_string($html)) {
        throw new RuntimeException('review page did not render');
    }
    return $html;
}

if (($argv[1] ?? '') === '--render') {
    echo renderChamberPage('https://live.example.com/chamber_remote/');
    exit(0);
}

$empty = renderChamberPage(null);
if (strpos($empty, 'id="chamber-live"') === false
    || strpos($empty, 'data-stream-url=""') === false
    || strpos($empty, 'id="chamber-live"') > strpos($empty, 'id="notice"')) {
    throw new RuntimeException('unconfigured panel is missing or misplaced');
}
$url = 'https://live.example.com/chamber_remote/';
$configured = renderChamberPage($url);
if (!str_contains($configured, 'data-stream-url="' . $url . '"')
    || !str_contains($configured, 'id="chamber-live-open" href="' . $url . '"')
    || str_contains($configured, '<iframe id="chamber-live-player" src=')) {
    throw new RuntimeException('configured panel should defer loading until opened');
}
echo "chamber panel rendering passed\n";
