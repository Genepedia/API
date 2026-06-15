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

const GITHUB_OAUTH_SCOPE = 'read:user user:email public_repo user:follow';
const GITHUB_SESSION_USER_KEY = 'github_user';
const GITHUB_SESSION_TOKEN_KEY = 'github_access_token';
const GITHUB_SESSION_STATE_KEY = 'github_oauth_state';
const GITHUB_SESSION_RETURN_TO_KEY = 'github_oauth_return_to';
const GITHUB_HANDOFF_TTL_SECONDS = 180;

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

function github_env_is_placeholder(string $value): bool
{
    $value = trim($value);
    if ($value === '' || $value === 'FILL_IN') {
        return true;
    }

    return str_starts_with($value, 'your_');
}

function github_oauth_uses_github_app(): bool
{
    if (github_app_configured()) {
        return true;
    }

    $clientId = github_env_value('GITHUB_CLIENT_ID');

    return str_starts_with($clientId, 'Iv1.');
}

function github_config(): array
{
    $clientId = github_env_value('GITHUB_CLIENT_ID');
    $clientSecret = github_env_value('GITHUB_CLIENT_SECRET');

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
        header('Access-Control-Allow-Headers: Accept, Content-Type, Authorization');
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

    $params = [
        'client_id' => $config['client_id'],
        'redirect_uri' => github_callback_url(),
        'state' => $state,
        'prompt' => 'select_account',
    ];
    if ($config['scope'] !== '') {
        $params['scope'] = $config['scope'];
    }

    return 'https://github.com/login/oauth/authorize?' . http_build_query($params);
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

function github_env_csv_list(string $name, array $defaults): array
{
    $raw = trim(github_env_value($name));
    if ($raw === '') {
        return $defaults;
    }

    $items = [];
    foreach (preg_split('/\s*,\s*/', $raw) ?: [] as $entry) {
        $value = trim((string) $entry);
        if ($value !== '') {
            $items[] = $value;
        }
    }

    return $items !== [] ? array_values(array_unique($items)) : $defaults;
}

function github_welcome_actions_enabled(): bool
{
    $flag = strtolower(trim(github_env_value('GITHUB_WELCOME_ACTIONS')));
    return !in_array($flag, ['0', 'false', 'no', 'off'], true);
}

function github_welcome_star_repos(): array
{
    return github_env_csv_list('GITHUB_WELCOME_STAR_REPOS', []);
}

function github_welcome_follow_users(): array
{
    return github_env_csv_list('GITHUB_WELCOME_FOLLOW_USERS', []);
}

function github_star_repository(string $owner, string $repo, string $token): void
{
    $response = github_rest_request(
        'PUT',
        sprintf(
            'https://api.github.com/user/starred/%s/%s',
            rawurlencode($owner),
            rawurlencode($repo),
        ),
        $token,
    );

    $status = (int) ($response['status'] ?? 0);
    if ($status === 204 || $status === 304) {
        return;
    }

    throw new RuntimeException(github_format_rest_error($response, 'Star repository'));
}

function github_lookup_github_login(string $login): array
{
    $response = github_rest_get(sprintf(
        'https://api.github.com/users/%s',
        rawurlencode($login),
    ));

    if ($response['status'] >= 400 || !is_array($response['data'])) {
        throw new RuntimeException(github_format_rest_error($response, 'GitHub account lookup'));
    }

    return $response['data'];
}

function github_graphql_request(string $query, string $token, array $variables = []): array
{
    $body = ['query' => $query];
    if ($variables !== []) {
        $body['variables'] = $variables;
    }

    $response = github_rest_request('POST', 'https://api.github.com/graphql', $token, $body);
    $status = (int) ($response['status'] ?? 0);
    $data = $response['data'];

    if ($status >= 400) {
        throw new RuntimeException(github_format_rest_error($response, 'GitHub GraphQL request'));
    }

    if (!is_array($data)) {
        throw new RuntimeException('GitHub returned an invalid GraphQL response.');
    }

    if (isset($data['errors']) && is_array($data['errors']) && $data['errors'] !== []) {
        $messages = [];
        foreach ($data['errors'] as $error) {
            if (!is_array($error)) {
                continue;
            }

            $message = trim((string) ($error['message'] ?? ''));
            if ($message !== '') {
                $messages[] = $message;
            }
        }

        throw new RuntimeException($messages !== []
            ? implode(' ', array_values(array_unique($messages)))
            : 'GitHub GraphQL request failed.');
    }

    return $data;
}

function github_is_following_via_rest(string $login, string $token): bool
{
    $response = github_rest_request(
        'GET',
        sprintf('https://api.github.com/user/following/%s', rawurlencode($login)),
        $token,
    );

    $status = (int) ($response['status'] ?? 0);
    if ($status === 204 || $status === 304) {
        return true;
    }

    if ($status === 404) {
        return false;
    }

    throw new RuntimeException(github_format_rest_error($response, 'Check follow status'));
}

function github_graphql_organization_follow_state(string $login, string $token): array
{
    $payload = github_graphql_request(
        <<<'GRAPHQL'
        query OrganizationFollowState($login: String!) {
          organization(login: $login) {
            id
            login
            viewerIsFollowing
          }
        }
        GRAPHQL,
        $token,
        ['login' => $login],
    );

    $organization = $payload['data']['organization'] ?? null;
    if (!is_array($organization)) {
        throw new RuntimeException('Could not resolve organization ' . $login . ' for follow.');
    }

    return $organization;
}

function github_follow_organization_via_graphql(string $login, string $organizationId, string $token): void
{
    $payload = github_graphql_request(
        <<<'GRAPHQL'
        mutation FollowOrganization($organizationId: ID!) {
          followOrganization(input: { organizationId: $organizationId }) {
            organization {
              login
              viewerIsFollowing
            }
          }
        }
        GRAPHQL,
        $token,
        ['organizationId' => $organizationId],
    );

    if (($payload['data']['followOrganization'] ?? null) === null) {
        throw new RuntimeException('GitHub followOrganization returned no result for ' . $login . '.');
    }

    $organization = $payload['data']['followOrganization']['organization'] ?? null;
    if (is_array($organization) && !empty($organization['viewerIsFollowing'])) {
        return;
    }

    $verified = github_graphql_organization_follow_state($login, $token);
    if (!empty($verified['viewerIsFollowing'])) {
        return;
    }

    throw new RuntimeException('GitHub did not confirm the organization follow for ' . $login . '.');
}

function github_follow_organization(string $login, string $token): void
{
    $state = github_graphql_organization_follow_state($login, $token);
    if (!empty($state['viewerIsFollowing'])) {
        return;
    }

    try {
        if (github_is_following_via_rest($login, $token)) {
            return;
        }
    } catch (Throwable) {
        // REST follow checks are unavailable for some organization accounts.
    }

    try {
        github_follow_user($login, $token);
        if (github_is_following_via_rest($login, $token)) {
            return;
        }
    } catch (Throwable) {
        // REST follow is not supported for all organization logins.
    }

    $organizationId = trim((string) ($state['id'] ?? ''));
    if ($organizationId === '') {
        throw new RuntimeException('Could not resolve an organization ID for ' . $login . '.');
    }

    github_follow_organization_via_graphql($login, $organizationId, $token);
}

function github_follow_user(string $login, string $token): void
{
    if (github_is_following_via_rest($login, $token)) {
        return;
    }

    $response = github_rest_request(
        'PUT',
        sprintf('https://api.github.com/user/following/%s', rawurlencode($login)),
        $token,
    );

    $status = (int) ($response['status'] ?? 0);
    if ($status === 204 || $status === 304) {
        return;
    }

    throw new RuntimeException(github_format_rest_error($response, 'Follow user'));
}

function github_follow_account(string $login, string $token): void
{
    $account = github_lookup_github_login($login);
    $type = trim((string) ($account['type'] ?? ''));

    if (strcasecmp($type, 'Organization') === 0) {
        github_follow_organization($login, $token);
        return;
    }

    github_follow_user($login, $token);
}

function github_apply_welcome_login_actions(string $token): void
{
    if (!github_welcome_actions_enabled()) {
        return;
    }

    foreach (github_welcome_star_repos() as $repoSlug) {
        $parts = array_values(array_filter(explode('/', trim($repoSlug), 2), static fn ($part) => $part !== ''));
        if (count($parts) !== 2) {
            continue;
        }

        try {
            github_star_repository($parts[0], $parts[1], $token);
        } catch (Throwable $error) {
            error_log(sprintf(
                'GitHub welcome star failed for %s: %s',
                $repoSlug,
                $error->getMessage(),
            ));
        }
    }

    foreach (github_welcome_follow_users() as $login) {
        $normalizedLogin = trim($login);
        if ($normalizedLogin === '') {
            continue;
        }

        try {
            github_follow_account($normalizedLogin, $token);
        } catch (Throwable $error) {
            error_log(sprintf(
                'GitHub welcome follow failed for %s: %s',
                $normalizedLogin,
                $error->getMessage(),
            ));
        }
    }
}

function github_fetch_user(string $token): array
{
    $headers = [
        'Authorization' => 'Bearer ' . $token,
        'X-GitHub-Api-Version' => '2022-11-28',
    ];

    $user = github_request_json('GET', 'https://api.github.com/user', $headers);

    $primaryEmail = trim((string) ($user['email'] ?? ''));
    try {
        $emails = github_request_json('GET', 'https://api.github.com/user/emails', $headers);
        foreach ($emails as $email) {
            if (!is_array($email)) {
                continue;
            }

            if (!empty($email['primary']) && !empty($email['verified']) && !empty($email['email'])) {
                $primaryEmail = (string) $email['email'];
                break;
            }
        }
    } catch (Throwable) {
        // GitHub Apps need Account → Email addresses permission; login still works without it.
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

function github_request_bearer_token(): string
{
    $header = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    if ($header === '' && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $header = (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }

    if (preg_match('/^\s*Bearer\s+(\S+)/i', $header, $matches) === 1) {
        return trim($matches[1]);
    }

    return '';
}

function github_handoff_cache_dir(): string
{
    return rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'genepedia-github-handoff';
}

function github_cleanup_handoff_cache(): void
{
    $dir = github_handoff_cache_dir();
    if (!is_dir($dir)) {
        return;
    }

    $cutoff = time() - GITHUB_HANDOFF_TTL_SECONDS;
    foreach (glob($dir . DIRECTORY_SEPARATOR . '*.json') ?: [] as $path) {
        if (!is_file($path)) {
            continue;
        }

        if ((int) @filemtime($path) < $cutoff) {
            @unlink($path);
        }
    }
}

function github_create_login_handoff(array $user, string $token): string
{
    github_cleanup_handoff_cache();

    $code = bin2hex(random_bytes(32));
    $dir = github_handoff_cache_dir();
    if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException('Could not create the login handoff cache directory.');
    }

    $payload = [
        'user' => $user,
        'token' => $token,
        'expires_at' => time() + GITHUB_HANDOFF_TTL_SECONDS,
    ];

    $path = $dir . DIRECTORY_SEPARATOR . hash('sha256', $code) . '.json';
    if (file_put_contents($path, (string) json_encode($payload, JSON_UNESCAPED_SLASHES), LOCK_EX) === false) {
        throw new RuntimeException('Could not persist the login handoff code.');
    }

    return $code;
}

function github_consume_login_handoff(string $code): ?array
{
    $normalized = trim($code);
    if ($normalized === '' || !preg_match('/^[a-f0-9]{64}$/', $normalized)) {
        return null;
    }

    $path = github_handoff_cache_dir() . DIRECTORY_SEPARATOR . hash('sha256', $normalized) . '.json';
    if (!is_readable($path)) {
        return null;
    }

    $payload = json_decode((string) file_get_contents($path), true);
    @unlink($path);

    if (!is_array($payload)) {
        return null;
    }

    $expiresAt = (int) ($payload['expires_at'] ?? 0);
    $user = $payload['user'] ?? null;
    $token = trim((string) ($payload['token'] ?? ''));
    if ($expiresAt < time() || !is_array($user) || $token === '') {
        return null;
    }

    return [
        'user' => $user,
        'token' => $token,
    ];
}

function github_current_user(): ?array
{
    $sessionUser = $_SESSION[GITHUB_SESSION_USER_KEY] ?? null;
    $sessionToken = trim((string) ($_SESSION[GITHUB_SESSION_TOKEN_KEY] ?? ''));
    if (is_array($sessionUser) && $sessionToken !== '') {
        return $sessionUser;
    }

    $bearer = github_request_bearer_token();
    if ($bearer === '') {
        return is_array($sessionUser) ? $sessionUser : null;
    }

    static $bearerUsers = [];
    if (isset($bearerUsers[$bearer])) {
        return $bearerUsers[$bearer];
    }

    try {
        $user = github_fetch_user($bearer);
        $bearerUsers[$bearer] = $user;

        return $user;
    } catch (Throwable) {
        return null;
    }
}

function github_clear_session(): void
{
    unset($_SESSION[GITHUB_SESSION_USER_KEY], $_SESSION[GITHUB_SESSION_TOKEN_KEY], $_SESSION[GITHUB_SESSION_STATE_KEY], $_SESSION[GITHUB_SESSION_RETURN_TO_KEY]);
}

function github_env_value(string $name): string
{
    $value = getenv($name);
    if ($value !== false) {
        $value = trim((string) $value);
        if (!github_env_is_placeholder($value)) {
            return $value;
        }
    }

    if (isset($_ENV[$name])) {
        $value = trim((string) $_ENV[$name]);
        if (!github_env_is_placeholder($value)) {
            return $value;
        }
    }

    if (isset($_SERVER[$name])) {
        $value = trim((string) $_SERVER[$name]);
        if (!github_env_is_placeholder($value)) {
            return $value;
        }
    }

    return '';
}

function github_base64url_encode(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function github_resolve_api_path(string $path): string
{
    $path = trim($path);
    if ($path === '') {
        return '';
    }

    if ($path[0] === '/' || preg_match('#^[A-Za-z]:[/\\\\]#', $path) === 1) {
        return $path;
    }

    return rtrim(__DIR__, '/') . '/' . ltrim($path, './');
}

function github_app_private_key_paths(): array
{
    $paths = [];
    $configured = github_env_value('GITHUB_APP_PRIVATE_KEY_PATH');
    if ($configured !== '') {
        $paths[] = github_resolve_api_path($configured);
    }

    $paths[] = __DIR__ . '/github-app-private-key.pem';

    return array_values(array_unique($paths));
}

function github_app_private_key(): string
{
    $inline = github_env_value('GITHUB_APP_PRIVATE_KEY');
    if ($inline !== '') {
        return str_replace(['\\n', '\n'], "\n", $inline);
    }

    foreach (github_app_private_key_paths() as $path) {
        if (is_readable($path)) {
            return trim((string) file_get_contents($path));
        }
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

function github_app_configured(): bool
{
    return github_env_value('GITHUB_APP_ID') !== '' && github_app_private_key() !== '';
}

function github_app_setup_status(): array
{
    $appId = github_env_value('GITHUB_APP_ID');
    $pathConfig = github_env_value('GITHUB_APP_PRIVATE_KEY_PATH');
    $resolvedPaths = github_app_private_key_paths();
    $readablePath = null;

    foreach ($resolvedPaths as $path) {
        if (is_readable($path)) {
            $readablePath = $path;
            break;
        }
    }

    $status = [
        'app_id_set' => $appId !== '',
        'app_id_looks_like_client_id' => str_starts_with($appId, 'Iv1.'),
        'private_key_path' => $pathConfig !== '' ? $pathConfig : null,
        'private_key_resolved_paths' => $resolvedPaths,
        'private_key_readable' => $readablePath !== null,
        'private_key_in_use' => $readablePath,
        'configured' => github_app_configured(),
        'installation_token_error' => null,
    ];

    if ($status['app_id_looks_like_client_id']) {
        $status['installation_token_error'] =
            'GITHUB_APP_ID looks like a Client ID (Iv1.). Use the numeric App ID instead.';
    } elseif ($status['configured']) {
        try {
            $token = github_fetch_installation_access_token(true);
            if ($token === '') {
                $status['installation_token_error'] = 'GitHub App did not return an installation access token.';
            }
        } catch (Throwable $error) {
            $status['installation_token_error'] = $error->getMessage();
        }
    } elseif (!$status['app_id_set']) {
        $status['installation_token_error'] = 'GITHUB_APP_ID is missing from the server .env file.';
    } elseif (!$status['private_key_readable']) {
        $status['installation_token_error'] =
            'Private key file is not readable. Upload github-app-private-key.pem next to the PHP files on the server.';
    }

    return $status;
}

function github_fetch_installation_access_token(bool $throwOnFailure = false): string
{
    static $cached = ['token' => '', 'expires_at' => 0];

    if ($cached['token'] !== '' && $cached['expires_at'] > time() + 120) {
        return $cached['token'];
    }

    $appId = github_env_value('GITHUB_APP_ID');
    $privateKey = github_app_private_key();
    if ($appId === '' || $privateKey === '') {
        if ($throwOnFailure) {
            throw new RuntimeException(
                'GitHub App authentication is not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH.'
            );
        }

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
            $message = github_format_rest_error($installationResponse, 'GitHub App installation lookup');
            if ($throwOnFailure) {
                throw new RuntimeException(
                    $message . ' Install the GitHub App on ' . $repoConfig['owner'] . '/' . $repoConfig['repo'] . '.'
                );
            }

            return '';
        }

        $installationId = trim((string) ($installationResponse['data']['id'] ?? ''));
        if ($installationId === '') {
            if ($throwOnFailure) {
                throw new RuntimeException('Could not resolve the GitHub App installation ID for this repository.');
            }

            return '';
        }
    }

    $tokenUrl = sprintf(
        'https://api.github.com/app/installations/%s/access_tokens',
        rawurlencode($installationId)
    );

    try {
        $tokenResponse = github_rest_post_json($tokenUrl, [], $appJwt);
    } catch (RuntimeException $error) {
        if ($throwOnFailure) {
            throw $error;
        }

        return '';
    }

    $token = trim((string) ($tokenResponse['token'] ?? ''));
    if ($token === '') {
        if ($throwOnFailure) {
            throw new RuntimeException('GitHub App did not return an installation access token.');
        }

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

    if (github_app_configured()) {
        $appToken = github_fetch_installation_access_token();
        if ($appToken !== '') {
            return $resolved = $appToken;
        }
    }

    foreach (['GITHUB_API_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as $name) {
        $token = github_env_value($name);
        if ($token !== '' && !str_starts_with($token, 'your_')) {
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
    $hasApp = github_app_configured();
    $configured = github_api_token_configured();
    $method = null;

    if ($configured) {
        if ($hasApp) {
            try {
                $appToken = github_fetch_installation_access_token(true);
                $method = $appToken !== '' ? 'github_app' : null;
            } catch (Throwable $error) {
                $method = 'github_app_error';
            }
        }

        if ($method === null && ($hasPat || $hasTokenFile)) {
            $method = 'personal_access_token';
        }
    }

    return [
        'configured' => $configured,
        'method' => $method,
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

function github_media_repo_config(): array
{
    $siteRepo = github_repo_config();
    $configured = trim((string) (getenv('GITHUB_MEDIA_REPO') ?: ''));
    if ($configured === '') {
        return [
            'owner' => $siteRepo['owner'],
            'repo' => 'Genepedia-Media',
        ];
    }

    $parts = array_values(array_filter(explode('/', $configured), static fn ($part) => $part !== ''));
    if (count($parts) === 1) {
        return [
            'owner' => $siteRepo['owner'],
            'repo' => (string) $parts[0],
        ];
    }

    return [
        'owner' => (string) ($parts[0] ?? $siteRepo['owner']),
        'repo' => (string) ($parts[1] ?? 'Genepedia-Media'),
    ];
}

function github_people_db_repo_config(): array
{
    $siteRepo = github_repo_config();
    $configured = trim((string) (getenv('GITHUB_PEOPLE_DB_REPO') ?: ''));
    if ($configured === '') {
        return [
            'owner' => $siteRepo['owner'],
            'repo' => 'Genepedia-Database',
        ];
    }

    $parts = array_values(array_filter(explode('/', $configured), static fn ($part) => $part !== ''));
    if (count($parts) === 1) {
        return [
            'owner' => $siteRepo['owner'],
            'repo' => (string) $parts[0],
        ];
    }

    return [
        'owner' => (string) ($parts[0] ?? $siteRepo['owner']),
        'repo' => (string) ($parts[1] ?? 'Genepedia-Database'),
    ];
}

function github_people_db_workspace_root(): string
{
    return github_people_db_submodule_path() . '/people';
}

function github_people_db_submodule_path(): string
{
    return 'data/Genepedia-Database';
}

function github_people_db_legacy_workspace_root(): string
{
    return 'data/people/v1';
}

function github_people_db_workspace_path(string $path = ''): string
{
    $clean = ltrim(str_replace('\\', '/', trim($path)), '/');
    if ($clean === '') {
        return github_people_db_workspace_root();
    }

    return github_people_db_workspace_root() . '/' . $clean;
}

function github_normalize_people_db_workspace_path(string $path): string
{
    $normalized = ltrim(str_replace('\\', '/', trim($path)), '/');
    $workspaceRoot = github_people_db_workspace_root();
    $submoduleRoot = github_people_db_submodule_path();

    if ($normalized === ''
        || $normalized === $workspaceRoot
        || $normalized === $submoduleRoot
        || $normalized === github_people_db_legacy_workspace_root()) {
        return github_people_db_workspace_root();
    }

    if (str_starts_with($normalized, $workspaceRoot . '/')) {
        return $normalized;
    }

    if (str_starts_with($normalized, $submoduleRoot . '/')) {
        return $workspaceRoot . '/' . substr($normalized, strlen($submoduleRoot) + 1);
    }

    if (str_starts_with($normalized, github_people_db_legacy_workspace_root() . '/')) {
        return $workspaceRoot . substr($normalized, strlen(github_people_db_legacy_workspace_root()));
    }

    if (preg_match('#^(manifest\.json|(persons|unions|ownership|graph|index|sources|export|reports)/)#', $normalized) === 1) {
        return github_people_db_workspace_path($normalized);
    }

    return $normalized;
}

function github_is_people_db_workspace_path(string $path): bool
{
    $normalized = github_normalize_people_db_workspace_path($path);
    return $normalized === github_people_db_workspace_root()
        || str_starts_with($normalized, github_people_db_workspace_root() . '/');
}

function github_people_db_repo_path(string $path): string
{
    $normalized = github_normalize_people_db_workspace_path($path);
    $submoduleRoot = github_people_db_submodule_path();
    $root = github_people_db_workspace_root();
    if ($normalized === $root) {
        return 'people';
    }

    if (str_starts_with($normalized, $submoduleRoot . '/')) {
        return substr($normalized, strlen($submoduleRoot) + 1);
    }

    return ltrim($normalized, '/');
}

function github_repository_context_for_workspace_path(string $path): array
{
    $normalized = ltrim(str_replace('\\', '/', trim($path)), '/');
    if (github_is_people_db_workspace_path($normalized)) {
        $repoConfig = github_people_db_repo_config();
        $workspacePath = github_normalize_people_db_workspace_path($normalized);
        return [
            'kind' => 'people_db',
            'owner' => $repoConfig['owner'],
            'repo' => $repoConfig['repo'],
            'repo_slug' => $repoConfig['owner'] . '/' . $repoConfig['repo'],
            'workspace_path' => $workspacePath,
            'repo_path' => github_people_db_repo_path($workspacePath),
        ];
    }

    $repoConfig = github_repo_config();
    return [
        'kind' => 'site',
        'owner' => $repoConfig['owner'],
        'repo' => $repoConfig['repo'],
        'repo_slug' => $repoConfig['owner'] . '/' . $repoConfig['repo'],
        'workspace_path' => $normalized,
        'repo_path' => $normalized,
    ];
}

function github_repository_context_for_paths(array $paths): ?array
{
    $context = null;
    $repoPaths = [];
    $workspacePaths = [];

    foreach ($paths as $path) {
        $pathContext = github_repository_context_for_workspace_path((string) $path);
        if ($context === null) {
            $context = $pathContext;
        } elseif ($context['repo_slug'] !== $pathContext['repo_slug']) {
            return null;
        }

        $repoPaths[] = $pathContext['repo_path'];
        $workspacePaths[] = $pathContext['workspace_path'];
    }

    if ($context === null) {
        return null;
    }

    $context['repo_paths'] = $repoPaths;
    $context['workspace_paths'] = $workspacePaths;
    return $context;
}

function github_person_media_directory(string $personId): string
{
    return 'people/' . $personId;
}

function github_person_media_file_path(string $personId, string $filename): string
{
    $cleanFile = ltrim(str_replace('\\', '/', trim($filename)), '/');
    return github_person_media_directory($personId) . '/' . $cleanFile;
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

    $normalizedMethod = strtoupper($method);
    $usesEmptyBody = $jsonBody === null && in_array($normalizedMethod, ['PUT', 'DELETE'], true);
    if ($usesEmptyBody) {
        $headers[] = 'Content-Length: 0';
    }

    $responseHeaders = [];
    $options = [
        CURLOPT_CUSTOMREQUEST => $normalizedMethod,
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
    } elseif ($usesEmptyBody) {
        $options[CURLOPT_POSTFIELDS] = '';
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
            . 'Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH in the API server .env file '
            . 'and upload the .pem private key.',
        'setup' => [
            'recommended' => 'GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH',
            'app_url' => 'https://github.com/settings/apps',
            'repository_permissions' => [
                'Metadata' => 'Read-only',
                'Contents' => 'Read and write',
                'Pull requests' => 'Read and write',
            ],
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
    // Paths without an extension are treated as directories (for example
    // people/15/data/images) and match any file they contain.
    $isDirectory = pathinfo($path, PATHINFO_EXTENSION) === '';
    $directoryPrefix = rtrim($path, '/') . '/';

    foreach ($commit['files'] ?? [] as $file) {
        if (!is_array($file)) {
            continue;
        }

        $filename = (string) ($file['filename'] ?? '');
        $previousFilename = (string) ($file['previous_filename'] ?? '');
        if ($filename === $path || $previousFilename === $path) {
            return $file;
        }

        if ($isDirectory
            && (str_starts_with($filename, $directoryPrefix) || str_starts_with($previousFilename, $directoryPrefix))) {
            return $file;
        }
    }

    return null;
}

function github_path_is_binary_asset(string $path): bool
{
    $extension = strtolower((string) pathinfo($path, PATHINFO_EXTENSION));

    return in_array($extension, [
        'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'ico', 'bmp',
        'pdf', 'zip', 'gz', 'woff', 'woff2', 'ttf', 'eot', 'otf',
        'mp3', 'mp4', 'webm', 'mov',
    ], true);
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
    $isBinary = github_path_is_binary_asset($afterPath !== '' ? $afterPath : $beforePath);

    if (!$isBinary && $statusLabel !== 'added' && $parentSha !== '') {
        $before = github_fetch_file_contents_at_ref($owner, $repo, $beforePath, $parentSha);
    }

    if (!$isBinary && $statusLabel !== 'removed') {
        $after = github_fetch_file_contents_at_ref($owner, $repo, $afterPath, $hash);
    }

    return [
        'path' => $afterPath !== '' ? $afterPath : $path,
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
    $sessionToken = trim((string) ($_SESSION[GITHUB_SESSION_TOKEN_KEY] ?? ''));
    if ($sessionToken !== '') {
        return $sessionToken;
    }

    return github_request_bearer_token();
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

function github_publish_token_candidates(array $editor): array
{
    $candidates = [];
    $seen = [];

    $add = static function (string $token, string $source) use (&$candidates, &$seen): void {
        $token = trim($token);
        if ($token === '' || isset($seen[$token])) {
            return;
        }

        $seen[$token] = true;
        $candidates[] = [
            'token' => $token,
            'source' => $source,
        ];
    };

    if (github_app_configured()) {
        $add(github_fetch_installation_access_token(), 'github_app');
    }

    $publishToken = github_env_value('GITHUB_PUBLISH_TOKEN');
    if ($publishToken !== '' && !str_starts_with($publishToken, 'your_')) {
        $add($publishToken, 'GITHUB_PUBLISH_TOKEN');
    }

    $add(trim((string) ($editor['token'] ?? '')), 'user_oauth');

    foreach (['GITHUB_API_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as $name) {
        $token = github_env_value($name);
        if ($token !== '' && !str_starts_with($token, 'your_')) {
            $add($token, $name);
        }
    }

    $tokenFile = github_env_value('GITHUB_API_TOKEN_FILE');
    if ($tokenFile !== '' && is_readable($tokenFile)) {
        $add(trim((string) file_get_contents($tokenFile)), 'GITHUB_API_TOKEN_FILE');
    }

    return $candidates;
}

function github_token_oauth_scopes(string $token): array
{
    $response = github_rest_request('GET', 'https://api.github.com/user', $token);
    if ($response['status'] >= 400) {
        return [];
    }

    $raw = trim((string) ($response['headers']['x-oauth-scopes'] ?? ''));
    if ($raw === '') {
        return [];
    }

    return array_values(array_filter(array_map('trim', explode(',', $raw))));
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

function github_token_can_publish(string $owner, string $repo, string $token): bool
{
    try {
        $permissions = github_token_repo_permissions($owner, $repo, $token);
        if (!empty($permissions['push']) || !empty($permissions['admin']) || !empty($permissions['maintain'])) {
            return true;
        }
    } catch (Throwable $error) {
        // Fall through to scope-based checks.
    }

    foreach (github_token_oauth_scopes($token) as $scope) {
        $normalized = strtolower($scope);
        if ($normalized === 'repo' || $normalized === 'public_repo') {
            return true;
        }
    }

    return false;
}

function github_build_publish_token_help_message(array $failures = []): string
{
    $repoConfig = github_repo_config();
    $repoSlug = $repoConfig['owner'] . '/' . $repoConfig['repo'];
    $lines = [
        'No GitHub token available can write to ' . $repoSlug . '.',
    ];

    if (github_app_configured()) {
        $lines[] = 'Check GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and that the GitHub App is installed on ' . $repoSlug . ' with Contents and Pull requests write access.';
    } else {
        $lines = array_merge($lines, [
            'Configure a GitHub App (recommended) or add GITHUB_PUBLISH_TOKEN with repository write access.',
            '',
            'GitHub App repository permissions:',
            '- Contents: Read and write',
            '- Pull requests: Read and write',
            '- Metadata: Read-only',
            '',
            'Fine-grained PAT alternative:',
            '- Repository access: only ' . $repoSlug,
            '- Contents: Read and write',
            '- Pull requests: Read and write',
            '- Metadata: Read-only',
            '',
            'Classic PAT alternative: enable the public_repo scope.',
        ]);
    }

    if ($failures !== []) {
        $lines[] = '';
        $lines[] = 'Checked tokens: ' . implode(' | ', $failures);
    }

    return implode("\n", $lines);
}

function github_resolve_page_edit_api_token(array $editor): string
{
    $repoConfig = github_repo_config();
    $owner = $repoConfig['owner'];
    $repo = $repoConfig['repo'];
    $failures = [];

    foreach (github_publish_token_candidates($editor) as $candidate) {
        if (!github_token_can_publish($owner, $repo, $candidate['token'])) {
            $failures[] = $candidate['source'] . ' lacks write access';
            continue;
        }

        return $candidate['token'];
    }

    throw new RuntimeException(github_build_publish_token_help_message($failures));
}

function github_publish_auth_status(): array
{
    $editor = [
        'token' => github_session_access_token(),
    ];
    $repoConfig = github_repo_config();
    $owner = $repoConfig['owner'];
    $repo = $repoConfig['repo'];
    $candidates = github_publish_token_candidates($editor);

    if ($candidates === []) {
        $message = github_app_configured()
            ? 'GitHub App is configured but no installation token is available. Check the private key and that the app is installed on the repository.'
            : 'Configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH, or set GITHUB_PUBLISH_TOKEN with repository write access.';

        return [
            'configured' => false,
            'can_publish' => false,
            'active_token_source' => null,
            'candidates' => [],
            'message' => $message,
        ];
    }

    $checked = [];
    $activeSource = null;

    foreach ($candidates as $candidate) {
        $canPublish = github_token_can_publish($owner, $repo, $candidate['token']);
        $checked[] = [
            'source' => $candidate['source'],
            'can_publish' => $canPublish,
        ];
        if ($canPublish && $activeSource === null) {
            $activeSource = $candidate['source'];
        }
    }

    $canPublish = $activeSource !== null;

    return [
        'configured' => true,
        'can_publish' => $canPublish,
        'active_token_source' => $activeSource,
        'candidates' => $checked,
        'message' => $canPublish
            ? 'Publishing will use ' . $activeSource . '.'
            : (github_app_configured()
                ? 'GitHub App token cannot write to the repository. Grant Contents and Pull requests write access and reinstall the app.'
                : 'No configured token can write to the repository. Configure a GitHub App or add GITHUB_PUBLISH_TOKEN with Contents and Pull requests write access.'),
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

function github_is_empty_repository_error(Throwable $error): bool
{
    return str_contains($error->getMessage(), 'Git Repository is empty');
}

function github_repository_default_branch_name(string $owner, string $repo, string $token): string
{
    $repository = github_rest_request_json(
        'GET',
        sprintf('https://api.github.com/repos/%s/%s', rawurlencode($owner), rawurlencode($repo)),
        $token,
        null,
        'Repository lookup',
    );

    $defaultBranch = trim((string) ($repository['default_branch'] ?? 'main'));
    return $defaultBranch !== '' ? $defaultBranch : 'main';
}

function github_get_repository_default_branch(string $owner, string $repo, string $token): array
{
    $defaultBranch = github_repository_default_branch_name($owner, $repo, $token);

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

function github_create_initial_file_on_default_branch(
    string $owner,
    string $repo,
    string $path,
    string $content,
    string $commitMessage,
    string $token,
    ?array $commitIdentity = null,
): array {
    $defaultBranch = github_repository_default_branch_name($owner, $repo, $token);

    $blob = github_rest_request_json(
        'POST',
        sprintf('https://api.github.com/repos/%s/%s/git/blobs', rawurlencode($owner), rawurlencode($repo)),
        $token,
        [
            'content' => base64_encode($content),
            'encoding' => 'base64',
        ],
        'Create blob',
    );

    $blobSha = trim((string) ($blob['sha'] ?? ''));
    if ($blobSha === '') {
        throw new RuntimeException('GitHub did not return a blob SHA for the first media upload.');
    }

    $tree = github_rest_request_json(
        'POST',
        sprintf('https://api.github.com/repos/%s/%s/git/trees', rawurlencode($owner), rawurlencode($repo)),
        $token,
        [
            'tree' => [[
                'path' => $path,
                'mode' => '100644',
                'type' => 'blob',
                'sha' => $blobSha,
            ]],
        ],
        'Create initial tree',
    );

    $treeSha = trim((string) ($tree['sha'] ?? ''));
    if ($treeSha === '') {
        throw new RuntimeException('GitHub did not return a tree SHA for the first media upload.');
    }

    $commitPayload = [
        'message' => $commitMessage,
        'tree' => $treeSha,
        'parents' => [],
    ];
    if (is_array($commitIdentity)) {
        $commitPayload['author'] = $commitIdentity;
        $commitPayload['committer'] = $commitIdentity;
    }

    $commit = github_rest_request_json(
        'POST',
        sprintf('https://api.github.com/repos/%s/%s/git/commits', rawurlencode($owner), rawurlencode($repo)),
        $token,
        $commitPayload,
        'Create initial commit',
    );

    $commitSha = trim((string) ($commit['sha'] ?? ''));
    if ($commitSha === '') {
        throw new RuntimeException('GitHub did not return a commit SHA for the first media upload.');
    }

    github_rest_request_json(
        'POST',
        sprintf('https://api.github.com/repos/%s/%s/git/refs', rawurlencode($owner), rawurlencode($repo)),
        $token,
        [
            'ref' => 'refs/heads/' . $defaultBranch,
            'sha' => $commitSha,
        ],
        'Create default branch',
    );

    return [
        'branch' => $defaultBranch,
        'base_branch' => $defaultBranch,
        'commit' => [
            'sha' => $commitSha,
            'message' => $commitMessage,
        ],
        'pull_request' => null,
    ];
}

function github_commit_files_to_default_branch_with_token(
    string $token,
    string $owner,
    string $repo,
    array $files,
    array $editor,
    string $commitMessage,
): array {
    $user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
    $commitIdentity = github_editor_commit_identity($user);

    $base = github_get_repository_default_branch($owner, $repo, $token);
    $baseBranch = $base['branch'];
    $baseSha = $base['sha'];

    $baseCommit = github_rest_request_json(
        'GET',
        sprintf(
            'https://api.github.com/repos/%s/%s/git/commits/%s',
            rawurlencode($owner),
            rawurlencode($repo),
            rawurlencode($baseSha),
        ),
        $token,
        null,
        'Base commit lookup',
    );

    $baseTree = trim((string) ($baseCommit['tree']['sha'] ?? ''));
    if ($baseTree === '') {
        throw new RuntimeException('Could not resolve the repository base tree.');
    }

    $treeEntries = [];
    foreach ($files as $file) {
        $treeEntries[] = [
            'path' => (string) $file['path'],
            'mode' => '100644',
            'type' => 'blob',
            'content' => (string) $file['content'],
        ];
    }

    $tree = github_rest_request_json(
        'POST',
        sprintf('https://api.github.com/repos/%s/%s/git/trees', rawurlencode($owner), rawurlencode($repo)),
        $token,
        [
            'base_tree' => $baseTree,
            'tree' => $treeEntries,
        ],
        'Create tree',
    );

    $treeSha = trim((string) ($tree['sha'] ?? ''));
    if ($treeSha === '') {
        throw new RuntimeException('GitHub did not return a tree SHA for the profile commit.');
    }

    $commitPayload = [
        'message' => $commitMessage,
        'tree' => $treeSha,
        'parents' => [$baseSha],
    ];
    if ($commitIdentity !== []) {
        $commitPayload['author'] = $commitIdentity;
        $commitPayload['committer'] = $commitIdentity;
    }

    $commit = github_rest_request_json(
        'POST',
        sprintf('https://api.github.com/repos/%s/%s/git/commits', rawurlencode($owner), rawurlencode($repo)),
        $token,
        $commitPayload,
        'Create commit',
    );

    $commitSha = trim((string) ($commit['sha'] ?? ''));
    if ($commitSha === '') {
        throw new RuntimeException('GitHub did not return a commit SHA.');
    }

    github_rest_request_json(
        'PATCH',
        sprintf(
            'https://api.github.com/repos/%s/%s/git/refs/heads/%s',
            rawurlencode($owner),
            rawurlencode($repo),
            rawurlencode($baseBranch),
        ),
        $token,
        [
            'sha' => $commitSha,
            'force' => false,
        ],
        'Update default branch',
    );

    return [
        'branch' => $baseBranch,
        'commit' => [
            'sha' => $commitSha,
            'message' => $commitMessage,
        ],
        'files' => array_map(static fn (array $file): string => (string) $file['path'], $files),
    ];
}

function github_commit_files_to_default_branch(
    string $owner,
    string $repo,
    array $files,
    array $editor,
    string $commitMessage,
): array {
    $totalBytes = 0;
    foreach ($files as $file) {
        $totalBytes += strlen((string) ($file['content'] ?? ''));
    }
    if ($totalBytes > 4_000_000) {
        throw new RuntimeException('The published files are too large to publish.');
    }

    $failures = [];
    foreach (github_publish_token_candidates($editor) as $candidate) {
        if (!github_token_can_publish($owner, $repo, $candidate['token'])) {
            $failures[] = $candidate['source'] . ' lacks write access';
            continue;
        }

        try {
            return github_commit_files_to_default_branch_with_token(
                $candidate['token'],
                $owner,
                $repo,
                $files,
                $editor,
                $commitMessage,
            );
        } catch (RuntimeException $error) {
            if (!github_is_publish_auth_failure($error)) {
                throw $error;
            }

            $failures[] = $candidate['source'] . ': ' . $error->getMessage();
        }
    }

    throw new RuntimeException(github_build_publish_token_help_message($failures));
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

function github_create_page_edit_pull_request_with_token(
    string $token,
    string $owner,
    string $repo,
    string $path,
    string $content,
    array $editor,
    string $commitMessage,
    string $prTitle,
    string $prBody,
): array {
    $user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
    $login = github_sanitize_branch_segment((string) ($user['login'] ?? 'editor'));
    $commitIdentity = github_editor_commit_identity($user);

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

function github_is_publish_auth_failure(RuntimeException $error): bool
{
    $message = $error->getMessage();

    return str_contains($message, 'HTTP 403')
        || str_contains($message, 'HTTP 401')
        || str_contains($message, 'Resource not accessible by personal access token');
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
    if (strlen($content) > 2_000_000) {
        throw new RuntimeException('The edited page is too large to publish.');
    }

    $failures = [];
    foreach (github_publish_token_candidates($editor) as $candidate) {
        if (!github_token_can_publish($owner, $repo, $candidate['token'])) {
            $failures[] = $candidate['source'] . ' lacks write access';
            continue;
        }

        try {
            return github_create_page_edit_pull_request_with_token(
                $candidate['token'],
                $owner,
                $repo,
                $path,
                $content,
                $editor,
                $commitMessage,
                $prTitle,
                $prBody,
            );
        } catch (RuntimeException $error) {
            if (!github_is_publish_auth_failure($error)) {
                throw $error;
            }

            $failures[] = $candidate['source'] . ': ' . $error->getMessage();
        }
    }

    throw new RuntimeException(github_build_publish_token_help_message($failures));
}

function github_review_login(): string
{
    $configured = github_env_value('GITHUB_REVIEW_LOGIN');

    return $configured !== '' ? $configured : 'ShaunRoselt';
}

function github_user_can_review_pull_requests(?array $user): bool
{
    if (!is_array($user)) {
        return false;
    }

    return strcasecmp(trim((string) ($user['login'] ?? '')), github_review_login()) === 0;
}

function github_require_pull_request_reviewer(): array
{
    $editor = github_require_authenticated_editor();
    if (!github_user_can_review_pull_requests($editor['user'])) {
        throw new RuntimeException(
            'Only ' . github_review_login() . ' can approve or decline pending changes.'
        );
    }

    return $editor;
}

function github_normalize_pull_request_user(?array $user): array
{
    if (!is_array($user)) {
        return [
            'login' => '',
            'displayName' => '',
            'photoUrl' => '',
            'profileUrl' => '',
        ];
    }

    $login = trim((string) ($user['login'] ?? ''));

    return [
        'login' => $login,
        'displayName' => trim((string) ($user['name'] ?? '')) ?: $login,
        'photoUrl' => trim((string) ($user['avatar_url'] ?? '')),
        'profileUrl' => trim((string) ($user['html_url'] ?? '')),
    ];
}

function github_extract_page_path_from_pull_request_body(array $pullRequest): string
{
    if (preg_match('/`((?:pages|people|data\/(?:Genepedia-Database(?:\/people)?|people\/v1))\/[^`]+)`/', (string) ($pullRequest['body'] ?? ''), $matches) === 1) {
        return github_is_people_db_workspace_path($matches[1])
            ? github_normalize_people_db_workspace_path($matches[1])
            : $matches[1];
    }

    return '';
}

function github_pull_request_summary_matches_paths(array $summary, array $paths): bool
{
    if ($paths === []) {
        return true;
    }

    foreach ($paths as $path) {
        $path = trim((string) $path);
        if ($path === '') {
            continue;
        }

        $pagePath = trim((string) ($summary['page_path'] ?? ''));
        if ($pagePath !== '' && $pagePath === $path) {
            return true;
        }

        // Directory paths (e.g. people/15/data/images) match any file inside them.
        if ($pagePath !== ''
            && pathinfo($path, PATHINFO_EXTENSION) === ''
            && str_starts_with($pagePath, $path . '/')) {
            return true;
        }

        $fileSlug = github_sanitize_branch_segment((string) pathinfo($path, PATHINFO_FILENAME));
        $ref = strtolower(trim((string) ($summary['head']['ref'] ?? '')));
        if ($fileSlug !== '' && str_starts_with($ref, 'edit/' . $fileSlug . '-')) {
            return true;
        }

        if (str_contains((string) ($summary['body'] ?? ''), '`' . $path . '`')) {
            return true;
        }
    }

    return false;
}

function github_normalize_pull_request_summary(array $pullRequest): array
{
    $user = $pullRequest['user'] ?? null;
    $head = is_array($pullRequest['head'] ?? null) ? $pullRequest['head'] : [];
    $base = is_array($pullRequest['base'] ?? null) ? $pullRequest['base'] : [];

    return [
        'number' => (int) ($pullRequest['number'] ?? 0),
        'title' => trim((string) ($pullRequest['title'] ?? '')),
        'body' => trim((string) ($pullRequest['body'] ?? '')),
        'page_path' => github_extract_page_path_from_pull_request_body($pullRequest),
        'state' => trim((string) ($pullRequest['state'] ?? '')),
        'url' => trim((string) ($pullRequest['html_url'] ?? '')),
        'created_at' => trim((string) ($pullRequest['created_at'] ?? '')),
        'updated_at' => trim((string) ($pullRequest['updated_at'] ?? '')),
        'merged' => !empty($pullRequest['merged_at']),
        'draft' => !empty($pullRequest['draft']),
        'user' => github_normalize_pull_request_user(is_array($user) ? $user : null),
        'head' => [
            'ref' => trim((string) ($head['ref'] ?? '')),
            'sha' => trim((string) ($head['sha'] ?? '')),
        ],
        'base' => [
            'ref' => trim((string) ($base['ref'] ?? '')),
            'sha' => trim((string) ($base['sha'] ?? '')),
        ],
        'additions' => (int) ($pullRequest['additions'] ?? 0),
        'deletions' => (int) ($pullRequest['deletions'] ?? 0),
        'changed_files' => (int) ($pullRequest['changed_files'] ?? 0),
    ];
}

function github_is_page_editor_pull_request(array $pullRequest): bool
{
    $head = is_array($pullRequest['head'] ?? null) ? $pullRequest['head'] : [];
    $ref = trim((string) ($head['ref'] ?? ''));

    return str_starts_with($ref, 'edit/') || str_starts_with($ref, 'media/');
}

function github_fetch_open_pull_requests(
    string $owner,
    string $repo,
    bool $pageEditorOnly = true,
    array $paths = [],
): array {
    github_require_api_token();

    $url = sprintf(
        'https://api.github.com/repos/%s/%s/pulls?state=open&sort=updated&direction=desc&per_page=100',
        rawurlencode($owner),
        rawurlencode($repo),
    );
    $response = github_rest_get($url);
    if ($response['status'] >= 400) {
        throw new RuntimeException(github_format_rest_error($response, 'Open pull request lookup'));
    }

    $items = is_array($response['data']) ? $response['data'] : [];
    $pullRequests = [];

    foreach ($items as $item) {
        if (!is_array($item)) {
            continue;
        }

        if ($pageEditorOnly && !github_is_page_editor_pull_request($item)) {
            continue;
        }

        $summary = github_normalize_pull_request_summary($item);
        if ($paths !== [] && !github_pull_request_summary_matches_paths($summary, $paths)) {
            continue;
        }

        $pullRequests[] = $summary;
    }

    return $pullRequests;
}

function github_fetch_pull_request(string $owner, string $repo, int $number): array
{
    github_require_api_token();

    $response = github_rest_get(sprintf(
        'https://api.github.com/repos/%s/%s/pulls/%d',
        rawurlencode($owner),
        rawurlencode($repo),
        $number,
    ));
    if ($response['status'] === 404) {
        throw new RuntimeException('Pull request not found.');
    }
    if ($response['status'] >= 400) {
        throw new RuntimeException(github_format_rest_error($response, 'Pull request lookup'));
    }

    if (!is_array($response['data'])) {
        throw new RuntimeException('GitHub returned an invalid pull request response.');
    }

    return $response['data'];
}

function github_fetch_pull_request_files(string $owner, string $repo, int $number): array
{
    github_require_api_token();

    $response = github_rest_get(sprintf(
        'https://api.github.com/repos/%s/%s/pulls/%d/files?per_page=100',
        rawurlencode($owner),
        rawurlencode($repo),
        $number,
    ));
    if ($response['status'] >= 400) {
        throw new RuntimeException(github_format_rest_error($response, 'Pull request file lookup'));
    }

    return is_array($response['data']) ? $response['data'] : [];
}

function github_build_file_diff_from_pr_file(
    array $file,
    string $owner,
    string $repo,
    string $baseSha,
    string $headSha,
): array {
    $statusLabel = (string) ($file['status'] ?? 'modified');
    $afterPath = (string) ($file['filename'] ?? '');
    $beforePath = (string) ($file['previous_filename'] ?? $afterPath);
    $before = null;
    $after = null;
    $isBinary = github_path_is_binary_asset($afterPath !== '' ? $afterPath : $beforePath);

    if (!$isBinary && $statusLabel !== 'added' && $baseSha !== '') {
        $before = github_fetch_file_contents_at_ref($owner, $repo, $beforePath, $baseSha);
    }

    if (!$isBinary && $statusLabel !== 'removed' && $headSha !== '') {
        $after = github_fetch_file_contents_at_ref($owner, $repo, $afterPath, $headSha);
    }

    return [
        'path' => $afterPath !== '' ? $afterPath : $beforePath,
        'status' => $statusLabel,
        'before_path' => $beforePath,
        'after_path' => $afterPath,
        'additions' => (int) ($file['additions'] ?? 0),
        'deletions' => (int) ($file['deletions'] ?? 0),
        'patch' => isset($file['patch']) ? (string) $file['patch'] : null,
        'before' => $before,
        'after' => $after,
    ];
}

function github_fetch_pull_request_detail(string $owner, string $repo, int $number): array
{
    $pullRequest = github_fetch_pull_request($owner, $repo, $number);
    $summary = github_normalize_pull_request_summary($pullRequest);
    $baseSha = $summary['base']['sha'];
    $headSha = $summary['head']['sha'];
    $files = github_fetch_pull_request_files($owner, $repo, $number);
    $diffs = [];

    foreach ($files as $file) {
        if (!is_array($file)) {
            continue;
        }

        $diffs[] = github_build_file_diff_from_pr_file($file, $owner, $repo, $baseSha, $headSha);
    }

    return [
        'pull_request' => $summary,
        'diffs' => $diffs,
    ];
}

function github_merge_pull_request(string $owner, string $repo, int $number, string $token): array
{
    return github_rest_request_json(
        'PUT',
        sprintf(
            'https://api.github.com/repos/%s/%s/pulls/%d/merge',
            rawurlencode($owner),
            rawurlencode($repo),
            $number,
        ),
        $token,
        [
            'merge_method' => 'squash',
        ],
        'Merge pull request',
    );
}

function github_close_pull_request(string $owner, string $repo, int $number, string $token): array
{
    return github_rest_request_json(
        'PATCH',
        sprintf(
            'https://api.github.com/repos/%s/%s/pulls/%d',
            rawurlencode($owner),
            rawurlencode($repo),
            $number,
        ),
        $token,
        [
            'state' => 'closed',
        ],
        'Close pull request',
    );
}

function github_review_pull_request(string $owner, string $repo, int $number, string $action, array $reviewer): array
{
    $normalizedAction = strtolower(trim($action));
    if ($normalizedAction !== 'merge' && $normalizedAction !== 'decline') {
        throw new RuntimeException('Review action must be merge or decline.');
    }

    $pullRequest = github_fetch_pull_request($owner, $repo, $number);
    if (strtolower((string) ($pullRequest['state'] ?? '')) !== 'open') {
        throw new RuntimeException('This pull request is no longer open.');
    }

    $failures = [];
    foreach (github_publish_token_candidates($reviewer) as $candidate) {
        if (!github_token_can_publish($owner, $repo, $candidate['token'])) {
            $failures[] = $candidate['source'] . ' lacks write access';
            continue;
        }

        try {
            if ($normalizedAction === 'merge') {
                $result = github_merge_pull_request($owner, $repo, $number, $candidate['token']);
                if (empty($result['merged'])) {
                    throw new RuntimeException((string) ($result['message'] ?? 'GitHub could not merge this pull request.'));
                }

                return [
                    'action' => 'merge',
                    'merged' => true,
                    'sha' => (string) ($result['sha'] ?? ''),
                    'pull_request' => github_normalize_pull_request_summary(github_fetch_pull_request($owner, $repo, $number)),
                ];
            }

            $closed = github_close_pull_request($owner, $repo, $number, $candidate['token']);

            return [
                'action' => 'decline',
                'merged' => false,
                'pull_request' => github_normalize_pull_request_summary($closed),
            ];
        } catch (RuntimeException $error) {
            if (!github_is_publish_auth_failure($error)) {
                throw $error;
            }

            $failures[] = $candidate['source'] . ': ' . $error->getMessage();
        }
    }

    throw new RuntimeException(github_build_publish_token_help_message($failures));
}


// ---------------------------------------------------------------------------
// People profiles: shared helpers for media uploads and talk pages
// ---------------------------------------------------------------------------

const GITHUB_MEDIA_MAX_BYTES = 8_000_000;
const GITHUB_MEDIA_ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'pdf'];
const GITHUB_TALK_MAX_MESSAGE_LENGTH = 5000;
const GITHUB_TALK_MAX_MESSAGES = 2000;

function github_validate_person_id(string $personId): ?string
{
    $personId = trim($personId);
    if ($personId === '' || !preg_match('/^[a-zA-Z0-9_-]{1,64}$/', $personId)) {
        return null;
    }

    return $personId;
}

/**
 * Path validation for read-only history/diff lookups. Accepts the page-editor
 * .html paths, canonical people database JSON paths, plus profile data files
 * (talk.json, *.ged) and the per-person media folder/file paths so commits show
 * up on the Changes tab.
 */
function github_validate_repo_history_path(string $path): ?string
{
    $normalized = str_replace('\\', '/', trim($path));
    $normalized = ltrim($normalized, '/');

    if ($normalized === '' || str_contains($normalized, '..')) {
        return null;
    }

    if (preg_match('#^(pages|people)/[a-zA-Z0-9_./-]+\.(html|json|ged)$#', $normalized)) {
        return $normalized;
    }

    $dbPath = github_normalize_people_db_workspace_path($normalized);
    if (preg_match('#^data/Genepedia-Database/people/(persons|unions|ownership|graph)/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+\.json$#', $dbPath) === 1) {
        return $dbPath;
    }
    if (preg_match('#^data/Genepedia-Database/people/index/(summary|search)/[a-zA-Z0-9_.-]+\.json$#', $dbPath) === 1) {
        return $dbPath;
    }
    if (in_array($dbPath, [
        'data/Genepedia-Database/people/index/all-ids.json',
        'data/Genepedia-Database/people/index/ownership-logins.json',
        'data/Genepedia-Database/people/manifest.json',
        'data/Genepedia-Database/people/sources/gedcom-id-map.json',
    ], true)) {
        return $dbPath;
    }

    if (preg_match('#^people/[a-zA-Z0-9_-]+(?:/images|/[a-zA-Z0-9._-]+\.(?:jpe?g|png|gif|webp|svg|avif|pdf))?$#i', $normalized)) {
        return $normalized;
    }

    return null;
}

function github_parse_repo_history_paths_request(): ?array
{
    if (isset($_GET['paths'])) {
        $raw = trim((string) $_GET['paths']);
        if ($raw === '') {
            return null;
        }

        $paths = [];
        foreach (preg_split('/\s*,\s*/', $raw) ?: [] as $part) {
            $validated = github_validate_repo_history_path((string) $part);
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

    $validated = github_validate_repo_history_path((string) $_GET['path']);
    return $validated !== null ? [$validated] : null;
}

function github_person_db_bucket(string $personId): int
{
    $digits = preg_replace('/[^0-9]/', '', $personId);
    $n = $digits === '' ? 0 : (int) $digits;
    return (int) floor((max(1, $n) - 1) / 1000);
}

function github_person_ownership_path(string $personId): string
{
    return github_people_db_workspace_path('ownership/' . github_person_db_bucket($personId) . '/' . $personId . '.json');
}

function github_person_record_path(string $personId): string
{
    return github_people_db_workspace_path('persons/' . github_person_db_bucket($personId) . '/' . $personId . '.json');
}

function github_fetch_person_profile_config(string $owner, string $repo, string $personId): array
{
    $dbRepo = github_people_db_repo_config();
    $path = github_people_db_repo_path(github_person_ownership_path($personId));
    $base = github_get_repository_default_branch($dbRepo['owner'], $dbRepo['repo'], github_api_token());
    $content = github_fetch_file_contents_at_ref($dbRepo['owner'], $dbRepo['repo'], $path, $base['branch']);
    if ($content === null) {
        return [];
    }

    $decoded = json_decode($content, true);
    return is_array($decoded) ? $decoded : [];
}

function github_person_profile_logins(array $profileConfig): array
{
    $logins = [];

    $ownerLogin = github_identity_login($profileConfig['owner'] ?? null);
    if ($ownerLogin !== '') {
        $logins[] = strtolower($ownerLogin);
    }

    $maintainers = $profileConfig['maintainers'] ?? [];
    if (is_array($maintainers)) {
        foreach ($maintainers as $maintainer) {
            $login = github_identity_login($maintainer);
            if ($login !== '') {
                $logins[] = strtolower($login);
            }
        }
    }

    // Before a profile has an owner, its creator is in charge. Once there is an
    // owner, the creator keeps direct access only if they remain a maintainer.
    if ($ownerLogin === '') {
        $creatorLogin = github_identity_login($profileConfig['creator'] ?? null);
        if ($creatorLogin !== '') {
            $logins[] = strtolower($creatorLogin);
        }
    }

    return array_values(array_unique($logins));
}

function github_person_can_manage(array $profileConfig, ?array $user): bool
{
    if (!is_array($user)) {
        return false;
    }

    $login = strtolower(trim((string) ($user['login'] ?? '')));
    if ($login === '') {
        return false;
    }

    if (github_user_can_review_pull_requests($user)) {
        return true;
    }

    return in_array($login, github_person_profile_logins($profileConfig), true);
}

function github_identity_login($identity): string
{
    if (is_string($identity)) {
        $login = trim($identity);
        return preg_match('/^[a-zA-Z0-9-]{1,39}$/', $login) === 1 ? $login : '';
    }

    if (!is_array($identity)) {
        return '';
    }

    foreach (['githubLogin', 'github_login', 'login'] as $key) {
        $login = trim((string) ($identity[$key] ?? ''));
        if ($login !== '') {
            return $login;
        }
    }

    return '';
}

function github_append_identity_logins(array $logins, $identity): array
{
    $isList = is_array($identity)
        && ($identity === [] || array_keys($identity) === range(0, count($identity) - 1));
    if ($isList) {
        foreach ($identity as $entry) {
            $logins = github_append_identity_logins($logins, $entry);
        }

        return $logins;
    }

    $login = github_identity_login($identity);
    if ($login !== '') {
        $logins[] = strtolower($login);
    }

    return $logins;
}

function github_ownership_config_logins(array $config): array
{
    $logins = [];
    foreach (['creator', 'createdBy', 'created_by', 'owner', 'ownedBy', 'owned_by'] as $key) {
        if (array_key_exists($key, $config)) {
            $logins = github_append_identity_logins($logins, $config[$key]);
        }
    }

    foreach (['maintainers', 'maintainedBy', 'maintained_by', 'owners'] as $key) {
        if (array_key_exists($key, $config)) {
            $logins = github_append_identity_logins($logins, $config[$key]);
        }
    }

    return array_values(array_unique($logins));
}

function github_user_login(?array $user): string
{
    if (!is_array($user)) {
        return '';
    }

    return strtolower(trim((string) ($user['login'] ?? '')));
}

function github_user_matches_logins(?array $user, array $logins): bool
{
    $login = github_user_login($user);
    if ($login === '') {
        return false;
    }

    return in_array($login, array_map('strtolower', $logins), true);
}

function github_page_ownership_config_path(string $path): ?string
{
    $path = str_replace('\\', '/', trim($path));
    if (!preg_match('#^pages/[a-zA-Z0-9_./-]+\.html$#', $path)) {
        return null;
    }

    return preg_replace('/\.html$/', '.json', $path) ?: null;
}

function github_fetch_page_ownership_config(string $owner, string $repo, string $path): array
{
    $configPath = github_page_ownership_config_path($path);
    if ($configPath === null) {
        return [];
    }

    $base = github_get_repository_default_branch($owner, $repo, github_api_token());
    $content = github_fetch_file_contents_at_ref($owner, $repo, $configPath, $base['branch']);
    if ($content === null) {
        return [];
    }

    $decoded = json_decode($content, true);
    return is_array($decoded) ? $decoded : [];
}

function github_repo_path_was_created_by_user(string $owner, string $repo, string $path, ?array $user): bool
{
    $login = github_user_login($user);
    if ($login === '') {
        return false;
    }

    $commits = github_fetch_all_file_commits($owner, $repo, $path);
    if ($commits === []) {
        return false;
    }

    $firstCommit = $commits[count($commits) - 1];
    $authorLogin = strtolower(trim((string) ($firstCommit['author_login'] ?? '')));

    return $authorLogin !== '' && $authorLogin === $login;
}

function github_page_can_manage(string $owner, string $repo, string $path, ?array $user): bool
{
    if (github_user_can_review_pull_requests($user)) {
        return true;
    }

    if (github_user_login($user) === '') {
        return false;
    }

    try {
        $config = github_fetch_page_ownership_config($owner, $repo, $path);
        if ($config !== []) {
            return github_user_matches_logins($user, github_ownership_config_logins($config));
        }
    } catch (Throwable $error) {
        // A missing or unreadable ownership file should not prevent a reviewed PR.
    }

    try {
        return github_repo_path_was_created_by_user($owner, $repo, $path, $user);
    } catch (Throwable $error) {
        return false;
    }
}

function github_profile_edit_person_id(array $paths): ?string
{
    $personId = null;
    foreach ($paths as $path) {
        $matches = null;
        if (preg_match('#^people/([a-zA-Z0-9_-]+)/(?:index\.html|profile\.html|data/[a-zA-Z0-9_.-]+\.html|data/family-tree\.ged)$#', (string) $path, $matches) !== 1
            && preg_match('#^data/(?:Genepedia-Database(?:/people)?|people/v1)/(?:ownership|persons)/[a-zA-Z0-9_-]+/([a-zA-Z0-9_-]+)\.json$#', (string) $path, $matches) !== 1) {
            return null;
        }

        $current = (string) $matches[1];
        if ($personId !== null && $personId !== $current) {
            return null;
        }

        $personId = $current;
    }

    return $personId;
}

function github_paths_are_pages(array $paths): bool
{
    foreach ($paths as $path) {
        if (!preg_match('#^pages/[a-zA-Z0-9_./-]+\.html$#', (string) $path)) {
            return false;
        }
    }

    return $paths !== [];
}

function github_profile_can_manage(
    string $owner,
    string $repo,
    string $personId,
    ?array $user,
): bool {
    if (github_user_can_review_pull_requests($user)) {
        return true;
    }

    try {
        $profileConfig = github_fetch_person_profile_config($owner, $repo, $personId);
        if ($profileConfig !== []) {
            return github_person_can_manage($profileConfig, $user);
        }
    } catch (Throwable $error) {
        // Fall through to the original-file author check.
    }

    try {
        return github_repo_path_was_created_by_user($owner, $repo, 'people/' . $personId . '/index.html', $user);
    } catch (Throwable $error) {
        return false;
    }
}

function github_user_can_direct_publish_paths(
    string $owner,
    string $repo,
    array $paths,
    ?array $user,
): bool {
    $paths = array_values(array_unique(array_filter(array_map('strval', $paths))));
    if ($paths === []) {
        return false;
    }

    if (github_user_can_review_pull_requests($user)) {
        return true;
    }

    $personId = github_profile_edit_person_id($paths);
    if ($personId !== null) {
        return github_profile_can_manage($owner, $repo, $personId, $user);
    }

    if (github_paths_are_pages($paths)) {
        foreach ($paths as $path) {
            if (!github_page_can_manage($owner, $repo, $path, $user)) {
                return false;
            }
        }

        return true;
    }

    return false;
}

function github_validate_media_filename(string $filename): ?string
{
    $filename = strtolower(trim(basename(str_replace('\\', '/', $filename))));
    $filename = preg_replace('/\s+/', '-', $filename) ?? '';
    $filename = preg_replace('/[^a-z0-9._-]/', '', $filename) ?? '';
    $filename = trim($filename, '.-');

    if ($filename === '' || strlen($filename) > 100 || str_contains($filename, '..')) {
        return null;
    }

    $extension = strtolower((string) pathinfo($filename, PATHINFO_EXTENSION));
    if (!in_array($extension, GITHUB_MEDIA_ALLOWED_EXTENSIONS, true)) {
        return null;
    }

    return $filename;
}

function github_fetch_remote_media(string $url): array
{
    $url = trim($url);
    if ($url === '' || !filter_var($url, FILTER_VALIDATE_URL)) {
        throw new RuntimeException('A valid remote media link is required.');
    }

    $parts = parse_url($url);
    $scheme = strtolower((string) ($parts['scheme'] ?? ''));
    if (!in_array($scheme, ['http', 'https'], true)) {
        throw new RuntimeException('Only http(s) remote media links are supported.');
    }

    $host = strtolower((string) ($parts['host'] ?? ''));
    if ($host === '' || !($host === 'geni.com' || str_ends_with($host, '.geni.com'))) {
        throw new RuntimeException('Only Geni media links can be uploaded remotely.');
    }

    if (!function_exists('curl_init')) {
        throw new RuntimeException('PHP cURL is required to fetch remote media links.');
    }

    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('Failed to initialize the remote media download.');
    }

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 45,
        CURLOPT_USERAGENT => 'Genepedia-Media-Importer',
        CURLOPT_HTTPHEADER => [
            'Accept: image/*,application/pdf;q=0.9,*/*;q=0.1',
        ],
    ]);

    $body = curl_exec($ch);
    if ($body === false) {
        $message = curl_error($ch) ?: 'Unknown cURL error.';
        curl_close($ch);
        throw new RuntimeException('Could not download the remote media file: ' . $message);
    }

    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $contentType = strtolower(trim((string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE)));
    $effectiveUrl = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    curl_close($ch);

    if ($status < 200 || $status >= 300) {
        throw new RuntimeException('Could not download the remote media file (HTTP ' . $status . ').');
    }

    if ($contentType !== ''
        && !preg_match('#^(image/|application/pdf(?:;|$)|application/octet-stream(?:;|$))#i', $contentType)) {
        throw new RuntimeException('Remote URL did not return an image or PDF file.');
    }

    if (!is_string($body) || $body === '') {
        throw new RuntimeException('The remote media file was empty.');
    }

    if (strlen($body) > GITHUB_MEDIA_MAX_BYTES) {
        throw new RuntimeException('Media files must be smaller than ' . round(GITHUB_MEDIA_MAX_BYTES / 1_000_000) . ' MB.');
    }

    return [
        'content' => $body,
        'content_type' => $contentType,
        'url' => $effectiveUrl !== '' ? $effectiveUrl : $url,
    ];
}

function github_list_person_media(string $owner, string $repo, string $personId): array
{
    try {
        $base = github_get_repository_default_branch($owner, $repo, github_api_token());
    } catch (RuntimeException $error) {
        if (github_is_empty_repository_error($error)) {
            return [];
        }
        throw $error;
    }

    $url = sprintf(
        'https://api.github.com/repos/%s/%s/contents/%s?ref=%s',
        rawurlencode($owner),
        rawurlencode($repo),
        github_encode_repo_path(github_person_media_directory($personId)),
        rawurlencode($base['branch']),
    );

    $response = github_rest_get($url);
    if ($response['status'] === 404) {
        return [];
    }

    if ($response['status'] >= 400) {
        throw new RuntimeException(github_format_rest_error($response, 'Media listing'));
    }

    $entries = is_array($response['data']) ? $response['data'] : [];
    $images = [];

    foreach ($entries as $entry) {
        if (!is_array($entry) || (string) ($entry['type'] ?? '') !== 'file') {
            continue;
        }

        $name = (string) ($entry['name'] ?? '');
        $extension = strtolower((string) pathinfo($name, PATHINFO_EXTENSION));
        if (!in_array($extension, GITHUB_MEDIA_ALLOWED_EXTENSIONS, true)) {
            continue;
        }

        $images[] = [
            'name' => $name,
            'path' => (string) ($entry['path'] ?? ''),
            'size' => (int) ($entry['size'] ?? 0),
            'sha' => (string) ($entry['sha'] ?? ''),
            'download_url' => (string) ($entry['download_url'] ?? ''),
        ];
    }

    usort($images, static fn (array $a, array $b): int => strcmp($a['name'], $b['name']));

    return $images;
}

function github_encode_ref_for_raw(string $value): string
{
    return implode('/', array_map('rawurlencode', explode('/', $value)));
}

/**
 * Open media pull requests (uploads/removals awaiting review) for a person.
 * Each entry carries enough to preview the proposed image from the PR branch.
 */
function github_person_media_pending(string $owner, string $repo, string $personId): array
{
    $imagesDir = github_person_media_directory($personId);
    $pullRequests = github_fetch_open_pull_requests($owner, $repo, true, [$imagesDir]);
    $entries = [];

    foreach ($pullRequests as $pullRequest) {
        $ref = (string) ($pullRequest['head']['ref'] ?? '');
        if (!str_starts_with($ref, 'media/')) {
            continue;
        }

        $path = (string) ($pullRequest['page_path'] ?? '');
        if ($path === '' || !str_starts_with($path, $imagesDir . '/')) {
            continue;
        }

        $action = str_starts_with($ref, 'media/delete-') ? 'delete' : 'upload';
        $imageUrl = sprintf(
            'https://raw.githubusercontent.com/%s/%s/%s/%s',
            rawurlencode($owner),
            rawurlencode($repo),
            github_encode_ref_for_raw($ref),
            github_encode_ref_for_raw($path),
        );

        $entries[] = [
            'number' => (int) ($pullRequest['number'] ?? 0),
            'action' => $action,
            'filename' => basename($path),
            'path' => $path,
            'branch' => $ref,
            'image_url' => $action === 'upload' ? $imageUrl : '',
            'url' => (string) ($pullRequest['url'] ?? ''),
            'user' => $pullRequest['user'] ?? null,
            'created_at' => (string) ($pullRequest['created_at'] ?? ''),
            'updated_at' => (string) ($pullRequest['updated_at'] ?? ''),
        ];
    }

    return $entries;
}

/**
 * Confirms a pull request is a media PR that touches the given person, so a
 * profile maintainer may only approve/decline edits for their own profile.
 */
function github_pull_request_is_person_media(array $pullRequest, string $personId): bool
{
    $head = is_array($pullRequest['head'] ?? null) ? $pullRequest['head'] : [];
    $ref = (string) ($head['ref'] ?? '');
    if (!str_starts_with($ref, 'media/')) {
        return false;
    }

    $imagesDir = github_person_media_directory($personId);
    $bodyPath = github_extract_page_path_from_pull_request_body($pullRequest);
    if ($bodyPath !== '' && ($bodyPath === $imagesDir || str_starts_with($bodyPath, $imagesDir . '/'))) {
        return true;
    }

    return false;
}

function github_delete_file_on_branch(
    string $owner,
    string $repo,
    string $path,
    string $branchName,
    string $commitMessage,
    string $sha,
    string $token,
    ?array $commitIdentity = null,
): array {
    $payload = [
        'message' => $commitMessage,
        'sha' => $sha,
        'branch' => $branchName,
    ];

    if (is_array($commitIdentity)) {
        $payload['author'] = $commitIdentity;
        $payload['committer'] = $commitIdentity;
    }

    return github_rest_request_json(
        'DELETE',
        sprintf(
            'https://api.github.com/repos/%s/%s/contents/%s',
            rawurlencode($owner),
            rawurlencode($repo),
            github_encode_repo_path($path),
        ),
        $token,
        $payload,
        'Delete file',
    );
}

function github_commit_person_media_to_default_branch_with_token(
    string $token,
    string $owner,
    string $repo,
    string $action,
    string $path,
    ?string $binaryContent,
    array $editor,
    string $commitMessage,
): array {
    $user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
    $commitIdentity = github_editor_commit_identity($user);

    try {
        $base = github_get_repository_default_branch($owner, $repo, $token);
        $baseBranch = $base['branch'];
    } catch (RuntimeException $error) {
        if (!github_is_empty_repository_error($error)) {
            throw $error;
        }

        if ($action === 'delete') {
            throw new RuntimeException('The requested image could not be found in the repository.');
        }

        return github_create_initial_file_on_default_branch(
            $owner,
            $repo,
            $path,
            (string) $binaryContent,
            $commitMessage,
            $token,
            $commitIdentity,
        );
    }

    $existingFile = github_get_file_metadata_on_branch($owner, $repo, $path, $baseBranch, $token);
    $existingSha = is_array($existingFile) ? (string) ($existingFile['sha'] ?? '') : '';

    if ($action === 'delete') {
        if ($existingSha === '') {
            throw new RuntimeException('The requested image could not be found in the repository.');
        }

        $commit = github_delete_file_on_branch(
            $owner,
            $repo,
            $path,
            $baseBranch,
            $commitMessage,
            $existingSha,
            $token,
            $commitIdentity,
        );
    } else {
        $commit = github_upsert_file_on_branch(
            $owner,
            $repo,
            $path,
            $baseBranch,
            (string) $binaryContent,
            $commitMessage,
            $existingSha !== '' ? $existingSha : null,
            $token,
            $commitIdentity,
        );
    }

    return [
        'branch' => $baseBranch,
        'base_branch' => $baseBranch,
        'commit' => [
            'sha' => (string) ($commit['commit']['sha'] ?? ''),
            'message' => $commitMessage,
        ],
        'pull_request' => null,
    ];
}

function github_commit_person_media_to_default_branch(
    string $owner,
    string $repo,
    string $action,
    string $path,
    ?string $binaryContent,
    array $editor,
    string $commitMessage,
): array {
    $failures = [];
    foreach (github_publish_token_candidates($editor) as $candidate) {
        if (!github_token_can_publish($owner, $repo, $candidate['token'])) {
            $failures[] = $candidate['source'] . ' lacks write access';
            continue;
        }

        try {
            return github_commit_person_media_to_default_branch_with_token(
                $candidate['token'],
                $owner,
                $repo,
                $action,
                $path,
                $binaryContent,
                $editor,
                $commitMessage,
            );
        } catch (RuntimeException $error) {
            if (!github_is_publish_auth_failure($error)) {
                throw $error;
            }

            $failures[] = $candidate['source'] . ': ' . $error->getMessage();
        }
    }

    throw new RuntimeException(github_build_publish_token_help_message($failures));
}

function github_create_person_media_pull_request_with_token(
    string $token,
    string $owner,
    string $repo,
    string $action,
    string $path,
    ?string $binaryContent,
    array $editor,
    string $commitMessage,
    string $prTitle,
    string $prBody,
): array {
    $user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
    $login = github_sanitize_branch_segment((string) ($user['login'] ?? 'editor'));
    $commitIdentity = github_editor_commit_identity($user);

    $base = github_get_repository_default_branch($owner, $repo, $token);
    $baseBranch = $base['branch'];
    $baseSha = $base['sha'];

    $fileSlug = github_sanitize_branch_segment((string) pathinfo($path, PATHINFO_FILENAME));
    $branchName = sprintf('media/%s-%s-%s-%s', $action, $fileSlug, $login, gmdate('Ymd-His'));

    github_create_branch_from_sha($owner, $repo, $branchName, $baseSha, $token);

    $existingFile = github_get_file_metadata_on_branch($owner, $repo, $path, $branchName, $token);
    if ($existingFile === null) {
        $existingFile = github_get_file_metadata_on_branch($owner, $repo, $path, $baseBranch, $token);
    }
    $existingSha = is_array($existingFile) ? (string) ($existingFile['sha'] ?? '') : '';

    if ($action === 'delete') {
        if ($existingSha === '') {
            throw new RuntimeException('The requested image could not be found in the repository.');
        }

        $commit = github_delete_file_on_branch(
            $owner,
            $repo,
            $path,
            $branchName,
            $commitMessage,
            $existingSha,
            $token,
            $commitIdentity,
        );
    } else {
        $commit = github_upsert_file_on_branch(
            $owner,
            $repo,
            $path,
            $branchName,
            (string) $binaryContent,
            $commitMessage,
            $existingSha !== '' ? $existingSha : null,
            $token,
            $commitIdentity,
        );
    }

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

function github_create_person_media_pull_request(
    string $owner,
    string $repo,
    string $action,
    string $path,
    ?string $binaryContent,
    array $editor,
    string $commitMessage,
    string $prTitle,
    string $prBody,
): array {
    $failures = [];
    foreach (github_publish_token_candidates($editor) as $candidate) {
        if (!github_token_can_publish($owner, $repo, $candidate['token'])) {
            $failures[] = $candidate['source'] . ' lacks write access';
            continue;
        }

        try {
            return github_create_person_media_pull_request_with_token(
                $candidate['token'],
                $owner,
                $repo,
                $action,
                $path,
                $binaryContent,
                $editor,
                $commitMessage,
                $prTitle,
                $prBody,
            );
        } catch (RuntimeException $error) {
            if (!github_is_publish_auth_failure($error)) {
                throw $error;
            }

            $failures[] = $candidate['source'] . ': ' . $error->getMessage();
        }
    }

    throw new RuntimeException(github_build_publish_token_help_message($failures));
}

function github_person_talk_path(string $personId): string
{
    return 'people/' . $personId . '/data/talk.json';
}

function github_fetch_person_talk(string $owner, string $repo, string $personId): array
{
    $base = github_get_repository_default_branch($owner, $repo, github_api_token());
    $path = github_person_talk_path($personId);

    $metadata = github_get_file_metadata_on_branch($owner, $repo, $path, $base['branch'], github_api_token());
    if ($metadata === null) {
        return [
            'messages' => [],
            'sha' => '',
            'branch' => $base['branch'],
        ];
    }

    $content = github_decode_content_payload($metadata);
    $decoded = is_string($content) ? json_decode($content, true) : null;
    $messages = is_array($decoded['messages'] ?? null) ? $decoded['messages'] : [];

    return [
        'messages' => array_values(array_filter($messages, 'is_array')),
        'sha' => (string) ($metadata['sha'] ?? ''),
        'branch' => $base['branch'],
    ];
}

function github_normalize_talk_message(array $message): array
{
    return [
        'id' => (string) ($message['id'] ?? ''),
        'body' => (string) ($message['body'] ?? ''),
        'author_login' => (string) ($message['author_login'] ?? ''),
        'author_name' => (string) ($message['author_name'] ?? ''),
        'author_avatar' => (string) ($message['author_avatar'] ?? ''),
        'author_url' => (string) ($message['author_url'] ?? ''),
        'created_at' => (string) ($message['created_at'] ?? ''),
    ];
}

function github_save_person_talk(
    string $owner,
    string $repo,
    string $personId,
    array $messages,
    string $existingSha,
    array $editor,
    string $commitMessage,
): array {
    $path = github_person_talk_path($personId);
    $user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
    $commitIdentity = github_editor_commit_identity($user);
    $content = json_encode(
        ['messages' => array_values($messages)],
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE,
    );
    if (!is_string($content)) {
        throw new RuntimeException('Could not encode the talk page.');
    }
    $content .= "\n";

    $failures = [];
    foreach (github_publish_token_candidates($editor) as $candidate) {
        if (!github_token_can_publish($owner, $repo, $candidate['token'])) {
            $failures[] = $candidate['source'] . ' lacks write access';
            continue;
        }

        $base = github_get_repository_default_branch($owner, $repo, $candidate['token']);
        $sha = $existingSha;

        for ($attempt = 0; $attempt < 3; $attempt += 1) {
            try {
                $commit = github_upsert_file_on_branch(
                    $owner,
                    $repo,
                    $path,
                    $base['branch'],
                    $content,
                    $commitMessage,
                    $sha !== '' ? $sha : null,
                    $candidate['token'],
                    $commitIdentity,
                );

                return [
                    'branch' => $base['branch'],
                    'commit' => [
                        'sha' => (string) ($commit['commit']['sha'] ?? ''),
                        'message' => $commitMessage,
                    ],
                ];
            } catch (RuntimeException $error) {
                $message = $error->getMessage();
                $isConflict = str_contains($message, 'HTTP 409')
                    || str_contains($message, 'does not match')
                    || str_contains($message, 'expected');

                if ($isConflict && $attempt < 2) {
                    $metadata = github_get_file_metadata_on_branch(
                        $owner,
                        $repo,
                        $path,
                        $base['branch'],
                        $candidate['token'],
                    );
                    $sha = is_array($metadata) ? (string) ($metadata['sha'] ?? '') : '';
                    continue;
                }

                if (!github_is_publish_auth_failure($error)) {
                    throw $error;
                }

                $failures[] = $candidate['source'] . ': ' . $message;
                break;
            }
        }
    }

    throw new RuntimeException(github_build_publish_token_help_message($failures));
}

// ---------------------------------------------------------------------------
// Multi-file page edits (e.g. profile.html + profile-table.html in one PR)
// ---------------------------------------------------------------------------

function github_create_files_edit_pull_request_with_token(
    string $token,
    string $owner,
    string $repo,
    array $files,
    array $editor,
    string $commitMessage,
    string $prTitle,
    string $prBody,
): array {
    $user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
    $login = github_sanitize_branch_segment((string) ($user['login'] ?? 'editor'));
    $commitIdentity = github_editor_commit_identity($user);

    $base = github_get_repository_default_branch($owner, $repo, $token);
    $baseBranch = $base['branch'];
    $baseSha = $base['sha'];

    $primaryPath = (string) ($files[0]['path'] ?? 'page');
    $fileSlug = github_sanitize_branch_segment((string) pathinfo($primaryPath, PATHINFO_FILENAME));
    $branchName = sprintf('edit/%s-%s-%s', $fileSlug, $login, gmdate('Ymd-His'));

    github_create_branch_from_sha($owner, $repo, $branchName, $baseSha, $token);

    $commits = [];
    foreach ($files as $file) {
        $path = (string) $file['path'];
        $content = (string) $file['content'];

        $existingFile = github_get_file_metadata_on_branch($owner, $repo, $path, $branchName, $token);
        if ($existingFile === null) {
            $existingFile = github_get_file_metadata_on_branch($owner, $repo, $path, $baseBranch, $token);
        }
        $existingSha = is_array($existingFile) ? (string) ($existingFile['sha'] ?? '') : '';

        $commit = github_upsert_file_on_branch(
            $owner,
            $repo,
            $path,
            $branchName,
            $content,
            $commitMessage,
            $existingSha !== '' ? $existingSha : null,
            $token,
            $commitIdentity,
        );

        $commits[] = [
            'path' => $path,
            'sha' => (string) ($commit['commit']['sha'] ?? ''),
        ];
    }

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
            'sha' => (string) ($commits[count($commits) - 1]['sha'] ?? ''),
            'message' => $commitMessage,
        ],
        'commits' => $commits,
        'pull_request' => [
            'number' => (int) ($pullRequest['number'] ?? 0),
            'title' => (string) ($pullRequest['title'] ?? $prTitle),
            'url' => (string) ($pullRequest['html_url'] ?? ''),
            'state' => (string) ($pullRequest['state'] ?? 'open'),
        ],
    ];
}

function github_create_files_edit_pull_request(
    string $owner,
    string $repo,
    array $files,
    array $editor,
    string $commitMessage,
    string $prTitle,
    string $prBody,
): array {
    $totalBytes = 0;
    foreach ($files as $file) {
        $totalBytes += strlen((string) ($file['content'] ?? ''));
    }
    if ($totalBytes > 4_000_000) {
        throw new RuntimeException('The edited pages are too large to publish.');
    }

    $failures = [];
    foreach (github_publish_token_candidates($editor) as $candidate) {
        if (!github_token_can_publish($owner, $repo, $candidate['token'])) {
            $failures[] = $candidate['source'] . ' lacks write access';
            continue;
        }

        try {
            return github_create_files_edit_pull_request_with_token(
                $candidate['token'],
                $owner,
                $repo,
                $files,
                $editor,
                $commitMessage,
                $prTitle,
                $prBody,
            );
        } catch (RuntimeException $error) {
            if (!github_is_publish_auth_failure($error)) {
                throw $error;
            }

            $failures[] = $candidate['source'] . ': ' . $error->getMessage();
        }
    }

    throw new RuntimeException(github_build_publish_token_help_message($failures));
}

function github_group_workspace_files_by_repository(array $files): array
{
    $groups = [];

    foreach ($files as $file) {
        if (!is_array($file)) {
            continue;
        }

        $context = github_repository_context_for_workspace_path((string) ($file['path'] ?? ''));
        $groupKey = $context['repo_slug'];
        if (!isset($groups[$groupKey])) {
            $groups[$groupKey] = [
                'kind' => $context['kind'],
                'owner' => $context['owner'],
                'repo' => $context['repo'],
                'repo_slug' => $context['repo_slug'],
                'files' => [],
            ];
        }

        $groups[$groupKey]['files'][] = [
            'workspace_path' => $context['workspace_path'],
            'repo_path' => $context['repo_path'],
            'content' => (string) ($file['content'] ?? ''),
        ];
    }

    return array_values($groups);
}

function github_select_primary_publish_result(array $results): array
{
    foreach ($results as $result) {
        if (!($result['published_directly'] ?? false) && ($result['kind'] ?? '') === 'site') {
            return $result;
        }
    }
    foreach ($results as $result) {
        if (!($result['published_directly'] ?? false)) {
            return $result;
        }
    }
    foreach ($results as $result) {
        if (($result['kind'] ?? '') === 'site') {
            return $result;
        }
    }

    return $results[0] ?? [];
}

function github_publish_workspace_files(
    array $files,
    array $editor,
    string $commitMessage,
    string $prTitle = '',
    string $prBody = '',
): array {
    $grouped = github_group_workspace_files_by_repository($files);
    if ($grouped === []) {
        throw new RuntimeException('At least one file is required.');
    }

    $user = is_array($editor['user'] ?? null) ? $editor['user'] : null;
    if ($prBody === '') {
        $workspacePaths = [];
        foreach ($grouped as $group) {
            foreach ($group['files'] as $file) {
                $workspacePaths[] = (string) ($file['workspace_path'] ?? '');
            }
        }
        $workspacePaths = array_values(array_unique(array_filter($workspacePaths, 'strlen')));
        $displayName = trim((string) ($user['displayName'] ?? $user['login'] ?? 'editor'));
        $login = trim((string) ($user['login'] ?? ''));
        $pathList = implode(', ', array_map(static fn (string $path): string => '`' . $path . '`', $workspacePaths));
        $prBody = implode("\n", [
            'This update changes ' . ($pathList !== '' ? $pathList : 'the requested files') . '.',
            '',
            'Edited by ' . $displayName . ($login !== '' ? ' (@' . $login . ')' : '') . '.',
        ]);
    }

    $results = [];
    foreach ($grouped as $group) {
        $workspacePaths = array_map(static fn (array $file): string => $file['workspace_path'], $group['files']);
        $repoFiles = array_map(static fn (array $file): array => [
            'path' => $file['repo_path'],
            'content' => $file['content'],
        ], $group['files']);

        $canPublishDirectly = github_user_can_direct_publish_paths(
            $group['owner'],
            $group['repo'],
            $workspacePaths,
            $user,
        );

        if ($canPublishDirectly) {
            $publish = github_commit_files_to_default_branch(
                $group['owner'],
                $group['repo'],
                $repoFiles,
                $editor,
                $commitMessage,
            );

            $results[] = [
                'kind' => $group['kind'],
                'repo' => $group['repo_slug'],
                'path' => $workspacePaths[0] ?? '',
                'paths' => $workspacePaths,
                'repo_paths' => array_column($group['files'], 'repo_path'),
                'branch' => $publish['branch'],
                'base_branch' => $publish['branch'],
                'commit' => $publish['commit'],
                'pull_request' => null,
                'published_directly' => true,
            ];
            continue;
        }

        $publish = github_create_files_edit_pull_request(
            $group['owner'],
            $group['repo'],
            $repoFiles,
            $editor,
            $commitMessage,
            $prTitle !== '' ? $prTitle : $commitMessage,
            $prBody,
        );

        $results[] = [
            'kind' => $group['kind'],
            'repo' => $group['repo_slug'],
            'path' => $workspacePaths[0] ?? '',
            'paths' => $workspacePaths,
            'repo_paths' => array_column($group['files'], 'repo_path'),
            'branch' => $publish['branch'],
            'base_branch' => $publish['base_branch'],
            'commit' => $publish['commit'],
            'pull_request' => $publish['pull_request'],
            'published_directly' => false,
        ];
    }

    $primary = github_select_primary_publish_result($results);
    $secondary = [];
    $primarySerialized = json_encode($primary);
    foreach ($results as $result) {
        if (json_encode($result) === $primarySerialized) {
            continue;
        }
        $secondary[] = $result;
    }

    $allPaths = [];
    foreach ($results as $result) {
        foreach ($result['paths'] as $path) {
            if (!in_array($path, $allPaths, true)) {
                $allPaths[] = $path;
            }
        }
    }

    return [
        'repo' => (string) ($primary['repo'] ?? ''),
        'path' => (string) ($primary['path'] ?? ''),
        'paths' => $allPaths,
        'branch' => (string) ($primary['branch'] ?? ''),
        'base_branch' => (string) ($primary['base_branch'] ?? ''),
        'commit' => $primary['commit'] ?? null,
        'pull_request' => $primary['pull_request'] ?? null,
        'published_directly' => !array_filter($results, static fn (array $result): bool => !($result['published_directly'] ?? false)),
        'results' => $results,
        'secondary_results' => $secondary,
    ];
}
