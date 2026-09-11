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
        if ($method === 'GET' && $path === '/api/v1/layers/index') {
            // The whole build's timeline, without the per-layer detail. See
            // ReviewRepository::sessionIndex().
            $monitorId = self::monitorQuery($request);
            $unassigned = $request->query('unassigned') === 'true';
            $sessionId = $unassigned ? null : self::positiveQuery($request, 'session_id', true);
            $index = $this->review->sessionIndex(
                $monitorId,
                $sessionId,
                $unassigned,
                self::limit($request, 20000, 1, 50000),
                $request->basePath(),
            );
            Response::json(200, [
                'layers' => $index['layers'],
                // A build longer than the cap is reported rather than silently
                // shortened: a timeline missing its end is worse than a warning.
                'truncated' => $index['truncated'],
                'latest_id' => $this->review->latestPublicationId($monitorId, $sessionId, $unassigned),
            ]);
        }
        if ($method === 'GET' && $path === '/api/v1/layers') {
            $monitorId = self::monitorQuery($request);
            $unassigned = $request->query('unassigned') === 'true';
            $sessionId = $unassigned ? null : self::positiveQuery($request, 'session_id', true);
            $limit = self::limit($request, 120, 1, 250);
            $ids = self::idsQuery($request);
            if ($ids !== null) {
                // Detail for layers the viewer has already located in the
                // session index, so it fetches the screenful it shows rather
                // than the build.
                Response::json(200, [
                    'layers' => $this->review->layersByIds(
                        $monitorId, $sessionId, $unassigned, $ids, $request->basePath()
                    ),
                ]);
            }
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

    /**
     * `ids=1,2,3`, or null when the caller did not ask for named layers.
     *
     * Bounded because it becomes an IN list: a viewer needs the layers around
     * its selection, not an arbitrary slice of the build.
     *
     * @return list<int>|null
     */
    private static function idsQuery(Request $request): ?array
    {
        $value = $request->query('ids');
        if ($value === null) {
            return null;
        }
        if ($value === '') {
            throw new HttpError(422, 'ids must not be empty');
        }
        $ids = [];
        foreach (explode(',', $value) as $item) {
            if (!ctype_digit($item) || (int) $item < 1) {
                throw new HttpError(422, 'ids must be positive integers');
            }
            $ids[] = (int) $item;
        }
        $ids = array_values(array_unique($ids));
        if (count($ids) > 120) {
            throw new HttpError(422, 'ids may name at most 120 layers');
        }
        return $ids;
    }

    private static function monitorQuery(Request $request): string
    {
        $monitorId = $request->query('monitor_instance_id');
        if (!is_string($monitorId) || preg_match('/^[0-9a-f-]{36}$/Di', $monitorId) !== 1) {
            throw new HttpError(422, 'monitor_instance_id is required');
        }
        return $monitorId;
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
        $html = <<<'HTML'
<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <title>SLM Remote Review</title>
  <link rel="stylesheet" href="{{asset:review.css}}">
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">SLM</span><div><strong data-i18n="brand.title">Remote review</strong><small data-i18n="brand.subtitle">Layer evidence</small></div></div>
      <label class="session-picker"><span data-i18n="session.label">Session</span><select id="session-select" aria-label="Review session" data-i18n-aria="session.aria"><option value="" data-i18n="session.loading">Loading sessions...</option></select></label>
      <div class="display-controls">
        <label class="language-picker"><span class="sr-only" data-i18n="language.label">Language</span><select id="language-select" aria-label="Language" data-i18n-aria="language.label"><option value="en">EN</option><option value="uk">УКР</option></select></label>
        <button id="theme-toggle" class="icon-toggle" type="button" aria-label="Use light theme" data-i18n-aria="theme.light"><span aria-hidden="true">&#9788;</span></button>
      </div>
      <button id="follow-toggle" class="follow-toggle" type="button" aria-pressed="true" title="Jump to each new layer as it arrives" data-i18n-title="follow.title">
        <span class="follow-dot"></span><span class="follow-text">Live</span>
      </button>
    </header>
    <main class="review-shell">
      <section id="notice" class="notice" aria-live="polite" data-i18n="notice.loading">Loading committed sessions...</section>
      <section class="selected-grid" aria-label="Selected layer" data-i18n-aria="selected.aria">
        <article class="panel viewer-card">
          <div id="evidence-selector" class="evidence-selector" role="tablist" aria-label="Layer evidence views" data-i18n-aria="evidence.aria"></div>
          <div id="stage" class="stage">
            <div id="stage-viewport" class="stage-viewport">
              <img id="stage-image" class="stage-image" alt="" draggable="false">
            </div>
            <div id="stage-grid" class="stage-grid" role="list" hidden></div>
            <p id="stage-empty" class="stage-empty" data-i18n="evidence.none_frame">No frame selected.</p>
            <div class="stage-controls" role="group" aria-label="View controls" data-i18n-aria="view.controls">
              <button id="grid-toggle" class="grid-toggle" type="button" aria-pressed="false" aria-label="Show every view at once" data-i18n-aria="view.grid">
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
              </button>
              <button id="fill-toggle" class="fill-toggle" type="button" aria-pressed="false" aria-label="Fill the panel" data-i18n-aria="view.fill">
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M5 6.5h6M5 9.5h6"/></svg>
              </button>
              <span class="stage-controls-divider" aria-hidden="true"></span>
              <button id="zoom-out" type="button" aria-label="Zoom out" data-i18n-aria="view.zoom_out">&minus;</button>
              <button id="zoom-reset" type="button" aria-label="Reset zoom" data-i18n-aria="view.zoom_reset">1&times;</button>
              <button id="zoom-in" type="button" aria-label="Zoom in" data-i18n-aria="view.zoom_in">+</button>
            </div>
            <div id="stage-hint" class="stage-hint" aria-hidden="true"></div>
          </div>
          <p id="frame-caption" class="frame-caption" data-i18n="evidence.none_selected">No evidence selected.</p>
          <div class="timeline">
            <div id="scrubber" class="scrubber" role="slider" tabindex="0" aria-label="Layer timeline" data-i18n-aria="timeline.aria"
                 aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="No layers">
              <canvas id="scrub-canvas" class="scrub-canvas" aria-hidden="true"></canvas>
              <div id="scrub-playhead" class="scrub-playhead" aria-hidden="true"></div>
              <div id="scrub-bubble" class="scrub-bubble" aria-hidden="true"></div>
            </div>
            <div id="navigator" class="navigator" role="group" aria-label="Timeline zoom" data-i18n-aria="timeline.zoom">
              <canvas id="navigator-canvas" class="navigator-canvas" aria-hidden="true"></canvas>
              <div id="navigator-window" class="navigator-window" aria-hidden="true">
                <span class="navigator-grip navigator-grip-start"></span>
                <span class="navigator-grip navigator-grip-end"></span>
              </div>
            </div>
            <div class="timeline-foot">
              <div class="transport" role="group" aria-label="Timeline transport" data-i18n-aria="timeline.transport">
                <button id="finding-back" class="transport-button is-finding" type="button" aria-label="Previous flagged layer" title="Previous flagged layer (N)" data-i18n-aria="timeline.previous_finding">
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M9.8 3.4 5.2 8l4.6 4.6V3.4z"/>
                    <circle cx="12.1" cy="8" r="1.5"/>
                  </svg>
                </button>
                <button id="play-back" class="transport-button" type="button" aria-pressed="false" aria-label="Play backwards through the build" data-i18n-aria="timeline.play_back">
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path class="icon-play" d="M10.5 3.6 4 8l6.5 4.4z"/>
                    <path class="icon-pause" d="M5 3.5h2.2v9H5zm3.8 0H11v9H8.8z"/>
                  </svg>
                </button>
                <button id="step-back" class="transport-button" type="button" aria-label="Previous layer" data-i18n-aria="timeline.previous">
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M11 3.6 5.6 8 11 12.4zM5 3.5h1.6v9H5z"/>
                  </svg>
                </button>
                <button id="step-forward" class="transport-button" type="button" aria-label="Next layer" data-i18n-aria="timeline.next">
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M5 3.6 10.4 8 5 12.4zM9.4 3.5H11v9H9.4z"/>
                  </svg>
                </button>
                <button id="play-toggle" class="transport-button" type="button" aria-pressed="false" aria-label="Play through the build" data-i18n-aria="timeline.play">
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path class="icon-play" d="M5.5 3.6 12 8l-6.5 4.4z"/>
                    <path class="icon-pause" d="M5 3.5h2.2v9H5zm3.8 0H11v9H8.8z"/>
                  </svg>
                </button>
                <button id="finding-forward" class="transport-button is-finding" type="button" aria-label="Next flagged layer" title="Next flagged layer (n)" data-i18n-aria="timeline.next_finding">
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M6.2 3.4 10.8 8l-4.6 4.6V3.4z"/>
                    <circle cx="3.9" cy="8" r="1.5"/>
                  </svg>
                </button>
              </div>
              <span id="timeline-count" class="timeline-count"></span>
              <span class="keyboard-hint" data-i18n="timeline.hint">Drag to scrub, away for fine &middot; arrows to step &middot; n for the next flagged layer</span>
            </div>
            <div id="filmstrip" class="filmstrip" role="listbox" aria-label="Layer filmstrip" data-i18n-aria="timeline.filmstrip"></div>
          </div>
        </article>
        <aside class="panel evidence-card">
          <div class="selected-heading"><div><p class="eyebrow" data-i18n="selected.eyebrow">SELECTED LAYER</p><h1 id="layer-title" data-i18n="selected.none">No layer</h1></div><span id="layer-severity" class="severity-badge severity-unknown" data-i18n="unknown">unknown</span></div>
          <p id="analysis-reason" class="analysis-reason" data-i18n="selected.prompt">Select a committed layer to inspect its result.</p>
          <dl id="layer-summary"></dl>
          <details id="metadata-details" class="metadata-details"><summary data-i18n="meta.summary">Technical details</summary><dl id="layer-facts"></dl></details>
          <section class="argon-panel"><div class="subheading"><span data-i18n="argon.title">Argon snapshot</span><strong id="argon-combined">--</strong></div><div id="argon-state" class="argon-state" data-i18n="argon.unavailable">Argon context unavailable.</div><div id="argon-runway" class="argon-runway" data-state="muted">Argon left: --</div></section>
        </aside>
      </section>
      <section class="metrics-grid">
        <article class="panel chart-card"><div class="chart-heading"><div><p class="eyebrow" data-i18n="quality.eyebrow">ROLLING QUALITY</p><h2 data-i18n="quality.title">Defect rate</h2></div><strong id="defect-rate">--</strong></div><canvas id="defect-chart" height="132" aria-label="Rolling defect rate chart" data-i18n-aria="quality.aria"></canvas><p id="defect-note" class="chart-note"></p></article>
        <article class="panel chart-card"><div class="chart-heading"><div><p class="eyebrow" data-i18n="argon_chart.eyebrow">CAPTURED WITH LAYER</p><h2 data-i18n="argon_chart.title">Argon channels</h2></div><strong id="argon-label">--</strong></div><div id="argon-legend" class="chart-legend"></div><canvas id="argon-chart" height="132" aria-label="Argon snapshot chart" data-i18n-aria="argon_chart.aria"></canvas><p class="chart-note" data-i18n="argon_chart.note">Values are never interpolated. On a build longer than this chart is wide, each pixel column shows the highest and lowest reading in it, and becomes a gap only where the whole column was unreadable.</p></article>
      </section>
    </main>
  </div>
  <script src="{{asset:review.js}}" type="module"></script>
</body>
</html>
HTML;

        return strtr($html, [
            '{{asset:review.css}}' => self::asset('review.css'),
            '{{asset:review.js}}' => self::asset('review.js'),
        ]);
    }

    /**
     * A static asset URL that changes when the asset does.
     *
     * The deploy overwrites assets in place, so without this the URL a browser
     * asks for after a deploy is byte-identical to the one it already holds.
     * Nothing sets Cache-Control on them, which leaves the browser free to
     * reuse its copy without revalidating -- so a fixed viewer goes on looking
     * unfixed until someone thinks to hard-reload, and the deploy that fixed it
     * looks like it failed. The mtime changes on every deploy and on nothing
     * else, so it is the version.
     *
     * Resolved from the running script, never from __DIR__: the deploy puts the
     * entry script and assets together in the web root while the application
     * itself lives outside it. If the file cannot be found the URL is emitted
     * bare, which is exactly what it was before.
     */
    private static function asset(string $file): string
    {
        $url = 'assets/' . $file;
        $script = $_SERVER['SCRIPT_FILENAME'] ?? '';
        if (!is_string($script) || $script === '') {
            return $url;
        }
        $path = dirname($script) . '/assets/' . $file;
        $stamp = is_file($path) ? filemtime($path) : false;
        return $stamp === false ? $url : $url . '?v=' . $stamp;
    }
}
