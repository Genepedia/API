<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_apply_cors();
github_start_session();

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method === 'OPTIONS') {
    exit;
}

github_ensure_file_api_authenticated();

$siteRepoConfig = github_repo_config();
$siteOwner = $siteRepoConfig['owner'];
$siteRepo = $siteRepoConfig['repo'];
$mediaRepoConfig = github_media_repo_config();
$owner = $mediaRepoConfig['owner'];
$repo = $mediaRepoConfig['repo'];
$repoSlug = $owner . '/' . $repo;

if ($method === 'GET') {
    $personId = github_validate_person_id((string) ($_GET['person'] ?? ''));
    if ($personId === null) {
        github_json([
            'ok' => false,
            'error' => 'invalid_person',
            'message' => 'A valid person id is required.',
        ], 400);
    }

    try {
        $profileConfig = github_fetch_person_profile_config($siteOwner, $siteRepo, $personId);
        $user = github_current_user();

        $pending = [];
        try {
            $pending = github_person_media_pending($owner, $repo, $personId);
        } catch (Throwable $pendingError) {
            $pending = [];
        }

        github_json([
            'ok' => true,
            'repo' => $repoSlug,
            'person' => $personId,
            'images' => github_list_person_media($owner, $repo, $personId),
            'pending' => $pending,
            'can_manage' => github_profile_can_manage($siteOwner, $siteRepo, $personId, $user),
            'manager_logins' => github_person_profile_logins($profileConfig),
            'fetched_at' => gmdate('c'),
        ]);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'github_media_list_failed',
            'message' => $error->getMessage(),
        ], 502);
    }
}

if ($method !== 'POST') {
    github_json([
        'ok' => false,
        'error' => 'method_not_allowed',
        'message' => 'Only GET and POST requests are supported.',
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
if (!in_array($action, ['upload', 'delete', 'approve', 'decline'], true)) {
    github_json([
        'ok' => false,
        'error' => 'invalid_action',
        'message' => 'Action must be "upload", "delete", "approve" or "decline".',
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

// Approve/decline a pending media pull request. Allowed for the global
// reviewer or a maintainer/creator of this specific profile.
if ($action === 'approve' || $action === 'decline') {
    $number = (int) ($payload['number'] ?? 0);
    if ($number <= 0) {
        github_json([
            'ok' => false,
            'error' => 'invalid_request',
            'message' => 'A valid pull request number is required.',
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

    try {
        $profileConfig = github_fetch_person_profile_config($siteOwner, $siteRepo, $personId);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'github_profile_lookup_failed',
            'message' => $error->getMessage(),
        ], 502);
    }

    if (!github_profile_can_manage($siteOwner, $siteRepo, $personId, $editor['user'])) {
        github_json([
            'ok' => false,
            'error' => 'not_allowed',
            'message' => 'Only the creator, owner or maintainers of this profile can review its media.',
        ], 403);
    }

    try {
        $pullRequest = github_fetch_pull_request($owner, $repo, $number);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'pull_request_not_found',
            'message' => $error->getMessage(),
        ], 404);
    }

    if (!github_pull_request_is_person_media($pullRequest, $personId)) {
        github_json([
            'ok' => false,
            'error' => 'not_media_pull_request',
            'message' => 'That pull request is not a media change for this profile.',
        ], 400);
    }

    try {
        $result = github_review_pull_request(
            $owner,
            $repo,
            $number,
            $action === 'approve' ? 'merge' : 'decline',
            $editor,
        );

        github_json([
            'ok' => true,
            'repo' => $repoSlug,
            'person' => $personId,
            'action' => $action,
            'number' => $number,
            'result' => $result,
            'reviewed_at' => gmdate('c'),
        ]);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'github_media_review_failed',
            'message' => $error->getMessage(),
        ], 502);
    }
}

$filename = github_validate_media_filename((string) ($payload['filename'] ?? ''));
if ($filename === null) {
    github_json([
        'ok' => false,
        'error' => 'invalid_filename',
        'message' => 'Media filename must use letters, numbers, dashes and end in '
            . implode(', ', GITHUB_MEDIA_ALLOWED_EXTENSIONS) . '.',
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

$user = $editor['user'];
$login = trim((string) ($user['login'] ?? ''));
$displayName = trim((string) ($user['displayName'] ?? $login));

try {
    $profileConfig = github_fetch_person_profile_config($siteOwner, $siteRepo, $personId);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_profile_lookup_failed',
        'message' => $error->getMessage(),
    ], 502);
}

if (!github_profile_can_manage($siteOwner, $siteRepo, $personId, $user)) {
    github_json([
        'ok' => false,
        'error' => 'not_allowed',
        'message' => 'Only the creator, owner or maintainers of this profile can manage its media.',
    ], 403);
}

$path = github_person_media_file_path($personId, $filename);
$binaryContent = null;

if ($action === 'upload') {
    $contentBase64 = (string) ($payload['content_base64'] ?? '');
    $contentBase64 = preg_replace('/^data:[^;]+;base64,/', '', trim($contentBase64)) ?? '';
    $sourceUrl = trim((string) ($payload['source_url'] ?? ''));

    if ($contentBase64 !== '') {
        $binaryContent = base64_decode($contentBase64, true);
    } elseif ($sourceUrl !== '') {
        try {
            $download = github_fetch_remote_media($sourceUrl);
            $binaryContent = (string) ($download['content'] ?? '');
        } catch (Throwable $error) {
            github_json([
                'ok' => false,
                'error' => 'invalid_source_url',
                'message' => $error->getMessage(),
            ], 400);
        }
    }

    if (!is_string($binaryContent) || $binaryContent === '') {
        github_json([
            'ok' => false,
            'error' => 'invalid_content',
            'message' => 'Media content must be provided as base64 or a Geni media link.',
        ], 400);
    }

    if (strlen($binaryContent) > GITHUB_MEDIA_MAX_BYTES) {
        github_json([
            'ok' => false,
            'error' => 'image_too_large',
            'message' => 'Media files must be smaller than ' . round(GITHUB_MEDIA_MAX_BYTES / 1_000_000) . ' MB.',
        ], 400);
    }
}

$caption = trim((string) ($payload['caption'] ?? ''));
$commitMessage = trim((string) ($payload['commit_message'] ?? ''));
$prTitle = trim((string) ($payload['pr_title'] ?? ''));
$prBody = trim((string) ($payload['pr_body'] ?? ''));

$actionLabel = $action === 'upload' ? 'Add' : 'Remove';
if ($commitMessage === '') {
    $commitMessage = sprintf('%s image %s for profile %s', $actionLabel, $filename, $personId);
}

if ($prTitle === '') {
    $prTitle = $commitMessage;
}

if ($prBody === '') {
    $lines = [
        sprintf(
            'This update %s `%s` via the profile media tab.',
            $action === 'upload' ? 'adds' : 'removes',
            $path,
        ),
        '',
    ];

    if ($caption !== '') {
        $lines[] = 'Caption: ' . $caption;
        $lines[] = '';
    }

    $lines[] = 'Submitted by ' . ($displayName !== '' ? $displayName : $login)
        . ($login !== '' ? ' (@' . $login . ')' : '') . '.';
    $prBody = implode("\n", $lines);
} elseif (!str_contains($prBody, '`' . $path . '`')) {
    $prBody .= "\n\nFile: `" . $path . '`';
}

try {
    $result = github_commit_person_media_to_default_branch(
        $owner,
        $repo,
        $action,
        $path,
        $binaryContent,
        $editor,
        $commitMessage,
        $prTitle,
        $prBody,
    );

    github_json([
        'ok' => true,
        'repo' => $repoSlug,
        'person' => $personId,
        'action' => $action,
        'path' => $path,
        'filename' => $filename,
        'branch' => $result['branch'],
        'base_branch' => $result['base_branch'],
        'commit' => $result['commit'],
        'pull_request' => $result['pull_request'],
        'published_directly' => true,
        'submitted_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    $message = $error->getMessage();
    $status = 502;
    if (str_contains($message, 'missing repository write permissions')
        || str_contains($message, 'needs write access')) {
        $status = 503;
    }

    github_json([
        'ok' => false,
        'error' => 'github_media_' . $action . '_failed',
        'message' => $message,
    ], $status);
}
