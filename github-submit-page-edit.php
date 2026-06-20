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

    // Editable site pages.
    if (preg_match('#^pages/[a-zA-Z0-9_./-]+\.html$#', $normalized)) {
        return $normalized;
    }

    // Per-person SEO shell + editable narrative prose.
    if (preg_match('#^people/[a-zA-Z0-9_-]+/index\.html$#', $normalized)) {
        return $normalized;
    }
    if (preg_match('#^people/[a-zA-Z0-9_-]+/(?:profile|[a-zA-Z0-9_.-]+)\.html$#', $normalized)) {
        return $normalized;
    }

    // Canonical JSON database records and derived indexes.
    $dbPath = github_normalize_people_db_workspace_path($normalized);
    if (preg_match('#^data/Genepedia-Database/people/(persons|unions|ownership|graph)/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+\.json$#', $dbPath)) {
        return $dbPath;
    }
    if (preg_match('#^data/Genepedia-Database/people/index/(summary|search)/[a-zA-Z0-9_.-]+\.json$#', $dbPath)) {
        return $dbPath;
    }
    if (in_array($dbPath, [
        'data/Genepedia-Database/people/index/all-ids.json',
        'data/Genepedia-Database/people/index/ownership-logins.json',
        'data/Genepedia-Database/people/manifest.json',
        'data/Genepedia-Database/people/sources/gedcom-id-map.json',
    ], true)) {
        return $dbPath;
    }

    // Separate pets database (animals + their own families).
    if (preg_match('#^data/Genepedia-Database/pets/(persons|unions)/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+\.json$#', $normalized)) {
        return $normalized;
    }
    if (preg_match('#^data/Genepedia-Database/pets/index/(summary|search)/[a-zA-Z0-9_.-]+\.json$#', $normalized)
        || $normalized === 'data/Genepedia-Database/pets/index/all-ids.json'
        || $normalized === 'data/Genepedia-Database/pets/manifest.json') {
        return $normalized;
    }

    // Compatibility registries + sitemap.
    if ($normalized === 'pages/people/people.json'
        || $normalized === 'pages/pets/pets.json'
        || $normalized === 'people/people.json'
        || $normalized === 'sitemap.xml') {
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

// Up to 12 files per edit: a relationship save can additionally create linked
// pet profiles (each adds its record, SEO shell, prose, and ownership) plus the
// linking union and the registry, matching the new-profile endpoint's allowance.
if ($rawFiles === [] || count($rawFiles) > 12) {
    github_json([
        'ok' => false,
        'error' => 'invalid_files',
        'message' => 'Between one and twelve files can be published per edit.',
    ], 400);
}

$files = [];
foreach ($rawFiles as $entry) {
    $path = github_submit_page_edit_validate_path($entry['path']);
    $content = $entry['content'];

    // Profile shells/fragments live under pages/people/<id>/ and pages/pets/<id>/
    // (legacy people/<id>/ still recognised). They are distinguished from generic
    // editable site pages so their content rules apply correctly.
    $profilePrefix = '(?:pages/(?:people|pets)|people)';
    $isPeopleShell = $path !== null && preg_match('#^' . $profilePrefix . '/[a-zA-Z0-9_-]+/index\.html$#', $path) === 1;
    $isPeopleFragment = $path !== null && preg_match('#^' . $profilePrefix . '/[a-zA-Z0-9_-]+/(?:profile|data/[a-zA-Z0-9_./-]+|[a-zA-Z0-9_.-]+)\.html$#', $path) === 1 && !$isPeopleShell;
    $isPagePath = $path !== null && str_starts_with($path, 'pages/') && !$isPeopleShell && !$isPeopleFragment;
    $isDbJson = $path !== null && (
        preg_match('#^data/Genepedia-Database/(people|pets)/.+\.json$#', $path) === 1
        || $path === 'pages/people/people.json'
        || $path === 'pages/pets/pets.json'
        || $path === 'people/people.json'
    );
    $isSitemap = $path === 'sitemap.xml';

    if ($path === null) {
        github_json([
            'ok' => false,
            'error' => 'invalid_path',
            'message' => 'A valid pages/*.html, people/<id>/index.html, people/<id>/*.html, or data/Genepedia-Database/people/**.json path is required.',
        ], 400);
    }

    if ($content === '') {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'Content is required for ' . $path . '.',
        ], 400);
    }

    $looksLikeFullDocument = str_contains(strtolower($content), '<html')
        || str_contains(strtolower($content), '<!doctype');

    // Full HTML documents are required for site pages and per-person shells.
    if (($isPagePath || $isPeopleShell) && !$looksLikeFullDocument) {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'Published page content must be a complete HTML document.',
        ], 400);
    }

    // Prose fragments must contain HTML.
    if ($isPeopleFragment && !str_contains($content, '<')) {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'Profile prose must contain HTML.',
        ], 400);
    }

    // Database records must be valid JSON.
    if ($isDbJson && json_decode($content) === null && strtolower(trim($content)) !== 'null') {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => $path . ' must be valid JSON.',
        ], 400);
    }

    // Sitemap must be an XML urlset.
    if ($isSitemap && !str_contains($content, '<urlset')) {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'sitemap.xml must be a sitemap urlset document.',
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
    $result = github_publish_workspace_files($files, $editor, $commitMessage, $prTitle, $prBody);

    github_json([
        'ok' => true,
        'repo' => $result['repo'],
        'path' => $result['path'] !== '' ? $result['path'] : $path,
        'paths' => $result['paths'] ?: $allPaths,
        'branch' => $result['branch'],
        'base_branch' => $result['base_branch'],
        'commit' => $result['commit'],
        'pull_request' => $result['pull_request'],
        'published_directly' => (bool) $result['published_directly'],
        'results' => $result['results'],
        'secondary_results' => $result['secondary_results'],
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
