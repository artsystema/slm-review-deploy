<?php

declare(strict_types=1);

require dirname(__DIR__) . '/app/bootstrap.php';

use SlmReview\ChamberAccess;
use SlmReview\Request;

$url = ChamberAccess::bootstrapUrl(
    'https://chamber.example.com/chamber/player.html',
    str_repeat('v', 48),
    1700000000,
    str_repeat('b', 32),
);
$prefix = 'https://chamber.example.com/chamber/access#';
if (!str_starts_with($url, $prefix)) {
    throw new RuntimeException('grant URL must use the viewer origin and a fragment');
}
$grant = substr($url, strlen($prefix));
[$encoded, $signature] = explode('.', $grant);
$payload = base64_decode(strtr($encoded, '-_', '+/'), true);
$mac = base64_decode(strtr($signature, '-_', '+/'), true);
if ($payload !== 'v1:1700000000:1700000045:' . str_repeat('b', 32)
    || $mac === false || !hash_equals(hash_hmac('sha256', $payload, str_repeat('v', 48), true), $mac)) {
    throw new RuntimeException('relay grant format or signature changed');
}
foreach (['http://chamber.example.com/chamber/player.html', 'https://invalid'] as $badUrl) {
    try {
        ChamberAccess::bootstrapUrl($badUrl, str_repeat('v', 48));
        throw new RuntimeException('invalid player URL was accepted');
    } catch (InvalidArgumentException) {
    }
}
try {
    ChamberAccess::bootstrapUrl('https://chamber.example.com/chamber/player.html', 'short');
    throw new RuntimeException('short signing key was accepted');
} catch (InvalidArgumentException) {
}
$requestType = new ReflectionClass(Request::class);
$request = $requestType->newInstanceWithoutConstructor();
$requestType->getProperty('server')->setValue($request, ['REMOTE_USER' => 'reviewer-1']);
if ($request->authenticatedUser() !== 'reviewer-1') {
    throw new RuntimeException('Directory Privacy user was not recognized');
}
$requestType->getProperty('server')->setValue($request, []);
if ($request->authenticatedUser() !== null) {
    throw new RuntimeException('missing Directory Privacy user was authorized');
}
$requestType->getProperty('server')->setValue($request, ['PHP_AUTH_USER' => 'unverified']);
if ($request->authenticatedUser() !== null) {
    throw new RuntimeException('unverified Basic Auth header was authorized');
}
echo "chamber access grant passed\n";
