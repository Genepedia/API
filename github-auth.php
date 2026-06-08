<?php

declare(strict_types=1);

// Optional .env loader for simple copy/paste deployments:
// If a file named `.env` exists next to these API files, it
// will be parsed and the variables will be placed into the process
// environment so the rest of this script can use `getenv()` as usual.
$envFile = __DIR__ . '/.env';
if (file_exists($envFile) && is_readable($envFile)) {
    $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }

        // Support KEY=VALUE and export KEY=VALUE
        if (str_starts_with($line, 'export ')) {
            $line = trim(substr($line, 7));
        }

        $parts = explode('=', $line, 2);
        if (count($parts) !== 2) {
            continue;
        }

        $key = trim($parts[0]);
        $value = trim($parts[1]);

        // Remove surrounding quotes if present
        if ((str_starts_with($value, '"') && str_ends_with($value, '"')) || (str_starts_with($value, "'") && str_ends_with($value, "'"))) {
            $value = substr($value, 1, -1);
        }

        if ($key !== '') {
            $existing = getenv($key);
            if ($existing === false || trim((string) $existing) === '') {
                putenv(sprintf('%s=%s', $key, $value));
                $_ENV[$key] = $value;
                $_SERVER[$key] = $value;
            }
        }
    }
}

const GITHUB_OAUTH_SCOPE = 'read:user user:email';
const GITHUB_SESSION_USER_KEY = 'github_user';
const GITHUB_SESSION_TOKEN_KEY = 'github_access_token';
const GITHUB_SESSION_STATE_KEY = 'github_oauth_state';
const GITHUB_SESSION_RETURN_TO_KEY = 'github_oauth_return_to';
const GITHUB_DEFAULT_CLIENT_ID = 'Ov23liPGTumhPzPYFhnh';

function github_is_https_request(): bool
{
    return !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
}

function github_normalize_origin(string $value): ?string
{
    $candidate = trim($value);
    if ($candidate === '') {
        return null;
    }

    $parts = parse_url($candidate);
    if ($parts === false) {
        return null;
    }

    $scheme = strtolower((string) ($parts['scheme'] ?? ''));
    $host = strtolower((string) ($parts['host'] ?? ''));
    if (($scheme !== 'http' && $scheme !== 'https') || $host === '') {
        return null;
    }

    $origin = $scheme . '://' . $host;
    if (isset($parts['port'])) {
        $origin .= ':' . (int) $parts['port'];
    }

    return $origin;
}

function github_env_url_list(string $name): array
{
    $raw = trim((string) (getenv($name) ?: ''));
    if ($raw === '') {
        return [];
    }

    $origins = [];
    foreach (preg_split('/\s*,\s*/', $raw) ?: [] as $entry) {
        $origin = github_normalize_origin($entry);
        if ($origin !== null) {
            $origins[] = $origin;
        }
    }

    return array_values(array_unique($origins));
}

function github_request_origin(): ?string
{
    return github_normalize_origin((string) ($_SERVER['HTTP_ORIGIN'] ?? ''));
}

function github_start_session(): void
{
    github_apply_cors();

    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    $secure = github_is_https_request();
    $sameSite = github_session_same_site();
    session_set_cookie_params([
        'httponly' => true,
        'samesite' => $sameSite,
        'secure' => $secure,
        'path' => '/',
    ]);

    session_start();
}

function github_config(): array
{
    $clientId = trim((string) (getenv('GITHUB_CLIENT_ID') ?: GITHUB_DEFAULT_CLIENT_ID));
    $clientSecret = trim((string) (getenv('GITHUB_CLIENT_SECRET') ?: ''));

    return [
        'client_id' => $clientId,
        'client_secret' => $clientSecret,
        'scope' => GITHUB_OAUTH_SCOPE,
    ];
}

function github_api_base_path(): string
{
    $scriptName = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? '/api'));
    $dirName = rtrim(str_replace('\\', '/', dirname($scriptName)), '/');

    return $dirName === '' ? '' : $dirName;
}

function github_site_base_path(): string
{
    $apiPath = github_api_base_path();
    if ($apiPath === '' || $apiPath === '/api') {
        return '';
    }

    $sitePath = rtrim(str_replace('\\', '/', dirname($apiPath)), '/');
    return $sitePath === '/' ? '' : $sitePath;
}

function github_origin(): string
{
    $isHttps = github_is_https_request();
    $scheme = $isHttps ? 'https' : 'http';
    $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');

    return $scheme . '://' . $host;
}

function github_allowed_return_origins(): array
{
    $origins = github_env_url_list('GITHUB_ALLOWED_RETURN_ORIGINS');
    if ($origins === []) {
        $defaultReturnTo = trim((string) (getenv('GITHUB_DEFAULT_RETURN_TO') ?: ''));
        $defaultReturnOrigin = github_normalize_origin($defaultReturnTo);
        if ($defaultReturnOrigin !== null) {
            $origins[] = $defaultReturnOrigin;
        }
    }

    $origins[] = github_origin();
    return array_values(array_unique(array_filter($origins)));
}

function github_allowed_cors_origins(): array
{
    $origins = github_env_url_list('GITHUB_ALLOWED_CORS_ORIGINS');
    if ($origins !== []) {
        return $origins;
    }

    return github_allowed_return_origins();
}

function github_session_same_site(): string
{
    $configured = strtolower(trim((string) (getenv('GITHUB_SESSION_SAMESITE') ?: '')));
    if ($configured === 'strict') {
        return 'Strict';
    }

    if ($configured === 'none') {
        return 'None';
    }

    if ($configured === 'lax') {
        return 'Lax';
    }

    if (!github_is_https_request()) {
        return 'Lax';
    }

    foreach (github_allowed_return_origins() as $origin) {
        if ($origin !== github_origin()) {
            return 'None';
        }
    }

    return 'Lax';
}

function github_apply_cors(): void
{
    $origin = github_request_origin();
    if ($origin !== null && in_array($origin, github_allowed_cors_origins(), true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Access-Control-Allow-Credentials: true');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Allow-Headers: Accept, Content-Type');
        header('Vary: Origin');
    }

    if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function github_url(string $path): string
{
    $prefix = github_api_base_path();
    if ($prefix !== '' && str_starts_with($path, '/')) {
        $path = $prefix . $path;
    }

    return github_origin() . $path;
}

function github_callback_url(): string
{
    return github_url('/github-callback.php');
}

function github_default_return_to(): string
{
    $configured = trim((string) (getenv('GITHUB_DEFAULT_RETURN_TO') ?: ''));
    if ($configured !== '') {
        $parts = parse_url($configured);
        if ($parts !== false && isset($parts['scheme'], $parts['host'])) {
            return $configured;
        }
    }

    return github_origin() . github_site_base_path() . '/index.html';
}

function github_normalize_return_to(?string $value): string
{
    $candidate = trim((string) $value);
    if ($candidate === '') {
        return github_default_return_to();
    }

    $parts = parse_url($candidate);
    if ($parts === false) {
        return github_default_return_to();
    }

    if (!isset($parts['host'])) {
        if (!str_starts_with($candidate, '/')) {
            return github_default_return_to();
        }

        return github_origin() . $candidate;
    }

    $originParts = parse_url(github_origin()) ?: [];
    $candidateOrigin = github_normalize_origin($candidate);
    if ($candidateOrigin === null || !in_array($candidateOrigin, github_allowed_return_origins(), true)) {
        return github_default_return_to();
    }

    return $candidate;
}

function github_json(array $payload, int $status = 200, ?string $cacheControl = null): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: ' . ($cacheControl ?? 'no-store, no-cache, must-revalidate, max-age=0'));
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function github_redirect(string $url): void
{
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Location: ' . $url, true, 302);
    exit;
}

function github_require_config(): array
{
    $config = github_config();
    if ($config['client_id'] === '' || $config['client_secret'] === '') {
        github_json([
            'authenticated' => false,
            'error' => 'github_oauth_not_configured',
            'message' => 'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET before using GitHub login.',
        ], 500);
    }

    return $config;
}

function github_build_authorize_url(string $state, string $returnTo): string
{
    $config = github_require_config();
    $_SESSION[GITHUB_SESSION_STATE_KEY] = $state;
    $_SESSION[GITHUB_SESSION_RETURN_TO_KEY] = $returnTo;

    $query = http_build_query([
        'client_id' => $config['client_id'],
        'redirect_uri' => github_callback_url(),
        'scope' => $config['scope'],
        'state' => $state,
        'prompt' => 'select_account',
    ]);

    return 'https://github.com/login/oauth/authorize?' . $query;
}

function github_request_json(string $method, string $url, array $headers = [], ?array $body = null): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('PHP cURL is required for GitHub OAuth.');
    }

    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('Failed to initialize cURL.');
    }

    $normalizedHeaders = [
        'Accept: application/json',
        'User-Agent: Genepedia-GitHub-OAuth',
    ];

    foreach ($headers as $name => $value) {
        $normalizedHeaders[] = $name . ': ' . $value;
    }

    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => strtoupper($method),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $normalizedHeaders,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => 20,
    ]);

    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($body));
        $normalizedHeaders[] = 'Content-Type: application/x-www-form-urlencoded';
        curl_setopt($ch, CURLOPT_HTTPHEADER, $normalizedHeaders);
    }

    $raw = curl_exec($ch);
    if ($raw === false) {
        $message = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('GitHub request failed: ' . $message);
    }

    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        throw new RuntimeException('GitHub returned an invalid JSON response.');
    }

    if ($status >= 400) {
        $message = (string) ($decoded['error_description'] ?? $decoded['message'] ?? 'GitHub request failed.');
        throw new RuntimeException($message);
    }

    return $decoded;
}

function github_exchange_code(string $code): string
{
    $config = github_require_config();
    $response = github_request_json('POST', 'https://github.com/login/oauth/access_token', [], [
        'client_id' => $config['client_id'],
        'client_secret' => $config['client_secret'],
        'code' => $code,
        'redirect_uri' => github_callback_url(),
    ]);

    $token = trim((string) ($response['access_token'] ?? ''));
    if ($token === '') {
        throw new RuntimeException('GitHub did not return an access token.');
    }

    return $token;
}

function github_fetch_user(string $token): array
{
    $headers = [
        'Authorization' => 'Bearer ' . $token,
        'X-GitHub-Api-Version' => '2022-11-28',
    ];

    $user = github_request_json('GET', 'https://api.github.com/user', $headers);
    $emails = github_request_json('GET', 'https://api.github.com/user/emails', $headers);

    $primaryEmail = '';
    foreach ($emails as $email) {
        if (!is_array($email)) {
            continue;
        }

        if (!empty($email['primary']) && !empty($email['verified']) && !empty($email['email'])) {
            $primaryEmail = (string) $email['email'];
            break;
        }
    }

    $displayName = trim((string) ($user['name'] ?? ''));
    $login = trim((string) ($user['login'] ?? ''));

    $givenName = '';
    $familyName = '';
    if ($displayName !== '') {
        $parts = preg_split('/\s+/', $displayName) ?: [];
        if (count($parts) === 1) {
            $givenName = $parts[0];
        } elseif (count($parts) > 1) {
            $givenName = (string) array_shift($parts);
            $familyName = implode(' ', $parts);
        }
    }

    if ($givenName === '' && $familyName === '' && $login !== '') {
        $givenName = $login;
    }

    return [
        'id' => (string) ($user['id'] ?? ''),
        'login' => $login,
        'displayName' => $displayName !== '' ? $displayName : $login,
        'givenName' => $givenName,
        'familyName' => $familyName,
        'photoUrl' => trim((string) ($user['avatar_url'] ?? '')),
        'profileUrl' => trim((string) ($user['html_url'] ?? '')),
        'email' => $primaryEmail,
    ];
}

function github_current_user(): ?array
{
    $user = $_SESSION[GITHUB_SESSION_USER_KEY] ?? null;
    return is_array($user) ? $user : null;
}

function github_clear_session(): void
{
    unset($_SESSION[GITHUB_SESSION_USER_KEY], $_SESSION[GITHUB_SESSION_TOKEN_KEY], $_SESSION[GITHUB_SESSION_STATE_KEY], $_SESSION[GITHUB_SESSION_RETURN_TO_KEY]);
}

function github_env_value(string $name): string
{
    $value = getenv($name);
    if ($value !== false && trim((string) $value) !== '') {
        return trim((string) $value);
    }

    if (isset($_ENV[$name]) && trim((string) $_ENV[$name]) !== '') {
        return trim((string) $_ENV[$name]);
    }

    if (isset($_SERVER[$name]) && trim((string) $_SERVER[$name]) !== '') {
        return trim((string) $_SERVER[$name]);
    }

    return '';
}

function github_base64url_encode(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function github_app_private_key(): string
{
    $inline = github_env_value('GITHUB_APP_PRIVATE_KEY');
    if ($inline !== '') {
        return str_replace(['\\n', '\n'], "\n", $inline);
    }

    $path = github_env_value('GITHUB_APP_PRIVATE_KEY_PATH');
    if ($path !== '' && is_readable($path)) {
        return trim((string) file_get_contents($path));
    }

    $defaultPath = __DIR__ . '/github-app-private-key.pem';
    if (is_readable($defaultPath)) {
        return trim((string) file_get_contents($defaultPath));
    }

    return '';
}

function github_create_app_jwt(string $appId, string $privateKey): string
{
    $now = time();
    $header = github_base64url_encode((string) json_encode([
        'alg' => 'RS256',
        'typ' => 'JWT',
    ], JSON_THROW_ON_ERROR));
    $payload = github_base64url_encode((string) json_encode([
        'iat' => $now - 60,
        'exp' => $now + 540,
        'iss' => $appId,
    ], JSON_THROW_ON_ERROR));
    $segments = $header . '.' . $payload;

    $signature = '';
    $signed = openssl_sign($segments, $signature, $privateKey, OPENSSL_ALGO_SHA256);
    if (!$signed) {
        throw new RuntimeException('Failed to sign GitHub App JWT.');
    }

    return $segments . '.' . github_base64url_encode($signature);
}

function github_fetch_installation_access_token(): string
{
    static $cached = ['token' => '', 'expires_at' => 0];

    if ($cached['token'] !== '' && $cached['expires_at'] > time() + 120) {
        return $cached['token'];
    }

    $appId = github_env_value('GITHUB_APP_ID');
    $privateKey = github_app_private_key();
    if ($appId === '' || $privateKey === '') {
        return '';
    }

    $appJwt = github_create_app_jwt($appId, $privateKey);
    $installationId = github_env_value('GITHUB_APP_INSTALLATION_ID');

    if ($installationId === '') {
        $repoConfig = github_repo_config();
        $installationUrl = sprintf(
            'https://api.github.com/repos/%s/%s/installation',
            rawurlencode($repoConfig['owner']),
            rawurlencode($repoConfig['repo'])
        );
        $installationResponse = github_rest_get($installationUrl, $appJwt);
        if ($installationResponse['status'] >= 400) {
            return '';
        }

        $installationId = trim((string) ($installationResponse['data']['id'] ?? ''));
        if ($installationId === '') {
            return '';
        }
    }

    $tokenUrl = sprintf(
        'https://api.github.com/app/installations/%s/access_tokens',
        rawurlencode($installationId)
    );
    $tokenResponse = github_rest_post_json($tokenUrl, [], $appJwt);
    $token = trim((string) ($tokenResponse['token'] ?? ''));
    if ($token === '') {
        return '';
    }

    $expiresAt = strtotime((string) ($tokenResponse['expires_at'] ?? ''));
    $cached = [
        'token' => $token,
        'expires_at' => $expiresAt > 0 ? $expiresAt : time() + 3600,
    ];

    return $token;
}

function github_api_token(): string
{
    static $resolved = null;
    if ($resolved !== null) {
        return $resolved;
    }

    foreach (['GITHUB_API_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as $name) {
        $token = github_env_value($name);
        if ($token !== '') {
            return $resolved = $token;
        }
    }

    $tokenFile = github_env_value('GITHUB_API_TOKEN_FILE');
    if ($tokenFile !== '' && is_readable($tokenFile)) {
        $token = trim((string) file_get_contents($tokenFile));
        if ($token !== '') {
            return $resolved = $token;
        }
    }

    $appToken = github_fetch_installation_access_token();
    if ($appToken !== '') {
        return $resolved = $appToken;
    }

    return $resolved = '';
}

function github_api_token_configured(): bool
{
    return github_api_token() !== '';
}

function github_require_api_token(): string
{
    $token = github_api_token();
    if ($token === '') {
        throw new RuntimeException(
            'Server GitHub API authentication is not configured. '
            . 'Set GITHUB_API_TOKEN in the API .env file (recommended), '
            . 'or configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY for GitHub App authentication.'
        );
    }

    return $token;
}

function github_api_auth_status(): array
{
    $hasPat = github_env_value('GITHUB_API_TOKEN') !== ''
        || github_env_value('GITHUB_TOKEN') !== ''
        || github_env_value('GH_TOKEN') !== '';
    $tokenFile = github_env_value('GITHUB_API_TOKEN_FILE');
    $hasTokenFile = $tokenFile !== '' && is_readable($tokenFile);
    $hasApp = github_env_value('GITHUB_APP_ID') !== '' && github_app_private_key() !== '';

    return [
        'configured' => github_api_token_configured(),
        'method' => github_api_token_configured()
            ? ($hasApp && !($hasPat || $hasTokenFile) ? 'github_app' : 'personal_access_token')
            : null,
        'personal_access_token' => $hasPat || $hasTokenFile,
        'github_app' => $hasApp,
    ];
}

function github_repo_config(): array
{
    $configured = trim((string) (getenv('GITHUB_REPO') ?: 'Genepedia/Genepedia'));
    $parts = array_values(array_filter(explode('/', $configured), static fn ($part) => $part !== ''));

    return [
        'owner' => (string) ($parts[0] ?? 'Genepedia'),
        'repo' => (string) ($parts[1] ?? 'Genepedia'),
    ];
}

function github_validate_repo_file_path(string $path): ?string
{
    $normalized = str_replace('\\', '/', trim($path));
    $normalized = ltrim($normalized, '/');

    if ($normalized === '' || str_contains($normalized, '..')) {
        return null;
    }

    if (!preg_match('#^(pages|people)/[a-zA-Z0-9_./-]+\.html$#', $normalized)) {
        return null;
    }

    return $normalized;
}

function github_rest_request(string $method, string $url, ?string $token = null, ?array $jsonBody = null): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('PHP cURL is required for GitHub API requests.');
    }

    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('Failed to initialize cURL.');
    }

    $headers = [
        'Accept: application/vnd.github+json',
        'User-Agent: Genepedia-GitHub-API',
        'X-GitHub-Api-Version: 2022-11-28',
    ];

    $token = trim((string) ($token ?? github_api_token()));
    if ($token !== '') {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    if ($jsonBody !== null) {
        $headers[] = 'Content-Type: application/json';
    }

    $responseHeaders = [];
    $options = [
        CURLOPT_CUSTOMREQUEST => strtoupper($method),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HEADERFUNCTION => static function ($curl, string $headerLine) use (&$responseHeaders): int {
            $length = strlen($headerLine);
            $parts = explode(':', $headerLine, 2);
            if (count($parts) === 2) {
                $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
            }

            return $length;
        },
    ];

    if ($jsonBody !== null) {
        $options[CURLOPT_POSTFIELDS] = (string) json_encode($jsonBody, JSON_THROW_ON_ERROR);
    }

    curl_setopt_array($ch, $options);

    $raw = curl_exec($ch);
    if ($raw === false) {
        $message = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('GitHub request failed: ' . $message);
    }

    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    $decoded = json_decode($raw, true);

    return [
        'status' => $status,
        'headers' => $responseHeaders,
        'data' => $decoded,
        'raw' => $raw,
    ];
}

function github_rest_get(string $url, ?string $token = null): array
{
    return github_rest_request('GET', $url, $token);
}

function github_rest_post_json(string $url, array $body = [], ?string $token = null): array
{
    $response = github_rest_request('POST', $url, $token, $body);
    $status = $response['status'];
    $data = $response['data'];

    if ($status >= 400) {
        $message = is_array($data)
            ? (string) ($data['message'] ?? 'GitHub API request failed.')
            : 'GitHub API request failed.';
        throw new RuntimeException($message);
    }

    if (!is_array($data)) {
        throw new RuntimeException('GitHub returned an invalid JSON response.');
    }

    return $data;
}

function github_rate_limit_message(array $response): string
{
    $data = $response['data'];
    $message = is_array($data)
        ? (string) ($data['message'] ?? 'GitHub API rate limit reached.')
        : 'GitHub API rate limit reached.';

    if (!github_api_token_configured()) {
        return $message . ' Configure GITHUB_API_TOKEN on the API server for authenticated requests.';
    }

    return $message;
}

function github_normalize_commit_item(array $item): array
{
    $message = trim((string) ($item['commit']['message'] ?? ''));
    $subject = $message !== '' ? strtok($message, "\n") : 'No commit message';
    if ($subject === false || $subject === '') {
        $subject = 'No commit message';
    }

    $authorLogin = (string) ($item['author']['login'] ?? $item['committer']['login'] ?? '');
    $authorUrl = trim((string) ($item['author']['html_url'] ?? $item['committer']['html_url'] ?? ''));
    if ($authorUrl === '' && $authorLogin !== '') {
        $authorUrl = 'https://github.com/' . rawurlencode($authorLogin);
    }

    return [
        'hash' => (string) ($item['sha'] ?? ''),
        'date' => (string) ($item['commit']['author']['date'] ?? $item['commit']['committer']['date'] ?? ''),
        'author' => (string) ($item['commit']['author']['name'] ?? 'Unknown author'),
        'author_login' => $authorLogin,
        'author_url' => $authorUrl,
        'subject' => $subject,
    ];
}

function github_ensure_file_api_authenticated(): void
{
    if (github_api_token_configured()) {
        return;
    }

    github_json([
        'ok' => false,
        'error' => 'api_token_not_configured',
        'message' => 'Server GitHub API authentication is not configured. '
            . 'Set GITHUB_API_TOKEN in the API server .env file, '
            . 'or configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.',
        'setup' => [
            'recommended' => 'GITHUB_API_TOKEN',
            'token_url' => 'https://github.com/settings/tokens',
            'required_scopes' => ['public_repo (classic PAT)', 'Contents: Read + Metadata: Read (fine-grained PAT)'],
        ],
    ], 503);
}

function github_fetch_all_file_commits(string $owner, string $repo, string $path, ?int $maxCommits = null): array
{
    github_require_api_token();

    $commits = [];
    $perPage = ($maxCommits !== null && $maxCommits > 0 && $maxCommits < 100)
        ? $maxCommits
        : 100;
    $page = 1;
    $maxPages = 100;

    while ($page <= $maxPages) {
        $url = sprintf(
            'https://api.github.com/repos/%s/%s/commits?path=%s&per_page=%d&page=%d',
            rawurlencode($owner),
            rawurlencode($repo),
            rawurlencode($path),
            $perPage,
            $page
        );

        $response = github_rest_get($url);
        $status = $response['status'];
        $batch = $response['data'];

        if ($status === 404) {
            return [];
        }

        if ($status === 403) {
            throw new RuntimeException(github_rate_limit_message($response));
        }

        if ($status >= 400) {
            $message = is_array($batch)
                ? (string) ($batch['message'] ?? 'GitHub API request failed.')
                : 'GitHub API request failed.';
            throw new RuntimeException($message);
        }

        if (!is_array($batch) || $batch === []) {
            break;
        }

        foreach ($batch as $item) {
            if (!is_array($item)) {
                continue;
            }

            $commits[] = github_normalize_commit_item($item);

            if ($maxCommits !== null && count($commits) >= $maxCommits) {
                return $commits;
            }
        }

        if (count($batch) < $perPage) {
            break;
        }

        if ($maxCommits !== null && count($commits) >= $maxCommits) {
            break;
        }

        $page++;
    }

    return $commits;
}

function github_validate_commit_hash(string $hash): ?string
{
    $normalized = strtolower(trim($hash));
    if (!preg_match('/^[a-f0-9]{40}$/', $normalized)) {
        return null;
    }

    return $normalized;
}

function github_decode_content_payload(?array $payload): ?string
{
    if (!is_array($payload) || !array_key_exists('content', $payload)) {
        return null;
    }

    $encoding = (string) ($payload['encoding'] ?? '');
    $content = (string) ($payload['content'] ?? '');

    if ($encoding === 'base64') {
        $decoded = base64_decode(str_replace("\n", '', $content), true);

        return $decoded === false ? null : $decoded;
    }

    return $content;
}

function github_fetch_file_contents_at_ref(string $owner, string $repo, string $path, string $ref): ?string
{
    $url = sprintf(
        'https://api.github.com/repos/%s/%s/contents/%s?ref=%s',
        rawurlencode($owner),
        rawurlencode($repo),
        rawurlencode($path),
        rawurlencode($ref)
    );

    $response = github_rest_get($url);
    $status = $response['status'];
    $payload = $response['data'];

    if ($status === 404) {
        return null;
    }

    if ($status >= 400) {
        $message = is_array($payload)
            ? (string) ($payload['message'] ?? 'GitHub API request failed.')
            : 'GitHub API request failed.';
        throw new RuntimeException($message);
    }

    return github_decode_content_payload(is_array($payload) ? $payload : null);
}

function github_fetch_file_commit_diff(string $owner, string $repo, string $path, string $hash): array
{
    github_require_api_token();

    $url = sprintf(
        'https://api.github.com/repos/%s/%s/commits/%s',
        rawurlencode($owner),
        rawurlencode($repo),
        rawurlencode($hash)
    );

    $response = github_rest_get($url);
    $status = $response['status'];
    $commit = $response['data'];

    if ($status === 404) {
        throw new RuntimeException('Commit not found.');
    }

    if ($status === 403) {
        throw new RuntimeException(github_rate_limit_message($response));
    }

    if ($status >= 400) {
        $message = is_array($commit)
            ? (string) ($commit['message'] ?? 'GitHub API request failed.')
            : 'GitHub API request failed.';
        throw new RuntimeException($message);
    }

    if (!is_array($commit)) {
        throw new RuntimeException('GitHub returned an invalid commit response.');
    }

    $fileChange = null;
    foreach ($commit['files'] ?? [] as $file) {
        if (!is_array($file)) {
            continue;
        }

        $filename = (string) ($file['filename'] ?? '');
        $previousFilename = (string) ($file['previous_filename'] ?? '');
        if ($filename === $path || $previousFilename === $path) {
            $fileChange = $file;
            break;
        }
    }

    if ($fileChange === null) {
        throw new RuntimeException('This commit does not include changes for the requested file.');
    }

    $statusLabel = (string) ($fileChange['status'] ?? 'modified');
    $beforePath = (string) ($fileChange['previous_filename'] ?? $path);
    $afterPath = (string) ($fileChange['filename'] ?? $path);
    $parentSha = (string) ($commit['parents'][0]['sha'] ?? '');

    $before = null;
    $after = null;

    if ($statusLabel !== 'added' && $parentSha !== '') {
        $before = github_fetch_file_contents_at_ref($owner, $repo, $beforePath, $parentSha);
    }

    if ($statusLabel !== 'removed') {
        $after = github_fetch_file_contents_at_ref($owner, $repo, $afterPath, $hash);
    }

    return [
        'path' => $path,
        'hash' => $hash,
        'status' => $statusLabel,
        'before_path' => $beforePath,
        'after_path' => $afterPath,
        'additions' => (int) ($fileChange['additions'] ?? 0),
        'deletions' => (int) ($fileChange['deletions'] ?? 0),
        'patch' => isset($fileChange['patch']) ? (string) $fileChange['patch'] : null,
        'before' => $before,
        'after' => $after,
    ];
}

