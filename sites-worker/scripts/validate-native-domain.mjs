import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createNativeStorage } from '../worker/storage-core.mjs';
import { createNativeDomain } from '../worker/storage-domain.mjs';
import { createD1, MemoryBucket } from './native-test-runtime.mjs';

class ApiError extends Error {
  constructor(status, code, message, details = null) { super(message); Object.assign(this, { status, code, details }); }
}

const helpers = {
  ApiError,
  randomHex: (bytes = 32) => randomBytes(bytes).toString('hex'),
  sha256: async (value) => createHash('sha256').update(value).digest('hex'),
  contentType: (name) => name.endsWith('.json') ? 'application/json' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream',
  readJson: async (request, max = 12_000_000) => {
    const text = await request.text();
    if (Buffer.byteLength(text) > max) throw new ApiError(413, 'body_too_large', 'Request is too large');
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
      return value;
    } catch { throw new ApiError(400, 'invalid_json', 'Request body must be a JSON object'); }
  },
  jsonResponse: (_request, _env, data, status = 200, headers = {}) => Response.json(data, { status, headers }),
  methodNotAllowed: (_request, _env, methods) => Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { Allow: methods.join(', ') } }),
  requireUser: async (request) => {
    const login = request.headers.get('X-Test-User');
    if (!login) throw new ApiError(401, 'authentication_required', 'Sign in');
    return { authType: 'github', user: { id: login, login, displayName: login, photoUrl: '', profileUrl: `https://github.com/${login}` } };
  },
  sessionFromRequest: async (request) => request.headers.has('X-Test-User') ? helpers.requireUser(request) : null,
  personBucket: (id) => Math.floor((Math.max(1, Number.parseInt(String(id).replace(/\D/g, '') || '0', 10)) - 1) / 1000),
  profileIdentity: (user, personId, fallbackName = '') => ({ personId, name: fallbackName || user?.displayName || user?.login || 'User', githubLogin: user?.login || '' }),
  profileConfigWithOwner(config, user, personId, claimSelf, fallbackName = '') {
    const next = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
    const identity = helpers.profileIdentity(user, personId, fallbackName);
    if (!next.creator || typeof next.creator !== 'object') next.creator = identity;
    const maintainers = Array.isArray(next.maintainers) ? [...next.maintainers] : [];
    if (!maintainers.some((item) => String(item.githubLogin || '').toLowerCase() === identity.githubLogin.toLowerCase())) maintainers.push(identity);
    next.maintainers = maintainers;
    next.owner = claimSelf ? identity : null;
    return next;
  },
  profileManagerLogins(config) {
    const values = [config?.owner, ...(Array.isArray(config?.maintainers) ? config.maintainers : [])];
    return [...new Set(values.map((item) => String(typeof item === 'string' ? item : item?.githubLogin || item?.login || '').toLowerCase()).filter(Boolean))];
  },
  normalizeTalkMessage(message) {
    return {
      id: String(message?.id || ''), body: String(message?.body || ''), author_login: String(message?.author_login || ''),
      author_name: String(message?.author_name || ''), author_avatar: String(message?.author_avatar || ''),
      author_url: String(message?.author_url || ''), created_at: String(message?.created_at || ''),
    };
  },
  normalizeMemorial(value) {
    return {
      id: String(value?.id || ''), name: String(value?.name || '').trim().slice(0, 300),
      cemetery: String(value?.cemetery || '').trim().slice(0, 500), birth_date: String(value?.birth_date || '').trim().slice(0, 100),
      death_date: String(value?.death_date || '').trim().slice(0, 100), inscription: String(value?.inscription || '').trim().slice(0, 12_000),
      notes: String(value?.notes || '').trim().slice(0, 12_000), source: String(value?.source || '').trim().slice(0, 2_000),
    };
  },
  normalizeStatisticsEvent(payload) {
    const type = String(payload.event || payload.action || 'profile_view').toLowerCase();
    const created_at = new Date().toISOString();
    if (type === 'search' || type === 'search_query') {
      const query = String(payload.query || payload.q || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 80);
      if (!query) throw new ApiError(400, 'invalid_request', 'A non-empty search query is required');
      return { event: 'search', query, result_count: Math.max(0, Number(payload.result_count || payload.results || 0)), created_at };
    }
    const person_id = String(payload.person_id || payload.person || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(person_id)) throw new ApiError(400, 'invalid_request', 'A valid profile id is required');
    return { event: 'profile_view', kind: String(payload.kind || '').toLowerCase() === 'pet' ? 'pet' : 'person', person_id, created_at };
  },
  parsePhpBoolean(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
  },
  safeRepoPath(value) {
    const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    return path && !path.split('/').some((part) => !part || part === '.' || part === '..') ? path : null;
  },
  constantTimeEqual(left, right) { return String(left) === String(right); },
};

const store = createNativeStorage(helpers);
const domain = createNativeDomain(helpers, store);
const env = {
  DB: await createD1(),
  BUCKET: new MemoryBucket(),
  STORAGE_MIGRATION_TOKEN: 'domain-test-migration-token',
  GITHUB_STATISTICS_FLUSH_TOKEN: 'domain-test-flush-token',
  GITHUB_REVIEW_LOGIN: 'reviewer',
};
const actor = (login) => ({ id: login, login, displayName: login });
const file = (namespace, path, value, expectedVersion) => ({
  namespace,
  path,
  content: typeof value === 'string' ? value : JSON.stringify(value),
  ...(expectedVersion === undefined ? {} : { expectedVersion }),
});
let checks = 0;

async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`Passed: ${name}`);
}

async function call(site, endpoint, { method = 'GET', query = '', body, user = '', headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (user) requestHeaders.set('X-Test-User', user);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  const request = new Request(`https://api.test/v1/${site}/${endpoint}${query}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const response = await domain.handle(request, env, site, endpoint);
    return { status: response.status, body: await response.json() };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
}

await check('pet self-profile submissions use isolated pets database record and ownership paths', async () => {
  const createRequest = {
    method: 'POST', user: 'alice', headers: { 'Idempotency-Key': 'pet-profile-create-7' },
    body: {
      action: 'create', person_id: '7', profile_kind: 'pet',
      files: [
        { path: 'pages/pets/7/index.html', content: '<html><body>Pet</body></html>' },
        { path: 'pages/pets/7/profile.html', content: '<h1>Pet profile</h1>' },
        { path: 'data/Genepedia-Database/pets/persons/0/7.json', content: '{"id":7,"names":{"display":"Test pet"}}' },
        { path: 'data/Genepedia-Database/pets/ownership/0/7.json', content: '{"owner":{"name":"Alice"}}' },
      ],
    },
  };
  const response = await call('genepedia', 'profiles/self', createRequest);
  assert.equal(response.status, 201);
  const replay = await call('genepedia', 'profiles/self', createRequest);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.change_id, response.body.change_id);
  assert.equal(replay.body.published_at, response.body.published_at);
  const change = await store.getChange(env, 'genepedia', response.body.pull_request.number);
  assert.ok(change.files.some((item) => item.namespace === 'data' && item.path === 'pets/persons/0/7.json'));
  assert.ok(change.files.some((item) => item.namespace === 'data' && item.path === 'pets/ownership/0/7.json'));
  assert.equal(await store.get(env, 'genepedia', 'data', 'people/persons/0/7.json'), null);
  assert.equal(await store.get(env, 'genepedia', 'data', 'people/ownership/0/7.json'), null);
  await store.reviewChange(env, 'genepedia', response.body.pull_request.number, actor('reviewer'), 'approve');
  const replayAfterApproval = await call('genepedia', 'profiles/self', createRequest);
  assert.equal(replayAfterApproval.status, 201);
  assert.deepEqual(Object.keys(replayAfterApproval.body).sort(), Object.keys(response.body).sort());
  assert.equal(replayAfterApproval.body.change_id, response.body.change_id);
  assert.equal(replayAfterApproval.body.published_at, response.body.published_at);
  assert.equal(replayAfterApproval.body.pull_request.state, 'merged');
  const changedCreateReplay = await call('genepedia', 'profiles/self', {
    ...createRequest,
    body: { ...createRequest.body, files: createRequest.body.files.map((entry) => entry.path.endsWith('/profile.html') ? { ...entry, content: '<h1>Changed</h1>' } : entry) },
  });
  assert.equal(changedCreateReplay.status, 409);
  assert.equal(changedCreateReplay.body.error, 'idempotency_conflict');
});

await check('claim uses compare-and-set metadata and competing claims cannot both reserve the path', async () => {
  await store.apply(env, {
    site: 'genepedia', actor: actor('migration'),
    files: [file('data', 'people/ownership/0/8.json', { creator: { githubLogin: 'owner' }, owner: null, maintainers: [] })],
  });
  const claimRequest = { method: 'POST', user: 'alice', headers: { 'Idempotency-Key': 'claim-person-8' }, body: { action: 'claim', person_id: '8' } };
  const first = await call('genepedia', 'profiles/self', claimRequest);
  assert.equal(first.status, 201);
  const replay = await call('genepedia', 'profiles/self', claimRequest);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.change_id, first.body.change_id);
  const competing = await call('genepedia', 'profiles/self', { method: 'POST', user: 'bob', body: { action: 'claim', person_id: '8' } });
  assert.equal(competing.status, 409);
  assert.equal((await store.get(env, 'genepedia', 'data', 'people/ownership/0/8.json')).version, 1);
  const accepted = await store.reviewChange(env, 'genepedia', first.body.pull_request.number, actor('reviewer'), 'approve');
  assert.equal(accepted.merged, true);
  assert.equal(JSON.parse((await store.get(env, 'genepedia', 'data', 'people/ownership/0/8.json')).content).owner.githubLogin, 'alice');
  const claimReplayAfterApproval = await call('genepedia', 'profiles/self', claimRequest);
  assert.equal(claimReplayAfterApproval.status, 201);
  assert.equal(claimReplayAfterApproval.body.change_id, first.body.change_id);
  assert.equal(claimReplayAfterApproval.body.claimed_at, first.body.claimed_at);
  assert.deepEqual(Object.keys(claimReplayAfterApproval.body).sort(), Object.keys(first.body).sort());
  assert.equal(claimReplayAfterApproval.body.pull_request.state, 'merged');
  const changedClaimReplay = await call('genepedia', 'profiles/self', {
    ...claimRequest,
    body: { ...claimRequest.body, commit_message: 'A changed intent' },
  });
  assert.equal(changedClaimReplay.status, 409);
  assert.equal(changedClaimReplay.body.error, 'idempotency_conflict');
  const afterApproval = await call('genepedia', 'profiles/self', { method: 'POST', user: 'bob', body: { action: 'claim', person_id: '8' } });
  assert.equal(afterApproval.status, 409);
});

await check('maintainer changes are scoped to one target and only target owner can invite', async () => {
  await store.apply(env, {
    site: 'genepedia', actor: actor('migration'),
    files: [file('data', 'people/ownership/0/9.json', { owner: { githubLogin: 'alice', name: 'Alice' }, maintainers: [] })],
  });
  const unauthorized = await call('genepedia', 'maintainers', { method: 'POST', user: 'bob', body: { path: 'pages/people/9/profile.html', action: 'invite', github_login: 'carol' } });
  assert.equal(unauthorized.status, 403);
  const inviteHeaders = { 'Idempotency-Key': 'maintainer-invite-alice-bob' };
  const inviteRequest = { method: 'POST', user: 'alice', headers: inviteHeaders, body: { path: 'pages/people/9/profile.html', action: 'invite', github_login: 'bob' } };
  const invited = await call('genepedia', 'maintainers', inviteRequest);
  assert.equal(invited.status, 201);
  const item = invited.body.items.find((entry) => entry.kind === 'invite');
  assert.ok(item);
  const inviteReplay = await call('genepedia', 'maintainers', inviteRequest);
  assert.equal(inviteReplay.status, 201);
  assert.equal(inviteReplay.body.change_id, invited.body.change_id);
  assert.equal(inviteReplay.body.items.find((entry) => entry.id === item.id).createdAt, item.createdAt);
  const change = await store.getChange(env, 'genepedia', invited.body.pull_request.number);
  assert.ok(change.files.some((entry) => entry.path.startsWith('maintainers/targets/')));
  const accepted = await call('genepedia', 'maintainers', { method: 'POST', user: 'bob', body: { path: 'pages/people/9/profile.html', action: 'accept_invite', id: item.id } });
  assert.equal(accepted.status, 404); // An invite staged for review is not yet visible in the live target ledger.
  await store.reviewChange(env, 'genepedia', invited.body.pull_request.number, actor('reviewer'), 'approve');
  const acceptedInviteRequest = {
    method: 'POST', user: 'bob', headers: { 'Idempotency-Key': 'maintainer-accept-bob-invite' },
    body: { path: 'pages/people/9/profile.html', action: 'accept_invite', id: item.id },
  };
  const acceptedAfterReview = await call('genepedia', 'maintainers', acceptedInviteRequest);
  assert.equal(acceptedAfterReview.status, 201);
  await store.reviewChange(env, 'genepedia', acceptedAfterReview.body.pull_request.number, actor('reviewer'), 'approve');
  const acceptedInviteReplay = await call('genepedia', 'maintainers', acceptedInviteRequest);
  assert.equal(acceptedInviteReplay.status, 201);
  assert.deepEqual(Object.keys(acceptedInviteReplay.body).sort(), Object.keys(acceptedAfterReview.body).sort());
  assert.equal(acceptedInviteReplay.body.change_id, acceptedAfterReview.body.change_id);
  assert.equal(acceptedInviteReplay.body.published_at, acceptedAfterReview.body.published_at);
  assert.equal(acceptedInviteReplay.body.pull_request.state, 'merged');
  assert.equal(acceptedInviteReplay.body.items.find((entry) => entry.id === item.id).status, 'accepted');
  const changedInviteReplay = await call('genepedia', 'maintainers', {
    ...acceptedInviteRequest,
    body: { ...acceptedInviteRequest.body, id: 'different-invite' },
  });
  assert.equal(changedInviteReplay.status, 409);
  assert.equal(changedInviteReplay.body.error, 'idempotency_conflict');
  const config = JSON.parse((await store.get(env, 'genepedia', 'data', 'people/ownership/0/9.json')).content);
  assert.ok(config.maintainers.some((entry) => entry.githubLogin === 'bob'));
});

await check('talk appends preserve concurrent posts and delete authorization is enforced', async () => {
  await store.apply(env, {
    site: 'genepedia', actor: actor('migration'),
    files: [file('data', 'people/ownership/0/12.json', { owner: { githubLogin: 'moderator' }, maintainers: [] })],
  });
  const results = await Promise.all(['alice', 'bob'].map((user) => call('genepedia', 'talk', {
    method: 'POST', user, headers: { 'Idempotency-Key': `talk-post-${user}` }, body: { action: 'post', person_id: '12', body: `Hello from ${user}` },
  })));
  assert.deepEqual(results.map((entry) => entry.status), [201, 201]);
  const talk = JSON.parse((await store.get(env, 'genepedia', 'content', 'pages/people/12/data/talk.json')).content);
  assert.equal(talk.messages.length, 2);
  const target = talk.messages.find((message) => message.author_login === 'alice');
  const denied = await call('genepedia', 'talk', { method: 'POST', user: 'bob', body: { action: 'delete', person_id: '12', message_id: target.id } });
  assert.equal(denied.status, 403);
  const deleteRequest = { method: 'POST', user: 'moderator', headers: { 'Idempotency-Key': 'talk-delete-alice-target' }, body: { action: 'delete', person_id: '12', message_id: target.id } };
  const deleted = await call('genepedia', 'talk', deleteRequest);
  assert.equal(deleted.status, 200);
  assert.equal(JSON.parse((await store.get(env, 'genepedia', 'content', 'pages/people/12/data/talk.json')).content).messages.length, 1);
  const replay = await call('genepedia', 'talk', deleteRequest);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.change_id, deleted.body.change_id);
  assert.equal(replay.body.messages.length, 1);
  const mismatchedReplay = await call('genepedia', 'talk', { ...deleteRequest, body: { ...deleteRequest.body, message_id: 'some-other-message' } });
  assert.equal(mismatchedReplay.status, 409);
  assert.equal(mismatchedReplay.body.error, 'idempotency_conflict');
});

await check('corrupt talk JSON fails closed without replacing stored content', async () => {
  await store.apply(env, {
    site: 'genepedia', actor: actor('migration'),
    files: [file('content', 'pages/people/13/data/talk.json', '{not-json')],
  });
  const response = await call('genepedia', 'talk', { query: '?person=13' });
  assert.equal(response.status, 502);
  assert.equal(response.body.error, 'storage_file_invalid');
  assert.equal((await store.get(env, 'genepedia', 'content', 'pages/people/13/data/talk.json')).content, '{not-json');
});

await check('native statistics combine imported published totals with D1 events and leave imported files untouched', async () => {
  const profileViews = JSON.stringify({ schema: 'genepedia/statistics/profile-views@2', updatedAt: '2026-01-01T00:00:00Z', profiles: { 'person:20': { views: 11, firstViewedAt: '2026-01-01T00:00:00Z', lastViewedAt: '2026-01-02T00:00:00Z' } } });
  const searchQueries = JSON.stringify({ schema: 'genepedia/statistics/search-queries@1', updatedAt: '2026-01-01T00:00:00Z', queries: { roots: { count: 5, lastSearchedAt: '2026-01-02T00:00:00Z', lastResultCount: 1 } } });
  const today = new Date().toISOString().slice(0, 10);
  const dailyRollups = JSON.stringify({ days: { [today]: { profileViews: 2, searches: 1, profiles: {}, queries: {} } } });
  await store.importRecords(env, 'genepedia', [
    { namespace: 'data', path: 'statistics/profile-views.json', content: profileViews, content_type: 'application/json', sha256: await helpers.sha256(profileViews) },
    { namespace: 'data', path: 'statistics/search-queries.json', content: searchQueries, content_type: 'application/json', sha256: await helpers.sha256(searchQueries) },
    { namespace: 'data', path: 'statistics/daily-rollups.json', content: dailyRollups, content_type: 'application/json', sha256: await helpers.sha256(dailyRollups) },
  ]);
  const baseline = (await store.get(env, 'genepedia', 'data', 'statistics/profile-views.json')).content;
  await store.recordStatistic(env, { id: 'domain-view-1', site: 'genepedia', event_type: 'profile_view', person_id: '20', kind: 'person', created_at: new Date().toISOString() });
  await store.recordStatistic(env, { id: 'domain-search-1', site: 'genepedia', event_type: 'search', query: 'roots', result_count: 2, created_at: new Date().toISOString() });
  const response = await call('genepedia', 'statistics', { query: '?metric=summary' });
  assert.equal(response.status, 200);
  assert.equal(response.body.summary.totals.profileViews, 12);
  assert.equal(response.body.summary.totals.searches, 6);
  assert.equal(response.body.summary.today.profileViews, 3);
  assert.equal(response.body.summary.today.searches, 2);
  assert.equal((await store.get(env, 'genepedia', 'data', 'statistics/profile-views.json')).content, baseline);
});

await check('statistics totals remain exact when the indexed leaderboard group rows are capped', async () => {
  const manyPeople = Array.from({ length: 5_000 }, (_, index) => ({ kind: 'person', person_id: `person-${index}`, count: 1, last_at: '2026-10-23T12:00:00.000Z' }));
  const limitedStore = {
    ...store,
    async aggregateStatistics(_env, { since } = {}) {
      if (since) return { total: 0, by_event_type: [], by_person: [], by_query: [], people_groups_total: 0, query_groups_total: 0 };
      return {
        total: 5_002,
        by_event_type: [{ event_type: 'profile_view', count: 5_001 }, { event_type: 'search', count: 1 }],
        by_person: manyPeople,
        by_query: [{ query: 'one unique query', count: 1, last_at: '2026-10-23T12:00:00.000Z', last_result_count: 0 }],
        people_groups_total: 5_001,
        query_groups_total: 1,
      };
    },
  };
  const isolatedEnv = { ...env, DB: await createD1(), BUCKET: new MemoryBucket() };
  const limitedDomain = createNativeDomain(helpers, limitedStore);
  const request = new Request('https://api.test/v1/genepedia/statistics?metric=summary');
  const response = await limitedDomain.handle(request, isolatedEnv, 'genepedia', 'statistics');
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.summary.totals.profileViews, 5_001);
  assert.equal(payload.summary.totals.searches, 1);
  assert.equal(payload.summary.nativeEvents, 5_002);
  assert.equal(payload.summary.totals.profilesTracked, 5_000);
  assert.equal(payload.summary.totals.profilesTrackedCapped, true);
  isolatedEnv.DB.sqlite.close();
});

await check('statistics summaries coalesce, invalidate on writes and flush, and evict failed cache entries', async () => {
  const isolatedEnv = { ...env, DB: await createD1(), BUCKET: new MemoryBucket() };
  let aggregateCalls = 0;
  let failNextAggregate = true;
  const cacheStore = {
    ...store,
    async aggregateStatistics() {
      aggregateCalls += 1;
      if (failNextAggregate) throw new Error('simulated aggregate failure');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { total: 0, by_event_type: [], by_person: [], by_query: [], people_groups_total: 0, query_groups_total: 0 };
    },
  };
  const cacheDomain = createNativeDomain(helpers, cacheStore);
  const summaryRequest = () => new Request('https://api.test/v1/genepedia/statistics?metric=summary');
  await assert.rejects(cacheDomain.handle(summaryRequest(), isolatedEnv, 'genepedia', 'statistics'), /simulated aggregate failure/);
  failNextAggregate = false;
  await Promise.all([
    cacheDomain.handle(summaryRequest(), isolatedEnv, 'genepedia', 'statistics'),
    cacheDomain.handle(summaryRequest(), isolatedEnv, 'genepedia', 'statistics'),
  ]);
  assert.equal(aggregateCalls, 20); // The failed build starts its ten queries; the next coalesced build starts ten more.
  const post = await cacheDomain.handle(new Request('https://api.test/v1/genepedia/statistics', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'cache-invalidate-event' }, body: JSON.stringify({ event: 'profile_view', person_id: 'cache-profile' }),
  }), isolatedEnv, 'genepedia', 'statistics');
  assert.equal(post.status, 202);
  await Promise.all([
    cacheDomain.handle(summaryRequest(), isolatedEnv, 'genepedia', 'statistics'),
    cacheDomain.handle(summaryRequest(), isolatedEnv, 'genepedia', 'statistics'),
  ]);
  assert.equal(aggregateCalls, 30);
  const flush = await cacheDomain.handle(new Request('https://api.test/v1/genepedia/statistics/flush', {
    method: 'POST', headers: { 'X-Statistics-Flush-Token': isolatedEnv.STORAGE_MIGRATION_TOKEN },
  }), isolatedEnv, 'genepedia', 'statistics/flush');
  assert.equal(flush.status, 200);
  await cacheDomain.handle(summaryRequest(), isolatedEnv, 'genepedia', 'statistics');
  assert.equal(aggregateCalls, 40);
  isolatedEnv.DB.sqlite.close();
});

await check('malformed imported statistics shapes fail closed instead of returning zero totals', async () => {
  const isolatedEnv = { ...env, DB: await createD1(), BUCKET: new MemoryBucket() };
  const invalid = JSON.stringify({ schema: 'genepedia/statistics/profile-views@2', profiles: [] });
  await store.importRecords(isolatedEnv, 'genepedia', [{ namespace: 'data', path: 'statistics/profile-views.json', content: invalid, content_type: 'application/json' }]);
  const limitedDomain = createNativeDomain(helpers, store);
  await assert.rejects(
    limitedDomain.handle(new Request('https://api.test/v1/genepedia/statistics?metric=summary'), isolatedEnv, 'genepedia', 'statistics'),
    (error) => error instanceof ApiError && error.status === 502 && error.code === 'storage_file_invalid',
  );
  isolatedEnv.DB.sqlite.close();
});

await check('statistics events replay idempotently and reject reusing a key for a different event', async () => {
  const headers = { 'Idempotency-Key': 'statistics-search-roots' };
  const first = await call('genepedia', 'statistics', { method: 'POST', headers, body: { event: 'search', query: 'roots', result_count: 3 } });
  const replay = await call('genepedia', 'statistics', { method: 'POST', headers, body: { event: 'search', query: 'roots', result_count: 3 } });
  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.equal(replay.body.publish.event_id, first.body.publish.event_id);
  assert.equal((await store.queryStatistics(env, { site: 'genepedia', event_type: 'search', query: 'roots' })).total, 2); // One earlier baseline test event plus this single replayed event.
  const changed = await call('genepedia', 'statistics', { method: 'POST', headers, body: { event: 'search', query: 'other roots', result_count: 3 } });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'idempotency_conflict');
});

await check('statistics flush drains legacy queue atomically and repeated flush is idempotent', async () => {
  const event = { event: 'profile_view', kind: 'person', person_id: '88', created_at: '2026-10-23T12:00:00.000Z' };
  env.DB.sqlite.prepare('INSERT INTO statistics_events (event_id,payload,created_at) VALUES (?,?,?)').run('legacy-domain-event', JSON.stringify(event), event.created_at);
  const headers = { 'X-Statistics-Flush-Token': env.STORAGE_MIGRATION_TOKEN };
  const first = await call('genepedia', 'statistics/flush', { method: 'POST', headers });
  assert.equal(first.status, 200);
  assert.equal(first.body.flush.copied, 1);
  assert.equal(first.body.flush.acknowledged, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM statistics_events').get().n, 0);
  const second = await call('genepedia', 'statistics/flush', { method: 'POST', headers });
  assert.equal(second.status, 200);
  assert.equal(second.body.flush.copied, 0);
  assert.equal((await store.queryStatistics(env, { site: 'genepedia', event_type: 'profile_view', person_id: '88' })).total, 1);
  const unauthorized = await call('genepedia', 'statistics/flush', { method: 'POST', headers: { 'X-Statistics-Flush-Token': 'wrong-token' } });
  assert.equal(unauthorized.status, 403);
});

await check('memorial search uses native FTS and returns stored records with offset pagination', async () => {
  const record = { id: 'memorial-1', name: 'Ada Example', cemetery: 'North Valley', birth_date: '1900', death_date: '1980' };
  await store.importRecords(env, 'gravepedia', [{ namespace: 'data', path: 'memorials/records/memorial-1.json', content: JSON.stringify(record), content_type: 'application/json' }]);
  const first = await call('gravepedia', 'memorials', { query: '?q=Ada&limit=1&offset=0' });
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 1);
  assert.equal(first.body.results[0].name, 'Ada Example');
});

await check('memorial submissions replay by idempotency key without duplicating staged changes', async () => {
  const request = {
    method: 'POST', user: 'alice', headers: { 'Idempotency-Key': 'memorial-submission-1' },
    body: { name: 'Grace Example', cemetery: 'North Valley', birth_date: '1910', death_date: '1990' },
  };
  const first = await call('gravepedia', 'memorials', request);
  const replay = await call('gravepedia', 'memorials', request);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.submission_id, first.body.submission_id);
  assert.equal(replay.body.change_id, first.body.change_id);
  assert.equal((await store.listChanges(env, 'gravepedia', { state: 'open', limit: 100 })).changes.filter((change) => change.title.includes('Grace Example')).length, 1);
});

await check('contact submissions persist as private native support records', async () => {
  const request = { method: 'POST', user: 'alice', headers: { 'Idempotency-Key': 'contact-alice-question' }, body: { subject: 'Question', message: 'Please contact me', reason: 'question' } };
  const response = await call('genepedia', 'contact', request);
  assert.equal(response.status, 201);
  const replay = await call('genepedia', 'contact', request);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.ticket_id, response.body.ticket_id);
  assert.equal(replay.body.created_at, response.body.created_at);
  const changed = await call('genepedia', 'contact', { ...request, body: { ...request.body, message: 'Different message' } });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'idempotency_conflict');
  const docs = await store.list(env, 'genepedia', 'data', { prefix: 'support/contacts/', limit: 10 });
  assert.equal(docs.documents.length, 1);
  const ticket = JSON.parse((await store.get(env, 'genepedia', 'data', docs.documents[0].path)).content);
  assert.equal(ticket.author, 'alice');
  assert.equal(ticket.subject, 'Question');
});

assert.equal(env.DB.sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
console.log(`Native domain: ${checks} checks passed with real SQLite transactions and a mock R2 bucket.`);
