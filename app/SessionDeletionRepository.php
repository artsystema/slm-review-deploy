<?php

declare(strict_types=1);

namespace SlmReview;

use PDO;

final class SessionDeletionRepository
{
    public function __construct(private PDO $database, private MediaStore $mediaStore)
    {
    }

    /**
     * Delete one ended, named session and media no remaining publication uses.
     *
     * @param mixed $body
     * @return array<string, int|string>
     */
    public function delete(mixed $body): array
    {
        [$monitorId, $sessionId, $expectedName, $expectedCount] = self::validate($body);
        $orphanPaths = [];
        $orphanBytes = 0;
        $publicationCount = 0;
        $this->database->beginTransaction();
        try {
            $rows = $this->database->prepare(
                'SELECT id, session_name, status FROM publications
                 WHERE monitor_instance_id = :monitor_id AND session_local_id = :session_id
                 ORDER BY id ASC FOR UPDATE'
            );
            $rows->execute(['monitor_id' => $monitorId, 'session_id' => $sessionId]);
            $publications = $rows->fetchAll();
            if ($publications === []) {
                throw new HttpError(404, 'session was not found');
            }
            $publicationCount = count($publications);
            $committedCount = count(array_filter(
                $publications,
                static fn (array $row): bool => $row['status'] === 'committed'
            ));
            $storedName = null;
            foreach ($publications as $publication) {
                if (is_string($publication['session_name']) && $publication['session_name'] !== '') {
                    $storedName = $publication['session_name'];
                }
            }
            if ($storedName === null || !hash_equals($storedName, $expectedName)) {
                throw new HttpError(409, 'session name confirmation does not match');
            }
            if ($committedCount !== $expectedCount) {
                throw new HttpError(409, 'session layer count changed; reload before deleting');
            }
            $ended = $this->database->prepare(
                'SELECT ended_at FROM session_ends
                 WHERE monitor_instance_id = :monitor_id AND session_local_id = :session_id FOR UPDATE'
            );
            $ended->execute(['monitor_id' => $monitorId, 'session_id' => $sessionId]);
            if ($ended->fetchColumn() === false) {
                throw new HttpError(409, 'an active or unterminated session cannot be deleted');
            }

            $media = $this->database->prepare(
                'SELECT DISTINCT pm.media_sha256
                 FROM publication_media pm
                 INNER JOIN publications p ON p.id = pm.publication_id
                 WHERE p.monitor_instance_id = :monitor_id AND p.session_local_id = :session_id'
            );
            $media->execute(['monitor_id' => $monitorId, 'session_id' => $sessionId]);
            $candidateHashes = array_values(array_filter($media->fetchAll(PDO::FETCH_COLUMN), 'is_string'));

            $reviews = $this->database->prepare(
                'DELETE lr FROM layer_reviews lr
                 INNER JOIN publications p ON p.id = lr.publication_id
                 WHERE p.monitor_instance_id = :monitor_id AND p.session_local_id = :session_id'
            );
            $reviews->execute(['monitor_id' => $monitorId, 'session_id' => $sessionId]);
            $links = $this->database->prepare(
                'DELETE pm FROM publication_media pm
                 INNER JOIN publications p ON p.id = pm.publication_id
                 WHERE p.monitor_instance_id = :monitor_id AND p.session_local_id = :session_id'
            );
            $links->execute(['monitor_id' => $monitorId, 'session_id' => $sessionId]);
            $deletePublications = $this->database->prepare(
                'DELETE FROM publications WHERE monitor_instance_id = :monitor_id AND session_local_id = :session_id'
            );
            $deletePublications->execute(['monitor_id' => $monitorId, 'session_id' => $sessionId]);
            $deleteEnd = $this->database->prepare(
                'DELETE FROM session_ends WHERE monitor_instance_id = :monitor_id AND session_local_id = :session_id'
            );
            $deleteEnd->execute(['monitor_id' => $monitorId, 'session_id' => $sessionId]);

            foreach (array_chunk($candidateHashes, 400) as $chunk) {
                $placeholders = [];
                $parameters = [];
                foreach ($chunk as $position => $hash) {
                    $key = "hash{$position}";
                    $placeholders[] = ":{$key}";
                    $parameters[$key] = $hash;
                }
                $sql = 'SELECT mo.sha256, mo.storage_path, mo.size_bytes FROM media_objects mo
                        WHERE mo.sha256 IN (' . implode(',', $placeholders) . ')
                          AND NOT EXISTS (
                              SELECT 1 FROM publication_media pm WHERE pm.media_sha256 = mo.sha256
                          )';
                $orphans = $this->database->prepare($sql);
                $orphans->execute($parameters);
                foreach ($orphans->fetchAll() as $orphan) {
                    $orphanPaths[] = (string) $orphan['storage_path'];
                    $orphanBytes += (int) $orphan['size_bytes'];
                }
                if ($orphanPaths !== []) {
                    $deleteObjects = $this->database->prepare(
                        'DELETE FROM media_objects WHERE sha256 IN (' . implode(',', $placeholders) . ')
                          AND NOT EXISTS (
                              SELECT 1 FROM publication_media pm WHERE pm.media_sha256 = media_objects.sha256
                          )'
                    );
                    $deleteObjects->execute($parameters);
                }
            }
            $this->database->commit();
        } catch (\Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }

        $filesDeleted = 0;
        $fileErrors = 0;
        foreach ($orphanPaths as $path) {
            try {
                if ($this->mediaStore->deleteObject($path)) {
                    $filesDeleted++;
                    continue;
                }
            } catch (\Throwable $exception) {
                error_log('SLM remote review rejected orphan media path: ' . $exception->getMessage());
            }
            $fileErrors++;
            error_log('SLM remote review could not remove orphan media ' . $path);
        }
        return [
            'status' => 'deleted',
            'session_name' => $expectedName,
            'publications_deleted' => $publicationCount,
            'media_objects_deleted' => count($orphanPaths),
            'media_bytes_released' => $orphanBytes,
            'media_files_deleted' => $filesDeleted,
            'media_file_errors' => $fileErrors,
        ];
    }

    /** @param mixed $body @return array{string, int, string, int} */
    public static function validate(mixed $body): array
    {
        $keys = ['expected_layer_count', 'expected_session_name', 'monitor_instance_id', 'session_local_id'];
        $actualKeys = is_array($body) && !array_is_list($body) ? array_keys($body) : [];
        sort($actualKeys);
        if (!is_array($body) || array_is_list($body) || $actualKeys !== $keys) {
            throw new HttpError(422, 'session deletion body has invalid fields');
        }
        $monitorId = $body['monitor_instance_id'];
        $sessionId = $body['session_local_id'];
        $name = $body['expected_session_name'];
        $count = $body['expected_layer_count'];
        if (!is_string($monitorId)
            || preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D', $monitorId) !== 1
            || !is_int($sessionId) || $sessionId <= 0
            || !is_string($name) || $name === '' || strlen($name) > 255
            || !is_int($count) || $count <= 0) {
            throw new HttpError(422, 'session deletion identity or confirmation is invalid');
        }
        return [$monitorId, $sessionId, $name, $count];
    }
}
