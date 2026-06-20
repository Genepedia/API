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

$action = strtolower(trim((string) ($payload['action'] ?? '')));
if (!in_array($action, ['create', 'claim'], true)) {
    github_json([
        'ok' => false,
        'error' => 'invalid_action',
        'message' => 'Action must be "create" or "claim".',
    ], 400);
}

$personId = github_validate_person_id((string) ($payload['person_id'] ?? $payload['person'] ?? ''));
if ($personId === null) {
    github_json([
        'ok' => false,
        'error' => 'invalid_person',
        'message' => 'A valid person id is required.',
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
$peopleDbRepoConfig = github_people_db_repo_config();
$peopleDbOwner = $peopleDbRepoConfig['owner'];
$peopleDbRepo = $peopleDbRepoConfig['repo'];
$peopleDbRepoSlug = $peopleDbOwner . '/' . $peopleDbRepo;
$user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
$login = trim((string) ($user['login'] ?? ''));

if ($login === '') {
    github_json([
        'ok' => false,
        'error' => 'authentication_required',
        'message' => 'GitHub login is required to save a self profile.',
    ], 401);
}

function github_self_profile_display_name(array $user, string $fallback = ''): string
{
    $fallback = trim($fallback);
    if ($fallback !== '') {
        return $fallback;
    }

    $displayName = trim((string) ($user['displayName'] ?? ''));
    if ($displayName !== '') {
        return $displayName;
    }

    $givenName = trim((string) ($user['givenName'] ?? ''));
    $familyName = trim((string) ($user['familyName'] ?? ''));
    $name = trim($givenName . ' ' . $familyName);
    if ($name !== '') {
        return $name;
    }

    return trim((string) ($user['login'] ?? 'Genepedia user'));
}

function github_self_profile_identity(string $personId, array $user, string $fallbackName = ''): array
{
    return [
        'personId' => $personId,
        'name' => github_self_profile_display_name($user, $fallbackName),
        'githubLogin' => trim((string) ($user['login'] ?? '')),
    ];
}

function github_self_profile_apply_owner(array $config, string $personId, array $user, string $fallbackName = '', bool $claimSelf = true): array
{
    $identity = github_self_profile_identity($personId, $user, $fallbackName);

    if (!is_array($config['creator'] ?? null)) {
        $config['creator'] = $identity;
    }

    $maintainers = is_array($config['maintainers'] ?? null) ? array_values(array_filter($config['maintainers'], 'is_array')) : [];
    $hasMaintainer = false;
    foreach ($maintainers as $maintainer) {
        if (strcasecmp((string) ($maintainer['githubLogin'] ?? ''), $identity['githubLogin']) === 0) {
            $hasMaintainer = true;
            break;
        }
    }
    if (!$hasMaintainer) {
        $maintainers[] = $identity;
    }

    $config['maintainers'] = $maintainers;
    $config['owner'] = $claimSelf ? $identity : null;
    return $config;
}

function github_self_profile_apply_claim(array $config, string $personId, array $user, string $fallbackName = ''): array
{
    return github_self_profile_apply_owner($config, $personId, $user, $fallbackName, true);
}

function github_self_profile_json(array $config): string
{
    $encoded = json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($encoded)) {
        throw new RuntimeException('Could not encode profile metadata.');
    }

    return $encoded . "\n";
}

function github_self_profile_validate_content(string $path, string $content): void
{
    if ($content === '') {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'Profile file content is required for ' . $path . '.',
        ], 400);
    }

    if (str_ends_with($path, '.html') && !str_contains($content, '<')) {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'HTML profile files must contain markup.',
        ], 400);
    }

    if (str_ends_with($path, '.ged') && (!str_contains($content, '0 HEAD') || !str_contains($content, '0 TRLR'))) {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'family-tree.ged must be a GEDCOM document.',
        ], 400);
    }

    if (str_ends_with($path, '.json') && json_decode($content, true) === null && json_last_error() !== JSON_ERROR_NONE) {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => $path . ' must be valid JSON.',
        ], 400);
    }
}

function github_self_profile_validate_create_files(array $payload, string $personId, array $user): array
{
    $rawFiles = is_array($payload['files'] ?? null) ? $payload['files'] : [];
    if ($rawFiles === [] || count($rawFiles) > 12) {
        github_json([
            'ok' => false,
            'error' => 'invalid_files',
            'message' => 'A new profile must publish between one and twelve files.',
        ], 400);
    }

    $recordPath = github_person_record_path($personId);
    $ownershipPath = github_person_ownership_path($personId);

    // Profiles live under pages/people/<id>/; pets under pages/pets/<id>/.
    $profileKind = strtolower(trim((string) ($payload['profile_kind'] ?? 'person')));
    $profileFolder = $profileKind === 'pet'
        ? 'pages/pets/' . $personId
        : 'pages/people/' . $personId;

    $allowed = [
        $profileFolder . '/index.html' => true,
        $profileFolder . '/profile.html' => true,
        $recordPath => true,
        $ownershipPath => true,
        'pages/people/people.json' => true,
    ];

    $filesByPath = [];
    foreach ($rawFiles as $entry) {
        if (!is_array($entry)) {
            continue;
        }

        $path = str_replace('\\', '/', trim((string) ($entry['path'] ?? '')));
        $path = ltrim($path, '/');
        $content = (string) ($entry['content'] ?? '');

        if (!isset($allowed[$path])) {
            github_json([
                'ok' => false,
                'error' => 'invalid_path',
                'message' => 'Self-profile creation cannot publish ' . ($path !== '' ? $path : 'that path') . '.',
            ], 400);
        }

        github_self_profile_validate_content($path, $content);
        $filesByPath[$path] = [
            'path' => $path,
            'content' => $content,
        ];
    }

    $required = [
        $profileFolder . '/index.html',
        $profileFolder . '/profile.html',
        $recordPath,
        $ownershipPath,
    ];

    foreach ($required as $path) {
        if (!isset($filesByPath[$path])) {
            github_json([
                'ok' => false,
                'error' => 'missing_file',
                'message' => 'New profiles must include ' . $path . '.',
            ], 400);
        }
    }

    $profileJsonPath = github_person_ownership_path($personId);
    $profileConfig = json_decode($filesByPath[$profileJsonPath]['content'], true);
    $profileConfig = is_array($profileConfig) ? $profileConfig : [];
    $fallbackName = trim((string) ($profileConfig['owner']['name'] ?? $profileConfig['creator']['name'] ?? ''));
    $claimSelf = !array_key_exists('claim_self', $payload) || filter_var($payload['claim_self'], FILTER_VALIDATE_BOOLEAN);
    $profileConfig = github_self_profile_apply_owner($profileConfig, $personId, $user, $fallbackName, $claimSelf);
    $filesByPath[$profileJsonPath]['content'] = github_self_profile_json($profileConfig);

    return array_values($filesByPath);
}

if ($action === 'claim') {
    try {
        $profileConfig = github_fetch_person_profile_config($owner, $repo, $personId);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'github_profile_lookup_failed',
            'message' => $error->getMessage(),
        ], 502);
    }

    if ($profileConfig === []) {
        github_json([
            'ok' => false,
            'error' => 'profile_not_found',
            'message' => 'That profile does not have profile metadata to claim.',
        ], 404);
    }

    $existingClaimLogin = trim((string) ($profileConfig['owner']['githubLogin'] ?? ''));
    if ($existingClaimLogin !== '' && strcasecmp($existingClaimLogin, $login) !== 0) {
        github_json([
            'ok' => false,
            'error' => 'profile_already_claimed',
            'message' => 'That profile has already been claimed.',
        ], 409);
    }

    $nextConfig = github_self_profile_apply_claim($profileConfig, $personId, $user, (string) ($profileConfig['owner']['name'] ?? ''));
    $path = github_person_ownership_path($personId);
    $content = github_self_profile_json($nextConfig);

    if ($content === github_self_profile_json($profileConfig)) {
        github_json([
            'ok' => true,
            'repo' => $peopleDbRepoSlug,
            'person' => $personId,
            'action' => 'claim',
            'commit' => null,
            'claimed_at' => gmdate('c'),
        ]);
    }

    $commitMessage = trim((string) ($payload['commit_message'] ?? ''));
    if ($commitMessage === '') {
        $commitMessage = 'Claim profile ' . $personId . ' for @' . $login;
    }

    try {
        $result = github_publish_workspace_files([[
            'path' => $path,
            'content' => $content,
        ]], $editor, $commitMessage, $commitMessage, '');

        github_json([
            'ok' => true,
            'repo' => $result['repo'],
            'person' => $personId,
            'action' => 'claim',
            'branch' => $result['branch'],
            'commit' => $result['commit'],
            'pull_request' => $result['pull_request'],
            'results' => $result['results'],
            'claimed_at' => gmdate('c'),
        ]);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'github_claim_failed',
            'message' => $error->getMessage(),
        ], 502);
    }
}

// action === create
try {
    $base = github_get_repository_default_branch($owner, $repo, github_api_token());
    $dbBase = github_get_repository_default_branch($peopleDbOwner, $peopleDbRepo, github_api_token());
    $createKind = strtolower(trim((string) ($payload['profile_kind'] ?? 'person')));
    $createFolder = $createKind === 'pet' ? 'pages/pets/' . $personId : 'pages/people/' . $personId;
    $existingProfile = github_get_file_metadata_on_branch($owner, $repo, $createFolder . '/index.html', $base['branch'], github_api_token());
    $existingMetadata = github_get_file_metadata_on_branch(
        $peopleDbOwner,
        $peopleDbRepo,
        github_people_db_repo_path(github_person_record_path($personId)),
        $dbBase['branch'],
        github_api_token(),
    );
    if ($existingProfile !== null || $existingMetadata !== null) {
        github_json([
            'ok' => false,
            'error' => 'profile_exists',
            'message' => 'That profile id already exists. Refresh and try again.',
        ], 409);
    }
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_profile_lookup_failed',
        'message' => $error->getMessage(),
    ], 502);
}

$files = github_self_profile_validate_create_files($payload, $personId, $user);
$commitMessage = trim((string) ($payload['commit_message'] ?? ''));
if ($commitMessage === '') {
    $commitMessage = 'Create self profile ' . $personId . ' for @' . $login;
}

try {
    $result = github_publish_workspace_files($files, $editor, $commitMessage, $commitMessage, '');

    github_json([
        'ok' => true,
        'repo' => $result['repo'],
        'person' => $personId,
        'action' => 'create',
        'paths' => $result['paths'],
        'branch' => $result['branch'],
        'base_branch' => $result['base_branch'],
        'commit' => $result['commit'],
        'pull_request' => $result['pull_request'],
        'published_directly' => (bool) $result['published_directly'],
        'results' => $result['results'],
        'published_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_profile_create_failed',
        'message' => $error->getMessage(),
    ], 502);
}
