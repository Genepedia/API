# API

Shared API between Genepedia projects.

## Endpoints

- `github-login.php`
- `github-callback.php`
- `github-session.php`
- `github-logout.php`
- `github-file-commits.php` — live file commit history for Genepedia pages (GitHub REST API proxy)
- `github-file-commit-diff.php` — before/after file contents and unified diff for a single commit
- `github-config.php` — reports whether OAuth and GitHub API authentication are configured
- `github-submit-page-edit.php` — creates a branch, commit, and pull request for page editor changes (uses a GitHub App installation token or PAT with repository write access)
- `github-pull-requests.php` — lists open page-editor pull requests and returns file diffs for a selected PR
- `github-pull-request-review.php` — approves (merge) or declines (close) a pull request; restricted to `GITHUB_REVIEW_LOGIN`

These endpoints are used by the shared `Web-Framework` header for GitHub authentication and sessions.
`github-file-commits.php` powers the Changes tab on Genepedia pages.

## Configuration

Fill in `.env` on the server. Configure a [GitHub App](https://github.com/settings/apps)
with Contents and Pull requests write access, install it on the repository, and set
`GITHUB_APP_ID` plus `GITHUB_APP_PRIVATE_KEY_PATH` (upload the `.pem` key to the
server). Use the app's Client ID and a client secret for `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET` so users can sign in with GitHub OAuth.

GitHub login requests the `public_repo` scope so signed-in editors are identified when
submitting pull requests. Server-side API calls (commit history and publishing) use the
GitHub App installation token when configured. PAT fallbacks (`GITHUB_API_TOKEN`,
`GITHUB_PUBLISH_TOKEN`) are optional.

The `.env` file and private keys are ignored and should not be committed.
See `COPY_TO_SERVER.md` for full deployment steps.

`github-file-commits.php` accepts `?path=pages/privacy_policy.html` or a comma-separated
`?paths=people/15/profile.html,people/15/data/profile.html,...` query for merged profile
history. It fetches commit history from the GitHub REST API using the server token and
returns normalized JSON for the front end.

Both Genepedia and Gravepedia currently point at:

```text
https://api.shaunroselt.com/genepedia
```

See `COPY_TO_SERVER.md` for deployment notes.
