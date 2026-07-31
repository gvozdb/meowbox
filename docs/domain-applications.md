# Domain applications

## Ownership model

A Site is the shared Linux container: system user, root directory and
Site-level lifecycle. Every main `SiteDomain` owns exactly one application.
An alias only routes to its main domain and never creates another application.

Selecting a domain in the Site header selects its application everywhere on
the page. The selection is stored in the `domain` URL query so refreshes and
shared links keep the same context. A missing or stale selection falls back to
the primary main domain and rewrites the URL. Application routes never silently
target the primary domain when `domainId` is required.

## Presets

| Preset | Runtime | Domain-scoped controls |
| --- | --- | --- |
| `MODX_REVO` | PHP-FPM + MODX 2 | PHP version/pool, MODX credentials and paths, primary DB, per-domain update |
| `MODX_3` | PHP-FPM + MODX 3 | PHP version/pool, MODX credentials and paths, primary DB, per-domain update |
| `CUSTOM` | PHP-FPM or internal application port | PHP/runtime settings, Git/deploy settings, owned databases |

Each main domain keeps its own `filesRelPath`, runtime status, PHP settings,
Nginx settings, deploy settings and application metadata. `appPort` is an
internal runtime field and is not exposed by generic Site/domain forms.
Database ownership is explicit through `siteDomainId`; at most one
`APP_PRIMARY` database is allowed per application.

## Runtime topology

Every PHP-enabled main domain has a stable runtime key, one PHP-FPM pool and
one Unix socket. Domains using the same PHP version share the operating-system
`phpX.Y-fpm` service, not a worker pool. Nginx remains split into managed
per-domain chunks.

During legacy migration, the old Site pool worker ceiling is distributed
across replacement domain pools. The migration aborts when it cannot preserve
the resource envelope; it never copies the full worker budget to every domain.
Legacy secondary domains become `CUSTOM` applications while preserving their
effective files path, PHP runtime, internal port, Nginx and SSL behaviour.

## Operations and conflicts

Provision, deploy, update, delete, duplicate, restore and database mutations
use durable idempotent operations. Site-wide operations exclude domain
operations. Independent domain operations may run together when neither
changes shared Site runtime.

A Site backup and a mutating Site/domain operation cannot start together.
All destinations of one multi-storage backup are reserved atomically before
agent dispatch. Conflicts return `409`; retry after the active operation or
backup finishes. Application progress and errors belong to the selected
domain, not to the Site container.

## Backup and restore

Site backup manifest version 2 records:

- Site container metadata;
- every main domain and alias;
- domain preset, files path and runtime settings;
- explicit database-to-domain ownership;
- deduplicated content roots when domains share a path.

Encrypted credentials remain encrypted in the manifest and are never returned
by public backup responses. `FILES_ONLY` excludes databases. `DB_ONLY` requires
at least one selected Site database. A shared files root is archived once and
mapped back to every owning domain.

Exact restore validates the manifest checksum and reserves hostname ownership
before changing metadata. It restores domain/database mappings and then
regenerates managed runtime. A failure restores the pre-restore metadata and
runtime checkpoint. Deleting application files is refused while another
domain references the same root.

## Import and migration

HostPanel/server imports must serialize destination `siteDomainId`, preset,
files path and database purpose explicitly. Imported aliases remain aliases.
No application is inferred from a hostname or silently adopted from arbitrary
files.

The in-place release first maps legacy rows deterministically on a read-only
SQLite clone, applies `prisma migrate deploy`, renders and validates staged
PHP-FPM/Nginx artifacts, and only then enters maintenance. See
[domain-runtime release runbook](runbook/domain-runtime-release.md) for the
dry-run, snapshot and rollback boundary.
