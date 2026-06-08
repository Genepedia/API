# Quick copy-paste instructions for the API repository

1. Copy the contents of this repository to your server document root (for
   example `/var/www/genepedia/`) so endpoints are reachable at
   `https://<your-host>/genepedia/{file}.php`.

2. On the server, create or edit `.env` next to the PHP files (this file is ignored by
   the repository). Set `GITHUB_CLIENT_SECRET` to your GitHub app secret,
   `GITHUB_API_TOKEN` to a repo read token for commit history, and make sure both
   `https://genepedia.org` and `https://www.genepedia.org` are allowed origins if
   the public site redirects to `www`.

   Example (edit the file directly):

   GITHUB_CLIENT_SECRET=your_github_app_secret_here
   GITHUB_API_TOKEN=your_github_personal_access_token_here
   GITHUB_REPO=Genepedia/Genepedia
   GITHUB_ALLOWED_RETURN_ORIGINS=https://genepedia.org,https://www.genepedia.org,https://api.shaunroselt.com
   GITHUB_ALLOWED_CORS_ORIGINS=https://genepedia.org,https://www.genepedia.org
   GITHUB_DEFAULT_RETURN_TO=https://www.genepedia.org/

3. Ensure the webserver user can read the API files and that PHP has the
   `curl` and `session` extensions enabled. Typical permissions:

   sudo chown -R www-data:www-data /var/www/genepedia
   sudo find /var/www/genepedia -type d -exec chmod 755 {} \;
   sudo find /var/www/genepedia -type f -exec chmod 644 {} \;

4. Test the session endpoint to confirm configuration:

   curl -i -H "Origin: https://www.genepedia.org" 'https://api.shaunroselt.com/genepedia/github-session.php'

   The JSON should include `"configured": true` once `GITHUB_CLIENT_SECRET`
   is set and readable by PHP.

Security notes
- Do NOT commit `.env` or your secret to version control.
- Use a server-side secret manager or environment variables if available.
