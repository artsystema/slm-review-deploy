<?php

declare(strict_types=1);

namespace SlmReview;

use PDO;
use PDOStatement;

final class ReviewRepository
{
    /** The shape `summary_version` marks a row as having been written in. */
    public const SUMMARY_VERSION = 1;

    /** At most this many rows are summarised on any one read, so a first
     *  request against a long history cannot run past the execution limit.
     *  A session longer than this converges over a few reads. */
    private const SUMMARY_FILL_LIMIT = 2000;

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

    /**
     * A whole session's timeline in one response.
     *
     * This carries only what the filmstrip, the severity strip, the defect
     * chart and the argon runway read. The per-layer detail -- the metrics, the
     * processor, the media, the reading ages -- stays behind the windowed
     * `layers` query and is asked for a screenful at a time.
     *
     * The point is not only the transfer. Paging meant the defect rate and the
     * argon runway were fitted over whatever the operator had loaded, so the
     * hours-remaining figure changed when they pressed a button. Over the whole
     * build those are properties of the build.
     *
     * Rows written before the summary columns existed are read out of the
     * manifest here, which is why this answers correctly on the first request
     * after the migration and merely gets cheaper afterwards.
     *
     * A session longer than the cap is cut at its *start*, not its end: the
     * newest layers are the ones a build in progress is being watched through,
     * and a timeline that dropped them would follow a layer hours behind the
     * machine. The caller is told it was cut.
     *
     * @return array{layers: list<array<string, mixed>>, truncated: bool}
     */
    public function sessionIndex(
        string $monitorId,
        ?int $sessionId,
        bool $unassigned,
        int $limit,
        string $basePath,
    ): array {
        $sql = 'SELECT p.id, p.run_local_id, p.layer_index, p.captured_at, p.analysis_status,
                       p.severity, p.summary_version, p.deficit_area_frac, p.argon_combined_value,
                       p.argon_combined_state, p.argon_units, p.argon_channels_json, p.preview_sha256,
                       CASE WHEN p.summary_version IS NULL THEN p.manifest_json END AS manifest_json
                FROM publications p
                WHERE p.status = \'committed\' AND p.monitor_instance_id = :monitor_id'
            . $this->scopeClause($unassigned)
            . ' ORDER BY p.run_local_id DESC, p.layer_index DESC, p.id DESC LIMIT :limit';
        $statement = $this->database->prepare($sql);
        $this->bindScope($statement, $monitorId, $sessionId, $unassigned);
        $statement->bindValue('limit', $limit + 1, PDO::PARAM_INT);
        $statement->execute();
        // Newest first so an over-long build loses its oldest layers, then back
        // into build order for the timeline the viewer draws.
        $records = $statement->fetchAll();
        $truncated = count($records) > $limit;
        if ($truncated) {
            array_pop($records);
        }
        $records = array_reverse($records);

        $layers = [];
        $pending = [];
        foreach ($records as $row) {
            if ($row['summary_version'] === null) {
                $summary = self::summaryOfManifest((string) $row['manifest_json']);
                if (count($pending) < self::SUMMARY_FILL_LIMIT) {
                    $pending[(int) $row['id']] = $summary;
                }
            } else {
                $summary = self::summaryOfColumns($row);
            }
            $layers[] = [
                'id' => (int) $row['id'],
                'run_local_id' => (int) $row['run_local_id'],
                'index' => (int) $row['layer_index'],
                'captured_at' => $row['captured_at'],
                'analysis' => [
                    'status' => $row['analysis_status'],
                    'severity' => $row['severity'],
                    'deficit_area_frac' => $summary['deficit_area_frac'],
                ],
                'argon_snapshot' => [
                    'channels' => $summary['channels'],
                    'combined' => [
                        'value' => $summary['combined_value'],
                        'state' => $summary['combined_state'],
                        'units' => $summary['units'],
                    ],
                ],
                'preview_url' => $summary['preview_sha256'] === null
                    ? null
                    : $basePath . '/api/v1/media/' . $summary['preview_sha256'],
            ];
        }
        $this->rememberSummaries($pending);
        return ['layers' => $layers, 'truncated' => $truncated];
    }

    /**
     * Write summaries back so the next read does not decode manifests again.
     *
     * A failure here is deliberately swallowed: this is a cache being warmed
     * during a read, the response above is already correct without it, and a
     * database that will not take the update -- a runtime user without UPDATE,
     * a migration not yet imported -- must not turn a working reviewer into an
     * error page.
     *
     * @param array<int, array<string, mixed>> $summaries keyed by publication id
     */
    private function rememberSummaries(array $summaries): void
    {
        if ($summaries === []) {
            return;
        }
        $started = false;
        try {
            // One commit rather than one per row: the decode above is the work,
            // and a few thousand autocommitted updates over a network socket
            // would not be.
            $started = !$this->database->inTransaction() && $this->database->beginTransaction();
            $statement = $this->database->prepare(
                'UPDATE publications
                    SET summary_version = :version, deficit_area_frac = :deficit,
                        argon_combined_value = :combined_value, argon_combined_state = :combined_state,
                        argon_units = :units, argon_channels_json = :channels, preview_sha256 = :preview
                  WHERE id = :id AND summary_version IS NULL'
            );
            foreach ($summaries as $id => $summary) {
                $statement->execute([
                    'version' => self::SUMMARY_VERSION,
                    'deficit' => $summary['deficit_area_frac'],
                    'combined_value' => $summary['combined_value'],
                    'combined_state' => $summary['combined_state'],
                    'units' => $summary['units'],
                    'channels' => json_encode(array_map(
                        static fn (array $channel): array => [
                            $channel['channel'], $channel['value'], $channel['reading_status'],
                        ],
                        $summary['channels'],
                    ), JSON_THROW_ON_ERROR),
                    'preview' => $summary['preview_sha256'],
                    'id' => $id,
                ]);
            }
            if ($started) {
                $this->database->commit();
            }
        } catch (\PDOException) {
            // See the note above: the answer does not depend on this succeeding.
            if ($started && $this->database->inTransaction()) {
                $this->database->rollBack();
            }
        }
    }

    /**
     * The summary a stored manifest implies.
     *
     * A reading only becomes a value when the monitor called it `ok`; every
     * other status keeps its name and leaves the value null, so the chart draws
     * a gap rather than a zero and the sidebar can still say why.
     *
     * @return array<string, mixed>
     */
    public static function summaryOfManifest(string $manifestJson): array
    {
        try {
            $manifest = json_decode($manifestJson, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return self::emptySummary();
        }
        $analysis = is_array($manifest['analysis'] ?? null) ? $manifest['analysis'] : [];
        $snapshot = is_array($manifest['argon_snapshot'] ?? null) ? $manifest['argon_snapshot'] : [];
        $combined = is_array($snapshot['combined'] ?? null) ? $snapshot['combined'] : [];
        $units = null;
        $channels = [];
        foreach (is_array($snapshot['channels'] ?? null) ? $snapshot['channels'] : [] as $channel) {
            if (!is_array($channel)) {
                continue;
            }
            $status = is_string($channel['reading_status'] ?? null) ? $channel['reading_status'] : 'unknown';
            $value = $status === 'ok' && is_numeric($channel['value'] ?? null)
                ? (float) $channel['value']
                : null;
            $units ??= is_string($channel['units'] ?? null) ? $channel['units'] : null;
            $channels[] = [
                'channel' => (int) ($channel['channel'] ?? 0),
                'value' => $value,
                'reading_status' => $status,
            ];
        }
        $units ??= is_string($combined['units'] ?? null) ? $combined['units'] : null;
        return [
            'deficit_area_frac' => is_numeric($analysis['deficit_area_frac'] ?? null)
                ? (float) $analysis['deficit_area_frac']
                : null,
            'combined_value' => is_numeric($combined['value'] ?? null) ? (float) $combined['value'] : null,
            'combined_state' => is_string($combined['state'] ?? null) ? $combined['state'] : null,
            'units' => $units,
            'channels' => $channels,
            'preview_sha256' => self::previewSha(is_array($manifest['media'] ?? null) ? $manifest['media'] : []),
        ];
    }

    /**
     * Which stored image a filmstrip chip should show.
     *
     * A published thumbnail wins outright -- it exists to be this. Otherwise the
     * order matches what the viewer would have picked for the chip anyway, so a
     * build published before thumbnails existed still has previews.
     *
     * @param list<mixed> $media
     */
    private static function previewSha(array $media): ?string
    {
        $byRole = [];
        foreach ($media as $item) {
            if (is_array($item) && is_string($item['role'] ?? null) && is_string($item['sha256'] ?? null)) {
                $byRole[$item['role']] = $item['sha256'];
            }
        }
        foreach (['thumbnail', 'diagnostic_overlay', 'key_view', 'raw_after', 'raw_before'] as $role) {
            if (isset($byRole[$role])) {
                return $byRole[$role];
            }
        }
        return null;
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private static function summaryOfColumns(array $row): array
    {
        $channels = [];
        if (is_string($row['argon_channels_json']) && $row['argon_channels_json'] !== '') {
            try {
                foreach (json_decode($row['argon_channels_json'], true, 8, JSON_THROW_ON_ERROR) as $channel) {
                    $channels[] = [
                        'channel' => (int) $channel[0],
                        'value' => $channel[1] === null ? null : (float) $channel[1],
                        'reading_status' => (string) $channel[2],
                    ];
                }
            } catch (\JsonException) {
                $channels = [];
            }
        }
        return [
            'deficit_area_frac' => $row['deficit_area_frac'] === null ? null : (float) $row['deficit_area_frac'],
            'combined_value' => $row['argon_combined_value'] === null
                ? null
                : (float) $row['argon_combined_value'],
            'combined_state' => $row['argon_combined_state'],
            'units' => $row['argon_units'],
            'channels' => $channels,
            'preview_sha256' => $row['preview_sha256'],
        ];
    }

    /** @return array<string, mixed> */
    private static function emptySummary(): array
    {
        return [
            'deficit_area_frac' => null,
            'combined_value' => null,
            'combined_state' => null,
            'units' => null,
            'channels' => [],
            'preview_sha256' => null,
        ];
    }

    /**
     * Full detail for named layers, in build order.
     *
     * The timeline comes from the session index; this is what the viewer asks
     * for once it knows which layers it is actually going to show -- the
     * selected one and its neighbours -- so the metrics, the processor and the
     * media list are fetched a screenful at a time instead of for the build.
     *
     * @param list<int> $ids
     * @return list<array<string, mixed>>
     */
    public function layersByIds(
        string $monitorId,
        ?int $sessionId,
        bool $unassigned,
        array $ids,
        string $basePath,
    ): array {
        if ($ids === []) {
            return [];
        }
        // The scope clause is bound by name, and PDO refuses a statement that
        // mixes named and positional placeholders, so the list is named too.
        $names = [];
        foreach (array_keys(array_values($ids)) as $position) {
            $names[] = ":layer_id{$position}";
        }
        $sql = $this->selectClause() . $this->scopeClause($unassigned)
            . ' AND p.id IN (' . implode(',', $names) . ')'
            . ' ORDER BY p.run_local_id ASC, p.layer_index ASC, p.id ASC';
        $statement = $this->database->prepare($sql);
        $this->bindScope($statement, $monitorId, $sessionId, $unassigned);
        foreach (array_values($ids) as $position => $id) {
            $statement->bindValue("layer_id{$position}", $id, PDO::PARAM_INT);
        }
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
            // Named the same way the session index names it, so a layer that
            // arrives live through the poll gets the same filmstrip chip as one
            // read from the index rather than the full evidence frame.
            $previewSha = self::previewSha($manifest['media']);
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
                'preview_url' => $previewSha === null
                    ? null
                    : $basePath . '/api/v1/media/' . $previewSha,
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
