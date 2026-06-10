<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_apply_cors();
github_start_session();

if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
    github_json([
        'ok' => false,
        'error' => 'method_not_allowed',
        'message' => 'Only GET requests are supported.',
    ], 405);
}

github_ensure_file_api_authenticated();

$repoConfig = github_repo_config();
$owner = $repoConfig['owner'];
$repo = $repoConfig['repo'];
$repoSlug = $owner . '/' . $repo;
$user = github_current_user();
$number = isset($_GET['number']) ? (int) $_GET['number'] : 0;

try {
    if ($number > 0) {
        $detail = github_fetch_pull_request_detail($owner, $repo, $number);

        github_json([
            'ok' => true,
            'repo' => $repoSlug,
            'can_review' => github_user_can_review_pull_requests($user),
            'review_login' => github_review_login(),
            'pull_request' => $detail['pull_request'],
            'diffs' => $detail['diffs'],
            'fetched_at' => gmdate('c'),
        ]);
    }

    $paths = github_parse_repo_history_paths_request() ?? [];
    $pullRequests = github_fetch_open_pull_requests($owner, $repo, true, $paths);

    github_json([
        'ok' => true,
        'repo' => $repoSlug,
        'paths' => $paths,
        'can_review' => github_user_can_review_pull_requests($user),
        'review_login' => github_review_login(),
        'pull_requests' => $pullRequests,
        'count' => count($pullRequests),
        'fetched_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_pull_request_fetch_failed',
        'message' => $error->getMessage(),
    ], 502);
}
