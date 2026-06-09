<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_start_session();

$returnTo = github_normalize_return_to($_SESSION[GITHUB_SESSION_RETURN_TO_KEY] ?? null);
$state = (string) ($_GET['state'] ?? '');
$expectedState = (string) ($_SESSION[GITHUB_SESSION_STATE_KEY] ?? '');
$code = trim((string) ($_GET['code'] ?? ''));

if ($state === '' || $expectedState === '' || !hash_equals($expectedState, $state)) {
    github_clear_session();
    github_redirect($returnTo . (str_contains($returnTo, '?') ? '&' : '?') . 'github_auth_error=state_mismatch');
}

if ($code === '') {
    github_clear_session();
    github_redirect($returnTo . (str_contains($returnTo, '?') ? '&' : '?') . 'github_auth_error=missing_code');
}

try {
    $token = github_exchange_code($code);
} catch (Throwable $exception) {
    error_log('GitHub OAuth token exchange failed: ' . $exception->getMessage());
    github_clear_session();
    github_redirect($returnTo . (str_contains($returnTo, '?') ? '&' : '?') . 'github_auth_error=token_exchange');
}

try {
    $user = github_fetch_user($token);
    github_apply_welcome_login_actions($token);

    session_regenerate_id(true);
    $_SESSION[GITHUB_SESSION_TOKEN_KEY] = $token;
    $_SESSION[GITHUB_SESSION_USER_KEY] = $user;
    unset($_SESSION[GITHUB_SESSION_STATE_KEY], $_SESSION[GITHUB_SESSION_RETURN_TO_KEY]);

    $handoffCode = github_create_login_handoff($user, $token);
    $separator = str_contains($returnTo, '?') ? '&' : '?';
    github_redirect($returnTo . $separator . 'github_handoff=' . rawurlencode($handoffCode));
} catch (Throwable $exception) {
    error_log('GitHub OAuth user profile fetch failed: ' . $exception->getMessage());
    github_clear_session();
    github_redirect($returnTo . (str_contains($returnTo, '?') ? '&' : '?') . 'github_auth_error=user_profile');
}
