<?php

declare(strict_types=1);

const GITHUB_STATISTICS_HOURLY_RETENTION_HOURS = 192;
const GITHUB_STATISTICS_DAILY_RETENTION_DAYS = 400;
const GITHUB_STATISTICS_SEARCH_QUERY_MAX_LENGTH = 80;
const GITHUB_STATISTICS_TOP_SEARCH_LIMIT = 100;
const GITHUB_STATISTICS_LEADERBOARD_LIMIT = 24;

function github_statistics_root_dir(): string
{
    static $resolved = null;
    if (is_string($resolved) && $resolved !== '') {
        return $resolved;
    }

    $relativeStats = github_statistics_workspace_relative_path();
    $candidates = github_statistics_root_dir_candidates($relativeStats);
    $seen = [];

    foreach ($candidates as $candidate) {
        $path = rtrim(str_replace('\\', '/', (string) $candidate), '/');
        if ($path === '' || isset($seen[$path])) {
            continue;
        }
        $seen[$path] = true;

        if (is_dir($path)) {
            $resolved = $path;
            return $resolved;
        }

        $parent = dirname($path);
        if (is_dir($parent) && is_writable($parent)) {
            $resolved = $path;
            return $resolved;
        }
    }

    throw new RuntimeException(
        'Could not locate the Genepedia statistics directory at '
        . $relativeStats
        . '. Ensure the API can reach the Genepedia site checkout on disk.'
    );
}

function github_statistics_root_dir_candidates(string $relativeStats): array
{
    $candidates = [];
    $apiDir = realpath(__DIR__);
    if ($apiDir === false) {
        $apiDir = __DIR__;
    }

    $remember = static function (string $path) use (&$candidates): void {
        $normalized = rtrim(str_replace('\\', '/', $path), '/');
        if ($normalized !== '') {
            $candidates[] = $normalized;
        }
    };

    $remember(github_resolve_api_path('../Genepedia/' . $relativeStats));

    $dir = $apiDir;
    while ($dir !== false) {
        if (is_file($dir . '/site-info.js') || is_dir($dir . '/data/Genepedia-Database/people')) {
            $remember($dir . '/' . $relativeStats);
        }

        if (is_file($dir . '/people/manifest.json')) {
            $remember($dir . '/statistics');
        }

        $parent = dirname($dir);
        if ($parent === $dir) {
            break;
        }
        $dir = $parent;
    }

    $parentDir = dirname($apiDir);
    foreach (['Genepedia', 'genepedia'] as $siteDirName) {
        $remember($parentDir . '/' . $siteDirName . '/' . $relativeStats);
    }

    $grandparentDir = dirname($parentDir);
    if ($grandparentDir !== $parentDir) {
        foreach (['Genepedia', 'genepedia'] as $siteDirName) {
            $remember($grandparentDir . '/' . $siteDirName . '/' . $relativeStats);
        }
    }

    $documentRoot = realpath((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''));
    if (is_string($documentRoot) && $documentRoot !== '') {
        $remember($documentRoot . '/' . $relativeStats);

        $documentParent = dirname($documentRoot);
        if ($documentParent !== $documentRoot) {
            foreach (['Genepedia', 'genepedia', ''] as $siteDirName) {
                $base = $siteDirName === '' ? $documentParent : $documentParent . '/' . $siteDirName;
                $remember($base . '/' . $relativeStats);
            }
        }
    }

    return $candidates;
}

function github_statistics_workspace_relative_path(string $file = ''): string
{
    $clean = ltrim(str_replace('\\', '/', trim($file)), '/');
    if ($clean === '') {
        return github_people_db_submodule_path() . '/statistics';
    }

    return github_people_db_submodule_path() . '/statistics/' . $clean;
}

function github_statistics_ensure_root(): string
{
    $root = github_statistics_root_dir();
    if (!is_dir($root) && !mkdir($root, 0775, true) && !is_dir($root)) {
        throw new RuntimeException('Could not create the statistics directory.');
    }

    return $root;
}

function github_statistics_file_path(string $filename): string
{
    $clean = ltrim(str_replace('\\', '/', trim($filename)), '/');
    if ($clean === '' || str_contains($clean, '..') || !preg_match('/^[a-z0-9][a-z0-9._-]*\.json$/i', $clean)) {
        throw new InvalidArgumentException('Invalid statistics filename.');
    }

    return github_statistics_ensure_root() . '/' . $clean;
}

function github_statistics_read_json(string $filename, callable $defaultFactory): array
{
    $path = github_statistics_file_path($filename);
    if (!is_readable($path)) {
        return $defaultFactory();
    }

    $decoded = json_decode((string) file_get_contents($path), true);
    if (!is_array($decoded)) {
        return $defaultFactory();
    }

    return $decoded;
}

function github_statistics_write_json(string $filename, array $data): void
{
    $path = github_statistics_file_path($filename);
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
    if (file_put_contents($path, $json, LOCK_EX) === false) {
        throw new RuntimeException('Could not save statistics file: ' . $filename);
    }
}

function github_statistics_mutate_json(string $filename, callable $defaultFactory, callable $mutator): array
{
    $path = github_statistics_file_path($filename);
    github_statistics_ensure_root();
    $handle = fopen($path, 'c+');
    if ($handle === false) {
        throw new RuntimeException('Could not open statistics file: ' . $filename);
    }

    try {
        if (!flock($handle, LOCK_EX)) {
            throw new RuntimeException('Could not lock statistics file: ' . $filename);
        }

        $contents = stream_get_contents($handle);
        $data = is_string($contents) && trim($contents) !== ''
            ? json_decode($contents, true)
            : null;
        if (!is_array($data)) {
            $data = $defaultFactory();
        }

        $result = $mutator($data);
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
        ftruncate($handle, 0);
        rewind($handle);
        if (fwrite($handle, $json) === false) {
            throw new RuntimeException('Could not write statistics file: ' . $filename);
        }
        fflush($handle);
        flock($handle, LOCK_UN);

        return is_array($result) ? $result : [];
    } finally {
        fclose($handle);
    }
}

function github_statistics_now(): string
{
    return gmdate('c');
}

function github_statistics_today_key(): string
{
    return gmdate('Y-m-d');
}

function github_statistics_hour_key(?int $timestamp = null): string
{
    return gmdate('Y-m-d\TH', $timestamp ?? time());
}

function github_statistics_window_definitions(): array
{
    return [
        '24h' => 24,
        '3d' => 72,
        '7d' => 168,
        '30d' => 720,
        '60d' => 1440,
        '90d' => 2160,
        '6m' => 183 * 24,
        '1y' => 365 * 24,
    ];
}

function github_statistics_window_keys(): array
{
    return [...array_keys(github_statistics_window_definitions()), 'all'];
}

function github_statistics_normalize_window(string $window): string
{
    $normalized = strtolower(trim($window));
    if ($normalized === '' || $normalized === 'all' || $normalized === 'all_time') {
        return 'all';
    }

    if (!array_key_exists($normalized, github_statistics_window_definitions())) {
        throw new InvalidArgumentException('Unsupported statistics window: ' . $window);
    }

    return $normalized;
}

function github_statistics_window_hours(string $window): ?int
{
    $normalized = github_statistics_normalize_window($window);
    if ($normalized === 'all') {
        return null;
    }

    return github_statistics_window_definitions()[$normalized];
}

function github_statistics_floor_to_hour(int $timestamp): int
{
    return (int) (floor($timestamp / 3600) * 3600);
}

function github_statistics_floor_to_day(int $timestamp): int
{
    return (int) (floor($timestamp / 86400) * 86400);
}

function github_normalize_profile_kind(string $kind): string
{
    return strtolower(trim($kind)) === 'pet' ? 'pet' : 'person';
}

function github_profile_view_key(string $kind, string $personId): string
{
    return github_normalize_profile_kind($kind) . ':' . $personId;
}

function github_normalize_search_query(string $query): string
{
    $normalized = strtolower(trim(preg_replace('/\s+/u', ' ', $query) ?? ''));
    if ($normalized === '') {
        return '';
    }

    return mb_substr($normalized, 0, GITHUB_STATISTICS_SEARCH_QUERY_MAX_LENGTH);
}

function github_default_profile_views_store(): array
{
    return [
        'schema' => 'genepedia/statistics/profile-views@2',
        'updatedAt' => github_statistics_now(),
        'profiles' => [],
    ];
}

function github_normalize_profile_views_store(array $store): array
{
    if (isset($store['profiles']) && is_array($store['profiles'])) {
        if (!isset($store['schema'])) {
            $store['schema'] = 'genepedia/statistics/profile-views@2';
        }

        return $store;
    }

    $profiles = [];
    $legacyViews = is_array($store['views'] ?? null) ? $store['views'] : [];
    $fallbackTime = (string) ($store['updatedAt'] ?? github_statistics_now());
    foreach ($legacyViews as $key => $count) {
        $profiles[(string) $key] = [
            'views' => max(0, (int) $count),
            'firstViewedAt' => $fallbackTime,
            'lastViewedAt' => $fallbackTime,
        ];
    }

    return [
        'schema' => 'genepedia/statistics/profile-views@2',
        'updatedAt' => $fallbackTime,
        'profiles' => $profiles,
    ];
}

function github_read_profile_views_store(): array
{
    $store = github_statistics_read_json('profile-views.json', 'github_default_profile_views_store');
    return github_normalize_profile_views_store($store);
}

function github_default_search_queries_store(): array
{
    return [
        'schema' => 'genepedia/statistics/search-queries@1',
        'updatedAt' => github_statistics_now(),
        'queries' => [],
    ];
}

function github_read_search_queries_store(): array
{
    $store = github_statistics_read_json('search-queries.json', 'github_default_search_queries_store');
    if (!isset($store['queries']) || !is_array($store['queries'])) {
        $store['queries'] = [];
    }

    return $store;
}

function github_default_daily_rollups_store(): array
{
    return [
        'schema' => 'genepedia/statistics/daily-rollups@2',
        'updatedAt' => github_statistics_now(),
        'days' => [],
    ];
}

function github_default_hourly_rollups_store(): array
{
    return [
        'schema' => 'genepedia/statistics/hourly-rollups@1',
        'updatedAt' => github_statistics_now(),
        'hours' => [],
    ];
}

function github_read_hourly_rollups_store(): array
{
    $store = github_statistics_read_json('hourly-rollups.json', 'github_default_hourly_rollups_store');
    if (!isset($store['hours']) || !is_array($store['hours'])) {
        $store['hours'] = [];
    }

    return $store;
}

function github_prune_hourly_rollups(array &$store): void
{
    if (!isset($store['hours']) || !is_array($store['hours'])) {
        $store['hours'] = [];
        return;
    }

    $cutoff = github_statistics_hour_key(time() - (GITHUB_STATISTICS_HOURLY_RETENTION_HOURS * 3600));
    foreach (array_keys($store['hours']) as $hour) {
        if ((string) $hour < $cutoff) {
            unset($store['hours'][$hour]);
        }
    }
}

function github_ensure_hourly_bucket(array &$store, string $hour): array
{
    if (!isset($store['hours'][$hour]) || !is_array($store['hours'][$hour])) {
        $store['hours'][$hour] = [
            'profileViews' => 0,
            'searches' => 0,
            'profiles' => [],
            'queries' => [],
        ];
    }

    if (!isset($store['hours'][$hour]['profiles']) || !is_array($store['hours'][$hour]['profiles'])) {
        $store['hours'][$hour]['profiles'] = [];
    }

    if (!isset($store['hours'][$hour]['queries']) || !is_array($store['hours'][$hour]['queries'])) {
        $store['hours'][$hour]['queries'] = [];
    }

    return $store['hours'][$hour];
}

function github_statistics_touch_hourly_profile_view(array &$store, string $profileKey): void
{
    $hour = github_statistics_hour_key();
    github_prune_hourly_rollups($store);
    $bucket = github_ensure_hourly_bucket($store, $hour);
    $bucket['profileViews'] = max(0, (int) ($bucket['profileViews'] ?? 0)) + 1;
    $bucket['profiles'][$profileKey] = max(0, (int) ($bucket['profiles'][$profileKey] ?? 0)) + 1;
    $store['hours'][$hour] = $bucket;
    $store['updatedAt'] = github_statistics_now();
}

function github_statistics_touch_hourly_search(array &$store, string $queryKey): void
{
    $hour = github_statistics_hour_key();
    github_prune_hourly_rollups($store);
    $bucket = github_ensure_hourly_bucket($store, $hour);
    $bucket['searches'] = max(0, (int) ($bucket['searches'] ?? 0)) + 1;
    $bucket['queries'][$queryKey] = max(0, (int) ($bucket['queries'][$queryKey] ?? 0)) + 1;
    $store['hours'][$hour] = $bucket;
    $store['updatedAt'] = github_statistics_now();
}

function github_read_daily_rollups_store(): array
{
    $store = github_statistics_read_json('daily-rollups.json', 'github_default_daily_rollups_store');
    if (!isset($store['days']) || !is_array($store['days'])) {
        $store['days'] = [];
    }

    return $store;
}

function github_statistics_merge_count_map(array &$target, array $source): void
{
    foreach ($source as $key => $count) {
        $label = trim((string) $key);
        if ($label === '') {
            continue;
        }

        $target[$label] = max(0, (int) ($target[$label] ?? 0)) + max(0, (int) $count);
    }
}

function github_statistics_aggregate_profile_counts_in_window(array $hourlyStore, array $dailyStore, int $windowHours): array
{
    $now = time();
    $cutoff = $now - ($windowHours * 3600);
    $hourlyZoneStart = $now - (GITHUB_STATISTICS_HOURLY_RETENTION_HOURS * 3600);
    $counts = [];

    $hourCursor = github_statistics_floor_to_hour((int) max($cutoff, $hourlyZoneStart));
    while ($hourCursor <= $now) {
        $hourKey = github_statistics_hour_key($hourCursor);
        $bucket = is_array($hourlyStore['hours'][$hourKey] ?? null) ? $hourlyStore['hours'][$hourKey] : null;
        if ($bucket !== null) {
            github_statistics_merge_count_map($counts, is_array($bucket['profiles'] ?? null) ? $bucket['profiles'] : []);
        }
        $hourCursor += 3600;
    }

    if ($cutoff >= $hourlyZoneStart) {
        return $counts;
    }

    $dailyOnlyEnd = github_statistics_floor_to_day($hourlyZoneStart) - 86400;
    $dayCursor = github_statistics_floor_to_day($cutoff);
    while ($dayCursor <= $dailyOnlyEnd) {
        $dayKey = gmdate('Y-m-d', $dayCursor);
        $bucket = is_array($dailyStore['days'][$dayKey] ?? null) ? $dailyStore['days'][$dayKey] : null;
        if ($bucket !== null) {
            github_statistics_merge_count_map($counts, is_array($bucket['profiles'] ?? null) ? $bucket['profiles'] : []);
        }
        $dayCursor += 86400;
    }

    return $counts;
}

function github_statistics_aggregate_query_counts_in_window(array $hourlyStore, array $dailyStore, int $windowHours): array
{
    $now = time();
    $cutoff = $now - ($windowHours * 3600);
    $hourlyZoneStart = $now - (GITHUB_STATISTICS_HOURLY_RETENTION_HOURS * 3600);
    $counts = [];

    $hourCursor = github_statistics_floor_to_hour((int) max($cutoff, $hourlyZoneStart));
    while ($hourCursor <= $now) {
        $hourKey = github_statistics_hour_key($hourCursor);
        $bucket = is_array($hourlyStore['hours'][$hourKey] ?? null) ? $hourlyStore['hours'][$hourKey] : null;
        if ($bucket !== null) {
            github_statistics_merge_count_map($counts, is_array($bucket['queries'] ?? null) ? $bucket['queries'] : []);
        }
        $hourCursor += 3600;
    }

    if ($cutoff >= $hourlyZoneStart) {
        return $counts;
    }

    $dailyOnlyEnd = github_statistics_floor_to_day($hourlyZoneStart) - 86400;
    $dayCursor = github_statistics_floor_to_day($cutoff);
    while ($dayCursor <= $dailyOnlyEnd) {
        $dayKey = gmdate('Y-m-d', $dayCursor);
        $bucket = is_array($dailyStore['days'][$dayKey] ?? null) ? $dailyStore['days'][$dayKey] : null;
        if ($bucket !== null) {
            github_statistics_merge_count_map($counts, is_array($bucket['queries'] ?? null) ? $bucket['queries'] : []);
        }
        $dayCursor += 86400;
    }

    return $counts;
}

function github_statistics_format_profile_leaderboard(array $counts, int $limit): array
{
    $limit = max(1, min(GITHUB_STATISTICS_LEADERBOARD_LIMIT, $limit));
    arsort($counts, SORT_NUMERIC);

    $results = [];
    foreach ($counts as $key => $count) {
        $parts = explode(':', (string) $key, 2);
        if (count($parts) !== 2) {
            continue;
        }

        [$kind, $profileId] = $parts;
        $profileId = github_validate_person_id($profileId);
        if ($profileId === null) {
            continue;
        }

        $results[] = [
            'kind' => github_normalize_profile_kind($kind),
            'person_id' => $profileId,
            'views' => max(0, (int) $count),
        ];

        if (count($results) >= $limit) {
            break;
        }
    }

    return $results;
}

function github_statistics_format_search_leaderboard(array $counts, int $limit): array
{
    $limit = max(1, min(GITHUB_STATISTICS_LEADERBOARD_LIMIT, $limit));
    arsort($counts, SORT_NUMERIC);

    $results = [];
    foreach ($counts as $query => $count) {
        $label = trim((string) $query);
        if ($label === '') {
            continue;
        }

        $results[] = [
            'query' => $label,
            'count' => max(0, (int) $count),
        ];

        if (count($results) >= $limit) {
            break;
        }
    }

    return $results;
}

function github_prune_daily_rollups(array &$store): void
{
    if (!isset($store['days']) || !is_array($store['days'])) {
        $store['days'] = [];
        return;
    }

    $cutoff = gmdate('Y-m-d', time() - (GITHUB_STATISTICS_DAILY_RETENTION_DAYS * 86400));
    foreach (array_keys($store['days']) as $day) {
        if ((string) $day < $cutoff) {
            unset($store['days'][$day]);
        }
    }
}

function github_ensure_daily_bucket(array &$store, string $day): array
{
    if (!isset($store['days'][$day]) || !is_array($store['days'][$day])) {
        $store['days'][$day] = [
            'profileViews' => 0,
            'searches' => 0,
            'profiles' => [],
            'queries' => [],
        ];
    }

    if (!isset($store['days'][$day]['profiles']) || !is_array($store['days'][$day]['profiles'])) {
        $store['days'][$day]['profiles'] = [];
    }

    if (!isset($store['days'][$day]['queries']) || !is_array($store['days'][$day]['queries'])) {
        $store['days'][$day]['queries'] = [];
    }

    return $store['days'][$day];
}

function github_statistics_touch_daily_profile_view(array &$store, string $profileKey): void
{
    $day = github_statistics_today_key();
    github_prune_daily_rollups($store);
    $bucket = github_ensure_daily_bucket($store, $day);
    $bucket['profileViews'] = max(0, (int) ($bucket['profileViews'] ?? 0)) + 1;
    $bucket['profiles'][$profileKey] = max(0, (int) ($bucket['profiles'][$profileKey] ?? 0)) + 1;
    $store['days'][$day] = $bucket;
    $store['updatedAt'] = github_statistics_now();
}

function github_statistics_touch_daily_search(array &$store, string $queryKey): void
{
    $day = github_statistics_today_key();
    github_prune_daily_rollups($store);
    $bucket = github_ensure_daily_bucket($store, $day);
    $bucket['searches'] = max(0, (int) ($bucket['searches'] ?? 0)) + 1;
    $bucket['queries'][$queryKey] = max(0, (int) ($bucket['queries'][$queryKey] ?? 0)) + 1;
    $store['days'][$day] = $bucket;
    $store['updatedAt'] = github_statistics_now();
}

function github_build_statistics_leaderboards(int $limit = 8): array
{
    $limit = max(1, min(GITHUB_STATISTICS_LEADERBOARD_LIMIT, $limit));
    $hourlyRollups = github_read_hourly_rollups_store();
    $dailyRollups = github_read_daily_rollups_store();
    $profileViews = github_read_profile_views_store();
    $searchQueries = github_read_search_queries_store();

    $allTimeProfileCounts = [];
    foreach (is_array($profileViews['profiles'] ?? null) ? $profileViews['profiles'] : [] as $key => $entry) {
        $allTimeProfileCounts[(string) $key] = max(0, (int) ($entry['views'] ?? 0));
    }

    $allTimeQueryCounts = [];
    foreach (is_array($searchQueries['queries'] ?? null) ? $searchQueries['queries'] : [] as $query => $entry) {
        $allTimeQueryCounts[(string) $query] = max(0, (int) ($entry['count'] ?? 0));
    }

    $profiles = [];
    $searches = [];
    foreach (github_statistics_window_keys() as $window) {
        if ($window === 'all') {
            $profiles[$window] = github_statistics_format_profile_leaderboard($allTimeProfileCounts, $limit);
            $searches[$window] = github_statistics_format_search_leaderboard($allTimeQueryCounts, $limit);
            continue;
        }

        $windowHours = github_statistics_window_hours($window);
        if ($windowHours === null) {
            continue;
        }

        $profileCounts = github_statistics_aggregate_profile_counts_in_window($hourlyRollups, $dailyRollups, $windowHours);
        $queryCounts = github_statistics_aggregate_query_counts_in_window($hourlyRollups, $dailyRollups, $windowHours);
        $profiles[$window] = github_statistics_format_profile_leaderboard($profileCounts, $limit);
        $searches[$window] = github_statistics_format_search_leaderboard($queryCounts, $limit);
    }

    return [
        'schema' => 'genepedia/statistics/leaderboards@1',
        'generatedAt' => github_statistics_now(),
        'windows' => github_statistics_window_keys(),
        'profiles' => $profiles,
        'searches' => $searches,
    ];
}

function github_read_statistics_leaderboards(): array
{
    $leaderboards = github_statistics_read_json('leaderboards.json', static function (): array {
        return [];
    });

    if (!isset($leaderboards['profiles']) || !is_array($leaderboards['profiles'])) {
        github_statistics_refresh_derived_files();
        return github_statistics_read_json('leaderboards.json', static fn (): array => github_build_statistics_leaderboards());
    }

    return $leaderboards;
}

function github_statistics_refresh_derived_files(): void
{
    $profileViews = github_read_profile_views_store();
    $searchQueries = github_read_search_queries_store();
    $dailyRollups = github_read_daily_rollups_store();
    $hourlyRollups = github_read_hourly_rollups_store();
    $leaderboards = github_build_statistics_leaderboards(GITHUB_STATISTICS_LEADERBOARD_LIMIT);
    $now = github_statistics_now();
    $today = github_statistics_today_key();

    $totalProfileViews = 0;
    foreach (($profileViews['profiles'] ?? []) as $entry) {
        $totalProfileViews += max(0, (int) ($entry['views'] ?? 0));
    }

    $totalSearches = 0;
    foreach (($searchQueries['queries'] ?? []) as $entry) {
        $totalSearches += max(0, (int) ($entry['count'] ?? 0));
    }

    $summary = [
        'schema' => 'genepedia/statistics/summary@2',
        'generatedAt' => $now,
        'windows' => github_statistics_window_keys(),
        'totals' => [
            'profileViews' => $totalProfileViews,
            'searches' => $totalSearches,
            'profilesTracked' => count($profileViews['profiles'] ?? []),
            'queriesTracked' => count($searchQueries['queries'] ?? []),
        ],
        'today' => [
            'date' => $today,
            'profileViews' => max(0, (int) ($dailyRollups['days'][$today]['profileViews'] ?? 0)),
            'searches' => max(0, (int) ($dailyRollups['days'][$today]['searches'] ?? 0)),
        ],
        'popularProfiles' => $leaderboards['profiles']['all'] ?? github_popular_profiles(8),
        'popularSearches' => $leaderboards['searches']['all'] ?? github_popular_searches(8),
        'leaderboards' => [
            'profiles' => $leaderboards['profiles'],
            'searches' => $leaderboards['searches'],
        ],
    ];

    $manifest = [
        'schema' => 'genepedia/statistics/manifest@2',
        'updatedAt' => $now,
        'windows' => github_statistics_window_keys(),
        'files' => [
            'profile-views.json' => [
                'schema' => (string) ($profileViews['schema'] ?? 'genepedia/statistics/profile-views@2'),
                'updatedAt' => (string) ($profileViews['updatedAt'] ?? $now),
            ],
            'search-queries.json' => [
                'schema' => (string) ($searchQueries['schema'] ?? 'genepedia/statistics/search-queries@1'),
                'updatedAt' => (string) ($searchQueries['updatedAt'] ?? $now),
            ],
            'hourly-rollups.json' => [
                'schema' => (string) ($hourlyRollups['schema'] ?? 'genepedia/statistics/hourly-rollups@1'),
                'updatedAt' => (string) ($hourlyRollups['updatedAt'] ?? $now),
            ],
            'daily-rollups.json' => [
                'schema' => (string) ($dailyRollups['schema'] ?? 'genepedia/statistics/daily-rollups@2'),
                'updatedAt' => (string) ($dailyRollups['updatedAt'] ?? $now),
            ],
            'leaderboards.json' => [
                'schema' => 'genepedia/statistics/leaderboards@1',
                'updatedAt' => $now,
            ],
            'summary.json' => [
                'schema' => 'genepedia/statistics/summary@2',
                'updatedAt' => $now,
            ],
        ],
    ];

    github_statistics_write_json('leaderboards.json', $leaderboards);
    github_statistics_write_json('summary.json', $summary);
    github_statistics_write_json('manifest.json', $manifest);
}

function github_statistics_publish_filenames(): array
{
    return [
        'profile-views.json',
        'search-queries.json',
        'hourly-rollups.json',
        'daily-rollups.json',
        'leaderboards.json',
        'summary.json',
        'manifest.json',
    ];
}

function github_statistics_collect_publish_files(): array
{
    $files = [];
    foreach (github_statistics_publish_filenames() as $filename) {
        $path = github_statistics_file_path($filename);
        if (!is_readable($path)) {
            continue;
        }

        $content = file_get_contents($path);
        if (!is_string($content)) {
            continue;
        }

        $files[] = [
            'path' => github_statistics_workspace_relative_path($filename),
            'content' => $content,
        ];
    }

    return $files;
}

function github_statistics_resolve_publish_editor(): array
{
    $user = github_current_user();
    $token = github_session_access_token();
    if (is_array($user) && $token !== '') {
        return [
            'source' => 'user',
            'user' => $user,
            'token' => $token,
        ];
    }

    if (!github_app_configured()) {
        throw new RuntimeException('GitHub App authentication is required to record anonymous statistics.');
    }

    return [
        'source' => 'github_app',
        'user' => github_app_statistics_actor(),
        'token' => github_fetch_installation_access_token(true),
    ];
}

function github_statistics_build_sync_commit_message(string $event, array $editor, array $context = []): string
{
    $login = trim((string) ($editor['user']['login'] ?? ''));
    $actorLabel = ($editor['source'] ?? '') === 'user'
        ? ($login !== '' ? '@' . $login : 'signed-in user')
        : trim((string) ($editor['user']['displayName'] ?? 'Genepedia[bot]'));

    $detail = '';
    if (($context['kind'] ?? '') !== '' && ($context['person_id'] ?? '') !== '') {
        $detail = github_profile_view_key((string) $context['kind'], (string) $context['person_id']);
    } elseif (trim((string) ($context['query'] ?? '')) !== '') {
        $detail = '"' . trim((string) $context['query']) . '"';
    }

    $message = 'statistics: ' . trim($event);
    if ($detail !== '') {
        $message .= ' ' . $detail;
    }

    return $message . ' (' . $actorLabel . ')';
}

function github_statistics_sync_to_repository(string $event, array $context = []): array
{
    if (trim(github_env_value('GITHUB_STATISTICS_SYNC')) === '0') {
        return [
            'synced' => false,
            'skipped' => 'disabled',
        ];
    }

    try {
        github_start_session();
        $editor = github_statistics_resolve_publish_editor();
        $files = github_statistics_collect_publish_files();
        if ($files === []) {
            return [
                'synced' => false,
                'skipped' => 'no_files',
                'source' => $editor['source'],
            ];
        }

        $repoConfig = github_repo_config();
        $commitMessage = github_statistics_build_sync_commit_message($event, $editor, $context);
        $publish = github_commit_files_to_default_branch_with_token(
            $editor['token'],
            $repoConfig['owner'],
            $repoConfig['repo'],
            $files,
            [
                'user' => $editor['user'],
                'token' => $editor['token'],
            ],
            $commitMessage,
        );

        return [
            'synced' => true,
            'source' => $editor['source'],
            'repo' => $repoConfig['owner'] . '/' . $repoConfig['repo'],
            'commit' => $publish['commit'] ?? null,
        ];
    } catch (Throwable $error) {
        return [
            'synced' => false,
            'source' => isset($editor) && is_array($editor) ? ($editor['source'] ?? null) : null,
            'error' => $error->getMessage(),
        ];
    }
}

function github_increment_profile_view(string $kind, string $personId): array
{
    $now = github_statistics_now();
    $key = github_profile_view_key($kind, $personId);

    $result = github_statistics_mutate_json(
        'profile-views.json',
        'github_default_profile_views_store',
        static function (array &$store) use ($key, $now): array {
            $store = github_normalize_profile_views_store($store);
            if (!isset($store['profiles'][$key]) || !is_array($store['profiles'][$key])) {
                $store['profiles'][$key] = [
                    'views' => 0,
                    'firstViewedAt' => $now,
                    'lastViewedAt' => $now,
                ];
            }

            $store['profiles'][$key]['views'] = max(0, (int) ($store['profiles'][$key]['views'] ?? 0)) + 1;
            $store['profiles'][$key]['lastViewedAt'] = $now;
            $store['updatedAt'] = $now;
            $store['schema'] = 'genepedia/statistics/profile-views@2';

            return [
                'key' => $key,
                'kind' => explode(':', $key, 2)[0],
                'person_id' => explode(':', $key, 2)[1],
                'views' => (int) $store['profiles'][$key]['views'],
                'last_viewed_at' => $now,
            ];
        },
    );

    github_statistics_mutate_json(
        'daily-rollups.json',
        'github_default_daily_rollups_store',
        static function (array &$store) use ($key): array {
            github_statistics_touch_daily_profile_view($store, $key);
            $store['schema'] = 'genepedia/statistics/daily-rollups@2';
            return [];
        },
    );

    github_statistics_mutate_json(
        'hourly-rollups.json',
        'github_default_hourly_rollups_store',
        static function (array &$store) use ($key): array {
            github_statistics_touch_hourly_profile_view($store, $key);
            $store['schema'] = 'genepedia/statistics/hourly-rollups@1';
            return [];
        },
    );

    github_statistics_refresh_derived_files();

    return $result;
}

function github_record_search_query(string $query, int $resultCount = 0): array
{
    $normalized = github_normalize_search_query($query);
    if ($normalized === '') {
        throw new InvalidArgumentException('A non-empty search query is required.');
    }

    $now = github_statistics_now();

    $result = github_statistics_mutate_json(
        'search-queries.json',
        'github_default_search_queries_store',
        static function (array &$store) use ($normalized, $now, $resultCount): array {
            if (!isset($store['queries'][$normalized]) || !is_array($store['queries'][$normalized])) {
                $store['queries'][$normalized] = [
                    'count' => 0,
                    'firstSearchedAt' => $now,
                    'lastSearchedAt' => $now,
                    'lastResultCount' => 0,
                ];
            }

            $store['queries'][$normalized]['count'] = max(0, (int) ($store['queries'][$normalized]['count'] ?? 0)) + 1;
            $store['queries'][$normalized]['lastSearchedAt'] = $now;
            $store['queries'][$normalized]['lastResultCount'] = max(0, $resultCount);
            $store['updatedAt'] = $now;
            $store['schema'] = 'genepedia/statistics/search-queries@1';

            if (count($store['queries']) > GITHUB_STATISTICS_TOP_SEARCH_LIMIT) {
                uasort($store['queries'], static fn (array $a, array $b): int => (
                    ((int) ($b['count'] ?? 0)) <=> ((int) ($a['count'] ?? 0))
                    ?: strcmp((string) ($a['lastSearchedAt'] ?? ''), (string) ($b['lastSearchedAt'] ?? ''))
                ));
                $store['queries'] = array_slice($store['queries'], 0, GITHUB_STATISTICS_TOP_SEARCH_LIMIT, true);
            }

            return [
                'query' => $normalized,
                'count' => (int) $store['queries'][$normalized]['count'],
                'last_result_count' => max(0, $resultCount),
                'last_searched_at' => $now,
            ];
        },
    );

    github_statistics_mutate_json(
        'daily-rollups.json',
        'github_default_daily_rollups_store',
        static function (array &$store) use ($normalized): array {
            github_statistics_touch_daily_search($store, $normalized);
            $store['schema'] = 'genepedia/statistics/daily-rollups@2';
            return [];
        },
    );

    github_statistics_mutate_json(
        'hourly-rollups.json',
        'github_default_hourly_rollups_store',
        static function (array &$store) use ($normalized): array {
            github_statistics_touch_hourly_search($store, $normalized);
            $store['schema'] = 'genepedia/statistics/hourly-rollups@1';
            return [];
        },
    );

    github_statistics_refresh_derived_files();

    return $result;
}

function github_popular_profiles(int $limit = 4, string $window = 'all'): array
{
    $limit = max(1, min(GITHUB_STATISTICS_LEADERBOARD_LIMIT, $limit));
    $window = github_statistics_normalize_window($window);

    if ($window === 'all') {
        $store = github_read_profile_views_store();
        $profiles = is_array($store['profiles'] ?? null) ? $store['profiles'] : [];

        uasort($profiles, static function (array $a, array $b): int {
            $viewsCompare = ((int) ($b['views'] ?? 0)) <=> ((int) ($a['views'] ?? 0));
            if ($viewsCompare !== 0) {
                return $viewsCompare;
            }

            return strcmp((string) ($b['lastViewedAt'] ?? ''), (string) ($a['lastViewedAt'] ?? ''));
        });

        $counts = [];
        foreach ($profiles as $key => $entry) {
            $counts[(string) $key] = max(0, (int) ($entry['views'] ?? 0));
        }

        $results = github_statistics_format_profile_leaderboard($counts, $limit);
        foreach ($results as &$entry) {
            $profileKey = github_profile_view_key((string) ($entry['kind'] ?? 'person'), (string) ($entry['person_id'] ?? ''));
            $entry['last_viewed_at'] = (string) ($profiles[$profileKey]['lastViewedAt'] ?? '');
        }
        unset($entry);

        return $results;
    }

    $windowHours = github_statistics_window_hours($window);
    if ($windowHours === null) {
        return [];
    }

    $leaderboards = github_read_statistics_leaderboards();
    $cached = $leaderboards['profiles'][$window] ?? null;
    if (is_array($cached) && $cached !== []) {
        return array_slice($cached, 0, $limit);
    }

    $hourlyRollups = github_read_hourly_rollups_store();
    $dailyRollups = github_read_daily_rollups_store();
    $counts = github_statistics_aggregate_profile_counts_in_window($hourlyRollups, $dailyRollups, $windowHours);

    return github_statistics_format_profile_leaderboard($counts, $limit);
}

function github_popular_searches(int $limit = 8, string $window = 'all'): array
{
    $limit = max(1, min(GITHUB_STATISTICS_LEADERBOARD_LIMIT, $limit));
    $window = github_statistics_normalize_window($window);

    if ($window === 'all') {
        $store = github_read_search_queries_store();
        $queries = is_array($store['queries'] ?? null) ? $store['queries'] : [];

        uasort($queries, static function (array $a, array $b): int {
            $countCompare = ((int) ($b['count'] ?? 0)) <=> ((int) ($a['count'] ?? 0));
            if ($countCompare !== 0) {
                return $countCompare;
            }

            return strcmp((string) ($b['lastSearchedAt'] ?? ''), (string) ($a['lastSearchedAt'] ?? ''));
        });

        $counts = [];
        foreach ($queries as $query => $entry) {
            $counts[(string) $query] = max(0, (int) ($entry['count'] ?? 0));
        }

        $results = github_statistics_format_search_leaderboard($counts, $limit);
        foreach ($results as &$entry) {
            $query = (string) ($entry['query'] ?? '');
            $entry['last_result_count'] = max(0, (int) ($queries[$query]['lastResultCount'] ?? 0));
            $entry['last_searched_at'] = (string) ($queries[$query]['lastSearchedAt'] ?? '');
        }
        unset($entry);

        return $results;
    }

    $windowHours = github_statistics_window_hours($window);
    if ($windowHours === null) {
        return [];
    }

    $leaderboards = github_read_statistics_leaderboards();
    $cached = $leaderboards['searches'][$window] ?? null;
    if (is_array($cached) && $cached !== []) {
        return array_slice($cached, 0, $limit);
    }

    $hourlyRollups = github_read_hourly_rollups_store();
    $dailyRollups = github_read_daily_rollups_store();
    $counts = github_statistics_aggregate_query_counts_in_window($hourlyRollups, $dailyRollups, $windowHours);

    return github_statistics_format_search_leaderboard($counts, $limit);
}

function github_read_statistics_summary(): array
{
    $summary = github_statistics_read_json('summary.json', static function (): array {
        github_statistics_refresh_derived_files();
        return github_statistics_read_json('summary.json', static fn (): array => [
            'schema' => 'genepedia/statistics/summary@2',
            'generatedAt' => github_statistics_now(),
            'windows' => github_statistics_window_keys(),
            'totals' => [
                'profileViews' => 0,
                'searches' => 0,
                'profilesTracked' => 0,
                'queriesTracked' => 0,
            ],
            'today' => [
                'date' => github_statistics_today_key(),
                'profileViews' => 0,
                'searches' => 0,
            ],
            'popularProfiles' => [],
            'popularSearches' => [],
            'leaderboards' => [
                'profiles' => [],
                'searches' => [],
            ],
        ]);
    });

    if (!isset($summary['totals']) || !is_array($summary['totals'])) {
        github_statistics_refresh_derived_files();
        return github_read_statistics_summary();
    }

    return $summary;
}

function github_handle_statistics_event(array $payload): array
{
    $event = strtolower(trim((string) ($payload['event'] ?? $payload['action'] ?? 'profile_view')));

    if ($event === 'search' || $event === 'search_query') {
        $search = github_record_search_query(
            (string) ($payload['query'] ?? $payload['q'] ?? ''),
            max(0, (int) ($payload['result_count'] ?? $payload['results'] ?? 0)),
        );

        return [
            'event' => 'search',
            'search' => $search,
            'publish' => github_statistics_sync_to_repository('search', [
                'query' => (string) ($search['query'] ?? ''),
            ]),
        ];
    }

    $personId = github_validate_person_id((string) ($payload['person_id'] ?? $payload['person'] ?? ''));
    if ($personId === null) {
        throw new InvalidArgumentException('A valid profile id is required.');
    }

    $kind = github_normalize_profile_kind((string) ($payload['kind'] ?? 'person'));
    $profile = github_increment_profile_view($kind, $personId);

    return [
        'event' => 'profile_view',
        'profile' => $profile,
        'publish' => github_statistics_sync_to_repository('profile view', [
            'kind' => $kind,
            'person_id' => $personId,
        ]),
    ];
}
