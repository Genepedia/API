<?php

declare(strict_types=1);

require __DIR__ . '/github-auth.php';

github_start_session();
github_clear_session();
session_regenerate_id(true);

github_json([
    'authenticated' => false,
]);