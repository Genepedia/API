<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_apply_cors();

if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
    github_json([
        'ok' => false,
        'error' => 'method_not_allowed',
        'message' => 'Only GET requests are supported.',
    ], 405);
}

$repoConfig = github_repo_config();
$apiAuth = github_api_auth_status();
$publishAuth = github_publish_auth_status();
$oauthConfig = github_config();
$clientId = $oauthConfig['client_id'];
$oauthConfigured = $clientId !== '' && $oauthConfig['client_secret'] !== '';

github_json([
    'ok' => true,
    'oauth_configured' => $oauthConfigured,
    'oauth' => [
        'uses_github_app_flow' => github_oauth_uses_github_app(),
        'callback_url' => github_callback_url(),
        'client_id_set' => $clientId !== '',
        'client_id_is_github_app_format' => str_starts_with($clientId, 'Iv1.'),
        'client_id_preview' => $clientId !== '' ? substr($clientId, 0, 8) . '...' : null,
    ],
    'github_app' => github_app_setup_status(),
    'api_auth' => $apiAuth,
    'publish_auth' => $publishAuth,
    'repo' => $repoConfig['owner'] . '/' . $repoConfig['repo'],
    'setup' => [
        'recommended' => 'Configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH, install the app on the repository, and upload the .pem key to the server.',
        'app_url' => 'https://github.com/settings/apps',
        'alternative' => 'Or set GITHUB_API_TOKEN and GITHUB_PUBLISH_TOKEN personal access tokens in .env.',
        'token_url' => 'https://github.com/settings/tokens',
    ],
]);
