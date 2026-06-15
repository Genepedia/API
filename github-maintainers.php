<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_apply_cors();
github_start_session();

const GITHUB_MAINTAINER_INVITES_PATH = 'data/maintainer-invitations.json';

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method === 'OPTIONS') {
    exit;
}

github_ensure_file_api_authenticated();

$repoConfig = github_repo_config();
$owner = $repoConfig['owner'];
$repo = $repoConfig['repo'];
$repoSlug = $owner . '/' . $repo;

function github_maintainers_parse_paths($value): array
{
    if (is_array($value)) {
        $parts = $value;
    } else {
        $parts = preg_split('/\s*,\s*/', (string) $value) ?: [];
    }

    $paths = [];
    foreach ($parts as $part) {
        $path = str_replace('\\', '/', trim((string) $part));
        $path = ltrim($path, '/');
        if ($path !== '') {
            $paths[] = $path;
        }
    }

    return array_values(array_unique($paths));
}

function github_maintainers_profile_person_id(array $paths): ?string
{
    $personId = null;
    foreach ($paths as $path) {
        if (preg_match('#^people/([a-zA-Z0-9_-]+)/(?:index\.html|profile\.html|data/|media/)#', (string) $path, $matches) !== 1) {
            return null;
        }

        $current = (string) $matches[1];
        if ($personId !== null && $personId !== $current) {
            return null;
        }

        $personId = $current;
    }

    return $personId;
}

function github_maintainers_target_from_paths(array $paths): ?array
{
    $personId = github_maintainers_profile_person_id($paths);
    if ($personId !== null) {
        return [
            'type' => 'profile',
            'key' => 'profile:' . $personId,
            'person_id' => $personId,
            'editable_path' => 'people/' . $personId . '/profile.html',
            'metadata_path' => github_person_ownership_path($personId),
            'label' => 'Profile ' . $personId,
        ];
    }

    if (count($paths) === 1 && preg_match('#^pages/[a-zA-Z0-9_./-]+\.html$#', $paths[0]) === 1) {
        $metadataPath = github_page_ownership_config_path($paths[0]);
        if ($metadataPath === null) {
            return null;
        }

        return [
            'type' => 'page',
            'key' => 'page:' . $paths[0],
            'editable_path' => $paths[0],
            'metadata_path' => $metadataPath,
            'label' => str_replace('_', ' ', (string) pathinfo($paths[0], PATHINFO_FILENAME)),
        ];
    }

    return null;
}

function github_maintainers_target_from_request(array $payload = []): ?array
{
    $raw = $payload['paths'] ?? $payload['path'] ?? $_GET['paths'] ?? $_GET['path'] ?? '';
    return github_maintainers_target_from_paths(github_maintainers_parse_paths($raw));
}

function github_maintainers_identity(array $user, string $fallbackLogin = '', string $fallbackName = ''): array
{
    $login = trim((string) ($user['login'] ?? $user['githubLogin'] ?? $fallbackLogin));
    $name = trim((string) ($fallbackName ?: ($user['displayName'] ?? $user['name'] ?? '')));
    if ($name === '') {
        $name = $login;
    }

    $identity = [
        'name' => $name,
        'githubLogin' => $login,
    ];

    $personId = trim((string) ($user['personId'] ?? $user['person_id'] ?? ''));
    if ($personId !== '') {
        $identity['personId'] = $personId;
    }

    return $identity;
}

function github_maintainers_fetch_json_file(string $owner, string $repo, string $path): array
{
    $base = github_get_repository_default_branch($owner, $repo, github_api_token());
    $content = github_fetch_file_contents_at_ref($owner, $repo, $path, $base['branch']);
    if ($content === null || trim($content) === '') {
        return [];
    }

    $decoded = json_decode($content, true);
    return is_array($decoded) ? $decoded : [];
}

function github_maintainers_read_ledger(string $owner, string $repo): array
{
    $ledger = github_maintainers_fetch_json_file($owner, $repo, GITHUB_MAINTAINER_INVITES_PATH);
    return [
        'version' => 1,
        'items' => array_values(array_filter(is_array($ledger['items'] ?? null) ? $ledger['items'] : [], 'is_array')),
    ];
}

function github_maintainers_json(array $data): string
{
    $encoded = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($encoded)) {
        throw new RuntimeException('Could not encode maintainer invitations.');
    }

    return $encoded . "\n";
}

function github_maintainers_target_items(array $ledger, array $target): array
{
    return array_values(array_filter($ledger['items'], static function (array $item) use ($target): bool {
        return (string) ($item['target']['key'] ?? '') === (string) $target['key'];
    }));
}

function github_maintainers_fetch_target_config(string $owner, string $repo, array $target): array
{
    if ($target['type'] === 'profile') {
        return github_fetch_person_profile_config($owner, $repo, (string) $target['person_id']);
    }

    return github_fetch_page_ownership_config($owner, $repo, (string) $target['editable_path']);
}

function github_maintainers_user_can_manage(string $owner, string $repo, array $target, ?array $user): bool
{
    if ($target['type'] === 'profile') {
        return github_profile_can_manage($owner, $repo, (string) $target['person_id'], $user);
    }

    return github_page_can_manage($owner, $repo, (string) $target['editable_path'], $user);
}

function github_maintainers_is_maintainer(array $config, ?array $user): bool
{
    $login = github_user_login($user);
    if ($login === '') {
        return false;
    }

    $logins = github_ownership_config_logins([
        'owner' => $config['owner'] ?? null,
        'maintainers' => is_array($config['maintainers'] ?? null) ? $config['maintainers'] : [],
    ]);

    return in_array($login, $logins, true);
}

function github_maintainers_has_open_item(array $ledger, array $target, string $kind, string $login): bool
{
    $login = strtolower(trim($login));
    foreach (github_maintainers_target_items($ledger, $target) as $item) {
        if ((string) ($item['kind'] ?? '') !== $kind) {
            continue;
        }
        if ((string) ($item['status'] ?? '') !== 'pending') {
            continue;
        }
        $itemLogin = strtolower(trim((string) ($item['person']['githubLogin'] ?? '')));
        if ($itemLogin !== '' && $itemLogin === $login) {
            return true;
        }
    }

    return false;
}

function github_maintainers_add_maintainer(array $config, array $identity): array
{
    $login = strtolower(trim((string) ($identity['githubLogin'] ?? '')));
    if ($login === '') {
        return $config;
    }

    $maintainers = is_array($config['maintainers'] ?? null)
        ? array_values(array_filter($config['maintainers'], 'is_array'))
        : [];
    foreach ($maintainers as $maintainer) {
        if (strcasecmp((string) ($maintainer['githubLogin'] ?? ''), $identity['githubLogin']) === 0) {
            $config['maintainers'] = $maintainers;
            return $config;
        }
    }

    $maintainers[] = $identity;
    $config['maintainers'] = $maintainers;
    return $config;
}

function github_maintainers_find_item_index(array $ledger, string $id): int
{
    foreach ($ledger['items'] as $index => $item) {
        if ((string) ($item['id'] ?? '') === $id) {
            return $index;
        }
    }

    return -1;
}

$target = null;
$payload = [];
if ($method === 'POST') {
    $rawBody = file_get_contents('php://input');
    $payload = json_decode(is_string($rawBody) ? $rawBody : '', true);
    if (!is_array($payload)) {
        github_json([
            'ok' => false,
            'error' => 'invalid_json',
            'message' => 'Request body must be valid JSON.',
        ], 400);
    }
    $target = github_maintainers_target_from_request($payload);
} else {
    $target = github_maintainers_target_from_request();
}

if ($target === null) {
    github_json([
        'ok' => false,
        'error' => 'invalid_target',
        'message' => 'A valid editable page or profile target is required.',
    ], 400);
}

try {
    $ledger = github_maintainers_read_ledger($owner, $repo);
    $targetConfig = github_maintainers_fetch_target_config($owner, $repo, $target);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_lookup_failed',
        'message' => $error->getMessage(),
    ], 502);
}

$user = github_current_user();
$canManage = github_maintainers_user_can_manage($owner, $repo, $target, $user);
$isMaintainer = github_maintainers_is_maintainer($targetConfig, $user) || $canManage;

if ($method === 'GET') {
    github_json([
        'ok' => true,
        'repo' => $repoSlug,
        'target' => $target,
        'items' => github_maintainers_target_items($ledger, $target),
        'can_manage' => $canManage,
        'is_maintainer' => $isMaintainer,
        'current_user' => is_array($user) ? github_normalize_pull_request_user($user) : null,
        'fetched_at' => gmdate('c'),
    ]);
}

if ($method !== 'POST') {
    github_json([
        'ok' => false,
        'error' => 'method_not_allowed',
        'message' => 'Only GET and POST requests are supported.',
    ], 405);
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

$user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
$canManage = github_maintainers_user_can_manage($owner, $repo, $target, $user);
$isMaintainer = github_maintainers_is_maintainer($targetConfig, $user) || $canManage;
$action = strtolower(trim((string) ($payload['action'] ?? '')));
$now = gmdate('c');
$files = [];
$commitMessage = '';

if ($action === 'request') {
    if ($isMaintainer) {
        github_json([
            'ok' => false,
            'error' => 'already_maintainer',
            'message' => 'You are already a maintainer for this target.',
        ], 409);
    }

    $identity = github_maintainers_identity($user);
    $login = strtolower((string) ($identity['githubLogin'] ?? ''));
    if ($login === '') {
        github_json([
            'ok' => false,
            'error' => 'missing_login',
            'message' => 'A GitHub login is required.',
        ], 400);
    }
    if (github_maintainers_has_open_item($ledger, $target, 'request', $login)) {
        github_json([
            'ok' => false,
            'error' => 'request_exists',
            'message' => 'You already have a pending maintainer request.',
        ], 409);
    }

    $ledger['items'][] = [
        'id' => 'maint-' . bin2hex(random_bytes(8)),
        'target' => $target,
        'kind' => 'request',
        'status' => 'pending',
        'person' => $identity,
        'createdBy' => $identity,
        'createdAt' => $now,
    ];
    $files[] = ['path' => GITHUB_MAINTAINER_INVITES_PATH, 'content' => github_maintainers_json($ledger)];
    $commitMessage = 'Request maintainer access for ' . $target['label'];
} elseif ($action === 'invite') {
    if (!$canManage) {
        github_json([
            'ok' => false,
            'error' => 'not_allowed',
            'message' => 'Only current maintainers can invite new maintainers.',
        ], 403);
    }

    $inviteLogin = trim((string) ($payload['github_login'] ?? $payload['login'] ?? ''));
    if ($inviteLogin === '' || preg_match('/^[a-zA-Z0-9-]{1,39}$/', $inviteLogin) !== 1) {
        github_json([
            'ok' => false,
            'error' => 'invalid_login',
            'message' => 'A valid GitHub login is required.',
        ], 400);
    }
    if (github_maintainers_has_open_item($ledger, $target, 'invite', strtolower($inviteLogin))) {
        github_json([
            'ok' => false,
            'error' => 'invite_exists',
            'message' => 'That person already has a pending maintainer invitation.',
        ], 409);
    }

    $identity = github_maintainers_identity([], $inviteLogin, (string) ($payload['name'] ?? $inviteLogin));
    $ledger['items'][] = [
        'id' => 'maint-' . bin2hex(random_bytes(8)),
        'target' => $target,
        'kind' => 'invite',
        'status' => 'pending',
        'person' => $identity,
        'createdBy' => github_maintainers_identity($user),
        'createdAt' => $now,
    ];
    $files[] = ['path' => GITHUB_MAINTAINER_INVITES_PATH, 'content' => github_maintainers_json($ledger)];
    $commitMessage = 'Invite @' . $inviteLogin . ' as maintainer for ' . $target['label'];
} elseif (in_array($action, ['approve', 'decline', 'cancel', 'accept_invite', 'decline_invite'], true)) {
    $id = trim((string) ($payload['id'] ?? ''));
    $index = github_maintainers_find_item_index($ledger, $id);
    if ($id === '' || $index < 0) {
        github_json([
            'ok' => false,
            'error' => 'item_not_found',
            'message' => 'That maintainer invitation or request could not be found.',
        ], 404);
    }

    $item = $ledger['items'][$index];
    if ((string) ($item['target']['key'] ?? '') !== (string) $target['key'] || (string) ($item['status'] ?? '') !== 'pending') {
        github_json([
            'ok' => false,
            'error' => 'item_not_pending',
            'message' => 'That maintainer invitation or request is no longer pending.',
        ], 409);
    }

    $kind = (string) ($item['kind'] ?? '');
    $itemLogin = strtolower(trim((string) ($item['person']['githubLogin'] ?? '')));
    $userLogin = github_user_login($user);
    $decision = '';

    if ($action === 'approve' || $action === 'decline' || $action === 'cancel') {
        if (!$canManage) {
            github_json([
                'ok' => false,
                'error' => 'not_allowed',
                'message' => 'Only current maintainers can manage maintainer requests.',
            ], 403);
        }
        if ($action === 'approve' && $kind !== 'request') {
            github_json([
                'ok' => false,
                'error' => 'invalid_action',
                'message' => 'Only maintainer requests can be approved by maintainers.',
            ], 400);
        }
        $decision = $action === 'approve' ? 'accepted' : ($action === 'cancel' ? 'cancelled' : 'declined');
    } else {
        if ($kind !== 'invite' || $itemLogin === '' || $itemLogin !== $userLogin) {
            github_json([
                'ok' => false,
                'error' => 'not_allowed',
                'message' => 'Only the invited GitHub user can respond to this invitation.',
            ], 403);
        }
        $decision = $action === 'accept_invite' ? 'accepted' : 'declined';
    }

    $item['status'] = $decision;
    $item['decidedBy'] = github_maintainers_identity($user);
    $item['decidedAt'] = $now;
    $ledger['items'][$index] = $item;

    if ($decision === 'accepted') {
        $targetConfig = github_maintainers_add_maintainer($targetConfig, is_array($item['person'] ?? null) ? $item['person'] : []);
        $files[] = [
            'path' => (string) $target['metadata_path'],
            'content' => github_maintainers_json($targetConfig),
        ];
    }

    $files[] = ['path' => GITHUB_MAINTAINER_INVITES_PATH, 'content' => github_maintainers_json($ledger)];
    $commitMessage = ucfirst(str_replace('_', ' ', $action)) . ' maintainer access for ' . $target['label'];
} else {
    github_json([
        'ok' => false,
        'error' => 'invalid_action',
        'message' => 'Action must be request, invite, approve, decline, cancel, accept_invite or decline_invite.',
    ], 400);
}

try {
    $result = github_publish_workspace_files($files, $editor, $commitMessage, $commitMessage, '');
    $freshCanManage = github_maintainers_user_can_manage($owner, $repo, $target, $user);
    $freshIsMaintainer = github_maintainers_is_maintainer($targetConfig, $user) || $freshCanManage;
    github_json([
        'ok' => true,
        'repo' => $result['repo'],
        'target' => $target,
        'items' => github_maintainers_target_items($ledger, $target),
        'can_manage' => $freshCanManage,
        'is_maintainer' => $freshIsMaintainer,
        'commit' => $result['commit'],
        'pull_request' => $result['pull_request'],
        'published_directly' => (bool) $result['published_directly'],
        'results' => $result['results'],
        'published_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_maintainers_publish_failed',
        'message' => $error->getMessage(),
    ], 502);
}
