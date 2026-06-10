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

$repoConfig = github_repo_config();
$owner = $repoConfig['owner'];
$repo = $repoConfig['repo'];
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
        $talk = github_fetch_person_talk($owner, $repo, $personId);
        $profileConfig = github_fetch_person_profile_config($owner, $repo, $personId);
        $user = github_current_user();

        github_json([
            'ok' => true,
            'repo' => $repoSlug,
            'person' => $personId,
            'messages' => array_map('github_normalize_talk_message', $talk['messages']),
            'count' => count($talk['messages']),
            'can_moderate' => github_person_can_manage($profileConfig, $user),
            'viewer_login' => is_array($user) ? (string) ($user['login'] ?? '') : '',
            'fetched_at' => gmdate('c'),
        ]);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'github_talk_fetch_failed',
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

$action = strtolower(trim((string) ($payload['action'] ?? 'post')));
if (!in_array($action, ['post', 'delete'], true)) {
    github_json([
        'ok' => false,
        'error' => 'invalid_action',
        'message' => 'Action must be "post" or "delete".',
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
        'message' => 'Sign in with GitHub to take part in this talk page.',
    ], 401);
}

$user = $editor['user'];
$login = trim((string) ($user['login'] ?? ''));
$displayName = trim((string) ($user['displayName'] ?? $login));

try {
    $talk = github_fetch_person_talk($owner, $repo, $personId);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_talk_fetch_failed',
        'message' => $error->getMessage(),
    ], 502);
}

$messages = $talk['messages'];

if ($action === 'post') {
    $body = trim(str_replace("\r\n", "\n", (string) ($payload['body'] ?? '')));
    if ($body === '') {
        github_json([
            'ok' => false,
            'error' => 'empty_message',
            'message' => 'A message is required.',
        ], 400);
    }

    if (mb_strlen($body) > GITHUB_TALK_MAX_MESSAGE_LENGTH) {
        github_json([
            'ok' => false,
            'error' => 'message_too_long',
            'message' => 'Messages must be at most ' . GITHUB_TALK_MAX_MESSAGE_LENGTH . ' characters.',
        ], 400);
    }

    if (count($messages) >= GITHUB_TALK_MAX_MESSAGES) {
        github_json([
            'ok' => false,
            'error' => 'talk_page_full',
            'message' => 'This talk page has reached its maximum number of messages.',
        ], 400);
    }

    try {
        $messageId = 'msg-' . gmdate('Ymd-His') . '-' . bin2hex(random_bytes(4));
    } catch (Throwable) {
        $messageId = 'msg-' . gmdate('Ymd-His') . '-' . substr(md5(uniqid('', true)), 0, 8);
    }

    $message = [
        'id' => $messageId,
        'body' => $body,
        'author_login' => $login,
        'author_name' => $displayName,
        'author_avatar' => trim((string) ($user['avatarUrl'] ?? $user['avatar_url'] ?? '')),
        'author_url' => trim((string) ($user['htmlUrl'] ?? $user['html_url'] ?? ($login !== '' ? 'https://github.com/' . $login : ''))),
        'created_at' => gmdate('c'),
    ];
    $messages[] = $message;

    $commitMessage = sprintf(
        'Talk: new message on profile %s from @%s',
        $personId,
        $login !== '' ? $login : 'contributor',
    );

    try {
        $result = github_save_person_talk($owner, $repo, $personId, $messages, $talk['sha'], $editor, $commitMessage);

        github_json([
            'ok' => true,
            'repo' => $repoSlug,
            'person' => $personId,
            'action' => 'post',
            'message' => github_normalize_talk_message($message),
            'messages' => array_map('github_normalize_talk_message', $messages),
            'commit' => $result['commit'],
            'branch' => $result['branch'],
            'posted_at' => gmdate('c'),
        ]);
    } catch (Throwable $error) {
        github_json([
            'ok' => false,
            'error' => 'github_talk_post_failed',
            'message' => $error->getMessage(),
        ], 502);
    }
}

// action === 'delete'
$messageId = trim((string) ($payload['message_id'] ?? ''));
if ($messageId === '') {
    github_json([
        'ok' => false,
        'error' => 'invalid_message',
        'message' => 'A message id is required.',
    ], 400);
}

$target = null;
foreach ($messages as $message) {
    if ((string) ($message['id'] ?? '') === $messageId) {
        $target = $message;
        break;
    }
}

if ($target === null) {
    github_json([
        'ok' => false,
        'error' => 'message_not_found',
        'message' => 'That message no longer exists.',
    ], 404);
}

try {
    $profileConfig = github_fetch_person_profile_config($owner, $repo, $personId);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_profile_lookup_failed',
        'message' => $error->getMessage(),
    ], 502);
}

$isAuthor = $login !== '' && strcasecmp($login, (string) ($target['author_login'] ?? '')) === 0;
if (!$isAuthor && !github_person_can_manage($profileConfig, $user)) {
    github_json([
        'ok' => false,
        'error' => 'not_allowed',
        'message' => 'Only the message author or a profile maintainer can delete this message.',
    ], 403);
}

$messages = array_values(array_filter(
    $messages,
    static fn (array $message): bool => (string) ($message['id'] ?? '') !== $messageId,
));

$commitMessage = sprintf(
    'Talk: remove message %s on profile %s (by @%s)',
    $messageId,
    $personId,
    $login !== '' ? $login : 'moderator',
);

try {
    $result = github_save_person_talk($owner, $repo, $personId, $messages, $talk['sha'], $editor, $commitMessage);

    github_json([
        'ok' => true,
        'repo' => $repoSlug,
        'person' => $personId,
        'action' => 'delete',
        'deleted_id' => $messageId,
        'messages' => array_map('github_normalize_talk_message', $messages),
        'commit' => $result['commit'],
        'branch' => $result['branch'],
        'deleted_at' => gmdate('c'),
    ]);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_talk_delete_failed',
        'message' => $error->getMessage(),
    ], 502);
}
