<?php

declare(strict_types=1);

namespace SlmReview;

use JsonException;

final class HttpError extends \RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

final class Request
{
    /** @param array<string, string> $server */
    private function __construct(private array $server)
    {
    }

    public static function fromGlobals(): self
    {
        /** @var array<string, string> $server */
        $server = $_SERVER;
        return new self($server);
    }

    public function method(): string
    {
        return strtoupper($this->server['REQUEST_METHOD'] ?? 'GET');
    }

    public function path(): string
    {
        $path = parse_url($this->server['REQUEST_URI'] ?? '/', PHP_URL_PATH);
        if (!is_string($path)) {
            throw new HttpError(400, 'request path is invalid');
        }
        $base = $this->basePath();
        if ($base !== '' && str_starts_with($path, $base . '/')) {
            $path = substr($path, strlen($base));
        }
        return '/' . ltrim($path, '/');
    }

    public function basePath(): string
    {
        $script = $this->server['SCRIPT_NAME'] ?? '/index.php';
        return rtrim(str_replace('/index.php', '', $script), '/');
    }

    public function query(string $name): ?string
    {
        $value = $_GET[$name] ?? null;
        return is_string($value) ? $value : null;
    }

    public function header(string $name): ?string
    {
        $normalized = strtoupper(str_replace('-', '_', $name));
        // PHP exposes these CGI headers without the usual HTTP_ prefix.
        $key = match ($normalized) {
            'CONTENT_TYPE', 'CONTENT_LENGTH' => $normalized,
            default => 'HTTP_' . $normalized,
        };
        $value = $this->server[$key] ?? null;
        return is_string($value) ? $value : null;
    }

    public function jsonBody(int $maximumBytes): array
    {
        $contentType = $this->header('Content-Type') ?? '';
        if (!str_starts_with(strtolower($contentType), 'application/json')) {
            throw new HttpError(415, 'Content-Type must be application/json');
        }
        $body = $this->body($maximumBytes);
        try {
            $decoded = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $exception) {
            throw new HttpError(400, 'request body is not valid JSON');
        }
        if (!is_array($decoded) || array_is_list($decoded)) {
            throw new HttpError(400, 'request JSON must be an object');
        }
        return ['value' => $decoded, 'raw' => $body];
    }

    public function body(int $maximumBytes): string
    {
        $length = $this->server['CONTENT_LENGTH'] ?? null;
        if (is_string($length) && ctype_digit($length) && (int) $length > $maximumBytes) {
            throw new HttpError(413, 'request body exceeds size limit');
        }
        $body = file_get_contents('php://input');
        if (!is_string($body) || strlen($body) > $maximumBytes) {
            throw new HttpError(413, 'request body exceeds size limit');
        }
        return $body;
    }
}

final class Response
{
    /** @param array<string, mixed> $value */
    public static function json(int $status, array $value): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        echo json_encode($value, JSON_THROW_ON_ERROR);
        exit;
    }

    public static function html(string $html): never
    {
        http_response_code(200);
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        echo $html;
        exit;
    }

    public static function media(string $path, string $mediaType, int $size): never
    {
        http_response_code(200);
        header('Content-Type: ' . $mediaType);
        header('Content-Length: ' . (string) $size);
        header('Cache-Control: private, max-age=31536000, immutable');
        header('X-Content-Type-Options: nosniff');
        readfile($path);
        exit;
    }
}
