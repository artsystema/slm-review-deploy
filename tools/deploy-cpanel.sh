#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
public_root="${HOME}/public_html/slm.artsystema.com"
application_root="${HOME}/public_html/slm-review"
storage_root="${HOME}/public_html/slm-review-storage"
deny_file="${repository_root}/deploy/deny-web-access.htaccess"

require_directory() {
    if [[ ! -d "$1" ]]; then
        printf 'Required directory is missing: %s\n' "$1" >&2
        exit 1
    fi
}

require_file() {
    if [[ ! -f "$1" ]]; then
        printf 'Required file is missing: %s\n' "$1" >&2
        exit 1
    fi
}

require_directory "$repository_root/app"
require_directory "$repository_root/migrations"
require_directory "$repository_root/public/assets"
require_directory "$public_root"
require_file "$repository_root/public/index.php"
require_file "$deny_file"
require_file "$public_root/app-root.php"
require_file "$application_root/private/config.php"

mkdir -p \
    "$application_root/app" \
    "$application_root/migrations" \
    "$storage_root" \
    "$public_root/assets"

cp -R "$repository_root/app/." "$application_root/app/"
cp -R "$repository_root/migrations/." "$application_root/migrations/"
cp -R "$repository_root/public/assets/." "$public_root/assets/"
cp "$repository_root/public/index.php" "$public_root/index.php"
cp "$deny_file" "$application_root/.htaccess"
cp "$deny_file" "$storage_root/.htaccess"

printf 'SLM Review deployed successfully from %s\n' "$repository_root"
printf 'Private config, frame data, app-root.php, and the public .htaccess were preserved.\n'
printf 'Direct web access to the private app and frame storage was denied.\n'
