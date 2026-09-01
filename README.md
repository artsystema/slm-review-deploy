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
4. Import `migrations/001_initial.sql` with phpMyAdmin into the new database.
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

## Manual smoke procedure

1. Visit `/` and confirm the browser requests the Directory Privacy password.
2. Run the agent with `--once`; its JSON output should show `committed: 1` for
   a new bundle, then `attempted: 0` on the next pass.
3. Refresh the viewer. Select the session, scrub frames, switch among Analysis,
   Raw after, and Raw before, and confirm the index, verdict, defect chart
   point, and argon snapshot match the local manifest. Confirm Left/Right
   arrow keys scrub adjacent layers and repeat the review at a narrow mobile
   viewport without horizontal page overflow.
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

The deployment manifest copies only `app/`, `migrations/`, `public/index.php`,
and `public/assets/`. It verifies that the existing private configuration and
public app-root file are present, then leaves these operator-owned paths alone:

- `slm-review/private/config.php`
- `slm-review-storage/`
- `slm.artsystema.com/app-root.php`
- `slm.artsystema.com/.htaccess`

Leaving `.htaccess` out is deliberate: cPanel Directory Privacy writes its
authentication directives there. Database migrations are copied for review but
are never executed automatically.

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
