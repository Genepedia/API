# API

Shared API between Genepedia projects.

## Endpoints

- `local-login.php` — validates the username/password from the standalone `pages/login.html` page against `.env` and issues a login handoff. See "Standalone login page" below.
- `github-login.php`
- `github-callback.php`
- `github-handoff.php` — exchanges a one-time post-login code for a user access token (used when cross-site cookies are blocked)
- `github-session.php`
- `github-logout.php`
- `github-file-commits.php` — live file commit history for Genepedia pages (GitHub REST API proxy)
- `github-file-commit-diff.php` — before/after file contents and unified diff for a single commit
- `github-config.php` — reports whether OAuth and GitHub API authentication are configured
- `github-submit-page-edit.php` — commits managed page/profile edits directly and opens pull requests for edits that need review (uses a GitHub App installation token or PAT with repository write access)
- `github-self-profile.php` — directly commits new profiles and profile ownership without opening a pull request
- `github-maintainers.php` — directly commits maintainer invitations, requests, and accepted maintainer access
- `github-media.php` — directly commits managed profile media uploads/removals and reviews legacy pending media pull requests
- `github-pull-requests.php` — lists open page-editor pull requests and returns file diffs for a selected PR
- `github-pull-request-review.php` — approves (merge) or declines (close) a pull request; restricted to `GITHUB_REVIEW_LOGIN`
- `github-contact.php` — creates a GitHub issue from the public contact form using the GitHub App installation token or PAT (no GitHub sign-in required)
- `github-statistics.php` — unified statistics API: records profile views and search queries, returns popular profiles/searches and a generated summary
- `github-profile-views.php` — backward-compatible wrapper for profile view recording and popular profiles (prefer `github-statistics.php` for new integrations)
- `location-search.php` — public place-search proxy used by structured location fields in the profile editor

These endpoints are used by the shared `Web-Framework` header for GitHub authentication and sessions.
`github-file-commits.php` powers the Changes tab on Genepedia pages.

## Configuration

Fill in `.env` on the server. Configure a [GitHub App](https://github.com/settings/apps)
with Contents and Pull requests write access, install it on the repository, and set
`GITHUB_APP_ID` plus `GITHUB_APP_PRIVATE_KEY_PATH` (upload the `.pem` key to the
server). Use the app's Client ID and a client secret for `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET` so users can sign in with GitHub OAuth.

After a successful login, the API best-effort stars repos and follows accounts listed
in `.env` (`GITHUB_WELCOME_STAR_REPOS`, `GITHUB_WELCOME_FOLLOW_USERS`). User accounts
are followed through the REST API; organization accounts use the GraphQL
`followOrganization` mutation. Set `GITHUB_WELCOME_ACTIONS=0` to disable that behavior.
The GitHub App needs account permissions for Starring and Followers (read and write).
Server-side API calls (commit history and publishing) use the GitHub App installation
token when configured. PAT fallbacks (`GITHUB_API_TOKEN`, `GITHUB_PUBLISH_TOKEN`) are
optional.

The `.env` file and private keys are ignored and should not be committed.
See `COPY_TO_SERVER.md` for full deployment steps.

## Standalone login page

The sign-in page itself lives in the **site** repo at `pages/login.html`. It is
**not linked anywhere** on the public site, is served `noindex`, and is left out
of `sitemap.xml`. Access it directly, e.g. `https://www.genepedia.org/pages/login.html`.
It offers two ways in:

- **Username / password** — the page posts the credentials to `local-login.php`,
  which validates them server-side against `.env`:
  - `LOCAL_LOGIN_USERNAME` — the allowed username (leave blank to disable this form entirely).
  - `LOCAL_LOGIN_PASSWORD` — plaintext password, **or**
  - `LOCAL_LOGIN_PASSWORD_HASH` — a bcrypt hash (recommended; takes priority over the plaintext value).
    Generate one with `php -r 'echo password_hash("your-password", PASSWORD_DEFAULT), "\n";'`.
  - `LOCAL_LOGIN_DISPLAY_NAME` — optional name shown in the header after sign-in.
- **Continue with GitHub** — the normal GitHub OAuth flow (unchanged).

On a successful username/password sign-in, `local-login.php` issues the same
one-time login handoff that GitHub login uses; the page redirects to the home
page with that handoff code and the front-end completes sign-in. The public
header "Log In" button is unchanged and still uses GitHub only.

Note: the local user is not backed by a GitHub access token, so it can browse
signed-in but cannot publish edits to GitHub. Use GitHub login for editing.

`github-file-commits.php` accepts `?path=pages/privacy_policy.html` or a comma-separated
`?paths=people/15/profile.html,people/15/data/profile.html,...` query for merged profile
history. It fetches commit history from the GitHub REST API using the server token and
returns normalized JSON for the front end.

Both Genepedia and Gravepedia currently point at:

```text
https://api.shaunroselt.com/genepedia
```

See `COPY_TO_SERVER.md` for deployment notes.
