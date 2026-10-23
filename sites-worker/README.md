# Genepedia and Gravepedia API

Production is a JavaScript ES module on ChatGPT Sites at `https://api.genepedia.org`.
The API uses Web Request/Response, fetch and Web Crypto, without an application framework.
`esbuild` is a build dependency. No PHP is deployed and PHP-named routes return 404.

## Storage

- Sites D1 (`DB`): structured records, indexed person/pet and memorial search, document versions, review requests, ownership, discussions, contact messages, statistics and encrypted login sessions.
- Sites R2 (`BUCKET`): immutable, content-hashed binary and large text files. Small UTF-8 pages and assets stay inline in D1. D1 stores their published pointers.
- The two frontend Sites Workers serve those published files at the existing domains and cache public responses for 60 seconds. New profile routes can use the profile shell after verifying the stored record.
- GitHub provides optional sign-in and the existing welcome actions. Repository access is not needed for website data reads, saves or reviews. Original repositories and their Git history remain recovery archives; they are not automatically deleted or rewritten.
- External source links and third-party image URLs in genealogy records remain external links.

The public API bases are `/v1/genepedia` and `/v1/gravepedia`.
The shared OAuth callback is `/v1/auth/github/callback`.
See [openapi.json](openapi.json) for routes and request contracts.
The `pull-requests` resource contains native Sites edit requests; reviewers use
`/pages/review_edits.html` on either website. These routes do not create GitHub PRs.

## Integrity and permissions

File writes check expected document versions inside one D1 transaction. Approval publishes
all proposed files atomically; conflicting versions or an existing reservation reject the
operation. R2 bodies are written before D1 pointers change, so a failed transaction may
leave an unreferenced blob but cannot publish half an edit. History retains previous
versions. Callers should send `Idempotency-Key` on retried writes. Reusing a key with
changed intent returns 409. Editors send `expected_version` from `X-Document-Version`. Existing-file edits without a base version return 428; stale versions return 409. Native catalogs derive from the approved search index, so profile creation never stages a client copy of a shared catalog.

GitHub sessions are required for saving or moderating user data. Only
`GITHUB_REVIEW_LOGIN` can approve or decline edits. Profile managers can submit media
changes. Ownership, maintainer and discussion permissions are checked by the API.
Local password login is a browsing session. Contact records have no public read route.
The profile hidden/private flag remains a website display choice; published genealogy
JSON is intentionally readable through the public data API.

## Runtime configuration

Store secrets in Sites environment variables, never in Git or hosting.json.

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: OAuth identity credentials.
- `GITHUB_SESSION_SECRET`: high-entropy encryption key for D1 login state.
- `GITHUB_CALLBACK_URL`: optional exact registered OAuth callback override.
- `GITHUB_REVIEW_LOGIN`: reviewer identity.
- `GITHUB_ALLOWED_CORS_ORIGINS`, `GITHUB_ALLOWED_RETURN_ORIGINS`: exact origin lists.
- `GITHUB_WELCOME_ACTIONS`, `GITHUB_WELCOME_STAR_REPOS`, `GITHUB_WELCOME_FOLLOW_USERS`: optional existing welcome behaviour.
- `LOCAL_LOGIN_USERNAME`, `LOCAL_LOGIN_PASSWORD_HASH` or `LOCAL_LOGIN_PASSWORD`, `LOCAL_LOGIN_DISPLAY_NAME`: optional local browsing login.
- `STORAGE_MIGRATION_TOKEN`: temporary import secret. Remove after verification and redeploy.
- `GITHUB_STATISTICS_FLUSH_TOKEN`: optional administrative statistics-drain secret.

D1 migrations are applied by Sites before Worker upload. Do not edit an applied migration;
add another migration. No request handler issues schema DDL.

## Build and checks

```sh
npm ci
npm run build
npm run validate
```

The suites exercise real SQLite transactions with an R2 byte fixture, plus HTTP and
identity mocks. They cover concurrent writes, rollback, retries, stale approvals,
profile/pet isolation, permissions, media bytes, search, statistics, OAuth and CORS.
No production records or real GitHub account are used by these local suites.

## Import and recovery

`scripts/migrate-storage.mjs --source <snapshot> --content-genepedia <public-build>
--content-gravepedia <public-build>` imports a fixed source snapshot. The migration token
is read from hidden stdin. `--plan` produces a checksum manifest without uploading;
`--verify` compares every source checksum against the paginated destination manifest.
Receipts live outside the source checkout. Identical files skip safely on retries;
replacing different content requires an explicit expected version.

Keep the source snapshot, checksum manifest and receipts until a separate backup restore
has been exercised. Native history starts at the import; older Git history remains in
the original repositories. Migration copies data and does not erase public Git history.

## Capacity work

Indexed, paginated reads, bounded response sizes, atomic writes, short public caches and
coalesced statistics reads address the previous GitHub request/write bottlenecks. This is
not a benchmark proving millions of active users. Before that scale, measure realistic
concurrency and latency, confirm Sites account quotas, define backup/restore operations,
and partition storage when needed. Raw statistics and high-cardinality hourly rollups
need a retention/compaction policy. Leaderboard output is capped and the API marks capped
tracked-group counts. Large immutable imported registries are snapshots; use indexed
search for current discovery rather than downloading every profile.

The current full-catalog export is capped at 10,000 rows with cursor pagination. Existing bulk-list editor consumers must be moved to targeted paginated lookups before the catalog reaches that size; primary website search already uses indexed API pagination.
