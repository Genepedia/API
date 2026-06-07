# API

Shared API between Genepedia projects.

## Endpoints

- `github-login.php`
- `github-callback.php`
- `github-session.php`
- `github-logout.php`

These endpoints are used by the shared `Web-Framework` header for GitHub authentication and sessions.

## Configuration

Copy `.env.example` to `.env` on the server and set `GITHUB_CLIENT_SECRET`.
The `.env` file is ignored and should not be committed.

Both Genepedia and Gravepedia currently point at:

```text
https://api.shaunroselt.com/genepedia
```

See `COPY_TO_SERVER.md` for deployment notes.
