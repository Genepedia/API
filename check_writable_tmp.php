<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

$tempDir = sys_get_temp_dir();
$handoffDir = rtrim($tempDir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'genepedia-github-handoff';
$testFile = $handoffDir . DIRECTORY_SEPARATOR . 'write-test-' . bin2hex(random_bytes(8)) . '.txt';

$result = [
    'ok' => false,
    'php_sapi' => PHP_SAPI,
    'php_user' => function_exists('posix_getpwuid') && function_exists('posix_geteuid')
        ? (posix_getpwuid(posix_geteuid())['name'] ?? null)
        : null,
    'sys_temp_dir' => $tempDir,
    'handoff_dir' => $handoffDir,
    'handoff_dir_exists' => is_dir($handoffDir),
    'handoff_dir_writable' => is_dir($handoffDir) && is_writable($handoffDir),
    'write_test' => null,
    'message' => '',
];

try {
    if (!is_dir($handoffDir) && !mkdir($handoffDir, 0700, true) && !is_dir($handoffDir)) {
        throw new RuntimeException('Could not create the handoff directory.');
    }

    if (file_put_contents($testFile, 'ok', LOCK_EX) === false) {
        throw new RuntimeException('Could not write a test file in the handoff directory.');
    }

    if (!is_readable($testFile)) {
        throw new RuntimeException('Test file was written but is not readable.');
    }

    @unlink($testFile);

    $result['ok'] = true;
    $result['handoff_dir_exists'] = true;
    $result['handoff_dir_writable'] = true;
    $result['write_test'] = 'writable';
    $result['message'] = 'PHP can write login handoff files to the temp directory.';
} catch (Throwable $error) {
    $result['write_test'] = 'failed';
    $result['message'] = $error->getMessage();
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
