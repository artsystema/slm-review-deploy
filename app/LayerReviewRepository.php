<?php

declare(strict_types=1);

namespace SlmReview;

use PDO;
use PDOStatement;

/** Append-only human decisions about a published layer's CV assessment. */
final class LayerReviewRepository
{
    public function __construct(private PDO $database)
    {
    }

    /** @param array<string, mixed> $value
     *  @return array{publication_id: int, decision: string, note: string, idempotency_key: string, expected_review_id: ?int}
     */
    public static function validate(array $value): array
    {
        $keys = array_keys($value);
        sort($keys);
        if ($keys !== ['decision', 'expected_review_id', 'idempotency_key', 'note', 'publication_id']) {
            throw new HttpError(422, 'review fields are invalid');
        }
        $id = $value['publication_id'];
        $decision = $value['decision'];
        $note = $value['note'];
        $key = $value['idempotency_key'];
        $expected = $value['expected_review_id'];
        if (!is_int($id) || $id < 1) {
            throw new HttpError(422, 'publication_id must be a positive integer');
        }
        if (!in_array($decision, ['approve', 'reject'], true)) {
            throw new HttpError(422, 'decision must be approve or reject');
        }
        if (!is_string($note) || strlen($note) > 1000 || preg_match('//u', $note) !== 1) {
            throw new HttpError(422, 'note must be UTF-8 and at most 1000 bytes');
        }
        if (!is_string($key) || preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $key) !== 1) {
            throw new HttpError(422, 'idempotency_key must be a UUID v4');
        }
        if ($expected !== null && (!is_int($expected) || $expected < 1)) {
            throw new HttpError(422, 'expected_review_id must be null or a positive integer');
        }
        return [
            'publication_id' => $id,
            'decision' => $decision,
            'note' => trim($note),
            'idempotency_key' => $key,
            'expected_review_id' => $expected,
        ];
    }

    /** @param array<string, mixed>|false $prior
     *  @param array<string, mixed> $value
     *  @return array<string, mixed>|null
     */
    public static function repeatedDecision(array|false $prior, array $value): ?array
    {
        if ($prior === false) {
            return null;
        }
        if ((int) $prior['publication_id'] !== $value['publication_id']
            || $prior['decision'] !== $value['decision']
            || $prior['note'] !== $value['note']
            || ($prior['expected_review_id'] === null ? null : (int) $prior['expected_review_id']) !== $value['expected_review_id']) {
            throw new HttpError(409, 'idempotency key was used for a different decision');
        }
        return self::asReview($prior);
    }

    public static function requireExpected(?int $latestId, ?int $expectedId): void
    {
        if ($latestId !== $expectedId) {
            throw new HttpError(409, 'review changed; reload this layer before deciding');
        }
    }

    /** @return list<array<string, mixed>> */
    public function currentForSession(string $monitorId, ?int $sessionId, bool $unassigned): array
    {
        $scope = $unassigned ? 'p.session_local_id IS NULL' : 'p.session_local_id = :session_id';
        $statement = $this->database->prepare(
            'SELECT r.id, r.publication_id, r.decision, r.note, r.reviewer, r.created_at
             FROM layer_reviews r
             INNER JOIN (
                 SELECT lr.publication_id, MAX(lr.id) AS latest_id
                 FROM layer_reviews lr
                 INNER JOIN publications p ON p.id = lr.publication_id
                 WHERE p.status = \'committed\' AND p.monitor_instance_id = :monitor_id AND ' . $scope . '
                 GROUP BY lr.publication_id
             ) latest ON latest.latest_id = r.id
             ORDER BY r.publication_id ASC LIMIT 50001'
        );
        $statement->bindValue('monitor_id', $monitorId);
        if (!$unassigned) {
            $statement->bindValue('session_id', $sessionId, PDO::PARAM_INT);
        }
        $statement->execute();
        $rows = $statement->fetchAll();
        if (count($rows) > 50000) {
            throw new HttpError(413, 'review index exceeds 50000 layers');
        }
        return array_map([self::class, 'asReview'], $rows);
    }

    /** @return list<array<string, mixed>> */
    public function history(int $publicationId): array
    {
        $this->requireCommittedPublication($publicationId);
        $statement = $this->database->prepare(
            'SELECT id, publication_id, decision, note, reviewer, created_at
             FROM layer_reviews WHERE publication_id = :publication_id ORDER BY id DESC LIMIT 100'
        );
        $statement->execute(['publication_id' => $publicationId]);
        return array_map([self::class, 'asReview'], $statement->fetchAll());
    }

    /** @param array<string, mixed> $input
     *  @return array<string, mixed>
     */
    public function record(array $input, string $reviewer): array
    {
        $value = self::validate($input);
        $this->database->beginTransaction();
        try {
            // The publication lock serializes competing review decisions for
            // one layer, including retries with the same idempotency key.
            $lock = $this->database->prepare(
                'SELECT id FROM publications WHERE id = :id AND status = \'committed\' FOR UPDATE'
            );
            $lock->execute(['id' => $value['publication_id']]);
            if ($lock->fetchColumn() === false) {
                throw new HttpError(404, 'published layer was not found');
            }
            $existing = $this->database->prepare(
                'SELECT * FROM layer_reviews WHERE idempotency_key = :key LIMIT 1'
            );
            $existing->execute(['key' => $value['idempotency_key']]);
            $prior = $existing->fetch();
            $repeat = self::repeatedDecision($prior, $value);
            if ($repeat !== null) {
                $this->database->commit();
                return $repeat;
            }
            $latest = $this->database->prepare(
                'SELECT id FROM layer_reviews WHERE publication_id = :publication_id ORDER BY id DESC LIMIT 1'
            );
            $latest->execute(['publication_id' => $value['publication_id']]);
            $latestId = $latest->fetchColumn();
            self::requireExpected($latestId === false ? null : (int) $latestId, $value['expected_review_id']);
            $insert = $this->database->prepare(
                'INSERT INTO layer_reviews
                 (publication_id, decision, note, reviewer, idempotency_key, expected_review_id, created_at)
                 VALUES (:publication_id, :decision, :note, :reviewer, :idempotency_key, :expected_review_id, :created_at)'
            );
            $createdAt = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
                ->format('Y-m-d\TH:i:s.u\Z');
            $insert->execute([...$value, 'reviewer' => $reviewer, 'created_at' => $createdAt]);
            $id = (int) $this->database->lastInsertId();
            $read = $this->database->prepare(
                'SELECT id, publication_id, decision, note, reviewer, created_at
                 FROM layer_reviews WHERE id = :id'
            );
            $read->execute(['id' => $id]);
            $row = $read->fetch();
            $this->database->commit();
            return self::asReview($row);
        } catch (\Throwable $error) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $error;
        }
    }

    private function requireCommittedPublication(int $publicationId): void
    {
        $statement = $this->database->prepare(
            'SELECT id FROM publications WHERE id = :id AND status = \'committed\' LIMIT 1'
        );
        $statement->execute(['id' => $publicationId]);
        if ($statement->fetchColumn() === false) {
            throw new HttpError(404, 'published layer was not found');
        }
    }

    /** @param array<string, mixed> $row
     *  @return array<string, mixed>
     */
    private static function asReview(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'publication_id' => (int) $row['publication_id'],
            'decision' => $row['decision'],
            'note' => $row['note'],
            'reviewer' => $row['reviewer'],
            'created_at' => $row['created_at'],
        ];
    }
}
