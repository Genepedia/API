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

$path = github_validate_repo_file_path((string) ($payload['path'] ?? ''));
$content = (string) ($payload['content'] ?? '');
$commitMessage = trim((string) ($payload['commit_message'] ?? ''));
$prTitle = trim((string) ($payload['pr_title'] ?? ''));
$prBody = trim((string) ($payload['pr_body'] ?? ''));

if ($path === null || !str_starts_with($path, 'pages/')) {
    github_json([
        'ok' => false,
        'error' => 'invalid_path',
        'message' => 'A valid pages/*.html repository path is required.',
    ], 400);
}

if ($content === '') {
    github_json([
        'ok' => false,
        'error' => 'invalid_content',
        'message' => 'Page content is required.',
    ], 400);
}

if (!str_contains(strtolower($content), '<html') && !str_contains(strtolower($content), '<!doctype')) {
    github_json([
        'ok' => false,
        'error' => 'invalid_content',
        'message' => 'Published content must be a complete HTML document.',
    ], 400);
}

try {
    $editor = github_require_authenticated_editor();
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'authentication_required',
        'message' => $error->getMessage(),
    ], 401);
}

$repoConfig = github_repo_config();
$owner = $repoConfig['owner'];
$repo = $repoConfig['repo'];
$repoSlug = $owner . '/' . $repo;
$user = $editor['user'];
$login = trim((string) ($user['login'] ?? 'editor'));
$displayName = trim((string) ($user['displayName'] ?? $login));

if ($commitMessage === '') {
    $pageLabel = str_replace('_', ' ', (string) pathinfo($path, PATHINFO_FILENAME));
    $commitMessage = 'Update ' . $pageLabel;
}

if ($prTitle === '') {
    $prTitle = $commitMessage;
}

if ($prBody === '') {
    $prBody = implode("\n", [
        'This pull request updates `' . $path . '` using the site page editor.',
        '',
        'Edited by ' . ($displayName !== '' ? $displayName : $login)
            . ($login !== '' ? ' (@' . $login . ')' : '') . '.',
    ]);
}

try {
    $result = github_create_page_edit_pull_request(
        $owner,
        $repo,
        $path,
        $content,
        $editor,
        $commitMessage,
        $prTitle,
        $prBody,
    );

    github_json([
        'ok' => true,
        'repo' => $repoSlug,
        'path' => $path,
        'branch' => $result['branch'],
        'base_branch' => $result['base_branch'],
        'commit' => $result['commit'],
        'pull_request' => $result['pull_request'],
        'published_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    $message = $error->getMessage();
    $status = 502;
    if (str_contains($message, 'GITHUB_API_TOKEN cannot publish')
        || str_contains($message, 'missing repository write permissions')
        || str_contains($message, 'needs write access')) {
        $status = 503;
    }

    github_json([
        'ok' => false,
        'error' => 'github_publish_failed',
        'message' => $message,
    ], $status);
}
