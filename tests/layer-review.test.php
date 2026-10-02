<?php

declare(strict_types=1);

require dirname(__DIR__) . '/app/Http.php';
require dirname(__DIR__) . '/app/LayerReviewRepository.php';

use SlmReview\HttpError;
use SlmReview\LayerReviewRepository;
use SlmReview\Request;

$server = $_SERVER;
try {
    unset($_SERVER['REMOTE_USER'], $_SERVER['PHP_AUTH_USER']);
    if (Request::fromGlobals()->reviewer() !== 'review-token-holder') {
        throw new RuntimeException('missing server identity was misattributed');
    }
    $_SERVER['REMOTE_USER'] = 'node1';
    if (Request::fromGlobals()->reviewer() !== 'node1') {
        throw new RuntimeException('server identity was lost');
    }
} finally {
    $_SERVER = $server;
}

$valid = [
    'publication_id' => 199,
    'decision' => 'reject',
    'note' => 'Uncovered sector after recoat',
    'idempotency_key' => 'fe5da587-4cd4-4adb-90dd-e6f00cd5333d',
    'expected_review_id' => null,
];
if (LayerReviewRepository::validate($valid) !== $valid) {
    throw new RuntimeException('valid review was changed');
}
$prior = [
    ...$valid, 'id' => 8, 'reviewer' => 'operator', 'created_at' => '2026-10-03T07:00:00.000000Z',
];
if (LayerReviewRepository::repeatedDecision($prior, $valid)['id'] !== 8
    || LayerReviewRepository::repeatedDecision(false, $valid) !== null) {
    throw new RuntimeException('idempotent replay did not return its original event');
}
LayerReviewRepository::requireExpected(null, null);
LayerReviewRepository::requireExpected(8, 8);
foreach ([
    static fn () => LayerReviewRepository::repeatedDecision($prior, [...$valid, 'decision' => 'approve']),
    static fn () => LayerReviewRepository::requireExpected(8, null),
] as $conflict) {
    try {
        $conflict();
        throw new RuntimeException('conflicting review was accepted');
    } catch (HttpError $error) {
        if ($error->status !== 409) {
            throw new RuntimeException('wrong status for conflicting review');
        }
    }
}
foreach ([
    [...$valid, 'decision' => 'uncertain'],
    [...$valid, 'publication_id' => 0],
    [...$valid, 'publication_id' => '199'],
    [...$valid, 'idempotency_key' => '../other'],
    [...$valid, 'expected_review_id' => -1],
    [...$valid, 'note' => str_repeat('x', 1001)],
    [...$valid, 'note' => "\xff"],
    [...$valid, 'unexpected' => true],
] as $invalid) {
    try {
        LayerReviewRepository::validate($invalid);
        throw new RuntimeException('invalid review was accepted');
    } catch (HttpError $error) {
        if ($error->status !== 422) {
            throw new RuntimeException('wrong status for invalid review');
        }
    }
}
echo "layer review contract passed\n";
