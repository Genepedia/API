import { createNativeStorage } from "./storage-core.mjs";
import { createNativeDomain } from "./storage-domain.mjs";
import { createNativeHttp } from "./storage-http.mjs";

const API_VERSION = "2022-11-28";
const SESSION_COOKIE = "__Host-genepedia_session";
const OPENAPI_SPEC_JSON = "__OPENAPI_SPEC_JSON__";
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
    "Access-Control-Allow-Headers": "Accept, Content-Type, Authorization, Idempotency-Key, If-None-Match, Cache-Control, Pragma",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "ETag, X-Document-Version, X-Next-Cursor, Retry-After",
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

async function fetchGitHubIdentity(token) {
  if (!token) throw new ApiError(401, "github_identity_unavailable", "GitHub identity could not be verified.");
  const response = await fetch("https://api.github.com/user", {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Genepedia-Sites-API/1.0",
      "X-GitHub-Api-Version": API_VERSION,
    },
    redirect: "manual",
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    throw new ApiError(response.status === 401 ? 401 : 502, "github_identity_unavailable", "GitHub identity could not be verified.");
  }
  if (!data || typeof data !== "object") throw new ApiError(502, "github_identity_invalid", "GitHub returned an unreadable identity response.");
  return data;
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
      const user = await fetchGitHubIdentity(bearer);
      return { user: normalizeUser(user), token: bearer, kind: "bearer", authType: "github" };
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
  const authType = session?.authType === "local" ? "local" : "github";
  if (!session?.user || (authType === "github" && !session?.token)) return null;
  return { user: session.user, token: session.token || "", sid, kind: "cookie", authType };
}

async function requireUser(request, env) {
  const session = await sessionFromRequest(request, env);
  if (session?.authType !== "github" || !session?.user?.login || !session.token) {
    throw new ApiError(401, "authentication_required", "Sign in with GitHub to continue.");
  }
  return session;
}

async function putSession(env, user, token, authType = "github") {
  const sid = randomHex();
  const expiresAt = nowSeconds() + SESSION_TTL;
  const payload = await encryptJson(env, { user, token: token || "", authType: authType === "local" ? "local" : "github" });
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
  return String(env.GITHUB_CALLBACK_URL || "https://api.genepedia.org/v1/auth/github/callback").trim();
}

function isGitHubAppClientId(value) {
  return /^Iv(?:1\.|23)/.test(String(value || "").trim());
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
  authorize.searchParams.set("scope", "read:user user:email user:follow");
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

function localLoginConfigured(env) {
  const username = String(env.LOCAL_LOGIN_USERNAME || "").trim();
  const password = String(env.LOCAL_LOGIN_PASSWORD || "");
  const passwordHash = String(env.LOCAL_LOGIN_PASSWORD_HASH || "").trim();
  return Boolean(username && (passwordHash || password));
}

async function readLocalLoginPayload(request) {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > 16_384) throw new ApiError(413, "body_too_large", "The request body is too large.");
  const text = new TextDecoder().decode(raw);
  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    if (!contentType || contentType.includes("text/plain")) {
      return Object.fromEntries(new URLSearchParams(text));
    }
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

async function verifyLocalPassword(password, env) {
  const configuredHash = String(env.LOCAL_LOGIN_PASSWORD_HASH || "").trim();
  if (!configuredHash) {
    return constantTimeEqual(String(env.LOCAL_LOGIN_PASSWORD || ""), password);
  }

  // Web Crypto does not provide PHP's bcrypt password_verify format. Worker
  // deployments may use this portable PBKDF2 format instead:
  // pbkdf2-sha256$iterations$salt-base64url$digest-base64url
  const parts = configuredHash.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) return false;
  try {
    const salt = base64UrlDecode(parts[2]);
    const expected = base64UrlDecode(parts[3]);
    if (salt.length < 16 || salt.length > 64 || expected.length < 16 || expected.length > 64) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, expected.length * 8);
    return constantTimeEqual(base64UrlEncode(new Uint8Array(derived)), base64UrlEncode(expected));
  } catch {
    return false;
  }
}

function localLoginUser(username, env) {
  const displayName = String(env.LOCAL_LOGIN_DISPLAY_NAME || "").trim() || username;
  const nameParts = displayName.split(/\s+/).filter(Boolean);
  return {
    id: `local:${username}`,
    login: username,
    displayName,
    givenName: nameParts[0] || username,
    familyName: nameParts.slice(1).join(" "),
    photoUrl: "",
    profileUrl: "",
    email: "",
  };
}

async function localLogin(request, env) {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Only POST requests are supported.");
  const payload = await readLocalLoginPayload(request);
  const username = String(payload.username || "").trim();
  const password = String(payload.password ?? "");
  const expectedUsername = String(env.LOCAL_LOGIN_USERNAME || "").trim();
  const configured = localLoginConfigured(env);
  const passwordMatches = configured ? await verifyLocalPassword(password, env) : false;
  const usernameMatches = configured && constantTimeEqual(expectedUsername, username);
  if (!usernameMatches || !passwordMatches) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw new ApiError(401, "invalid_credentials", "Invalid username or password.");
  }

  const user = localLoginUser(expectedUsername, env);
  const handoffCode = randomHex();
  await storeOneTime(env, "oauth_handoffs", "handoff_hash", handoffCode, { user, token: "", authType: "local" }, HANDOFF_TTL);
  return jsonResponse(request, env, { ok: true, authenticated: true, auth_type: "local", handoff: handoffCode });
}

async function welcomeGitHubRequest(token, method, path, body = undefined) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "Genepedia-Sites-API/1.0",
    "X-GitHub-Api-Version": API_VERSION,
  };
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
  if (!response.ok && response.status !== 304 && response.status !== 404) {
    throw new Error(String(data?.message || `GitHub returned HTTP ${response.status}.`));
  }
  return { status: response.status, data };
}

function welcomeList(env, name) {
  return [...new Set(String(env[name] || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function welcomeActionsEnabled(env) {
  return !["0", "false", "no", "off"].includes(String(env.GITHUB_WELCOME_ACTIONS || "").trim().toLowerCase());
}

async function welcomeStarRepository(owner, repo, token) {
  const result = await welcomeGitHubRequest(token, "PUT", `/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (![204, 304].includes(result.status)) throw new Error(`GitHub returned HTTP ${result.status} while starring the repository.`);
}

async function welcomeIsFollowing(login, token) {
  const result = await welcomeGitHubRequest(token, "GET", `/user/following/${encodeURIComponent(login)}`);
  if ([204, 304].includes(result.status)) return true;
  if (result.status === 404) return false;
  throw new Error(`GitHub returned HTTP ${result.status} while checking follow status.`);
}

async function welcomeFollowUser(login, token) {
  if (await welcomeIsFollowing(login, token)) return;
  const result = await welcomeGitHubRequest(token, "PUT", `/user/following/${encodeURIComponent(login)}`);
  if (![204, 304].includes(result.status)) throw new Error(`GitHub returned HTTP ${result.status} while following the user.`);
}

async function welcomeOrganizationFollowState(login, token) {
  const result = await welcomeGitHubRequest(token, "POST", "/graphql", {
    query: "query OrganizationFollowState($login: String!) { organization(login: $login) { id login viewerIsFollowing } }",
    variables: { login },
  });
  if (Array.isArray(result.data?.errors) && result.data.errors.length) {
    throw new Error(String(result.data.errors[0]?.message || "GitHub GraphQL request failed."));
  }
  const organization = result.data?.data?.organization;
  if (!organization || typeof organization !== "object") throw new Error(`Could not resolve organization ${login} for follow.`);
  return organization;
}

async function welcomeFollowOrganization(login, token) {
  const state = await welcomeOrganizationFollowState(login, token);
  if (state.viewerIsFollowing) return;

  try {
    if (await welcomeIsFollowing(login, token)) return;
  } catch {
    // The REST follow check is unavailable for some organization accounts.
  }

  try {
    await welcomeFollowUser(login, token);
    if (await welcomeIsFollowing(login, token)) return;
  } catch {
    // REST follow is not supported for all organization accounts.
  }

  const organizationId = String(state.id || "").trim();
  if (!organizationId) throw new Error(`Could not resolve an organization ID for ${login}.`);
  const mutation = await welcomeGitHubRequest(token, "POST", "/graphql", {
    query: "mutation FollowOrganization($organizationId: ID!) { followOrganization(input: { organizationId: $organizationId }) { organization { login viewerIsFollowing } } }",
    variables: { organizationId },
  });
  if (Array.isArray(mutation.data?.errors) && mutation.data.errors.length) {
    throw new Error(String(mutation.data.errors[0]?.message || "GitHub GraphQL request failed."));
  }
  const organization = mutation.data?.data?.followOrganization?.organization;
  if (organization?.viewerIsFollowing) return;
  const verified = await welcomeOrganizationFollowState(login, token);
  if (!verified.viewerIsFollowing) throw new Error(`GitHub did not confirm the organization follow for ${login}.`);
}

async function welcomeFollowAccount(login, token) {
  const account = await welcomeGitHubRequest(token, "GET", `/users/${encodeURIComponent(login)}`);
  if (!account.data || typeof account.data !== "object") throw new Error(`GitHub account lookup failed for ${login}.`);
  if (String(account.data.type || "").toLowerCase() === "organization") {
    await welcomeFollowOrganization(login, token);
    return;
  }
  await welcomeFollowUser(login, token);
}

async function applyWelcomeLoginActions(env, token) {
  if (!welcomeActionsEnabled(env)) return;
  for (const repoSlug of welcomeList(env, "GITHUB_WELCOME_STAR_REPOS")) {
    const [owner, repo, ...extra] = repoSlug.split("/");
    if (extra.length || !/^[A-Za-z0-9-]{1,39}$/.test(owner || "") || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo || "")) continue;
    try {
      await welcomeStarRepository(owner, repo, token);
    } catch (error) {
      console.warn(`GitHub welcome star failed for ${repoSlug}: ${String(error?.message || "request failed")}`);
    }
  }
  for (const login of welcomeList(env, "GITHUB_WELCOME_FOLLOW_USERS")) {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) continue;
    try {
      await welcomeFollowAccount(login, token);
    } catch (error) {
      console.warn(`GitHub welcome follow failed for ${login}: ${String(error?.message || "request failed")}`);
    }
  }
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
    const user = normalizeUser(await fetchGitHubIdentity(token));
    if (!user.login) return fail("user_profile");
    await applyWelcomeLoginActions(env, token);
    const sid = await putSession(env, user, token, "github");
    const handoffCode = randomHex();
    await storeOneTime(env, "oauth_handoffs", "handoff_hash", handoffCode, { user, token, authType: "github" }, HANDOFF_TTL);
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
  const authType = handoff?.authType === "local" ? "local" : "github";
  const token = String(handoff?.token || "");
  if (!handoff?.user || (authType === "github" && !token)) throw new ApiError(401, "invalid_handoff", "This login handoff code is invalid or has expired. Please sign in again.");
  const sid = await putSession(env, handoff.user, token, authType);
  return jsonResponse(request, env, {
    ok: true,
    authenticated: true,
    auth_type: authType,
    user: handoff.user,
    ...(authType === "github" ? { access_token: token } : {}),
  }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, sid, SESSION_TTL, "None") });
}

async function githubConfig(request, env, site) {
  const storageConfigured = Boolean(env.DB && env.BUCKET);
  const callback = callbackUrl(env);
  const configured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  return jsonResponse(request, env, {
    ok: true,
    oauth_configured: configured,
    oauth: {
      uses_github_app_flow: isGitHubAppClientId(env.GITHUB_CLIENT_ID),
      callback_url: callback,
      client_id_set: Boolean(env.GITHUB_CLIENT_ID),
      client_id_is_github_app_format: isGitHubAppClientId(env.GITHUB_CLIENT_ID),
    },
    api_auth: { configured: storageConfigured, method: storageConfigured ? "sites" : null },
    publish_auth: { configured: storageConfigured, can_publish: storageConfigured },
    local_login_configured: localLoginConfigured(env),
    repo: site === "gravepedia" ? "Genepedia/Gravepedia" : "Genepedia/Genepedia",
    site,
    storage: { configured: storageConfigured, database: "D1", files: "R2", session_encryption_configured: String(env.GITHUB_SESSION_SECRET || "").length >= 32 },
  });
}

function workspacePathFor(site, input) {
  const path = safeRepoPath(input, { allowDirectory: true });
  if (!path) return null;
  if (site === "gravepedia") {
    if (/^pages\/[A-Za-z0-9_.\/-]+\.html$/.test(path)) return { namespace: "content", path, workspacePath: path };
    if (/^data\/memorials\/[A-Za-z0-9_.\/-]+\.json$/.test(path)) return { namespace: "data", path: path.slice(5), workspacePath: path };
    return null;
  }
  const databasePrefix = "data/Genepedia-Database/";
  if (path.startsWith(databasePrefix)) {
    const repoPath = path.slice(databasePrefix.length);
    if (/^(people|pets|statistics)\/[A-Za-z0-9_.\/-]+$/.test(repoPath) || /^(people|pets|statistics)\/[A-Za-z0-9_.\/-]+\.json$/.test(repoPath)) {
      return { namespace: "data", path: repoPath, workspacePath: path };
    }
    return null;
  }
  if (path.startsWith("data/people/")) {
    const repoPath = path.slice("data/".length);
    if (/^people\/[A-Za-z0-9_.\/-]+$/.test(repoPath)) {
      return { namespace: "data", path: repoPath, workspacePath: path };
    }
    return null;
  }
  if (/^pages\/[A-Za-z0-9_.\/-]+\.html$/.test(path)
    || /^pages\/people\/[0-9]+\/data\/talk\.json$/.test(path)
    || /^people\/[A-Za-z0-9_-]+\/(?:index|profile|[A-Za-z0-9_.-]+)\.html$/.test(path)
    || path === "sitemap.xml") return { namespace: "content", path, workspacePath: path };
  return null;
}

function historyContextFor(site, input) {
  const rawPath = String(input || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (site === "genepedia" && /^pages\/(?:people|pets)\/[0-9]+\/?$/.test(rawPath)) {
    const profilePath = safeRepoPath(rawPath.replace(/\/+$/, ""));
    return profilePath ? workspacePathFor(site, `${profilePath}/index.html`) : null;
  }
  const path = safeRepoPath(input);
  if (!path) return null;
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const historyPath = path.startsWith("pages/") && !fileName.includes(".") ? `${path}.html` : path;
  return workspacePathFor(site, historyPath);
}

function historyPaths(url) {
  const values = url.searchParams.get("paths") || url.searchParams.get("path") || "";
  if (!values.trim()) return null;
  const paths = values.split(",").map((part) => part.trim()).filter(Boolean);
  if (!paths.length || paths.length > 12) return null;
  return paths;
}

function contentType(path) {
  const extension = String(path).split(".").pop().toLowerCase();
  return ({ json: "application/json; charset=utf-8", html: "text/html; charset=utf-8", xml: "application/xml; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", txt: "text/plain; charset=utf-8", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", ico: "image/x-icon", ged: "text/plain; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", pdf: "application/pdf" })[extension] || "application/octet-stream";
}

function personBucket(personId) {
  const digits = String(personId).replace(/[^0-9]/g, "");
  const number = Number.parseInt(digits || "0", 10) || 0;
  return Math.floor((Math.max(1, number) - 1) / 1000);
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

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

async function logout(request, env) {
  const sid = readCookie(request, SESSION_COOKIE);
  if (/^[a-f0-9]{64}$/.test(sid)) {
    const database = await ensureStorage(env);
    await database.prepare("DELETE FROM worker_sessions WHERE session_id_hash = ?1").bind(await sha256(sid)).run();
  }
  return jsonResponse(request, env, { authenticated: false }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0, "None") });
}

function apiDescription(request, env, site = "") {
  return jsonResponse(request, env, {
    ok: true,
    service: "Genepedia API",
    api_version: 1,
    ...(site ? { site, version: 1, base: `/v1/${site}` } : {
      sites: { genepedia: "/v1/genepedia", gravepedia: "/v1/gravepedia" },
      github_callback: "/v1/auth/github/callback",
      openapi: "https://api.genepedia.org/v1/openapi.json",
    }),
  });
}

function methodNotAllowed(request, env, methods) {
  return jsonResponse(request, env, {
    ok: false,
    success: false,
    error: "method_not_allowed",
    message: `Only ${methods.join(" and ")} requests are supported for this route.`,
  }, 405, { Allow: methods.join(", ") });
}

function withMethods(request, env, methods, handler) {
  if (!methods.includes(request.method)) {
    return methodNotAllowed(request, env, methods);
  }
  return handler();
}

const storageHelpers = {
  ApiError, readJson, jsonResponse, requireUser, sessionFromRequest,
  randomHex, sha256, contentType, corsHeaders, personBucket,
  profileConfigWithOwner, profileManagerLogins, normalizeTalkMessage,
  normalizeMemorial, normalizeStatisticsEvent, profileIdentity,
  parsePhpBoolean, safeRepoPath, historyPaths, historyContextFor,
  workspacePathFor, constantTimeEqual, withMethods, methodNotAllowed,
};
const nativeStorage = createNativeStorage(storageHelpers);
const nativeDomain = createNativeDomain(storageHelpers, nativeStorage);
const nativeHttp = createNativeHttp(storageHelpers, nativeStorage);

async function nativeDataDispatch(request, env, site, endpoint) {
  if (endpoint === "meta/capabilities") return jsonResponse(request, env, {
    ok: true, api_version: 1, site,
    storage: { database: "D1", files: "R2", backend: "sites" },
    implemented: ["GitHub and local login/session/handoff", "Sites data and file storage", "indexed search", "atomic edit approval", "versioned file history", "profile and media editing", "profile discussions", "native statistics", "contact submissions"],
    unimplemented: [],
  });
  if (endpoint === "search/locations") return withMethods(request, env, ["GET"], () => locationSearch(request, env));
  const response = await nativeStorage.handle(request, env, site, endpoint)
    || await nativeHttp.handle(request, env, site, endpoint)
    || await nativeDomain.handle(request, env, site, endpoint);
  if (response) return response;
  throw new ApiError(404, "not_found", "Unknown API route.");
}

async function dispatch(request, env, ctx) {
  void ctx;
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, "") || "/";
  if (route === "/" || route === "/v1") return withMethods(request, env, ["GET"], () => apiDescription(request, env));
  if (route === "/v1/openapi.json") return withMethods(request, env, ["GET"], () => new Response(env.OPENAPI_SPEC_JSON || OPENAPI_SPEC_JSON, { status: 200, headers: { ...corsHeaders(request, env), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" } }));
  if (route === "/v1/auth/github/callback") return withMethods(request, env, ["GET"], () => oauthCallback(request, env));

  let site = "";
  let endpoint = "";
  const versionedRoute = route.match(/^\/v1\/(genepedia|gravepedia)(?:\/(.*))?$/);
  if (versionedRoute) {
    site = versionedRoute[1];
    endpoint = versionedRoute[2] || "";
  } else {
    throw new ApiError(404, "not_found", "Unknown API route.");
  }
  if (!endpoint) return withMethods(request, env, ["GET"], () => apiDescription(request, env, site));
  if (endpoint === "auth/github/login") return withMethods(request, env, ["GET"], () => loginStart(request, env, site));
  if (endpoint === "auth/local/login") return withMethods(request, env, ["POST"], () => localLogin(request, env));
  if (endpoint === "auth/github/callback") return withMethods(request, env, ["GET"], () => oauthCallback(request, env));
  if (endpoint === "auth/handoff") return withMethods(request, env, ["POST"], () => loginHandoff(request, env));
  if (endpoint === "auth/session") {
    if (request.method !== "GET") return methodNotAllowed(request, env, ["GET"]);
    const session = await sessionFromRequest(request, env);
    const reviewLogin = String(env.GITHUB_REVIEW_LOGIN || "");
    const apiConfigured = Boolean(env.DB && env.BUCKET);
    return jsonResponse(request, env, {
      authenticated: Boolean(session?.user),
      configured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      api_token_configured: apiConfigured,
      api_auth: { configured: apiConfigured, method: apiConfigured ? "sites" : null },
      auth_type: session?.authType || null,
      local_login_configured: localLoginConfigured(env),
      can_review_pull_requests: Boolean(session?.authType === "github" && session.user?.login && reviewLogin && session.user.login.toLowerCase() === reviewLogin.toLowerCase()),
      review_login: reviewLogin,
      user: session?.user || null,
    });
  }
  if (endpoint === "auth/logout") return withMethods(request, env, ["POST"], () => logout(request, env));
  if (endpoint === "auth/github/config") return withMethods(request, env, ["GET"], () => githubConfig(request, env, site));
  return nativeDataDispatch(request, env, site, endpoint);
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      if (request.method === "POST" && request.headers.has("Origin") && !corsHeaders(request, env)["Access-Control-Allow-Origin"]) {
        throw new ApiError(403, "origin_not_allowed", "This website is not allowed to submit changes.");
      }
      return await dispatch(request, env, ctx);
    } catch (error) {
      if (error instanceof ApiError) return jsonResponse(request, env, { ok: false, success: false, error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, error.status, error.retryAfter ? { "Retry-After": error.retryAfter } : {});
      return jsonResponse(request, env, { ok: false, success: false, error: "internal_error", message: "The API request could not be completed." }, 500);
    }
  },
};
