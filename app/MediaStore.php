<?php

declare(strict_types=1);

namespace SlmReview;

use RuntimeException;

final class StoredMedia
{
    public function __construct(
        public readonly string $relativePath,
        public readonly int $size,
    ) {
    }
}

final class MediaStore
{
    public function __construct(private string $storageDirectory)
    {
        if (!is_dir($storageDirectory) && !mkdir($storageDirectory, 0700, true) && !is_dir($storageDirectory)) {
            throw new RuntimeException('could not create private media storage directory');
        }
    }

    public function storeJpeg(string $expectedSha256, string $contents): StoredMedia
    {
        if (!hash_equals($expectedSha256, hash('sha256', $contents))) {
            throw new HttpError(422, 'media SHA-256 does not match uploaded content');
        }
        if (!str_starts_with($contents, "\xFF\xD8\xFF")) {
            throw new HttpError(422, 'uploaded key view is not a JPEG');
        }
        $relative = 'objects/' . substr($expectedSha256, 0, 2) . '/' . $expectedSha256 . '.jpg';
        $destination = $this->pathFor($relative);
        $directory = dirname($destination);
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new RuntimeException('could not create private media object directory');
        }
        if (is_file($destination)) {
            $this->verifyExisting($destination, $expectedSha256);
            return new StoredMedia($relative, filesize($destination) ?: 0);
        }
        $temporary = $destination . '.' . bin2hex(random_bytes(8)) . '.partial';
        if (file_put_contents($temporary, $contents, LOCK_EX) === false) {
            throw new RuntimeException('could not write media object');
        }
        if (!@rename($temporary, $destination)) {
            @unlink($temporary);
            if (!is_file($destination)) {
                throw new RuntimeException('could not commit media object');
            }
        }
        $this->verifyExisting($destination, $expectedSha256);
        return new StoredMedia($relative, filesize($destination) ?: 0);
    }

    public function absolutePath(string $relativePath): string
    {
        return $this->pathFor($relativePath);
    }

    private function verifyExisting(string $path, string $expectedSha256): void
    {
        if (!is_file($path) || !hash_equals($expectedSha256, hash_file('sha256', $path) ?: '')) {
            throw new RuntimeException('private media object hash verification failed');
        }
    }

    private function pathFor(string $relativePath): string
    {
        if (preg_match('/^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/D', $relativePath) !== 1) {
            throw new RuntimeException('invalid private media path');
        }
        return rtrim($this->storageDirectory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $relativePath;
    }
}
