# Genepedia Sites API Worker

This is the Sites Worker ESM replacement for the PHP API. It serves both API
bases from one Worker:

- `https://api.genepedia.org/genepedia`
- `https://api.genepedia.org/gravepedia`

The PHP API remains untouched. GitHub remains the public source of record for
site, people, memorial, and media data. This Worker uses fixed repository
routing in `worker/index.js`; callers cannot choose an arbitrary GitHub owner
or repository.

## GitHub repository routing

| Site/API prefix | Site and data repository | Media repository |
| --- | --- | --- |
| `/genepedia` | `Genepedia/Genepedia`; `Genepedia/Genepedia-Database` for database/statistics paths | `Genepedia/Genepedia-Media` |
| `/gravepedia` | `Genepedia/Gravepedia` for pages and `data/memorials/` | `Genepedia/Gravepedia-Media` |

Public content reads use the GitHub API and raw file URLs. Writes use a
server-side GitHub App installation token or a publish token, and create a
branch plus review pull request. The Gravepedia memorial search reads only
`data/memorials/index.json`; submissions are written beneath
`data/memorials/pending/` in a pull request, so they do not appear in public
search before a maintainer merges them.

## Storage and bindings

`.openai/hosting.json` declares the Sites D1 binding `DB`. Sites applies the
schema migration in `drizzle/0000_worker_storage.sql` before uploading the
Worker; the Worker never creates or alters tables while serving a request. D1
stores expiring OAuth states, one-time handoffs, encrypted sessions, and queued
statistics events. GitHub continues to store the project's site, people,
memorial, media, and published statistics records.

Set these values as Sites runtime environment variables. Keep every secret in
the Sites secret manager, never in this source tree or in the hosting manifest.

| Variable | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth/App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `GITHUB_SESSION_SECRET` | At least 32 random characters; derives the AES-GCM key used to encrypt session and handoff payloads in D1 |
| `GITHUB_CALLBACK_URL` | Optional override; default is `https://api.genepedia.org/genepedia/github-callback.php`. Register this exact URL in GitHub |
| `GITHUB_APP_ID` | Optional numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Optional GitHub App PEM private key, supplied as a runtime secret (not a file path) |
| `GITHUB_APP_INSTALLATION_ID` | Optional installation ID; otherwise the Worker looks it up for the fixed Genepedia site repository |
| `GITHUB_PUBLISH_TOKEN` | Optional PAT with Contents and Pull requests write access to all five fixed repositories |
| `GITHUB_API_TOKEN` | Optional GitHub API token for read requests; it may also be used for writes if it has the required permissions |
| `GITHUB_REVIEW_LOGIN` | GitHub login allowed to merge or decline pull requests |
| `GITHUB_STATISTICS_FLUSH_TOKEN` | Secret required by `github-statistics-flush.php`; accept it in `X-Statistics-Flush-Token` or the compatible `token` parameter |
| `GITHUB_STATISTICS_SYNC` | Optional; set to `0` to retain events in D1 without publishing them to GitHub |
| `GITHUB_ALLOWED_CORS_ORIGINS` | Optional comma-separated exact origins for hosted Site URLs or additional frontends |
| `GITHUB_ALLOWED_RETURN_ORIGINS` | Optional comma-separated exact HTTPS origins allowed for OAuth return URLs |
| `GITHUB_WELCOME_ACTIONS` | Optional; set to `0`, `false`, `no`, or `off` to disable welcome stars and follows; enabled by default |
| `GITHUB_WELCOME_STAR_REPOS` | Optional comma-separated `owner/repository` list to star after GitHub OAuth sign-in |
| `GITHUB_WELCOME_FOLLOW_USERS` | Optional comma-separated GitHub user or organization logins to follow after GitHub OAuth sign-in |
| `LOCAL_LOGIN_USERNAME` | Optional local sign-in username; leave blank to disable local login |
| `LOCAL_LOGIN_PASSWORD` | Optional local password secret; required with the username unless a supported password hash is configured |
| `LOCAL_LOGIN_PASSWORD_HASH` | Optional Worker PBKDF2 hash; takes precedence over `LOCAL_LOGIN_PASSWORD` |
| `LOCAL_LOGIN_DISPLAY_NAME` | Optional display name for the local signed-in identity |

GitHub App credentials are preferred for writes. The App must be installed with
the required permissions on the repositories it serves. Minimum installation
permissions are **Contents: read/write** and **Pull requests: read/write** on
the Genepedia site and database repositories, both Gravepedia repositories,
and the Genepedia media repository. Add **Issues: write** on the site
repositories for contact submissions. GitHub also requires **Metadata:
read-only**. A PAT can be used instead. `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` remain separate from the App ID and private key.

If the GitHub App installation reports missing permissions, its token cannot
read or write those repositories. OAuth bearer tokens can authorize an
individual request when they have the needed repository scope; otherwise
configure a server token with the same minimum repository permissions. Writes
that need branches or review PRs fail until one of those credentials is
authorized.

The default CORS allowlist includes `https://genepedia.org`,
`https://www.genepedia.org`, `https://gravepedia.org`, and
`https://www.gravepedia.org`. CORS reflects only an exact allowed origin and
allows credentialed requests. Add the exact origin for a hosted Site preview
or final Site URL to `GITHUB_ALLOWED_CORS_ORIGINS` when known; wildcard origins
are not supported.

OAuth state expires after 10 minutes and is bound to an HttpOnly CSRF cookie.
State and handoff records are consumed once in D1. A handoff expires after
three minutes. Session and handoff payloads are encrypted in D1; the browser
gets the short-lived GitHub access token from the existing handoff endpoint so
the current frontend can retain its bearer-token flow.

Local login uses the same one-time D1 handoff and encrypted HttpOnly session
cookie, but its response has `auth_type: "local"` and no GitHub access token.
The shared frontend must redeem the handoff with cookies enabled and must not
store or send a bearer token for local sessions. Local sessions can browse as
signed-in users; GitHub write, merge, decline, and moderation routes require a
GitHub-authenticated session and never use server publish credentials for a
local identity.

`LOCAL_LOGIN_PASSWORD_HASH` accepts
`pbkdf2-sha256$iterations$salt-base64url$digest-base64url`, with 100,000 to
1,000,000 PBKDF2-SHA-256 iterations, a 16 to 64 byte salt, and a 16 to 64 byte
derived digest. The Worker uses the hash when present; otherwise it compares
`LOCAL_LOGIN_PASSWORD` in constant time. PHP bcrypt strings such as `$2y$...`
are not a Worker-supported hash format, so use the password secret or configure
a PBKDF2 hash in the Sites secret manager.

## Supported routes

Routes keep their `.php` suffix where the existing frontend expects it.

- Authentication: `github-config.php`, `github-login.php`, `local-login.php`,
  `github-callback.php`, `github-session.php`, `github-logout.php`, and
  `github-handoff.php`.
- Public reads: `data.php?path=...`, `media.php?path=...`,
  `github-file-commits.php`, `github-file-commit-diff.php`, and
  `location-search.php`.
- GitHub submissions: `github-submit-page-edit.php` creates review PRs;
  `github-media.php` lists public profile media and accepts authenticated
  upload/delete submissions as review PRs and allows profile managers to
  approve/decline those PRs; `github-contact.php` opens a
  GitHub issue under the signed-in visitor's account.
- Pull requests: `github-pull-requests.php` lists open PRs or reads one PR;
  `github-pull-request-review.php` lets the configured reviewer merge or close
  one.
- Self-profile: `github-self-profile.php` validates and opens review PRs for
  profile creation across the site and database repositories, and for claiming
  existing database ownership records.
- Maintainers: `github-maintainers.php` reads the ownership ledger and submits
  request, invitation, acceptance, decline, approval, and cancellation PRs.
  Cross-repository updates produce one PR per fixed repository; if a later PR
  fails, earlier PRs are closed and their branches deleted where possible, and
  any remaining open PRs are reported in the error response.
- Talk: `github-talk.php` publicly reads profile discussions and directly
  commits signed-in posts/deletions to the site repository. Authors, profile
  owners, maintainers, and the configured reviewer can delete a message.
- Statistics: `github-statistics.php` supports public GET reads and anonymous
  POST events. Events buffer in D1 up to a hard 10,000-event limit; a saturated
  queue rejects new events with HTTP 429 until events publish. Events publish
  in bounded batches to the database repository; `github-profile-views.php`
  remains a backward-compatible read/write wrapper. `github-statistics-flush.php`
  accepts authenticated GET or POST requests for scheduled flushes.
- Gravepedia: `memorials.php?q=...` returns
  `{success, query, results, total}`; `POST memorials.php` requires GitHub sign-in
  and opens a pending-review memorial submission PR.
- `__capabilities` returns the Worker-supported and unimplemented route list.

GitHub OAuth success best-effort stars and follows configured welcome targets.
Each target is handled independently and failures do not prevent sign-in.
Stars use idempotent GitHub REST `PUT` requests. User follows check current
state before following; organization follows use the GitHub GraphQL mutation
with REST fallbacks. Local sign-in does not trigger GitHub mutations.

For Genepedia database reads, `data.php?path=people/...` is routed to the
database repository. The historical workspace prefix
`data/Genepedia-Database/` is also accepted and removed before the GitHub read.
For Gravepedia, `data.php` accepts only `data/memorials/...` paths.

## PHP endpoint not implemented

This legacy PHP endpoint remains unsupported in public hosting:

- `check_writable_tmp.php` — PHP-host-only writable temporary directory check.

Media management checks the profile ownership record in
`Genepedia/Genepedia-Database` or the configured global reviewer login before
allowing uploads, removals, approvals, or declines.

The generic page-edit and media routes always open a pull request. They do not
replicate PHP paths that directly commit changes to the default branch.

## Build and focused local validation

Run from this directory:

```sh
npm run build
npm run validate
```

The build copies the Worker ESM entry point and Sites hosting manifest to
`dist/`. Validation checks the emitted ESM artifact and exercises CORS,
memorial search/submission auth, fixed-repository path rejection, profile and
maintainer route validation, talk reads/writes auth, authorized reviewer/media
write-token fallback, oldest-commit history pagination, cleanup after a
second-repository PR failure, atomic D1 statistics queue saturation, and the
flush-secret gate with local mocks. It does not contact GitHub or require
secrets.
