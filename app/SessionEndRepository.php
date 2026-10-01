<?php

declare(strict_types=1);

namespace SlmReview;

use DateTimeImmutable;
use PDO;

final class SessionEndRepository
{
    public function __construct(private PDO $database)
    {
    }

    /** @param mixed $body */
    public function record(mixed $body): void
    {
        [$monitorId, $sessionId, $endedAt] = self::validate($body);
        $statement = $this->database->prepare(
            'INSERT IGNORE INTO session_ends (monitor_instance_id, session_local_id, ended_at)
             VALUES (:monitor_id, :session_id, :ended_at)'
        );
        $statement->execute([
            'monitor_id' => $monitorId,
            'session_id' => $sessionId,
            'ended_at' => $endedAt,
        ]);
        $stored = $this->database->prepare(
            'SELECT ended_at FROM session_ends WHERE monitor_instance_id = :monitor_id
             AND session_local_id = :session_id'
        );
        $stored->execute(['monitor_id' => $monitorId, 'session_id' => $sessionId]);
        if ($stored->fetchColumn() !== $endedAt) {
            throw new HttpError(409, 'session end time conflicts with an earlier delivery');
        }
    }

    /** @param mixed $body @return array{string, int, string} */
    public static function validate(mixed $body): array
    {
        if (!is_array($body) || count($body) !== 3
            || !array_key_exists('monitor_instance_id', $body)
            || !array_key_exists('session_local_id', $body)
            || !array_key_exists('ended_at', $body)) {
            throw new HttpError(422, 'session end body has invalid fields');
        }
        $monitorId = $body['monitor_instance_id'];
        $sessionId = $body['session_local_id'];
        $endedAt = $body['ended_at'];
        if (!is_string($monitorId)
            || preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D', $monitorId) !== 1
            || !is_int($sessionId) || $sessionId <= 0
            || !is_string($endedAt) || strlen($endedAt) > 64
            || preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/D', $endedAt) !== 1
        ) {
            throw new HttpError(422, 'session end identity or time is invalid');
        }
        try {
            new DateTimeImmutable($endedAt);
        } catch (\Exception) {
            throw new HttpError(422, 'session end time is invalid');
        }
        if (DateTimeImmutable::getLastErrors() !== false) {
            throw new HttpError(422, 'session end time is invalid');
        }
        return [$monitorId, $sessionId, $endedAt];
    }
}
