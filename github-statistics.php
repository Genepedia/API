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
    $metric = strtolower(trim((string) ($_GET['metric'] ?? 'popular_profiles')));
    $limit = max(1, min(24, (int) ($_GET['limit'] ?? 4)));

    try {
        if ($metric === 'summary' || $metric === 'all') {
            $summary = github_read_statistics_summary();
            github_json([
                'ok' => true,
                'metric' => $metric,
                'summary' => $summary,
                'storage_root' => github_statistics_workspace_relative_path(),
                'fetched_at' => gmdate('c'),
            ]);
        }

        if ($metric === 'popular_searches' || $metric === 'searches') {
            github_json([
                'ok' => true,
                'metric' => 'popular_searches',
                'searches' => github_popular_searches($limit),
                'storage_root' => github_statistics_workspace_relative_path(),
                'fetched_at' => gmdate('c'),
            ]);
        }

        if ($metric === 'manifest') {
            $manifest = github_statistics_read_json('manifest.json', static function (): array {
                github_statistics_refresh_derived_files();
                return github_statistics_read_json('manifest.json', static fn (): array => [
                    'schema' => 'genepedia/statistics/manifest@1',
                    'updatedAt' => github_statistics_now(),
                    'files' => [],
                ]);
            });
            github_json([
                'ok' => true,
                'metric' => 'manifest',
                'manifest' => $manifest,
                'fetched_at' => gmdate('c'),
            ]);
        }

        github_json([
            'ok' => true,
            'metric' => 'popular_profiles',
            'profiles' => github_popular_profiles($limit),
            'storage_root' => github_statistics_workspace_relative_path(),
            'fetched_at' => gmdate('c'),
        ]);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'statistics_read_failed',
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
    $result = github_handle_statistics_event($payload);
    github_json([
        'ok' => true,
        ...$result,
        'storage_root' => github_statistics_workspace_relative_path(),
    ]);
} catch (InvalidArgumentException $error) {
    github_json([
        'ok' => false,
        'error' => 'invalid_request',
        'message' => $error->getMessage(),
    ], 400);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'statistics_write_failed',
        'message' => $error->getMessage(),
    ], 500);
}
