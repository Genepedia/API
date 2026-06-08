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

github_json([
    'ok' => true,
    'oauth_configured' => github_config()['client_id'] !== '' && github_config()['client_secret'] !== '',
    'api_auth' => $apiAuth,
    'repo' => $repoConfig['owner'] . '/' . $repoConfig['repo'],
    'setup' => [
        'recommended' => 'Add GITHUB_API_TOKEN to the API server .env file.',
        'token_url' => 'https://github.com/settings/tokens',
        'alternative' => 'Or configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY for GitHub App authentication.',
    ],
]);
