const OWNER = "Genepedia";
const API_VERSION = "2022-11-28";
const SESSION_COOKIE = "__Host-genepedia_session";
const OAUTH_COOKIE = "__Host-genepedia_oauth";
const SESSION_TTL = 60 * 60 * 24 * 30;
const OAUTH_STATE_TTL = 10 * 60;
const HANDOFF_TTL = 180;
const MAX_BODY_BYTES = 12_000_000;
const DEFAULT_ORIGINS = [
  "https://genepedia.org",
  "https://www.genepedia.org",
  "https://gravepedia.org",
  "https://www.gravepedia.org",
];
const WINDOWS = ["24h", "3d", "7d", "30d", "60d", "90d", "6m", "1y", "all"];
const MAX_QUEUED_STATISTICS_EVENTS = 10_000;

// Requests select only these repositories. No endpoint accepts an owner or repo
// name from an arbitrary caller.
const REPOSITORIES = {
  genepediaSite: { owner: OWNER, repo: "Genepedia" },
  genepediaDatabase: { owner: OWNER, repo: "Genepedia-Database" },
  genepediaMedia: { owner: OWNER, repo: "Genepedia-Media" },
  gravepediaSite: { owner: OWNER, repo: "Gravepedia" },
  gravepediaMedia: { owner: OWNER, repo: "Gravepedia-Media" },
};

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function jsonResponse(request, env, payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      ...corsHeaders(request, env),
      ...headers,
    },
  });
}

function corsOrigins(env) {
  const configured = String(env.GITHUB_ALLOWED_CORS_ORIGINS || "")
    .split(",")
    .map((item) => normalizeOrigin(item))
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ORIGINS);
}

function corsHeaders(request, env) {
  const origin = normalizeOrigin(request.headers.get("Origin") || "");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && corsOrigins(env).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return decodeURIComponent(item.slice(separator + 1).trim());
    }
  }
  return "";
}

function cookie(name, value, maxAge, sameSite = "Lax") {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=${sameSite}`;
}

function redirectWithCookies(request, env, location, cookies) {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    ...corsHeaders(request, env),
  });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

function randomHex(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function db(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") {
    throw new ApiError(503, "storage_unavailable", "The API's D1 storage binding is not configured.");
  }
  return env.DB;
}

async function ensureStorage(env) {
  // Schema is provisioned by the Sites D1 migration before Worker upload.
  // Do not issue DDL from request handling: applied migration state belongs to
  // the Sites deployment workflow.
  return db(env);
}

function requiredSecret(env, name) {
  const value = String(env[name] || "");
  if (value.length < 32) {
    throw new ApiError(503, "session_secret_unavailable", `${name} must be configured as a high-entropy secret.`);
  }
  return value;
}

async function encryptionKey(env) {
  const secret = requiredSecret(env, "GITHUB_SESSION_SECRET");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptJson(env, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), plaintext);
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

async function decryptJson(env, value) {
  const [encodedIv, encodedCiphertext] = String(value || "").split(".");
  if (!encodedIv || !encodedCiphertext) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(encodedIv) },
      await encryptionKey(env),
      base64UrlDecode(encodedCiphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

function base64UrlEncode(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64Bytes(value) {
  const binary = atob(String(value).replace(/\s+/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > maxBytes) throw new ApiError(413, "body_too_large", "The request body is too large.");
  try {
    const value = JSON.parse(new TextDecoder().decode(raw));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

function safeRepoPath(value, { allowDirectory = false } = {}) {
  const path = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!path || path.length > 500 || /[\u0000-\u001f\u007f]/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (!allowDirectory && path.endsWith("/")) return null;
  return path;
}

function repoPathUrl(repo, suffix = "") {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${suffix}`;
}

function selectSiteRepo(site, requested = "") {
  if (site === "gravepedia") {
    if (requested && requested.toLowerCase() !== "genepedia/gravepedia") {
      throw new ApiError(400, "invalid_repo", "Only the Gravepedia repository is available for this request.");
    }
    return REPOSITORIES.gravepediaSite;
  }
  if (!requested || requested.toLowerCase() === "genepedia/genepedia") return REPOSITORIES.genepediaSite;
  if (requested.toLowerCase() === "genepedia/genepedia-database") return REPOSITORIES.genepediaDatabase;
  throw new ApiError(400, "invalid_repo", "Only the fixed Genepedia site and database repositories are available.");
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function siteRepository(site) {
  return site === "gravepedia" ? REPOSITORIES.gravepediaSite : REPOSITORIES.genepediaSite;
}

async function apiToken(env, { write = false } = {}) {
  if (write) {
    const installationToken = await githubAppInstallationToken(env);
    return installationToken || String(env.GITHUB_PUBLISH_TOKEN || env.GITHUB_API_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || "");
  }
  const installationToken = await githubAppInstallationToken(env);
  return installationToken || String(env.GITHUB_API_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_PUBLISH_TOKEN || "");
}

let cachedInstallationToken = null;

function pemBytes(pem) {
  return pemMaterial(pem)?.bytes || null;
}

function pemMaterial(pem) {
  const normalized = String(pem || "").replace(/\\n/g, "\n").replace(/\r/g, "");
  const body = normalized.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  if (!body) return null;
  try { return { bytes: base64Bytes(body), pkcs1: normalized.includes("-----BEGIN RSA PRIVATE KEY-----") }; } catch { return null; }
}

function derLength(length) {
  if (length < 128) return new Uint8Array([length]);
  const parts = [];
  let remaining = length;
  while (remaining > 0) {
    parts.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return new Uint8Array([0x80 | parts.length, ...parts]);
}

function derWrap(tag, value) {
  const length = derLength(value.length);
  const output = new Uint8Array(1 + length.length + value.length);
  output[0] = tag;
  output.set(length, 1);
  output.set(value, 1 + length.length);
  return output;
}

function concatBytes(...values) {
  const total = values.reduce((sum, value) => sum + value.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function privateKeyPkcs8(pem) {
  const material = pemMaterial(pem);
  if (!material) return null;
  if (!material.pkcs1) return material.bytes;
  const algorithmIdentifier = derWrap(0x30, new Uint8Array([
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]));
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const wrappedKey = derWrap(0x04, material.bytes);
  return derWrap(0x30, concatBytes(version, algorithmIdentifier, wrappedKey));
}

async function githubAppJwt(env) {
  const appId = String(env.GITHUB_APP_ID || "").trim();
  const keyBytes = privateKeyPkcs8(env.GITHUB_APP_PRIVATE_KEY);
  if (!/^\d+$/.test(appId) || !keyBytes) return null;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const issued = nowSeconds() - 30;
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ iss: appId, iat: issued, exp: issued + 540 })));
  const unsigned = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function githubAppInstallationToken(env) {
  if (cachedInstallationToken && cachedInstallationToken.expiresAt > Date.now() + 60_000) {
    return cachedInstallationToken.token;
  }
  try {
    const jwt = await githubAppJwt(env);
    if (!jwt) return "";
    let installationId = String(env.GITHUB_APP_INSTALLATION_ID || "").trim();
    if (!installationId) {
      const installation = await githubApi(env, "GET", repoPathUrl(REPOSITORIES.genepediaSite, "/installation"), { token: jwt });
      installationId = String(installation.data?.id || "");
    }
    if (!/^\d+$/.test(installationId)) return "";
    const tokenResult = await githubApi(env, "POST", `/app/installations/${installationId}/access_tokens`, { token: jwt });
    const token = String(tokenResult.data?.token || "");
    const expiresAt = Date.parse(String(tokenResult.data?.expires_at || ""));
    if (!token || !Number.isFinite(expiresAt)) return "";
    cachedInstallationToken = { token, expiresAt };
    return token;
  } catch {
    return "";
  }
}

async function githubApi(env, method, path, { token = null, body = undefined, accept = "application/vnd.github+json" } = {}) {
  const authToken = token === null ? await apiToken(env) : String(token || "");
  const headers = {
    Accept: accept,
    "User-Agent": "Genepedia-Sites-API/1.0",
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    redirect: "manual",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const message = String(data?.message || `GitHub returned HTTP ${response.status}.`);
    throw new ApiError(response.status === 404 ? 404 : response.status === 403 ? 503 : 502, "github_request_failed", message);
  }
  return { status: response.status, data, headers: response.headers };
}

function normalizeUser(user) {
  const login = String(user?.login || "").trim();
  const fullName = String(user?.name || "").trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    id: String(user?.id || ""),
    login,
    displayName: fullName || login || "GitHub User",
    givenName: parts[0] || login,
    familyName: parts.slice(1).join(" "),
    photoUrl: String(user?.avatar_url || ""),
    profileUrl: String(user?.html_url || ""),
    email: String(user?.email || ""),
  };
}

function bearerToken(request) {
  const match = (request.headers.get("Authorization") || "").match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
}

async function sessionFromRequest(request, env) {
  const bearer = bearerToken(request);
  if (bearer) {
    try {
      const user = await githubApi(env, "GET", "/user", { token: bearer });
      return { user: normalizeUser(user.data), token: bearer, kind: "bearer" };
    } catch {
      return null;
    }
  }
  const sid = readCookie(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(sid)) return null;
  const database = await ensureStorage(env);
  const row = await database.prepare(
    "SELECT payload, expires_at FROM worker_sessions WHERE session_id_hash = ?1",
  ).bind(await sha256(sid)).first();
  if (!row || Number(row.expires_at) <= nowSeconds()) {
    await database.prepare("DELETE FROM worker_sessions WHERE session_id_hash = ?1").bind(await sha256(sid)).run();
    return null;
  }
  const session = await decryptJson(env, row.payload);
  if (!session?.user || !session?.token) return null;
  return { user: session.user, token: session.token, sid, kind: "cookie" };
}

async function requireUser(request, env) {
  const session = await sessionFromRequest(request, env);
  if (!session?.user?.login || !session.token) {
    throw new ApiError(401, "authentication_required", "Sign in with GitHub to continue.");
  }
  return session;
}

async function putSession(env, user, token) {
  const sid = randomHex();
  const expiresAt = nowSeconds() + SESSION_TTL;
  const payload = await encryptJson(env, { user, token });
  const database = await ensureStorage(env);
  await database.batch([
    database.prepare("DELETE FROM worker_sessions WHERE expires_at <= ?1").bind(nowSeconds()),
    database.prepare("INSERT INTO worker_sessions (session_id_hash, payload, expires_at) VALUES (?1, ?2, ?3)")
      .bind(await sha256(sid), payload, expiresAt),
  ]);
  return sid;
}

function allowedReturnOrigins(env) {
  const values = String(env.GITHUB_ALLOWED_RETURN_ORIGINS || "")
    .split(",").map((item) => normalizeOrigin(item)).filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...values]);
}

function siteHome(site) {
  return site === "gravepedia" ? "https://www.gravepedia.org/" : "https://www.genepedia.org/";
}

function normalizeReturnTo(value, site, env) {
  const fallback = siteHome(site);
  const candidate = String(value || "").trim();
  if (!candidate) return fallback;
  try {
    const url = candidate.startsWith("/") ? new URL(candidate, fallback) : new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || !allowedReturnOrigins(env).has(url.origin.toLowerCase())) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

function callbackUrl(env) {
  return String(env.GITHUB_CALLBACK_URL || "https://api.genepedia.org/genepedia/github-callback.php").trim();
}

async function storeOneTime(env, table, keyName, key, payload, ttlSeconds) {
  const encrypted = await encryptJson(env, payload);
  const expiresAt = nowSeconds() + ttlSeconds;
  const hash = await sha256(key);
  const database = await ensureStorage(env);
  await database.prepare(`DELETE FROM ${table} WHERE expires_at <= ?1`).bind(nowSeconds()).run();
  await database.prepare(`INSERT INTO ${table} (${keyName}, payload, expires_at) VALUES (?1, ?2, ?3)`)
    .bind(hash, encrypted, expiresAt).run();
}

async function consumeOneTime(env, table, keyName, key) {
  if (!/^[a-f0-9]{64}$/.test(String(key || ""))) return null;
  const database = await ensureStorage(env);
  const row = await database.prepare(
    `DELETE FROM ${table} WHERE ${keyName} = ?1 AND expires_at > ?2 RETURNING payload`,
  ).bind(await sha256(key), nowSeconds()).first();
  return row ? decryptJson(env, row.payload) : null;
}

async function exchangeOAuthCode(env, code, redirectUri) {
  const clientId = String(env.GITHUB_CLIENT_ID || "");
  const clientSecret = String(env.GITHUB_CLIENT_SECRET || "");
  if (!clientId || !clientSecret) throw new ApiError(503, "github_oauth_not_configured", "GitHub sign-in is not configured.");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Genepedia-Sites-API/1.0" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    redirect: "manual",
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || !payload?.access_token) throw new ApiError(502, "token_exchange_failed", "GitHub sign-in could not be completed.");
  return String(payload.access_token);
}

function setQuery(urlValue, key, value) {
  const url = new URL(urlValue);
  url.searchParams.set(key, value);
  return url.href;
}

async function loginStart(request, env, site) {
  const url = new URL(request.url);
  const clientId = String(env.GITHUB_CLIENT_ID || "").trim();
  const clientSecret = String(env.GITHUB_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) throw new ApiError(503, "github_oauth_not_configured", "GitHub sign-in is not configured.");
  const state = randomHex();
  const csrf = randomHex();
  const returnTo = normalizeReturnTo(url.searchParams.get("return_to"), site, env);
  await storeOneTime(env, "oauth_states", "state_hash", state, { csrf, returnTo, site }, OAUTH_STATE_TTL);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl(env));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("scope", "read:user user:email public_repo user:follow");
  authorize.searchParams.set("prompt", "select_account");
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.href,
      "Cache-Control": "no-store",
      "Set-Cookie": cookie(OAUTH_COOKIE, csrf, OAUTH_STATE_TTL),
      ...corsHeaders(request, env),
    },
  });
}

async function oauthCallback(request, env) {
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") || "");
  const row = await consumeOneTime(env, "oauth_states", "state_hash", state);
  const csrf = readCookie(request, OAUTH_COOKIE);
  const valid = row && csrf && row.csrf === csrf;
  const fallbackSite = row?.site === "gravepedia" ? "gravepedia" : "genepedia";
  const returnTo = valid ? normalizeReturnTo(row.returnTo, fallbackSite, env) : siteHome(fallbackSite);
  const clearOauthCookie = cookie(OAUTH_COOKIE, "", 0);
  const fail = (reason) => redirectWithCookies(request, env, setQuery(returnTo, "github_auth_error", reason), [clearOauthCookie]);
  if (!valid) return fail("state_mismatch");
  const code = String(url.searchParams.get("code") || "").trim();
  if (!code) return fail("missing_code");
  try {
    const token = await exchangeOAuthCode(env, code, callbackUrl(env));
    const userResponse = await githubApi(env, "GET", "/user", { token });
    const user = normalizeUser(userResponse.data);
    if (!user.login) return fail("user_profile");
    const sid = await putSession(env, user, token);
    const handoffCode = randomHex();
    await storeOneTime(env, "oauth_handoffs", "handoff_hash", handoffCode, { user, token }, HANDOFF_TTL);
    return redirectWithCookies(request, env, setQuery(returnTo, "github_handoff", handoffCode), [
      clearOauthCookie,
      cookie(SESSION_COOKIE, sid, SESSION_TTL, "None"),
    ]);
  } catch (error) {
    return fail(error?.code === "github_oauth_not_configured" ? "not_configured" : "token_exchange");
  }
}

async function loginHandoff(request, env) {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Only POST requests are supported.");
  const payload = await readJson(request, 16_384);
  const code = String(payload.code || "").trim();
  if (!code) throw new ApiError(400, "missing_code", "A login handoff code is required.");
  const handoff = await consumeOneTime(env, "oauth_handoffs", "handoff_hash", code);
  if (!handoff?.user || !handoff?.token) throw new ApiError(401, "invalid_handoff", "This login handoff code is invalid or has expired. Please sign in again.");
  const sid = await putSession(env, handoff.user, handoff.token);
  return jsonResponse(request, env, {
    ok: true,
    authenticated: true,
    user: handoff.user,
    access_token: handoff.token,
  }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, sid, SESSION_TTL, "None") });
}

async function githubConfig(request, env, site) {
  const hasApp = /^\d+$/.test(String(env.GITHUB_APP_ID || "")) && Boolean(pemBytes(env.GITHUB_APP_PRIVATE_KEY));
  const hasPat = Boolean(env.GITHUB_API_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN);
  const canPublish = hasApp || Boolean(env.GITHUB_PUBLISH_TOKEN || env.GITHUB_API_TOKEN);
  const callback = callbackUrl(env);
  const configured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  return jsonResponse(request, env, {
    ok: true,
    oauth_configured: configured,
    oauth: {
      uses_github_app_flow: String(env.GITHUB_CLIENT_ID || "").startsWith("Iv1."),
      callback_url: callback,
      client_id_set: Boolean(env.GITHUB_CLIENT_ID),
      client_id_is_github_app_format: String(env.GITHUB_CLIENT_ID || "").startsWith("Iv1."),
    },
    github_app: { configured: hasApp, private_key_readable: hasApp },
    api_auth: { configured: hasApp || hasPat || Boolean(env.GITHUB_PUBLISH_TOKEN), method: hasApp ? "github_app" : hasPat ? "personal_access_token" : null },
    publish_auth: { configured: canPublish, can_publish: canPublish },
    repo: `${OWNER}/${siteRepository(site).repo}`,
    storage: { configured: Boolean(env.DB), session_encryption_configured: String(env.GITHUB_SESSION_SECRET || "").length >= 32 },
  });
}

function workspacePathFor(site, input) {
  const path = safeRepoPath(input, { allowDirectory: true });
  if (!path) return null;
  if (site === "gravepedia") {
    if (/^pages\/[A-Za-z0-9_.\/-]+\.html$/.test(path) || /^data\/memorials\/[A-Za-z0-9_.\/-]+\.json$/.test(path)) {
      return { repo: REPOSITORIES.gravepediaSite, repoPath: path, workspacePath: path };
    }
    return null;
  }
  const databasePrefix = "data/Genepedia-Database/";
  if (path.startsWith(databasePrefix)) {
    const repoPath = path.slice(databasePrefix.length);
    if (/^(people|pets|statistics)\/[A-Za-z0-9_.\/-]+$/.test(repoPath) || /^(people|pets|statistics)\/[A-Za-z0-9_.\/-]+\.json$/.test(repoPath)) {
      return { repo: REPOSITORIES.genepediaDatabase, repoPath, workspacePath: path };
    }
    return null;
  }
  if (path.startsWith("data/people/")) {
    const repoPath = path.slice("data/".length);
    if (/^people\/[A-Za-z0-9_.\/-]+$/.test(repoPath)) {
      return { repo: REPOSITORIES.genepediaDatabase, repoPath, workspacePath: `data/Genepedia-Database/${repoPath}` };
    }
    return null;
  }
  if (/^pages\/[A-Za-z0-9_.\/-]+\.html$/.test(path)
    || /^people\/[A-Za-z0-9_-]+\/(?:index|profile|[A-Za-z0-9_.-]+)\.html$/.test(path)
    || path === "sitemap.xml") {
    return { repo: REPOSITORIES.genepediaSite, repoPath: path, workspacePath: path };
  }
  return null;
}

function historyPaths(url) {
  const values = url.searchParams.get("paths") || url.searchParams.get("path") || "";
  if (!values.trim()) return null;
  const paths = values.split(",").map((part) => part.trim()).filter(Boolean);
  if (!paths.length || paths.length > 12) return null;
  return paths;
}

async function fileCommits(request, env, site) {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Only GET requests are supported.");
  const url = new URL(request.url);
  const paths = historyPaths(url);
  if (!paths) throw new ApiError(400, "invalid_path", "A valid repository file path or paths query is required.");
  const contexts = paths.map((path) => workspacePathFor(site, path));
  if (contexts.some((context) => !context)) throw new ApiError(400, "invalid_path", "This path is outside the repositories allowed for the site.");
  const context = contexts[0];
  if (contexts.some((item) => item.repo.repo !== context.repo.repo)) throw new ApiError(400, "invalid_path", "Commit history can only be fetched from one fixed repository per request.");
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
  const lists = await Promise.all(contexts.map(async (item) => {
    const result = await githubApi(env, "GET", `${repoPathUrl(item.repo, `/commits?path=${encodeURIComponent(item.repoPath)}&per_page=${limit}`)}`);
    return (Array.isArray(result.data) ? result.data : []).map((entry) => ({
      hash: String(entry.sha || ""),
      message: String(entry.commit?.message || "").split("\n")[0],
      author: String(entry.author?.login || entry.commit?.author?.name || "Unknown author"),
      date: String(entry.commit?.author?.date || ""),
      url: String(entry.html_url || ""),
      paths: [item.workspacePath],
    }));
  }));
  const unique = new Map();
  for (const list of lists) for (const commit of list) {
    const existing = unique.get(commit.hash);
    if (existing) existing.paths.push(...commit.paths);
    else unique.set(commit.hash, commit);
  }
  const commits = [...unique.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
  return jsonResponse(request, env, {
    ok: true,
    path: contexts[0].workspacePath,
    paths: contexts.map((item) => item.workspacePath),
    repo_paths: contexts.map((item) => item.repoPath),
    repo: `${context.repo.owner}/${context.repo.repo}`,
    commits,
    count: commits.length,
    fetched_at: new Date().toISOString(),
  });
}

async function fileCommitDiff(request, env, site) {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Only GET requests are supported.");
  const url = new URL(request.url);
  const paths = historyPaths(url);
  const hash = String(url.searchParams.get("hash") || "");
  if (!paths || !/^[a-f0-9]{7,64}$/i.test(hash)) throw new ApiError(400, "invalid_request", "A valid path and commit hash are required.");
  const contexts = paths.map((path) => workspacePathFor(site, path));
  if (contexts.some((context) => !context) || contexts.some((item) => item.repo.repo !== contexts[0].repo.repo)) {
    throw new ApiError(400, "invalid_request", "Diff lookup is limited to one fixed repository and allowed paths.");
  }
  const repo = contexts[0].repo;
  const commit = (await githubApi(env, "GET", repoPathUrl(repo, `/commits/${encodeURIComponent(hash)}`), { accept: "application/vnd.github+json" })).data;
  const diffs = [];
  for (const context of contexts) {
    const changed = (commit.files || []).find((entry) => entry.filename === context.repoPath || entry.previous_filename === context.repoPath);
    if (!changed) continue;
    const binary = /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|woff2?|mp4|webm)$/i.test(context.repoPath);
    let before = null;
    let after = null;
    if (!binary && changed.status !== "added" && commit.parents?.[0]?.sha) {
      before = await readTextFile(env, repo, changed.previous_filename || context.repoPath, commit.parents[0].sha);
    }
    if (!binary && changed.status !== "removed") after = await readTextFile(env, repo, changed.filename || context.repoPath, hash);
    diffs.push({
      path: changed.filename || context.workspacePath,
      hash,
      status: changed.status || "modified",
      before_path: changed.previous_filename || context.repoPath,
      after_path: changed.filename || context.repoPath,
      additions: Number(changed.additions || 0),
      deletions: Number(changed.deletions || 0),
      patch: changed.patch || null,
      before,
      after,
    });
  }
  if (!diffs.length) throw new ApiError(404, "diff_not_found", "This commit does not include changes for the requested file.");
  const base = { ok: true, repo: `${repo.owner}/${repo.repo}`, paths: contexts.map((item) => item.workspacePath), repo_paths: contexts.map((item) => item.repoPath), fetched_at: new Date().toISOString() };
  return jsonResponse(request, env, diffs.length === 1 ? { ...base, path: contexts[0].workspacePath, diff: diffs[0] } : { ...base, diffs });
}

async function readTextFile(env, repo, path, ref) {
  try {
    const result = await githubApi(env, "GET", repoPathUrl(repo, `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`));
    return decodeContent(result.data);
  } catch {
    return null;
  }
}

function decodeContent(file) {
  if (!file || file.type !== "file" || !file.content) return null;
  try { return new TextDecoder().decode(base64Bytes(file.content)); } catch { return null; }
}

async function publicFile(request, env, repo, inputPath) {
  const path = safeRepoPath(inputPath, { allowDirectory: true });
  if (!path) throw new ApiError(400, "invalid_path", "A valid repository path is required.");
  const result = await githubApi(env, "GET", repoPathUrl(repo, `/contents/${encodePath(path)}`));
  if (Array.isArray(result.data)) {
    return new Response(JSON.stringify(result.data), { headers: { ...corsHeaders(request, env), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=30" } });
  }
  const file = result.data;
  if (file?.type !== "file") throw new ApiError(404, "file_not_found", "The requested repository file was not found.");
  let bytes = null;
  if (file.content) bytes = base64Bytes(file.content);
  else if (file.download_url) {
    const rawUrl = new URL(file.download_url);
    if (rawUrl.hostname !== "raw.githubusercontent.com" || !rawUrl.pathname.startsWith(`/${repo.owner}/${repo.repo}/`)) {
      throw new ApiError(502, "invalid_github_file", "GitHub returned an unexpected file location.");
    }
    const raw = await fetch(rawUrl.href, { redirect: "manual" });
    if (!raw.ok) throw new ApiError(502, "github_file_unavailable", "The public GitHub file could not be fetched.");
    return new Response(raw.body, { status: 200, headers: { ...corsHeaders(request, env), "Content-Type": raw.headers.get("Content-Type") || contentType(path), "Cache-Control": "public, max-age=60" } });
  }
  if (!bytes) throw new ApiError(502, "github_file_unavailable", "The public GitHub file could not be fetched.");
  return new Response(bytes, { status: 200, headers: { ...corsHeaders(request, env), "Content-Type": contentType(path), "Cache-Control": "public, max-age=60" } });
}

function contentType(path) {
  const extension = String(path).split(".").pop().toLowerCase();
  return ({ json: "application/json; charset=utf-8", html: "text/html; charset=utf-8", xml: "application/xml; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", pdf: "application/pdf" })[extension] || "application/octet-stream";
}

async function dataProxy(request, env, site) {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Only GET requests are supported.");
  const url = new URL(request.url);
  let path = safeRepoPath(url.searchParams.get("path"), { allowDirectory: true });
  if (!path) throw new ApiError(400, "invalid_path", "A valid data path is required.");
  let repo;
  if (site === "gravepedia") {
    if (!path.startsWith("data/memorials/")) throw new ApiError(400, "invalid_path", "Only public Gravepedia memorial data can be read here.");
    repo = REPOSITORIES.gravepediaSite;
  } else {
    if (path.startsWith("data/Genepedia-Database/")) path = path.slice("data/Genepedia-Database/".length);
    if (path.startsWith("data/people/")) path = path.slice("data/".length);
    if (!/^(people|pets|statistics)\//.test(path)) throw new ApiError(400, "invalid_path", "Only public people, pet, and statistics data can be read here.");
    repo = REPOSITORIES.genepediaDatabase;
  }
  return publicFile(request, env, repo, path);
}

async function mediaProxy(request, env, site) {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Only GET requests are supported.");
  const url = new URL(request.url);
  const path = safeRepoPath(url.searchParams.get("path"), { allowDirectory: true });
  if (!path || !/^(pages|people)\/[A-Za-z0-9_./-]+$/.test(path)) throw new ApiError(400, "invalid_path", "A valid public media path is required.");
  return publicFile(request, env, site === "gravepedia" ? REPOSITORIES.gravepediaMedia : REPOSITORIES.genepediaMedia, path);
}

async function getJsonFile(env, repo, path, token = null) {
  try {
    const result = await githubApi(env, "GET", repoPathUrl(repo, `/contents/${encodePath(path)}`), { token });
    let content = decodeContent(result.data);
    if (content === null && result.data?.download_url) {
      const rawUrl = new URL(result.data.download_url);
      if (rawUrl.hostname !== "raw.githubusercontent.com" || !rawUrl.pathname.startsWith(`/${repo.owner}/${repo.repo}/`)) return null;
      const raw = await fetch(rawUrl.href, { redirect: "manual" });
      if (!raw.ok) return null;
      content = await raw.text();
    }
    if (content === null) return null;
    return JSON.parse(content);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function personBucket(personId) {
  const digits = String(personId).replace(/[^0-9]/g, "");
  const number = Number.parseInt(digits || "0", 10) || 0;
  return Math.floor((Math.max(1, number) - 1) / 1000);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function profileIdentity(user, personId, fallbackName = "") {
  const login = String(user?.login || "").trim();
  const displayName = String(fallbackName || user?.displayName || login || "Genepedia user").trim();
  return { personId, name: displayName || login, githubLogin: login };
}

function parsePhpBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["1", "true", "on", "yes"].includes(String(value).trim().toLowerCase());
}

function profileConfigWithOwner(config, user, personId, claimSelf, fallbackName = "") {
  const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  const identity = profileIdentity(user, personId, fallbackName);
  if (!next.creator || typeof next.creator !== "object" || Array.isArray(next.creator)) next.creator = identity;
  const maintainers = Array.isArray(next.maintainers) ? next.maintainers.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
  if (!maintainers.some((item) => String(item.githubLogin || "").toLowerCase() === identity.githubLogin.toLowerCase())) maintainers.push(identity);
  next.maintainers = maintainers;
  next.owner = claimSelf ? identity : null;
  return next;
}

async function githubPathExists(env, repo, path) {
  try {
    const result = await githubApi(env, "GET", repoPathUrl(repo, `/contents/${encodePath(path)}`));
    return result.data?.type === "file";
  } catch (error) {
    if (Number(error?.status) === 404) return false;
    throw error;
  }
}

function groupedFilesForWorkspace(files) {
  const groups = new Map();
  for (const file of files) {
    const path = safeRepoPath(file.path);
    if (!path) throw new ApiError(400, "invalid_path", "A submitted file path is invalid.");
    const databasePrefix = "data/Genepedia-Database/";
    const isDatabase = path.startsWith(databasePrefix);
    const repo = isDatabase ? REPOSITORIES.genepediaDatabase : REPOSITORIES.genepediaSite;
    const repoPath = isDatabase ? path.slice(databasePrefix.length) : path;
    const key = repo.repo;
    if (!groups.has(key)) groups.set(key, { repo, files: [], workspacePaths: [] });
    groups.get(key).files.push({ path: repoPath, content: file.content });
    groups.get(key).workspacePaths.push(path);
  }
  return [...groups.values()];
}

async function publishPullRequestGroups(env, groups, options) {
  const results = [];
  const created = [];
  const pending = groups.filter((group) => group.files.length);
  for (const group of pending) {
    const totalBytes = group.files.reduce((sum, file) => sum + new TextEncoder().encode(String(file.content || "")).length, 0);
    if (totalBytes > 4_000_000) throw new ApiError(413, "files_too_large", "The submitted repository changes exceed the 4 MB limit.");
  }
  for (const group of pending) {
    let result;
    try {
      result = await createPullRequest(env, group.repo, group.files, {
        ...options,
        accessToken: options.accessToken || "",
      });
    } catch (error) {
      if (!created.length) throw error;
      const cleanup = [];
      for (const item of [...created].reverse()) {
        const number = Number(item.result.pull_request?.number || 0);
        const state = { repo: `${item.group.repo.owner}/${item.group.repo.repo}`, number, url: String(item.result.pull_request?.url || ""), branch: item.result.branch, closed: false, branch_deleted: false };
        try {
          if (!number) throw new ApiError(502, "pull_request_id_unavailable", "The created pull request did not include a usable number.");
          await githubWriteWithFallback(env, options.accessToken || "", "PATCH", repoPathUrl(item.group.repo, `/pulls/${number}`), { state: "closed" });
          state.closed = true;
          try {
            await githubWriteWithFallback(env, options.accessToken || "", "DELETE", repoPathUrl(item.group.repo, `/git/refs/heads/${encodePath(item.result.branch)}`));
            state.branch_deleted = true;
          } catch (cleanupError) {
            state.cleanup_error = String(cleanupError?.code || "branch_delete_failed");
          }
        } catch (cleanupError) {
          state.cleanup_error = String(cleanupError?.code || "pull_request_close_failed");
        }
        cleanup.push(state);
      }
      const createdPullRequests = results.map((item) => ({ repo: item.repo, number: Number(item.pull_request?.number || 0), url: String(item.pull_request?.url || ""), branch: item.branch }));
      const openPullRequests = cleanup.filter((item) => !item.closed).map(({ repo, number, url, branch }) => ({ repo, number, url, branch }));
      throw new ApiError(502, "partial_publish_failed", "A later repository update failed. Earlier pull requests were closed where possible; review the cleanup details before retrying.", {
        failed_repo: `${group.repo.owner}/${group.repo.repo}`,
        cause: String(error?.code || "repository_publish_failed"),
        created_pull_requests: createdPullRequests,
        cleanup,
        open_pull_requests: openPullRequests,
      });
    }
    results.push({
      kind: group.repo.repo === "Genepedia-Database" ? "database" : "site",
      repo: `${group.repo.owner}/${group.repo.repo}`,
      paths: group.workspacePaths,
      repo_paths: group.files.map((file) => file.path),
      branch: result.branch,
      base_branch: result.baseBranch,
      commit: result.commit,
      pull_request: result.pull_request,
      published_directly: false,
    });
    created.push({ group, result });
  }
  const primary = results.find((result) => result.kind === "site") || results[0] || {};
  return {
    repo: primary.repo || "",
    branch: primary.branch || "",
    base_branch: primary.base_branch || "",
    commit: primary.commit || null,
    pull_request: primary.pull_request || null,
    paths: results.flatMap((result) => result.paths),
    published_directly: false,
    results,
  };
}

async function githubSelfProfile(request, env, site) {
  if (site !== "genepedia") throw new ApiError(404, "not_found", "This API endpoint is only available for Genepedia.");
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Only POST requests are supported.");
  const payload = await readJson(request);
  const action = String(payload.action || "").trim().toLowerCase();
  if (!["create", "claim"].includes(action)) throw new ApiError(400, "invalid_action", "Action must be create or claim.");
  const personId = String(payload.person_id || payload.person || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(personId)) throw new ApiError(400, "invalid_person", "A valid person id is required.");
  const editor = await requireUser(request, env);
  const login = String(editor.user.login || "").trim();
  if (!login) throw new ApiError(401, "authentication_required", "GitHub login is required to save a self profile.");
  const bucket = personBucket(personId);
  const ownershipRepoPath = `people/ownership/${bucket}/${personId}.json`;
  const workspaceOwnershipPath = `data/Genepedia-Database/${ownershipRepoPath}`;

  if (action === "claim") {
    const current = await getJsonFile(env, REPOSITORIES.genepediaDatabase, ownershipRepoPath);
    if (!current || typeof current !== "object" || Array.isArray(current)) throw new ApiError(404, "profile_not_found", "That profile does not have profile metadata to claim.");
    const ownerLogin = String(current.owner?.githubLogin || current.owner?.login || "").trim();
    if (ownerLogin && ownerLogin.toLowerCase() !== login.toLowerCase()) throw new ApiError(409, "profile_already_claimed", "That profile has already been claimed.");
    const next = profileConfigWithOwner(current, editor.user, personId, true, String(current.owner?.name || ""));
    if (JSON.stringify(current) === JSON.stringify(next)) {
      return jsonResponse(request, env, { ok: true, repo: "Genepedia/Genepedia-Database", person: personId, action: "claim", commit: null, claimed_at: new Date().toISOString() });
    }
    const message = String(payload.commit_message || `Claim profile ${personId} for @${login}`).trim().slice(0, 240);
    const result = await publishPullRequestGroups(env, [{
      repo: REPOSITORIES.genepediaDatabase,
      workspacePaths: [workspaceOwnershipPath],
      files: [{ path: ownershipRepoPath, content: jsonText(next) }],
    }], {
      accessToken: editor.token,
      branchPrefix: "profile-claim",
      title: message,
      body: `Profile ${personId} ownership was submitted for review by @${login}.`,
      commitMessage: message,
      user: editor.user,
    });
    return jsonResponse(request, env, { ok: true, repo: "Genepedia/Genepedia-Database", person: personId, action: "claim", branch: result.branch, commit: result.commit, pull_request: result.pull_request, results: result.results, claimed_at: new Date().toISOString() }, 201);
  }

  const rawFiles = Array.isArray(payload.files) ? payload.files : [];
  if (!rawFiles.length || rawFiles.length > 12) throw new ApiError(400, "invalid_files", "A new profile must publish between one and twelve files.");
  const profileKind = String(payload.profile_kind || "person").trim().toLowerCase() === "pet" ? "pet" : "person";
  const profileFolder = profileKind === "pet" ? `pages/pets/${personId}` : `pages/people/${personId}`;
  const recordPath = `data/Genepedia-Database/people/persons/${bucket}/${personId}.json`;
  const allowed = new Set([`${profileFolder}/index.html`, `${profileFolder}/profile.html`, recordPath, workspaceOwnershipPath, "pages/people/people.json"]);
  const byPath = new Map();
  for (const entry of rawFiles) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const path = String(entry.path || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    const content = String(entry.content ?? "");
    if (!allowed.has(path)) throw new ApiError(400, "invalid_path", `Self-profile creation cannot publish ${path || "that path"}.`);
    if (!content || content.length > 1_500_000) throw new ApiError(400, "invalid_content", `Profile file content is required for ${path}.`);
    if (path.endsWith(".html") && !content.includes("<")) throw new ApiError(400, "invalid_content", "HTML profile files must contain markup.");
    if (path.endsWith(".json")) {
      try { JSON.parse(content); } catch { throw new ApiError(400, "invalid_content", `${path} must be valid JSON.`); }
    }
    byPath.set(path, { path, content });
  }
  for (const path of [`${profileFolder}/index.html`, `${profileFolder}/profile.html`, recordPath, workspaceOwnershipPath]) {
    if (!byPath.has(path)) throw new ApiError(400, "missing_file", `New profiles must include ${path}.`);
  }
  const indexPath = `${profileFolder}/index.html`;
  if (await githubPathExists(env, REPOSITORIES.genepediaSite, indexPath)
    || await githubPathExists(env, REPOSITORIES.genepediaDatabase, `people/persons/${bucket}/${personId}.json`)) {
    throw new ApiError(409, "profile_exists", "That profile id already exists. Refresh and try again.");
  }
  const ownerEntry = byPath.get(workspaceOwnershipPath);
  let config;
  try { config = JSON.parse(ownerEntry.content); } catch { config = {}; }
  const fallbackName = String(config?.owner?.name || config?.creator?.name || "").trim();
  const nextConfig = profileConfigWithOwner(config, editor.user, personId, parsePhpBoolean(payload.claim_self, true), fallbackName);
  ownerEntry.content = jsonText(nextConfig);
  const workFiles = [...byPath.values()];
  const groups = groupedFilesForWorkspace(workFiles);
  const message = String(payload.commit_message || `Create self profile ${personId} for @${login}`).trim().slice(0, 240);
  const result = await publishPullRequestGroups(env, groups, {
    accessToken: editor.token,
    branchPrefix: "self-profile",
    title: message,
    body: `New ${profileKind} profile ${personId} submitted by @${login} for review.\n\nFiles: ${workFiles.map((file) => `\`${file.path}\``).join(", ")}`,
    commitMessage: message,
    user: editor.user,
  });
  return jsonResponse(request, env, {
    ok: true,
    repo: result.repo,
    person: personId,
    action: "create",
    paths: result.paths,
    branch: result.branch,
    base_branch: result.base_branch,
    commit: result.commit,
    pull_request: result.pull_request,
    published_directly: false,
    results: result.results,
    published_at: new Date().toISOString(),
  }, 201);
}

function parseMaintainerPaths(value) {
  const parts = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(parts.map((part) => String(part || "").replace(/\\/g, "/").trim().replace(/^\/+/, "")).filter(Boolean))];
}

function maintainerTarget(paths) {
  if (!paths.length || paths.length > 12) return null;
  let personId = "";
  for (const path of paths) {
    if (!safeRepoPath(path)) { personId = ""; break; }
    const match = path.match(/^people\/([A-Za-z0-9_-]+)\/(?:index\.html|profile\.html|data\/[A-Za-z0-9_.-]+|data\/|media\/[A-Za-z0-9_.-]+|media\/)/);
    if (!match || (personId && personId !== match[1])) { personId = ""; break; }
    personId = match[1];
  }
  if (personId) {
    const bucket = personBucket(personId);
    return {
      type: "profile",
      key: `profile:${personId}`,
      person_id: personId,
      editable_path: `pages/people/${personId}/profile.html`,
      metadata_path: `data/Genepedia-Database/people/ownership/${bucket}/${personId}.json`,
      metadata_repo: REPOSITORIES.genepediaDatabase,
      metadata_repo_path: `people/ownership/${bucket}/${personId}.json`,
      label: `Profile ${personId}`,
    };
  }
  if (paths.length !== 1 || !/^pages\/[A-Za-z0-9_./-]+\.html$/.test(paths[0]) || !safeRepoPath(paths[0])) return null;
  const path = paths[0];
  return {
    type: "page",
    key: `page:${path}`,
    editable_path: path,
    metadata_path: path.replace(/\.html$/, ".json"),
    metadata_repo: REPOSITORIES.genepediaSite,
    metadata_repo_path: path.replace(/\.html$/, ".json"),
    label: path.split("/").pop().replace(/_/g, " ").replace(/\.html$/i, ""),
  };
}

function maintainerIdentity(user, fallbackLogin = "", fallbackName = "") {
  const login = String(user?.login || user?.githubLogin || fallbackLogin).trim();
  const name = String(fallbackName || user?.displayName || user?.name || login).trim();
  const identity = { name: name || login, githubLogin: login };
  const personId = String(user?.personId || user?.person_id || "").trim();
  if (personId) identity.personId = personId;
  return identity;
}

function identityLogins(value) {
  if (Array.isArray(value)) return value.flatMap(identityLogins);
  if (typeof value === "string") return /^[A-Za-z0-9-]{1,39}$/.test(value.trim()) ? [value.trim().toLowerCase()] : [];
  if (!value || typeof value !== "object") return [];
  const login = String(value.githubLogin || value.github_login || value.login || "").trim();
  return /^[A-Za-z0-9-]{1,39}$/.test(login) ? [login.toLowerCase()] : [];
}

function profileManagerLogins(config) {
  const ownerLogin = identityLogins(config?.owner);
  const logins = [...ownerLogin, ...identityLogins(config?.maintainers)];
  if (!ownerLogin.length) logins.push(...identityLogins(config?.creator));
  return [...new Set(logins)];
}

function pageManagerLogins(config) {
  const logins = [];
  for (const key of ["creator", "createdBy", "created_by", "owner", "ownedBy", "owned_by", "maintainers", "maintainedBy", "maintained_by", "owners"]) {
    logins.push(...identityLogins(config?.[key]));
  }
  return [...new Set(logins)];
}

async function pathCreatedByUser(env, repo, path, login) {
  if (!login) return false;
  try {
    const commitsPath = repoPathUrl(repo, `/commits?path=${encodeURIComponent(path)}&per_page=100&page=1`);
    const firstPage = await githubApi(env, "GET", commitsPath);
    const firstCommits = Array.isArray(firstPage.data) ? firstPage.data : [];
    const lastPage = lastCommitHistoryPage(firstPage.headers.get("Link"));
    if (!lastPage && firstCommits.length >= 100) return false;
    const commits = lastPage > 1
      ? (await githubApi(env, "GET", repoPathUrl(repo, `/commits?path=${encodeURIComponent(path)}&per_page=100&page=${lastPage}`))).data
      : firstCommits;
    const oldest = Array.isArray(commits) ? commits[commits.length - 1] : null;
    return String(oldest?.author?.login || "").toLowerCase() === login.toLowerCase();
  } catch { return false; }
}

function lastCommitHistoryPage(linkHeader) {
  for (const link of String(linkHeader || "").split(/,\s*(?=<)/)) {
    if (!/;\s*rel=["']?last["']?\s*(?:,|$)/i.test(link)) continue;
    const match = link.match(/<([^>]+)>/);
    if (!match) return 0;
    try {
      const url = new URL(match[1]);
      if (url.origin !== "https://api.github.com" || !url.pathname.endsWith("/commits")) return 0;
      const page = Number(url.searchParams.get("page"));
      return Number.isSafeInteger(page) && page >= 1 ? page : 0;
    } catch { return 0; }
  }
  return 0;
}

async function maintainerCanManage(env, target, config, user, hasMetadata = false) {
  const login = String(user?.login || "").toLowerCase();
  if (!login) return false;
  const reviewer = String(env.GITHUB_REVIEW_LOGIN || "").toLowerCase();
  if (reviewer && login === reviewer) return true;
  const managers = target.type === "profile" ? profileManagerLogins(config) : pageManagerLogins(config);
  if (managers.includes(login)) return true;
  // A present ownership/config record is authoritative. The original file
  // author is only a legacy fallback when no metadata exists at all.
  if (hasMetadata) return false;
  const repo = target.type === "profile" ? REPOSITORIES.genepediaSite : REPOSITORIES.genepediaSite;
  const path = target.type === "profile" ? `pages/people/${target.person_id}/index.html` : target.editable_path;
  return pathCreatedByUser(env, repo, path, login);
}

function ledgerTargetItems(ledger, target) {
  return (Array.isArray(ledger?.items) ? ledger.items : []).filter((item) => String(item?.target?.key || "") === target.key);
}

function maintainerHasPending(ledger, target, kind, login) {
  return ledgerTargetItems(ledger, target).some((item) => String(item?.kind || "") === kind
    && String(item?.status || "") === "pending"
    && String(item?.person?.githubLogin || "").toLowerCase() === login.toLowerCase());
}

function maintainerConfigWithAdded(config, identity) {
  const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  const maintainers = Array.isArray(next.maintainers) ? next.maintainers.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
  if (!maintainers.some((item) => String(item.githubLogin || item.github_login || item.login || "").toLowerCase() === identity.githubLogin.toLowerCase())) maintainers.push(identity);
  next.maintainers = maintainers;
  return next;
}

async function githubMaintainers(request, env, site) {
  if (site !== "genepedia") throw new ApiError(404, "not_found", "This API endpoint is only available for Genepedia.");
  let payload = {};
  let targetPaths;
  if (request.method === "POST") {
    payload = await readJson(request, 64_000);
    targetPaths = parseMaintainerPaths(payload.paths ?? payload.path);
  } else if (request.method === "GET") {
    const url = new URL(request.url);
    targetPaths = parseMaintainerPaths(url.searchParams.get("paths") || url.searchParams.get("path") || "");
  } else {
    throw new ApiError(405, "method_not_allowed", "Only GET and POST requests are supported.");
  }
  const target = maintainerTarget(targetPaths);
  if (!target) throw new ApiError(400, "invalid_target", "A valid editable page or profile target is required.");
  const editor = request.method === "POST" ? await requireUser(request, env) : null;
  const [maybeUser, rawLedger, rawConfig] = await Promise.all([
    request.method === "GET" ? sessionFromRequest(request, env).catch(() => null) : Promise.resolve(null),
    getJsonFile(env, REPOSITORIES.genepediaSite, "data/maintainer-invitations.json"),
    getJsonFile(env, target.metadata_repo, target.metadata_repo_path),
  ]);
  const ledger = { version: 1, items: Array.isArray(rawLedger?.items) ? rawLedger.items.filter((item) => item && typeof item === "object") : [] };
  const hasMetadata = rawConfig !== null && typeof rawConfig === "object" && !Array.isArray(rawConfig);
  const config = hasMetadata ? rawConfig : {};
  const user = editor?.user || maybeUser?.user || null;
  const canManage = await maintainerCanManage(env, target, config, user, hasMetadata);
  const currentLogins = target.type === "profile" ? profileManagerLogins(config) : pageManagerLogins(config);
  const isMaintainer = canManage || Boolean(user?.login && currentLogins.includes(user.login.toLowerCase()));
  if (request.method === "GET") {
    return jsonResponse(request, env, {
      ok: true,
      repo: "Genepedia/Genepedia",
      target,
      items: ledgerTargetItems(ledger, target),
      can_manage: canManage,
      is_maintainer: isMaintainer,
      current_user: user ? { login: user.login, displayName: user.displayName, photoUrl: user.photoUrl, profileUrl: user.profileUrl } : null,
      fetched_at: new Date().toISOString(),
    });
  }
  const action = String(payload.action || "").trim().toLowerCase();
  const userLogin = String(editor.user.login || "").toLowerCase();
  const now = new Date().toISOString();
  let nextConfig = config;
  if (action === "request") {
    if (isMaintainer) throw new ApiError(409, "already_maintainer", "You are already a maintainer for this target.");
    if (!userLogin) throw new ApiError(400, "missing_login", "A GitHub login is required.");
    if (maintainerHasPending(ledger, target, "request", userLogin)) throw new ApiError(409, "request_exists", "You already have a pending maintainer request.");
    const identity = maintainerIdentity(editor.user);
    ledger.items.push({ id: `maint-${randomHex(8)}`, target, kind: "request", status: "pending", person: identity, createdBy: identity, createdAt: now });
  } else if (action === "invite") {
    if (!canManage) throw new ApiError(403, "not_allowed", "Only current maintainers can invite new maintainers.");
    const inviteLogin = String(payload.github_login || payload.login || "").trim();
    if (!/^[A-Za-z0-9-]{1,39}$/.test(inviteLogin)) throw new ApiError(400, "invalid_login", "A valid GitHub login is required.");
    if (maintainerHasPending(ledger, target, "invite", inviteLogin)) throw new ApiError(409, "invite_exists", "That person already has a pending maintainer invitation.");
    const identity = maintainerIdentity({}, inviteLogin, String(payload.name || inviteLogin));
    ledger.items.push({ id: `maint-${randomHex(8)}`, target, kind: "invite", status: "pending", person: identity, createdBy: maintainerIdentity(editor.user), createdAt: now });
  } else if (["approve", "decline", "cancel", "accept_invite", "decline_invite"].includes(action)) {
    const id = String(payload.id || "").trim();
    const index = ledger.items.findIndex((item) => String(item.id || "") === id);
    if (!id || index < 0) throw new ApiError(404, "item_not_found", "That maintainer invitation or request could not be found.");
    const item = ledger.items[index];
    if (String(item.target?.key || "") !== target.key || String(item.status || "") !== "pending") throw new ApiError(409, "item_not_pending", "That maintainer invitation or request is no longer pending.");
    const kind = String(item.kind || "");
    const itemLogin = String(item.person?.githubLogin || "").toLowerCase();
    let decision;
    if (["approve", "decline", "cancel"].includes(action)) {
      if (!canManage) throw new ApiError(403, "not_allowed", "Only current maintainers can manage maintainer requests.");
      if (action === "approve" && kind !== "request") throw new ApiError(400, "invalid_action", "Only maintainer requests can be approved by maintainers.");
      decision = action === "approve" ? "accepted" : action === "cancel" ? "cancelled" : "declined";
    } else {
      if (kind !== "invite" || !itemLogin || itemLogin !== userLogin) throw new ApiError(403, "not_allowed", "Only the invited GitHub user can respond to this invitation.");
      decision = action === "accept_invite" ? "accepted" : "declined";
    }
    item.status = decision;
    item.decidedBy = maintainerIdentity(editor.user);
    item.decidedAt = now;
    ledger.items[index] = item;
    if (decision === "accepted") nextConfig = maintainerConfigWithAdded(config, item.person || {});
  } else {
    throw new ApiError(400, "invalid_action", "Action must be request, invite, approve, decline, cancel, accept_invite or decline_invite.");
  }

  const message = `${action.replace(/_/g, " ")} maintainer access for ${target.label}`.slice(0, 240);
  const groups = [];
  const ledgerGroup = { repo: REPOSITORIES.genepediaSite, workspacePaths: ["data/maintainer-invitations.json"], files: [{ path: "data/maintainer-invitations.json", content: jsonText(ledger) }] };
  groups.push(ledgerGroup);
  if (JSON.stringify(nextConfig) !== JSON.stringify(config)) {
    groups.push({
      repo: target.metadata_repo,
      workspacePaths: [target.metadata_path],
      files: [{ path: target.metadata_repo_path, content: jsonText(nextConfig) }],
    });
  }
  const result = await publishPullRequestGroups(env, groups, {
    accessToken: editor.token,
    branchPrefix: "maintainer",
    title: message,
    body: `Maintainer action ${action} for ${target.label}, submitted by @${editor.user.login}.`,
    commitMessage: message,
    user: editor.user,
  });
  const refreshedCanManage = await maintainerCanManage(env, target, nextConfig, editor.user, true);
  return jsonResponse(request, env, {
    ok: true,
    repo: result.repo,
    target,
    items: ledgerTargetItems(ledger, target),
    can_manage: refreshedCanManage,
    is_maintainer: refreshedCanManage || profileManagerLogins(nextConfig).includes(userLogin),
    commit: result.commit,
    pull_request: result.pull_request,
    published_directly: false,
    results: result.results,
    published_at: new Date().toISOString(),
  }, 201);
}

function normalizeTalkMessage(message) {
  return {
    id: String(message?.id || ""),
    body: String(message?.body || ""),
    author_login: String(message?.author_login || ""),
    author_name: String(message?.author_name || ""),
    author_avatar: String(message?.author_avatar || ""),
    author_url: String(message?.author_url || ""),
    created_at: String(message?.created_at || ""),
  };
}

async function readTalkFile(env, repo, path, token) {
  try {
    const result = await githubApi(env, "GET", repoPathUrl(repo, `/contents/${encodePath(path)}`), { token });
    let content = decodeContent(result.data);
    if (content === null && result.data?.download_url) {
      const rawUrl = new URL(result.data.download_url);
      if (rawUrl.hostname !== "raw.githubusercontent.com" || !rawUrl.pathname.startsWith(`/${repo.owner}/${repo.repo}/`)) throw new ApiError(502, "invalid_github_file", "GitHub returned an unexpected talk file location.");
      const response = await fetch(rawUrl.href, { redirect: "manual" });
      if (!response.ok) throw new ApiError(502, "github_file_unavailable", "The talk file could not be fetched.");
      content = await response.text();
    }
    let decoded = {};
    try { decoded = content ? JSON.parse(content) : {}; } catch { decoded = {}; }
    return { sha: String(result.data?.sha || ""), branch: "", messages: Array.isArray(decoded?.messages) ? decoded.messages.filter((item) => item && typeof item === "object").map(normalizeTalkMessage) : [] };
  } catch (error) {
    if (Number(error?.status) === 404) return { sha: "", branch: "", messages: [] };
    throw error;
  }
}

function encodeUtf8Base64(value) {
  return bytesToBase64(new TextEncoder().encode(String(value)));
}

async function saveTalkFile(env, repo, path, transformMessages, editor, message) {
  const tokens = await writeTokens(env, editor.token);
  if (!tokens.length) throw new ApiError(503, "publish_auth_unavailable", "GitHub repository write access is not configured.");
  let lastError = null;
  for (const token of tokens) {
    try {
      const repository = (await githubApi(env, "GET", repoPathUrl(repo), { token })).data;
      const branch = String(repository.default_branch || "main");
      let latest = await readTalkFile(env, repo, path, token);
      for (let attempt = 0; attempt < 3; attempt++) {
        const messages = transformMessages(latest.messages.map(normalizeTalkMessage));
        const content = `${JSON.stringify({ messages }, null, 2)}\n`;
        try {
          const response = await githubApi(env, "PUT", repoPathUrl(repo, `/contents/${encodePath(path)}`), {
            token,
            body: { message, content: encodeUtf8Base64(content), ...(latest.sha ? { sha: latest.sha } : {}), branch },
          });
          return { branch, commit: { sha: String(response.data?.commit?.sha || ""), message }, messages };
        } catch (error) {
          if (![409, 422, 502].includes(Number(error?.status)) || attempt === 2) throw error;
          latest = await readTalkFile(env, repo, path, token);
        }
      }
    } catch (error) {
      lastError = error;
      if (![401, 403, 404, 502, 503].includes(Number(error?.status))) throw error;
    }
  }
  throw lastError || new ApiError(503, "publish_auth_unavailable", "GitHub repository write access is not configured.");
}

async function githubTalk(request, env, site) {
  if (site !== "genepedia") throw new ApiError(404, "not_found", "This API endpoint is only available for Genepedia.");
  const url = new URL(request.url);
  if (request.method === "GET") {
    const personId = String(url.searchParams.get("person") || "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(personId)) throw new ApiError(400, "invalid_person", "A valid person id is required.");
    const repo = REPOSITORIES.genepediaSite;
    const path = `pages/people/${personId}/data/talk.json`;
    const [talk, config, viewer] = await Promise.all([
      readTalkFile(env, repo, path, null),
      getJsonFile(env, REPOSITORIES.genepediaDatabase, `people/ownership/${personBucket(personId)}/${personId}.json`).catch(() => null),
      sessionFromRequest(request, env).catch(() => null),
    ]);
    const user = viewer?.user || null;
    const canModerate = Boolean(user?.login && (
      (env.GITHUB_REVIEW_LOGIN && String(env.GITHUB_REVIEW_LOGIN).toLowerCase() === user.login.toLowerCase())
      || profileManagerLogins(config).includes(user.login.toLowerCase())
    ));
    const messages = talk.messages.map(normalizeTalkMessage);
    return jsonResponse(request, env, { ok: true, repo: "Genepedia/Genepedia", person: personId, messages, count: messages.length, can_moderate: canModerate, viewer_login: String(user?.login || ""), fetched_at: new Date().toISOString() });
  }
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Only GET and POST requests are supported.");
  const payload = await readJson(request, 64_000);
  const action = String(payload.action || "post").trim().toLowerCase();
  if (!["post", "delete"].includes(action)) throw new ApiError(400, "invalid_action", "Action must be post or delete.");
  const personId = String(payload.person_id || payload.person || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(personId)) throw new ApiError(400, "invalid_person", "A valid person id is required.");
  const editor = await requireUser(request, env);
  const repo = REPOSITORIES.genepediaSite;
  const path = `pages/people/${personId}/data/talk.json`;
  let talk = await readTalkFile(env, repo, path, editor.token);
  let messages = talk.messages.map(normalizeTalkMessage);
  if (action === "post") {
    const body = String(payload.body || "").replace(/\r\n/g, "\n").trim();
    if (!body) throw new ApiError(400, "empty_message", "A message is required.");
    if ([...body].length > 5000) throw new ApiError(400, "message_too_long", "Messages must be at most 5000 characters.");
    if (messages.length >= 2000) throw new ApiError(400, "talk_page_full", "This talk page has reached its maximum number of messages.");
    const now = new Date().toISOString();
    const authorUrl = editor.user.profileUrl || `https://github.com/${editor.user.login}`;
    const message = normalizeTalkMessage({
      id: `msg-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomHex(4)}`,
      body,
      author_login: editor.user.login,
      author_name: editor.user.displayName || editor.user.login,
      author_avatar: editor.user.photoUrl || "",
      author_url: authorUrl,
      created_at: now,
    });
    const saved = await saveTalkFile(env, repo, path, (latest) => latest.some((item) => item.id === message.id) ? latest : [...latest, message], editor, `Talk: new message on profile ${personId} from @${editor.user.login}`);
    return jsonResponse(request, env, { ok: true, repo: "Genepedia/Genepedia", person: personId, action: "post", message, messages: saved.messages.map(normalizeTalkMessage), commit: saved.commit, branch: saved.branch, posted_at: now }, 201);
  }
  const messageId = String(payload.message_id || "").trim();
  if (!messageId) throw new ApiError(400, "invalid_message", "A message id is required.");
  const target = messages.find((message) => message.id === messageId);
  if (!target) throw new ApiError(404, "message_not_found", "That message no longer exists.");
  const config = await getJsonFile(env, REPOSITORIES.genepediaDatabase, `people/ownership/${personBucket(personId)}/${personId}.json`).catch(() => null);
  const author = editor.user.login.toLowerCase() === target.author_login.toLowerCase();
  const reviewer = String(env.GITHUB_REVIEW_LOGIN || "").toLowerCase() === editor.user.login.toLowerCase();
  const manager = profileManagerLogins(config).includes(editor.user.login.toLowerCase());
  if (!author && !reviewer && !manager) throw new ApiError(403, "not_allowed", "Only the message author or a profile maintainer can delete this message.");
  const nextMessages = messages.filter((message) => message.id !== messageId);
  const now = new Date().toISOString();
  const saved = await saveTalkFile(env, repo, path, (latest) => latest.some((message) => message.id === messageId) ? latest.filter((message) => message.id !== messageId) : latest, editor, `Talk: remove message ${messageId} on profile ${personId} (by @${editor.user.login})`);
  return jsonResponse(request, env, { ok: true, repo: "Genepedia/Genepedia", person: personId, action: "delete", deleted_id: messageId, messages: saved.messages.map(normalizeTalkMessage), commit: saved.commit, branch: saved.branch, deleted_at: now });
}

function normalizeMemorial(value) {
  const text = (key, max = 20_000) => String(value?.[key] || "").trim().slice(0, max);
  return {
    id: text("id", 120),
    name: text("name", 300),
    cemetery: text("cemetery", 500),
    birth_date: text("birth_date", 100),
    death_date: text("death_date", 100),
    inscription: text("inscription", 12_000),
    notes: text("notes", 12_000),
    source: safeHttpUrl(text("source", 2_000)),
  };
}

function safeHttpUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

async function gravepediaMemorials(request, env) {
  const repo = REPOSITORIES.gravepediaSite;
  if (request.method === "GET") {
    const url = new URL(request.url);
    const query = String(url.searchParams.get("q") || "").trim().replace(/\s+/g, " ").slice(0, 200);
    const store = await getJsonFile(env, repo, "data/memorials/index.json");
    const values = Array.isArray(store) ? store : Array.isArray(store?.memorials) ? store.memorials : Array.isArray(store?.records) ? store.records : Array.isArray(store?.results) ? store.results : [];
    const needle = query.toLocaleLowerCase();
    const matching = values.map(normalizeMemorial).filter((item) => !needle || Object.values(item).join(" ").toLocaleLowerCase().includes(needle));
    const total = matching.length;
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    return jsonResponse(request, env, { success: true, query, results: matching.slice(0, limit), total });
  }
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Only GET and POST requests are supported.");
  const user = await requireUser(request, env);
  const payload = await readJson(request);
  const memorial = normalizeMemorial(payload);
  if (!memorial.name) throw new ApiError(400, "missing_name", "A memorial name is required.");
  const submissionId = crypto.randomUUID();
  memorial.id = submissionId;
  const record = {
    ...memorial,
    submitted_at: new Date().toISOString(),
    submitted_by: user.user.login,
    status: "pending",
  };
  const path = `data/memorials/pending/${submissionId}.json`;
  const result = await createPullRequest(env, repo, [{ path, content: `${JSON.stringify(record, null, 2)}\n` }], {
    branchPrefix: "gravepedia-memorial",
    title: `Memorial submission: ${memorial.name}`.slice(0, 240),
    body: `A new memorial record was submitted for review.\n\n- Submission ID: \`${submissionId}\`\n- Submitted by: @${user.user.login}\n- Pending data path: \`${path}\`\n\nThis record is not included in public search until a maintainer approves and merges this pull request.`,
    commitMessage: `Submit Gravepedia memorial ${submissionId}`,
    user: user.user,
    accessToken: user.token,
  });
  return jsonResponse(request, env, {
    success: true,
    status: "pending",
    submission_id: submissionId,
    message: "Your memorial has been submitted for review.",
    pull_request: result.pull_request?.html_url || "",
  }, 201);
}

function validEditablePath(site, path) {
  const context = workspacePathFor(site, path);
  if (!context) return null;
  if (site === "gravepedia" && !/^pages\/[A-Za-z0-9_./-]+\.html$/.test(path)) return null;
  if (site === "genepedia" && context.repo.repo === "Genepedia-Database" && !/\.json$/i.test(context.repoPath)) return null;
  if (site === "genepedia" && context.repo.repo === "Genepedia" && !/^(pages|people)\//.test(path) && path !== "sitemap.xml") return null;
  return context;
}

async function submitPageEdit(request, env, site) {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Only POST requests are supported.");
  const user = await requireUser(request, env);
  const payload = await readJson(request);
  const rawFiles = Array.isArray(payload.files) && payload.files.length
    ? payload.files
    : [{ path: payload.path, content: payload.content }];
  if (!rawFiles.length || rawFiles.length > 12) throw new ApiError(400, "invalid_files", "Between one and twelve files can be submitted at a time.");
  const contexts = [];
  for (const file of rawFiles) {
    const path = String(file?.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const context = validEditablePath(site, path);
    const content = String(file?.content || "");
    if (!context || !content || content.length > 1_500_000) throw new ApiError(400, "invalid_file", "A submitted file path or its content is invalid.");
    if (context.repoPath.endsWith(".json") && (() => { try { JSON.parse(content); return false; } catch { return true; } })()) {
      throw new ApiError(400, "invalid_content", `${path} must contain valid JSON.`);
    }
    contexts.push({ ...context, content });
  }
  if (contexts.some((item) => item.repo.repo !== contexts[0].repo.repo)) throw new ApiError(400, "invalid_files", "One pull request cannot change files in more than one repository.");
  const result = await createPullRequest(env, contexts[0].repo, contexts.map((item) => ({ path: item.repoPath, content: item.content })), {
    branchPrefix: "site-edit",
    title: String(payload.pr_title || payload.commit_message || `Site edit by @${user.user.login}`).trim().slice(0, 240),
    body: String(payload.pr_body || `Submitted by @${user.user.login} through the site editor.`).slice(0, 20_000),
    commitMessage: String(payload.commit_message || `Site edit by @${user.user.login}`).trim().slice(0, 240),
    user: user.user,
    accessToken: user.token,
  });
  return jsonResponse(request, env, {
    ok: true,
    repo: `${contexts[0].repo.owner}/${contexts[0].repo.repo}`,
    paths: contexts.map((item) => item.workspacePath),
    branch: result.branch,
    base_branch: result.baseBranch,
    commit: result.commit,
    pull_request: result.pull_request,
    published_directly: false,
    results: result.files,
  }, 201);
}

async function writeTokens(env, preferredToken = "") {
  const values = [];
  if (preferredToken) values.push(String(preferredToken));
  const configured = await apiToken(env, { write: true });
  if (configured && !values.includes(configured)) values.push(configured);
  return values;
}

async function githubWriteWithFallback(env, preferredToken, method, path, body) {
  const tokens = await writeTokens(env, preferredToken);
  if (!tokens.length) throw new ApiError(503, "publish_auth_unavailable", "GitHub repository write access is not configured.");
  let lastError = null;
  for (const token of tokens) {
    try {
      return await githubApi(env, method, path, { token, body });
    } catch (error) {
      lastError = error;
      if (![401, 403, 404, 502, 503].includes(Number(error?.status))) throw error;
    }
  }
  throw lastError || new ApiError(503, "publish_auth_unavailable", "GitHub repository write access is not configured.");
}

function githubCommitIdentity(user = {}) {
  const login = String(user.login || "editor");
  const id = String(user.id || "");
  return {
    name: String(user.displayName || user.name || login || "Genepedia Editor"),
    email: String(user.email || (id ? `${id}+${login}` : login) + "@users.noreply.github.com"),
  };
}

async function commitFilesToDefaultBranch(env, repo, files, { message, user = {}, accessToken = "" } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > 20) {
    throw new ApiError(400, "invalid_files", "Between one and twenty files are required for a repository update.");
  }
  const cleanFiles = files.map((file) => {
    const path = safeRepoPath(file?.path);
    const content = String(file?.content ?? "");
    if (!path || content.length > 4_000_000) throw new ApiError(400, "invalid_file", "A repository path or file content is invalid.");
    return { path, content };
  });
  const tokens = await writeTokens(env, accessToken);
  if (!tokens.length) throw new ApiError(503, "publish_auth_unavailable", "GitHub repository write access is not configured.");
  let lastError = null;
  for (const token of tokens) {
    try {
      const metadata = (await githubApi(env, "GET", repoPathUrl(repo), { token })).data;
      const branch = String(metadata.default_branch || "main");
      const refPath = repoPathUrl(repo, `/git/ref/heads/${encodePath(branch)}`);
      const ref = (await githubApi(env, "GET", refPath, { token })).data;
      const baseSha = String(ref.object?.sha || "");
      if (!baseSha) throw new ApiError(502, "github_base_unavailable", "The repository base branch could not be read.");
      const baseCommit = (await githubApi(env, "GET", repoPathUrl(repo, `/git/commits/${encodeURIComponent(baseSha)}`), { token })).data;
      const tree = [];
      for (const file of cleanFiles) {
        const blob = await githubApi(env, "POST", repoPathUrl(repo, "/git/blobs"), { token, body: { content: file.content, encoding: "utf-8" } });
        tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.data.sha });
      }
      const nextTree = (await githubApi(env, "POST", repoPathUrl(repo, "/git/trees"), {
        token,
        body: { base_tree: String(baseCommit.tree?.sha || ""), tree },
      })).data;
      const identity = githubCommitIdentity(user);
      const commit = (await githubApi(env, "POST", repoPathUrl(repo, "/git/commits"), {
        token,
        body: { message: String(message || "Update Genepedia data"), tree: nextTree.sha, parents: [baseSha], author: identity, committer: identity },
      })).data;
      const updated = (await githubApi(env, "PATCH", repoPathUrl(repo, `/git/refs/heads/${encodePath(branch)}`), {
        token,
        body: { sha: commit.sha, force: false },
      })).data;
      return {
        branch,
        commit: { sha: String(commit.sha || ""), message: String(message || "Update Genepedia data"), url: String(commit.html_url || "") },
        files: cleanFiles.map((file) => ({ path: file.path, status: "committed" })),
        updated_ref: String(updated.ref || ""),
      };
    } catch (error) {
      lastError = error;
      if (![401, 403, 404, 502, 503].includes(Number(error?.status))) throw error;
    }
  }
  throw lastError || new ApiError(503, "publish_auth_unavailable", "GitHub repository write access is not configured.");
}

async function createPullRequest(env, repo, files, options) {
  const repoPath = (suffix) => repoPathUrl(repo, suffix);
  const tokens = await writeTokens(env, options.accessToken || "");
  if (!tokens.length) throw new ApiError(503, "publish_auth_unavailable", "GitHub repository write access is not configured.");
  let lastError = null;
  for (const token of tokens) {
    try {
      const metadata = (await githubApi(env, "GET", repoPath(""), { token })).data;
      const baseBranch = String(metadata.default_branch || "main");
      const baseRef = (await githubApi(env, "GET", repoPath(`/git/ref/heads/${encodePath(baseBranch)}`), { token })).data;
      const baseSha = String(baseRef.object?.sha || "");
      if (!baseSha) throw new ApiError(502, "github_base_unavailable", "The repository base branch could not be read.");
      const baseCommit = (await githubApi(env, "GET", repoPath(`/git/commits/${encodeURIComponent(baseSha)}`), { token })).data;
      const tree = [];
      for (const file of files) {
        const safePath = safeRepoPath(file.path);
        if (!safePath) throw new ApiError(400, "invalid_path", "A submitted file path is invalid.");
        const blob = await githubApi(env, "POST", repoPath("/git/blobs"), { token, body: { content: file.content, encoding: file.encoding || "utf-8" } });
        tree.push({ path: safePath, mode: file.mode || "100644", type: "blob", sha: blob.data.sha });
      }
      for (const file of (options.deletions || [])) {
        const safePath = safeRepoPath(file.path);
        if (safePath) tree.push({ path: safePath, mode: "100644", type: "blob", sha: null });
      }
      const nextTree = (await githubApi(env, "POST", repoPath("/git/trees"), { token, body: { base_tree: String(baseCommit.tree?.sha || ""), tree } })).data;
      const author = githubCommitIdentity(options.user || {});
      const commit = (await githubApi(env, "POST", repoPath("/git/commits"), {
        token,
        body: { message: options.commitMessage, tree: nextTree.sha, parents: [baseSha], author, committer: author },
      })).data;
      const slug = String(options.user?.login || "contributor").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "contributor";
      const branch = `${String(options.branchPrefix || "submission").replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-${slug}-${randomHex(6)}`;
      await githubApi(env, "POST", repoPath("/git/refs"), { token, body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
      let pullRequest;
      try {
        pullRequest = (await githubApi(env, "POST", repoPath("/pulls"), { token, body: { title: options.title, body: options.body, head: branch, base: baseBranch, maintainer_can_modify: true } })).data;
      } catch (error) {
        try { await githubApi(env, "DELETE", repoPath(`/git/refs/heads/${encodePath(branch)}`), { token }); } catch { /* Preserve the pull request error. */ }
        throw error;
      }
      return {
        branch,
        baseBranch,
        commit: { sha: commit.sha, url: commit.html_url || "" },
        pull_request: { number: pullRequest.number, url: pullRequest.html_url, title: pullRequest.title, state: pullRequest.state },
        files: files.map((file) => ({ path: file.path, status: "submitted_for_review" })),
      };
    } catch (error) {
      lastError = error;
      if (![401, 403, 404, 502, 503].includes(Number(error?.status))) throw error;
    }
  }
  throw lastError || new ApiError(503, "publish_auth_unavailable", "GitHub repository write access is not configured.");
}

async function mediaList(request, env, site) {
  const url = new URL(request.url);
  const personId = String(url.searchParams.get("person") || "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(personId)) throw new ApiError(400, "invalid_person", "A valid person id is required.");
  const repo = site === "gravepedia" ? REPOSITORIES.gravepediaMedia : REPOSITORIES.genepediaMedia;
  const path = `pages/people/${personId}`;
  let directoryEntries = [];
  try {
    const listing = await githubApi(env, "GET", repoPathUrl(repo, `/contents/${encodePath(path)}`));
    directoryEntries = Array.isArray(listing.data) ? listing.data : [];
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  const images = directoryEntries.filter((item) => item.type === "file" && /\.(?:jpe?g|png|gif|webp|avif|svg|pdf)$/i.test(String(item.name || ""))).map((item) => ({
    name: String(item.name || ""),
    path: String(item.path || ""),
    download_url: String(item.download_url || ""),
    size: Number(item.size || 0),
    type: contentType(String(item.name || "")),
  }));
  let user = null;
  try { user = (await sessionFromRequest(request, env))?.user || null; } catch { user = null; }
  const canManage = user ? await canManageMedia(env, personId, user) : false;
  const pullRequests = await githubApi(env, "GET", repoPathUrl(repo, "/pulls?state=open&per_page=50"));
  const candidates = (Array.isArray(pullRequests.data) ? pullRequests.data : []).filter((item) =>
    /^media[-/]/i.test(String(item.head?.ref || "")) || /\bmedia\b/i.test(String(item.title || "")),
  );
  const pending = (await Promise.all(candidates.map(async (pullRequest) => {
    try {
      const changedFiles = await githubApi(env, "GET", repoPathUrl(repo, `/pulls/${Number(pullRequest.number)}/files?per_page=100`));
      const file = (Array.isArray(changedFiles.data) ? changedFiles.data : []).find((entry) =>
        String(entry.filename || "").startsWith(`${path}/`) && /\.(?:jpe?g|png|gif|webp|avif|svg|pdf)$/i.test(String(entry.filename || "")),
      );
      if (!file) return null;
      const branch = String(pullRequest.head?.ref || "");
      const action = /^Remove media\b/i.test(String(pullRequest.title || "")) || /^media-delete-/i.test(branch) ? "delete" : "upload";
      const imageUrl = action === "upload"
        ? `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(branch)}/${encodePath(file.filename)}`
        : "";
      return {
        number: Number(pullRequest.number || 0),
        action,
        filename: String(file.filename).split("/").pop(),
        path: String(file.filename),
        branch,
        image_url: imageUrl,
        url: String(pullRequest.html_url || ""),
        user: pullRequest.user || null,
        created_at: String(pullRequest.created_at || ""),
        updated_at: String(pullRequest.updated_at || ""),
      };
    } catch {
      return null;
    }
  }))).filter(Boolean);
  return jsonResponse(request, env, {
    ok: true,
    repo: `${repo.owner}/${repo.repo}`,
    person: personId,
    images,
    pending,
    can_manage: canManage,
    manager_logins: [],
    fetched_at: new Date().toISOString(),
  });
}

async function mediaWrite(request, env, site) {
  const user = await requireUser(request, env);
  const payload = await readJson(request);
  const personId = String(payload.person_id || payload.person || "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(personId)) throw new ApiError(400, "invalid_person", "A valid person id is required.");
  const canManage = await canManageMedia(env, personId, user.user);
  if (!canManage) throw new ApiError(403, "not_allowed", "Only a profile owner, creator, maintainer, or configured reviewer can manage its media.");
  const action = String(payload.action || "").toLowerCase();
  const repo = site === "gravepedia" ? REPOSITORIES.gravepediaMedia : REPOSITORIES.genepediaMedia;
  if (["approve", "decline"].includes(action)) {
    const number = Number(payload.number || 0);
    if (!Number.isSafeInteger(number) || number <= 0) throw new ApiError(400, "invalid_request", "A valid media pull request number is required.");
    const pullRequest = (await githubApi(env, "GET", repoPathUrl(repo, `/pulls/${number}`), { token: user.token })).data;
    const changedFiles = await githubApi(env, "GET", repoPathUrl(repo, `/pulls/${number}/files?per_page=100`), { token: user.token });
    const mediaPrefix = `pages/people/${personId}/`;
    if (!Array.isArray(changedFiles.data) || !changedFiles.data.some((file) => String(file.filename || "").startsWith(mediaPrefix))
      || !/^media[-/]/i.test(String(pullRequest.head?.ref || ""))) {
      throw new ApiError(400, "not_media_pull_request", "That pull request is not a media change for this profile.");
    }
    const result = action === "approve"
      ? (await githubWriteWithFallback(env, user.token, "PUT", repoPathUrl(repo, `/pulls/${number}/merge`), { merge_method: "squash" })).data
      : (await githubWriteWithFallback(env, user.token, "PATCH", repoPathUrl(repo, `/pulls/${number}`), { state: "closed" })).data;
    return jsonResponse(request, env, { ok: true, repo: `${repo.owner}/${repo.repo}`, person: personId, action, number, result, reviewed_at: new Date().toISOString() });
  }
  const filename = String(payload.filename || "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9._-]{0,99}\.(?:jpe?g|png|gif|webp|avif|svg|pdf)$/.test(filename) || filename.includes("..")) {
    throw new ApiError(400, "invalid_filename", "Use a supported media filename with letters, numbers, dashes, underscores, or dots.");
  }
  if (!["upload", "delete"].includes(action)) throw new ApiError(400, "invalid_action", "Media action must be upload or delete.");
  const path = `pages/people/${personId}/${filename}`;
  const files = [];
  const deletions = [];
  if (action === "upload") {
    const base64 = String(payload.content_base64 || "").replace(/^data:[^;]+;base64,/, "").trim();
    let bytes;
    try { bytes = base64Bytes(base64); } catch { throw new ApiError(400, "invalid_content", "Media must be sent as base64 content."); }
    if (!bytes.length || bytes.length > 8_000_000) throw new ApiError(400, "image_too_large", "Media files must be smaller than 8 MB.");
    files.push({ path, content: bytesToBase64(bytes), encoding: "base64" });
  } else {
    const current = await githubApi(env, "GET", repoPathUrl(repo, `/contents/${encodePath(path)}`));
    if (!current.data?.sha) throw new ApiError(404, "media_not_found", "The media file was not found.");
    deletions.push({ path });
  }
  const result = await createPullRequest(env, repo, files, {
    deletions,
    branchPrefix: action === "delete" ? "media-delete" : "media-upload",
    title: `${action === "upload" ? "Add" : "Remove"} media ${filename} for profile ${personId}`,
    body: `A media ${action} was submitted for review by @${user.user.login}.\n\nFile: \`${path}\``,
    commitMessage: `${action === "upload" ? "Add" : "Remove"} media ${filename} for profile ${personId}`,
    user: user.user,
    accessToken: user.token,
  });
  return jsonResponse(request, env, { ok: true, repo: `${repo.owner}/${repo.repo}`, person: personId, action, path, filename, branch: result.branch, base_branch: result.baseBranch, commit: result.commit, pull_request: result.pull_request, published_directly: false, submitted_at: new Date().toISOString() }, 201);
}

async function canManageMedia(env, personId, user) {
  const login = String(user?.login || "").toLowerCase();
  if (!login) return false;
  const reviewer = String(env.GITHUB_REVIEW_LOGIN || "").toLowerCase();
  if (reviewer && login === reviewer) return true;
  const numericId = Number.parseInt(String(personId).replace(/\D/g, "") || "0", 10);
  const bucket = Math.floor((Math.max(1, numericId) - 1) / 1000);
  const config = await getJsonFile(env, REPOSITORIES.genepediaDatabase, `people/ownership/${bucket}/${personId}.json`);
  if (!config || typeof config !== "object") return false;
  const ownerLogin = String(config.owner?.githubLogin || config.owner?.login || "").toLowerCase();
  const logins = Array.isArray(config.maintainers)
    ? config.maintainers.map((item) => String(item?.githubLogin || item?.login || "").toLowerCase()).filter(Boolean)
    : [];
  if (ownerLogin) return ownerLogin === login || logins.includes(login);
  const creatorLogin = String(config.creator?.githubLogin || config.creator?.login || "").toLowerCase();
  return creatorLogin === login || logins.includes(login);
}

async function listPullRequests(request, env, site) {
  const url = new URL(request.url);
  const repo = selectSiteRepo(site, url.searchParams.get("repo") || "");
  const number = Number(url.searchParams.get("number") || 0);
  const token = (await sessionFromRequest(request, env))?.token || null;
  const reviewLogin = String(env.GITHUB_REVIEW_LOGIN || "");
  const user = (await sessionFromRequest(request, env))?.user || null;
  const canReview = Boolean(user?.login && reviewLogin && user.login.toLowerCase() === reviewLogin.toLowerCase());
  if (number > 0) {
    const pullRequest = (await githubApi(env, "GET", repoPathUrl(repo, `/pulls/${number}`), { token })).data;
    const files = (await githubApi(env, "GET", repoPathUrl(repo, `/pulls/${number}/files?per_page=100`), { token })).data;
    return jsonResponse(request, env, { ok: true, repo: `${repo.owner}/${repo.repo}`, can_review: canReview, review_login: reviewLogin, pull_request: { ...pullRequest, repo: `${repo.owner}/${repo.repo}` }, diffs: (Array.isArray(files) ? files : []).map((file) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.patch || null })) , fetched_at: new Date().toISOString() });
  }
  const paths = historyPaths(url);
  const data = (await githubApi(env, "GET", repoPathUrl(repo, "/pulls?state=open&per_page=100"), { token })).data;
  let pullRequests = (Array.isArray(data) ? data : []).map((item) => ({ ...item, repo: `${repo.owner}/${repo.repo}` }));
  if (paths?.length) {
    const candidates = await Promise.all(pullRequests.map(async (item) => {
      try {
        const files = (await githubApi(env, "GET", repoPathUrl(repo, `/pulls/${item.number}/files?per_page=100`), { token })).data;
        const names = new Set((Array.isArray(files) ? files : []).map((file) => file.filename));
        return paths.some((path) => {
          const context = workspacePathFor(site, path);
          return context?.repo.repo === repo.repo && names.has(context.repoPath);
        }) ? item : null;
      } catch { return null; }
    }));
    pullRequests = candidates.filter(Boolean);
  }
  return jsonResponse(request, env, { ok: true, repo: `${repo.owner}/${repo.repo}`, paths: paths || [], pull_requests: pullRequests, count: pullRequests.length, can_review: canReview, review_login: reviewLogin, fetched_at: new Date().toISOString() });
}

async function reviewPullRequest(request, env, site) {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Only POST requests are supported.");
  const user = await requireUser(request, env);
  const reviewer = String(env.GITHUB_REVIEW_LOGIN || "");
  if (!reviewer || user.user.login.toLowerCase() !== reviewer.toLowerCase()) throw new ApiError(403, "forbidden", "This GitHub account cannot review pull requests.");
  const payload = await readJson(request, 32_768);
  const number = Number(payload.number || 0);
  const action = String(payload.action || "").toLowerCase();
  if (!Number.isSafeInteger(number) || number <= 0 || !["merge", "decline"].includes(action)) throw new ApiError(400, "invalid_request", "A valid pull request number and merge or decline action are required.");
  const repo = selectSiteRepo(site, payload.repo || "");
  let result;
  if (action === "merge") {
    result = (await githubWriteWithFallback(env, user.token, "PUT", repoPathUrl(repo, `/pulls/${number}/merge`), { merge_method: "squash" })).data;
  } else {
    result = (await githubWriteWithFallback(env, user.token, "PATCH", repoPathUrl(repo, `/pulls/${number}`), { state: "closed" })).data;
  }
  return jsonResponse(request, env, { ok: true, repo: `${repo.owner}/${repo.repo}`, number, action, result, reviewed_at: new Date().toISOString() });
}

function normalizeLocationResult(entry) {
  const address = entry?.address && typeof entry.address === "object" ? entry.address : {};
  const first = (...values) => values.map((value) => String(value || "").trim()).find(Boolean) || "";
  const placeName = first(entry?.name, address.amenity, address.tourism, address.building, address.hamlet, address.village, address.town, address.city, address.county, address.state, address.country);
  const road = first(address.road, address.pedestrian, address.footway, address.path);
  const addressLine1 = [String(address.house_number || "").trim(), road].filter(Boolean).join(" ");
  const label = String(entry?.display_name || "");
  return {
    id: `${entry?.osm_type || ""}:${entry?.osm_id || ""}`,
    label,
    type: String(entry?.type || ""),
    location: {
      label,
      placeName,
      addressLine1,
      addressLine2: first(address.suburb, address.neighbourhood, address.residential, address.borough),
      addressLine3: first(address.city_district, address.district, address.quarter),
      city: first(address.city, address.town, address.village, address.hamlet, address.municipality),
      postalCode: String(address.postcode || ""),
      county: first(address.county, address.region),
      stateProvince: first(address.state, address.province, address.state_district),
      country: String(address.country || ""),
      countryCode: String(address.country_code || "").toUpperCase(),
      latitude: String(entry?.lat || ""),
      longitude: String(entry?.lon || ""),
      source: "nominatim",
    },
  };
}

async function locationSearch(request, env) {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Only GET requests are supported.");
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 300);
  if (query.length < 2) return jsonResponse(request, env, { ok: true, query, results: [] });
  const limit = Math.max(1, Math.min(8, Number(url.searchParams.get("limit") || 6)));
  const language = String(url.searchParams.get("accept_language") || request.headers.get("Accept-Language") || "")
    .replace(/[^A-Za-z0-9,;=\-\s]/g, "").slice(0, 200);
  const search = new URL("https://nominatim.openstreetmap.org/search");
  search.search = new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: String(limit), q: query, ...(language ? { "accept-language": language } : {}) }).toString();
  const response = await fetch(search.href, { headers: { Accept: "application/json", "User-Agent": "GenepediaLocationSearch/1.0 (+https://genepedia.org)" } });
  if (!response.ok) throw new ApiError(502, "location_lookup_failed", "Could not fetch location matches right now.");
  const entries = await response.json();
  if (!Array.isArray(entries)) throw new ApiError(502, "invalid_location_response", "The location service returned an unexpected response.");
  return jsonResponse(request, env, { ok: true, query, results: entries.map(normalizeLocationResult) });
}

const STATISTICS_WINDOWS = {
  "24h": 24,
  "3d": 72,
  "7d": 168,
  "30d": 720,
  "60d": 1440,
  "90d": 2160,
  "6m": 183 * 24,
  "1y": 365 * 24,
};
const STATISTICS_BATCH_SIZE = 500;

function statsObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function statsMap(value) {
  const result = Object.create(null);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) result[key] = item;
  }
  return result;
}

function normalizeStatisticsWindow(value) {
  const name = String(value || "all").trim().toLowerCase();
  const normalized = !name || name === "all_time" ? "all" : name;
  if (normalized !== "all" && !Object.hasOwn(STATISTICS_WINDOWS, normalized)) throw new ApiError(400, "invalid_window", "Use one of the supported statistics windows.");
  return normalized;
}

function normalizeStatisticsEvent(payload, legacyProfileViews = false) {
  const type = String(payload.event ?? payload.action ?? "profile_view").trim().toLowerCase();
  const createdAt = new Date().toISOString();
  if (type === "search" || type === "search_query") {
    const query = String(payload.query ?? payload.q ?? "").trim().replace(/\s+/gu, " ").toLowerCase().slice(0, 80);
    if (!query) throw new ApiError(400, "invalid_request", "A non-empty search query is required.");
    const rawCount = Number(payload.result_count ?? payload.results ?? 0);
    const resultCount = Number.isFinite(rawCount) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(rawCount))) : 0;
    return { event: "search", query, result_count: resultCount, created_at: createdAt };
  }
  const personId = String(payload.person_id ?? payload.person ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(personId)) throw new ApiError(400, legacyProfileViews ? "invalid_person" : "invalid_request", "A valid profile id is required.");
  const kind = String(payload.kind || "").trim().toLowerCase() === "pet" ? "pet" : "person";
  return { event: "profile_view", kind, person_id: personId, created_at: createdAt };
}

function utcDateKeys(isoValue) {
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) return { day: new Date().toISOString().slice(0, 10), hour: new Date().toISOString().slice(0, 13) };
  const iso = date.toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(0, 13) };
}

function incrementCount(map, key) {
  map[key] = Math.max(0, Number(map[key]) || 0) + 1;
}

function normalizeProfileViews(store, now) {
  const source = statsObject(store);
  if (source.profiles && typeof source.profiles === "object" && !Array.isArray(source.profiles)) {
    return { schema: "genepedia/statistics/profile-views@2", updatedAt: String(source.updatedAt || now), profiles: statsMap(source.profiles) };
  }
  const fallback = String(source.updatedAt || now);
  const profiles = Object.create(null);
  for (const [key, count] of Object.entries(statsObject(source.views))) {
    profiles[key] = { views: Math.max(0, Number(count) || 0), firstViewedAt: fallback, lastViewedAt: fallback };
  }
  return { schema: "genepedia/statistics/profile-views@2", updatedAt: fallback, profiles };
}

function normalizeStatRollup(store, collectionKey, schema, now) {
  const source = statsObject(store);
  return { schema, updatedAt: String(source.updatedAt || now), [collectionKey]: statsMap(source[collectionKey]) };
}

function ensureStatsBucket(store, collectionName, bucketKey) {
  const collection = store[collectionName];
  if (!collection[bucketKey] || typeof collection[bucketKey] !== "object") collection[bucketKey] = { profileViews: 0, searches: 0, profiles: Object.create(null), queries: Object.create(null) };
  const bucket = collection[bucketKey];
  bucket.profileViews = Math.max(0, Number(bucket.profileViews) || 0);
  bucket.searches = Math.max(0, Number(bucket.searches) || 0);
  bucket.profiles = statsMap(bucket.profiles);
  bucket.queries = statsMap(bucket.queries);
  return bucket;
}

function statisticsLeaderboard(counts, kind, limit = 24) {
  const entries = Object.entries(counts).sort(([keyA, valueA], [keyB, valueB]) => (Number(valueB) - Number(valueA)) || keyA.localeCompare(keyB));
  const output = [];
  for (const [key, count] of entries) {
    if (kind === "profiles") {
      const separator = key.indexOf(":");
      if (separator <= 0) continue;
      const profileKind = key.slice(0, separator) === "pet" ? "pet" : "person";
      const personId = key.slice(separator + 1);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(personId)) continue;
      output.push({ kind: profileKind, person_id: personId, views: Math.max(0, Number(count) || 0) });
    } else {
      const query = String(key).trim();
      if (query) output.push({ query, count: Math.max(0, Number(count) || 0) });
    }
    if (output.length >= limit) break;
  }
  return output;
}

function aggregateStatsWindow(hourly, daily, windowHours, nowMs, field) {
  const counts = Object.create(null);
  const cutoff = nowMs - windowHours * 3_600_000;
  const hourlyZoneStart = nowMs - 192 * 3_600_000;
  for (const [key, bucketValue] of Object.entries(hourly.hours)) {
    const timestamp = Date.parse(`${key}:00:00Z`);
    if (!Number.isFinite(timestamp) || timestamp < Math.max(cutoff, hourlyZoneStart) || timestamp > nowMs) continue;
    for (const [label, count] of Object.entries(statsMap(statsObject(bucketValue)[field]))) counts[label] = (Number(counts[label]) || 0) + Math.max(0, Number(count) || 0);
  }
  if (cutoff >= hourlyZoneStart) return counts;
  const dailyOnlyEnd = Math.floor(hourlyZoneStart / 86_400_000) * 86_400_000 - 86_400_000;
  for (const [key, bucketValue] of Object.entries(daily.days)) {
    const timestamp = Date.parse(`${key}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || timestamp < Math.floor(cutoff / 86_400_000) * 86_400_000 || timestamp > dailyOnlyEnd) continue;
    for (const [label, count] of Object.entries(statsMap(statsObject(bucketValue)[field]))) counts[label] = (Number(counts[label]) || 0) + Math.max(0, Number(count) || 0);
  }
  return counts;
}

function statsTotal(map, field) {
  return Object.values(map).reduce((sum, value) => sum + Math.max(0, Number(statsObject(value)[field]) || 0), 0);
}

async function readStatisticsFiles(env) {
  const repo = REPOSITORIES.genepediaDatabase;
  const names = ["profile-views", "search-queries", "hourly-rollups", "daily-rollups", "leaderboards", "summary", "manifest", "worker-flush"];
  const values = await Promise.all(names.map((name) => getJsonFile(env, repo, `statistics/${name}.json`).catch(() => null)));
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

function applyStatisticsBatch(storedFiles, events) {
  const now = new Date().toISOString();
  const profileViews = normalizeProfileViews(storedFiles["profile-views"], now);
  const searchStoreRaw = statsObject(storedFiles["search-queries"]);
  const searchQueries = { schema: "genepedia/statistics/search-queries@1", updatedAt: String(searchStoreRaw.updatedAt || now), queries: statsMap(searchStoreRaw.queries) };
  const hourly = normalizeStatRollup(storedFiles["hourly-rollups"], "hours", "genepedia/statistics/hourly-rollups@1", now);
  const daily = normalizeStatRollup(storedFiles["daily-rollups"], "days", "genepedia/statistics/daily-rollups@2", now);
  const changedProfiles = new Set();
  const changedQueries = new Set();
  for (const event of events) {
    const payload = statsObject(event.payload);
    const instant = String(payload.created_at || event.created_at || now);
    const { day, hour } = utcDateKeys(instant);
    const dayBucket = ensureStatsBucket(daily, "days", day);
    const hourBucket = ensureStatsBucket(hourly, "hours", hour);
    if (payload.event === "search") {
      const query = String(payload.query || "").trim().replace(/\s+/gu, " ").toLowerCase().slice(0, 80);
      if (!query) continue;
      const existing = statsObject(searchQueries.queries[query]);
      searchQueries.queries[query] = {
        count: Math.max(0, Number(existing.count) || 0) + 1,
        firstSearchedAt: String(existing.firstSearchedAt || instant),
        lastSearchedAt: instant,
        lastResultCount: Math.max(0, Number(payload.result_count) || 0),
      };
      dayBucket.searches += 1;
      hourBucket.searches += 1;
      incrementCount(dayBucket.queries, query);
      incrementCount(hourBucket.queries, query);
      changedQueries.add(query);
      continue;
    }
    const personId = String(payload.person_id || "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(personId)) continue;
    const kind = payload.kind === "pet" ? "pet" : "person";
    const key = `${kind}:${personId}`;
    const existing = statsObject(profileViews.profiles[key]);
    profileViews.profiles[key] = {
      views: Math.max(0, Number(existing.views) || 0) + 1,
      firstViewedAt: String(existing.firstViewedAt || instant),
      lastViewedAt: instant,
    };
    dayBucket.profileViews += 1;
    hourBucket.profileViews += 1;
    incrementCount(dayBucket.profiles, key);
    incrementCount(hourBucket.profiles, key);
    changedProfiles.add(key);
  }
  const profileLimit = 24;
  const searchLimit = 100;
  const queryEntries = Object.entries(searchQueries.queries).sort(([, left], [, right]) => (Number(statsObject(right).count) - Number(statsObject(left).count)) || String(statsObject(right).lastSearchedAt || "").localeCompare(String(statsObject(left).lastSearchedAt || ""))).slice(0, searchLimit);
  searchQueries.queries = Object.fromEntries(queryEntries);
  const currentMs = Date.now();
  const hourCutoff = new Date(currentMs - 192 * 3_600_000).toISOString().slice(0, 13);
  for (const key of Object.keys(hourly.hours)) if (key < hourCutoff) delete hourly.hours[key];
  const dayCutoff = new Date(currentMs - 400 * 86_400_000).toISOString().slice(0, 10);
  for (const key of Object.keys(daily.days)) if (key < dayCutoff) delete daily.days[key];
  profileViews.updatedAt = searchQueries.updatedAt = hourly.updatedAt = daily.updatedAt = now;

  const windows = [...Object.keys(STATISTICS_WINDOWS), "all"];
  const profileCountsAll = Object.fromEntries(Object.entries(profileViews.profiles).map(([key, value]) => [key, Math.max(0, Number(statsObject(value).views) || 0)]));
  const queryCountsAll = Object.fromEntries(Object.entries(searchQueries.queries).map(([key, value]) => [key, Math.max(0, Number(statsObject(value).count) || 0)]));
  const profileBoards = Object.create(null);
  const searchBoards = Object.create(null);
  for (const window of windows) {
    const profileCounts = window === "all" ? profileCountsAll : aggregateStatsWindow(hourly, daily, STATISTICS_WINDOWS[window], currentMs, "profiles");
    const queryCounts = window === "all" ? queryCountsAll : aggregateStatsWindow(hourly, daily, STATISTICS_WINDOWS[window], currentMs, "queries");
    profileBoards[window] = statisticsLeaderboard(profileCounts, "profiles", profileLimit);
    searchBoards[window] = statisticsLeaderboard(queryCounts, "searches", profileLimit);
  }
  const leaderboards = { schema: "genepedia/statistics/leaderboards@1", generatedAt: now, windows, profiles: profileBoards, searches: searchBoards };
  for (const item of profileBoards.all) {
    const entry = profileViews.profiles[`${item.kind}:${item.person_id}`];
    if (entry) item.last_viewed_at = String(statsObject(entry).lastViewedAt || "");
  }
  for (const item of searchBoards.all) {
    const entry = searchQueries.queries[item.query];
    if (entry) {
      item.last_result_count = Math.max(0, Number(statsObject(entry).lastResultCount) || 0);
      item.last_searched_at = String(statsObject(entry).lastSearchedAt || "");
    }
  }
  const summary = {
    schema: "genepedia/statistics/summary@2",
    generatedAt: now,
    windows,
    totals: { profileViews: statsTotal(profileViews.profiles, "views"), searches: statsTotal(searchQueries.queries, "count"), profilesTracked: Object.keys(profileViews.profiles).length, queriesTracked: Object.keys(searchQueries.queries).length },
    today: { date: now.slice(0, 10), profileViews: Math.max(0, Number(statsObject(daily.days[now.slice(0, 10)]).profileViews) || 0), searches: Math.max(0, Number(statsObject(daily.days[now.slice(0, 10)]).searches) || 0) },
    popularProfiles: profileBoards.all.slice(0, 8),
    popularSearches: searchBoards.all.slice(0, 8),
    leaderboards: { profiles: profileBoards, searches: searchBoards },
  };
  const manifest = {
    schema: "genepedia/statistics/manifest@2",
    updatedAt: now,
    windows,
    files: {
      "profile-views.json": { schema: profileViews.schema, updatedAt: profileViews.updatedAt },
      "search-queries.json": { schema: searchQueries.schema, updatedAt: searchQueries.updatedAt },
      "hourly-rollups.json": { schema: hourly.schema, updatedAt: hourly.updatedAt },
      "daily-rollups.json": { schema: daily.schema, updatedAt: daily.updatedAt },
      "leaderboards.json": { schema: leaderboards.schema, updatedAt: now },
      "summary.json": { schema: summary.schema, updatedAt: now },
    },
  };
  return {
    files: [
      { path: "statistics/profile-views.json", content: jsonText(profileViews) },
      { path: "statistics/search-queries.json", content: jsonText(searchQueries) },
      { path: "statistics/hourly-rollups.json", content: jsonText(hourly) },
      { path: "statistics/daily-rollups.json", content: jsonText(daily) },
      { path: "statistics/leaderboards.json", content: jsonText(leaderboards) },
      { path: "statistics/summary.json", content: jsonText(summary) },
      { path: "statistics/manifest.json", content: jsonText(manifest) },
    ],
    result: { profileViews, searchQueries, leaderboards, summary, changedProfiles: [...changedProfiles], changedQueries: [...changedQueries] },
  };
}

async function readQueuedStatistics(database, limit = STATISTICS_BATCH_SIZE) {
  const result = await database.prepare("SELECT event_id, payload, created_at FROM statistics_events ORDER BY created_at, event_id LIMIT ?1").bind(limit).all();
  return (Array.isArray(result?.results) ? result.results : []).map((row) => {
    try { return { id: String(row.event_id), created_at: String(row.created_at), payload: JSON.parse(String(row.payload)) }; }
    catch { return { id: String(row.event_id), created_at: String(row.created_at), payload: {} }; }
  });
}

async function statisticsQueueCount(database) {
  const row = await database.prepare("SELECT COUNT(*) AS count FROM statistics_events").first();
  return Math.max(0, Number(row?.count) || 0);
}

async function flushStatisticsQueue(env, maxBatches = 4, accessToken = "") {
  const database = await ensureStorage(env);
  const lockToken = randomHex();
  const now = nowSeconds();
  const lockRow = await database.prepare(
    "INSERT INTO statistics_flush_locks (lock_name, lock_token, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(lock_name) DO UPDATE SET lock_token = excluded.lock_token, expires_at = excluded.expires_at WHERE statistics_flush_locks.expires_at <= ?4 RETURNING lock_token",
  ).bind("statistics", lockToken, now + 180, now).first();
  if (!lockRow) return { synced: false, buffered: true, pending: true, busy: true, storage: "D1" };
  try {
    if (String(env.GITHUB_STATISTICS_SYNC || "").trim() === "0") return { synced: false, buffered: true, pending: true, skipped: "sync_disabled", storage: "D1" };
    let totalPublished = 0;
    let lastCommit = null;
    for (let batchNumber = 0; batchNumber < maxBatches; batchNumber += 1) {
      const events = await readQueuedStatistics(database);
      if (!events.length) break;
      const batchId = await sha256(events.map((event) => event.id).join("\n"));
      const stored = await readStatisticsFiles(env);
      const marker = statsObject(stored["worker-flush"]);
      let files;
      if (marker.last_batch_id === batchId) {
        files = [];
      } else {
        const updated = applyStatisticsBatch(stored, events);
        const workerMarker = { schema: "genepedia/statistics/worker-flush@1", last_batch_id: batchId, last_batch_size: events.length, last_flushed_at: new Date().toISOString() };
        files = [...updated.files, { path: "statistics/worker-flush.json", content: jsonText(workerMarker) }];
        const commit = await commitFilesToDefaultBranch(env, REPOSITORIES.genepediaDatabase, files, {
          message: `statistics: publish ${events.length} queued events`,
          accessToken,
          user: { id: "worker", login: "genepedia-worker", displayName: "Genepedia Statistics" },
        });
        lastCommit = commit.commit;
      }
      const deleteStatements = [];
      for (let offset = 0; offset < events.length; offset += 100) {
        const ids = events.slice(offset, offset + 100).map((event) => event.id);
        const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
        deleteStatements.push(database.prepare(`DELETE FROM statistics_events WHERE event_id IN (${placeholders})`).bind(...ids));
      }
      deleteStatements.push(database.prepare("INSERT INTO statistics_meta (meta_key, meta_value) VALUES ('last_flushed_at', ?1) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value").bind(new Date().toISOString()));
      await database.batch(deleteStatements);
      totalPublished += events.length;
    }
    const pendingCount = await statisticsQueueCount(database);
    return { synced: totalPublished > 0, buffered: true, pending: pendingCount > 0, pending_count: pendingCount, flushed_events: totalPublished, storage: "D1", ...(lastCommit ? { repo: "Genepedia/Genepedia-Database", commit: lastCommit } : {}) };
  } finally {
    await database.prepare("DELETE FROM statistics_flush_locks WHERE lock_name = ?1 AND lock_token = ?2").bind("statistics", lockToken).run();
  }
}

async function enqueueStatisticsEvent(request, env, payload, legacyProfileViews) {
  const event = normalizeStatisticsEvent(payload, legacyProfileViews);
  const database = await ensureStorage(env);
  const eventId = randomHex();
  const inserted = await database.prepare(
    "INSERT INTO statistics_events (event_id, payload, created_at) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM statistics_events) < ?4 RETURNING event_id",
  ).bind(eventId, JSON.stringify(event), event.created_at, MAX_QUEUED_STATISTICS_EVENTS).first();
  if (!inserted) throw new ApiError(429, "statistics_queue_full", "The statistics queue is full. Please retry after queued events have been published.");
  const count = await statisticsQueueCount(database);
  const lastFlushed = await database.prepare("SELECT meta_value FROM statistics_meta WHERE meta_key = 'last_flushed_at'").first();
  const lastFlushedAt = Date.parse(String(lastFlushed?.meta_value || "")) || 0;
  let publish = { synced: false, buffered: true, pending: true, pending_count: count, storage: "D1" };
  if (!lastFlushedAt || Date.now() - lastFlushedAt >= 3600_000) {
    try {
      const session = await sessionFromRequest(request, env).catch(() => null);
      publish = await flushStatisticsQueue(env, 1, session?.token || "");
    } catch (error) {
      publish = { synced: false, buffered: true, pending: true, pending_count: count, flush_error: String(error?.message || "Statistics publishing is not available."), storage: "D1" };
    }
  }
  const storageRoot = "data/Genepedia-Database/statistics/";
  if (legacyProfileViews) return { ok: true, profile: event.event === "profile_view" ? { key: `${event.kind}:${event.person_id}`, kind: event.kind, person_id: event.person_id, views: null, last_viewed_at: event.created_at } : null, publish, storage_path: `${storageRoot}profile-views.json` };
  if (event.event === "search") return { ok: true, event: "search", search: { query: event.query, count: null, last_result_count: event.result_count, last_searched_at: event.created_at }, publish, storage_root: storageRoot };
  return { ok: true, event: "profile_view", profile: { key: `${event.kind}:${event.person_id}`, kind: event.kind, person_id: event.person_id, views: null, last_viewed_at: event.created_at }, publish, storage_root: storageRoot };
}

async function statistics(request, env, legacyProfileViews = false) {
  if (request.method === "POST") {
    const payload = await readJson(request, 64_000);
    const result = await enqueueStatisticsEvent(request, env, payload, legacyProfileViews);
    return jsonResponse(request, env, result, 202);
  }
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Only GET and POST requests are supported.");
  const repo = REPOSITORIES.genepediaDatabase;
  const url = new URL(request.url);
  const metric = String(url.searchParams.get("metric") || "popular_profiles").trim().toLowerCase();
  const limit = Math.max(1, Math.min(24, Number(url.searchParams.get("limit") || 4)));
  const windowName = normalizeStatisticsWindow(url.searchParams.get("window") || "all");
  const storageRoot = "data/Genepedia-Database/statistics/";
  const fetchedAt = new Date().toISOString();
  if (!legacyProfileViews && ["summary", "all"].includes(metric)) {
    return jsonResponse(request, env, { ok: true, metric, summary: await getJsonFile(env, repo, "statistics/summary.json") || {}, windows: [...Object.keys(STATISTICS_WINDOWS), "all"], storage_root: storageRoot, fetched_at: fetchedAt });
  }
  if (!legacyProfileViews && ["leaderboards", "windows"].includes(metric)) {
    return jsonResponse(request, env, { ok: true, metric: "leaderboards", windows: [...Object.keys(STATISTICS_WINDOWS), "all"], leaderboards: await getJsonFile(env, repo, "statistics/leaderboards.json") || {}, storage_root: storageRoot, fetched_at: fetchedAt });
  }
  if (!legacyProfileViews && ["popular_searches", "searches"].includes(metric)) {
    const boards = await getJsonFile(env, repo, "statistics/leaderboards.json");
    const searches = boards?.searches?.[windowName] || (await getJsonFile(env, repo, "statistics/summary.json"))?.popularSearches || [];
    return jsonResponse(request, env, { ok: true, metric: "popular_searches", window: windowName, searches: Array.isArray(searches) ? searches.slice(0, limit) : [], storage_root: storageRoot, fetched_at: fetchedAt });
  }
  if (!legacyProfileViews && metric === "manifest") return jsonResponse(request, env, { ok: true, metric, manifest: await getJsonFile(env, repo, "statistics/manifest.json") || {}, fetched_at: fetchedAt });
  const summary = await getJsonFile(env, repo, "statistics/summary.json");
  const boards = await getJsonFile(env, repo, "statistics/leaderboards.json");
  const profiles = boards?.profiles?.[windowName] || summary?.leaderboards?.profiles?.[windowName] || summary?.popularProfiles || [];
  if (legacyProfileViews) return jsonResponse(request, env, { ok: true, window: windowName, profiles: Array.isArray(profiles) ? profiles.slice(0, limit) : [], storage_path: `${storageRoot}profile-views.json`, fetched_at: fetchedAt });
  return jsonResponse(request, env, { ok: true, metric: "popular_profiles", window: windowName, profiles: Array.isArray(profiles) ? profiles.slice(0, limit) : [], storage_path: `${storageRoot}profile-views.json`, fetched_at: fetchedAt });
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

async function statisticsFlush(request, env) {
  if (!["GET", "POST"].includes(request.method)) throw new ApiError(405, "method_not_allowed", "Only GET and POST requests are supported.");
  const configured = String(env.GITHUB_STATISTICS_FLUSH_TOKEN || "").trim();
  if (!configured) throw new ApiError(403, "flush_token_not_configured", "Statistics flush is not configured.");
  const url = new URL(request.url);
  let bodyToken = "";
  if (request.method === "POST") {
    const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      const payload = await readJson(request, 16_384);
      bodyToken = String(payload.token || "").trim();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      bodyToken = String(new URLSearchParams(await request.text()).get("token") || "").trim();
    }
  }
  const provided = String(request.headers.get("X-Statistics-Flush-Token") || url.searchParams.get("token") || bodyToken).trim();
  if (!provided || !constantTimeEqual(configured, provided)) throw new ApiError(403, "unauthorized", "A valid flush token is required.");
  const result = await flushStatisticsQueue(env, 4);
  return jsonResponse(request, env, { ok: true, flush: result, storage_root: "data/Genepedia-Database/statistics/", fetched_at: new Date().toISOString() });
}

async function githubContact(request, env, site) {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Only POST requests are supported.");
  const user = await requireUser(request, env);
  const payload = await readJson(request, 64_000);
  const subject = String(payload.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const message = String(payload.message || "").trim().slice(0, 8_000);
  const details = String(payload.details || "").trim().slice(0, 4_000);
  if (!subject || !message) throw new ApiError(400, "invalid_contact", "A subject and message are required.");
  const reason = ["question", "bug", "enhancement"].includes(String(payload.reason || "").toLowerCase()) ? String(payload.reason).toLowerCase() : "question";
  const labels = { question: "question", bug: "bug", enhancement: "enhancement" };
  const body = [`**Reason:** ${reason}`, "", "## Message", "", message, details ? `\n\n## Environment and diagnostics\n\n\`\`\`\n${details}\n\`\`\`` : "", "", `Submitted from ${site === "gravepedia" ? "Gravepedia" : "Genepedia"} by @${user.user.login}.`].join("\n");
  const repo = siteRepository(site);
  const result = await githubApi(env, "POST", repoPathUrl(repo, "/issues"), { token: user.token, body: { title: subject, body, labels: [labels[reason]] } });
  return jsonResponse(request, env, { ok: true, repo: `${repo.owner}/${repo.repo}`, reason, number: Number(result.data.number || 0), url: String(result.data.html_url || ""), author: user.user.login, created_at: new Date().toISOString() }, 201);
}

async function logout(request, env) {
  const sid = readCookie(request, SESSION_COOKIE);
  if (/^[a-f0-9]{64}$/.test(sid)) {
    const database = await ensureStorage(env);
    await database.prepare("DELETE FROM worker_sessions WHERE session_id_hash = ?1").bind(await sha256(sid)).run();
  }
  return jsonResponse(request, env, { authenticated: false }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0, "None") });
}

function unsupportedEndpoints() {
  return [
    "local-login.php (local username/password sign-in)",
    "check_writable_tmp.php (PHP host diagnostic)",
  ];
}

async function dispatch(request, env, ctx) {
  void ctx;
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, "") || "/";
  let site = "";
  let endpoint = "";
  if (route === "/genepedia" || route.startsWith("/genepedia/")) {
    site = "genepedia";
    endpoint = route.slice("/genepedia".length).replace(/^\//, "");
  } else if (route === "/gravepedia" || route.startsWith("/gravepedia/")) {
    site = "gravepedia";
    endpoint = route.slice("/gravepedia".length).replace(/^\//, "");
  } else {
    throw new ApiError(404, "not_found", "Unknown API route.");
  }
  if (!endpoint) return jsonResponse(request, env, { ok: true, service: "Genepedia Sites API", site, version: 1 });
  if (endpoint === "github-login.php") return loginStart(request, env, site);
  if (endpoint === "github-callback.php") return oauthCallback(request, env);
  if (endpoint === "github-handoff.php") return loginHandoff(request, env);
  if (endpoint === "github-session.php") {
    const session = await sessionFromRequest(request, env);
    const reviewLogin = String(env.GITHUB_REVIEW_LOGIN || "");
    const apiConfigured = Boolean(env.GITHUB_API_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_PUBLISH_TOKEN || env.GITHUB_APP_ID);
    return jsonResponse(request, env, {
      authenticated: Boolean(session?.user),
      configured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      api_token_configured: apiConfigured,
      api_auth: { configured: apiConfigured, method: env.GITHUB_APP_ID ? "github_app" : apiConfigured ? "personal_access_token" : null },
      can_review_pull_requests: Boolean(session?.user?.login && reviewLogin && session.user.login.toLowerCase() === reviewLogin.toLowerCase()),
      review_login: reviewLogin,
      user: session?.user || null,
    });
  }
  if (endpoint === "github-logout.php") return logout(request, env);
  if (endpoint === "github-config.php") return githubConfig(request, env, site);
  if (endpoint === "github-file-commits.php") return fileCommits(request, env, site);
  if (endpoint === "github-file-commit-diff.php") return fileCommitDiff(request, env, site);
  if (endpoint === "github-pull-requests.php") return listPullRequests(request, env, site);
  if (endpoint === "github-pull-request-review.php") return reviewPullRequest(request, env, site);
  if (endpoint === "github-submit-page-edit.php") return submitPageEdit(request, env, site);
  if (endpoint === "github-self-profile.php") return githubSelfProfile(request, env, site);
  if (endpoint === "github-maintainers.php") return githubMaintainers(request, env, site);
  if (endpoint === "github-talk.php") return githubTalk(request, env, site);
  if (endpoint === "github-media.php") return request.method === "GET" ? mediaList(request, env, site) : mediaWrite(request, env, site);
  if (endpoint === "github-contact.php") return githubContact(request, env, site);
  if (endpoint === "github-statistics-flush.php") return site === "genepedia" ? statisticsFlush(request, env) : jsonResponse(request, env, { ok: false, error: "not_found", message: "This API endpoint is only available for Genepedia." }, 404);
  if (endpoint === "github-statistics.php") return statistics(request, env);
  if (endpoint === "github-profile-views.php") return statistics(request, env, true);
  if (endpoint === "location-search.php") return locationSearch(request, env);
  if (endpoint === "data.php") return dataProxy(request, env, site);
  if (endpoint === "media.php") return mediaProxy(request, env, site);
  if (endpoint === "memorials.php" && site === "gravepedia") return gravepediaMemorials(request, env);
  if (endpoint === "__capabilities") return jsonResponse(request, env, { ok: true, implemented: ["OAuth/session/handoff", "public data/media proxy", "commit history/diffs", "pull request listing/review", "page edit pull requests", "profile create/claim pull requests", "maintainer requests/invitations/decisions", "profile talk posts/deletes", "media pull requests", "contact issue submission", "D1-buffered statistics with GitHub publication", "location search", "Gravepedia memorial search/submission"], unimplemented: unsupportedEndpoints() });
  if (unsupportedEndpoints().some((entry) => entry.startsWith(`${endpoint.replace(/\.php$/, "")} `) || entry.startsWith(endpoint))) {
    return jsonResponse(request, env, { ok: false, error: "not_implemented", message: `The ${endpoint} endpoint is not implemented in the Sites API yet.` }, 501);
  }
  throw new ApiError(404, "not_found", "Unknown API route.");
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      return await dispatch(request, env, ctx);
    } catch (error) {
      if (error instanceof ApiError) return jsonResponse(request, env, { ok: false, success: false, error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, error.status);
      return jsonResponse(request, env, { ok: false, success: false, error: "internal_error", message: "The API request could not be completed." }, 500);
    }
  },
};
