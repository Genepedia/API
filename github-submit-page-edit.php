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

$commitMessage = trim((string) ($payload['commit_message'] ?? ''));
$prTitle = trim((string) ($payload['pr_title'] ?? ''));
$prBody = trim((string) ($payload['pr_body'] ?? ''));

function github_submit_page_edit_validate_path(string $path): ?string
{
    $normalized = str_replace('\\', '/', trim($path));
    $normalized = ltrim($normalized, '/');

    if ($normalized === '' || str_contains($normalized, '..')) {
        return null;
    }

    if (preg_match('#^pages/[a-zA-Z0-9_./-]+\.html$#', $normalized)) {
        return $normalized;
    }

    if (preg_match('#^people/[a-zA-Z0-9_-]+/profile\.html$#', $normalized)) {
        return $normalized;
    }

    if (preg_match('#^people/[a-zA-Z0-9_-]+/data/[a-zA-Z0-9_.-]+\.html$#', $normalized)) {
        return $normalized;
    }

    if (preg_match('#^people/[a-zA-Z0-9_-]+/data/family-tree\.ged$#', $normalized)) {
        return $normalized;
    }

    return null;
}

// Normalise the request into a list of files. Clients send either the legacy
// single {path, content} pair or a files array for multi-file edits (for
// example a profile fragment together with its infobox include).
$rawFiles = [];
if (is_array($payload['files'] ?? null) && $payload['files'] !== []) {
    foreach ($payload['files'] as $entry) {
        if (is_array($entry)) {
            $rawFiles[] = [
                'path' => (string) ($entry['path'] ?? ''),
                'content' => (string) ($entry['content'] ?? ''),
            ];
        }
    }
} else {
    $rawFiles[] = [
        'path' => (string) ($payload['path'] ?? ''),
        'content' => (string) ($payload['content'] ?? ''),
    ];
}

if ($rawFiles === [] || count($rawFiles) > 5) {
    github_json([
        'ok' => false,
        'error' => 'invalid_files',
        'message' => 'Between one and five files can be published per edit.',
    ], 400);
}

$files = [];
foreach ($rawFiles as $entry) {
    $path = github_submit_page_edit_validate_path($entry['path']);
    $content = $entry['content'];

    $isPagePath = $path !== null && str_starts_with($path, 'pages/');
    $isPeoplePath = $path !== null
        && preg_match('#^people/[a-zA-Z0-9_-]+/(profile\.html|data/[a-zA-Z0-9_.-]+\.html|data/family-tree\.ged)$#', $path) === 1;
    $isGedcomPath = $path !== null && str_ends_with($path, '.ged');

    if ($path === null || (!$isPagePath && !$isPeoplePath)) {
        github_json([
            'ok' => false,
            'error' => 'invalid_path',
            'message' => 'A valid pages/*.html, people/<id>/(data/)*.html, or profile GEDCOM path is required.',
        ], 400);
    }

    if ($content === '') {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'Page content is required for ' . $path . '.',
        ], 400);
    }

    $looksLikeFullDocument = str_contains(strtolower($content), '<html')
        || str_contains(strtolower($content), '<!doctype');

    // Profile data files are HTML fragments; everything else must be a full document.
    $isFragmentPath = $isPeoplePath && str_contains($path, '/data/') && !$isGedcomPath;
    if (!$isFragmentPath && !$isGedcomPath && !$looksLikeFullDocument) {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'Published content must be a complete HTML document.',
        ], 400);
    }

    if ($isFragmentPath && !str_contains($content, '<')) {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'Published content must contain HTML.',
        ], 400);
    }

    if ($isGedcomPath && (!str_contains($content, '0 HEAD') || !str_contains($content, '0 TRLR'))) {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'family-tree.ged must be a GEDCOM document.',
        ], 400);
    }

    $files[] = ['path' => $path, 'content' => $content];
}

$path = $files[0]['path'];
$content = $files[0]['content'];

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

$allPaths = array_map(static fn (array $file): string => $file['path'], $files);

if ($prBody === '') {
    $pathList = implode(', ', array_map(static fn (string $p): string => '`' . $p . '`', $allPaths));
    $prBody = implode("\n", [
        'This update changes ' . $pathList . ' using the site page editor.',
        '',
        'Edited by ' . ($displayName !== '' ? $displayName : $login)
            . ($login !== '' ? ' (@' . $login . ')' : '') . '.',
    ]);
} else {
    // Make sure each path is referenced so pending-edit lookups can match it.
    foreach ($allPaths as $editedPath) {
        if (!str_contains($prBody, '`' . $editedPath . '`')) {
            $prBody .= "\n\nFile: `" . $editedPath . '`';
        }
    }
}

try {
    $canPublishDirectly = github_user_can_direct_publish_paths($owner, $repo, $allPaths, $user);

    if ($canPublishDirectly) {
        $result = github_commit_files_to_default_branch($owner, $repo, $files, $editor, $commitMessage);

        github_json([
            'ok' => true,
            'repo' => $repoSlug,
            'path' => $path,
            'paths' => $allPaths,
            'branch' => $result['branch'],
            'base_branch' => $result['branch'],
            'commit' => $result['commit'],
            'pull_request' => null,
            'published_directly' => true,
            'published_at' => gmdate('c'),
        ]);
    }

    if (count($files) > 1) {
        $result = github_create_files_edit_pull_request(
            $owner,
            $repo,
            $files,
            $editor,
            $commitMessage,
            $prTitle,
            $prBody,
        );
    } else {
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
    }

    github_json([
        'ok' => true,
        'repo' => $repoSlug,
        'path' => $path,
        'paths' => $allPaths,
        'branch' => $result['branch'],
        'base_branch' => $result['base_branch'],
        'commit' => $result['commit'],
        'pull_request' => $result['pull_request'],
        'published_directly' => false,
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
