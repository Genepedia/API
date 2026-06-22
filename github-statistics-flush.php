<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_apply_cors();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method === 'OPTIONS') {
    exit;
}

if ($method !== 'GET' && $method !== 'POST') {
    github_json([
        'ok' => false,
        'error' => 'method_not_allowed',
        'message' => 'Only GET and POST requests are supported.',
    ], 405);
}

// This endpoint is meant to be called by an hourly cron/scheduled task so the
// final batch of buffered Page/Search counts is pushed even when traffic stops.
// It is authorised with a shared secret so it cannot be abused to defeat the
// hourly batching by forcing extra commits.
$configuredToken = trim(github_env_value('GITHUB_STATISTICS_FLUSH_TOKEN'));
if ($configuredToken === '') {
    github_json([
        'ok' => false,
        'error' => 'flush_token_not_configured',
        'message' => 'Set GITHUB_STATISTICS_FLUSH_TOKEN in the API environment to enable scheduled flushes.',
    ], 403);
}

$providedToken = trim((string) ($_SERVER['HTTP_X_STATISTICS_FLUSH_TOKEN'] ?? ''));
if ($providedToken === '' && isset($_GET['token'])) {
    $providedToken = trim((string) $_GET['token']);
}
if ($providedToken === '' && isset($_POST['token'])) {
    $providedToken = trim((string) $_POST['token']);
}

if ($providedToken === '' || !hash_equals($configuredToken, $providedToken)) {
    github_json([
        'ok' => false,
        'error' => 'unauthorized',
        'message' => 'A valid flush token is required.',
    ], 403);
}

try {
    $result = github_statistics_force_flush();
    github_json([
        'ok' => true,
        'flush' => $result,
        'storage_root' => github_statistics_workspace_relative_path(),
        'fetched_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'statistics_flush_failed',
        'message' => $error->getMessage(),
    ], 500);
}
