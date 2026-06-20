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

if ($method === 'GET') {
    $limit = max(1, min(24, (int) ($_GET['limit'] ?? 4)));

    try {
        github_json([
            'ok' => true,
            'profiles' => github_popular_profiles($limit),
            'storage_path' => github_statistics_workspace_relative_path('profile-views.json'),
            'fetched_at' => gmdate('c'),
        ]);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'profile_views_read_failed',
            'message' => $error->getMessage(),
        ], 500);
    }
}

if ($method !== 'POST') {
    github_json([
        'ok' => false,
        'error' => 'method_not_allowed',
        'message' => 'Only GET and POST requests are supported.',
    ], 405);
}

$rawBody = file_get_contents('php://input');
$payload = json_decode(is_string($rawBody) ? $rawBody : '', true);
if (!is_array($payload)) {
    github_json([
        'ok' => false,
        'error' => 'invalid_json',
        'message' => 'Request body must be valid JSON.',
    ], 400);
}

try {
    $result = github_handle_statistics_event([
        'event' => 'profile_view',
        ...$payload,
    ]);
    github_json([
        'ok' => true,
        'profile' => $result['profile'] ?? null,
        'storage_path' => github_statistics_workspace_relative_path('profile-views.json'),
    ]);
} catch (InvalidArgumentException $error) {
    github_json([
        'ok' => false,
        'error' => 'invalid_person',
        'message' => $error->getMessage(),
    ], 400);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'profile_view_increment_failed',
        'message' => $error->getMessage(),
    ], 500);
}
