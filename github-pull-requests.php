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

$siteRepoConfig = github_repo_config();
$siteOwner = $siteRepoConfig['owner'];
$siteRepo = $siteRepoConfig['repo'];
$siteRepoSlug = $siteOwner . '/' . $siteRepo;
$dbRepoConfig = github_people_db_repo_config();
$dbOwner = $dbRepoConfig['owner'];
$dbRepo = $dbRepoConfig['repo'];
$dbRepoSlug = $dbOwner . '/' . $dbRepo;
$user = github_current_user();
$number = isset($_GET['number']) ? (int) $_GET['number'] : 0;
$requestedRepoSlug = trim((string) ($_GET['repo'] ?? ''));

try {
    if ($number > 0) {
        $candidates = [];
        if ($requestedRepoSlug !== '') {
            if (strcasecmp($requestedRepoSlug, $siteRepoSlug) === 0) {
                $candidates[] = ['owner' => $siteOwner, 'repo' => $siteRepo, 'slug' => $siteRepoSlug];
            } elseif (strcasecmp($requestedRepoSlug, $dbRepoSlug) === 0) {
                $candidates[] = ['owner' => $dbOwner, 'repo' => $dbRepo, 'slug' => $dbRepoSlug];
            } else {
                github_json([
                    'ok' => false,
                    'error' => 'invalid_repo',
                    'message' => 'Unknown repository requested for pull request lookup.',
                ], 400);
            }
        } else {
            $candidates[] = ['owner' => $siteOwner, 'repo' => $siteRepo, 'slug' => $siteRepoSlug];
            if ($dbRepoSlug !== $siteRepoSlug) {
                $candidates[] = ['owner' => $dbOwner, 'repo' => $dbRepo, 'slug' => $dbRepoSlug];
            }
        }

        $detail = null;
        $resolvedRepoSlug = '';
        $lastError = null;
        foreach ($candidates as $candidate) {
            try {
                $detail = github_fetch_pull_request_detail($candidate['owner'], $candidate['repo'], $number);
                $resolvedRepoSlug = $candidate['slug'];
                break;
            } catch (Throwable $error) {
                $lastError = $error;
                if (stripos($error->getMessage(), 'not found') !== false) {
                    continue;
                }
                throw $error;
            }
        }
        if (!is_array($detail)) {
            throw $lastError ?: new RuntimeException('Pull request not found.');
        }

        if (is_array($detail['pull_request'] ?? null)) {
            $detail['pull_request']['repo'] = $resolvedRepoSlug;
        }

        github_json([
            'ok' => true,
            'repo' => $resolvedRepoSlug,
            'can_review' => github_user_can_review_pull_requests($user),
            'review_login' => github_review_login(),
            'pull_request' => $detail['pull_request'],
            'diffs' => $detail['diffs'],
            'fetched_at' => gmdate('c'),
        ]);
    }

    $paths = github_parse_repo_history_paths_request() ?? [];
    $repoContext = $paths !== [] ? github_repository_context_for_paths($paths) : [
        'owner' => $siteOwner,
        'repo' => $siteRepo,
        'repo_slug' => $siteRepoSlug,
        'repo_paths' => $paths,
        'workspace_paths' => $paths,
    ];
    if ($repoContext === null) {
        github_json([
            'ok' => false,
            'error' => 'invalid_path',
            'message' => 'Pending edits can only be queried for paths from a single repository at a time.',
        ], 400);
    }

    $pullRequests = github_fetch_open_pull_requests($repoContext['owner'], $repoContext['repo'], true, $repoContext['repo_paths']);
    $pullRequests = array_map(static function (array $pullRequest) use ($repoContext): array {
        $pullRequest['repo'] = $repoContext['repo_slug'];
        return $pullRequest;
    }, $pullRequests);

    github_json([
        'ok' => true,
        'repo' => $repoContext['repo_slug'],
        'paths' => $repoContext['workspace_paths'],
        'repo_paths' => $repoContext['repo_paths'],
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
