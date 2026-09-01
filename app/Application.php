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
            $limit = self::limit($request, 120, 1, 250);
            $sinceId = self::sinceQuery($request);
            if ($sinceId !== null) {
                // Poll for what arrived, so a viewer following a live build never
                // reloads. Ordering by arrival is deliberate; see layersSince().
                $layers = $this->review->layersSince(
                    $monitorId, $sessionId, $unassigned, $sinceId, $limit, $request->basePath()
                );
                Response::json(200, [
                    'layers' => $layers,
                    'latest_id' => $layers === []
                        ? $sinceId
                        : $layers[count($layers) - 1]['id'],
                    'more' => count($layers) === $limit,
                ]);
            }
            $layers = $this->review->layers(
                $monitorId,
                $sessionId,
                $unassigned,
                self::beforeCursor($request),
                $limit,
                $request->basePath(),
            );
            Response::json(200, [
                'layers' => array_reverse($layers),
                // Exhausted only when the window came back short; a full window
                // may still be followed by nothing, and one empty fetch settles it.
                'next_before' => count($layers) < $limit ? null : self::cursorOf($layers[count($layers) - 1]),
                'latest_id' => $this->review->latestPublicationId($monitorId, $sessionId, $unassigned),
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

    /**
     * The polling watermark, which is zero for a viewer that has seen nothing.
     * Rejecting zero would make the very first publication in the database
     * unreachable by the poll, since it asks for ids strictly greater.
     */
    private static function sinceQuery(Request $request): ?int
    {
        $value = $request->query('since_id');
        if ($value === null) {
            return null;
        }
        if (!ctype_digit($value)) {
            throw new HttpError(422, 'since_id must be a non-negative integer');
        }
        return (int) $value;
    }

    /**
     * The "load earlier" cursor. Build order is (run, layer, id), so paging back
     * through it needs all three: layer_index alone repeats across runs, and id
     * alone is arrival order, which is the ordering this cursor exists to avoid.
     *
     * @return array{run: int, layer: int, id: int}|null
     */
    private static function beforeCursor(Request $request): ?array
    {
        $run = $request->query('before_run_local_id');
        $layer = $request->query('before_layer_index');
        $id = $request->query('before_id');
        if ($run === null && $layer === null && $id === null) {
            return null;
        }
        // layer_index is zero-based, so it is validated separately from the ids.
        if ($run === null || $layer === null || $id === null
            || !ctype_digit($run) || !ctype_digit($layer) || !ctype_digit($id)
            || (int) $run <= 0 || (int) $id <= 0
        ) {
            throw new HttpError(422, 'before_run_local_id, before_layer_index and before_id must be sent together');
        }
        return ['run' => (int) $run, 'layer' => (int) $layer, 'id' => (int) $id];
    }

    /**
     * @param array<string, mixed> $layer
     * @return array{run: int, layer: int, id: int}
     */
    private static function cursorOf(array $layer): array
    {
        return [
            'run' => (int) $layer['run_local_id'],
            'layer' => (int) $layer['index'],
            'id' => (int) $layer['id'],
        ];
    }

    private static function page(): string
    {
        return <<<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>SLM Remote Review</title>
  <link rel="stylesheet" href="assets/review.css">
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">SLM</span><div><strong>Remote review</strong><small>Layer evidence</small></div></div>
      <label class="session-picker"><span>Session</span><select id="session-select" aria-label="Review session"><option>Loading sessions...</option></select></label>
      <button id="follow-toggle" class="follow-toggle" type="button" aria-pressed="true" title="Jump to each new layer as it arrives">
        <span class="follow-dot"></span><span class="follow-text">Live</span>
      </button>
      <span class="read-only-chip">read only</span>
    </header>
    <main class="review-shell">
      <section id="notice" class="notice" aria-live="polite">Loading committed sessions...</section>
      <section class="selected-grid" aria-label="Selected layer">
        <article class="panel viewer-card">
          <div id="evidence-selector" class="evidence-selector" role="tablist" aria-label="Layer evidence views"></div>
          <div id="stage" class="stage">
            <div id="stage-viewport" class="stage-viewport">
              <img id="stage-image" class="stage-image" alt="" draggable="false">
            </div>
            <div id="stage-grid" class="stage-grid" role="list" hidden></div>
            <p id="stage-empty" class="stage-empty">No frame selected.</p>
            <div class="stage-controls" role="group" aria-label="View controls">
              <button id="grid-toggle" class="grid-toggle" type="button" aria-pressed="false" aria-label="Show every view at once">
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
              </button>
              <button id="fill-toggle" class="fill-toggle" type="button" aria-pressed="false" aria-label="Fill the panel">
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M5 6.5h6M5 9.5h6"/></svg>
              </button>
              <span class="stage-controls-divider" aria-hidden="true"></span>
              <button id="zoom-out" type="button" aria-label="Zoom out">&minus;</button>
              <button id="zoom-reset" type="button" aria-label="Reset zoom">1&times;</button>
              <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
            </div>
            <div id="stage-hint" class="stage-hint" aria-hidden="true"></div>
          </div>
          <p id="frame-caption" class="frame-caption">No evidence selected.</p>
          <div class="timeline">
            <div id="scrubber" class="scrubber" role="slider" tabindex="0" aria-label="Layer timeline"
                 aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="No layers">
              <canvas id="scrub-canvas" class="scrub-canvas" aria-hidden="true"></canvas>
              <div id="scrub-playhead" class="scrub-playhead" aria-hidden="true"></div>
              <div id="scrub-bubble" class="scrub-bubble" aria-hidden="true"></div>
            </div>
            <div class="timeline-foot">
              <button id="load-earlier" class="load-earlier" type="button" hidden>Load earlier</button>
              <span id="timeline-count" class="timeline-count"></span>
              <span class="keyboard-hint">Drag to scrub &middot; arrows to step &middot; double-tap to zoom</span>
            </div>
            <div id="filmstrip" class="filmstrip" role="listbox" aria-label="Layer filmstrip"></div>
          </div>
        </article>
        <aside class="panel evidence-card">
          <div class="selected-heading"><div><p class="eyebrow">SELECTED LAYER</p><h1 id="layer-title">No layer</h1></div><span id="layer-severity" class="severity-badge severity-unknown">unknown</span></div>
          <p id="analysis-reason" class="analysis-reason">Select a committed layer to inspect its result.</p>
          <dl id="layer-facts"></dl>
          <section class="argon-panel"><div class="subheading"><span>Argon snapshot</span><strong id="argon-combined">--</strong></div><div id="argon-state" class="argon-state">Argon context unavailable.</div></section>
        </aside>
      </section>
      <section class="metrics-grid">
        <article class="panel chart-card"><div class="chart-heading"><div><p class="eyebrow">ROLLING QUALITY</p><h2>Defect rate</h2></div><strong id="defect-rate">--</strong></div><canvas id="defect-chart" height="132" aria-label="Rolling defect rate chart"></canvas><p id="defect-note" class="chart-note"></p></article>
        <article class="panel chart-card"><div class="chart-heading"><div><p class="eyebrow">CAPTURED WITH LAYER</p><h2>Argon channels</h2></div><strong id="argon-label">--</strong></div><div id="argon-legend" class="chart-legend"></div><canvas id="argon-chart" height="132" aria-label="Argon snapshot chart"></canvas><p class="chart-note">Gaps mean no reliable reading. Values are never interpolated.</p></article>
      </section>
    </main>
  </div>
  <script src="assets/review.js" defer></script>
</body>
</html>
HTML;
    }
}
