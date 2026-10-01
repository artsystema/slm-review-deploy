<?php

declare(strict_types=1);

require dirname(__DIR__) . '/app/Http.php';
require dirname(__DIR__) . '/app/SessionEndRepository.php';

use SlmReview\HttpError;
use SlmReview\SessionEndRepository;

$valid = [
    'session_local_id' => 2,
    'ended_at' => '2026-09-29T21:48:13.209454+03:00',
    'monitor_instance_id' => 'efa4fcd0-3c9c-4a17-a892-a85875b6fd61',
];
if (SessionEndRepository::validate($valid) !== [
    $valid['monitor_instance_id'], 2, $valid['ended_at'],
]) {
    throw new RuntimeException('valid session end was rejected');
}
foreach ([
    [...$valid, 'extra' => true],
    [...$valid, 'session_local_id' => 0],
    [...$valid, 'ended_at' => '2026-09-29T21:48:13'],
    [...$valid, 'ended_at' => '2026-02-30T21:48:13+03:00'],
    [...$valid, 'monitor_instance_id' => '../other'],
] as $invalid) {
    try {
        SessionEndRepository::validate($invalid);
        throw new RuntimeException('invalid session end was accepted');
    } catch (HttpError $error) {
        if ($error->status !== 422) {
            throw new RuntimeException('wrong status for invalid session end');
        }
    }
}
echo "session end contract passed\n";
