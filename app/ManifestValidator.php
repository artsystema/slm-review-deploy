<?php

declare(strict_types=1);

namespace SlmReview;

use DateTimeImmutable;
use DateTimeInterface;

final class ValidatedMedia
{
    public function __construct(
        public readonly string $sha256,
        public readonly string $mediaType,
        public readonly int $width,
        public readonly int $height,
    ) {
    }
}

final class ValidatedManifest
{
    /** @param list<ValidatedMedia> $media */
    public function __construct(
        public readonly string $publicationKey,
        public readonly string $monitorInstanceId,
        public readonly ?int $sessionLocalId,
        public readonly ?string $sessionName,
        public readonly string $sessionState,
        public readonly int $runLocalId,
        public readonly int $analysisId,
        public readonly int $layerIndex,
        public readonly string $capturedAt,
        public readonly string $analysisStatus,
        public readonly string $severity,
        public readonly string $state,
        public readonly string $keyViewState,
        public readonly array $media,
    ) {
    }
}

final class ManifestValidator
{
    /** @param array<string, mixed> $manifest */
    public static function validate(array $manifest): ValidatedManifest
    {
        self::exactKeys($manifest, [
            'schema_version', 'publication_key', 'monitor', 'session', 'run', 'layer', 'analysis',
            'argon_snapshot', 'key_view_state', 'media',
        ], 'manifest');
        if (($manifest['schema_version'] ?? null) !== 1) {
            throw new HttpError(422, 'unsupported manifest schema version');
        }
        $key = self::string($manifest['publication_key'], 'publication_key', 71);
        if (preg_match('/^sha256:[0-9a-f]{64}$/D', $key) !== 1) {
            throw new HttpError(422, 'publication_key is invalid');
        }
        $monitor = self::object($manifest['monitor'], 'monitor');
        self::exactKeys($monitor, ['instance_id', 'software_version'], 'monitor');
        $monitorId = self::string($monitor['instance_id'], 'monitor.instance_id', 36);
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/Di', $monitorId) !== 1) {
            throw new HttpError(422, 'monitor.instance_id must be a UUID');
        }
        self::string($monitor['software_version'], 'monitor.software_version', 100);

        $session = self::object($manifest['session'], 'session');
        self::exactKeys($session, ['local_id', 'name', 'state'], 'session');
        $sessionId = self::nullablePositiveInt($session['local_id'], 'session.local_id');
        $sessionName = self::nullableString($session['name'], 'session.name', 255);
        $sessionState = self::string($session['state'], 'session.state', 50);

        $run = self::object($manifest['run'], 'run');
        self::exactKeys($run, ['local_id', 'processor', 'processor_version', 'rules_version', 'profile_name'], 'run');
        $runId = self::positiveInt($run['local_id'], 'run.local_id');
        foreach (['processor', 'processor_version', 'rules_version', 'profile_name'] as $field) {
            self::string($run[$field], "run.{$field}", 255);
        }

        $layer = self::object($manifest['layer'], 'layer');
        self::exactKeys($layer, ['analysis_id', 'index', 'label', 'captured_at'], 'layer');
        $analysisId = self::positiveInt($layer['analysis_id'], 'layer.analysis_id');
        $layerIndex = self::nonNegativeInt($layer['index'], 'layer.index');
        self::string($layer['label'], 'layer.label', 1024);
        $capturedAt = self::timestamp($layer['captured_at'], 'layer.captured_at');

        $analysis = self::object($manifest['analysis'], 'analysis');
        self::exactKeys($analysis, [
            'status', 'severity', 'state', 'confidence', 'deficit_area_frac', 'metrics', 'reason',
        ], 'analysis');
        $status = self::string($analysis['status'], 'analysis.status', 50);
        $severity = self::string($analysis['severity'], 'analysis.severity', 50);
        $state = self::string($analysis['state'], 'analysis.state', 100);
        self::finiteNumber($analysis['confidence'], 'analysis.confidence');
        self::nullableFiniteNumber($analysis['deficit_area_frac'], 'analysis.deficit_area_frac');
        self::numericMap($analysis['metrics'], 'analysis.metrics');
        self::string($analysis['reason'], 'analysis.reason', 4096);

        $argon = self::object($manifest['argon_snapshot'], 'argon_snapshot');
        self::exactKeys($argon, ['captured_at', 'channels', 'combined'], 'argon_snapshot');
        self::timestamp($argon['captured_at'], 'argon_snapshot.captured_at');
        self::validateArgon($argon);

        $keyViewState = self::string($manifest['key_view_state'], 'key_view_state', 20);
        if (!in_array($keyViewState, ['available', 'unavailable'], true)) {
            throw new HttpError(422, 'key_view_state is invalid');
        }
        if (!is_array($manifest['media']) || !array_is_list($manifest['media'])) {
            throw new HttpError(422, 'media must be an array');
        }
        $media = [];
        foreach ($manifest['media'] as $index => $item) {
            $entry = self::object($item, "media[{$index}]");
            self::exactKeys($entry, ['role', 'stage', 'path', 'media_type', 'sha256', 'width', 'height'], "media[{$index}]");
            if ($entry['role'] !== 'key_view' || $entry['path'] !== 'key-view.jpg' || $entry['media_type'] !== 'image/jpeg') {
                throw new HttpError(422, 'only image/jpeg key-view.jpg media is supported');
            }
            if ($entry['stage'] !== null && !is_string($entry['stage'])) {
                throw new HttpError(422, 'media stage must be a string or null');
            }
            $sha256 = self::string($entry['sha256'], "media[{$index}].sha256", 64);
            if (preg_match('/^[0-9a-f]{64}$/D', $sha256) !== 1) {
                throw new HttpError(422, 'media sha256 is invalid');
            }
            $media[] = new ValidatedMedia(
                $sha256,
                'image/jpeg',
                self::positiveInt($entry['width'], "media[{$index}].width"),
                self::positiveInt($entry['height'], "media[{$index}].height"),
            );
        }
        if (($keyViewState === 'available' && count($media) !== 1) || ($keyViewState === 'unavailable' && $media !== [])) {
            throw new HttpError(422, 'key view state and declared media disagree');
        }

        return new ValidatedManifest(
            $key, $monitorId, $sessionId, $sessionName, $sessionState, $runId, $analysisId,
            $layerIndex, $capturedAt, $status, $severity, $state, $keyViewState, $media,
        );
    }

    /** @param array<string, mixed> $value @param list<string> $expected */
    private static function exactKeys(array $value, array $expected, string $context): void
    {
        $actual = array_keys($value);
        sort($actual);
        sort($expected);
        if ($actual !== $expected) {
            throw new HttpError(422, "{$context} fields are invalid");
        }
    }

    /** @return array<string, mixed> */
    private static function object(mixed $value, string $field): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw new HttpError(422, "{$field} must be an object");
        }
        return $value;
    }

    private static function string(mixed $value, string $field, int $maximumLength): string
    {
        if (!is_string($value) || $value === '' || strlen($value) > $maximumLength) {
            throw new HttpError(422, "{$field} is invalid");
        }
        return $value;
    }

    private static function nullableString(mixed $value, string $field, int $maximumLength): ?string
    {
        return $value === null ? null : self::string($value, $field, $maximumLength);
    }

    private static function positiveInt(mixed $value, string $field): int
    {
        if (!is_int($value) || $value <= 0) {
            throw new HttpError(422, "{$field} must be a positive integer");
        }
        return $value;
    }

    private static function nullablePositiveInt(mixed $value, string $field): ?int
    {
        return $value === null ? null : self::positiveInt($value, $field);
    }

    private static function nonNegativeInt(mixed $value, string $field): int
    {
        if (!is_int($value) || $value < 0) {
            throw new HttpError(422, "{$field} must be a non-negative integer");
        }
        return $value;
    }

    private static function finiteNumber(mixed $value, string $field): float
    {
        if ((!is_int($value) && !is_float($value)) || !is_finite((float) $value)) {
            throw new HttpError(422, "{$field} must be finite numeric data");
        }
        return (float) $value;
    }

    private static function nullableFiniteNumber(mixed $value, string $field): ?float
    {
        return $value === null ? null : self::finiteNumber($value, $field);
    }

    /** @param array<string, mixed> $value */
    private static function numericMap(mixed $value, string $field): void
    {
        // PHP decodes both {} and [] as an empty array with assoc=true. The
        // monitor emits an object here, but an empty metric map is legitimate.
        if ($value === []) {
            return;
        }
        $map = self::object($value, $field);
        foreach ($map as $key => $number) {
            self::string($key, "{$field} key", 255);
            self::finiteNumber($number, "{$field}.{$key}");
        }
    }

    private static function timestamp(mixed $value, string $field): string
    {
        $timestamp = self::string($value, $field, 64);
        if (preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/D', $timestamp) !== 1) {
            throw new HttpError(422, "{$field} must be an ISO-8601 timestamp");
        }
        try {
            $parsed = new DateTimeImmutable($timestamp);
        } catch (\Exception) {
            throw new HttpError(422, "{$field} must be an ISO-8601 timestamp");
        }
        if ($parsed->format(DateTimeInterface::ATOM) === '') {
            throw new HttpError(422, "{$field} must be an ISO-8601 timestamp");
        }
        return $timestamp;
    }

    /** @param array<string, mixed> $snapshot */
    private static function validateArgon(array $snapshot): void
    {
        if (!is_array($snapshot['channels']) || !array_is_list($snapshot['channels'])) {
            throw new HttpError(422, 'argon_snapshot.channels must be an array');
        }
        foreach ($snapshot['channels'] as $index => $channel) {
            $entry = self::object($channel, "argon_snapshot.channels[{$index}]");
            self::exactKeys($entry, [
                'channel', 'device_id', 'reading_status', 'observed_at', 'value', 'reliable_at',
                'age_ms', 'units',
            ], "argon_snapshot.channels[{$index}]");
            self::positiveInt($entry['channel'], "argon_snapshot.channels[{$index}].channel");
            self::positiveInt($entry['device_id'], "argon_snapshot.channels[{$index}].device_id");
            self::string($entry['reading_status'], "argon_snapshot.channels[{$index}].reading_status", 50);
            if ($entry['observed_at'] !== null) {
                self::timestamp($entry['observed_at'], "argon_snapshot.channels[{$index}].observed_at");
            }
            self::nullableFiniteNumber($entry['value'], "argon_snapshot.channels[{$index}].value");
            if ($entry['reliable_at'] !== null) {
                self::timestamp($entry['reliable_at'], "argon_snapshot.channels[{$index}].reliable_at");
            }
            if ($entry['age_ms'] !== null) {
                self::nonNegativeInt($entry['age_ms'], "argon_snapshot.channels[{$index}].age_ms");
            }
            self::nullableString($entry['units'], "argon_snapshot.channels[{$index}].units", 50);
        }
        $combined = self::object($snapshot['combined'], 'argon_snapshot.combined');
        self::exactKeys($combined, ['value', 'state', 'units'], 'argon_snapshot.combined');
        self::nullableFiniteNumber($combined['value'], 'argon_snapshot.combined.value');
        $state = self::string($combined['state'], 'argon_snapshot.combined.state', 20);
        if (!in_array($state, ['complete', 'partial', 'unknown'], true)) {
            throw new HttpError(422, 'argon_snapshot.combined.state is invalid');
        }
        self::nullableString($combined['units'], 'argon_snapshot.combined.units', 50);
    }
}
