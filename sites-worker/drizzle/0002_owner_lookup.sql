CREATE INDEX IF NOT EXISTS native_profile_owner_login
ON native_documents (
  site,
  lower(COALESCE(json_extract(content, '$.owner.githubLogin'), json_extract(content, '$.owner.github_login'), json_extract(content, '$.owner.login'), ''))
)
WHERE namespace = 'data' AND is_deleted = 0
  AND (path GLOB 'people/ownership/*' OR path GLOB 'pets/ownership/*');
