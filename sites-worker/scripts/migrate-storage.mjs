import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const option = (name, fallback = '') => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const sourceRoot = path.resolve(option('--source'));
const receiptPath = path.resolve(option('--receipt', path.join(sourceRoot, 'migration-receipts.json')));
const apiOrigin = option('--api', 'https://api.genepedia.org');
const planOnly = argv.includes('--plan');
const verifyOnly = argv.includes('--verify');
const updateContent = argv.includes('--update-content');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mime = (name) => ({ '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ged': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.css': 'text/css', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(name).toLowerCase()] || 'application/octet-stream');

async function filesIn(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function makePlan() {
  const records = [];
  const keys = new Set();
  const add = async (site, namespace, root, file, prefix = '') => {
    const relative = prefix + path.relative(root, file).split(path.sep).join('/');
    const key = `${site}:${namespace}:${relative}`;
    if (keys.has(key)) throw new Error(`Duplicate migration path: ${key}`);
    const bytes = await readFile(file);
    if (namespace === 'data') JSON.parse(bytes.toString('utf8'));
    records.push({ site, namespace, path: relative, source: file, bytes: bytes.length, sha256: digest(bytes), content_type: mime(file) });
    keys.add(key);
  };
  const databaseRoot = path.join(sourceRoot, 'Genepedia-Database');
  for (const file of await filesIn(databaseRoot)) {
    if (file.endsWith('.json')) await add('genepedia', 'data', databaseRoot, file);
  }
  for (const site of ['genepedia', 'gravepedia']) {
    const repo = site === 'genepedia' ? 'Genepedia' : 'Gravepedia';
    const repoRoot = path.resolve(option(`--content-${site}`, path.join(sourceRoot, repo)));
    for (const file of await filesIn(path.join(repoRoot, 'pages'))) await add(site, 'content', repoRoot, file);
    for (const directory of ['assets', 'components', 'lib']) {
      for (const file of await filesIn(path.join(repoRoot, directory)).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))) await add(site, 'content', repoRoot, file);
    }
    const originalRoot = path.join(sourceRoot, repo);
    const dataRoot = path.join(originalRoot, 'data');
    const dataFiles = await filesIn(dataRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const file of dataFiles) {
      const relative = path.relative(dataRoot, file).split(path.sep).join('/');
      if (/^Genepedia-(?:Database|Media)\//.test(relative)) continue;
      if (site === 'gravepedia' && /^memorials\/.+\.json$/.test(relative)) await add(site, 'data', dataRoot, file);
      else await add(site, 'content', originalRoot, file);
    }
    const mediaRoot = path.join(sourceRoot, `${repo}-Media`);
    for (const file of await filesIn(mediaRoot)) {
      if (!/\.md$/i.test(file)) await add(site, 'media', mediaRoot, file);
    }
    for (const name of ['index.html', '404.html', 'sitemap.xml', 'site-info.js', 'index.js', 'index.css', 'robots.txt', 'favicon.ico']) {
      const file = path.join(repoRoot, name);
      try { await add(site, 'content', repoRoot, file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const site of ['genepedia', 'gravepedia']) {
    const extraRoot = path.join(sourceRoot, 'extra', site);
    for (const file of await filesIn(extraRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))) await add(site, 'data', extraRoot, file);
  }
  return records.sort((a, b) => `${a.site}:${a.namespace}:${a.path}`.localeCompare(`${b.site}:${b.namespace}:${b.path}`));
}

async function readSecretConfig() {
  process.stdout.write('Ready for migration credentials on stdin (input is hidden).\n');
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  try {
    return await new Promise((resolve, reject) => {
      let text = '';
      const onData = (chunk) => {
        text += chunk;
        if (!text.includes('\n')) return;
        process.stdin.off('data', onData);
        process.stdin.pause();
        try { resolve(JSON.parse(text.slice(0, text.indexOf('\n')))); }
        catch { reject(new Error('Invalid migration credential input.')); }
      };
      process.stdin.on('data', onData);
      process.stdin.on('error', reject);
      process.stdin.resume();
    });
  } finally { if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw)); }
}

const records = await makePlan();
const summary = {};
for (const record of records) {
  const key = `${record.site}:${record.namespace}`;
  summary[key] ??= { files: 0, bytes: 0 };
  summary[key].files += 1;
  summary[key].bytes += record.bytes;
}
await writeFile(path.join(sourceRoot, 'import-manifest.json'), JSON.stringify({ created_at: new Date().toISOString(), summary, records }, null, 2));
console.log(JSON.stringify({ event: 'plan', summary, total: records.length }));
if (planOnly) process.exit(0);
const { token } = await readSecretConfig();
if (!token || typeof token !== 'string') throw new Error('A migration token is required.');

async function call(site, suffix, payload) {
  const response = await fetch(`${apiOrigin}/v1/${site}/storage/${suffix}`, {
    method: payload ? 'POST' : 'GET',
    headers: { 'X-Storage-Migration-Token': token, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok === false) throw new Error(`Storage ${suffix.split('?')[0]} failed (${response.status}): ${result?.error || 'invalid_response'}`);
  return result;
}

let receipt = { started_at: new Date().toISOString(), summary, batches: [], completed: false };
try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); } catch {}
if (!verifyOnly) {
  receipt.completed = false;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  let batch = [];
  let encodedBytes = 0;
  let completedFiles = 0;
  const inFlight = new Set();
  let receiptWrites = Promise.resolve();
  const priorVersions = new Map(receipt.batches.flatMap((batch) => (batch.result?.records || []).map((record) => [`${batch.site}:${record.namespace}:${record.path}`, record])));
  const alreadyImported = new Set(receipt.batches.flatMap((batch) => (batch.result?.records || []).map((record) => `${batch.site}:${record.namespace}:${record.path}:${record.sha256}`)));
  const uploadBatch = async (batch) => {
    const site = batch[0].site;
    const payload = [];
    for (const record of batch) {
      const bytes = await readFile(record.source);
      if (digest(bytes) !== record.sha256) throw new Error('Migration source changed after the manifest was generated.');
      const entry = { namespace: record.namespace, path: record.path, content_type: record.content_type, sha256: record.sha256 };
      const prior = priorVersions.get(`${record.site}:${record.namespace}:${record.path}`);
      if (updateContent && record.namespace === 'content' && prior && prior.sha256 !== record.sha256) entry.expected_version = prior.version;
      if (record.namespace === 'data') entry.content = bytes.toString('utf8');
      else entry.content_base64 = bytes.toString('base64');
      payload.push(entry);
    }
    const result = await call(site, 'import', { records: payload });
    completedFiles += batch.length;
    receipt.batches.push({ site, files: batch.length, result, finished_at: new Date().toISOString() });
    receiptWrites = receiptWrites.then(() => writeFile(receiptPath, JSON.stringify(receipt, null, 2)));
    await receiptWrites;
    console.log(JSON.stringify({ event: 'import', site, completed: completedFiles, total: records.length }));
  };
  const upload = async () => {
    if (!batch.length) return;
    const selected = batch; batch = []; encodedBytes = 0;
    const job = uploadBatch(selected); inFlight.add(job);
    job.then(() => inFlight.delete(job), () => {});
    if (inFlight.size >= 4) await Promise.race(inFlight);
  };
  for (const record of records) {
    if (alreadyImported.has(`${record.site}:${record.namespace}:${record.path}:${record.sha256}`)) { completedFiles++; continue; }
    const size = record.namespace === 'data' ? record.bytes * 1.3 : Math.ceil(record.bytes * 4 / 3);
    if (size > 3_800_000) {
      await upload();
      if (record.bytes > 12_000_000) throw new Error(`File exceeds the bounded raw import size: ${record.site}:${record.namespace}:${record.path}`);
      await Promise.all(inFlight);
      const bytes = await readFile(record.source);
      if (digest(bytes) !== record.sha256) throw new Error('Migration source changed after planning.');
      const query = new URLSearchParams({ namespace: record.namespace, path: record.path, sha256: record.sha256 });
      const response = await fetch(`${apiOrigin}/v1/${record.site}/storage/import-file?${query}`, {
        method: 'POST', headers: { 'X-Storage-Migration-Token': token, 'Content-Type': record.content_type },
        body: bytes, signal: AbortSignal.timeout(90_000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok === false) throw new Error(`Raw storage import failed (${response.status}): ${result?.error || 'invalid_response'}`);
      completedFiles += 1;
      receipt.batches.push({ site: record.site, files: 1, result, finished_at: new Date().toISOString() });
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
      console.log(JSON.stringify({ event: 'import', site: record.site, completed: completedFiles, total: records.length }));
      continue;
    }
    if (batch.length && (batch[0].site !== record.site || batch.length >= 40 || encodedBytes + size > 3_500_000)) await upload();
    batch.push(record);
    encodedBytes += size;
  }
  await upload();
  await Promise.all(inFlight);
  await receiptWrites;
}

const expected = new Map(records.map((r) => [`${r.site}:${r.namespace}:${r.path}`, r]));
const seen = new Set();
for (const site of ['genepedia', 'gravepedia']) {
  let after = '';
  for (;;) {
    const result = await call(site, `status?manifest=1&limit=500${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    const manifest = result.manifest || result.documents || result.records;
    if (!Array.isArray(manifest)) throw new Error('Storage status did not provide a checksum manifest.');
    for (const item of manifest) {
      const key = `${site}:${item.namespace}:${item.path}`;
      const original = expected.get(key);
      if (original) {
        if (original.sha256 !== (item.sha256 || item.sha)) throw new Error(`Destination checksum mismatch: ${key}`);
        seen.add(key);
      }
    }
    const next = result.next_cursor || result.next_after || result.next;
    if (!next) break;
    if (next === after) throw new Error('Storage manifest pagination did not advance.');
    after = next;
  }
}
if (seen.size !== expected.size) throw new Error(`Destination verification is incomplete: ${seen.size}/${expected.size} files verified.`);
receipt.completed = true;
receipt.verified_files = seen.size;
receipt.finished_at = new Date().toISOString();
await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ event: 'verified', files: seen.size, summary }));
