<?php

declare(strict_types=1);

namespace SlmReview;

final class ChamberAccess
{
    private const GRANT_SECONDS = 45;

    public static function bootstrapUrl(string $playerUrl, string $secret, ?int $now = null, ?string $nonce = null): string
    {
        if (strlen($secret) < 32) {
            throw new \InvalidArgumentException('chamber access signing key is too short');
        }
        $parts = parse_url($playerUrl);
        if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https'
            || !isset($parts['host']) || !str_contains($parts['host'], '.')
            || ($parts['path'] ?? '') !== '/chamber/player.html'
            || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment'])) {
            throw new \InvalidArgumentException('chamber player URL is invalid');
        }
        $issued = $now ?? time();
        $random = $nonce ?? bin2hex(random_bytes(16));
        if ($issued < 1 || preg_match('/^[a-f0-9]{32}$/D', $random) !== 1) {
            throw new \InvalidArgumentException('chamber grant inputs are invalid');
        }
        $payload = sprintf('v1:%d:%d:%s', $issued, $issued + self::GRANT_SECONDS, $random);
        $signature = hash_hmac('sha256', $payload, $secret, true);
        $grant = self::base64url($payload) . '.' . self::base64url($signature);
        $port = isset($parts['port']) ? ':' . $parts['port'] : '';
        return 'https://' . $parts['host'] . $port . '/chamber/access#' . $grant;
    }

    private static function base64url(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }
}
