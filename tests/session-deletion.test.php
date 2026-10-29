<?php

declare(strict_types=1);

require dirname(__DIR__) . '/app/Http.php';
require dirname(__DIR__) . '/app/SessionDeletionRepository.php';

use SlmReview\HttpError;
use SlmReview\SessionDeletionRepository;

$valid = [
    'expected_layer_count' => 151,
    'expected_session_name' => '2610 dark-curve validation',
    'monitor_instance_id' => 'efa4fcd0-3c9c-4a17-a892-a85875b6fd61',
    'session_local_id' => 18,
];
if (SessionDeletionRepository::validate($valid) !== [
    $valid['monitor_instance_id'], 18, $valid['expected_session_name'], 151,
]) {
    throw new RuntimeException('valid session deletion confirmation was rejected');
}
foreach ([
    [...$valid, 'extra' => true],
    [...$valid, 'session_local_id' => 0],
    [...$valid, 'expected_layer_count' => 0],
    [...$valid, 'expected_session_name' => ''],
    [...$valid, 'monitor_instance_id' => '../other'],
] as $invalid) {
    try {
        SessionDeletionRepository::validate($invalid);
        throw new RuntimeException('invalid session deletion confirmation was accepted');
    } catch (HttpError $error) {
        if ($error->status !== 422) {
            throw new RuntimeException('wrong status for invalid deletion confirmation');
        }
    }
}
echo "session deletion contract passed\n";
