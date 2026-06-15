<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_apply_cors();
github_start_session();

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method === 'OPTIONS') {
    exit;
}

if ($method !== 'POST') {
    github_json([
        'ok' => false,
        'error' => 'method_not_allowed',
        'message' => 'Only POST requests are supported.',
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

$number = (int) ($payload['number'] ?? 0);
$action = strtolower(trim((string) ($payload['action'] ?? '')));
$requestedRepoSlug = trim((string) ($payload['repo'] ?? ''));

if ($number <= 0) {
    github_json([
        'ok' => false,
        'error' => 'invalid_request',
        'message' => 'A valid pull request number is required.',
    ], 400);
}

if ($action !== 'merge' && $action !== 'decline') {
    github_json([
        'ok' => false,
        'error' => 'invalid_action',
        'message' => 'Action must be merge or decline.',
    ], 400);
}

try {
    $reviewer = github_require_pull_request_reviewer();
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'forbidden',
        'message' => $error->getMessage(),
    ], 403);
}

$siteRepoConfig = github_repo_config();
$siteOwner = $siteRepoConfig['owner'];
$siteRepo = $siteRepoConfig['repo'];
$siteRepoSlug = $siteOwner . '/' . $siteRepo;
$dbRepoConfig = github_people_db_repo_config();
$dbOwner = $dbRepoConfig['owner'];
$dbRepo = $dbRepoConfig['repo'];
$dbRepoSlug = $dbOwner . '/' . $dbRepo;

try {
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
                'message' => 'Unknown repository requested for pull request review.',
            ], 400);
        }
    } else {
        $candidates[] = ['owner' => $siteOwner, 'repo' => $siteRepo, 'slug' => $siteRepoSlug];
        if ($dbRepoSlug !== $siteRepoSlug) {
            $candidates[] = ['owner' => $dbOwner, 'repo' => $dbRepo, 'slug' => $dbRepoSlug];
        }
    }

    $result = null;
    $resolvedRepoSlug = '';
    $lastError = null;
    foreach ($candidates as $candidate) {
        try {
            $result = github_review_pull_request($candidate['owner'], $candidate['repo'], $number, $action, $reviewer);
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
    if (!is_array($result)) {
        throw $lastError ?: new RuntimeException('Pull request not found.');
    }

    github_json([
        'ok' => true,
        'repo' => $resolvedRepoSlug,
        'result' => $result,
        'reviewed_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_pull_request_review_failed',
        'message' => $error->getMessage(),
    ], 502);
}
