<?php

declare(strict_types=1);

namespace SlmReview;

use PDO;

final class PublicationRepository
{
    public function __construct(private PDO $database, private MediaStore $mediaStore)
    {
    }

    /** @return array{status: string, missing_media: list<string>} */
    public function announce(ValidatedManifest $manifest, string $rawManifest): array
    {
        $manifestHash = hash('sha256', $rawManifest);
        $this->database->beginTransaction();
        try {
            $existing = $this->findPublication($manifest->publicationKey, true);
            if ($existing !== null) {
                if (!hash_equals($existing['manifest_sha256'], $manifestHash)) {
                    throw new HttpError(409, 'publication key already exists with different manifest content');
                }
                $missing = $existing['status'] === 'committed' ? [] : $this->missingMedia((int) $existing['id']);
                $this->database->commit();
                return ['status' => $existing['status'], 'missing_media' => $missing];
            }
            $statement = $this->database->prepare(
                'INSERT INTO publications (
                    publication_key, monitor_instance_id, monitor_software_version,
                    session_local_id, session_name, session_state,
                    run_local_id, layer_analysis_id, layer_index, captured_at, analysis_status, severity,
                    analysis_state, key_view_state, manifest_sha256, manifest_json, status
                ) VALUES (
                    :publication_key, :monitor_instance_id, :monitor_software_version,
                    :session_local_id, :session_name, :session_state,
                    :run_local_id, :layer_analysis_id, :layer_index, :captured_at, :analysis_status, :severity,
                    :analysis_state, :key_view_state, :manifest_sha256, :manifest_json, \'staged\'
                )'
            );
            $statement->execute([
                'publication_key' => $manifest->publicationKey,
                'monitor_instance_id' => $manifest->monitorInstanceId,
                'monitor_software_version' => $manifest->monitorSoftwareVersion,
                'session_local_id' => $manifest->sessionLocalId,
                'session_name' => $manifest->sessionName,
                'session_state' => $manifest->sessionState,
                'run_local_id' => $manifest->runLocalId,
                'layer_analysis_id' => $manifest->analysisId,
                'layer_index' => $manifest->layerIndex,
                'captured_at' => $manifest->capturedAt,
                'analysis_status' => $manifest->analysisStatus,
                'severity' => $manifest->severity,
                'analysis_state' => $manifest->state,
                'key_view_state' => $manifest->keyViewState,
                'manifest_sha256' => $manifestHash,
                'manifest_json' => $rawManifest,
            ]);
            $publicationId = (int) $this->database->lastInsertId();
            foreach ($manifest->media as $media) {
                $link = $this->database->prepare(
                    'INSERT INTO publication_media (publication_id, role, media_sha256, media_type, width, height)
                     VALUES (:publication_id, :role, :media_sha256, :media_type, :width, :height)'
                );
                $link->execute([
                    'publication_id' => $publicationId,
                    'role' => $media->role,
                    'media_sha256' => $media->sha256,
                    'media_type' => $media->mediaType,
                    'width' => $media->width,
                    'height' => $media->height,
                ]);
            }
            $missing = $this->missingMedia($publicationId);
            $this->database->commit();
            return ['status' => 'staged', 'missing_media' => $missing];
        } catch (\Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }
    }

    public function upload(string $publicationKey, string $sha256, string $contents): void
    {
        $publication = $this->findPublication($publicationKey, false);
        if ($publication === null) {
            throw new HttpError(404, 'publication was not announced');
        }
        $link = $this->database->prepare(
            'SELECT media_type FROM publication_media WHERE publication_id = :publication_id AND media_sha256 = :sha256'
        );
        $link->execute(['publication_id' => $publication['id'], 'sha256' => $sha256]);
        $expected = $link->fetch();
        if ($expected === false) {
            throw new HttpError(404, 'media hash is not declared by this publication');
        }
        if ($expected['media_type'] !== 'image/jpeg') {
            throw new HttpError(422, 'declared media type is unsupported');
        }
        $stored = $this->mediaStore->storeJpeg($sha256, $contents);
        $statement = $this->database->prepare(
            'INSERT INTO media_objects (sha256, media_type, storage_path, size_bytes)
             VALUES (:sha256, \'image/jpeg\', :storage_path, :size_bytes)
             ON DUPLICATE KEY UPDATE sha256 = VALUES(sha256)'
        );
        $statement->execute([
            'sha256' => $sha256,
            'storage_path' => $stored->relativePath,
            'size_bytes' => $stored->size,
        ]);
    }

    /** @return array{status: string, missing_media: list<string>} */
    public function commit(string $publicationKey): array
    {
        $this->database->beginTransaction();
        try {
            $publication = $this->findPublication($publicationKey, true);
            if ($publication === null) {
                throw new HttpError(404, 'publication was not announced');
            }
            if ($publication['status'] === 'committed') {
                $this->database->commit();
                return ['status' => 'committed', 'missing_media' => []];
            }
            $missing = $this->missingMedia((int) $publication['id']);
            if ($missing !== []) {
                throw new HttpError(409, 'publication has missing media');
            }
            $statement = $this->database->prepare(
                'UPDATE publications SET status = \'committed\', committed_at = UTC_TIMESTAMP(6)
                 WHERE id = :id AND status = \'staged\''
            );
            $statement->execute(['id' => $publication['id']]);
            $this->writeSummary((int) $publication['id'], (string) $publication['manifest_json']);
            $this->database->commit();
            return ['status' => 'committed', 'missing_media' => []];
        } catch (\Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }
    }

    /** @return list<string> */
    private function missingMedia(int $publicationId): array
    {
        $statement = $this->database->prepare(
            'SELECT pm.media_sha256, mo.storage_path
             FROM publication_media pm
             LEFT JOIN media_objects mo ON mo.sha256 = pm.media_sha256
             WHERE pm.publication_id = :publication_id'
        );
        $statement->execute(['publication_id' => $publicationId]);
        $missing = [];
        foreach ($statement->fetchAll() as $row) {
            if ($row['storage_path'] === null || !is_file($this->mediaStore->absolutePath($row['storage_path']))) {
                $missing[] = $row['media_sha256'];
            }
        }
        return $missing;
    }

    /**
     * Record the timeline fields beside the manifest as the layer commits.
     *
     * The session index reads these columns rather than thousands of manifests.
     * Doing it here means a layer is summarised once, by the request that
     * published it, instead of by whichever reviewer happens to open the build
     * first. The read path still copes with rows that predate this.
     */
    private function writeSummary(int $publicationId, string $manifestJson): void
    {
        $summary = ReviewRepository::summaryOfManifest($manifestJson);
        $statement = $this->database->prepare(
            'UPDATE publications
                SET summary_version = :version, deficit_area_frac = :deficit,
                    argon_combined_value = :combined_value, argon_combined_state = :combined_state,
                    argon_units = :units, argon_channels_json = :channels, preview_sha256 = :preview
              WHERE id = :id'
        );
        $statement->execute([
            'version' => ReviewRepository::SUMMARY_VERSION,
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
            'id' => $publicationId,
        ]);
    }

    /** @return array<string, mixed>|null */
    private function findPublication(string $publicationKey, bool $forUpdate): ?array
    {
        $statement = $this->database->prepare(
            'SELECT id, status, manifest_sha256, manifest_json FROM publications
             WHERE publication_key = :publication_key'
            . ($forUpdate ? ' FOR UPDATE' : '')
        );
        $statement->execute(['publication_key' => $publicationKey]);
        $result = $statement->fetch();
        return $result === false ? null : $result;
    }
}
