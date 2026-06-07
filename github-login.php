<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_start_session();

$returnTo = github_normalize_return_to($_GET['return_to'] ?? null);
$state = bin2hex(random_bytes(16));

github_redirect(github_build_authorize_url($state, $returnTo));