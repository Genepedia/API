<?php

declare(strict_types=1);

/**
 * Username/password login endpoint for the standalone /pages/login.html page.
 *
 * This validates credentials against `.env` (LOCAL_LOGIN_USERNAME plus
 * LOCAL_LOGIN_PASSWORD or LOCAL_LOGIN_PASSWORD_HASH) and, on success, issues the
 * same one-time login "handoff" code that GitHub login uses. The front-end then
 * redeems that code at github-handoff.php, so the signed-in session is
 * established through the exact same path as a GitHub sign-in.
 *
 * The public header "Log In" button is unaffected and still uses GitHub only.
 */

require __DIR__ . '/github-auth.php';

// github_start_session() applies CORS (and short-circuits OPTIONS preflight)
// before starting the PHP session.
github_start_session();

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method === 'OPTIONS') {
    exit;
}

if ($method !== 'POST') {
    github_json([
        'ok' => false,
        'error' => 'method_not_allowed',
        'message' => 'Only POST requests are supported.',
    ], 405);
}

/**
 * Build a synthetic user record that mirrors the shape returned by
 * github_fetch_user() so the rest of the app can treat it identically.
 */
function local_login_build_user(string $username, string $displayName): array
{
    $displayName = trim($displayName) !== '' ? trim($displayName) : $username;

    $givenName = '';
    $familyName = '';
    $parts = preg_split('/\s+/', $displayName) ?: [];
    if (count($parts) === 1) {
        $givenName = $parts[0];
    } elseif (count($parts) > 1) {
        $givenName = (string) array_shift($parts);
        $familyName = implode(' ', $parts);
    }

    return [
        'id' => 'local:' . $username,
        'login' => $username,
        'displayName' => $displayName,
        'givenName' => $givenName,
        'familyName' => $familyName,
        'photoUrl' => '',
        'profileUrl' => '',
        'email' => '',
    ];
}

/**
 * Validate the submitted credentials against `.env`.
 *
 * Returns the synthetic user record on success, or null on any failure or when
 * the local login is not configured. Comparisons are constant-time and the
 * outcome never reveals whether the username, the password, or the whole
 * feature was the reason for failure.
 */
function local_login_verify(string $username, string $password): ?array
{
    $expectedUsername = github_env_value('LOCAL_LOGIN_USERNAME');
    $passwordHash = github_env_value('LOCAL_LOGIN_PASSWORD_HASH');
    $plainPassword = github_env_value('LOCAL_LOGIN_PASSWORD');

    // Feature is opt-in: a username and at least one password form must be set.
    if ($expectedUsername === '' || ($passwordHash === '' && $plainPassword === '')) {
        return null;
    }

    $usernameMatches = hash_equals($expectedUsername, $username);

    if ($passwordHash !== '') {
        $passwordMatches = password_verify($password, $passwordHash);
    } else {
        $passwordMatches = hash_equals($plainPassword, $password);
    }

    if (!$usernameMatches || !$passwordMatches) {
        return null;
    }

    return local_login_build_user($expectedUsername, github_env_value('LOCAL_LOGIN_DISPLAY_NAME'));
}

$rawBody = file_get_contents('php://input');
$payload = json_decode(is_string($rawBody) ? $rawBody : '', true);
if (!is_array($payload)) {
    // Fall back to form-encoded submissions.
    $payload = $_POST;
}

$username = trim((string) ($payload['username'] ?? ''));
$password = (string) ($payload['password'] ?? '');

$user = local_login_verify($username, $password);
if ($user === null) {
    // Constant-ish response time to slow brute-force attempts.
    usleep(400000);
    github_json([
        'ok' => false,
        'authenticated' => false,
        'error' => 'invalid_credentials',
        'message' => 'Invalid username or password.',
    ], 401);
}

// Establish a server session (works when third-party cookies are allowed) and a
// one-time handoff code (the robust path the front-end already uses after
// GitHub login). The local user is not backed by a real GitHub token, so it can
// browse signed-in but cannot publish edits to GitHub.
$token = 'local-login-session';

session_regenerate_id(true);
$_SESSION[GITHUB_SESSION_USER_KEY] = $user;
$_SESSION[GITHUB_SESSION_TOKEN_KEY] = $token;

$handoffCode = github_create_login_handoff($user, $token);

github_json([
    'ok' => true,
    'authenticated' => true,
    'handoff' => $handoffCode,
]);
