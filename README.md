# SLM remote review for cPanel

This directory is a small PHP 8.2+ / MySQL remote-review application for the
GoDaddy Web Hosting (cPanel) account shown in the project discussion. It is a
separate deployment from the Windows monitor and receives data only through
the `review-sync` agent.

It is deliberately dependency-free: cPanel already provides PHP and MySQL,
and the service uses PDO rather than Composer or a long-running process.

## Security gate

**Do not deploy or configure the sync agent until the chosen hostname has a
valid, trusted HTTPS certificate.** The screenshot supplied for this project
shows an expired certificate. The sync agent rejects plain HTTP by default.

Before exposing the site, protect its directory or dedicated subdomain with
cPanel **Directory Privacy**. That password protection covers the browser
viewer and all API routes; the sync agent sends those Basic Auth credentials
from its own environment. The ingest endpoint additionally requires its own
long random bearer token. Do not put either credential in JavaScript, source
control, or the monitor's settings.

The first release is read-only. It does not control the printer, change local
analysis, acknowledge incidents, or treat remote availability as an operating
signal.

## Requirements

- GoDaddy Web Hosting (cPanel) with PHP **8.2 or newer**, PDO MySQL, and
  writable private account storage.
- MySQL 5.6+ or MariaDB 10.6+.
- A dedicated MySQL database and least-privilege database user.
- A dedicated review hostname or protected subdirectory with valid HTTPS.

GoDaddy's current cPanel documentation lists PHP 8.2, 8.3 and 8.4 and MySQL /
MariaDB availability. Confirm the active PHP version in the hosting dashboard
before deployment; do not use PHP versions in extended support.

## Install on cPanel

Use a dedicated hostname such as `review.example.com` where possible. These
paths are examples only; substitute the cPanel account's actual home path.

1. In **SSL/TLS Status**, run AutoSSL or install a trusted certificate and
   verify `https://review.example.com` in a browser without a warning.
2. In **MySQL Database Wizard**, create a database and a dedicated runtime
   user. Grant the runtime user only `SELECT`, `INSERT`, `UPDATE`, and
   `DELETE`; import the schema through phpMyAdmin with the account that owns
   the database.
3. Upload `app/` and `migrations/` outside the web root, for example to
   `/home/CPANEL_USER/slm-review/`. Create
   `/home/CPANEL_USER/slm-review/private/config.php` from
   `config.example.php`, with a generated ingest token and a private storage
   path such as `/home/CPANEL_USER/slm-review-storage`.
4. Import `migrations/001_initial.sql`, then `migrations/002_build_order.sql`,
   then `migrations/003_monitor_version.sql`, then
   `migrations/004_layer_summary.sql`, then `migrations/005_run_mode.sql`,
   with phpMyAdmin into the new database.
   All three later migrations are required when upgrading an existing install:
   002 adds the index behind the build-ordered timeline, 003 records which
   monitor build published each layer, backfilling history from the manifests
   already stored, and 004 adds the columns the session index is read from.
   Without 003 the ingest endpoint rejects every upload, because it writes a
   column that does not exist yet; without 004 it does the same, and the
   viewer's timeline request fails outright; 005 records whether each layer was
   watched live or replayed, which decides whether the viewer may call its
   elapsed figures print time.

   **Deploy this service before the monitor that sends `run.mode`.** The
   validator accepts the field as optional, so a reviewer updated first is happy
   with old and new monitors alike; a monitor updated first would have every
   bundle refused. Unlike 003, 004 needs no backfill
   step: the read path fills older rows in from the manifests it already
   stores, a bounded number per request, and answers correctly meanwhile.
5. Upload the contents of `public/` to the hostname document root. Copy
   `public/app-root.example.php` to `public/app-root.php` and set its returned
   string to `/home/CPANEL_USER/slm-review`. Never upload `private/config.php`
   into the document root.
6. In cPanel **Directory Privacy**, require a new strong password for this
   hostname/directory. Configure the same username/password in the sync
   agent's `REVIEW_SYNC_HTTP_BASIC_*` environment variables.
7. Run the manual smoke procedure below. Only then set the agent's
   `REVIEW_SYNC_SERVER_URL` and start it with `--once`.

If a protected subdirectory is used rather than a dedicated hostname, set the
agent URL to the full base path, for example
`https://example.com/slm-review`. The PHP router honours that base path.

## Shareable links

Viewer state lives in the URL fragment, so a link can be pasted into a message
and it opens on exactly what the sender was looking at. The fragment is used
rather than a query string so a shared link costs no server round trip and
cannot collide with the router under a base-path install.

| key | meaning |
| --- | --- |
| `m` | monitor instance id |
| `s` | session local id, or `unassigned` |
| `live` | `1` follows the newest layer as it arrives |
| `r` + `l` | run local id and layer index, addressing one frame |
| `v` | media role, e.g. `diagnostic_overlay`, `underfill_mask` |
| `grid` | `1` opens the all-views grid |

```
https://review.example.com/#m=<uuid>&s=22&live=1
https://review.example.com/#m=<uuid>&s=22&r=33&l=144&v=underfill_mask
```

The fragment is rewritten as the viewer moves -- selecting a frame, stepping
with the arrows, changing view, opening the grid -- so the address bar is always
the link to copy and there is no separate share control to find.

A link either follows the build (`live=1`) or pins one frame (`r`+`l`), never
both: a link copied while following would otherwise silently mean a different
layer to whoever opened it later. A frame outside the opening window is paged
back to, and one that was never published says so rather than showing a
neighbour. History is replaced rather than pushed, so scrubbing a hundred layers
does not bury the back button.

## Manual smoke procedure

1. Visit `/` and confirm the browser requests the Directory Privacy password.
2. Run the agent with `--once`; its JSON output should show `committed: 1` for
   a new bundle, then `attempted: 0` on the next pass.
3. Open the viewer. Select the session and confirm the index, verdict, defect
   chart point, and argon snapshot match the local manifest. Confirm the
   **Argon left** line under the snapshot reads either `~N h at R units/h` on a
   session whose reserve is falling, or a stated reason (`not enough committed
   layers…`, `argon steady…`) — it is fitted here from the layers' combined
   values, not sent by the monitor. Confirm each frame carries the burned
   `<print name> | <capture time>` strip along its top. Then check the viewer
   behaviours the operator depends on:
   - Work the transport under the timeline: play backwards, step back, step
     forward, play forward. Playing walks a layer at a time showing each one's
     preview; pressing it again, stepping, or dragging stops it and loads the
     evidence for the layer it stopped on. Each control is disabled when there
     is no build left in its direction, and playing stops following the live end
     rather than fighting the poll for the selection.
   - Pinch the timeline to zoom, or wheel over it on a desktop. The navigator
     rail below keeps showing the whole build; drag its middle to pan and its
     ends to resize. Press `0` or double-tap to fit the build again.
   - Press on the timeline and drag *away* from it. A build of thousands puts
     about ten layers under every pixel, so the drag gears down the further the
     finger goes -- to roughly two layers a pixel, then half of one, then a
     layer every several pixels -- and the bubble says when it has. The layer
     under the finger does not jump as the gearing changes. A build already
     finer than a rung asks for is left alone, so a short one never crawls.
   - Press and drag along the timeline directly under the image; frames follow
     the finger and the bubble names the layer being passed. While dragging,
     the frame is captioned as a scrub preview and the evidence for the layer
     landed on loads when the drag stops -- a drag crosses hundreds of layers
     and must not fetch a build's worth of them.
       Supported touch devices provide a light tick as the selected layer changes;
       unsupported browsers and reduced-motion sessions remain silent.
   - Switch among Before, After, Analysis and the detector views. The frame
     must not change size or position between them.
   - Pinch or double-tap to zoom, drag to pan, and confirm the zoom is held
     when the layer or the view changes. `0` resets it.
   - Swipe left/right on an unzoomed image, and use Left/Right, Home/End and
     the number keys.
   - With the **Live** chip lit, run the agent again with `--once`. The new
     layer must appear and be selected **without reloading the page**. Click
     the chip, or select any earlier layer, and confirm it stops following
     while still reporting that new layers arrived.
   - Repeat at a narrow mobile viewport without horizontal page overflow.
   - On a session of a few thousand layers, confirm the notice reports the
     whole build on the first load with no **Load earlier** to press, then step
     with the arrows and drag the timeline. The filmstrip keeps only the chips
     near the viewport in the page, so its scrollbar is as long as the build
     while the strip itself stays responsive; the selected chip must always end
     up highlighted and in view. Stepping onto a layer whose detail has not
     arrived shows "Loading this layer's evidence"; it must never say the
     evidence was not published.
4. Stop the server during a pass or temporarily use an invalid URL. Confirm
   the monitor continues normally and the agent reports a retry/backlog.
5. Restore the URL and run `--once`; confirm no duplicate remote layer appears.

## cPanel Git deployment

Do not clone the full `slm-monitor` repository into shared hosting. Its tracked
datasets and history are much larger than the remote application. Publish the
`remote-review/` subtree to a dedicated deployment repository instead; in that
repository this directory's `.cpanel.yml` becomes the top-level deployment
manifest required by cPanel.

After creating an empty deployment repository on GitHub, publish the subtree
from the monitor checkout:

```powershell
.\remote-review\tools\publish-deploy-repo.ps1 `
  -RepositoryUrl https://github.com/artsystema/slm-review-deploy.git
```

In cPanel **Git Version Control**, clone the dedicated repository into a new
private path such as `slm-review-git`. Keep the production directories separate
from the clone. On **Pull or Deploy**, first choose **Update from Remote**, then
**Deploy HEAD Commit**. cPanel requires a clean checkout and runs the checked-in
tasks in order.

**Import any new migration before deploying the code that needs it.** Migrations
are never run automatically (see below), so a deploy that expects a column the
database does not have yet fails every ingest until the SQL is imported — the
uploads are retried rather than lost, but the reviewer stops receiving layers in
the meantime. `003_monitor_version.sql` is one of these: the code deployed with
it writes `publications.monitor_software_version`.

This GoDaddy account keeps the SLM production folders below `public_html`, so
the checked-in deployment targets are:

- `/home/khzr7u2xld10/public_html/slm.artsystema.com`
- `/home/khzr7u2xld10/public_html/slm-review`
- `/home/khzr7u2xld10/public_html/slm-review-storage`

The deployment manifest copies only `app/`, `migrations/`, `public/index.php`,
`public/assets/`, and deny-access files for the private directories. It verifies
that the existing private configuration and public app-root file are present,
then leaves these operator-owned paths alone:

- `slm-review/private/config.php`
- frame data within `slm-review-storage/`
- `slm.artsystema.com/app-root.php`
- `slm.artsystema.com/.htaccess`

Leaving `.htaccess` out is deliberate: cPanel Directory Privacy writes its
authentication directives in the public site file. The deployment does install
deny-all `.htaccess` files in `slm-review/` and `slm-review-storage/` because
this account currently keeps those private directories below `public_html`.
Database migrations are copied for review but are never executed automatically.

If cPanel leaves **Deploy HEAD Commit** queued, use cPanel **Terminal** to run
the same guarded deployment directly:

```bash
bash /home/khzr7u2xld10/slm-review-deploy/tools/deploy-cpanel.sh
```

The script validates the production layout before copying anything and
preserves `private/config.php`, frame data, `app-root.php`, and the public site
`.htaccess`. It also denies direct web access to the private app and storage.

## Viewer at build scale

A session runs to thousands of layers, so the viewer is written against the
pixels rather than the layers:

- The filmstrip renders a window of chips over a rail as wide as the build,
  reusing about thirty nodes as it scrolls, with one delegated click handler.
  Chips outside the window leave the document so the browser can release the
  thumbnails behind them.
- The severity strip and both charts reduce to one column per device pixel,
  keeping each column's extremes -- the worst severity, and the minimum and
  maximum reading. A single flagged layer or a one-layer spike therefore still
  paints on a build far longer than the strip is wide.
- Series are recomputed when layers arrive, not when the selection moves.
  Stepping a layer redraws the frame, the sidebar, the playhead and the chart
  marker only.
- `public/assets/review-core.js` holds that arithmetic with no DOM in it. Run
  its tests with `node --test "remote-review/tests/*.test.mjs"`.
- JSON responses are gzipped when the client accepts it and the host is not
  already compressing them; a layer window compresses about ten to one.
- The timeline arrives as one session index rather than pages of full layer
  rows: 467 B per layer raw and 73 B gzipped against 4,517 B, so a 3,631-layer
  build is 0.25 MiB in one request instead of 15.6 MiB across fifteen presses
  of a button. There is no **Load earlier** control any more because there is
  nothing left to load. The per-layer detail -- metrics, processor, media,
  reading ages -- is fetched for the layer being looked at and its neighbours,
  and the sidebar says "loading" rather than "unknown" while it is in flight.
- The strip zooms, and the navigator rail under it always shows the whole build
  with the strip's window drawn on it -- so magnifying part of a build never
  costs the sense of where that part is in it. Pinch the strip, or wheel over
  it; drag the navigator's middle to pan and its ends to resize. `0` or a
  double-tap fits the whole build again. The window follows the selection only
  when the selection deliberately moves -- stepping, playing, jumping to a
  finding -- because doing it on every repaint made the view snap back the
  instant the operator panned somewhere else.
- Dragging is also geared: the further the finger moves off the strip, the fewer
  layers a pixel covers. It reckons from the window's scale rather than the
  build's, so zooming and gearing compose instead of fighting. See
  `scrubScale()` and `clampWindow()`.
- The two finding controls are tinted, held back until wanted, and greyed out
  when there is no finding that way, so the transport never offers what it
  cannot do.
- Above the bars is a time ruler: round elapsed times from the session's first
  layer, at an interval chosen for the span (six-hour marks on a two-day build,
  quarter hours on a two-hour one). The x axis counts layers, not seconds, so
  the marks spread where the machine was quick and crowd where it was not --
  the only thing on the page that shows the build's pace. Marks that would
  share a column are dropped rather than smeared into a wall.
- A stoppage breaks the strip. The threshold is a multiple of the build's own
  median layer time rather than a number of minutes, so it means the same on a
  fast machine and a slow one. Nothing is wrong with the layers either side --
  the time between them is the finding, and the severity strip has no bad layer
  to colour. It is drawn as a break rather than in amber for that reason.
- The foot reads `+18h 12m` for the selected layer, and says what that figure
  is. `captured_at` is the analysis timestamp: the frame's own time on a live
  `watch` run, and the replay's on a `batch` one. The manifest now carries
  `run.mode`, so a live build's figure is print time, a replay's is labelled
  `replay`, a session holding both claims neither, and a layer from a monitor
  that predates the field gets the figure with no claim attached. A replay also
  draws no stoppages: its gaps are the breaks between replay runs, and the
  machine was not even running.
- Because the whole build is loaded, the defect rate and the **Argon left**
  figure are computed over the build. They used to be fitted over however many
  pages had been loaded, so they moved when the operator pressed the button.
  Both are recomputed when layers arrive rather than when the selection moves.
- Layer detail is fetched when the selection settles, never while it is moving,
  and what has been fetched is bounded. A drag across a 3,600-layer build costs
  three requests, not one per layer passed.
- The severity strip mutes the stretches whose frames are not held locally, so
  it is visible where scrubbing will be instant. It is opacity, not colour: no
  hue is added or changed, because the strip's colour means severity and only
  severity. Only measured, quiet stretches mute -- a finding is drawn at full
  strength wherever it is, and so is a stretch with no verdict, since not
  knowing is something the operator needs to see. A stretch reads as held only
  when *every* layer under it is, so the mark never promises more than it has.
- A session longer than one index request is cut at its start, not its end: a
  build in progress is watched through its newest layers. The notice says the
  timeline was cut and that the figures cover only what it lists.

## Layout

```text
remote-review/
  app/                    PHP application code, deployed outside web root
  migrations/             import once through phpMyAdmin
  private/config.php      created by operator, never committed or public
  public/                 only these files enter the web document root
```

Media objects are stored outside the web root and are served only through the
read API after the cPanel directory protection challenge. They are deduplicated
by SHA-256. The original manifest JSON is retained together with normalized
fields. The service accepts only the fixed raw-before, raw-after, diagnostic
overlay, and legacy key-view roles declared by the bundle contract.

Every frame the monitor sends already has a `<print name> | <capture time>`
strip burned along its top, so a frame opened from a shared link still names its
build once the page around it is gone. The service stores and serves the frames
as received; it does not add or read the strip.
