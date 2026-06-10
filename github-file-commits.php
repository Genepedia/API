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

$paths = github_parse_repo_history_paths_request();
if ($paths === null) {
    github_json([
        'ok' => false,
        'error' => 'invalid_path',
        'message' => 'A valid repository file path or comma-separated paths query is required.',
    ], 400);
}

github_ensure_file_api_authenticated();

$repoConfig = github_repo_config();
$owner = $repoConfig['owner'];
$repo = $repoConfig['repo'];
$repoSlug = $owner . '/' . $repo;

$limit = null;
if (isset($_GET['limit'])) {
    $limit = max(1, min(100, (int) $_GET['limit']));
}

try {
    $commits = github_fetch_merged_file_commits($owner, $repo, $paths, $limit);

    github_json([
        'ok' => true,
        'path' => $paths[0],
        'paths' => $paths,
        'repo' => $repoSlug,
        'commits' => $commits,
        'count' => count($commits),
        'fetched_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_fetch_failed',
        'message' => $error->getMessage(),
    ], 502);
}
