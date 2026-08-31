<?php

declare(strict_types=1);

namespace SlmReview;

use PDO;

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

    /** @return list<array<string, mixed>> */
    public function layers(
        string $monitorId,
        ?int $sessionId,
        bool $unassigned,
        int $beforeId,
        int $limit,
        string $basePath,
    ): array
    {
        $sql = 'SELECT p.id, p.layer_index, p.captured_at, p.analysis_status, p.severity, p.analysis_state,
                       p.key_view_state, p.manifest_json, pm.media_sha256
                FROM publications p
                LEFT JOIN publication_media pm ON pm.publication_id = p.id AND pm.role = \'key_view\'
                WHERE p.status = \'committed\' AND p.monitor_instance_id = :monitor_id';
        if ($unassigned) {
            $sql .= ' AND p.session_local_id IS NULL';
        } else {
            $sql .= ' AND p.session_local_id = :session_id';
        }
        if ($beforeId > 0) {
            $sql .= ' AND p.id < :before_id';
        }
        $sql .= ' ORDER BY p.id DESC LIMIT :limit';
        $statement = $this->database->prepare($sql);
        $statement->bindValue('monitor_id', $monitorId);
        if (!$unassigned) {
            $statement->bindValue('session_id', $sessionId, PDO::PARAM_INT);
        }
        if ($beforeId > 0) {
            $statement->bindValue('before_id', $beforeId, PDO::PARAM_INT);
        }
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        $rows = [];
        foreach ($statement->fetchAll() as $row) {
            $manifest = json_decode($row['manifest_json'], true, 512, JSON_THROW_ON_ERROR);
            $rows[] = [
                'id' => (int) $row['id'],
                'index' => (int) $row['layer_index'],
                'captured_at' => $row['captured_at'],
                'analysis' => $manifest['analysis'],
                'argon_snapshot' => $manifest['argon_snapshot'],
                'key_view_state' => $row['key_view_state'],
                'key_view_url' => $row['media_sha256'] === null
                    ? null
                    : $basePath . '/api/v1/media/' . $row['media_sha256'],
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
