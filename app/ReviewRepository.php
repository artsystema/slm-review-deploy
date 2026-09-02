<?php

declare(strict_types=1);

namespace SlmReview;

use PDO;
use PDOStatement;

final class ReviewRepository
{
    public function __construct(private PDO $database)
    {
    }

    /** @return list<array<string, mixed>> */
    public function sessions(int $limit): array
    {
        $statement = $this->database->prepare(
            'SELECT monitor_instance_id, session_local_id, MAX(session_name) AS session_name,
                    MAX(session_state) AS session_state, MIN(captured_at) AS first_captured_at,
                    MAX(captured_at) AS last_captured_at, COUNT(*) AS layer_count,
                    MAX(id) AS latest_publication_id,
                    SUM(CASE WHEN analysis_status = \'completed\' THEN 1 ELSE 0 END) AS completed_count
             FROM publications
             WHERE status = \'committed\'
             GROUP BY monitor_instance_id, session_local_id
             ORDER BY last_captured_at DESC
             LIMIT :limit'
        );
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        return $statement->fetchAll();
    }

    /**
     * One window of a session's layers, newest first in *build* order.
     *
     * Build order is (run_local_id, layer_index), not the auto-increment id.
     * The id is arrival order: a bundle whose first upload failed is retried by
     * the monitor's reconciler minutes later and lands after layers captured
     * well after it. Ordering the timeline by id put those layers at the end of
     * the strip, out of sequence with the build.
     *
     * @param array{run: int, layer: int, id: int}|null $before
     * @return list<array<string, mixed>>
     */
    public function layers(
        string $monitorId,
        ?int $sessionId,
        bool $unassigned,
        ?array $before,
        int $limit,
        string $basePath,
    ): array {
        $sql = $this->selectClause() . $this->scopeClause($unassigned);
        if ($before !== null) {
            $sql .= ' AND (p.run_local_id, p.layer_index, p.id) < (:before_run, :before_layer, :before_id)';
        }
        $sql .= ' ORDER BY p.run_local_id DESC, p.layer_index DESC, p.id DESC LIMIT :limit';
        $statement = $this->database->prepare($sql);
        $this->bindScope($statement, $monitorId, $sessionId, $unassigned);
        if ($before !== null) {
            $statement->bindValue('before_run', $before['run'], PDO::PARAM_INT);
            $statement->bindValue('before_layer', $before['layer'], PDO::PARAM_INT);
            $statement->bindValue('before_id', $before['id'], PDO::PARAM_INT);
        }
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        return $this->hydrate($statement->fetchAll(), $basePath);
    }

    /**
     * Layers that arrived after `sinceId`, for polling clients.
     *
     * This one *is* keyed on the auto-increment id, because arrival is exactly
     * the question being asked: a layer backfilled out of build order is still
     * news to a viewer that has not seen it. The client merges the result into
     * its own build-ordered list.
     *
     * @return list<array<string, mixed>>
     */
    public function layersSince(
        string $monitorId,
        ?int $sessionId,
        bool $unassigned,
        int $sinceId,
        int $limit,
        string $basePath,
    ): array {
        $sql = $this->selectClause() . $this->scopeClause($unassigned)
            . ' AND p.id > :since_id ORDER BY p.id ASC LIMIT :limit';
        $statement = $this->database->prepare($sql);
        $this->bindScope($statement, $monitorId, $sessionId, $unassigned);
        $statement->bindValue('since_id', $sinceId, PDO::PARAM_INT);
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        return $this->hydrate($statement->fetchAll(), $basePath);
    }

    /** Highest committed publication id in a session, or null when it is empty. */
    public function latestPublicationId(string $monitorId, ?int $sessionId, bool $unassigned): ?int
    {
        $sql = 'SELECT MAX(p.id) AS latest FROM publications p
                WHERE p.status = \'committed\' AND p.monitor_instance_id = :monitor_id'
            . $this->scopeClause($unassigned);
        $statement = $this->database->prepare($sql);
        $this->bindScope($statement, $monitorId, $sessionId, $unassigned);
        $statement->execute();
        $value = $statement->fetchColumn();
        return $value === false || $value === null ? null : (int) $value;
    }

    private function selectClause(): string
    {
        return 'SELECT p.id, p.run_local_id, p.layer_index, p.captured_at, p.analysis_status, p.severity,
                       p.analysis_state, p.key_view_state, p.monitor_software_version, p.manifest_json
                FROM publications p
                WHERE p.status = \'committed\' AND p.monitor_instance_id = :monitor_id';
    }

    private function scopeClause(bool $unassigned): string
    {
        return $unassigned ? ' AND p.session_local_id IS NULL' : ' AND p.session_local_id = :session_id';
    }

    private function bindScope(
        PDOStatement $statement,
        string $monitorId,
        ?int $sessionId,
        bool $unassigned,
    ): void {
        $statement->bindValue('monitor_id', $monitorId);
        if (!$unassigned) {
            $statement->bindValue('session_id', $sessionId, PDO::PARAM_INT);
        }
    }

    /**
     * @param list<array<string, mixed>> $records
     * @return list<array<string, mixed>>
     */
    private function hydrate(array $records, string $basePath): array
    {
        $rows = [];
        foreach ($records as $row) {
            $manifest = json_decode($row['manifest_json'], true, 512, JSON_THROW_ON_ERROR);
            $media = [];
            $mediaByRole = [];
            foreach ($manifest['media'] as $item) {
                $entry = [
                    'role' => $item['role'],
                    'stage' => $item['stage'],
                    'url' => $basePath . '/api/v1/media/' . $item['sha256'],
                    'width' => $item['width'],
                    'height' => $item['height'],
                ];
                $media[] = $entry;
                $mediaByRole[$item['role']] = $entry;
            }
            $keyView = $mediaByRole['diagnostic_overlay']
                ?? $mediaByRole['key_view']
                ?? $mediaByRole['raw_after']
                ?? $mediaByRole['raw_before']
                ?? null;
            $rows[] = [
                'id' => (int) $row['id'],
                'run_local_id' => (int) $row['run_local_id'],
                'index' => (int) $row['layer_index'],
                'captured_at' => $row['captured_at'],
                'analysis' => $manifest['analysis'],
                'run' => $manifest['run'],
                'argon_snapshot' => $manifest['argon_snapshot'],
                'key_view_state' => $row['key_view_state'],
                'key_view_url' => $keyView['url'] ?? null,
                // Which build published this layer. Null for rows written
                // before the column existed and whose manifest could not be
                // parsed by the backfill.
                'monitor_software_version' => $row['monitor_software_version'] ?? null,
                'media' => $media,
            ];
        }
        return $rows;
    }

    /** @return array{path: string, media_type: string, size: int}|null */
    public function media(string $sha256): ?array
    {
        $statement = $this->database->prepare(
            'SELECT mo.storage_path, mo.media_type, mo.size_bytes
             FROM media_objects mo
             INNER JOIN publication_media pm ON pm.media_sha256 = mo.sha256
             INNER JOIN publications p ON p.id = pm.publication_id
             WHERE mo.sha256 = :sha256 AND p.status = \'committed\'
             LIMIT 1'
        );
        $statement->execute(['sha256' => $sha256]);
        $row = $statement->fetch();
        if ($row === false) {
            return null;
        }
        return [
            'path' => $row['storage_path'],
            'media_type' => $row['media_type'],
            'size' => (int) $row['size_bytes'],
        ];
    }
}
