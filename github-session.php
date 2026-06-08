<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_start_session();

$config = github_config();
$user = github_current_user();

$apiAuth = github_api_auth_status();

github_json([
    'authenticated' => $user !== null,
    'configured' => $config['client_id'] !== '' && $config['client_secret'] !== '',
    'api_token_configured' => $apiAuth['configured'],
    'api_auth' => $apiAuth,
    'user' => $user,
]);