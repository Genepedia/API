import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../dist/server/index.js';
import { createD1, MemoryBucket } from './native-test-runtime.mjs';

const env = { DB: await createD1(), BUCKET: new MemoryBucket(), STORAGE_BACKEND: 'sites', STORAGE_MIGRATION_TOKEN: 'test-import-secret', GITHUB_REVIEW_LOGIN: 'reviewer' };
const upstream = globalThis.fetch;
let identityReads = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  assert.equal(url.origin + url.pathname, 'https://api.github.com/user', 'native data operations must never use a GitHub repository API');
  identityReads += 1;
  const token = new Headers(init.headers).get('Authorization')?.replace('Bearer ', '') || 'writer';
  return Response.json({ id: token === 'reviewer' ? 1 : 2, login: token, name: token });
};
let passed = 0;
async function check(label, run) { await run(); passed++; console.log(`Passed: ${label}`); }
async function call(site, route, { user, body, headers = {}, method = body ? 'POST' : 'GET', status = 200 } = {}) {
  const response = await worker.fetch(new Request(`https://api.genepedia.org/v1/${site}/${route}`, { method, headers: { Origin: `https://www.${site}.org`, ...(user ? { Authorization: `Bearer ${user}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
  const text = await response.text();
  assert.equal(response.status, status, `${route}: ${text.slice(0, 1000)}`);
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { data, response };
}
const importRows = async (site, records) => call(site, 'storage/import', { headers: { 'X-Storage-Migration-Token': env.STORAGE_MIGRATION_TOKEN }, body: { records } });
const record = (namespace, path, content, content_type = 'application/json') => ({ namespace, path, content, content_type });
try {
  await check('native imports are protected and public reads retain versions, ETags and isolation', async () => {
    await call('genepedia', 'storage/status', { status: 401 });
    await importRows('genepedia', [record('data', 'people/persons/0/17.json', '{"id":17,"names":{"display":"Amina Test"}}'), record('data', 'people/ownership/0/17.json', '{"owner":{"githubLogin":"writer"},"maintainers":[{"githubLogin":"manager"}]}'), record('content', 'pages/about.html', '<h1>Original</h1>', 'text/html'), record('data', 'support/contacts/test.json', '{"email":"private@example.org"}')]);
    const { data, response } = await call('genepedia', 'data?path=people/persons/0/17.json');
    assert.equal(data.id, 17);
    assert.equal(response.headers.get('X-Document-Version'), '1');
    assert.ok(response.headers.get('ETag'));
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://www.genepedia.org');
    await call('genepedia', 'data?path=support/contacts/test.json', { status: 400 });
    await call('gravepedia', 'content?path=pages/about.html', { status: 404 });
    const search = await call('genepedia', 'search/people?q=Amina');
    assert.equal(search.data.total, 1);
  });
  await check('private support documents are not readable through public revision history', async () => {
    await call('genepedia', 'files/commits?path=data/Genepedia-Database/support/contacts/test.json', { status: 400 });
    await call('genepedia', 'files/commit-diff?path=data/Genepedia-Database/support/contacts/test.json&hash=' + 'a'.repeat(40), { status: 400 });
  });
  await check('updates to existing files require a client version precondition', async () => {
    await call('genepedia', 'page-edits', {
      user: 'writer',
      body: { files: [{ path: 'pages/about.html', content: '<h1>Stale update</h1>' }] },
      status: 428,
    });
  });
  let number;
  await check('page edits stay unpublished, replay safely, and only the reviewer can approve', async () => {
    await call('genepedia', 'page-edits', { body: { path: 'pages/about.html', content: 'bad' }, status: 401 });
    const edit = { files: [{ path: 'pages/about.html', content: '<h1>Approved</h1>', expected_version: 1 }] };
    const submitted = await call('genepedia', 'page-edits', { user: 'writer', body: edit, headers: { 'Idempotency-Key': 'http-edit-1' }, status: 201 });
    number = submitted.data.pull_request.number;
    assert.ok(submitted.data.pull_request.url.includes('/pages/review_edits.html?number='));
    const retry = await call('genepedia', 'page-edits', { user: 'writer', body: edit, headers: { 'Idempotency-Key': 'http-edit-1' }, status: 201 });
    assert.equal(retry.data.pull_request.number, number);
    assert.equal((await call('genepedia', 'content?path=pages/about.html')).data, '<h1>Original</h1>');
    await call('genepedia', `pull-requests?number=${number}`, { user: 'stranger', status: 403 });
    const detail = await call('genepedia', `pull-requests?number=${number}`, { user: 'reviewer' });
    assert.equal(detail.data.diffs[0].before, '<h1>Original</h1>');
    assert.equal(detail.data.diffs[0].after, '<h1>Approved</h1>');
    await call('genepedia', 'pull-requests/review', { user: 'writer', body: { number, action: 'approve' }, status: 403 });
    await call('genepedia', 'pull-requests/review', { user: 'reviewer', body: { number, action: 'approve' } });
    assert.equal((await call('genepedia', 'content?path=pages/about.html')).data, '<h1>Approved</h1>');
    await call('genepedia', 'page-edits', { user: 'writer', body: edit, status: 409 });
  });
  await check('native revision history returns both sides of the approved edit', async () => {
    const history = await call('genepedia', 'files/commits?path=pages/about.html');
    assert.ok(history.data.commits.length >= 2);
    const diff = await call('genepedia', `files/commit-diff?path=pages/about.html&hash=${history.data.commits[0].sha}`);
    assert.equal(diff.data.diff.before, '<h1>Original</h1>');
    assert.equal(diff.data.diff.after, '<h1>Approved</h1>');
  });
  await check('media authorisation and review cannot cross profile or file scopes', async () => {
    await call('genepedia', 'profiles/media', { user: 'stranger', body: { person_id: '17', action: 'upload', filename: 'test.png', content_base64: 'AAECAw==' }, status: 403 });
    const media = await call('genepedia', 'profiles/media', { user: 'writer', body: { person_id: '17', action: 'upload', filename: 'test.png', content_base64: 'AAECAw==' }, status: 201 });
    const mediaNumber = media.data.pull_request.number;
    const previewPath = 'pages/people/17/test.png';
    const previewQuery = `profiles/media/preview?number=${mediaNumber}&path=${encodeURIComponent(previewPath)}`;
    await call('genepedia', previewQuery, { status: 401 });
    await call('genepedia', previewQuery, { user: 'stranger', status: 403 });
    await call('genepedia', `profiles/media/preview?number=${mediaNumber}&path=${encodeURIComponent('pages/people/18/test.png')}`, { user: 'writer', status: 404 });
    const pending = await call('genepedia', 'profiles/media?person=17', { user: 'writer' });
    assert.equal(pending.data.pending[0].preview_url, `https://api.genepedia.org/v1/genepedia/${previewQuery}`);
    const detail = await call('genepedia', `pull-requests?number=${mediaNumber}`, { user: 'writer' });
    assert.equal(detail.data.diffs[0].preview_url, `https://api.genepedia.org/v1/genepedia/${previewQuery}`);
    const fetchPreview = async (user) => worker.fetch(new Request(`https://api.genepedia.org/v1/genepedia/${previewQuery}`, {
      headers: { Origin: 'https://www.genepedia.org', Authorization: `Bearer ${user}` },
    }), env);
    const preview = await fetchPreview('writer');
    assert.equal(preview.status, 200);
    assert.deepEqual([...new Uint8Array(await preview.arrayBuffer())], [0, 1, 2, 3]);
    assert.equal(preview.headers.get('Access-Control-Allow-Origin'), 'https://www.genepedia.org');
    assert.match(preview.headers.get('Cache-Control'), /no-store/);
    assert.equal(preview.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(preview.headers.get('Content-Security-Policy'), /sandbox/);
    const managerPreview = await fetchPreview('manager');
    assert.equal(managerPreview.status, 200);
    assert.deepEqual([...new Uint8Array(await managerPreview.arrayBuffer())], [0, 1, 2, 3]);
    const reviewerPreview = await fetchPreview('reviewer');
    assert.equal(reviewerPreview.status, 200);
    assert.deepEqual([...new Uint8Array(await reviewerPreview.arrayBuffer())], [0, 1, 2, 3]);
    await call('genepedia', 'profiles/media', { user: 'reviewer', body: { person_id: '18', action: 'approve', number: mediaNumber }, status: 400 });
    await call('genepedia', 'profiles/media', { user: 'reviewer', body: { person_id: '17', action: 'approve', number: mediaNumber } });
    const response = await worker.fetch(new Request('https://api.genepedia.org/v1/genepedia/media?path=pages/people/17/test.png'), env);
    assert.equal(response.status, 200);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1, 2, 3]);
  });
  await check('separate profile creates do not reserve or overwrite the shared generated catalog', async () => {
    const createProfile = (id, name) => {
      const bucket = Math.floor((Number(id) - 1) / 1000);
      return {
        action: 'create', person_id: id, claim_self: false,
        files: [
          { path: `pages/people/${id}/index.html`, content: `<html><body><h1>${name}</h1></body></html>` },
          { path: `pages/people/${id}/profile.html`, content: `<p>${name}</p>` },
          { path: `data/Genepedia-Database/people/persons/${bucket}/${id}.json`, content: JSON.stringify({ id: Number(id), names: { given: name, display: name } }) },
          { path: `data/Genepedia-Database/people/ownership/${bucket}/${id}.json`, content: '{}' },
          // This is intentionally a stale client snapshot. The server derives
          // catalogs from approved records and must not stage/reserve it.
          { path: 'pages/people/people.json', content: JSON.stringify({ people: [{ id: Number(id), displayName: name }] }) },
        ],
      };
    };
    const first = await call('genepedia', 'profiles/self', { user: 'writer', body: createProfile('71001', 'First') , status: 201 });
    const second = await call('genepedia', 'profiles/self', { user: 'writer', body: createProfile('72001', 'Second'), status: 201 });
    assert.notEqual(first.data.pull_request.number, second.data.pull_request.number);
    for (const number of [first.data.pull_request.number, second.data.pull_request.number]) {
      const detail = await call('genepedia', `pull-requests?number=${number}`, { user: 'writer' });
      assert.ok(detail.data.diffs.every((diff) => diff.path !== 'pages/people/people.json'));
    }
    await call('genepedia', 'pull-requests/review', { user: 'reviewer', body: { number: first.data.pull_request.number, action: 'approve' } });
    let catalog = await call('genepedia', 'content?path=pages/people/people.json');
    assert.ok(catalog.data.people.some((person) => String(person.id) === '71001'));
    assert.ok(!catalog.data.people.some((person) => String(person.id) === '72001'));
    await call('genepedia', 'pull-requests/review', { user: 'reviewer', body: { number: second.data.pull_request.number, action: 'approve' } });
    catalog = await call('genepedia', 'content?path=pages/people/people.json');
    assert.ok(catalog.data.people.some((person) => String(person.id) === '71001'));
    assert.ok(catalog.data.people.some((person) => String(person.id) === '72001'));
  });
  await check('memorial submissions preserve plain-text source citations', async () => {
    const citation = 'Cemetery register volume 3, page 42; photographed 2026-10-23.';
    const submitted = await call('gravepedia', 'memorials', { user: 'writer', body: { name: 'Citation fixture', cemetery: 'Test cemetery', source: citation }, status: 201 });
    const number = new URL(submitted.data.pull_request).searchParams.get('number');
    const detail = await call('gravepedia', `pull-requests?number=${number}`, { user: 'reviewer' });
    assert.equal(JSON.parse(detail.data.diffs[0].after).source, citation);
  });
  await check('both sites reject wrong methods, traversal, foreign origins and PHP routes', async () => {
    for (const site of ['genepedia', 'gravepedia']) {
      await call(site, 'data?path=../secret', { status: 400 });
      await call(site, 'page-edits', { status: 405 });
      await call(site, 'github-login.php', { status: 404 });
      await call(site, 'page-edits', { user: 'writer', headers: { Origin: 'https://untrusted.example' }, body: { path: 'pages/about.html', content: 'bad' }, status: 403 });
      const preflight = await call(site, 'page-edits', { method: 'OPTIONS', status: 204 });
      assert.ok(preflight.response.headers.get('Access-Control-Allow-Headers').includes('Idempotency-Key'));
    }
  });
  assert.ok(identityReads > 0);
  assert.equal((await env.DB.prepare('PRAGMA integrity_check').first()).integrity_check, 'ok');
  console.log(`Native HTTP validation passed: ${passed} checks; no GitHub repository requests`);
} finally { globalThis.fetch = upstream; }
