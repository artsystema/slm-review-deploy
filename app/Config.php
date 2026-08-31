<?php

declare(strict_types=1);

namespace SlmReview;

use PDO;
use RuntimeException;

final class Config
{
    /** @param array<string, mixed> $values */
    private function __construct(private array $values)
    {
    }

    public static function load(string $applicationRoot): self
    {
        $path = $applicationRoot . '/private/config.php';
        if (!is_file($path)) {
            throw new RuntimeException('private/config.php is missing');
        }
        $values = require $path;
        if (!is_array($values)) {
            throw new RuntimeException('remote review configuration must return an array');
        }
        foreach (['database', 'storage_dir', 'ingest_token', 'max_manifest_bytes', 'max_media_bytes'] as $key) {
            if (!array_key_exists($key, $values)) {
                throw new RuntimeException("remote review configuration is missing {$key}");
            }
        }
        if (!is_array($values['database'])) {
            throw new RuntimeException('database configuration must be an array');
        }
        foreach (['host', 'port', 'name', 'username', 'password'] as $key) {
            if (!array_key_exists($key, $values['database'])) {
                throw new RuntimeException("database configuration is missing {$key}");
            }
        }
        if (!is_string($values['storage_dir']) || $values['storage_dir'] === '') {
            throw new RuntimeException('storage_dir must be a non-empty string');
        }
        if (!is_string($values['ingest_token']) || strlen($values['ingest_token']) < 32) {
            throw new RuntimeException('ingest_token must be a long random secret');
        }
        foreach (['max_manifest_bytes', 'max_media_bytes'] as $key) {
            if (!is_int($values[$key]) || $values[$key] <= 0) {
                throw new RuntimeException("{$key} must be a positive integer");
            }
        }
        return new self($values);
    }

    public function database(): PDO
    {
        /** @var array<string, string|int> $database */
        $database = $this->values['database'];
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            $database['host'],
            $database['port'],
            $database['name']
        );
        return new PDO($dsn, (string) $database['username'], (string) $database['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    }

    public function storageDir(): string
    {
        /** @var string $storageDir */
        $storageDir = $this->values['storage_dir'];
        return $storageDir;
    }

    public function ingestToken(): string
    {
        /** @var string $token */
        $token = $this->values['ingest_token'];
        return $token;
    }

    public function maxManifestBytes(): int
    {
        /** @var int $value */
        $value = $this->values['max_manifest_bytes'];
        return $value;
    }

    public function maxMediaBytes(): int
    {
        /** @var int $value */
        $value = $this->values['max_media_bytes'];
        return $value;
    }
}
