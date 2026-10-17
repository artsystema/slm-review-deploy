<?php

declare(strict_types=1);

require dirname(__DIR__) . '/app/ReviewRepository.php';

use SlmReview\ReviewRepository;

// The session index carries the unrenewed area beside the deficit so the
// defect chart can plot both across a build (migration 009).
$manifest = static fn (array $metrics): string => json_encode([
    'analysis' => ['deficit_area_frac' => 0.0003, 'metrics' => $metrics],
    'argon_snapshot' => ['channels' => [], 'combined' => []],
    'media' => [],
], JSON_THROW_ON_ERROR);

$measured = ReviewRepository::summaryOfManifest($manifest(['renewal_before_after_unrenewed_frac' => 0.0021]));
if ($measured['renewal_unrenewed_frac'] !== 0.0021 || $measured['deficit_area_frac'] !== 0.0003) {
    throw new RuntimeException('renewal area was not summarised from the manifest metrics');
}

// A layer where renewal did not run is unmeasured, not zero.
foreach ([[], ['renewal_before_after_unrenewed_frac' => null], ['renewal_before_after_unrenewed_frac' => 'n/a']] as $metrics) {
    if (ReviewRepository::summaryOfManifest($manifest($metrics))['renewal_unrenewed_frac'] !== null) {
        throw new RuntimeException('a missing renewal measurement became a value');
    }
}
if (ReviewRepository::summaryOfManifest('{not json')['renewal_unrenewed_frac'] !== null) {
    throw new RuntimeException('an unreadable manifest produced a renewal value');
}
if (ReviewRepository::SUMMARY_VERSION < 2) {
    throw new RuntimeException('rows summarised before migration 009 would never gain the renewal column');
}

echo "layer summary ok\n";
