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

const GITHUB_OAUTH_SCOPE = 'read:user user:email public_repo';
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

function github_parse_repo_file_paths_request(): ?array
{
    if (isset($_GET['paths'])) {
        $raw = trim((string) $_GET['paths']);
        if ($raw === '') {
            return null;
        }

        $paths = [];
        foreach (preg_split('/\s*,\s*/', $raw) ?: [] as $part) {
            $validated = github_validate_repo_file_path((string) $part);
            if ($validated === null) {
                return null;
            }

            $paths[] = $validated;
        }

        return $paths !== [] ? array_values(array_unique($paths)) : null;
    }

    if (!isset($_GET['path'])) {
        return null;
    }

    $validated = github_validate_repo_file_path((string) $_GET['path']);
    return $validated !== null ? [$validated] : null;
}

function github_merge_commit_histories(array $listsByPath): array
{
    $merged = [];

    foreach ($listsByPath as $path => $commits) {
        if (!is_array($commits)) {
            continue;
        }

        foreach ($commits as $commit) {
            if (!is_array($commit)) {
                continue;
            }

            $hash = (string) ($commit['hash'] ?? '');
            if ($hash === '') {
                continue;
            }

            if (!isset($merged[$hash])) {
                $merged[$hash] = $commit;
                $merged[$hash]['paths'] = [$path];
                continue;
            }

            if (!in_array($path, $merged[$hash]['paths'], true)) {
                $merged[$hash]['paths'][] = $path;
            }
        }
    }

    $commits = array_values($merged);
    usort($commits, static function (array $a, array $b): int {
        return strcmp((string) ($b['date'] ?? ''), (string) ($a['date'] ?? ''));
    });

    foreach ($commits as &$commit) {
        $paths = is_array($commit['paths'] ?? null) ? $commit['paths'] : [];
        sort($paths);
        $commit['paths'] = array_values(array_unique($paths));
    }
    unset($commit);

    return $commits;
}

function github_fetch_merged_file_commits(string $owner, string $repo, array $paths, ?int $maxCommits = null): array
{
    github_require_api_token();

    $paths = array_values(array_unique($paths));
    if ($paths === []) {
        return [];
    }

    if (count($paths) === 1) {
        $commits = github_fetch_all_file_commits($owner, $repo, $paths[0], $maxCommits);
        foreach ($commits as &$commit) {
            $commit['paths'] = [$paths[0]];
        }
        unset($commit);

        return $commits;
    }

    $listsByPath = [];
    foreach ($paths as $path) {
        $listsByPath[$path] = github_fetch_all_file_commits($owner, $repo, $path, $maxCommits);
    }

    $merged = github_merge_commit_histories($listsByPath);
    if ($maxCommits !== null && count($merged) > $maxCommits) {
        $merged = array_slice($merged, 0, $maxCommits);
    }

    return $merged;
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

function github_fetch_commit_api_response(string $owner, string $repo, string $hash): array
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

    return $commit;
}

function github_find_file_change_in_commit(array $commit, string $path): ?array
{
    foreach ($commit['files'] ?? [] as $file) {
        if (!is_array($file)) {
            continue;
        }

        $filename = (string) ($file['filename'] ?? '');
        $previousFilename = (string) ($file['previous_filename'] ?? '');
        if ($filename === $path || $previousFilename === $path) {
            return $file;
        }
    }

    return null;
}

function github_build_file_diff_from_commit(
    array $commit,
    string $owner,
    string $repo,
    string $path,
    string $hash
): array {
    $fileChange = github_find_file_change_in_commit($commit, $path);
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

function github_fetch_file_commit_diff(string $owner, string $repo, string $path, string $hash): array
{
    $commit = github_fetch_commit_api_response($owner, $repo, $hash);

    return github_build_file_diff_from_commit($commit, $owner, $repo, $path, $hash);
}

function github_fetch_file_commit_diffs(string $owner, string $repo, array $paths, string $hash): array
{
    $paths = array_values(array_unique($paths));
    if ($paths === []) {
        throw new RuntimeException('At least one repository file path is required.');
    }

    if (count($paths) === 1) {
        return [github_fetch_file_commit_diff($owner, $repo, $paths[0], $hash)];
    }

    $commit = github_fetch_commit_api_response($owner, $repo, $hash);
    $diffs = [];

    foreach ($paths as $path) {
        try {
            $diffs[] = github_build_file_diff_from_commit($commit, $owner, $repo, $path, $hash);
        } catch (RuntimeException $error) {
            if (!str_contains($error->getMessage(), 'does not include changes')) {
                throw $error;
            }
        }
    }

    if ($diffs === []) {
        throw new RuntimeException('This commit does not include changes for any of the requested files.');
    }

    return $diffs;
}

function github_session_access_token(): string
{
    return trim((string) ($_SESSION[GITHUB_SESSION_TOKEN_KEY] ?? ''));
}

function github_require_authenticated_editor(): array
{
    $user = github_current_user();
    $token = github_session_access_token();

    if (!is_array($user) || $token === '') {
        throw new RuntimeException('GitHub login is required to publish page edits.');
    }

    return [
        'user' => $user,
        'token' => $token,
    ];
}

function github_editor_commit_identity(array $user): array
{
    $name = trim((string) ($user['displayName'] ?? $user['login'] ?? 'Genepedia Editor'));
    $email = trim((string) ($user['email'] ?? ''));
    if ($email === '') {
        $login = trim((string) ($user['login'] ?? 'user'));
        $id = trim((string) ($user['id'] ?? ''));
        $email = $id !== ''
            ? $id . '+' . $login . '@users.noreply.github.com'
            : $login . '@users.noreply.github.com';
    }

    return [
        'name' => $name !== '' ? $name : 'Genepedia Editor',
        'email' => $email,
    ];
}

function github_resolve_page_edit_api_token(array $editor): string
{
    $serverToken = github_api_token();
    if ($serverToken !== '') {
        return $serverToken;
    }

    $userToken = trim((string) ($editor['token'] ?? ''));
    if ($userToken !== '') {
        return $userToken;
    }

    throw new RuntimeException(
        'Page publishing is not configured. Set GITHUB_API_TOKEN with repository write access on the API server.'
    );
}

function github_token_repo_permissions(string $owner, string $repo, string $token): array
{
    $repository = github_rest_request_json(
        'GET',
        sprintf('https://api.github.com/repos/%s/%s', rawurlencode($owner), rawurlencode($repo)),
        $token,
        null,
        'Repository lookup',
    );

    return is_array($repository['permissions'] ?? null) ? $repository['permissions'] : [];
}

function github_publish_auth_status(): array
{
    $token = github_api_token();
    if ($token === '') {
        return [
            'configured' => false,
            'can_publish' => false,
            'message' => 'Set GITHUB_API_TOKEN with Contents and Pull requests write access.',
        ];
    }

    $repoConfig = github_repo_config();
    try {
        $permissions = github_token_repo_permissions($repoConfig['owner'], $repoConfig['repo'], $token);
    } catch (Throwable $error) {
        return [
            'configured' => true,
            'can_publish' => false,
            'message' => $error->getMessage(),
        ];
    }

    $canPublish = !empty($permissions['push']) || !empty($permissions['admin']) || !empty($permissions['maintain']);

    return [
        'configured' => true,
        'can_publish' => $canPublish,
        'permissions' => $permissions,
        'message' => $canPublish
            ? 'Server API token can create branches, commits, and pull requests.'
            : 'GITHUB_API_TOKEN can read the repository but needs write access to publish page edits.',
    ];
}

function github_encode_repo_path(string $path): string
{
    $parts = array_values(array_filter(
        explode('/', str_replace('\\', '/', $path)),
        static fn (string $part): bool => $part !== '',
    ));

    return implode('/', array_map('rawurlencode', $parts));
}

function github_sanitize_branch_segment(string $value): string
{
    $normalized = strtolower((string) preg_replace('/[^a-z0-9]+/', '-', $value));
    $normalized = trim((string) $normalized, '-');

    return $normalized !== '' ? $normalized : 'editor';
}

function github_format_rest_error(array $response, string $operation = 'GitHub API request'): string
{
    $status = (int) ($response['status'] ?? 0);
    $data = $response['data'];
    $message = is_array($data)
        ? (string) ($data['message'] ?? 'GitHub API request failed.')
        : 'GitHub API request failed.';

    $detail = $operation . ' failed: ' . $message;

    if ($status === 404) {
        $detail .= ' Check GITHUB_REPO and that the API token can access the repository.';
    } elseif ($status === 403) {
        $detail .= ' The API token may be missing repository write permissions.';
    }

    if ($status > 0) {
        $detail .= ' (HTTP ' . $status . ')';
    }

    return $detail;
}

function github_rest_request_json(string $method, string $url, ?string $token, ?array $body = null, string $operation = 'GitHub API request'): array
{
    $response = github_rest_request($method, $url, $token, $body);
    $status = $response['status'];
    $data = $response['data'];

    if ($status >= 400) {
        throw new RuntimeException(github_format_rest_error($response, $operation));
    }

    if (!is_array($data)) {
        throw new RuntimeException('GitHub returned an invalid JSON response.');
    }

    return $data;
}

function github_get_repository_default_branch(string $owner, string $repo, string $token): array
{
    $repository = github_rest_request_json(
        'GET',
        sprintf('https://api.github.com/repos/%s/%s', rawurlencode($owner), rawurlencode($repo)),
        $token,
        null,
        'Repository lookup',
    );

    $defaultBranch = trim((string) ($repository['default_branch'] ?? 'main'));
    if ($defaultBranch === '') {
        $defaultBranch = 'main';
    }

    $reference = github_rest_request_json(
        'GET',
        sprintf(
            'https://api.github.com/repos/%s/%s/git/ref/heads/%s',
            rawurlencode($owner),
            rawurlencode($repo),
            rawurlencode($defaultBranch),
        ),
        $token,
        null,
        'Default branch lookup',
    );

    $sha = trim((string) ($reference['object']['sha'] ?? ''));
    if ($sha === '') {
        throw new RuntimeException('Could not resolve the repository default branch.');
    }

    return [
        'branch' => $defaultBranch,
        'sha' => $sha,
    ];
}

function github_get_file_metadata_on_branch(
    string $owner,
    string $repo,
    string $path,
    string $branch,
    string $token,
): ?array {
    $url = sprintf(
        'https://api.github.com/repos/%s/%s/contents/%s?ref=%s',
        rawurlencode($owner),
        rawurlencode($repo),
        github_encode_repo_path($path),
        rawurlencode($branch),
    );

    $response = github_rest_request('GET', $url, $token);
    if ($response['status'] === 404) {
        return null;
    }

    if ($response['status'] >= 400) {
        $data = $response['data'];
        $message = is_array($data)
            ? (string) ($data['message'] ?? 'GitHub API request failed.')
            : 'GitHub API request failed.';
        throw new RuntimeException($message);
    }

    return is_array($response['data']) ? $response['data'] : null;
}

function github_create_branch_from_sha(
    string $owner,
    string $repo,
    string $branchName,
    string $sha,
    string $token,
): void {
    github_rest_request_json(
        'POST',
        sprintf('https://api.github.com/repos/%s/%s/git/refs', rawurlencode($owner), rawurlencode($repo)),
        $token,
        [
            'ref' => 'refs/heads/' . $branchName,
            'sha' => $sha,
        ],
        'Create branch',
    );
}

function github_upsert_file_on_branch(
    string $owner,
    string $repo,
    string $path,
    string $branchName,
    string $content,
    string $commitMessage,
    ?string $existingSha,
    string $token,
    ?array $commitIdentity = null,
): array {
    $payload = [
        'message' => $commitMessage,
        'content' => base64_encode($content),
        'branch' => $branchName,
    ];

    if ($existingSha !== null && $existingSha !== '') {
        $payload['sha'] = $existingSha;
    }

    if (is_array($commitIdentity)) {
        $payload['author'] = $commitIdentity;
        $payload['committer'] = $commitIdentity;
    }

    return github_rest_request_json(
        'PUT',
        sprintf(
            'https://api.github.com/repos/%s/%s/contents/%s',
            rawurlencode($owner),
            rawurlencode($repo),
            github_encode_repo_path($path),
        ),
        $token,
        $payload,
        'Update file',
    );
}

function github_create_pull_request(
    string $owner,
    string $repo,
    string $title,
    string $headBranch,
    string $baseBranch,
    string $body,
    string $token,
): array {
    return github_rest_request_json(
        'POST',
        sprintf('https://api.github.com/repos/%s/%s/pulls', rawurlencode($owner), rawurlencode($repo)),
        $token,
        [
            'title' => $title,
            'head' => $headBranch,
            'base' => $baseBranch,
            'body' => $body,
            'maintainer_can_modify' => true,
        ],
        'Create pull request',
    );
}

function github_create_page_edit_pull_request(
    string $owner,
    string $repo,
    string $path,
    string $content,
    array $editor,
    string $commitMessage,
    string $prTitle,
    string $prBody,
): array {
    $token = github_resolve_page_edit_api_token($editor);
    $user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
    $login = github_sanitize_branch_segment((string) ($user['login'] ?? 'editor'));
    $commitIdentity = github_editor_commit_identity($user);

    if (strlen($content) > 2_000_000) {
        throw new RuntimeException('The edited page is too large to publish.');
    }

    $publishStatus = github_publish_auth_status();
    if (($publishStatus['configured'] ?? false) && !($publishStatus['can_publish'] ?? false)) {
        throw new RuntimeException((string) ($publishStatus['message'] ?? 'GITHUB_API_TOKEN cannot publish page edits.'));
    }

    $base = github_get_repository_default_branch($owner, $repo, $token);
    $baseBranch = $base['branch'];
    $baseSha = $base['sha'];

    $fileSlug = github_sanitize_branch_segment((string) pathinfo($path, PATHINFO_FILENAME));
    $branchName = sprintf('edit/%s-%s-%s', $fileSlug, $login, gmdate('Ymd-His'));

    github_create_branch_from_sha($owner, $repo, $branchName, $baseSha, $token);

    $existingFile = github_get_file_metadata_on_branch($owner, $repo, $path, $branchName, $token);
    if ($existingFile === null) {
        $existingFile = github_get_file_metadata_on_branch($owner, $repo, $path, $baseBranch, $token);
    }
    $existingSha = is_array($existingFile) ? (string) ($existingFile['sha'] ?? '') : null;
    if ($existingSha === '') {
        $existingSha = null;
    }

    $commit = github_upsert_file_on_branch(
        $owner,
        $repo,
        $path,
        $branchName,
        $content,
        $commitMessage,
        $existingSha,
        $token,
        $commitIdentity,
    );

    $pullRequest = github_create_pull_request(
        $owner,
        $repo,
        $prTitle,
        $branchName,
        $baseBranch,
        $prBody,
        $token,
    );

    return [
        'branch' => $branchName,
        'base_branch' => $baseBranch,
        'commit' => [
            'sha' => (string) ($commit['commit']['sha'] ?? ''),
            'message' => $commitMessage,
        ],
        'pull_request' => [
            'number' => (int) ($pullRequest['number'] ?? 0),
            'title' => (string) ($pullRequest['title'] ?? $prTitle),
            'url' => (string) ($pullRequest['html_url'] ?? ''),
            'state' => (string) ($pullRequest['state'] ?? 'open'),
        ],
    ];
}

