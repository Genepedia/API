# Quick copy-paste instructions for the API repository

1. Copy the contents of this repository to your server document root (for
   example `/var/www/genepedia/`) so endpoints are reachable at
   `https://<your-host>/genepedia/{file}.php`.

2. Create a **GitHub App** (or use your existing one) at
   https://github.com/settings/apps

   **Repository permissions** (required for the whole site):

   | Permission | Access | Used for |
   |---|---|---|
   | Metadata | Read-only | Repo lookup (always required) |
   | Contents | Read and write | Changes tab, commit diffs, footer “last edited”, page editor saves |
   | Pull requests | Read and write | Page editor opens a PR after save |

   **Account permissions** (for “Sign in with GitHub”):

   | Permission | Access | Used for |
   |---|---|---|
   | Email addresses | Read-only | User email in session (login still works without it) |

   No organization permissions are needed. Install the app on the **Genepedia**
   organization with access to the `Genepedia` repository.

   From the app settings page, note:
   - **App ID** → `GITHUB_APP_ID`
   - **Client ID** (starts with `Iv1.`) → `GITHUB_CLIENT_ID` — this is **not** the App ID
   - Generate a **Client secret** → `GITHUB_CLIENT_SECRET`
   - Generate a **Private key** (.pem) and download it

   **Account permissions** (for site login):
   - Email addresses: Read-only

   Installing on the **Genepedia organization** is correct — the app must be installed
   on whichever account owns `Genepedia/Genepedia`.

3. Fill in `.env` in this repository (every `FILL_IN` value), then upload it next to
   the PHP files on the server. The file is ignored by git.

   Double-check the two IDs are not swapped:
   - `GITHUB_APP_ID` = numeric **App ID**
   - `GITHUB_CLIENT_ID` = **Client ID** starting with `Iv1.`

4. Upload the **updated PHP files** (`github-auth.php`, `github-config.php`, etc.)
   and the private key next to the PHP files (do **not** commit the key):

   ```
   scp github-app-private-key.pem user@server:/var/www/genepedia/
   sudo chown www-data:www-data /var/www/genepedia/github-app-private-key.pem
   sudo chmod 600 /var/www/genepedia/github-app-private-key.pem
   ```

5. Ensure the webserver user can read the API files and that PHP has the
   `curl` and `session` extensions enabled. Typical permissions:

   ```
   sudo chown -R www-data:www-data /var/www/genepedia
   sudo find /var/www/genepedia -type d -exec chmod 755 {} \;
   sudo find /var/www/genepedia -type f -exec chmod 644 {} \;
   ```

6. In your GitHub App settings, add this exact **Callback URL**:
   `https://api.shaunroselt.com/genepedia/github-callback.php`

   If login fails with `github_auth_error=token_exchange`, the usual causes are:
   - `GITHUB_CLIENT_ID` is missing or still the old OAuth app ID
   - `GITHUB_CLIENT_SECRET` does not match that Client ID
   - Callback URL is missing or does not match exactly

7. Test configuration:

   ```
   curl -s 'https://api.shaunroselt.com/genepedia/github-config.php'
   curl -s 'https://api.shaunroselt.com/genepedia/github-file-commits.php?path=pages/home.html&limit=1'
   ```

   `github-config.php` should report:
   - `"configured": true` under `github_app`
   - `"installation_token_error": null`
   - `"configured": true` and `"method": "github_app"` under `api_auth`
   - `"can_publish": true` under `publish_auth`

   If `github_app.private_key_readable` is `false`, the `.pem` file is missing or
   not uploaded to the same folder as `github-auth.php`.

## Security notes

- Do NOT commit `.env`, client secrets, or `.pem` private keys to version control.
- Restrict the private key file to the webserver user (`chmod 600`).
- Use a server-side secret manager or environment variables if available.
