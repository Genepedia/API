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

$repoConfig = github_repo_config();
$owner = $repoConfig['owner'];
$repo = $repoConfig['repo'];
$repoSlug = $owner . '/' . $repo;

try {
    $result = github_review_pull_request($owner, $repo, $number, $action, $reviewer);

    github_json([
        'ok' => true,
        'repo' => $repoSlug,
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
