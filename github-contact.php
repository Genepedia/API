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

// Reasons the contact form can submit, mapped to an issue label and a human
// title. Labels are resolved server-side so the client can never inject an
// arbitrary label onto a repository issue.
const GITHUB_CONTACT_REASONS = [
    'question' => ['title' => 'General Question', 'label' => 'question'],
    'bug' => ['title' => 'Bug Report', 'label' => 'bug'],
    'enhancement' => ['title' => 'Feature Request', 'label' => 'enhancement'],
];

const GITHUB_CONTACT_MAX_SUBJECT_LENGTH = 200;
const GITHUB_CONTACT_MAX_MESSAGE_LENGTH = 8000;
const GITHUB_CONTACT_MAX_DETAILS_LENGTH = 4000;

$rawBody = file_get_contents('php://input');
$payload = json_decode(is_string($rawBody) ? $rawBody : '', true);
if (!is_array($payload)) {
    github_json([
        'ok' => false,
        'error' => 'invalid_json',
        'message' => 'Request body must be valid JSON.',
    ], 400);
}

$reasonKey = strtolower(trim((string) ($payload['reason'] ?? 'question')));
$reason = GITHUB_CONTACT_REASONS[$reasonKey] ?? GITHUB_CONTACT_REASONS['question'];

$subject = trim(str_replace(["\r\n", "\r", "\n"], ' ', (string) ($payload['subject'] ?? '')));
$message = trim(str_replace("\r\n", "\n", (string) ($payload['message'] ?? '')));
$details = trim(str_replace("\r\n", "\n", (string) ($payload['details'] ?? '')));

if ($subject === '') {
    github_json([
        'ok' => false,
        'error' => 'missing_subject',
        'message' => 'A subject is required.',
    ], 400);
}

if ($message === '') {
    github_json([
        'ok' => false,
        'error' => 'missing_message',
        'message' => 'A message is required.',
    ], 400);
}

if (mb_strlen($subject) > GITHUB_CONTACT_MAX_SUBJECT_LENGTH) {
    $subject = mb_substr($subject, 0, GITHUB_CONTACT_MAX_SUBJECT_LENGTH);
}
if (mb_strlen($message) > GITHUB_CONTACT_MAX_MESSAGE_LENGTH) {
    github_json([
        'ok' => false,
        'error' => 'message_too_long',
        'message' => 'Messages must be at most ' . GITHUB_CONTACT_MAX_MESSAGE_LENGTH . ' characters.',
    ], 400);
}
if (mb_strlen($details) > GITHUB_CONTACT_MAX_DETAILS_LENGTH) {
    $details = mb_substr($details, 0, GITHUB_CONTACT_MAX_DETAILS_LENGTH);
}

$repoConfig = github_repo_config();
$owner = $repoConfig['owner'];
$repo = $repoConfig['repo'];
$repoSlug = $owner . '/' . $repo;

// Create the issue as the signed-in visitor so it is attributed to them on
// GitHub — never as the Genepedia app/bot. Visitors who are not signed in are
// asked to sign in (the client falls back to a pre-filled GitHub issue link).
try {
    $editor = github_require_authenticated_editor();
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'authentication_required',
        'message' => 'Sign in with GitHub to send your message — the issue is opened under your account.',
    ], 401);
}

$token = (string) $editor['token'];
$user = is_array($editor['user'] ?? null) ? $editor['user'] : [];
$authorLogin = trim((string) ($user['login'] ?? ''));

// Build the issue body. Anything the visitor controls is treated as plain text;
// the environment "details" block is included verbatim (already plain text built
// by the client) inside a collapsible section so the issue stays readable.
$bodyLines = [
    '**Reason:** ' . $reason['title'],
    '',
    '## Message',
    '',
    $message,
];

if ($details !== '') {
    $bodyLines[] = '';
    $bodyLines[] = '<details>';
    $bodyLines[] = '<summary>Environment & diagnostics</summary>';
    $bodyLines[] = '';
    $bodyLines[] = '```';
    $bodyLines[] = $details;
    $bodyLines[] = '```';
    $bodyLines[] = '';
    $bodyLines[] = '</details>';
}

$bodyLines[] = '';
$bodyLines[] = '_Submitted from the Genepedia contact page._';

// Labels are included as a best effort: GitHub only honours them when the
// author has push access and silently drops them otherwise, so the reason is
// also recorded in the issue body above.
$issuePayload = [
    'title' => $subject,
    'body' => implode("\n", $bodyLines),
    'labels' => [$reason['label']],
];

$url = 'https://api.github.com/repos/'
    . rawurlencode($owner) . '/' . rawurlencode($repo) . '/issues';

try {
    $response = github_rest_request('POST', $url, $token, $issuePayload);
} catch (Throwable $error) {
    github_json([
        'ok' => false,
        'error' => 'github_request_failed',
        'message' => 'Could not reach GitHub to create the issue.',
    ], 502);
}

$status = (int) ($response['status'] ?? 0);
$data = is_array($response['data'] ?? null) ? $response['data'] : [];

if ($status >= 400) {
    error_log('github-contact: issue creation failed (' . $status . '): ' . (string) ($response['raw'] ?? ''));
    github_json([
        'ok' => false,
        'error' => 'github_issue_failed',
        'message' => 'GitHub rejected the request. Please try again later.',
    ], 502);
}

github_json([
    'ok' => true,
    'repo' => $repoSlug,
    'reason' => $reasonKey,
    'number' => (int) ($data['number'] ?? 0),
    'url' => (string) ($data['html_url'] ?? ''),
    'author' => $authorLogin,
    'created_at' => gmdate('c'),
], 201);
