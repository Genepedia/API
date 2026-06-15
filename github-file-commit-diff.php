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
$hash = github_validate_commit_hash((string) ($_GET['hash'] ?? ''));

if ($paths === null || $hash === null) {
    github_json([
        'ok' => false,
        'error' => 'invalid_request',
        'message' => 'A valid repository file path (or paths) and commit hash are required.',
    ], 400);
}

github_ensure_file_api_authenticated();

$repoContext = github_repository_context_for_paths($paths);
if ($repoContext === null) {
    github_json([
        'ok' => false,
        'error' => 'invalid_request',
        'message' => 'Diff lookups can only target paths from a single repository at a time.',
    ], 400);
}

$owner = $repoContext['owner'];
$repo = $repoContext['repo'];
$repoSlug = $repoContext['repo_slug'];
$repoPaths = $repoContext['repo_paths'];
$workspacePaths = $repoContext['workspace_paths'];

try {
    if (count($repoPaths) === 1) {
        $diff = github_fetch_file_commit_diff($owner, $repo, $repoPaths[0], $hash);

        github_json([
            'ok' => true,
            'repo' => $repoSlug,
            'path' => $workspacePaths[0],
            'paths' => $workspacePaths,
            'repo_paths' => $repoPaths,
            'diff' => $diff,
            'fetched_at' => gmdate('c'),
        ]);
    }

    $diffs = github_fetch_file_commit_diffs($owner, $repo, $repoPaths, $hash);

    github_json([
        'ok' => true,
        'repo' => $repoSlug,
        'paths' => $workspacePaths,
        'repo_paths' => $repoPaths,
        'diffs' => $diffs,
        'fetched_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_fetch_failed',
        'message' => $error->getMessage(),
    ], 502);
}
