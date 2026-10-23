const VALID_SITES = new Set(["genepedia", "gravepedia"]);
const VALID_NAMESPACES = new Set(["data", "content", "media"]);
const INLINE_JSON_LIMIT = 1_500_000;
const IMPORT_BODY_LIMIT = 4_000_000;
const IMPORT_RECORD_LIMIT = 50;
const MAX_FILES_PER_CHANGE = 100;
const DEFAULT_LIST_LIMIT = 100;

function nowIso() {
  return new Date().toISOString();
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashBytes(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function bytesFromBase64(value) {
  const binary = atob(String(value || "").replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64FromBytes(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function textFromBytes(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function hasUtf8Bom(bytes) {
  return bytes?.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function normalizeSite(site, ApiError) {
  const value = String(site || "").toLowerCase();
  if (!VALID_SITES.has(value)) throw new ApiError(400, "invalid_site", "A valid site is required.");
  return value;
}

function normalizeNamespace(namespace, ApiError) {
  const value = String(namespace || "").toLowerCase();
  if (!VALID_NAMESPACES.has(value)) throw new ApiError(400, "invalid_namespace", "Namespace must be data, content, or media.");
  return value;
}

function safePath(value, ApiError) {
  const path = String(value || "");
  if (!path || path.length > 500 || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new ApiError(400, "invalid_path", "The storage path is invalid.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.trim() !== part)) {
    throw new ApiError(400, "invalid_path", "The storage path is invalid.");
  }
  return path;
}

function normalizeLogin(actor) {
  return String(actor?.login || actor?.githubLogin || actor?.user?.login || actor?.actor_login || "system").trim().slice(0, 120) || "system";
}

function actorId(actor) {
  return String(actor?.id || actor?.user?.id || "").slice(0, 120);
}

  async function mapLimit(items, concurrency, callback) {
    const output = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        output[index] = await callback(items[index], index);
      }
    });
    await Promise.all(workers);
    return output;
  }

function validateSha(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function requestHeader(request, name) {
  return String(request.headers.get(name) || "").trim();
}

function jsonTry(value) {
  try { return JSON.parse(String(value || "")); } catch { return null; }
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    const ordered = Object.create(null);
    for (const key of Object.keys(value).sort()) ordered[key] = canonicalJsonValue(value[key]);
    return ordered;
  }
  return value;
}

function publicUrl(site, number) {
  const host = site === "gravepedia" ? "www.gravepedia.org" : "www.genepedia.org";
  return `https://${host}/pages/review_edits.html?number=${encodeURIComponent(number)}`;
}

function normalizedSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function ftsPrefixQuery(value) {
  const tokens = normalizedSearch(value).split(" ").filter(Boolean).slice(0, 8);
  if (!tokens.length) return "";
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" AND ");
}

export function createNativeStorage(helpers = {}) {
  const {
    ApiError,
    readJson,
    jsonResponse,
    requireUser,
    sessionFromRequest,
    randomHex,
    sha256,
    contentType,
  } = helpers;

  if (typeof ApiError !== "function" || typeof jsonResponse !== "function" || typeof readJson !== "function") {
    throw new TypeError("createNativeStorage requires ApiError, readJson, and jsonResponse helpers.");
  }

  function fail(status, code, message, details = null) {
    throw new ApiError(status, code, message, details);
  }

  function database(env) {
    if (!env?.DB || typeof env.DB.prepare !== "function" || typeof env.DB.batch !== "function") {
      fail(503, "storage_unavailable", "The native D1 storage binding is not configured.");
    }
    return env.DB;
  }

  function bucket(env) {
    if (!env?.BUCKET || typeof env.BUCKET.put !== "function" || typeof env.BUCKET.get !== "function") {
      fail(503, "storage_unavailable", "The native R2 storage binding is not configured.");
    }
    return env.BUCKET;
  }

  function pathContentType(path, explicit = "") {
    const value = String(explicit || "").trim().split(";")[0].slice(0, 160);
    if (value && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(value)) return value.toLowerCase();
    try { return String(contentType?.(path) || "application/octet-stream").split(";")[0].toLowerCase(); }
    catch { return "application/octet-stream"; }
  }

  function actorKey(actor) {
    return normalizeLogin(actor).toLowerCase();
  }

  function normalizeBytes(file, namespace) {
    if (file?.delete === true || file?.operation === "delete" || file?.action === "delete") return new Uint8Array();
    if (file?.bytes instanceof Uint8Array) return new Uint8Array(file.bytes);
    if (file?.bytes instanceof ArrayBuffer) return new Uint8Array(file.bytes.slice(0));
    if (ArrayBuffer.isView(file?.bytes)) return new Uint8Array(file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength));
    if (typeof file?.content_base64 === "string") {
      try { return bytesFromBase64(file.content_base64); }
      catch { fail(400, "invalid_content", "The base64 storage content is invalid."); }
    }
    if (file?.content !== undefined && file?.content !== null) return new TextEncoder().encode(String(file.content));
    if (namespace === "media" || namespace === "content") fail(400, "invalid_content", "A content value or byte payload is required.");
    return new TextEncoder().encode("");
  }

  function normalizeFile(file, ApiContext = {}) {
    const namespace = normalizeNamespace(file?.namespace || ApiContext.namespace || "data", ApiError);
    const path = safePath(file?.path, ApiError);
    const operation = file?.delete === true || file?.operation === "delete" || file?.action === "delete" ? "delete" : "upsert";
    const bytes = normalizeBytes(file, namespace);
    const hash = operation === "delete" ? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" : null;
    const text = operation === "delete" ? null : textFromBytes(bytes);
    const mediaType = pathContentType(path, file?.contentType || file?.content_type);
    const inlineLimit = namespace === "content" ? 64 * 1024 : INLINE_JSON_LIMIT;
    const inline = operation === "upsert"
      && (namespace === "data" || namespace === "content")
      && bytes.byteLength <= inlineLimit
      && text !== null
      // TextDecoder strips UTF-8 BOMs. Keep such files byte-for-byte in R2;
      // readers can still expose decoded content while HTTP serves raw bytes.
      && !hasUtf8Bom(bytes);
    return {
      namespace,
      path,
      operation,
      bytes,
      text,
      contentType: mediaType,
      inline,
      byteSize: operation === "delete" ? 0 : bytes.byteLength,
      sha256: hash,
      expectedVersion: file?.expectedVersion ?? file?.expected_version,
      suppliedSha256: String(file?.sha256 || "").toLowerCase(),
      original: file,
    };
  }

  async function finalizeFile(file) {
    if (file.operation === "delete") {
      file.sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      return file;
    }
    file.sha256 = await hashBytes(file.bytes);
    if (file.suppliedSha256 && (!validateSha(file.suppliedSha256) || file.suppliedSha256 !== file.sha256)) {
      fail(400, "content_hash_mismatch", "The supplied SHA-256 does not match the content bytes.");
    }
    const isJsonData = file.namespace === "data"
      && (/\.json$/i.test(file.path) || /(?:\/json|\+json)$/i.test(file.contentType));
    if (isJsonData) {
      if (file.text === null) fail(400, "invalid_content", "JSON data files must contain valid UTF-8 text.");
      try { JSON.parse(file.text); }
      catch { fail(400, "invalid_content", "JSON data files must contain valid JSON."); }
    }
    return file;
  }

  function expectedVersionFor(file, expectedVersions = {}) {
    const keys = [`${file.namespace}:${file.path}`, file.path];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(expectedVersions, key)) return expectedVersions[key];
    }
    return file.expectedVersion;
  }

  async function getRow(env, site, namespace, path) {
    return database(env).prepare(
      "SELECT site, namespace, path, version, content, blob_key, content_type, byte_size, sha256, is_deleted, updated_at, updated_by FROM native_documents WHERE site = ?1 AND namespace = ?2 AND path = ?3",
    ).bind(site, namespace, path).first();
  }

  async function getRowsForFiles(env, site, files) {
    const found = new Map();
    const db = database(env);
    // Keep under D1's 100-bind limit while replacing per-record importer reads
    // with one indexed query per chunk.
    for (let start = 0; start < files.length; start += 45) {
      const chunk = files.slice(start, start + 45);
      if (!chunk.length) continue;
      const predicates = chunk.map((_, index) => `(namespace = ?${index * 2 + 2} AND path = ?${index * 2 + 3})`).join(" OR ");
      const result = await db.prepare(
        `SELECT site, namespace, path, version, content, blob_key, content_type, byte_size, sha256, is_deleted, updated_at, updated_by
         FROM native_documents WHERE site = ?1 AND (${predicates})`,
      ).bind(site, ...chunk.flatMap((file) => [file.namespace, file.path])).all();
      for (const row of Array.isArray(result?.results) ? result.results : []) found.set(`${row.namespace}\u0000${row.path}`, row);
    }
    return found;
  }

  async function getChangeRow(env, site, number) {
    return database(env).prepare(
      "SELECT number, change_id, site, title, body, state, actor_login, actor_id, created_at, updated_at, reviewed_by, reviewed_at FROM native_changes WHERE site = ?1 AND number = ?2",
    ).bind(site, number).first();
  }

  async function loadIdempotency(env, site, actor, key) {
    if (!key) return null;
    return database(env).prepare(
      "SELECT request_sha256, resource_type, resource_id, response_json FROM native_storage_idempotency WHERE site = ?1 AND actor_key = ?2 AND idempotency_key = ?3",
    ).bind(site, actorKey(actor), key).first();
  }

  function normalizeIdempotencyKey(value) {
    const key = String(value || "").trim();
    if (!key) return "";
    if (key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) fail(400, "invalid_idempotency_key", "The idempotency key is invalid.");
    return key;
  }

  function conflict(message = "The document changed while this update was being prepared. Read the latest version and retry.") {
    fail(409, "storage_conflict", message);
  }

  function isCheckConflict(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("check constraint failed") && message.includes("valid");
  }

  function isUniqueConflict(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("unique constraint failed") || message.includes("primary key");
  }

  function makeAuditStatement(db, site, actor, action, resourceType, resourceId, file = null, version = null, sha = null, details = {}) {
    return db.prepare(
      "INSERT INTO native_audit_events (event_id, site, actor_login, action, resource_type, resource_id, namespace, path, version, sha256, details_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    ).bind(randomHex(16), site, normalizeLogin(actor), action, resourceType, String(resourceId), file?.namespace || null, file?.path || null, version, sha, JSON.stringify(details), nowIso());
  }

  async function writeBlob(env, site, namespace, path, version, hash, bytes, mediaType, objectPrefix = "documents") {
    const objectKey = `native/${site}/${objectPrefix}/${namespace}/${path}/${version}-${hash}-${randomHex(8)}`;
    const r2 = bucket(env);
    await r2.put(objectKey, bytes, {
      httpMetadata: { contentType: mediaType },
      customMetadata: { site, namespace, path, version: String(version), sha256: hash },
    });
    return objectKey;
  }

  async function loadDocumentBytes(env, row) {
    if (row.content !== null && row.content !== undefined) return new TextEncoder().encode(String(row.content));
    if (!row.blob_key) return new Uint8Array();
    const object = await bucket(env).get(String(row.blob_key));
    if (!object) fail(503, "storage_blob_missing", "A stored file body is temporarily unavailable.");
    return new Uint8Array(await object.arrayBuffer());
  }

  function decodeDocument(row, bytes) {
    const isText = /^text\//i.test(String(row.content_type || ""))
      || /(?:json|xml|javascript|x-www-form-urlencoded)/i.test(String(row.content_type || ""));
    const content = isText ? textFromBytes(bytes) : null;
    return {
      site: row.site,
      namespace: row.namespace,
      path: row.path,
      version: Number(row.version || 0),
      content: content ?? (row.content === null ? null : String(row.content || "")),
      // Keep exact blob bytes even when they are valid UTF-8. TextDecoder may
      // consume a BOM, and HTTP media/content reads must preserve original
      // bytes for downloads and checksum verification. Inline D1 JSON can be
      // reconstructed losslessly from its stored text.
      bytes: row.blob_key || content === null ? bytes : null,
      content_type: String(row.content_type || "application/octet-stream"),
      size: Number(row.byte_size || bytes.byteLength),
      sha256: String(row.sha256 || ""),
      blob_key: row.blob_key ? String(row.blob_key) : null,
      updated_at: String(row.updated_at || ""),
      updated_by: String(row.updated_by || ""),
      is_deleted: Boolean(Number(row.is_deleted || 0)),
    };
  }

  async function get(env, siteValue, namespaceValue, pathValue) {
    const site = normalizeSite(siteValue, ApiError);
    const namespace = normalizeNamespace(namespaceValue, ApiError);
    const path = safePath(pathValue, ApiError);
    const row = await getRow(env, site, namespace, path);
    if (!row || Number(row.is_deleted)) return null;
    const bytes = await loadDocumentBytes(env, row);
    return decodeDocument(row, bytes);
  }

  async function getBlob(env, siteValue, keyOrPath) {
    const site = normalizeSite(siteValue, ApiError);
    const value = String(keyOrPath || "");
    let key = value;
    if (!value.startsWith(`native/${site}/`)) {
      const doc = await get(env, site, "media", value);
      if (!doc?.blob_key) return null;
      key = doc.blob_key;
    }
    if (!key.startsWith(`native/${site}/`)) fail(400, "invalid_path", "The object key is outside this site's storage namespace.");
    return bucket(env).get(key);
  }

  async function list(env, siteValue, namespaceValue, options = {}) {
    const site = normalizeSite(siteValue, ApiError);
    const namespace = normalizeNamespace(namespaceValue, ApiError);
    const rawPrefix = options.prefix === undefined || options.prefix === null ? "" : String(options.prefix);
    // Directory callers conventionally include the final slash (for example
    // `memorials/`). Keep that slash for prefix matching while validating the
    // actual path segments with the same rules as document paths.
    const prefix = rawPrefix.endsWith("/")
      ? `${safePath(rawPrefix.slice(0, -1), ApiError)}/`
      : rawPrefix ? safePath(rawPrefix, ApiError) : "";
    const limit = Math.max(1, Math.min(1000, Number(options.limit || DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT));
    const cursor = options.cursor ? safePath(options.cursor, ApiError) : "";
    const rows = await database(env).prepare(
      `SELECT site, namespace, path, version, content_type, byte_size, sha256, updated_at, updated_by, blob_key
       FROM native_documents WHERE site = ?1 AND namespace = ?2 AND is_deleted = 0
         AND (?3 = '' OR substr(path, 1, length(?3)) = ?3)
         AND (?4 = '' OR path > ?4)
       ORDER BY path ASC LIMIT ?5`,
    ).bind(site, namespace, prefix, cursor, limit + 1).all();
    const records = Array.isArray(rows?.results) ? rows.results : [];
    const hasMore = records.length > limit;
    const selected = records.slice(0, limit);
    return {
      documents: selected.map((row) => ({
        site: row.site,
        namespace: row.namespace,
        path: row.path,
        version: Number(row.version || 0),
        content_type: String(row.content_type || ""),
        size: Number(row.byte_size || 0),
        sha256: String(row.sha256 || ""),
        updated_at: String(row.updated_at || ""),
        updated_by: String(row.updated_by || ""),
        blob_key: row.blob_key ? String(row.blob_key) : null,
      })),
      next_cursor: hasMore ? String(selected.at(-1)?.path || "") : null,
    };
  }

  async function filePayloadForWrite(env, site, file, version, objectPrefix) {
    if (file.operation === "delete") return { content: null, blobKey: null };
    if (file.inline) return { content: file.text, blobKey: null };
    return {
      content: null,
      blobKey: await writeBlob(env, site, file.namespace, file.path, version, file.sha256, file.bytes, file.contentType, objectPrefix),
    };
  }

  function indexRecordFromFile(site, file, sourcePath) {
    if (file.operation === "delete" || typeof file.text !== "string") return null;
    const record = jsonTry(file.text);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const fileId = sourcePath.match(/(?:^|\/)(?:people|pets)\/persons\/(?:[^/]+\/)?([^/]+)\.json$/i)?.[1]
      || sourcePath.match(/(?:^|\/)memorials\/(?:[^/]+\/)*([^/]+)\.json$/i)?.[1]
      || "";
    const id = String(fileId || record.id || record.personId || "").trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
    const names = record.names && typeof record.names === "object" ? record.names : {};
    const person = record.person && typeof record.person === "object" ? record.person : {};
    const displayName = String(record.displayName || record.display_name || names.display || person.displayName || record.name || [record.firstName || names.given, record.lastName || names.surname].filter(Boolean).join(" ")).trim().slice(0, 240);
    const nameParts = displayName.split(/\s+/).filter(Boolean);
    const firstName = String(record.firstName || names.given || person.firstName || nameParts[0] || "").trim().slice(0, 120);
    const lastName = String(record.lastName || names.surname || person.lastName || nameParts.slice(1).join(" ") || "").trim().slice(0, 120);
    const events = record.events && typeof record.events === "object" ? record.events : {};
    const birthYear = record.birthYear ?? events.birth?.year ?? record.birth_date?.year ?? String(record.birth_date || "").match(/\b(?:1[0-9]{3}|20[0-9]{2})\b/)?.[0] ?? null;
    const deathYear = record.deathYear ?? events.death?.year ?? record.death_date?.year ?? String(record.death_date || "").match(/\b(?:1[0-9]{3}|20[0-9]{2})\b/)?.[0] ?? null;
    const pathKind = /(?:^|\/)pets\/persons\//i.test(sourcePath) ? "pet" : /(?:^|\/)memorials\//i.test(sourcePath) ? "memorial" : "person";
    const kind = pathKind;
    const photoUrl = String(record.photoUrl || record.imageUrl || record.photo_url || record.image_url || person.photoUrl || "").slice(0, 1000);
    const searchText = [id, displayName, firstName, lastName, names.married, names.nick, ...(Array.isArray(names.aliases) ? names.aliases : [])].filter(Boolean).join(" ");
    return {
      site,
      id,
      kind,
      displayName: displayName || id,
      firstName,
      lastName,
      birthYear: birthYear === null || birthYear === undefined ? null : String(birthYear).slice(0, 16),
      deathYear: deathYear === null || deathYear === undefined ? null : String(deathYear).slice(0, 16),
      photoUrl,
      normalizedName: normalizedSearch(searchText),
      searchText: searchText.slice(0, 2000),
      sourcePath,
    };
  }

  function peopleIndexStatements(db, site, file, version, updatedAt) {
    if (file.namespace !== "data" || !/(?:^|\/)(?:(?:people|pets)\/persons\/(?:[^/]+\/)?|memorials\/(?:[^/]+\/)*)[^/]+\.json$/i.test(file.path)) return [];
    const fileId = file.path.match(/(?:^|\/)(?:people|pets)\/persons\/(?:[^/]+\/)?([^/]+)\.json$/i)?.[1]
      || file.path.match(/(?:^|\/)memorials\/(?:[^/]+\/)*([^/]+)\.json$/i)?.[1]
      || "";
    const id = fileId;
    const kind = /(?:^|\/)pets\/persons\//i.test(file.path) ? "pet" : /(?:^|\/)memorials\//i.test(file.path) ? "memorial" : "person";
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return [];
    const statements = [db.prepare("DELETE FROM native_people_fts WHERE site = ?1 AND kind = ?2 AND person_id = ?3").bind(site, kind, id)];
    if (file.operation === "delete") {
      statements.push(db.prepare("DELETE FROM native_people_index WHERE site = ?1 AND kind = ?2 AND person_id = ?3").bind(site, kind, id));
      return statements;
    }
    const record = indexRecordFromFile(site, file, file.path);
    if (!record) return statements;
    statements.push(db.prepare(
      `INSERT INTO native_people_index (site, kind, person_id, display_name, first_name, last_name, birth_year, death_year, photo_url, normalized_name, source_path, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(site, kind, person_id) DO UPDATE SET display_name=excluded.display_name, first_name=excluded.first_name, last_name=excluded.last_name, birth_year=excluded.birth_year, death_year=excluded.death_year, photo_url=excluded.photo_url, normalized_name=excluded.normalized_name, source_path=excluded.source_path, updated_at=excluded.updated_at`,
    ).bind(site, kind, record.id, record.displayName, record.firstName, record.lastName, record.birthYear, record.deathYear, record.photoUrl, record.normalizedName, record.sourcePath, updatedAt));
    statements.push(db.prepare(
      "INSERT INTO native_people_fts (site, kind, person_id, display_name, first_name, last_name, normalized_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(site, kind, record.id, record.displayName, record.firstName, record.lastName, record.normalizedName));
    return statements;
  }

  async function storedChangeFileRows(env, changeId) {
    const result = await database(env).prepare(
      "SELECT change_id, ordinal, site, namespace, path, operation, expected_version, content, blob_key, content_type, byte_size, sha256 FROM native_change_files WHERE change_id = ?1 ORDER BY ordinal ASC",
    ).bind(changeId).all();
    return Array.isArray(result?.results) ? result.results : [];
  }

  async function materializeChange(env, row, includeContent = true) {
    const staged = await storedChangeFileRows(env, String(row.change_id));
    const files = staged.map((file) => ({
      namespace: file.namespace,
      path: file.path,
      filename: file.path,
      status: file.operation === "delete" ? "removed" : file.expected_version > 0 ? "modified" : "added",
      operation: file.operation,
      expected_version: Number(file.expected_version || 0),
      content: includeContent ? (file.content ?? null) : undefined,
      blob_key: file.blob_key ? String(file.blob_key) : null,
      content_type: file.content_type,
      size: Number(file.byte_size || 0),
      sha256: String(file.sha256 || ""),
    }));
    const number = Number(row.number || 0);
    const id = String(row.change_id || "");
    const sha = (await sha256(`native-change:${row.site}:${id}`)).slice(0, 40);
    return {
      number,
      change_id: id,
      title: String(row.title || ""),
      body: String(row.body || ""),
      state: String(row.state || "open"),
      user: { login: String(row.actor_login || "unknown"), id: String(row.actor_id || "") },
      actor_login: String(row.actor_login || "unknown"),
      created_at: String(row.created_at || ""),
      updated_at: String(row.updated_at || ""),
      merged_at: row.state === "merged" ? String(row.reviewed_at || "") : null,
      reviewed_by: String(row.reviewed_by || ""),
      html_url: publicUrl(String(row.site), number),
      url: publicUrl(String(row.site), number),
      head: { ref: `native/${id}`, sha, repo: { full_name: `Genepedia/${row.site}-native-storage` } },
      base: { ref: "main", repo: { full_name: `Genepedia/${row.site}-native-storage` } },
      changed_files: files.length,
      files,
    };
  }

  async function checkExistingIdempotency(env, site, actor, key, requestHash, responseResourceResolver) {
    const existing = await loadIdempotency(env, site, actor, key);
    if (!existing) return null;
    if (existing.request_sha256 !== requestHash) fail(409, "idempotency_conflict", "This idempotency key was already used for a different request.");
    if (existing.resource_type === "change" && responseResourceResolver) return responseResourceResolver(String(existing.resource_id));
    return jsonTry(existing.response_json) || {};
  }

  async function lookupIdempotency(env, siteValue, actor, keyValue, options = {}) {
    const site = normalizeSite(siteValue, ApiError);
    const key = normalizeIdempotencyKey(keyValue);
    if (!key) return null;
    const operation = String(options.operation || "").toLowerCase();
    if (!["apply", "submit"].includes(operation) || !Object.prototype.hasOwnProperty.call(options, "idempotencyRequest")) {
      fail(400, "invalid_idempotency_lookup", "An operation and stable idempotency request are required.");
    }
    const requestHash = await fingerprint(site, [], actor || {}, { operation }, { provided: true, value: options.idempotencyRequest });
    const existing = await loadIdempotency(env, site, actor || {}, key);
    if (!existing) return null;
    if (existing.request_sha256 !== requestHash) fail(409, "idempotency_conflict", "This idempotency key was already used for a different request.");
    if (existing.resource_type === "change") return getChangeById(env, site, String(existing.resource_id));
    return jsonTry(existing.response_json) || {};
  }

  async function normalizeFiles(rawFiles, expectedVersions = {}) {
    if (!Array.isArray(rawFiles) || !rawFiles.length || rawFiles.length > MAX_FILES_PER_CHANGE) {
      fail(400, "invalid_files", `Between one and ${MAX_FILES_PER_CHANGE} files are required.`);
    }
    const files = rawFiles.map((file) => normalizeFile(file));
    const pathKeys = new Set();
    for (const file of files) {
      const key = `${file.namespace}\u0000${file.path}`;
      if (pathKeys.has(key)) fail(400, "duplicate_path", "A change cannot include the same storage path more than once.");
      pathKeys.add(key);
      await finalizeFile(file);
      file.requestedExpectedVersion = expectedVersionFor(file, expectedVersions);
    }
    const total = files.reduce((sum, file) => sum + file.byteSize, 0);
    if (total > 50_000_000) fail(413, "storage_change_too_large", "A storage change cannot exceed 50 MB of content.");
    return files;
  }

  async function attachCurrentVersions(env, site, files, preloadedRows = null) {
    const versions = [];
    for (const file of files) {
      const key = `${file.namespace}\u0000${file.path}`;
      const row = preloadedRows
        ? (preloadedRows.get(key) || null)
        : await getRow(env, site, file.namespace, file.path);
      const requestedVersion = file.requestedExpectedVersion;
      const currentVersion = Number(row?.version || 0);
      if (requestedVersion !== undefined && requestedVersion !== null && Number(requestedVersion) !== currentVersion) {
        conflict(`The latest version of ${file.path} is ${currentVersion}; the request expected ${requestedVersion}.`);
      }
      versions.push(currentVersion);
      file.currentRow = row;
      file.expectedVersion = currentVersion;
    }
    return { files, versions };
  }

  async function fingerprint(site, files, actor, context = {}, stableRequest = null) {
    const hasStableRequest = stableRequest && stableRequest.provided === true;
    const value = hasStableRequest ? {
      site,
      actor: actorKey(actor),
      operation: context.operation,
      request: canonicalJsonValue(stableRequest.value),
    } : {
      site,
      actor: actorKey(actor),
      context,
      files: files.map((file) => ({ namespace: file.namespace, path: file.path, operation: file.operation, sha256: file.sha256, expectedVersion: file.requestedExpectedVersion ?? null })),
    };
    return sha256(JSON.stringify(value));
  }

  function changeFilesInsert(db, changeId, site, files) {
    return files.map((file, ordinal) => db.prepare(
      "INSERT INTO native_change_files (change_id, ordinal, site, namespace, path, operation, expected_version, content, blob_key, content_type, byte_size, sha256) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    ).bind(changeId, ordinal, site, file.namespace, file.path, file.operation, file.expectedVersion, file.inline ? file.text : null, file.blobKey || null, file.contentType, file.byteSize, file.sha256));
  }

  async function getChangeById(env, site, changeId) {
    const row = await database(env).prepare(
      "SELECT number, change_id, site, title, body, state, actor_login, actor_id, created_at, updated_at, reviewed_by, reviewed_at FROM native_changes WHERE site = ?1 AND change_id = ?2",
    ).bind(site, changeId).first();
    return row ? materializeChange(env, row) : null;
  }

  async function apply(env, input = {}, internalOptions = {}) {
    const site = normalizeSite(input.site, ApiError);
    const actor = input.actor || {};
    const expectedVersions = input.expectedVersions || {};
    const files = await normalizeFiles(input.files, expectedVersions);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey || input.idempotency_key);
    const summary = String(input.summary || input.action || "Update stored data").slice(0, 500);
    const requestHash = await fingerprint(site, files, actor, { operation: "apply", summary },
      Object.prototype.hasOwnProperty.call(input, "idempotencyRequest") ? { provided: true, value: input.idempotencyRequest } : null);
    const existing = await checkExistingIdempotency(env, site, actor, idempotencyKey, requestHash);
    if (existing) return existing;
    await attachCurrentVersions(env, site, files, internalOptions.preloadedRows || null);

    const operationId = randomHex(16);
    const updatedAt = nowIso();
    const plan = await mapLimit(files, 6, async (file) => {
      const nextVersion = file.expectedVersion + 1;
      const payload = await filePayloadForWrite(env, site, file, nextVersion, "documents");
      const active = !file.currentRow || Number(file.currentRow.is_deleted) === 1;
      return {
        file,
        version: nextVersion,
        content: payload.content,
        blobKey: payload.blobKey,
        status: file.operation === "delete" ? "deleted" : active ? "added" : "modified",
        commitSha: (await sha256(JSON.stringify({ site, namespace: file.namespace, path: file.path, version: nextVersion, sha256: file.sha256, actor: normalizeLogin(actor), updatedAt }))).slice(0, 40),
      };
    });
    const result = {
      change_id: operationId,
      committed_at: updatedAt,
      files: plan.map(({ file, version, status, commitSha }) => ({ namespace: file.namespace, path: file.path, version, sha: commitSha, sha256: file.sha256, status })),
    };
    const db = database(env);
    const statements = [];
    if (idempotencyKey) statements.push(db.prepare(
      "INSERT INTO native_storage_idempotency (site, actor_key, idempotency_key, request_sha256, resource_type, resource_id, response_json, created_at) VALUES (?1, ?2, ?3, ?4, 'apply', ?5, ?6, ?7)",
    ).bind(site, actorKey(actor), idempotencyKey, requestHash, operationId, JSON.stringify(result), updatedAt));
    for (const item of plan) {
      const { file } = item;
      statements.push(db.prepare(
        `INSERT INTO native_version_checks (check_id, valid)
         VALUES (?1, CASE WHEN COALESCE((SELECT version FROM native_documents WHERE site=?2 AND namespace=?3 AND path=?4), 0) = ?5
           AND NOT EXISTS (SELECT 1 FROM native_path_reservations WHERE site=?2 AND namespace=?3 AND path=?4) THEN 1 ELSE 0 END)`,
      ).bind(`${operationId}:${file.namespace}:${file.path}`, site, file.namespace, file.path, file.expectedVersion));
    }
    for (const item of plan) {
      const { file } = item;
      const deleted = file.operation === "delete" ? 1 : 0;
      statements.push(db.prepare(
        `INSERT INTO native_documents (site, namespace, path, version, content, blob_key, content_type, byte_size, sha256, is_deleted, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(site, namespace, path) DO UPDATE SET version=excluded.version, content=excluded.content, blob_key=excluded.blob_key, content_type=excluded.content_type, byte_size=excluded.byte_size, sha256=excluded.sha256, is_deleted=excluded.is_deleted, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      ).bind(site, file.namespace, file.path, item.version, item.content, item.blobKey, file.contentType, file.byteSize, file.sha256, deleted, updatedAt, normalizeLogin(actor)));
      statements.push(db.prepare(
        "INSERT INTO native_document_revisions (site, namespace, path, version, commit_sha, content, blob_key, content_type, byte_size, sha256, is_deleted, summary, actor_login, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
      ).bind(site, file.namespace, file.path, item.version, item.commitSha, item.content, item.blobKey, file.contentType, file.byteSize, file.sha256, deleted, summary, normalizeLogin(actor), updatedAt));
      statements.push(...peopleIndexStatements(db, site, file, item.version, updatedAt));
      if (input.audit !== false) statements.push(makeAuditStatement(db, site, actor, file.operation === "delete" ? "delete" : "write", "document", `${file.namespace}:${file.path}`, file, item.version, file.sha256, { summary, operation_id: operationId }));
    }
    for (const item of plan) statements.push(db.prepare("DELETE FROM native_version_checks WHERE check_id = ?1").bind(`${operationId}:${item.file.namespace}:${item.file.path}`));
    try {
      await db.batch(statements);
      return result;
    } catch (error) {
      const prior = await loadIdempotency(env, site, actor, idempotencyKey).catch(() => null);
      if (prior) {
        if (prior.request_sha256 !== requestHash) fail(409, "idempotency_conflict", "This idempotency key was already used for a different request.");
        return jsonTry(prior.response_json) || result;
      }
      if (isCheckConflict(error)) conflict();
      if (isUniqueConflict(error) && idempotencyKey) {
        const retry = await checkExistingIdempotency(env, site, actor, idempotencyKey, requestHash);
        if (retry) return retry;
      }
      throw error;
    }
  }

  async function submit(env, input = {}) {
    const site = normalizeSite(input.site, ApiError);
    const actor = input.actor || {};
    const files = await normalizeFiles(input.files, input.expectedVersions || {});
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey || input.idempotency_key);
    const title = String(input.title || "Storage change").trim().slice(0, 300) || "Storage change";
    const body = String(input.body || "").slice(0, 20_000);
    const requestHash = await fingerprint(site, files, actor, { operation: "submit", title, body },
      Object.prototype.hasOwnProperty.call(input, "idempotencyRequest") ? { provided: true, value: input.idempotencyRequest } : null);
    const resolveExisting = async (changeId) => getChangeById(env, site, changeId);
    const existing = await checkExistingIdempotency(env, site, actor, idempotencyKey, requestHash, resolveExisting);
    if (existing) return existing;
    await attachCurrentVersions(env, site, files);

    const changeId = randomHex(16);
    const now = nowIso();
    await mapLimit(files, 6, async (file) => {
      const staged = file.operation === "delete"
        ? { content: null, blobKey: null }
        : file.inline
          ? { content: file.text, blobKey: null }
          : { content: null, blobKey: await writeBlob(env, site, file.namespace, file.path, file.expectedVersion + 1, file.sha256, file.bytes, file.contentType, "staged") };
      file.stagedContent = staged.content;
      file.blobKey = staged.blobKey;
    });
    const db = database(env);
    const statements = [];
    if (idempotencyKey) statements.push(db.prepare(
      "INSERT INTO native_storage_idempotency (site, actor_key, idempotency_key, request_sha256, resource_type, resource_id, response_json, created_at) VALUES (?1, ?2, ?3, ?4, 'change', ?5, ?6, ?7)",
    ).bind(site, actorKey(actor), idempotencyKey, requestHash, changeId, JSON.stringify({ change_id: changeId }), now));
    statements.push(db.prepare(
      "INSERT INTO native_changes (change_id, site, title, body, state, actor_login, actor_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7, ?7)",
    ).bind(changeId, site, title, body, normalizeLogin(actor), actorId(actor), now));
    files.forEach((file, ordinal) => {
      statements.push(db.prepare(
        "INSERT INTO native_change_files (change_id, ordinal, site, namespace, path, operation, expected_version, content, blob_key, content_type, byte_size, sha256) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
      ).bind(changeId, ordinal, site, file.namespace, file.path, file.operation, file.expectedVersion, file.stagedContent, file.blobKey, file.contentType, file.byteSize, file.sha256));
      statements.push(db.prepare(
        "INSERT INTO native_path_reservations (site, namespace, path, change_id, expected_version, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).bind(site, file.namespace, file.path, changeId, file.expectedVersion, now));
    });
    statements.push(makeAuditStatement(db, site, actor, "submit", "change", changeId, null, null, null, { title, files: files.length }));
    try {
      await db.batch(statements);
      const inserted = await getChangeById(env, site, changeId);
      if (!inserted) fail(503, "storage_unavailable", "The storage change could not be loaded after submission.");
      return inserted;
    } catch (error) {
      const prior = await loadIdempotency(env, site, actor, idempotencyKey).catch(() => null);
      if (prior) {
        if (prior.request_sha256 !== requestHash) fail(409, "idempotency_conflict", "This idempotency key was already used for a different request.");
        if (prior.resource_type === "change") return await getChangeById(env, site, String(prior.resource_id));
      }
      if (isUniqueConflict(error) && idempotencyKey) {
        const retry = await checkExistingIdempotency(env, site, actor, idempotencyKey, requestHash, resolveExisting);
        if (retry) return retry;
      }
      if (isUniqueConflict(error) && String(error?.message || "").includes("native_path_reservations")) {
        fail(409, "storage_conflict", "Another open change already reserves one of these paths.");
      }
      throw error;
    }
  }

  async function listChanges(env, siteValue, options = {}) {
    const site = normalizeSite(siteValue, ApiError);
    const state = String(options.state || "").toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(options.limit || 50) || 50));
    const cursor = Math.max(0, Number(options.cursor || 0) || 0);
    const rows = await database(env).prepare(
      `SELECT number, change_id, site, title, body, state, actor_login, actor_id, created_at, updated_at, reviewed_by, reviewed_at
       FROM native_changes WHERE site = ?1 AND (?2 = '' OR state = ?2) AND (?3 = 0 OR number < ?3)
       ORDER BY number DESC LIMIT ?4`,
    ).bind(site, state, cursor, limit + 1).all();
    const records = Array.isArray(rows?.results) ? rows.results : [];
    const hasMore = records.length > limit;
    const selected = records.slice(0, limit);
    const changes = await Promise.all(selected.map((row) => materializeChange(env, row, false)));
    return { changes, next_cursor: hasMore ? Number(selected.at(-1)?.number || 0) : null };
  }

  async function getChange(env, siteValue, numberValue) {
    const site = normalizeSite(siteValue, ApiError);
    const number = Number(numberValue);
    if (!Number.isSafeInteger(number) || number <= 0) fail(400, "invalid_request", "A valid change number is required.");
    const row = await getChangeRow(env, site, number);
    return row ? materializeChange(env, row, true) : null;
  }

  async function approveStagedChange(env, site, change, reviewer, stagedRows) {
    const actor = reviewer || {};
    const files = [];
    for (const row of stagedRows) {
      let bytes;
      if (row.content !== null && row.content !== undefined) bytes = new TextEncoder().encode(String(row.content));
      else if (row.blob_key) {
        const object = await bucket(env).get(String(row.blob_key));
        if (!object) fail(503, "storage_blob_missing", "A staged file body is temporarily unavailable.");
        bytes = new Uint8Array(await object.arrayBuffer());
      } else bytes = new Uint8Array();
      const text = textFromBytes(bytes);
      files.push({
        namespace: row.namespace,
        path: row.path,
        operation: row.operation,
        bytes,
        text,
        contentType: String(row.content_type || "application/octet-stream"),
        inline: row.content !== null && row.content !== undefined,
        byteSize: Number(row.byte_size || 0),
        sha256: String(row.sha256 || ""),
        expectedVersion: Number(row.expected_version || 0),
        currentRow: await getRow(env, site, row.namespace, row.path),
        stagedBlobKey: row.blob_key ? String(row.blob_key) : null,
      });
    }
    return commitPrepared(env, site, actor, files, {
      summary: String(change.title || "Approve storage change").slice(0, 500),
      changeNumber: Number(change.number),
      changeId: String(change.change_id),
    });
  }

  async function commitPrepared(env, site, actor, files, options = {}) {
    const db = database(env);
    const operationId = randomHex(16);
    const updatedAt = nowIso();
    const plan = [];
    for (const file of files) {
      const nextVersion = file.expectedVersion + 1;
      let payload;
      if (file.operation === "delete") payload = { content: null, blobKey: null };
      else if (file.stagedBlobKey) payload = { content: null, blobKey: file.stagedBlobKey };
      else payload = await filePayloadForWrite(env, site, file, nextVersion, "documents");
      plan.push({
        file,
        version: nextVersion,
        content: payload.content,
        blobKey: payload.blobKey,
        status: file.operation === "delete" ? "deleted" : !file.currentRow || Number(file.currentRow.is_deleted) === 1 ? "added" : "modified",
        commitSha: (await sha256(JSON.stringify({ site, namespace: file.namespace, path: file.path, version: nextVersion, sha256: file.sha256, actor: normalizeLogin(actor), updatedAt }))).slice(0, 40),
      });
    }
    const result = {
      change_id: options.changeId || operationId,
      committed_at: updatedAt,
      files: plan.map(({ file, version, status, commitSha }) => ({ namespace: file.namespace, path: file.path, version, sha: commitSha, sha256: file.sha256, status })),
    };
    const statements = [];
    if (options.changeId) {
      statements.push(db.prepare(
        `INSERT INTO native_version_checks (check_id, valid)
         VALUES (?1, CASE WHEN (SELECT state FROM native_changes WHERE site=?2 AND number=?3) = 'open' THEN 1 ELSE 0 END)`,
      ).bind(`${operationId}:change`, site, options.changeNumber));
    }
    for (const item of plan) {
      const { file } = item;
      statements.push(db.prepare(
        `INSERT INTO native_version_checks (check_id, valid)
         VALUES (?1, CASE WHEN COALESCE((SELECT version FROM native_documents WHERE site=?2 AND namespace=?3 AND path=?4), 0) = ?5
           AND NOT EXISTS (SELECT 1 FROM native_path_reservations WHERE site=?2 AND namespace=?3 AND path=?4 AND (?6='' OR change_id<>?6)) THEN 1 ELSE 0 END)`,
      ).bind(`${operationId}:${file.namespace}:${file.path}`, site, file.namespace, file.path, file.expectedVersion, options.changeId || ""));
    }
    for (const item of plan) {
      const { file } = item;
      const deleted = file.operation === "delete" ? 1 : 0;
      statements.push(db.prepare(
        `INSERT INTO native_documents (site, namespace, path, version, content, blob_key, content_type, byte_size, sha256, is_deleted, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(site, namespace, path) DO UPDATE SET version=excluded.version, content=excluded.content, blob_key=excluded.blob_key, content_type=excluded.content_type, byte_size=excluded.byte_size, sha256=excluded.sha256, is_deleted=excluded.is_deleted, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      ).bind(site, file.namespace, file.path, item.version, item.content, item.blobKey, file.contentType, file.byteSize, file.sha256, deleted, updatedAt, normalizeLogin(actor)));
      statements.push(db.prepare(
        "INSERT INTO native_document_revisions (site, namespace, path, version, commit_sha, content, blob_key, content_type, byte_size, sha256, is_deleted, summary, actor_login, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
      ).bind(site, file.namespace, file.path, item.version, item.commitSha, item.content, item.blobKey, file.contentType, file.byteSize, file.sha256, deleted, String(options.summary || "Update stored data"), normalizeLogin(actor), updatedAt));
      statements.push(...peopleIndexStatements(db, site, file, item.version, updatedAt));
      statements.push(makeAuditStatement(db, site, actor, file.operation === "delete" ? "delete" : "write", "document", `${file.namespace}:${file.path}`, file, item.version, file.sha256, { summary: String(options.summary || ""), operation_id: result.change_id }));
    }
    if (options.changeId) {
      statements.push(db.prepare(
        "UPDATE native_changes SET state='merged', reviewed_by=?1, reviewed_at=?2, updated_at=?2 WHERE site=?3 AND number=?4 AND state='open'",
      ).bind(normalizeLogin(actor), updatedAt, site, options.changeNumber));
      statements.push(db.prepare("DELETE FROM native_path_reservations WHERE change_id=?1").bind(String(options.changeId)));
      statements.push(makeAuditStatement(db, site, actor, "approve", "change", String(options.changeId), null, null, null, { number: options.changeNumber, files: plan.length }));
    }
    for (const item of plan) statements.push(db.prepare("DELETE FROM native_version_checks WHERE check_id = ?1").bind(`${operationId}:${item.file.namespace}:${item.file.path}`));
    if (options.changeId) statements.push(db.prepare("DELETE FROM native_version_checks WHERE check_id = ?1").bind(`${operationId}:change`));
    try {
      await db.batch(statements);
    } catch (error) {
      if (isCheckConflict(error)) conflict("The storage change is stale or has already been reviewed.");
      throw error;
    }
    return result;
  }

  async function reviewChange(env, siteValue, numberValue, reviewer, actionValue) {
    const site = normalizeSite(siteValue, ApiError);
    const number = Number(numberValue);
    const action = String(actionValue || "").toLowerCase();
    if (!Number.isSafeInteger(number) || number <= 0 || !["approve", "decline"].includes(action)) fail(400, "invalid_request", "A valid change number and approve or decline action are required.");
    const configuredReviewer = String(env.GITHUB_REVIEW_LOGIN || "").trim().toLowerCase();
    const login = normalizeLogin(reviewer).toLowerCase();
    if (!configuredReviewer) fail(503, "review_unavailable", "A reviewer account is not configured.");
    if (!login || login !== configuredReviewer) fail(403, "forbidden", "This account cannot review storage changes.");
    const change = await getChangeRow(env, site, number);
    if (!change) fail(404, "change_not_found", "The storage change was not found.");
    if (action === "approve" && change.state === "merged") return { ...(await materializeChange(env, change)), merged: true };
    if (action === "decline" && change.state === "closed") return { ...(await materializeChange(env, change)), merged: false };
    if (change.state !== "open") fail(409, "storage_conflict", "Only open storage changes can be reviewed.");
    const rows = await storedChangeFileRows(env, String(change.change_id));
    if (!rows.length) fail(409, "empty_change", "This storage change contains no files.");
    if (action === "approve") {
      const applied = await approveStagedChange(env, site, change, reviewer, rows);
      return { ...(await getChange(env, site, number)), merged: true, result: applied };
    }
    const db = database(env);
    const now = nowIso();
    const checkId = `decline:${randomHex(16)}`;
    try {
      await db.batch([
        db.prepare("INSERT INTO native_version_checks (check_id, valid) VALUES (?1, CASE WHEN (SELECT state FROM native_changes WHERE site=?2 AND number=?3)='open' THEN 1 ELSE 0 END)").bind(checkId, site, number),
        db.prepare("UPDATE native_changes SET state='closed', reviewed_by=?1, reviewed_at=?2, updated_at=?2 WHERE site=?3 AND number=?4 AND state='open'").bind(normalizeLogin(reviewer), now, site, number),
        makeAuditStatement(db, site, reviewer, "decline", "change", String(change.change_id), null, null, null, { number }),
        db.prepare("DELETE FROM native_path_reservations WHERE change_id=(SELECT change_id FROM native_changes WHERE site=?1 AND number=?2)").bind(site, number),
        db.prepare("DELETE FROM native_version_checks WHERE check_id=?1").bind(checkId),
      ]);
    } catch (error) {
      if (isCheckConflict(error)) conflict("This storage change has already been reviewed.");
      throw error;
    }
    return { ...(await getChange(env, site, number)), merged: false };
  }

  async function history(env, siteValue, namespaceValue, pathValue, options = {}) {
    const site = normalizeSite(siteValue, ApiError);
    const namespace = normalizeNamespace(namespaceValue, ApiError);
    const path = safePath(pathValue, ApiError);
    const limit = Math.max(1, Math.min(100, Number(options.limit || 50) || 50));
    const cursor = Math.max(0, Number(options.cursor || 0) || 0);
    const result = await database(env).prepare(
      `SELECT version, commit_sha, content_type, byte_size, sha256, is_deleted, summary, actor_login, created_at
       FROM native_document_revisions WHERE site=?1 AND namespace=?2 AND path=?3 AND (?4=0 OR version<?4)
       ORDER BY version DESC LIMIT ?5`,
    ).bind(site, namespace, path, cursor, limit + 1).all();
    const rows = Array.isArray(result?.results) ? result.results : [];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const commits = selected.map((row) => ({
      hash: String(row.commit_sha),
      sha: String(row.commit_sha),
      message: String(row.summary || "Update stored data"),
      author: String(row.actor_login || "unknown"),
      date: String(row.created_at || ""),
      url: publicUrl(site, row.commit_sha),
      paths: [path],
      version: Number(row.version || 0),
      status: Number(row.is_deleted) ? "deleted" : "committed",
      sha256: String(row.sha256 || ""),
      content_type: String(row.content_type || ""),
      size: Number(row.byte_size || 0),
    }));
    return { commits, count: commits.length, next_cursor: hasMore ? Number(selected.at(-1)?.version || 0) : null };
  }

  async function getRevision(env, siteValue, namespaceValue, pathValue, shaValue) {
    const site = normalizeSite(siteValue, ApiError);
    const namespace = normalizeNamespace(namespaceValue, ApiError);
    const path = safePath(pathValue, ApiError);
    const sha = String(shaValue || "").toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(sha)) fail(400, "invalid_request", "A valid revision SHA is required.");
    const row = await database(env).prepare(
      "SELECT site, namespace, path, version, commit_sha, content, blob_key, content_type, byte_size, sha256, is_deleted, summary, actor_login, created_at FROM native_document_revisions WHERE site=?1 AND namespace=?2 AND path=?3 AND commit_sha=?4",
    ).bind(site, namespace, path, sha).first();
    if (!row) return null;
    if (Number(row.is_deleted)) return { ...row, deleted: true, content: null, bytes: null };
    const bytes = row.content !== null && row.content !== undefined
      ? new TextEncoder().encode(String(row.content))
      : await (async () => {
        const object = await bucket(env).get(String(row.blob_key || ""));
        if (!object) fail(503, "storage_blob_missing", "A stored revision body is temporarily unavailable.");
        return new Uint8Array(await object.arrayBuffer());
      })();
    const text = textFromBytes(bytes);
    return { ...row, deleted: false, content: text, bytes: text === null ? bytes : null };
  }

  async function searchPeople(env, siteValue, queryValue, options = {}) {
    const site = normalizeSite(siteValue, ApiError);
    const query = String(queryValue || "").trim().slice(0, 120);
    const match = ftsPrefixQuery(query);
    if (!match) return { total: 0, results: [], limit: 0, offset: 0, has_more: false };
    const limit = Math.max(1, Math.min(100, Number(options.limit || 20) || 20));
    const offset = Math.max(0, Math.min(100_000, Number(options.offset || 0) || 0));
    const requestedKind = String(options.kind || "").trim().toLowerCase();
    const kind = requestedKind === "people" ? "person" : requestedKind;
    if (kind && !["person", "pet", "memorial"].includes(kind)) fail(400, "invalid_kind", "The requested search kind is invalid.");
    const prefix = `${normalizedSearch(query)}%`;
    const db = database(env);
    const totals = await db.prepare(
      `WITH matches AS (
         SELECT site, kind, person_id FROM native_people_fts WHERE native_people_fts MATCH ?1 AND site=?2
         UNION
         SELECT site, kind, person_id FROM native_people_index
         WHERE site=?2 AND (normalized_name LIKE ?3 OR person_id LIKE ?3)
       )
       SELECT COUNT(*) AS total FROM native_people_index p JOIN matches m
         ON m.site=p.site AND m.kind=p.kind AND m.person_id=p.person_id
       WHERE p.site=?2 AND (?4='' OR p.kind=?4)`,
    ).bind(match, site, prefix, kind).first();
    const total = Math.max(0, Number(totals?.total || 0));
    const rows = await db.prepare(
      `WITH matches AS (
         SELECT site, kind, person_id FROM native_people_fts WHERE native_people_fts MATCH ?1 AND site=?2
         UNION
         SELECT site, kind, person_id FROM native_people_index
         WHERE site=?2 AND (normalized_name LIKE ?3 OR person_id LIKE ?3)
       )
       SELECT p.person_id AS id, p.kind, p.display_name AS displayName, p.first_name AS firstName,
              p.last_name AS lastName, p.birth_year AS birthYear, p.death_year AS deathYear, p.photo_url AS photoUrl,
              p.source_path AS sourcePath
       FROM native_people_index p JOIN matches m ON m.site=p.site AND m.kind=p.kind AND m.person_id=p.person_id
       WHERE p.site=?2 AND (?4='' OR p.kind=?4)
       ORDER BY CASE WHEN p.normalized_name LIKE ?3 THEN 0 ELSE 1 END, p.normalized_name ASC, p.kind ASC, p.person_id ASC
       LIMIT ?5 OFFSET ?6`,
    ).bind(match, site, prefix, kind, limit, offset).all();
    const results = (Array.isArray(rows?.results) ? rows.results : []).map((row) => ({
      id: String(row.id),
      kind: String(row.kind || "person"),
      displayName: String(row.displayName || ""),
      firstName: String(row.firstName || ""),
      lastName: String(row.lastName || ""),
      birthYear: row.birthYear === null || row.birthYear === undefined ? null : String(row.birthYear),
      deathYear: row.deathYear === null || row.deathYear === undefined ? null : String(row.deathYear),
      photoUrl: String(row.photoUrl || ""),
      sourcePath: String(row.sourcePath || ""),
    }));
    return { total, results, limit, offset, has_more: offset + results.length < total };
  }

  async function searchMemorials(env, siteValue, queryValue, options = {}) {
    return searchPeople(env, siteValue, queryValue, { ...options, kind: "memorial" });
  }

  async function recordStatistic(env, event = {}) {
    const site = normalizeSite(event.site || "genepedia", ApiError);
    const eventId = String(event.id || event.event_id || randomHex(16)).slice(0, 200);
    if (!eventId || /[\u0000-\u001f\u007f]/.test(eventId)) fail(400, "invalid_event", "The statistics event id is invalid.");
    const eventType = String(event.event_type || event.event || "").trim().toLowerCase().slice(0, 48);
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(eventType)) fail(400, "invalid_event", "The statistics event type is invalid.");
    const personId = String(event.person_id || "").slice(0, 80);
    const kind = String(event.kind || "").slice(0, 32);
    const path = String(event.path || "").slice(0, 500);
    const query = String(event.query || "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 120);
    const resultCount = Math.max(0, Math.min(2_147_483_647, Number(event.result_count || 0) || 0));
    const parsedAt = Date.parse(String(event.created_at || ""));
    const createdAt = Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : nowIso();
    const payload = { ...event, event_id: eventId, event_type: eventType, site, person_id: personId, kind, path, query, result_count: resultCount, created_at: createdAt };
    const db = database(env);
    const checkId = `statistic:${randomHex(12)}`;
    let result;
    try {
      result = await db.batch([
        db.prepare(
          "INSERT OR IGNORE INTO native_statistics_events (event_id, site, event_type, person_id, kind, path, query, result_count, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        ).bind(eventId, site, eventType, personId, kind, path, query, resultCount, JSON.stringify(payload), createdAt),
        db.prepare(
          `INSERT INTO native_version_checks (check_id, valid)
           VALUES (?1, CASE WHEN EXISTS (
             SELECT 1 FROM native_statistics_events WHERE event_id=?2 AND site=?3 AND event_type=?4 AND person_id=?5 AND kind=?6 AND path=?7 AND query=?8 AND result_count=?9
           ) THEN 1 ELSE 0 END)`,
        ).bind(checkId, eventId, site, eventType, personId, kind, path, query, resultCount),
        db.prepare("DELETE FROM native_version_checks WHERE check_id=?1").bind(checkId),
      ]);
    } catch (error) {
      if (isCheckConflict(error)) fail(409, "idempotency_conflict", "This statistics event id was already used for a different event.");
      throw error;
    }
    const inserted = Number(result?.[0]?.meta?.changes || 0) > 0;
    return { inserted, event_id: eventId };
  }

  async function queryStatistics(env, options = {}) {
    const site = normalizeSite(options.site || "genepedia", ApiError);
    const clauses = ["site=?1"];
    const binds = [site];
    const add = (sql, value) => { binds.push(value); clauses.push(sql.replace("?", `?${binds.length}`)); };
    if (options.event_type) add("event_type=?", String(options.event_type).slice(0, 48));
    if (options.person_id) add("person_id=?", String(options.person_id).slice(0, 80));
    if (options.kind) add("kind=?", String(options.kind).slice(0, 32));
    if (options.since) add("created_at>=?", String(options.since).slice(0, 40));
    if (options.until) add("created_at<=?", String(options.until).slice(0, 40));
    const limit = Math.max(1, Math.min(1000, Number(options.limit || 100) || 100));
    const offset = Math.max(0, Math.min(100_000, Number(options.offset || 0) || 0));
    const db = database(env);
    const where = clauses.join(" AND ");
    const totalRow = await db.prepare(`SELECT COUNT(*) AS total FROM native_statistics_events WHERE ${where}`).bind(...binds).first();
    const rows = await db.prepare(
      `SELECT event_id, event_type, person_id, kind, path, query, result_count, payload_json, created_at FROM native_statistics_events WHERE ${where} ORDER BY created_at DESC, event_id DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
    ).bind(...binds, limit, offset).all();
    const events = (Array.isArray(rows?.results) ? rows.results : []).map((row) => jsonTry(row.payload_json) || {
      event_id: String(row.event_id), event_type: String(row.event_type), person_id: String(row.person_id), kind: String(row.kind),
      path: String(row.path), query: String(row.query), result_count: Number(row.result_count || 0), created_at: String(row.created_at),
    });
    return { events, total: Math.max(0, Number(totalRow?.total || 0)), limit, offset, has_more: offset + events.length < Number(totalRow?.total || 0) };
  }

  function statisticsContributionQuery(site, since, until) {
    const startHour = since ? since.slice(0, 13) : "";
    const endHour = until ? until.slice(0, 13) : "";
    const binds = [site, since, until, startHour, endHour];
    const rollupWhere = `site=?1 AND (?2='' OR bucket_hour>=substr(?2,1,13)) AND (?3='' OR bucket_hour<=substr(?3,1,13))
      AND (?4='' OR bucket_hour<>?4) AND (?5='' OR bucket_hour<>?5)`;
    const rawWhere = `site=?1 AND (?2='' OR created_at>=?2) AND (?3='' OR created_at<=?3)
      AND ((?4<>'' AND substr(created_at,1,13)=?4) OR (?5<>'' AND substr(created_at,1,13)=?5))`;
    return {
      binds,
      sql: `WITH contributions AS (
        SELECT event_type, person_id, kind, query, event_count, last_at, last_result_count
        FROM native_statistics_rollups WHERE ${rollupWhere}
        UNION ALL
        SELECT event_type, person_id, kind, query, 1 AS event_count, created_at AS last_at, result_count AS last_result_count
        FROM native_statistics_events WHERE ${rawWhere}
      )`,
    };
  }

  function normalizeStatisticsBound(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) fail(400, "invalid_statistics_window", "Statistics time bounds must be valid timestamps.");
    return new Date(timestamp).toISOString();
  }

  async function statisticsTotals(env, options = {}) {
    const site = normalizeSite(options.site || "genepedia", ApiError);
    const since = normalizeStatisticsBound(options.since);
    const until = normalizeStatisticsBound(options.until);
    const query = statisticsContributionQuery(site, since, until);
    const result = await database(env).prepare(
      `${query.sql}
       SELECT event_type, SUM(event_count) AS count FROM contributions GROUP BY event_type ORDER BY count DESC, event_type ASC`,
    ).bind(...query.binds).all();
    const rows = Array.isArray(result?.results) ? result.results : [];
    const byEventType = rows.map((row) => ({ event_type: String(row.event_type), count: Math.max(0, Number(row.count || 0)) }));
    return {
      total: byEventType.reduce((sum, row) => sum + row.count, 0),
      by_event_type: byEventType,
      since: since || null,
      until: until || null,
    };
  }

  async function aggregateStatistics(env, options = {}) {
    const site = normalizeSite(options.site || "genepedia", ApiError);
    const since = normalizeStatisticsBound(options.since);
    const until = normalizeStatisticsBound(options.until);
    const limit = Math.max(1, Math.min(5000, Number(options.limit || 5000) || 5000));
    const query = statisticsContributionQuery(site, since, until);
    const db = database(env);
    const totalsRows = await db.prepare(
      `${query.sql} SELECT event_type, SUM(event_count) AS count FROM contributions GROUP BY event_type ORDER BY count DESC, event_type ASC`,
    ).bind(...query.binds).all();
    const byEventType = (Array.isArray(totalsRows?.results) ? totalsRows.results : []).map((row) => ({
      event_type: String(row.event_type), count: Math.max(0, Number(row.count || 0)),
    }));
    const byPersonRows = await db.prepare(
      `${query.sql}
       SELECT kind, person_id, SUM(event_count) AS count, MAX(last_at) AS last_at
       FROM contributions WHERE event_type IN ('profile_view','profile-view') AND person_id<>''
       GROUP BY kind, person_id ORDER BY count DESC, last_at DESC, kind ASC, person_id ASC LIMIT ?6`,
    ).bind(...query.binds, limit).all();
    const peopleGroups = (Array.isArray(byPersonRows?.results) ? byPersonRows.results : []).map((row) => ({
      kind: String(row.kind || "person"), person_id: String(row.person_id || ""),
      count: Math.max(0, Number(row.count || 0)), last_at: String(row.last_at || ""),
    }));
    const personCount = await db.prepare(
      `${query.sql}
       SELECT COUNT(*) AS groups_total FROM (
         SELECT kind, person_id FROM contributions WHERE event_type IN ('profile_view','profile-view') AND person_id<>'' GROUP BY kind, person_id
       )`,
    ).bind(...query.binds).first();
    const byQueryRows = await db.prepare(
      `${query.sql}, grouped AS (
         SELECT query, SUM(event_count) AS count, MAX(last_at) AS last_at
         FROM contributions WHERE event_type IN ('search','search_query') AND query<>'' GROUP BY query
       )
       SELECT g.query, g.count, g.last_at,
         (SELECT c.last_result_count FROM contributions c WHERE c.query=g.query AND c.event_type IN ('search','search_query') ORDER BY c.last_at DESC LIMIT 1) AS last_result_count
       FROM grouped g ORDER BY g.count DESC, g.last_at DESC, g.query ASC LIMIT ?6`,
    ).bind(...query.binds, limit).all();
    const searchGroups = (Array.isArray(byQueryRows?.results) ? byQueryRows.results : []).map((row) => ({
      query: String(row.query || ""), count: Math.max(0, Number(row.count || 0)),
      last_at: String(row.last_at || ""), last_result_count: Math.max(0, Number(row.last_result_count || 0)),
    }));
    const queryCount = await db.prepare(
      `${query.sql}
       SELECT COUNT(*) AS groups_total FROM (
         SELECT query FROM contributions WHERE event_type IN ('search','search_query') AND query<>'' GROUP BY query
       )`,
    ).bind(...query.binds).first();
    return {
      total: byEventType.reduce((sum, row) => sum + row.count, 0),
      by_event_type: byEventType,
      by_person: peopleGroups,
      people_groups_total: Math.max(0, Number(personCount?.groups_total || 0)),
      by_query: searchGroups,
      query_groups_total: Math.max(0, Number(queryCount?.groups_total || 0)),
      since: since || null,
      until: until || null,
    };
  }

  async function drainLegacyStatistics(env, siteValue) {
    const site = normalizeSite(siteValue || "genepedia", ApiError);
    const db = database(env);
    let copied = 0;
    let acknowledged = 0;
    const chunkSize = 40;
    // Keep a request bounded; subsequent calls continue from the oldest rows.
    // Each chunk copies and deletes its source rows in one D1 batch transaction.
    for (let chunkNumber = 0; chunkNumber < 25; chunkNumber += 1) {
      let rows;
      try {
        const result = await db.prepare("SELECT event_id, payload, created_at FROM statistics_events ORDER BY created_at ASC, event_id ASC LIMIT ?1").bind(chunkSize).all();
        rows = Array.isArray(result?.results) ? result.results : [];
      } catch (error) {
        if (/no such table.*statistics_events/i.test(String(error?.message || error))) return { copied, acknowledged, pending: 0 };
        throw error;
      }
      if (!rows.length) break;
      const statements = [];
      rows.forEach((row, index) => {
        const eventId = String(row.event_id || "").slice(0, 200);
        const parsed = jsonTry(row.payload);
        const original = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { legacy_payload: String(row.payload || "") };
        const rawType = String(original.event_type || original.event || original.action || original.type || "legacy").trim().toLowerCase().slice(0, 48);
        const eventType = /^[a-z][a-z0-9_-]{0,47}$/.test(rawType) ? rawType : "legacy";
        const personId = String(original.person_id || original.person || "").trim().slice(0, 80);
        const kind = String(original.kind || "").trim().toLowerCase().slice(0, 32);
        const path = String(original.path || "").slice(0, 500);
        const queryText = String(original.query || original.q || "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 120);
        const rawResultCount = Number(original.result_count ?? original.results ?? 0);
        const resultCount = Number.isFinite(rawResultCount) ? Math.max(0, Math.min(2_147_483_647, Math.trunc(rawResultCount))) : 0;
        const parsedAt = Date.parse(String(row.created_at || original.created_at || ""));
        const createdAt = Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : nowIso();
        const payload = {
          ...original, event_id: eventId, event_type: eventType, site, person_id: personId, kind, path,
          query: queryText, result_count: resultCount, created_at: createdAt,
        };
        const checkId = `legacy-stat:${eventId}:${randomHex(4)}`;
        statements.push(db.prepare(
          "INSERT OR IGNORE INTO native_statistics_events (event_id, site, event_type, person_id, kind, path, query, result_count, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        ).bind(eventId, site, eventType, personId, kind, path, queryText, resultCount, JSON.stringify(payload), createdAt));
        statements.push(db.prepare(
          `INSERT INTO native_version_checks (check_id, valid)
           VALUES (?1, CASE WHEN EXISTS (
             SELECT 1 FROM native_statistics_events WHERE event_id=?2 AND site=?3 AND event_type=?4 AND person_id=?5 AND kind=?6 AND path=?7 AND query=?8 AND result_count=?9 AND payload_json=?10 AND created_at=?11
           ) THEN 1 ELSE 0 END)`,
        ).bind(checkId, eventId, site, eventType, personId, kind, path, queryText, resultCount, JSON.stringify(payload), createdAt));
        statements.push(db.prepare("DELETE FROM statistics_events WHERE event_id=?1").bind(eventId));
        statements.push(db.prepare("DELETE FROM native_version_checks WHERE check_id=?1").bind(checkId));
      });
      const result = await db.batch(statements);
      for (let index = 0; index < rows.length; index += 1) {
        copied += Number(result?.[index * 4]?.meta?.changes || 0);
        acknowledged += Number(result?.[index * 4 + 2]?.meta?.changes || 0);
      }
      if (rows.length < chunkSize) break;
    }
    let pending = 0;
    try {
      const row = await db.prepare("SELECT COUNT(*) AS count FROM statistics_events").first();
      pending = Math.max(0, Number(row?.count || 0));
    } catch (error) {
      if (!/no such table.*statistics_events/i.test(String(error?.message || error))) throw error;
    }
    return { copied, acknowledged, pending };
  }

  async function importRecords(env, siteValue, records, options = {}) {
    const site = normalizeSite(siteValue, ApiError);
    if (!Array.isArray(records) || !records.length || records.length > IMPORT_RECORD_LIMIT) fail(400, "invalid_import", `Import requires between 1 and ${IMPORT_RECORD_LIMIT} records.`);
    const paths = new Set();
    let totalBytes = 0;
    const files = [];
    const skipped = [];
    const expectedVersions = {};
    const prepared = [];
    for (const record of records) {
      const namespace = normalizeNamespace(record?.namespace, ApiError);
      const path = safePath(record?.path, ApiError);
      const pathKey = `${namespace}\u0000${path}`;
      if (paths.has(pathKey)) fail(400, "duplicate_path", "An import batch cannot contain the same path more than once.");
      paths.add(pathKey);
      const file = normalizeFile({
        namespace,
        path,
        content: record?.content,
        bytes: record?.bytes,
        content_base64: record?.content_base64,
        content_type: record?.content_type,
        sha256: record?.sha256,
      });
      await finalizeFile(file);
      totalBytes += file.byteSize;
      const maxBytes = Number(options.maxBytes || IMPORT_BODY_LIMIT);
      if (totalBytes > maxBytes) fail(413, "import_too_large", `An import batch cannot exceed ${maxBytes} bytes of uncompressed content.`);
      prepared.push({ record, file });
    }
    const currentRows = await getRowsForFiles(env, site, prepared.map(({ file }) => file));
    for (const { record, file } of prepared) {
      const namespace = file.namespace;
      const path = file.path;
      const current = currentRows.get(`${namespace}\u0000${path}`) || null;
      if (current && !Number(current.is_deleted) && String(current.sha256) === file.sha256) {
        skipped.push({ namespace, path, sha256: file.sha256, skipped: true, version: Number(current.version) });
        continue;
      }
      if (current && !Number(current.is_deleted) && record?.expected_version === undefined) {
        fail(409, "storage_import_conflict", `The existing ${namespace}/${path} differs from the import; an expected_version is required to replace it.`);
      }
      const expected = record?.expected_version === undefined ? Number(current?.version || 0) : Number(record.expected_version);
      if (!Number.isSafeInteger(expected) || expected < 0 || expected !== Number(current?.version || 0)) {
        fail(409, "storage_conflict", `The latest version of ${path} does not match expected_version.`);
      }
      file.expectedVersion = expected;
      files.push(file);
      expectedVersions[`${namespace}:${path}`] = expected;
    }
    let applied = { files: [], committed_at: nowIso() };
    if (files.length) {
      const allFirstVersions = files.every((file) => file.expectedVersion === 0
        && !currentRows.has(`${file.namespace}\u0000${file.path}`));
      if (allFirstVersions) {
        applied = await importFirstVersions(env, site, files);
      } else {
        // Replacements and tombstone restores retain the general CAS path.
        // Keeping mixed batches together also preserves all-or-nothing updates.
        applied = await apply(env, {
          site,
          actor: { login: "storage-migration", id: "migration" },
          files: files.map((file) => ({
            namespace: file.namespace,
            path: file.path,
            bytes: file.bytes,
            contentType: file.contentType,
            sha256: file.sha256,
            expectedVersion: file.expectedVersion,
          })),
          expectedVersions,
          idempotencyKey: "",
          summary: "Import legacy storage record",
          audit: false,
        }, { preloadedRows: currentRows });
      }
    }
    return {
      ok: true,
      site,
      imported: applied.files.length,
      skipped: skipped.length,
      records: [
        ...applied.files.map((file) => ({ ...file, imported: true, skipped: false })),
        ...skipped,
      ],
    };
  }

  async function importFirstVersions(env, site, files) {
    const actor = { login: "storage-migration", id: "migration" };
    const updatedAt = nowIso();
    const operationId = randomHex(16);
    const plan = await mapLimit(files, 6, async (file) => {
      const payload = await filePayloadForWrite(env, site, file, 1, "documents");
      return {
        file,
        content: payload.content,
        blobKey: payload.blobKey,
        commitSha: (await sha256(JSON.stringify({
          site,
          namespace: file.namespace,
          path: file.path,
          version: 1,
          sha256: file.sha256,
          actor: normalizeLogin(actor),
          updatedAt,
        }))).slice(0, 40),
      };
    });
    const db = database(env);
    const statements = [];
    const checks = plan.map((item, index) => `${operationId}:${index}`);

    // The check and the first-version inserts share one atomic D1 batch. A
    // concurrent importer or an open review reservation makes CHECK(valid=1)
    // fail, rolling back every file in this import batch.
    for (let start = 0; start < plan.length; start += 25) {
      const chunk = plan.slice(start, start + 25);
      const binds = [];
      const values = chunk.map((item, offset) => {
        const checkId = checks[start + offset];
        const base = binds.length;
        binds.push(checkId, site, item.file.namespace, item.file.path);
        const check = (number) => `?${number}`;
        const checkBind = check(base + 1);
        const siteBind = check(base + 2);
        const namespaceBind = check(base + 3);
        const pathBind = check(base + 4);
        return `(${checkBind}, CASE WHEN NOT EXISTS (
          SELECT 1 FROM native_documents WHERE site=${siteBind} AND namespace=${namespaceBind} AND path=${pathBind}
        ) AND NOT EXISTS (
          SELECT 1 FROM native_path_reservations WHERE site=${siteBind} AND namespace=${namespaceBind} AND path=${pathBind}
        ) THEN 1 ELSE 0 END)`;
      });
      statements.push(db.prepare(
        `INSERT INTO native_version_checks (check_id, valid) VALUES ${values.join(",")}`,
      ).bind(...binds));
    }

    for (let start = 0; start < plan.length; start += 8) {
      const chunk = plan.slice(start, start + 8);
      const binds = [];
      const values = chunk.map(({ file, content, blobKey }) => {
        const offset = binds.length;
        binds.push(site, file.namespace, file.path, 1, content, blobKey, file.contentType, file.byteSize, file.sha256, 0, updatedAt, normalizeLogin(actor));
        return `(${Array.from({ length: 12 }, (_, index) => `?${offset + index + 1}`).join(",")})`;
      });
      statements.push(db.prepare(
        `INSERT INTO native_documents (site, namespace, path, version, content, blob_key, content_type, byte_size, sha256, is_deleted, updated_at, updated_by)
         VALUES ${values.join(",")}`,
      ).bind(...binds));
    }

    for (let start = 0; start < plan.length; start += 7) {
      const chunk = plan.slice(start, start + 7);
      const binds = [];
      const values = chunk.map(({ file, content, blobKey, commitSha }) => {
        const offset = binds.length;
        binds.push(site, file.namespace, file.path, 1, commitSha, content, blobKey, file.contentType, file.byteSize, file.sha256, 0, "Import legacy storage record", normalizeLogin(actor), updatedAt);
        return `(${Array.from({ length: 14 }, (_, index) => `?${offset + index + 1}`).join(",")})`;
      });
      statements.push(db.prepare(
        `INSERT INTO native_document_revisions (site, namespace, path, version, commit_sha, content, blob_key, content_type, byte_size, sha256, is_deleted, summary, actor_login, created_at)
         VALUES ${values.join(",")}`,
      ).bind(...binds));
    }

    // Index only the final record for any repeated (kind,id) in the batch,
    // matching the former sequential delete/upsert/insert behavior.
    const indexRecords = new Map();
    const indexTargets = new Map();
    for (const { file } of plan) {
      if (file.namespace !== "data" || !/(?:^|\/)(?:(?:people|pets)\/persons\/(?:[^/]+\/)?|memorials\/(?:[^/]+\/)*)[^/]+\.json$/i.test(file.path)) continue;
      const fileId = file.path.match(/(?:^|\/)(?:people|pets)\/persons\/(?:[^/]+\/)?([^/]+)\.json$/i)?.[1]
        || file.path.match(/(?:^|\/)memorials\/(?:[^/]+\/)*([^/]+)\.json$/i)?.[1]
        || "";
      const kind = /(?:^|\/)pets\/persons\//i.test(file.path) ? "pet" : /(?:^|\/)memorials\//i.test(file.path) ? "memorial" : "person";
      const id = String(fileId || "").trim();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue;
      const key = `${kind}\u0000${id}`;
      indexTargets.set(key, { kind, id });
      const record = indexRecordFromFile(site, file, file.path);
      if (record) indexRecords.set(key, record);
      else indexRecords.delete(key);
    }
    const targets = [...indexTargets.values()];
    for (let start = 0; start < targets.length; start += 33) {
      const chunk = targets.slice(start, start + 33);
      const binds = [];
      const predicates = chunk.map(({ kind, id }) => {
        const offset = binds.length;
        binds.push(site, kind, id);
        return `(site=?${offset + 1} AND kind=?${offset + 2} AND person_id=?${offset + 3})`;
      });
      statements.push(db.prepare(`DELETE FROM native_people_fts WHERE ${predicates.join(" OR ")}`).bind(...binds));
    }
    const records = [...indexRecords.values()];
    for (let start = 0; start < records.length; start += 8) {
      const chunk = records.slice(start, start + 8);
      const binds = [];
      const values = chunk.map((record) => {
        const offset = binds.length;
        binds.push(site, record.kind, record.id, record.displayName, record.firstName, record.lastName, record.birthYear, record.deathYear, record.photoUrl, record.normalizedName, record.sourcePath, updatedAt);
        return `(${Array.from({ length: 12 }, (_, index) => `?${offset + index + 1}`).join(",")})`;
      });
      statements.push(db.prepare(
        `INSERT INTO native_people_index (site, kind, person_id, display_name, first_name, last_name, birth_year, death_year, photo_url, normalized_name, source_path, updated_at)
         VALUES ${values.join(",")}
         ON CONFLICT(site, kind, person_id) DO UPDATE SET display_name=excluded.display_name, first_name=excluded.first_name, last_name=excluded.last_name, birth_year=excluded.birth_year, death_year=excluded.death_year, photo_url=excluded.photo_url, normalized_name=excluded.normalized_name, source_path=excluded.source_path, updated_at=excluded.updated_at`,
      ).bind(...binds));
    }
    for (let start = 0; start < records.length; start += 14) {
      const chunk = records.slice(start, start + 14);
      const binds = [];
      const values = chunk.map((record) => {
        const offset = binds.length;
        binds.push(site, record.kind, record.id, record.displayName, record.firstName, record.lastName, record.normalizedName);
        return `(${Array.from({ length: 7 }, (_, index) => `?${offset + index + 1}`).join(",")})`;
      });
      statements.push(db.prepare(
        `INSERT INTO native_people_fts (site, kind, person_id, display_name, first_name, last_name, normalized_name)
         VALUES ${values.join(",")}`,
      ).bind(...binds));
    }
    statements.push(db.prepare(
      `DELETE FROM native_version_checks WHERE check_id IN (${checks.map((_, index) => `?${index + 1}`).join(",")})`,
    ).bind(...checks));

    try {
      await db.batch(statements);
    } catch (error) {
      if (isCheckConflict(error) || isUniqueConflict(error)) {
        conflict("One or more imported paths changed or were reserved while the import was being prepared.");
      }
      throw error;
    }
    return {
      change_id: operationId,
      committed_at: updatedAt,
      files: plan.map(({ file, commitSha }) => ({
        namespace: file.namespace,
        path: file.path,
        version: 1,
        sha: commitSha,
        sha256: file.sha256,
        status: "added",
      })),
    };
  }

  async function migrationAuthorized(request, env, allowReviewer = false) {
    const configured = String(env.STORAGE_MIGRATION_TOKEN || "");
    const supplied = requestHeader(request, "X-Storage-Migration-Token");
    if (configured && supplied && supplied.length === configured.length) {
      let diff = 0;
      for (let index = 0; index < configured.length; index += 1) diff |= configured.charCodeAt(index) ^ supplied.charCodeAt(index);
      if (diff === 0) return { login: "storage-migration", id: "migration" };
    }
    if (!allowReviewer) fail(configured ? 403 : 503, configured ? "forbidden" : "migration_token_unavailable", "The storage migration token is not valid or is not configured.");
    if (typeof requireUser !== "function") fail(401, "authentication_required", "Sign in as the configured reviewer to view storage status.");
    const session = await requireUser(request, env);
    const reviewer = String(env.GITHUB_REVIEW_LOGIN || "").trim().toLowerCase();
    if (!reviewer || String(session?.user?.login || "").trim().toLowerCase() !== reviewer) fail(403, "forbidden", "Only the configured reviewer can view storage status.");
    return session.user;
  }

  function encodeManifestCursor(namespace, path) {
    const bytes = new TextEncoder().encode(JSON.stringify({ namespace, path }));
    return btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join("")).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }

  function decodeManifestCursor(value) {
    if (!value) return { namespace: "", path: "" };
    try {
      const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      const namespace = normalizeNamespace(parsed.namespace, ApiError);
      const path = safePath(parsed.path, ApiError);
      return { namespace, path };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      fail(400, "invalid_cursor", "The storage manifest cursor is invalid.");
    }
  }

  async function storageManifest(env, siteValue, options = {}) {
    const site = normalizeSite(siteValue, ApiError);
    const namespace = options.namespace ? normalizeNamespace(options.namespace, ApiError) : "";
    const cursor = decodeManifestCursor(options.after || options.cursor || "");
    if (namespace && cursor.namespace && cursor.namespace !== namespace) fail(400, "invalid_cursor", "The storage manifest cursor does not match the requested namespace.");
    const limit = Math.max(1, Math.min(500, Number(options.limit || 500) || 500));
    const result = await database(env).prepare(
      `SELECT namespace, path, sha256 FROM native_documents
       WHERE site=?1 AND is_deleted=0 AND (?2='' OR namespace=?2)
         AND (?3='' OR namespace>?3 OR (namespace=?3 AND path>?4))
       ORDER BY namespace ASC, path ASC LIMIT ?5`,
    ).bind(site, namespace, cursor.namespace, cursor.path, limit + 1).all();
    const rows = Array.isArray(result?.results) ? result.results : [];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      manifest: selected.map((row) => ({ namespace: String(row.namespace), path: String(row.path), sha256: String(row.sha256) })),
      next_cursor: hasMore && last ? encodeManifestCursor(String(last.namespace), String(last.path)) : null,
    };
  }

  async function storageStatus(env, siteValue) {
    const site = normalizeSite(siteValue, ApiError);
    const db = database(env);
    const rows = await db.prepare(
      "SELECT namespace, COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes, MIN(path) AS min_path, MAX(path) AS max_path FROM native_documents WHERE site=?1 AND is_deleted=0 GROUP BY namespace ORDER BY namespace",
    ).bind(site).all();
    const revisions = await db.prepare("SELECT COUNT(*) AS count FROM native_document_revisions WHERE site=?1").bind(site).first();
    const changes = await db.prepare("SELECT state, COUNT(*) AS count FROM native_changes WHERE site=?1 GROUP BY state").bind(site).all();
    const people = await db.prepare("SELECT COUNT(*) AS count FROM native_people_index WHERE site=?1").bind(site).first();
    const namespaces = Object.fromEntries((Array.isArray(rows?.results) ? rows.results : []).map((row) => [String(row.namespace), { count: Number(row.count || 0), bytes: Number(row.bytes || 0), min_path: row.min_path || null, max_path: row.max_path || null }]));
    return {
      ok: true,
      site,
      namespaces,
      total_documents: Object.values(namespaces).reduce((sum, item) => sum + item.count, 0),
      total_bytes: Object.values(namespaces).reduce((sum, item) => sum + item.bytes, 0),
      revisions: Number(revisions?.count || 0),
      people_indexed: Number(people?.count || 0),
      changes: Object.fromEntries((Array.isArray(changes?.results) ? changes.results : []).map((row) => [String(row.state), Number(row.count || 0)])),
      inventory_sha256: null,
      fetched_at: nowIso(),
    };
  }

  async function handle(request, env, siteValue, endpoint) {
    const site = normalizeSite(siteValue, ApiError);
    if (endpoint === "storage/import") {
      if (request.method !== "POST") fail(405, "method_not_allowed", "Only POST requests are supported.");
      await migrationAuthorized(request, env, false);
      const payload = await readJson(request, IMPORT_BODY_LIMIT);
      const result = await importRecords(env, site, payload.records);
      return jsonResponse(request, env, result, 200);
    }
    if (endpoint === "storage/import-file") {
      if (request.method !== "POST") fail(405, "method_not_allowed", "Only POST requests are supported.");
      await migrationAuthorized(request, env, false);
      const url = new URL(request.url);
      const namespace = normalizeNamespace(url.searchParams.get("namespace"), ApiError);
      const path = safePath(url.searchParams.get("path"), ApiError);
      const expectedSha = String(url.searchParams.get("sha256") || "").toLowerCase();
      if (!validateSha(expectedSha)) fail(400, "invalid_request", "A valid SHA-256 query parameter is required.");
      const expectedVersionText = url.searchParams.get("expected_version");
      const expectedVersion = expectedVersionText === null ? undefined : Number(expectedVersionText);
      if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) fail(400, "invalid_request", "expected_version must be a non-negative integer.");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > 12_000_000) fail(413, "import_too_large", "Raw file imports must be smaller than 12 MB.");
      const result = await importRecords(env, site, [{
        namespace,
        path,
        bytes,
        content_type: request.headers.get("Content-Type") || "application/octet-stream",
        sha256: expectedSha,
        expected_version: expectedVersion,
      }], { maxBytes: 12_000_000 });
      return jsonResponse(request, env, result, 200);
    }
    if (endpoint === "storage/status") {
      if (request.method !== "GET") fail(405, "method_not_allowed", "Only GET requests are supported.");
      await migrationAuthorized(request, env, true);
      const url = new URL(request.url);
      const summary = await storageStatus(env, site);
      if (url.searchParams.get("manifest") === "1") {
        const page = await storageManifest(env, site, {
          namespace: url.searchParams.get("namespace") || "",
          limit: url.searchParams.get("limit") || 500,
          after: url.searchParams.get("after") || "",
        });
        return jsonResponse(request, env, { ...summary, ...page });
      }
      return jsonResponse(request, env, summary);
    }
    return null;
  }

  return {
    get,
    list,
    apply,
    submit,
    lookupIdempotency,
    listChanges,
    getChange,
    reviewChange,
    getBlob,
    putMedia: (env, input = {}) => apply(env, {
      ...input,
      files: [{ namespace: "media", path: input.path, bytes: input.bytes, contentType: input.contentType, expectedVersion: input.expectedVersion }],
      summary: input.summary || "Store media file",
    }),
    history,
    getRevision,
    searchPeople,
    recordStatistic,
    queryStatistics,
    statisticsTotals,
    aggregateStatistics,
    drainLegacyStatistics,
    importRecords,
    storageStatus,
    storageManifest,
    handle,
  };
}

