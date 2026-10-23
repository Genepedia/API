export function createNativeHttp(h, store) {
  const fail = (status, code, message) => { throw new h.ApiError(status, code, message); };
  const siteUrl = (site) => `https://www.${site}.org`;
  const reviewUrl = (site, number) => `${siteUrl(site)}/pages/review_edits.html?number=${number}`;
  const publicRepo = (site) => `${site}/storage`;
  const json = (request, env, body, status = 200, headers = {}) => h.jsonResponse(request, env, body, status, headers);
  const safe = (input) => {
    const value = String(input || '').replace(/^\/+/, '');
    if (!value || value.length > 500 || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..' || part.trim() !== part)) fail(400, 'invalid_path', 'A valid storage path is required.');
    return value;
  };
  const login = (user) => String(user?.login || '').toLowerCase();
  const isReviewer = (env, user) => Boolean(env.GITHUB_REVIEW_LOGIN && login(user) === String(env.GITHUB_REVIEW_LOGIN).toLowerCase());
  const parsed = (doc) => {
    if (!doc) return null;
    try { return JSON.parse(doc.content); } catch { fail(502, 'storage_file_invalid', 'Stored JSON could not be decoded. Existing data was preserved.'); }
  };
  async function viewer(request, env) {
    const session = await h.sessionFromRequest(request, env);
    return session?.authType === 'github' ? session.user : null;
  }
  async function editor(request, env) {
    const origin = request.headers.get('Origin');
    if (origin && !h.corsHeaders(request, env)['Access-Control-Allow-Origin']) fail(403, 'origin_not_allowed', 'This website is not allowed to submit changes.');
    return h.requireUser(request, env);
  }
  function mappedPath(site, input) {
    const path = safe(input);
    if (path.startsWith('data/Genepedia-Database/')) {
      const relative = path.slice('data/Genepedia-Database/'.length);
      if (site !== 'genepedia' || !/^(?:people|pets|statistics)\//.test(relative)) fail(400, 'invalid_path', 'This is not a public data path.');
      return { namespace: 'data', path: relative };
    }
    if (site === 'genepedia' && /^data\/(?:people|pets|statistics)\//.test(path)) return { namespace: 'data', path: path.slice(5) };
    if (site === 'gravepedia' && path.startsWith('data/memorials/')) return { namespace: 'data', path: path.slice(5) };
    if (/^(?:pages|people)\/.+\.(?:html|json)$/.test(path) || path === 'sitemap.xml' || path === 'index.html') return { namespace: 'content', path };
    fail(400, 'invalid_path', 'This file is not editable through the website.');
  }
  function requestedPaths(url) {
    const paths = String(url.searchParams.get('paths') || url.searchParams.get('path') || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (!paths.length || paths.length > 12) fail(400, 'invalid_path', 'Provide between one and twelve file paths.');
    return paths.map((path) => /^pages\/[^.]+$/.test(path) ? `${path.replace(/\/$/, '')}${/^pages\/(?:people|pets)\/\d+$/.test(path.replace(/\/$/, '')) ? '/index' : ''}.html` : path);
  }
  function changeForBrowser(site, change) {
    return { ...change, repo: publicRepo(site), url: reviewUrl(site, change.number), html_url: reviewUrl(site, change.number), files: undefined };
  }
  function visibleChange(env, user, change) {
    return isReviewer(env, user) || login(user) === login(change.user || { login: change.actor_login });
  }
  async function publicRead(request, env, site, namespace, path) {
    if (site === 'genepedia' && namespace === 'content' && /^pages\/(?:people\/people|pets\/pets)\.json$/.test(path)) {
      const url = new URL(request.url);
      const kind = path.includes('pets/') ? 'pet' : 'person';
      const limit = Math.max(1, Math.min(10_000, Number(url.searchParams.get('limit') || 10_000) || 10_000));
      const after = String(url.searchParams.get('after') || '');
      const rows = await env.DB.prepare(`SELECT person_id, display_name, first_name, last_name, birth_year, death_year, photo_url, updated_at
        FROM native_people_index WHERE site=?1 AND kind=?2 AND person_id>?3 ORDER BY person_id LIMIT ?4`).bind(site, kind, after, limit + 1).all();
      const hasMore = rows.results.length > limit;
      const selected = rows.results.slice(0, limit);
      const people = selected.map(row => ({ id: /^\d+$/.test(row.person_id) ? Number(row.person_id) : row.person_id, displayName: row.display_name, firstName: row.first_name, lastName: row.last_name, birthYear: row.birth_year, deathYear: row.death_year, photoUrl: row.photo_url, kind }));
      const total = await env.DB.prepare('SELECT COUNT(*) AS count FROM native_people_index WHERE site=?1 AND kind=?2').bind(site, kind).first();
      return json(request, env, { count: Number(total.count), people, ...(kind === 'pet' ? { pets: people } : {}), generated_from: 'native_people_index', has_more: hasMore, next_cursor: hasMore ? selected.at(-1).person_id : null }, 200, { 'Cache-Control': 'public, max-age=30' });
    }
    const document = await store.get(env, site, namespace, path);
    if (!document) {
      const url = new URL(request.url);
      const page = await store.list(env, site, namespace, { prefix: `${path.replace(/\/$/, '')}/`, limit: Number(url.searchParams.get('limit') || 100), cursor: url.searchParams.get('cursor') || '' });
      if (!page.documents.length) fail(404, 'file_not_found', 'This published file was not found.');
      const entries = page.documents.map((row) => ({ type: 'file', name: row.path.split('/').at(-1), path: row.path, size: row.size, sha: row.sha256, download_url: `https://api.genepedia.org/v1/${site}/${namespace === 'content' ? 'content' : namespace === 'media' ? 'media' : 'data'}?path=${encodeURIComponent(row.path)}` }));
      return json(request, env, entries, 200, { 'Cache-Control': 'public, max-age=30', ...(page.next_cursor ? { 'X-Next-Cursor': String(page.next_cursor) } : {}) });
    }
    const etag = `"${document.sha256}"`;
    const headers = { ...h.corsHeaders(request, env), 'Content-Type': document.content_type || h.contentType(path), 'ETag': etag, 'X-Document-Version': String(document.version), 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' };
    if (/html|svg|pdf/i.test(headers['Content-Type'])) headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
    return new Response(document.bytes || document.content || '', { status: 200, headers });
  }
  async function changes(request, env, site) {
    const user = await viewer(request, env);
    if (!user) fail(401, 'authentication_required', 'Sign in with GitHub to view edit requests.');
    const url = new URL(request.url);
    const number = Number(url.searchParams.get('number') || 0);
    if (number) {
      const change = await store.getChange(env, site, number);
      if (!change) fail(404, 'change_not_found', 'This edit request was not found.');
      if (!visibleChange(env, user, change)) fail(403, 'forbidden', 'This edit request is available to its author and reviewer.');
      const diffs = [];
      for (const file of change.files || []) {
        const current = await store.get(env, site, file.namespace, file.path);
        let after = file.content;
        if (after === null && file.blob_key && /^text\/|json|xml/.test(file.content_type)) {
          const object = await store.getBlob(env, site, file.blob_key);
          if (!object) fail(503, 'storage_blob_missing', 'The proposed content is temporarily unavailable.');
          after = await object.text();
        }
        diffs.push({ path: file.path, namespace: file.namespace, status: file.status, before: current?.content || null, after: after || null, patch: null, size: file.size, expected_version: file.expected_version, current_version: current?.version || 0 });
      }
      return json(request, env, { ok: true, repo: publicRepo(site), can_review: isReviewer(env, user), pull_request: changeForBrowser(site, change), diffs });
    }
    const page = await store.listChanges(env, site, { state: url.searchParams.get('state') || 'open', limit: Number(url.searchParams.get('limit') || 50), cursor: Number(url.searchParams.get('cursor') || 0) });
    let rows = page.changes.filter((change) => visibleChange(env, user, change));
    const pathQuery = url.searchParams.get('paths') || url.searchParams.get('path');
    if (pathQuery) {
      const wanted = requestedPaths(url).map((path) => mappedPath(site, path));
      const matches = [];
      for (const row of rows) {
        const detail = row.files ? row : await store.getChange(env, site, row.number);
        if (detail.files?.some((file) => wanted.some((path) => path.namespace === file.namespace && path.path === file.path))) matches.push(row);
      }
      rows = matches;
    }
    return json(request, env, { ok: true, repo: publicRepo(site), can_review: isReviewer(env, user), pull_requests: rows.map((change) => changeForBrowser(site, change)), count: rows.length, next_cursor: page.next_cursor });
  }
  async function submitEdit(request, env, site) {
    const session = await editor(request, env);
    const body = await h.readJson(request);
    const files = body.files || [{ path: body.path, content: body.content, expected_version: body.expected_version }];
    if (!Array.isArray(files) || !files.length || files.length > 12) fail(400, 'invalid_files', 'Submit between one and twelve files.');
    const normalized = files.filter(file => !/^pages\/(?:people\/people|pets\/pets)\.json$/.test(String(file.path))).map((file) => {
      const target = mappedPath(site, file.path);
      const content = String(file.content ?? '');
      if (!content || new TextEncoder().encode(content).length > 1_500_000) fail(400, 'invalid_content', 'A submitted file is empty or exceeds its size limit.');
      if (target.path.endsWith('.json')) { try { JSON.parse(content); } catch { fail(400, 'invalid_content', 'Submitted JSON is invalid.'); } }
      return { ...target, content, contentType: h.contentType(target.path), expectedVersion: file.expected_version ?? file.expectedVersion ?? body.expected_versions?.[`${target.namespace}:${target.path}`] ?? body.expected_versions?.[file.path] };
    });
    if (!normalized.length) fail(400, 'derived_catalog', 'The catalog is generated from approved profile records. Edit a profile record instead.');
    const title = body.pr_title || body.commit_message || `Edit by ${session.user.login}`;
    const description = body.pr_body || '';
    const idempotencyKey = request.headers.get('Idempotency-Key') || '';
    const idempotencyRequest = { title, body: description, files: normalized.map(file => ({ namespace: file.namespace, path: file.path, content: file.content, expected_version: file.expectedVersion ?? null })) };
    const envelope = change => ({ ok: true, site, paths: normalized.map(file => file.path), published_directly: false, pull_request: changeForBrowser(site, change), change_id: change.change_id });
    if (idempotencyKey) {
      const replay = await store.lookupIdempotency(env, site, session.user, idempotencyKey, { operation: 'submit', idempotencyRequest });
      if (replay) return json(request, env, envelope(replay), 201);
    }
    for (const file of normalized) {
      if (file.expectedVersion == null) {
        if (await store.get(env, site, file.namespace, file.path)) fail(428, 'precondition_required', 'Reload the file before editing: expected_version is required for existing files.');
        file.expectedVersion = 0;
      }
    }
    const change = await store.submit(env, { site, actor: session.user, files: normalized, idempotencyKey, idempotencyRequest, title, body: description });
    return json(request, env, envelope(change), 201);
  }
  async function fileHistory(request, env, site, diff) {
    const url = new URL(request.url);
    const paths = requestedPaths(url);
    if (!diff) {
      const entries = [];
      for (const original of paths) {
        const target = mappedPath(site, original);
        const history = await store.history(env, site, target.namespace, target.path, { limit: Number(url.searchParams.get('limit') || 50), cursor: Number(url.searchParams.get('cursor') || 0) });
        entries.push(...history.commits.map((commit) => ({ ...commit, paths: [original], repo: publicRepo(site) })));
      }
      entries.sort((a, b) => b.date.localeCompare(a.date));
      return json(request, env, { ok: true, repo: publicRepo(site), paths, commits: entries.slice(0, 100), count: entries.length });
    }
    const hash = url.searchParams.get('hash') || '';
    const diffs = [];
    for (const original of paths) {
      const target = mappedPath(site, original);
      const after = await store.getRevision(env, site, target.namespace, target.path, hash);
      if (!after) continue;
      const older = await store.history(env, site, target.namespace, target.path, { limit: 1, cursor: after.version });
      const before = older.commits[0] ? await store.getRevision(env, site, target.namespace, target.path, older.commits[0].sha) : null;
      diffs.push({ path: original, hash, before: before?.content || null, after: after.content || null, patch: null, status: after.deleted ? 'removed' : before ? 'modified' : 'added' });
    }
    if (!diffs.length) fail(404, 'diff_not_found', 'No revision was found for these files.');
    return json(request, env, { ok: true, repo: publicRepo(site), paths, ...(diffs.length === 1 ? { path: paths[0], diff: diffs[0] } : { diffs }) });
  }
  async function managesMedia(env, site, person, user) {
    if (isReviewer(env, user)) return true;
    if (site !== 'genepedia') return false;
    const config = parsed(await store.get(env, site, 'data', `people/ownership/${h.personBucket(person)}/${person}.json`));
    return config ? h.profileManagerLogins(config).includes(login(user)) : false;
  }
  async function profileMedia(request, env, site) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await h.readJson(request) : {};
    const person = String(body.person_id || body.person || url.searchParams.get('person') || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(person)) fail(400, 'invalid_person', 'A valid profile identifier is required.');
    const user = request.method === 'POST' ? (await editor(request, env)).user : await viewer(request, env);
    const canManage = Boolean(user && await managesMedia(env, site, person, user));
    if (request.method === 'GET') {
      const images = [];
      let next = null;
      for (const prefix of [`pages/people/${person}/`, `people/${person}/`]) {
        const page = await store.list(env, site, 'media', { prefix, limit: 100, cursor: url.searchParams.get('cursor') || '' });
        images.push(...page.documents.map((row) => ({ name: row.path.split('/').at(-1), path: row.path, size: row.size, type: row.content_type, download_url: `https://api.genepedia.org/v1/${site}/media?path=${encodeURIComponent(row.path)}` })));
        next ||= page.next_cursor;
      }
      const pending = [];
      if (user) {
        const page = await store.listChanges(env, site, { state: 'open', limit: 100 });
        for (const change of page.changes) {
          if (!visibleChange(env, user, change) && !canManage) continue;
          const detail = change.files ? change : await store.getChange(env, site, change.number);
          for (const file of detail.files || []) if (file.namespace === 'media' && file.path.startsWith(`pages/people/${person}/`)) pending.push({ number: detail.number, action: file.operation === 'delete' ? 'delete' : 'upload', filename: file.path.split('/').at(-1), path: file.path, url: reviewUrl(site, detail.number), user: detail.user, created_at: detail.created_at });
        }
      }
      return json(request, env, { ok: true, repo: publicRepo(site), person, images, pending, can_manage: canManage, can_review: isReviewer(env, user), manager_logins: [], next_cursor: next });
    }
    if (!canManage) fail(403, 'not_allowed', 'Only this profile’s managers can change its media.');
    const action = String(body.action || '').toLowerCase();
    if (['approve', 'decline'].includes(action)) {
      const change = await store.getChange(env, site, Number(body.number));
      if (!change?.files?.length || !change.files.every((file) => file.namespace === 'media' && file.path.startsWith(`pages/people/${person}/`) && /\.(?:jpe?g|png|gif|webp|avif|svg|pdf)$/i.test(file.path))) fail(400, 'not_media_change', 'This edit contains files outside the selected profile.');
      const result = await store.reviewChange(env, site, change.number, user, action);
      return json(request, env, { ok: true, number: change.number, action, result });
    }
    const filename = String(body.filename || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,99}\.(?:jpe?g|png|gif|webp|avif|svg|pdf)$/.test(filename) || filename.includes('..')) fail(400, 'invalid_filename', 'A supported media filename is required.');
    if (!['upload', 'delete'].includes(action)) fail(400, 'invalid_action', 'Media action must be upload or delete.');
    const idempotencyKey = request.headers.get('Idempotency-Key') || '';
    const idempotencyRequest = { action, person, filename, content_base64: action === 'upload' ? String(body.content_base64 || '') : '' };
    if (idempotencyKey) {
      const replay = await store.lookupIdempotency(env, site, user, idempotencyKey, { operation: 'submit', idempotencyRequest });
      if (replay) return json(request, env, { ok: true, person, path: `pages/people/${person}/${filename}`, filename, action, pull_request: changeForBrowser(site, replay), published_directly: false }, 201);
    }
    const file = { namespace: 'media', path: `pages/people/${person}/${filename}`, contentType: h.contentType(filename) };
    if (action === 'delete') {
      if (!await store.get(env, site, 'media', file.path)) fail(404, 'file_not_found', 'This media file was not found.');
      file.delete = true;
    }
    else {
      const base64 = String(body.content_base64 || '').replace(/^data:[^;]+;base64,/, '');
      let bytes;
      try { bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)); } catch { fail(400, 'invalid_content', 'The media content could not be decoded.'); }
      if (!bytes.length || bytes.length > 8_000_000) fail(413, 'media_too_large', 'Media must be smaller than 8 MB.');
      file.bytes = bytes;
    }
    const change = await store.submit(env, { site, actor: user, files: [file], idempotencyKey, idempotencyRequest, title: `${action === 'delete' ? 'Remove' : 'Add'} media ${filename} for ${person}` });
    return json(request, env, { ok: true, person, path: file.path, filename, action, pull_request: changeForBrowser(site, change), published_directly: false }, 201);
  }
  return {
    async handle(request, env, site, endpoint) {
      const url = new URL(request.url);
      if (['data', 'media', 'content'].includes(endpoint)) {
        if (request.method !== 'GET') return h.methodNotAllowed(request, env, ['GET']);
        let path = safe(url.searchParams.get('path'));
        if (endpoint === 'data') {
          path = path.replace(/^data\/Genepedia-Database\//, '').replace(/^data\//, '');
          if (!(site === 'genepedia' ? /^(?:people|pets|statistics)(?:\/|$)/ : /^memorials(?:\/|$)/).test(path)) fail(400, 'invalid_path', 'This is not a public data path.');
        } else if (endpoint === 'media' && !/^(?:people|pages)\//.test(path)) fail(400, 'invalid_path', 'A public media path is required.');
        else if (endpoint === 'content' && !/^(?:pages|people|data|assets|components|lib)\/|^(?:index\.html|404\.html|sitemap\.xml|site-info\.js|index\.js|index\.css|robots\.txt|favicon\.ico)$/.test(path)) fail(400, 'invalid_path', 'A public content path is required.');
        return publicRead(request, env, site, endpoint, path);
      }
      if (endpoint === 'search/people') {
        if (request.method !== 'GET') return h.methodNotAllowed(request, env, ['GET']);
        const query = String(url.searchParams.get('q') || '').slice(0, 200);
        const result = await store.searchPeople(env, site, query, { limit: Number(url.searchParams.get('limit') || 20), offset: Number(url.searchParams.get('offset') || 0), kind: url.searchParams.get('kind') || '' });
        return json(request, env, { ok: true, query, ...result }, 200, { 'Cache-Control': 'public, max-age=30' });
      }
      if (endpoint === 'profiles/owned' && site === 'genepedia') {
        if (request.method !== 'GET') return h.methodNotAllowed(request, env, ['GET']);
        const user = await viewer(request, env);
        if (!user) fail(401, 'authentication_required', 'Sign in with GitHub to find your profile.');
        const rows = await env.DB.prepare(`SELECT path, content FROM native_documents
          WHERE site = ?1 AND namespace = 'data' AND is_deleted = 0
            AND (path GLOB 'people/ownership/*' OR path GLOB 'pets/ownership/*')
            AND lower(COALESCE(json_extract(content, '$.owner.githubLogin'), json_extract(content, '$.owner.github_login'), json_extract(content, '$.owner.login'), '')) = ?2
          ORDER BY path LIMIT 50`).bind(site, login(user)).all();
        const profiles = rows.results.map(row => ({ person_id: row.path.split('/').at(-1).replace(/\.json$/, ''), kind: row.path.startsWith('pets/') ? 'pet' : 'person', config: parsed(row) }));
        return json(request, env, { ok: true, profiles });
      }
      if (endpoint === 'page-edits') return request.method === 'POST' ? submitEdit(request, env, site) : h.methodNotAllowed(request, env, ['POST']);
      if (endpoint === 'pull-requests') return request.method === 'GET' ? changes(request, env, site) : h.methodNotAllowed(request, env, ['GET']);
      if (endpoint === 'pull-requests/review') {
        if (request.method !== 'POST') return h.methodNotAllowed(request, env, ['POST']);
        const session = await editor(request, env);
        const body = await h.readJson(request, 32_768);
        const result = await store.reviewChange(env, site, Number(body.number), session.user, body.action === 'merge' ? 'approve' : body.action);
        return json(request, env, { ok: true, number: Number(body.number), action: body.action, result: { ...result, state: result.merged ? 'closed' : result.state, merged: result.merged } });
      }
      if (endpoint === 'files/commits' || endpoint === 'files/commit-diff') return request.method === 'GET' ? fileHistory(request, env, site, endpoint.endsWith('commit-diff')) : h.methodNotAllowed(request, env, ['GET']);
      if (endpoint === 'profiles/media') return ['GET', 'POST'].includes(request.method) ? profileMedia(request, env, site) : h.methodNotAllowed(request, env, ['GET', 'POST']);
      return null;
    },
  };
}
