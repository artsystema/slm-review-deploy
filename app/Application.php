<?php

declare(strict_types=1);

namespace SlmReview;

use PDOException;

final class Application
{
    private function __construct(
        private Config $config,
        private PublicationRepository $publications,
        private ReviewRepository $review,
        private MediaStore $mediaStore,
    ) {
    }

    public static function run(): never
    {
        $root = dirname(__DIR__);
        $config = Config::load($root);
        $database = $config->database();
        $mediaStore = new MediaStore($config->storageDir());
        $application = new self(
            $config,
            new PublicationRepository($database, $mediaStore),
            new ReviewRepository($database),
            $mediaStore,
        );
        try {
            $application->dispatch(Request::fromGlobals());
        } catch (HttpError $exception) {
            Response::json($exception->status, ['error' => $exception->getMessage()]);
        } catch (PDOException $exception) {
            error_log('SLM remote review database error: ' . $exception->getMessage());
            Response::json(503, ['error' => 'database is temporarily unavailable']);
        }
    }

    private function dispatch(Request $request): never
    {
        $method = $request->method();
        $path = $request->path();
        if ($method === 'GET' && $path === '/') {
            Response::html(self::page());
        }
        if ($method === 'GET' && $path === '/api/v1/health') {
            Response::json(200, ['status' => 'ok']);
        }
        if ($method === 'POST' && $path === '/api/v1/ingest/publications') {
            $this->requireIngestToken($request);
            $body = $request->jsonBody($this->config->maxManifestBytes());
            $manifest = ManifestValidator::validate($body['value']);
            Response::json(201, $this->publications->announce($manifest, $body['raw']));
        }
        if ($method === 'POST' && preg_match('#^/api/v1/ingest/publications/(sha256%3A[0-9a-f]{64}|sha256:[0-9a-f]{64})/commit$#D', $path, $matches) === 1) {
            $this->requireIngestToken($request);
            Response::json(200, $this->publications->commit(rawurldecode($matches[1])));
        }
        if ($method === 'PUT' && preg_match('#^/api/v1/ingest/publications/(sha256%3A[0-9a-f]{64}|sha256:[0-9a-f]{64})/media/([0-9a-f]{64})$#D', $path, $matches) === 1) {
            $this->requireIngestToken($request);
            $declaredHash = $request->header('X-Content-SHA256');
            if (!is_string($declaredHash) || !hash_equals($matches[2], $declaredHash)) {
                throw new HttpError(422, 'X-Content-SHA256 does not match URL');
            }
            $contentType = $request->header('Content-Type') ?? '';
            if (strtolower($contentType) !== 'image/jpeg') {
                throw new HttpError(415, 'Content-Type must be image/jpeg');
            }
            $this->publications->upload(
                rawurldecode($matches[1]), $matches[2], $request->body($this->config->maxMediaBytes())
            );
            Response::json(201, ['status' => 'stored']);
        }
        if ($method === 'GET' && $path === '/api/v1/sessions') {
            Response::json(200, ['sessions' => $this->review->sessions(self::limit($request, 50, 1, 100))]);
        }
        if ($method === 'GET' && $path === '/api/v1/layers') {
            $monitorId = $request->query('monitor_instance_id');
            if (!is_string($monitorId) || preg_match('/^[0-9a-f-]{36}$/Di', $monitorId) !== 1) {
                throw new HttpError(422, 'monitor_instance_id is required');
            }
            $unassigned = $request->query('unassigned') === 'true';
            $sessionId = $unassigned ? null : self::positiveQuery($request, 'session_id', true);
            $beforeId = self::positiveQuery($request, 'before_id', false) ?? 0;
            $layers = $this->review->layers(
                $monitorId,
                $sessionId,
                $unassigned,
                $beforeId,
                self::limit($request, 120, 1, 250),
                $request->basePath(),
            );
            Response::json(200, [
                'layers' => array_reverse($layers),
                'next_before_id' => $layers === [] ? null : $layers[count($layers) - 1]['id'],
            ]);
        }
        if ($method === 'GET' && preg_match('#^/api/v1/media/([0-9a-f]{64})$#D', $path, $matches) === 1) {
            $media = $this->review->media($matches[1]);
            if ($media === null) {
                throw new HttpError(404, 'media is unavailable');
            }
            $path = $this->mediaStore->absolutePath($media['path']);
            if (!is_file($path)) {
                throw new HttpError(404, 'media object is unavailable');
            }
            Response::media($path, $media['media_type'], $media['size']);
        }
        throw new HttpError(404, 'route was not found');
    }

    private function requireIngestToken(Request $request): void
    {
        // cPanel Directory Privacy owns HTTP Basic authentication. The agent
        // moves its ingest bearer to this header when Basic Auth is enabled.
        $authorization = $request->header('X-SLM-Ingest-Authorization') ?? $request->header('Authorization');
        if (!is_string($authorization) || !str_starts_with($authorization, 'Bearer ')) {
            throw new HttpError(401, 'ingest authorization is required');
        }
        $token = substr($authorization, 7);
        if (!hash_equals($this->config->ingestToken(), $token)) {
            throw new HttpError(403, 'ingest authorization is invalid');
        }
    }

    private static function limit(Request $request, int $default, int $minimum, int $maximum): int
    {
        $value = $request->query('limit');
        if ($value === null) {
            return $default;
        }
        if (!ctype_digit($value) || (int) $value < $minimum || (int) $value > $maximum) {
            throw new HttpError(422, "limit must be between {$minimum} and {$maximum}");
        }
        return (int) $value;
    }

    private static function positiveQuery(Request $request, string $name, bool $required): ?int
    {
        $value = $request->query($name);
        if ($value === null && !$required) {
            return null;
        }
        if ($value === null || !ctype_digit($value) || (int) $value <= 0) {
            throw new HttpError(422, "{$name} must be a positive integer");
        }
        return (int) $value;
    }

    private static function page(): string
    {
        return <<<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>SLM Remote Review</title>
  <link rel="stylesheet" href="assets/review.css">
</head>
<body>
  <main class="review-shell">
    <header class="masthead">
      <p class="eyebrow">REMOTE EVIDENCE REVIEW</p>
      <div><h1>Layer trace</h1><p>Read-only review. Remote data is not a machine-control signal.</p></div>
      <label class="session-picker">Session<select id="session-select" aria-label="Review session"><option>Loading sessions...</option></select></label>
    </header>
    <section id="notice" class="notice" aria-live="polite">Loading committed sessions...</section>
    <section class="selected-grid" aria-label="Selected layer">
      <article class="frame-card"><div id="image-wrap" class="image-wrap"><p>No frame selected.</p></div></article>
      <aside class="evidence-card"><p class="eyebrow">SELECTED LAYER</p><h2 id="layer-title">No layer</h2><dl id="layer-facts"></dl><div id="argon-state" class="argon-state">Argon context unavailable.</div></aside>
    </section>
    <section class="metrics-grid">
      <article class="chart-card"><div class="chart-heading"><div><p class="eyebrow">ROLLING QUALITY</p><h2>Defect rate</h2></div><strong id="defect-rate">--</strong></div><canvas id="defect-chart" height="180" aria-label="Rolling defect rate chart"></canvas><p id="defect-note" class="chart-note"></p></article>
      <article class="chart-card"><div class="chart-heading"><div><p class="eyebrow">CAPTURED WITH LAYER</p><h2>Argon channels</h2></div><strong id="argon-label">--</strong></div><canvas id="argon-chart" height="180" aria-label="Argon snapshot chart"></canvas><p class="chart-note">Gaps mean no reliable reading. Values are never interpolated.</p></article>
    </section>
    <section class="filmstrip-section"><div><p class="eyebrow">TIMELINE</p><h2>Scrub layers</h2></div><div id="filmstrip" class="filmstrip" role="listbox" aria-label="Layer timeline"></div><button id="load-earlier" class="load-earlier" type="button" hidden>Load earlier layers</button></section>
  </main>
  <script src="assets/review.js" defer></script>
</body>
</html>
HTML;
    }
}
