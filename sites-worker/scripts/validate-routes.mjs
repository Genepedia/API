import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
import { createD1, MemoryBucket } from './native-test-runtime.mjs';

const env = {
  DB: await createD1(),
  BUCKET: new MemoryBucket(),
  GITHUB_SESSION_SECRET: 'native-route-validation-session-secret-0123456789',
  GITHUB_CLIENT_ID: 'Iv1.route-validation',
  GITHUB_CLIENT_SECRET: 'route-validation-oauth-secret',
  GITHUB_CALLBACK_URL: 'https://api.genepedia.org/v1/auth/github/callback',
  GITHUB_REVIEW_LOGIN: 'reviewer',
  GITHUB_WELCOME_STAR_REPOS: 'ExampleOrg/example-repo',
  GITHUB_WELCOME_FOLLOW_USERS: 'followed-user',
  STORAGE_MIGRATION_TOKEN: 'native-route-validation-migration-token',
};

const originalFetch = globalThis.fetch;
const externalRequests = [];
let starWrites = 0;
let followWrites = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method || input?.method || 'GET';
  externalRequests.push(`${method} ${url.origin}${url.pathname}`);

  if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token' && method === 'POST') {
    return Response.json({ access_token: 'test-github-user-token' });
  }
  if (url.origin === 'https://api.github.com' && url.pathname === '/user' && method === 'GET') {
    return Response.json({ id: 41, login: 'test-user', name: 'Test User', avatar_url: 'https://avatars.example/test', html_url: 'https://github.com/test-user' });
  }
  if (url.origin === 'https://api.github.com' && url.pathname === '/user/starred/ExampleOrg/example-repo' && method === 'PUT') {
    starWrites += 1;
    return new Response(null, { status: 204 });
  }
  if (url.origin === 'https://api.github.com' && url.pathname === '/users/followed-user' && method === 'GET') {
    return Response.json({ login: 'followed-user', type: 'User' });
  }
  if (url.origin === 'https://api.github.com' && url.pathname === '/user/following/followed-user') {
    if (method === 'PUT') {
      followWrites += 1;
      return new Response(null, { status: 204 });
    }
    if (method === 'GET') return new Response(null, { status: 404 });
  }
  throw new Error(`Unexpected external request from route validation: ${method} ${url.href}`);
};

let passed = 0;
async function check(label, run) {
  await run();
  passed += 1;
  console.log(`Passed: ${label}`);
}

async function call(path, { method = 'GET', body, headers = {}, status = 200, targetEnv = env } = {}) {
  const requestHeaders = new Headers(headers);
  if (body !== undefined && !requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request(`https://api.genepedia.org${path}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), targetEnv);
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text.slice(0, 1200)}`);
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data };
}

function cookieValue(header, name) {
  const match = String(header || '').match(new RegExp(`${name}=([^;,]+)`));
  assert.ok(match, `Expected ${name} cookie`);
  return decodeURIComponent(match[1]);
}

try {
  await check('API discovery advertises Sites storage without a backend switch', async () => {
    const discovery = await call('/v1');
    assert.deepEqual(discovery.data.sites, { genepedia: '/v1/genepedia', gravepedia: '/v1/gravepedia' });
    const capabilities = await call('/v1/genepedia/meta/capabilities');
    assert.deepEqual(capabilities.data.storage, { database: 'D1', files: 'R2', backend: 'sites' });
    assert.deepEqual(capabilities.data.unimplemented, []);
    const config = await call('/v1/genepedia/auth/github/config');
    assert.equal(config.data.api_auth.method, 'sites');
    assert.equal(config.data.storage.database, 'D1');
  });

  await check('native routes, history paths and PHP aliases never fall back to GitHub repositories', async () => {
    const missing = await call('/v1/genepedia/data?path=people/persons/0/404.json', { status: 404 });
    assert.equal(missing.data.error, 'file_not_found');
    const history = await call('/v1/genepedia/files/commits?path=pages/people/29/');
    assert.equal(history.data.paths[0], 'pages/people/29/index.html');
    assert.deepEqual(history.data.commits, []);
    await call('/v1/genepedia/profiles/self.php', { status: 404 });
    await call('/v1/genepedia/github-login.php', { status: 404 });
    await call('/v1/genepedia/page-edits', { method: 'POST', body: { path: 'pages/about.html', content: '<h1>test</h1>' }, status: 401 });
    assert.equal(externalRequests.filter((request) => request.includes('/repos/')).length, 0);
  });

  await check('CORS allows configured website origins and rejects cross-origin writes', async () => {
    const preflight = await call('/v1/genepedia/page-edits', {
      method: 'OPTIONS', headers: { Origin: 'https://www.genepedia.org', 'Access-Control-Request-Method': 'POST' }, status: 204,
    });
    assert.equal(preflight.response.headers.get('Access-Control-Allow-Origin'), 'https://www.genepedia.org');
    assert.ok(preflight.response.headers.get('Access-Control-Allow-Headers').includes('Idempotency-Key'));
    const before = externalRequests.length;
    const rejected = await call('/v1/genepedia/page-edits', {
      method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: { path: 'pages/about.html', content: '<h1>x</h1>' }, status: 403,
    });
    assert.equal(rejected.data.error, 'origin_not_allowed');
    assert.equal(externalRequests.length, before);
  });

  let githubSessionCookie;
  let githubHandoff;
  await check('GitHub OAuth still verifies identity and applies configured welcome actions', async () => {
    const start = await call('/v1/genepedia/auth/github/login?return_to=https%3A%2F%2Fwww.genepedia.org%2Fpages%2Flogin.html', {
      headers: { Origin: 'https://www.genepedia.org' }, status: 302,
    });
    const authorization = new URL(start.response.headers.get('Location'));
    assert.equal(authorization.origin, 'https://github.com');
    assert.equal(authorization.pathname, '/login/oauth/authorize');
    assert.equal(authorization.searchParams.get('scope'), 'read:user user:email user:follow');
    const state = authorization.searchParams.get('state');
    const csrf = cookieValue(start.response.headers.get('Set-Cookie'), '__Host-genepedia_oauth');
    const callback = await call(`/v1/auth/github/callback?state=${encodeURIComponent(state)}&code=validation-code`, {
      headers: { Cookie: `__Host-genepedia_oauth=${encodeURIComponent(csrf)}` }, status: 302,
    });
    const returnTo = new URL(callback.response.headers.get('Location'));
    assert.equal(returnTo.origin, 'https://www.genepedia.org');
    githubHandoff = returnTo.searchParams.get('github_handoff');
    githubSessionCookie = cookieValue(callback.response.headers.get('Set-Cookie'), '__Host-genepedia_session');
    assert.ok(githubHandoff);
    assert.equal(starWrites, 1);
    assert.equal(followWrites, 1);
    const session = await call('/v1/genepedia/auth/session', { headers: { Cookie: `__Host-genepedia_session=${githubSessionCookie}` } });
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.auth_type, 'github');
    assert.equal(session.data.user.login, 'test-user');
    assert.equal(session.data.api_auth.method, 'sites');
  });

  await check('GitHub identity bearer sessions and one-time handoff remain available', async () => {
    const bearer = await call('/v1/genepedia/auth/session', { headers: { Authorization: 'Bearer test-github-user-token' } });
    assert.equal(bearer.data.authenticated, true);
    assert.equal(bearer.data.user.login, 'test-user');
    const handoff = await call('/v1/genepedia/auth/handoff', { method: 'POST', body: { code: githubHandoff } });
    assert.equal(handoff.data.authenticated, true);
    assert.equal(handoff.data.auth_type, 'github');
    const cookie = cookieValue(handoff.response.headers.get('Set-Cookie'), '__Host-genepedia_session');
    const session = await call('/v1/genepedia/auth/session', { headers: { Cookie: `__Host-genepedia_session=${cookie}` } });
    assert.equal(session.data.user.login, 'test-user');
    const logout = await call('/v1/genepedia/auth/logout', { method: 'POST', headers: { Cookie: `__Host-genepedia_session=${cookie}` } });
    assert.equal(logout.data.authenticated, false);
  });

  await check('local login and session handoff remain available', async () => {
    const localEnv = {
      ...env,
      LOCAL_LOGIN_USERNAME: 'local-reviewer',
      LOCAL_LOGIN_PASSWORD: 'local-password-fixture',
      LOCAL_LOGIN_DISPLAY_NAME: 'Local Reviewer',
    };
    const invalid = await call('/v1/genepedia/auth/local/login', {
      method: 'POST', body: { username: 'local-reviewer', password: 'incorrect' }, targetEnv: localEnv, status: 401,
    });
    assert.equal(invalid.data.error, 'invalid_credentials');
    const login = await call('/v1/genepedia/auth/local/login', {
      method: 'POST', body: { username: 'local-reviewer', password: 'local-password-fixture' }, targetEnv: localEnv,
    });
    assert.equal(login.data.auth_type, 'local');
    const handoff = await call('/v1/genepedia/auth/handoff', { method: 'POST', body: { code: login.data.handoff }, targetEnv: localEnv });
    assert.equal(handoff.data.auth_type, 'local');
    assert.equal(Object.hasOwn(handoff.data, 'access_token'), false);
    const cookie = cookieValue(handoff.response.headers.get('Set-Cookie'), '__Host-genepedia_session');
    const session = await call('/v1/genepedia/auth/session', { headers: { Cookie: `__Host-genepedia_session=${cookie}` }, targetEnv: localEnv });
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.auth_type, 'local');
    assert.equal(session.data.user.login, 'local-reviewer');
  });

  assert.equal(externalRequests.filter((request) => request.includes('/repos/')).length, 0);
  assert.equal((await env.DB.prepare('PRAGMA integrity_check').first()).integrity_check, 'ok');
  console.log(`Route validation passed: ${passed} checks; GitHub calls limited to OAuth identity and configured welcome actions.`);
} finally {
  globalThis.fetch = originalFetch;
}
