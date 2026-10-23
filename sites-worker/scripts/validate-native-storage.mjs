import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createNativeStorage } from '../worker/storage-core.mjs';
import { createNativeHttp } from '../worker/storage-http.mjs';
import { createD1, MemoryBucket } from './native-test-runtime.mjs';

class ApiError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); }
}
const helpers = {
  ApiError,
  randomHex: (bytes = 32) => randomBytes(bytes).toString('hex'),
  sha256: async (value) => createHash('sha256').update(value).digest('hex'),
  contentType: (name) => name.endsWith('.json') ? 'application/json' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream',
  readJson: async (request, max = 12_000_000) => {
    const text = await request.text();
    if (Buffer.byteLength(text) > max) throw new ApiError(413, 'body_too_large', 'Request is too large');
    return JSON.parse(text);
  },
  jsonResponse: (_request, _env, data, status = 200, headers = {}) => Response.json(data, { status, headers }),
  corsHeaders: () => ({}),
  requireUser: async (request) => {
    const login = request.headers.get('X-Test-User');
    if (!login) throw new ApiError(401, 'authentication_required', 'Sign in');
    return { authType: 'github', user: { id: login, login, displayName: login } };
  },
  sessionFromRequest: async (request) => request.headers.has('X-Test-User') ? helpers.requireUser(request) : null,
};
const store = createNativeStorage(helpers);
const http = createNativeHttp(helpers, store);
const env = { DB: await createD1(), BUCKET: new MemoryBucket(), STORAGE_MIGRATION_TOKEN: 'test-only-migration-secret', GITHUB_REVIEW_LOGIN: 'reviewer' };
const actor = { id: 'writer', login: 'writer' };
const reviewer = { id: 'reviewer', login: 'reviewer' };
const hash = helpers.sha256;
const file = (path, value, namespace = 'data', expectedVersion) => ({ namespace, path, content: typeof value === 'string' ? value : JSON.stringify(value), ...(expectedVersion === undefined ? {} : { expectedVersion }) });
let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`Passed: ${label}`);
}

await check('identical imports preserve exact bytes and versions; conflicting imports preserve original', async () => {
  const content = '{ "id": 1, "names": {"display": "Storage Test"} }\n';
  const record = { namespace: 'data', path: 'people/persons/0/1.json', content, sha256: await hash(content), content_type: 'application/json' };
  const first = await store.importRecords(env, 'genepedia', [record]);
  assert.equal(first.imported, 1);
  const duplicate = await store.importRecords(env, 'genepedia', [record]);
  assert.equal(duplicate.skipped, 1);
  const stored = await store.get(env, 'genepedia', 'data', record.path);
  assert.equal(stored.content, content);
  assert.equal(stored.version, 1);
  await assert.rejects(store.importRecords(env, 'genepedia', [{ ...record, content: '{}', sha256: await hash('{}') }]), (error) => error.status === 409);
  assert.equal((await store.get(env, 'genepedia', 'data', record.path)).content, content);
});

await check('fresh batched imports do not issue one D1 row lookup per document', async () => {
  const originalPrepare = env.DB.prepare;
  let individualDocumentReads = 0;
  env.DB.prepare = function (sql) {
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();
    if (/^SELECT .* FROM native_documents WHERE site = \?1 AND namespace = \?2 AND path = \?3$/i.test(normalizedSql)) {
      individualDocumentReads += 1;
    }
    return originalPrepare.call(this, sql);
  };
  try {
    const records = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
      const content = JSON.stringify({ id: `fresh-${index}` });
      return {
        namespace: 'data',
        path: `import-batch/fresh-${index}.json`,
        content,
        sha256: await hash(content),
        content_type: 'application/json',
      };
    }));
    const result = await store.importRecords(env, 'genepedia', records);
    assert.equal(result.imported, records.length);
    assert.equal(individualDocumentReads, 0);
  } finally {
    env.DB.prepare = originalPrepare;
  }
});

await check('first-version imports use bounded bulk D1 statements and populate search indexes', async () => {
  const originalBatch = env.DB.batch;
  let batchStatementCount = 0;
  env.DB.batch = async function (statements) {
    batchStatementCount = statements.length;
    return originalBatch.call(this, statements);
  };
  try {
    const records = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      const content = JSON.stringify({ id: `bulk-${index}`, names: { display: `Bulk Person ${index}` } });
      return {
        namespace: 'data',
        path: `people/persons/0/bulk-${index}.json`,
        content,
        sha256: await hash(content),
        content_type: 'application/json',
      };
    }));
    const result = await store.importRecords(env, 'genepedia', records);
    assert.equal(result.imported, 50);
    assert.ok(batchStatementCount <= 40, `expected bounded bulk statements, got ${batchStatementCount}`);
    const docs = await env.DB.prepare("SELECT COUNT(*) AS n FROM native_documents WHERE site='genepedia' AND path LIKE 'people/persons/0/bulk-%'").first();
    const revisions = await env.DB.prepare("SELECT COUNT(*) AS n FROM native_document_revisions WHERE site='genepedia' AND path LIKE 'people/persons/0/bulk-%'").first();
    const index = await env.DB.prepare("SELECT COUNT(*) AS n FROM native_people_index WHERE site='genepedia' AND person_id LIKE 'bulk-%'").first();
    const fts = await env.DB.prepare("SELECT COUNT(*) AS n FROM native_people_fts WHERE site='genepedia' AND person_id LIKE 'bulk-%'").first();
    assert.equal(Number(docs.n), 50);
    assert.equal(Number(revisions.n), 50);
    assert.equal(Number(index.n), 50);
    assert.equal(Number(fts.n), 50);
  } finally {
    env.DB.batch = originalBatch;
  }
});

await check('small UTF-8 content stays inline while content above 64 KiB uses R2', async () => {
  const small = 'a'.repeat(64 * 1024);
  const large = 'b'.repeat(64 * 1024 + 1);
  await store.importRecords(env, 'genepedia', [
    { namespace: 'content', path: 'pages/inline-threshold.html', content: small },
    { namespace: 'content', path: 'pages/r2-threshold.html', content: large },
  ]);
  const inline = await env.DB.prepare("SELECT content, blob_key FROM native_documents WHERE site='genepedia' AND namespace='content' AND path='pages/inline-threshold.html'").first();
  const blobbed = await env.DB.prepare("SELECT content, blob_key FROM native_documents WHERE site='genepedia' AND namespace='content' AND path='pages/r2-threshold.html'").first();
  assert.equal(inline.content, small);
  assert.equal(inline.blob_key, null);
  assert.equal(blobbed.content, null);
  assert.ok(blobbed.blob_key);
  assert.equal((await store.get(env, 'genepedia', 'content', 'pages/r2-threshold.html')).content, large);
});

await check('storage paths reject traversal before any write', async () => {
  for (const path of ['../secret', 'a/../b', '/absolute', 'a\\b', 'a//b']) {
    await assert.rejects(store.apply(env, { site: 'genepedia', actor, files: [file(path, {})] }), (error) => error.status === 400);
  }
});

await check('same person and pet ID remain separate in indexed search', async () => {
  await store.apply(env, { site: 'genepedia', actor, files: [
    file('people/persons/0/7.json', { id: 7, names: { display: 'Orchid Human', given: 'Orchid', surname: 'Human' } }),
    file('pets/persons/0/7.json', { id: 7, names: { display: 'Orchid Pet', given: 'Orchid', surname: 'Pet' } }),
  ] });
  const result = await store.searchPeople(env, 'genepedia', 'Orchid', { limit: 20 });
  assert.equal(result.total, 2);
  assert.deepEqual(new Set(result.results.map((row) => row.kind)), new Set(['person', 'pet']));
});

await check('stale multi-file writes roll back every document, revision, and search index', async () => {
  await store.apply(env, { site: 'genepedia', actor, files: [file('integrity/a.json', { value: 'old-a' }), file('integrity/b.json', { value: 'old-b' })] });
  await store.apply(env, { site: 'genepedia', actor, files: [file('integrity/a.json', { value: 'new-a' }, 'data', 1)] });
  await assert.rejects(store.apply(env, { site: 'genepedia', actor, files: [file('integrity/a.json', { value: 'stale-a' }, 'data', 1), file('integrity/b.json', { value: 'stale-b' }, 'data', 1)] }), (error) => error.status === 409);
  assert.equal(JSON.parse((await store.get(env, 'genepedia', 'data', 'integrity/a.json')).content).value, 'new-a');
  assert.equal(JSON.parse((await store.get(env, 'genepedia', 'data', 'integrity/b.json')).content).value, 'old-b');
});

await check('successful write retries are idempotent even after their expected version becomes stale', async () => {
  const input = { site: 'genepedia', actor, idempotencyKey: 'test-write-retry', files: [file('integrity/idempotent.json', { value: 1 }, 'data', 0)] };
  const first = await store.apply(env, input);
  assert.deepEqual(await store.apply(env, input), first);
  assert.equal((await store.get(env, 'genepedia', 'data', 'integrity/idempotent.json')).version, 1);
  await assert.rejects(store.apply(env, { ...input, files: [file('integrity/idempotent.json', { value: 2 }, 'data', 0)] }), (error) => error.status === 409);
});

await check('stable idempotency requests replay generated writes and reject changed intent', async () => {
  const input = {
    site: 'genepedia', actor, idempotencyKey: 'test-stable-request',
    idempotencyRequest: { action: 'create-contact', message: 'same intent' },
    files: [file('integrity/stable-request.json', { generated_id: 'first', created_at: 'first-time' })],
  };
  const first = await store.apply(env, input);
  const replay = await store.apply(env, {
    ...input,
    idempotencyRequest: { message: 'same intent', action: 'create-contact' },
    files: [file('integrity/stable-request.json', { generated_id: 'second', created_at: 'later-time' })],
  });
  assert.deepEqual(replay, first);
  assert.deepEqual(await store.lookupIdempotency(env, 'genepedia', actor, 'test-stable-request', {
    operation: 'apply', idempotencyRequest: { action: 'create-contact', message: 'same intent' },
  }), first);
  await assert.rejects(store.lookupIdempotency(env, 'genepedia', actor, 'test-stable-request', {
    operation: 'apply', idempotencyRequest: { action: 'create-contact', message: 'different' },
  }), (error) => error.status === 409 && error.code === 'idempotency_conflict');
  assert.equal((await store.get(env, 'genepedia', 'data', 'integrity/stable-request.json')).version, 1);
  await assert.rejects(store.apply(env, {
    ...input,
    idempotencyRequest: { action: 'create-contact', message: 'changed intent' },
    files: [file('integrity/stable-request.json', { generated_id: 'third' })],
  }), (error) => error.status === 409 && error.code === 'idempotency_conflict');
  const staged = await store.submit(env, {
    site: 'genepedia', actor, idempotencyKey: 'test-stable-submit',
    idempotencyRequest: { action: 'talk-create', message: 'hello' },
    title: 'Generated title', body: 'Generated body',
    files: [file('integrity/stable-submit.json', { generated_id: 'first' })],
  });
  const stagedReplay = await store.lookupIdempotency(env, 'genepedia', actor, 'test-stable-submit', {
    operation: 'submit', idempotencyRequest: { message: 'hello', action: 'talk-create' },
  });
  assert.equal(stagedReplay.number, staged.number);
  assert.equal(stagedReplay.state, 'open');
});

await check('concurrent multi-file commits choose one complete winner without mixing versions', async () => {
  await store.apply(env, { site: 'genepedia', actor, files: [file('race/a.json', { winner: 'base' }), file('race/b.json', { winner: 'base' })] });
  const results = await Promise.allSettled(['one', 'two'].map((winner) => store.apply(env, {
    site: 'genepedia', actor, files: [file('race/a.json', { winner }, 'data', 1), file('race/b.json', { winner }, 'data', 1)],
  })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1);
  const a = JSON.parse((await store.get(env, 'genepedia', 'data', 'race/a.json')).content);
  const b = JSON.parse((await store.get(env, 'genepedia', 'data', 'race/b.json')).content);
  assert.equal(a.winner, b.winner);
});

await check('review submissions stay unpublished and only the configured reviewer can approve', async () => {
  const input = { site: 'genepedia', actor, idempotencyKey: 'test-review-submit', title: 'Review fixture', files: [file('integrity/review.json', { approved: true })] };
  const change = await store.submit(env, input);
  assert.equal(change.html_url, `https://www.genepedia.org/pages/review_edits.html?number=${change.number}`);
  assert.equal((await store.submit(env, input)).number, change.number);
  assert.equal(await store.get(env, 'genepedia', 'data', 'integrity/review.json'), null);
  await assert.rejects(store.reviewChange(env, 'genepedia', change.number, actor, 'approve'), (error) => error.status === 403);
  const approved = await store.reviewChange(env, 'genepedia', change.number, reviewer, 'approve');
  assert.equal(approved.merged, true);
  assert.equal(JSON.parse((await store.get(env, 'genepedia', 'data', 'integrity/review.json')).content).approved, true);
  assert.equal((await store.reviewChange(env, 'genepedia', change.number, reviewer, 'approve')).merged, true);
});

await check('path reservations reject competing writes and stale approvals preserve a newer restored version', async () => {
  const pending = await store.submit(env, { site: 'genepedia', actor, title: 'Pending edit', files: [file('integrity/review.json', { value: 'stale' }, 'data', 1)] });
  await assert.rejects(store.apply(env, { site: 'genepedia', actor: reviewer, files: [file('integrity/review.json', { value: 'one' }, 'data', 1)] }), (error) => error.status === 409);
  // Simulate a restore outside the request path so the final transactional
  // version guard is tested even when the ordinary path reservation is intact.
  const newer = JSON.stringify({ value: 'one' });
  env.DB.sqlite.prepare("UPDATE native_documents SET content=?,version=version+1,sha256=?,byte_size=? WHERE site='genepedia' AND namespace='data' AND path='integrity/review.json'").run(newer, await hash(newer), Buffer.byteLength(newer));
  await assert.rejects(store.reviewChange(env, 'genepedia', pending.number, reviewer, 'approve'), (error) => error.status === 409);
  assert.equal(JSON.parse((await store.get(env, 'genepedia', 'data', 'integrity/review.json')).content).value, 'one');
  assert.equal((await store.getChange(env, 'genepedia', pending.number)).state, 'open');
});

await check('R2 bytes survive import without corruption and missing objects fail closed', async () => {
  const bytes = Buffer.from([0, 255, 17, 128, 42]);
  await store.importRecords(env, 'genepedia', [{ namespace: 'media', path: 'people/7/test.png', content_base64: bytes.toString('base64'), sha256: await hash(bytes), content_type: 'image/png' }]);
  const media = await store.get(env, 'genepedia', 'media', 'people/7/test.png');
  assert.deepEqual(Buffer.from(media.bytes), bytes);
  const bomJson = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"id":"bom"}\n')]);
  await store.importRecords(env, 'genepedia', [{ namespace: 'data', path: 'integrity/bom.json', content_base64: bomJson.toString('base64'), sha256: await hash(bomJson), content_type: 'application/json' }]);
  const bomDocument = await store.get(env, 'genepedia', 'data', 'integrity/bom.json');
  assert.deepEqual(Buffer.from(bomDocument.bytes), bomJson);
  assert.equal(bomDocument.sha256, await hash(bomJson));
  assert.equal(JSON.parse(bomDocument.content).id, 'bom');
  const svgBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')]);
  await store.importRecords(env, 'genepedia', [{ namespace: 'media', path: 'people/7/bom.svg', content_base64: svgBom.toString('base64'), sha256: await hash(svgBom), content_type: 'image/svg+xml' }]);
  const response = await http.handle(new Request('https://api.genepedia.org/v1/genepedia/media?path=people%2F7%2Fbom.svg'), env, 'genepedia', 'media');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), svgBom);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Content-Security-Policy') || '', /sandbox/);
  env.BUCKET.objects.clear();
  await assert.rejects(store.get(env, 'genepedia', 'media', 'people/7/test.png'), (error) => error.status >= 500);
});

await check('statistics events are idempotent, aggregate by rollup, and preserve partial-hour windows', async () => {
  const profileEvent = { id: 'stat-profile-1', site: 'genepedia', event_type: 'profile_view', person_id: '42', kind: 'pet', created_at: '2026-10-23T12:34:56.000Z' };
  const searchEvent = { id: 'stat-search-1', site: 'genepedia', event_type: 'search', query: 'cedar', result_count: 4, created_at: '2026-10-23T12:36:00.000Z' };
  const outsideEvent = { id: 'stat-outside-1', site: 'genepedia', event_type: 'search', query: 'outside', result_count: 8, created_at: '2026-10-23T13:02:00.000Z' };
  assert.equal((await store.recordStatistic(env, profileEvent)).inserted, true);
  assert.equal((await store.recordStatistic(env, { ...profileEvent, created_at: '2026-10-23T12:40:00.000Z' })).inserted, false);
  await assert.rejects(store.recordStatistic(env, { ...profileEvent, person_id: 'different' }), (error) => error.status === 409 && error.code === 'idempotency_conflict');
  await store.recordStatistic(env, searchEvent);
  await store.recordStatistic(env, outsideEvent);
  const aggregate = await store.aggregateStatistics(env, { site: 'genepedia', since: '2026-10-23T12:34:57.000Z', until: '2026-10-23T13:00:00.000Z' });
  assert.equal(aggregate.total, 1);
  assert.equal(aggregate.by_query[0].query, 'cedar');
  assert.equal(aggregate.by_query[0].last_result_count, 4);
  const totals = await store.statisticsTotals(env, { site: 'genepedia' });
  assert.equal(totals.by_event_type.find((row) => row.event_type === 'search').count, 2);
});

await check('legacy statistics drain copies and acknowledges source rows atomically and repeatably', async () => {
  env.DB.sqlite.prepare('INSERT INTO statistics_events (event_id, payload, created_at) VALUES (?, ?, ?)').run(
    'legacy-stat-profile', JSON.stringify({ event: 'profile_view', person_id: '900', kind: 'person' }), '2026-10-20T11:22:00Z');
  env.DB.sqlite.prepare('INSERT INTO statistics_events (event_id, payload, created_at) VALUES (?, ?, ?)').run(
    'legacy-stat-search', JSON.stringify({ event: 'search', query: 'red oak', result_count: 9 }), '2026-10-20T12:22:00Z');
  const drained = await store.drainLegacyStatistics(env, 'genepedia');
  assert.equal(drained.copied, 2);
  assert.equal(drained.acknowledged, 2);
  assert.equal(drained.pending, 0);
  assert.equal((await store.drainLegacyStatistics(env, 'genepedia')).copied, 0);
  const aggregate = await store.aggregateStatistics(env, { site: 'genepedia' });
  assert.equal(aggregate.by_person.find((row) => row.person_id === '900').kind, 'person');
  assert.equal(aggregate.by_query.find((row) => row.query === 'red oak').last_result_count, 9);
});

await check('data JSON is validated and directory prefixes can include a trailing slash', async () => {
  await assert.rejects(store.apply(env, { site: 'genepedia', actor, files: [file('integrity/invalid.json', '{invalid')] }), (error) => error.status === 400 && error.code === 'invalid_content');
  await store.apply(env, { site: 'genepedia', actor, files: [file('memorials/folder/record.json', { id: 'record' })] });
  const page = await store.list(env, 'genepedia', 'data', { prefix: 'memorials/folder/' });
  assert.equal(page.documents.length, 1);
  assert.equal(page.documents[0].path, 'memorials/folder/record.json');
  const first = await store.storageManifest(env, 'genepedia', { limit: 1 });
  assert.equal(first.manifest.length, 1);
  assert.ok(first.next_cursor);
  const second = await store.storageManifest(env, 'genepedia', { limit: 1, after: first.next_cursor });
  assert.equal(second.manifest.length, 1);
  assert.notEqual(second.manifest[0].path, first.manifest[0].path);
  const mismatchNamespace = first.manifest[0].namespace === 'data' ? 'media' : 'data';
  await assert.rejects(store.storageManifest(env, 'genepedia', { namespace: mismatchNamespace, after: first.next_cursor }), (error) => error.status === 400 && error.code === 'invalid_cursor');
});

assert.equal(env.DB.sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
console.log(`Native storage: ${passed} checks passed with real SQLite transactions and an R2 byte fixture.`);
