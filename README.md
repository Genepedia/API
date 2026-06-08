# API

Shared API between Genepedia projects.

## Endpoints

- `github-login.php`
- `github-callback.php`
- `github-session.php`
- `github-logout.php`
- `github-file-commits.php` — live file commit history for Genepedia pages (GitHub REST API proxy)

These endpoints are used by the shared `Web-Framework` header for GitHub authentication and sessions.
`github-file-commits.php` powers the Changes tab on Genepedia pages.

## Configuration

Copy `.env.example` to `.env` on the server and set `GITHUB_CLIENT_SECRET`.
For commit history, also set `GITHUB_API_TOKEN` (a repo-scoped PAT with read access).
The `.env` file is ignored and should not be committed.

`github-file-commits.php` accepts `?path=pages/privacy_policy.html`, fetches the latest full commit history from the GitHub REST API using the server token, and returns normalized JSON for the front end.

Both Genepedia and Gravepedia currently point at:

```text
https://api.shaunroselt.com/genepedia
```

See `COPY_TO_SERVER.md` for deployment notes.
