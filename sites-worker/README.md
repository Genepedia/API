# Genepedia API

The production API is a JavaScript ES module running as a Cloudflare Worker
through ChatGPT Sites. One versioned API serves Genepedia and Gravepedia:

- `https://api.genepedia.org/v1/genepedia`
- `https://api.genepedia.org/v1/gravepedia`
- Shared GitHub OAuth callback: `https://api.genepedia.org/v1/auth/github/callback`

The service uses the Web `Request`, `Response`, `fetch`, and Web Crypto APIs;
it has no application framework or runtime package dependencies. The legacy
PHP files in the parent repository are not part of this deployment. GitHub
remains the source of record for published site, people, memorial, and media
data. This Worker fixes every repository it can access in `worker/index.js`;
callers cannot choose an arbitrary GitHub owner or repository.

The OpenAPI 3.1 contract is in [`openapi.json`](openapi.json).

## API contract

`GET /v1` returns service discovery. Site-specific routes share the same
resource paths under their site base. Responses are JSON unless a route returns
the GitHub OAuth redirect or a proxied media file. Errors use the shape
`{ "ok": false, "error": "...", "message": "..." }`.

| Method | Genepedia and Gravepedia route | Purpose |
| --- | --- | --- |
| `GET` | `/auth/github/config` | Public authentication and repository configuration |
| `GET` | `/auth/github/login` | Start GitHub OAuth; accepts an allowlisted `return_to` |
| `POST` | `/auth/local/login` | Optional standalone username/password login |
| `GET` | `/auth/session` | Read the current session |
| `POST` | `/auth/logout` | End the current session |
| `POST` | `/auth/handoff` | Redeem a one-time login handoff |
| `GET` | `/data?path=...` | Read an allowlisted public data file from GitHub |
| `GET` | `/media?path=...` | Read an allowlisted public media file from GitHub |
| `GET` | `/files/commits?path=...` | Read allowed file history; accepts up to 12 paths |
| `GET` | `/files/commit-diff?path=...&hash=...` | Read an allowed commit diff |
| `GET` | `/pull-requests` | List open edit requests or inspect one request |
| `POST` | `/pull-requests/review` | Merge or close a request as the configured reviewer |
| `POST` | `/page-edits` | Submit a page edit for review |
| `GET`, `POST` | `/profiles/media` | List profile media or submit an upload/removal for review |
| `POST` | `/contact` | Submit a signed-in contact issue |
| `GET`, `POST` | `/statistics` | Read published statistics or queue an event |
| `GET`, `POST` | `/statistics/profile-views` | Profile-view compatibility resource |
| `GET` | `/search/locations?q=...` | Search locations for profile editors |
| `GET` | `/meta/capabilities` | List supported and unavailable features |

Genepedia also provides:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/profiles/self` | Submit profile creation or ownership claim changes |
| `GET`, `POST` | `/maintainers` | Read or submit maintainer requests and decisions |
| `GET`, `POST` | `/talk` | Read, post, or delete profile discussions |
| `GET`, `POST` | `/statistics/flush` | Flush queued statistics with the configured secret |

Gravepedia also provides:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/memorials?q=...` | Search published memorials |
| `POST` | `/memorials` | Submit a memorial for review |

The shared callback is the exception to the site bases. OAuth state records
which site initiated the login, so both frontends return through the same
registered callback. The Worker accepts the previous frontend route spellings
as compatibility aliases while cached pages age out; current frontends use
only the versioned routes above.

For page history, a public extensionless URL such as `pages/login` maps to the
source file `pages/login.html`. Other GitHub paths remain restricted to the
allowlisted repositories and formats in the Worker.

## GitHub repository routing

| Site/API prefix | Site and data repository | Media repository |
| --- | --- | --- |
| `/v1/genepedia` | `Genepedia/Genepedia`; `Genepedia/Genepedia-Database` for database/statistics paths | `Genepedia/Genepedia-Media` |
| `/v1/gravepedia` | `Genepedia/Gravepedia` for pages and `data/memorials/` | `Genepedia/Gravepedia-Media` |

Public content reads use the GitHub API and raw file URLs. Writes use a
server-side GitHub App installation token or a publish token, and create a
branch plus review pull request. Gravepedia submissions remain pending until
a maintainer merges their review request.

## Storage and secrets

`.openai/hosting.json` declares the Sites D1 binding `DB`. Sites applies the
schema migration in `drizzle/0000_worker_storage.sql` before uploading the
Worker; request handling never changes the schema. D1 stores expiring OAuth
state, one-time handoffs, encrypted sessions, and queued statistics events.
GitHub stores the published site content and records.

Set runtime values in the Sites secret manager. Do not add secrets or key files
to this source tree or hosting manifest.

| Variable | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth/App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `GITHUB_SESSION_SECRET` | High-entropy key source used to encrypt session records in D1 |
| `GITHUB_CALLBACK_URL` | Optional callback override; default is `https://api.genepedia.org/v1/auth/github/callback`. Register this exact URL in GitHub |
| `GITHUB_APP_ID` | Optional numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Optional GitHub App PEM key, supplied as a runtime secret |
| `GITHUB_APP_INSTALLATION_ID` | Optional installation ID; otherwise looked up for the fixed site repository |
| `GITHUB_PUBLISH_TOKEN` | Optional token with Contents and Pull requests write access to the fixed repositories |
| `GITHUB_API_TOKEN` | Optional GitHub API read token; can also be used for authorized writes |
| `GITHUB_REVIEW_LOGIN` | GitHub login allowed to merge or decline review requests |
| `GITHUB_STATISTICS_FLUSH_TOKEN` | Secret required to flush the statistics queue |
| `GITHUB_STATISTICS_SYNC` | Set to `0` to retain queued events without publishing them to GitHub |
| `GITHUB_ALLOWED_CORS_ORIGINS` | Comma-separated exact origins allowed to call the API |
| `GITHUB_ALLOWED_RETURN_ORIGINS` | Comma-separated HTTPS origins allowed for OAuth return URLs |
| `GITHUB_WELCOME_ACTIONS` | Set to `0`, `false`, `no`, or `off` to disable welcome stars and follows |
| `GITHUB_WELCOME_STAR_REPOS` | Comma-separated repositories to star after GitHub login |
| `GITHUB_WELCOME_FOLLOW_USERS` | Comma-separated GitHub accounts to follow after login |
| `LOCAL_LOGIN_USERNAME` | Optional username for the standalone local login page |
| `LOCAL_LOGIN_PASSWORD` | Optional password secret; leave unset to disable password login |
| `LOCAL_LOGIN_PASSWORD_HASH` | Optional PBKDF2-SHA-256 password hash; takes precedence over the password |
| `LOCAL_LOGIN_DISPLAY_NAME` | Optional display name for a local login |

GitHub App credentials are preferred for writes. The App needs Contents and
Pull requests read/write on the site, database, and media repositories; Issues
write is needed for contact submissions. GitHub requires Metadata read-only.
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are separate from the App ID and
private key.

The CORS allowlist uses exact origins, reflects only an allowed origin, and
supports credentialed requests. Wildcard origins are not supported. OAuth
state is single-use, bound to an HttpOnly CSRF cookie, and expires after ten
minutes. Handoffs expire after three minutes. Session and handoff payloads are
encrypted in D1.

Local login sessions can browse but cannot use GitHub write, merge, decline,
or moderation routes. Those operations require a GitHub-authenticated session.
`LOCAL_LOGIN_PASSWORD_HASH` uses
`pbkdf2-sha256$iterations$salt-base64url$digest-base64url`, with 100,000 to
1,000,000 PBKDF2-SHA-256 iterations. PHP bcrypt hashes are not accepted by the
Worker.

## Build and validation

Run from this directory:

```sh
npm run build
npm run validate
```

Validation checks the emitted ESM artifact and exercises API discovery,
versioned and compatibility routes, CORS, OAuth callback construction,
memorial search/submission auth, repository path restrictions, profile and
maintainer permissions, talk and media write authorization, pull request
cleanup, file-history pagination and extensionless page paths, statistics
queue limits, and the flush-secret gate with local mocks. It does not contact
GitHub or require production secrets.
