<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_apply_cors();

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
$code = is_array($payload) ? trim((string) ($payload['code'] ?? '')) : '';

if ($code === '') {
    github_json([
        'ok' => false,
        'error' => 'missing_code',
        'message' => 'A login handoff code is required.',
    ], 400);
}

$handoff = github_consume_login_handoff($code);
if ($handoff === null) {
    github_json([
        'ok' => false,
        'error' => 'invalid_handoff',
        'message' => 'This login handoff code is invalid or has expired. Please sign in again.',
    ], 401);
}

github_json([
    'ok' => true,
    'authenticated' => true,
    'user' => $handoff['user'],
    'access_token' => $handoff['token'],
]);
