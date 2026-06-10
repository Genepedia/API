<?php

declare(strict_types=1);

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Accept, Content-Type');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($method !== 'GET') {
    http_response_code(405);
    echo json_encode([
        'ok' => false,
        'error' => 'method_not_allowed',
        'message' => 'Only GET and OPTIONS requests are supported.',
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

$query = trim((string) ($_GET['q'] ?? ''));
$limit = max(1, min(8, (int) ($_GET['limit'] ?? 6)));
$acceptLanguage = trim((string) ($_GET['accept_language'] ?? ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '')));
$acceptLanguage = preg_replace('/[^A-Za-z0-9,;=\-\s]/', '', $acceptLanguage) ?? '';

if ($query === '') {
    echo json_encode([
        'ok' => true,
        'query' => '',
        'results' => [],
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

if (strlen($query) < 2) {
    echo json_encode([
        'ok' => true,
        'query' => $query,
        'results' => [],
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

function location_search_first_non_empty(array $values): string
{
    foreach ($values as $value) {
        $text = trim((string) $value);
        if ($text !== '') {
            return $text;
        }
    }

    return '';
}

function location_search_normalize_result(array $entry): array
{
    $address = is_array($entry['address'] ?? null) ? $entry['address'] : [];

    $placeName = location_search_first_non_empty([
        $entry['name'] ?? '',
        $address['amenity'] ?? '',
        $address['tourism'] ?? '',
        $address['building'] ?? '',
        $address['hamlet'] ?? '',
        $address['village'] ?? '',
        $address['town'] ?? '',
        $address['city'] ?? '',
        $address['county'] ?? '',
        $address['state'] ?? '',
        $address['country'] ?? '',
    ]);

    $addressLine1 = trim(implode(' ', array_filter([
        trim((string) ($address['house_number'] ?? '')),
        location_search_first_non_empty([
            $address['road'] ?? '',
            $address['pedestrian'] ?? '',
            $address['footway'] ?? '',
            $address['path'] ?? '',
        ]),
    ], static fn ($part) => trim((string) $part) !== '')));

    $addressLine2 = location_search_first_non_empty([
        $address['suburb'] ?? '',
        $address['neighbourhood'] ?? '',
        $address['residential'] ?? '',
        $address['borough'] ?? '',
    ]);

    $addressLine3 = location_search_first_non_empty([
        $address['city_district'] ?? '',
        $address['district'] ?? '',
        $address['quarter'] ?? '',
    ]);

    $city = location_search_first_non_empty([
        $address['city'] ?? '',
        $address['town'] ?? '',
        $address['village'] ?? '',
        $address['hamlet'] ?? '',
        $address['municipality'] ?? '',
    ]);

    $county = location_search_first_non_empty([
        $address['county'] ?? '',
        $address['region'] ?? '',
    ]);

    $stateProvince = location_search_first_non_empty([
        $address['state'] ?? '',
        $address['province'] ?? '',
        $address['state_district'] ?? '',
    ]);

    $country = trim((string) ($address['country'] ?? ''));
    $countryCode = strtoupper(trim((string) ($address['country_code'] ?? '')));

    return [
        'id' => trim((string) (($entry['osm_type'] ?? '') . ':' . ($entry['osm_id'] ?? ''))),
        'label' => trim((string) ($entry['display_name'] ?? '')),
        'type' => trim((string) ($entry['type'] ?? '')),
        'location' => [
            'label' => trim((string) ($entry['display_name'] ?? '')),
            'placeName' => $placeName,
            'addressLine1' => $addressLine1,
            'addressLine2' => $addressLine2,
            'addressLine3' => $addressLine3,
            'city' => $city,
            'postalCode' => trim((string) ($address['postcode'] ?? '')),
            'county' => $county,
            'stateProvince' => $stateProvince,
            'country' => $country,
            'countryCode' => $countryCode,
            'latitude' => trim((string) ($entry['lat'] ?? '')),
            'longitude' => trim((string) ($entry['lon'] ?? '')),
            'source' => 'nominatim',
        ],
    ];
}

$params = [
    'format' => 'jsonv2',
    'addressdetails' => '1',
    'limit' => (string) $limit,
    'q' => $query,
];

if ($acceptLanguage !== '') {
    $params['accept-language'] = $acceptLanguage;
}

$url = 'https://nominatim.openstreetmap.org/search?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986);
$headers = [
    'Accept: application/json',
    'User-Agent: GenepediaLocationSearch/1.0 (+https://genepedia.org)',
];

$context = stream_context_create([
    'http' => [
        'method' => 'GET',
        'timeout' => 10,
        'ignore_errors' => true,
        'header' => implode("\r\n", $headers),
    ],
]);

$body = @file_get_contents($url, false, $context);
$statusLine = is_array($http_response_header ?? null) ? (string) ($http_response_header[0] ?? '') : '';
$status = preg_match('/\s(\d{3})\s/', $statusLine, $match) ? (int) $match[1] : 0;

if (!is_string($body) || $status < 200 || $status >= 300) {
    http_response_code(502);
    echo json_encode([
        'ok' => false,
        'error' => 'location_lookup_failed',
        'message' => 'Could not fetch location matches right now.',
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

$decoded = json_decode($body, true);
if (!is_array($decoded)) {
    http_response_code(502);
    echo json_encode([
        'ok' => false,
        'error' => 'invalid_location_response',
        'message' => 'The location service returned an unexpected response.',
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

$results = [];
foreach ($decoded as $entry) {
    if (!is_array($entry)) {
        continue;
    }
    $results[] = location_search_normalize_result($entry);
}

echo json_encode([
    'ok' => true,
    'query' => $query,
    'results' => $results,
], JSON_UNESCAPED_SLASHES);