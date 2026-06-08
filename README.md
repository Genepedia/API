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

These endpoints are used by the shared `Web-Framework` header for GitHub authentication and sessions.
`github-file-commits.php` powers the Changes tab on Genepedia pages.

## Configuration

Copy `.env.example` to `.env` on the server and set `GITHUB_CLIENT_SECRET`.
For commit history, **you must set `GITHUB_API_TOKEN`** (a PAT with read access to the
repository). Run `./scripts/configure-github-api-token.sh` locally, then deploy the
updated `.env` to the server. Alternatively, use `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` for GitHub App authentication.
The `.env` file is ignored and should not be committed.

`github-file-commits.php` accepts `?path=pages/privacy_policy.html`, fetches the latest full commit history from the GitHub REST API using the server token, and returns normalized JSON for the front end.

Both Genepedia and Gravepedia currently point at:

```text
https://api.shaunroselt.com/genepedia
```

See `COPY_TO_SERVER.md` for deployment notes.
