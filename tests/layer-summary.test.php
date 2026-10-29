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

$measured = ReviewRepository::summaryOfManifest($manifest([
    'renewal_before_after_unrenewed_frac' => 0.0021,
    'dark_curve_skeleton_pixels' => 632,
    'dark_curve_span_px' => 421.9,
    'dark_curve_severity_reported' => 3,
]));
if ($measured['renewal_unrenewed_frac'] !== 0.0021 || $measured['deficit_area_frac'] !== 0.0003) {
    throw new RuntimeException('renewal area was not summarised from the manifest metrics');
}
if ($measured['dark_curve_skeleton_pixels'] !== 632.0
    || $measured['dark_curve_span_px'] !== 421.9
    || $measured['dark_curve_severity'] !== 3) {
    throw new RuntimeException('dark curve measurements were not summarised from the manifest metrics');
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
if (ReviewRepository::SUMMARY_VERSION < 3) {
    throw new RuntimeException('rows summarised before migration 010 would never gain curve columns');
}

echo "layer summary ok\n";
