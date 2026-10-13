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
    echo renderChamberPage('https://live.example.com/chamber/player.html');
    exit(0);
}

$empty = renderChamberPage(null);
$notice = strpos($empty, 'id="notice"');
$grid = strpos($empty, 'class="selected-grid"');
$chamber = strpos($empty, 'id="chamber-live"');
$viewer = strpos($empty, 'class="panel viewer-card"');
$evidence = strpos($empty, 'class="panel evidence-card"');
if (strpos($empty, 'data-stream-url=""') === false
    || $notice === false || $grid === false || $chamber === false
    || $viewer === false || $evidence === false
    || !($notice < $grid && $grid < $chamber && $chamber < $viewer && $viewer < $evidence)) {
    throw new RuntimeException('unconfigured panel is missing or misplaced');
}
$url = 'https://live.example.com/chamber/player.html';
$configured = renderChamberPage($url);
if (!str_contains($configured, 'data-stream-url="' . $url . '"')
    || !str_contains($configured, '<aside id="chamber-live"')
    || !str_contains($configured, 'id="chamber-lightbox-open"')
    || !str_contains($configured, 'id="chamber-badge"')
    || !str_contains($configured, 'id="chamber-caption"')
    || str_contains($configured, 'chamber-facts')
    || str_contains($configured, 'chamber-live-open')
    || str_contains($configured, '<iframe id="chamber-live-player" src=')) {
    throw new RuntimeException('configured panel should be permanent and defer iframe loading to the browser');
}
echo "chamber panel rendering passed\n";
