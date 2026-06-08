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

$path = github_validate_repo_file_path((string) ($_GET['path'] ?? ''));
$hash = github_validate_commit_hash((string) ($_GET['hash'] ?? ''));

if ($path === null || $hash === null) {
    github_json([
        'ok' => false,
        'error' => 'invalid_request',
        'message' => 'A valid repository file path and commit hash are required.',
    ], 400);
}

$repoConfig = github_repo_config();
$owner = $repoConfig['owner'];
$repo = $repoConfig['repo'];
$repoSlug = $owner . '/' . $repo;

try {
    $diff = github_fetch_file_commit_diff($owner, $repo, $path, $hash);

    github_json([
        'ok' => true,
        'repo' => $repoSlug,
        'diff' => $diff,
        'fetched_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_fetch_failed',
        'message' => $error->getMessage(),
    ], 502);
}
