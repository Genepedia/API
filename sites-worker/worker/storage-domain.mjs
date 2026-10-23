const STATISTICS_WINDOWS = Object.freeze({
  "24h": 24,
  "3d": 72,
  "7d": 168,
  "30d": 720,
  "60d": 1440,
  "90d": 2160,
  "6m": 183 * 24,
  "1y": 365 * 24,
});
const STATISTICS_WINDOW_NAMES = [...Object.keys(STATISTICS_WINDOWS), "all"];
const PAGE_SIZE = 1000;
const STATISTICS_CACHE_TTL_MS = 20_000;

export function createNativeDomain(helpers, store) {
  const h = helpers || {};
  const statisticsCache = new WeakMap();

  function apiError(status, code, message, details = null) {
    return new h.ApiError(status, code, message, details);
  }

  function notFound(message = "This API endpoint is not available for this site.") {
    throw apiError(404, "not_found", message);
  }

  function checkMethod(request, env, methods) {
    if (methods.includes(request.method)) return null;
    if (typeof h.methodNotAllowed === "function") return h.methodNotAllowed(request, env, methods);
    return h.jsonResponse(request, env, {
      ok: false,
      success: false,
      error: "method_not_allowed",
      message: `Only ${methods.join(" and ")} requests are supported for this route.`,
    }, 405, { Allow: methods.join(", ") });
  }

  function json(request, env, payload, status = 200, headers = {}) {
    return h.jsonResponse(request, env, payload, status, headers);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function validPersonId(value) {
    const id = String(value || "").trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
  }

  function loginOf(user) {
    return String(user?.login || "").trim();
  }

  function idempotencyKey(request, prefix) {
    const supplied = String(request.headers.get("Idempotency-Key") || "").trim();
    if (supplied) {
      if (supplied.length > 200 || /[\r\n]/.test(supplied)) throw apiError(400, "invalid_idempotency_key", "The Idempotency-Key header is invalid.");
      return supplied;
    }
    return `${prefix}-${h.randomHex(16)}`;
  }

  async function stableResourceId(prefix, site, login, key) {
    const digest = await h.sha256(`${site}\n${String(login || "").toLowerCase()}\n${prefix}\n${key}`);
    return `${prefix}-${digest.slice(0, 32)}`;
  }

  function jsonText(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  function parseJsonDocument(document, label = "stored data") {
    if (document === null || document === undefined) return null;
    if (typeof document.content !== "string") throw apiError(502, "storage_file_invalid", `${label} could not be decoded.`);
    try {
      return JSON.parse(document.content);
    } catch {
      throw apiError(502, "storage_file_invalid", `${label} contains invalid JSON.`);
    }
  }

  function objectOrInvalid(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw apiError(502, "storage_file_invalid", `${label} has an invalid shape.`);
    return value;
  }

  function expectedVersion(document) {
    return Number.isSafeInteger(Number(document?.version)) && Number(document?.version) >= 0 ? Number(document.version) : 0;
  }

  function expectedVersions(files, documents) {
    const result = {};
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const version = expectedVersion(documents[index]);
      result[`${file.namespace}:${file.path}`] = version;
    }
    return result;
  }

  function nativeChangeSummary(change) {
    if (!change) return null;
    const url = String(change.url || "");
    return {
      number: Number(change.number || 0),
      url,
      html_url: url,
      title: String(change.title || ""),
      state: String(change.state || "open"),
    };
  }

  function isConflict(error) {
    return Number(error?.status) === 409 && ["storage_conflict", "idempotency_conflict"].includes(String(error?.code || ""));
  }

  async function requireEditor(request, env) {
    const editor = await h.requireUser(request, env);
    const login = loginOf(editor?.user);
    if (!login || !/^[A-Za-z0-9-]{1,39}$/.test(login)) throw apiError(401, "authentication_required", "A GitHub login is required to save this change.");
    return editor;
  }

  async function getJson(env, site, namespace, path, label = path) {
    return parseJsonDocument(await store.get(env, site, namespace, path), label);
  }

  async function getDocument(env, site, namespace, path) {
    return store.get(env, site, namespace, path);
  }

  function personOwnershipPath(id, kind = "person") {
    const root = kind === "pet" ? "pets" : "people";
    return `${root}/ownership/${h.personBucket(id)}/${id}.json`;
  }

  function profileManagerLogins(config) {
    return typeof h.profileManagerLogins === "function" ? h.profileManagerLogins(config) : [];
  }

  function profileFolder(kind, id) {
    return kind === "pet" ? `pages/pets/${id}` : `pages/people/${id}`;
  }

  function mapLegacyWorkspacePath(path) {
    const normalized = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (normalized.startsWith("data/Genepedia-Database/")) return { namespace: "data", path: normalized.slice("data/Genepedia-Database/".length) };
    if (normalized.startsWith("data/")) return { namespace: "data", path: normalized.slice(5) };
    if (normalized.startsWith("pages/")) return { namespace: "content", path: normalized };
    throw apiError(400, "invalid_path", `The path ${normalized || "(empty)"} is not supported.`);
  }

  function profileWorkspacePath(path) {
    const mapped = mapLegacyWorkspacePath(path);
    if (!h.safeRepoPath(path)) throw apiError(400, "invalid_path", `The path ${path} is not supported.`);
    return mapped;
  }

  async function submitChange(env, site, editor, files, versionDocs, key, title, body, idempotencyRequest) {
    const versions = expectedVersions(files, versionDocs);
    return store.submit(env, {
      site,
      actor: editor.user,
      files,
      expectedVersions: versions,
      idempotencyKey: key,
      ...(idempotencyRequest === undefined ? {} : { idempotencyRequest }),
      title,
      body,
    });
  }

  async function handleSelfProfile(request, env, site) {
    if (site !== "genepedia") notFound("This API endpoint is only available for Genepedia.");
    const payload = await h.readJson(request, 2_000_000);
    const action = String(payload.action || "").trim().toLowerCase();
    if (!["create", "claim"].includes(action)) throw apiError(400, "invalid_action", "Action must be create or claim.");
    const personId = validPersonId(payload.person_id || payload.person);
    if (!personId) throw apiError(400, "invalid_person", "A valid person id is required.");
    const editor = await requireEditor(request, env);
    const login = loginOf(editor.user);
    const bucket = h.personBucket(personId);
    const profileKind = String(payload.profile_kind || "person").trim().toLowerCase() === "pet" ? "pet" : "person";
    const stableIntent = action === "claim"
      ? { action, person_id: personId, profile_kind: profileKind, commit_message: String(payload.commit_message || "").trim() }
      : {
        action, person_id: personId, profile_kind: profileKind, claim_self: h.parsePhpBoolean(payload.claim_self, true),
        commit_message: String(payload.commit_message || "").trim(),
        files: (Array.isArray(payload.files) ? payload.files : []).map(entry => ({ path: String(entry?.path || "").replace(/\\/g, "/").replace(/^\/+/, "").trim(), content: String(entry?.content ?? "") })).sort((a, b) => a.path.localeCompare(b.path)),
      };
    const replayKey = request.headers.get("Idempotency-Key");
    if (replayKey) {
      const replay = await store.lookupIdempotency(env, site, editor.user, replayKey, { operation: "submit", idempotencyRequest: stableIntent });
      if (replay) {
        const pullRequest = nativeChangeSummary(replay);
        if (action === "claim") {
          return json(request, env, {
            ok: true,
            repo: "Genepedia/Genepedia-Database",
            person: personId,
            action,
            branch: "",
            commit: null,
            pull_request: pullRequest,
            change_id: replay.change_id,
            claimed_at: replay.created_at || nowIso(),
          }, 201);
        }
        const paths = (Array.isArray(payload.files) ? payload.files : []).map((entry) => String(entry?.path || "").replace(/\\/g, "/").replace(/^\/+/, "").trim());
        return json(request, env, {
          ok: true,
          repo: "Genepedia/Genepedia",
          person: personId,
          action: "create",
          paths,
          branch: "",
          base_branch: "",
          commit: null,
          pull_request: pullRequest,
          change_id: replay.change_id,
          published_directly: false,
          results: [],
          published_at: replay.created_at || nowIso(),
        }, 201);
      }
    }
    const ownershipPath = personOwnershipPath(personId, profileKind);
    const ownershipWorkspacePath = `data/Genepedia-Database/${ownershipPath}`;
    const ownershipDocument = await getDocument(env, site, "data", ownershipPath);

    if (action === "claim") {
      const current = parseJsonDocument(ownershipDocument, "Profile ownership metadata");
      if (!current || typeof current !== "object" || Array.isArray(current)) throw apiError(404, "profile_not_found", "That profile does not have profile metadata to claim.");
      const ownerLogin = String(current.owner?.githubLogin || current.owner?.login || "").trim();
      if (ownerLogin && ownerLogin.toLowerCase() !== login.toLowerCase()) throw apiError(409, "profile_already_claimed", "That profile has already been claimed.");
      const next = h.profileConfigWithOwner(current, editor.user, personId, true, String(current.owner?.name || ""));
      if (JSON.stringify(current) === JSON.stringify(next)) {
        return json(request, env, { ok: true, repo: "Genepedia/Genepedia-Database", person: personId, action: "claim", commit: null, claimed_at: nowIso() });
      }
      const file = { namespace: "data", path: ownershipPath, content: jsonText(next), contentType: "application/json; charset=utf-8" };
      const key = idempotencyKey(request, "profile-claim");
      const title = String(payload.commit_message || `Claim profile ${personId} for @${login}`).trim().slice(0, 240);
      const change = await submitChange(env, site, editor, [file], [ownershipDocument], key, title,
        `Profile ${personId} ownership was submitted for review by @${login}.`,
        { action: "claim", person_id: personId, profile_kind: profileKind, commit_message: String(payload.commit_message || "").trim() });
      return json(request, env, {
        ok: true,
        repo: "Genepedia/Genepedia-Database",
        person: personId,
        action: "claim",
        branch: "",
        commit: null,
        pull_request: nativeChangeSummary(change),
        change_id: change.change_id,
        claimed_at: change.created_at || nowIso(),
      }, 201);
    }

    const rawFiles = Array.isArray(payload.files) ? payload.files : [];
    if (!rawFiles.length || rawFiles.length > 12) throw apiError(400, "invalid_files", "A new profile must publish between one and twelve files.");
    const folder = profileFolder(profileKind, personId);
    const recordPath = `${profileKind === "pet" ? "pets" : "people"}/persons/${bucket}/${personId}.json`;
    const recordWorkspacePath = `data/Genepedia-Database/${recordPath}`;
    const registryPath = profileKind === "pet" ? "pages/pets/pets.json" : "pages/people/people.json";
    const allowed = new Set([
      `${folder}/index.html`,
      `${folder}/profile.html`,
      recordWorkspacePath,
      ownershipWorkspacePath,
      registryPath,
    ]);
    const byPath = new Map();
    for (const entry of rawFiles) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const path = String(entry.path || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
      // Catalogs are derived from the approved native index, never a client snapshot.
      if (path === registryPath) continue;
      const content = String(entry.content ?? "");
      if (!allowed.has(path)) throw apiError(400, "invalid_path", `Self-profile creation cannot publish ${path || "that path"}.`);
      if (!content || content.length > 1_500_000) throw apiError(400, "invalid_content", `Profile file content is required for ${path}.`);
      if (path.endsWith(".html") && !content.includes("<")) throw apiError(400, "invalid_content", "HTML profile files must contain markup.");
      if (path.endsWith(".json")) {
        try { JSON.parse(content); } catch { throw apiError(400, "invalid_content", `${path} must be valid JSON.`); }
      }
      const location = profileWorkspacePath(path);
      if (byPath.has(path)) throw apiError(400, "duplicate_path", `Profile creation cannot include ${path} more than once.`);
      byPath.set(path, {
        namespace: location.namespace,
        path: location.path,
        content,
        contentType: typeof h.contentType === "function" ? h.contentType(path) : "application/json; charset=utf-8",
      });
    }
    for (const path of [`${folder}/index.html`, `${folder}/profile.html`, recordWorkspacePath, ownershipWorkspacePath]) {
      if (!byPath.has(path)) throw apiError(400, "missing_file", `New profiles must include ${path}.`);
    }

    const profileIndexPath = `${folder}/index.html`;
    const recordDocument = await getDocument(env, site, "data", recordPath);
    const indexDocument = await getDocument(env, site, "content", profileIndexPath);
    if (indexDocument || recordDocument || ownershipDocument) throw apiError(409, "profile_exists", "That profile id already exists. Refresh and try again.");

    const ownershipEntry = byPath.get(ownershipWorkspacePath);
    let config;
    try { config = JSON.parse(ownershipEntry.content); }
    catch { throw apiError(400, "invalid_content", `${ownershipWorkspacePath} must be valid JSON.`); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw apiError(400, "invalid_content", `${ownershipWorkspacePath} must contain a JSON object.`);
    const fallbackName = String(config?.owner?.name || config?.creator?.name || "").trim();
    ownershipEntry.content = jsonText(h.profileConfigWithOwner(config, editor.user, personId, h.parsePhpBoolean(payload.claim_self, true), fallbackName));

    const files = [...byPath.values()];
    const documents = [];
    for (const file of files) {
      documents.push(file.namespace === "content"
        ? await getDocument(env, site, "content", file.path)
        : await getDocument(env, site, "data", file.path));
    }
    // Profile paths and database records are create-only. Shared registry edits
    // remain version-checked at review time but can already exist.
    for (let index = 0; index < files.length; index += 1) {
      const sourcePath = [...byPath.keys()][index];
      if (sourcePath !== registryPath && documents[index]) throw apiError(409, "profile_exists", "That profile id already exists. Refresh and try again.");
    }
    const key = idempotencyKey(request, "self-profile");
    const title = String(payload.commit_message || `Create self profile ${personId} for @${login}`).trim().slice(0, 240);
    const change = await submitChange(env, site, editor, files, documents, key, title,
      `New ${profileKind} profile ${personId} submitted by @${login} for review.\n\nFiles: ${[...byPath.keys()].map((path) => `\`${path}\``).join(", ")}`,
      {
        action: "create",
        person_id: personId,
        profile_kind: profileKind,
        claim_self: h.parsePhpBoolean(payload.claim_self, true),
        commit_message: String(payload.commit_message || "").trim(),
        files: rawFiles.map((entry) => ({
          path: String(entry?.path || "").replace(/\\/g, "/").replace(/^\/+/, "").trim(),
          content: String(entry?.content ?? ""),
        })).sort((left, right) => left.path.localeCompare(right.path)),
      });
    return json(request, env, {
      ok: true,
      repo: "Genepedia/Genepedia",
      person: personId,
      action: "create",
      paths: [...byPath.keys()],
      branch: "",
      base_branch: "",
      commit: null,
      pull_request: nativeChangeSummary(change),
      change_id: change.change_id,
      published_directly: false,
      results: [],
      published_at: change.created_at || nowIso(),
    }, 201);
  }

  function parseMaintainerPaths(value) {
    const parts = Array.isArray(value) ? value : String(value || "").split(",");
    return [...new Set(parts.map((part) => String(part || "").replace(/\\/g, "/").trim().replace(/^\/+/, "")).filter(Boolean))];
  }

  function maintainerTarget(paths) {
    if (!paths.length || paths.length > 12) return null;
    let personId = "";
    let profileKind = "";
    for (const path of paths) {
      if (!h.safeRepoPath(path)) return null;
      const match = path.match(/^(?:pages\/)?(people|pets)\/([A-Za-z0-9_-]+)\/(?:index\.html|profile\.html|data\/[A-Za-z0-9_.-]+|data\/|media\/[A-Za-z0-9_.-]+|media\/)/);
      const currentKind = match?.[1] === "pets" ? "pet" : "person";
      if (!match || (personId && (personId !== match[2] || (profileKind && profileKind !== currentKind)))) { personId = ""; profileKind = ""; break; }
      personId = match[2];
      profileKind = currentKind;
    }
    if (personId) {
      return {
        type: "profile",
        profile_kind: profileKind,
        key: `${profileKind === "pet" ? "pet" : "profile"}:${personId}`,
        person_id: personId,
        editable_path: `pages/${profileKind === "pet" ? "pets" : "people"}/${personId}/profile.html`,
        metadata_namespace: "data",
        metadata_path: personOwnershipPath(personId, profileKind),
        label: `Profile ${personId}`,
      };
    }
    if (paths.length !== 1 || !/^pages\/[A-Za-z0-9_./-]+\.html$/.test(paths[0]) || !h.safeRepoPath(paths[0])) return null;
    const path = paths[0];
    return {
      type: "page",
      key: `page:${path}`,
      editable_path: path,
      metadata_namespace: "content",
      metadata_path: path.replace(/\.html$/, ".json"),
      label: path.split("/").pop().replace(/_/g, " ").replace(/\.html$/i, ""),
    };
  }

  function ledgerItemsFor(ledger, target) {
    return ledger.items.filter((item) => String(item?.target?.key || "") === target.key);
  }

  function maintainerHasPending(ledger, target, kind, login) {
    return ledgerItemsFor(ledger, target).some((item) => String(item?.kind || "") === kind
      && String(item?.status || "") === "pending"
      && String(item?.person?.githubLogin || "").toLowerCase() === login.toLowerCase());
  }

  function pageManagerLogins(config) {
    const logins = [];
    for (const key of ["creator", "createdBy", "created_by", "owner", "ownedBy", "owned_by", "maintainers", "maintainedBy", "maintained_by", "owners"]) {
      const value = config?.[key];
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        const login = String(typeof item === "string" ? item : item?.githubLogin || item?.github_login || item?.login || "").trim();
        if (/^[A-Za-z0-9-]{1,39}$/.test(login)) logins.push(login.toLowerCase());
      }
    }
    return [...new Set(logins)];
  }

  function maintainerIdentity(user, fallbackLogin = "", fallbackName = "") {
    const login = String(user?.login || user?.githubLogin || fallbackLogin).trim();
    const name = String(fallbackName || user?.displayName || user?.name || login).trim();
    const identity = { name: name || login, githubLogin: login };
    const personId = String(user?.personId || user?.person_id || "").trim();
    if (personId) identity.personId = personId;
    return identity;
  }

  function maintainerConfigWithAdded(config, identity) {
    const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
    const maintainers = Array.isArray(next.maintainers) ? next.maintainers.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
    if (!maintainers.some((item) => String(item.githubLogin || item.github_login || item.login || "").toLowerCase() === String(identity.githubLogin || "").toLowerCase())) maintainers.push(identity);
    next.maintainers = maintainers;
    return next;
  }

  function maintainerCanManage(env, target, config, user, hasMetadata) {
    const login = String(user?.login || "").toLowerCase();
    if (!login) return false;
    const reviewer = String(env.GITHUB_REVIEW_LOGIN || "").toLowerCase();
    if (reviewer && login === reviewer) return true;
    const managers = target.type === "profile" ? profileManagerLogins(config) : pageManagerLogins(config);
    if (managers.includes(login)) return true;
    // Native storage has no commit-author fallback. Missing metadata cannot
    // prove ownership, so only an explicit reviewer/manager may manage it.
    return false;
  }

  async function maintainerMutationResponse(request, env, site, target, editor, userLogin, change, fallbackLedger, fallbackConfig) {
    const targetLedgerPath = `maintainers/targets/${await h.sha256(target.key)}.json`;
    let responseLedger = fallbackLedger;
    const stagedLedger = change.files?.find((file) => file.namespace === "data" && file.path === targetLedgerPath && typeof file.content === "string");
    if (stagedLedger) {
      responseLedger = objectOrInvalid(parseJsonDocument({ content: stagedLedger.content }, "Submitted maintainer ledger"), "Submitted maintainer ledger");
    } else if (!responseLedger) {
      responseLedger = objectOrInvalid(await getJson(env, site, "data", targetLedgerPath, "Submitted maintainer ledger") || { version: 1, items: [] }, "Submitted maintainer ledger");
    }
    if (!Array.isArray(responseLedger.items)) throw apiError(502, "storage_file_invalid", "Submitted maintainer ledger has an invalid shape.");

    let responseConfig = fallbackConfig;
    const stagedConfig = change.files?.find((file) => file.namespace === target.metadata_namespace && file.path === target.metadata_path && typeof file.content === "string");
    if (stagedConfig) {
      responseConfig = objectOrInvalid(parseJsonDocument({ content: stagedConfig.content }, "Submitted maintainer metadata"), "Submitted maintainer metadata");
    } else if (responseConfig === undefined) {
      const config = await getJson(env, site, target.metadata_namespace, target.metadata_path, "Maintainer metadata");
      responseConfig = config === null ? {} : objectOrInvalid(config, "Maintainer metadata");
    }
    const refreshedCanManage = maintainerCanManage(env, target, responseConfig || {}, editor.user, true);
    const refreshedLogins = target.type === "profile" ? profileManagerLogins(responseConfig || {}) : pageManagerLogins(responseConfig || {});
    return json(request, env, {
      ok: true,
      repo: "Genepedia/Genepedia",
      target,
      items: ledgerItemsFor(responseLedger, target),
      can_manage: refreshedCanManage,
      is_maintainer: refreshedCanManage || refreshedLogins.includes(userLogin),
      commit: null,
      pull_request: nativeChangeSummary(change),
      change_id: change.change_id,
      published_directly: false,
      results: [],
      published_at: change.created_at || nowIso(),
    }, 201);
  }

  async function handleMaintainers(request, env, site) {
    if (site !== "genepedia") notFound("This API endpoint is only available for Genepedia.");
    let payload = {};
    let paths;
    if (request.method === "POST") {
      payload = await h.readJson(request, 64_000);
      paths = parseMaintainerPaths(payload.paths ?? payload.path);
    } else {
      const url = new URL(request.url);
      paths = parseMaintainerPaths(url.searchParams.get("paths") || url.searchParams.get("path") || "");
    }
    const target = maintainerTarget(paths);
    if (!target) throw apiError(400, "invalid_target", "A valid editable page or profile target is required.");
    const editor = request.method === "POST" ? await requireEditor(request, env) : null;
    const key = editor ? idempotencyKey(request, "maintainer") : "";
    const action = String(payload.action || "").trim().toLowerCase();
    const userLogin = loginOf(editor?.user).toLowerCase();
    const stableIntent = {
      action,
      target: target.key,
      github_login: String(payload.github_login || payload.login || "").trim().toLowerCase(),
      name: String(payload.name || "").trim(),
      id: String(payload.id || "").trim(),
    };
    const explicitKey = String(request.headers.get("Idempotency-Key") || "").trim();
    if (editor && explicitKey && typeof store.lookupIdempotency === "function") {
      const replay = await store.lookupIdempotency(env, site, editor.user, key, { operation: "submit", idempotencyRequest: stableIntent });
      if (replay) return maintainerMutationResponse(request, env, site, target, editor, userLogin, replay);
    }
    const viewer = request.method === "GET" ? await h.sessionFromRequest(request, env).catch(() => null) : null;
    const targetLedgerPath = `maintainers/targets/${await h.sha256(target.key)}.json`;
    const [ledgerDocument, configDocument] = await Promise.all([
      getDocument(env, site, "data", targetLedgerPath),
      getDocument(env, site, target.metadata_namespace, target.metadata_path),
    ]);
    const legacyLedgerDocument = ledgerDocument ? null : await getDocument(env, site, "data", "maintainer-invitations.json");
    const rawLedger = parseJsonDocument(ledgerDocument || legacyLedgerDocument, "Maintainer invitation ledger");
    const rawConfig = parseJsonDocument(configDocument, "Maintainer metadata");
    const ledger = rawLedger === null ? { version: 1, items: [] } : objectOrInvalid(rawLedger, "Maintainer invitation ledger");
    if (!Array.isArray(ledger.items)) throw apiError(502, "storage_file_invalid", "Maintainer invitation ledger has an invalid shape.");
    const cleanLedger = { ...ledger, version: 1, items: ledger.items.filter((item) => item && typeof item === "object" && !Array.isArray(item) && String(item?.target?.key || "") === target.key) };
    const hasMetadata = rawConfig !== null;
    const config = hasMetadata ? objectOrInvalid(rawConfig, "Maintainer metadata") : {};
    const displayUser = editor?.user || viewer?.user || null;
    const accessUser = editor?.user || (viewer?.authType === "github" ? viewer.user : null);
    const canManage = maintainerCanManage(env, target, config, accessUser, hasMetadata);
    const currentLogins = target.type === "profile" ? profileManagerLogins(config) : pageManagerLogins(config);
    const isMaintainer = canManage || Boolean(accessUser?.login && currentLogins.includes(String(accessUser.login).toLowerCase()));
    if (request.method === "GET") {
      return json(request, env, {
        ok: true,
        repo: "Genepedia/Genepedia",
        target,
        items: ledgerItemsFor(cleanLedger, target),
        can_manage: canManage,
        is_maintainer: isMaintainer,
        current_user: displayUser ? { login: displayUser.login, displayName: displayUser.displayName, photoUrl: displayUser.photoUrl, profileUrl: displayUser.profileUrl } : null,
        fetched_at: nowIso(),
      });
    }

    const now = nowIso();
    let nextConfig = config;
    if (action === "request") {
      if (isMaintainer) throw apiError(409, "already_maintainer", "You are already a maintainer for this target.");
      if (!userLogin) throw apiError(400, "missing_login", "A GitHub login is required.");
      if (maintainerHasPending(cleanLedger, target, "request", userLogin)) throw apiError(409, "request_exists", "You already have a pending maintainer request.");
      const identity = maintainerIdentity(editor.user);
      cleanLedger.items.push({ id: await stableResourceId("maint", site, userLogin, key), target, kind: "request", status: "pending", person: identity, createdBy: identity, createdAt: now });
    } else if (action === "invite") {
      if (!canManage) throw apiError(403, "not_allowed", "Only current maintainers can invite new maintainers.");
      const inviteLogin = String(payload.github_login || payload.login || "").trim();
      if (!/^[A-Za-z0-9-]{1,39}$/.test(inviteLogin)) throw apiError(400, "invalid_login", "A valid GitHub login is required.");
      if (maintainerHasPending(cleanLedger, target, "invite", inviteLogin)) throw apiError(409, "invite_exists", "That person already has a pending maintainer invitation.");
      const identity = maintainerIdentity({}, inviteLogin, String(payload.name || inviteLogin));
      cleanLedger.items.push({ id: await stableResourceId("maint", site, userLogin, key), target, kind: "invite", status: "pending", person: identity, createdBy: maintainerIdentity(editor.user), createdAt: now });
    } else if (["approve", "decline", "cancel", "accept_invite", "decline_invite"].includes(action)) {
      const id = String(payload.id || "").trim();
      const index = cleanLedger.items.findIndex((item) => String(item.id || "") === id);
      if (!id || index < 0) throw apiError(404, "item_not_found", "That maintainer invitation or request could not be found.");
      const item = cleanLedger.items[index];
      if (String(item.target?.key || "") !== target.key || String(item.status || "") !== "pending") throw apiError(409, "item_not_pending", "That maintainer invitation or request is no longer pending.");
      const kind = String(item.kind || "");
      const itemLogin = String(item.person?.githubLogin || "").toLowerCase();
      let decision;
      if (["approve", "decline", "cancel"].includes(action)) {
        if (!canManage) throw apiError(403, "not_allowed", "Only current maintainers can manage maintainer requests.");
        if (action === "approve" && kind !== "request") throw apiError(400, "invalid_action", "Only maintainer requests can be approved by maintainers.");
        decision = action === "approve" ? "accepted" : action === "cancel" ? "cancelled" : "declined";
      } else {
        if (kind !== "invite" || !itemLogin || itemLogin !== userLogin) throw apiError(403, "not_allowed", "Only the invited GitHub user can respond to this invitation.");
        decision = action === "accept_invite" ? "accepted" : "declined";
      }
      item.status = decision;
      item.decidedBy = maintainerIdentity(editor.user);
      item.decidedAt = now;
      cleanLedger.items[index] = item;
      if (decision === "accepted") nextConfig = maintainerConfigWithAdded(config, item.person || {});
    } else {
      throw apiError(400, "invalid_action", "Action must be request, invite, approve, decline, cancel, accept_invite or decline_invite.");
    }

    const message = `${action.replace(/_/g, " ")} maintainer access for ${target.label}`.slice(0, 240);
    const files = [{ namespace: "data", path: targetLedgerPath, content: jsonText(cleanLedger), contentType: "application/json; charset=utf-8" }];
    const versionDocs = [ledgerDocument];
    if (JSON.stringify(nextConfig) !== JSON.stringify(config)) {
      files.push({ namespace: target.metadata_namespace, path: target.metadata_path, content: jsonText(nextConfig), contentType: "application/json; charset=utf-8" });
      versionDocs.push(configDocument);
    }
    const change = await store.submit(env, {
      site,
      actor: editor.user,
      files,
      expectedVersions: expectedVersions(files, versionDocs),
      idempotencyKey: key,
      idempotencyRequest: stableIntent,
      title: message,
      body: `Maintainer action ${action} for ${target.label}, submitted by @${loginOf(editor.user)}.`,
    });
    return maintainerMutationResponse(request, env, site, target, editor, userLogin, change, cleanLedger, nextConfig);
  }

  function normalizedTalkMessage(value) {
    return typeof h.normalizeTalkMessage === "function" ? h.normalizeTalkMessage(value) : {
      id: String(value?.id || ""), body: String(value?.body || ""), author_login: String(value?.author_login || ""),
      author_name: String(value?.author_name || ""), author_avatar: String(value?.author_avatar || ""),
      author_url: String(value?.author_url || ""), created_at: String(value?.created_at || ""),
    };
  }

  function decodeTalk(document) {
    if (!document) return { messages: [] };
    const payload = objectOrInvalid(parseJsonDocument(document, "Stored discussion"), "Stored discussion");
    if (!Array.isArray(payload.messages)) throw apiError(502, "storage_file_invalid", "The stored discussion has an invalid shape.");
    return { messages: payload.messages.map(normalizedTalkMessage) };
  }

  function userCanModerate(env, config, user) {
    const login = String(user?.login || "").toLowerCase();
    if (!login) return false;
    return (String(env.GITHUB_REVIEW_LOGIN || "").toLowerCase() === login)
      || profileManagerLogins(config).includes(login);
  }

  async function handleTalk(request, env, site) {
    if (site !== "genepedia") notFound("This API endpoint is only available for Genepedia.");
    const url = new URL(request.url);
    if (request.method === "GET") {
      const personId = validPersonId(url.searchParams.get("person"));
      if (!personId) throw apiError(400, "invalid_person", "A valid person id is required.");
      const profileKind = String(url.searchParams.get("profile_kind") || url.searchParams.get("kind") || "person").trim().toLowerCase() === "pet" ? "pet" : "person";
      const profileFolder = profileKind === "pet" ? "pets" : "people";
      const path = `pages/${profileFolder}/${personId}/data/talk.json`;
      const ownershipPath = personOwnershipPath(personId, profileKind);
      const [talkDocument, configDocument, viewer] = await Promise.all([
        getDocument(env, site, "content", path),
        getDocument(env, site, "data", ownershipPath),
        h.sessionFromRequest(request, env).catch(() => null),
      ]);
      const talk = decodeTalk(talkDocument);
      const config = configDocument ? objectOrInvalid(parseJsonDocument(configDocument, "Profile ownership metadata"), "Profile ownership metadata") : null;
      const user = viewer?.user || null;
      const githubUser = viewer?.authType === "github" ? user : null;
      const canModerate = userCanModerate(env, config, githubUser);
      return json(request, env, {
        ok: true,
        repo: "Genepedia/Genepedia",
        person: personId,
        messages: talk.messages,
        count: talk.messages.length,
        can_moderate: canModerate,
        viewer_login: String(user?.login || ""),
        fetched_at: nowIso(),
      });
    }
    const payload = await h.readJson(request, 64_000);
    const action = String(payload.action || "post").trim().toLowerCase();
    if (!["post", "delete"].includes(action)) throw apiError(400, "invalid_action", "Action must be post or delete.");
    const personId = validPersonId(payload.person_id || payload.person);
    if (!personId) throw apiError(400, "invalid_person", "A valid person id is required.");
    const editor = await requireEditor(request, env);
    const login = loginOf(editor.user);
    const profileKind = String(payload.profile_kind || payload.kind || "person").trim().toLowerCase() === "pet" ? "pet" : "person";
    const profileFolder = profileKind === "pet" ? "pets" : "people";
    const path = `pages/${profileFolder}/${personId}/data/talk.json`;
    const ownershipPath = personOwnershipPath(personId, profileKind);
    const key = idempotencyKey(request, "talk");
    const now = nowIso();
    let messageId = "";
    let newMessage = null;
    let deleteId = "";
    if (action === "post") {
      const body = String(payload.body || "").replace(/\r\n/g, "\n").trim();
      if (!body) throw apiError(400, "empty_message", "A message is required.");
      if ([...body].length > 5000) throw apiError(400, "message_too_long", "Messages must be at most 5000 characters.");
      messageId = `msg-${(await h.sha256(`${login.toLowerCase()}\n${key}`)).slice(0, 24)}`;
      newMessage = normalizedTalkMessage({
        id: messageId,
        body,
        author_login: login,
        author_name: editor.user.displayName || login,
        author_avatar: editor.user.photoUrl || "",
        author_url: editor.user.profileUrl || `https://github.com/${login}`,
        created_at: now,
      });
    } else {
      deleteId = String(payload.message_id || "").trim();
      if (!deleteId) throw apiError(400, "invalid_message", "A message id is required.");
    }
    const idempotencyRequest = action === "post"
      ? { action: "talk.post", person_id: personId, profile_kind: profileKind, body: newMessage.body }
      : { action: "talk.delete", person_id: personId, profile_kind: profileKind, message_id: deleteId };

    let savedMessages = null;
    let result = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [talkDocument, configDocument] = await Promise.all([
        getDocument(env, site, "content", path),
        action === "delete" ? getDocument(env, site, "data", ownershipPath) : Promise.resolve(null),
      ]);
      const messages = decodeTalk(talkDocument).messages;
      let nextMessages;
      if (action === "post") {
        const replay = messages.find((message) => message.id === messageId);
        if (replay) {
          if (replay.author_login.toLowerCase() !== login.toLowerCase() || replay.body !== newMessage.body) throw apiError(409, "idempotency_conflict", "This Idempotency-Key was already used for a different discussion message.");
          newMessage = replay;
          savedMessages = messages;
          break;
        }
        if (messages.length >= 2000) throw apiError(400, "talk_page_full", "This talk page has reached its maximum number of messages.");
        nextMessages = [...messages, newMessage];
      } else {
        const target = messages.find((message) => message.id === deleteId);
        if (!target) {
          const replay = typeof store.lookupIdempotency === "function"
            ? await store.lookupIdempotency(env, site, editor.user, key, { operation: "apply", idempotencyRequest })
            : null;
          if (replay) {
            result = replay;
            savedMessages = messages;
            break;
          }
          throw apiError(404, "message_not_found", "That message no longer exists.");
        }
        const config = configDocument ? objectOrInvalid(parseJsonDocument(configDocument, "Profile ownership metadata"), "Profile ownership metadata") : null;
        const author = login.toLowerCase() === target.author_login.toLowerCase();
        if (!author && !userCanModerate(env, config, editor.user)) throw apiError(403, "not_allowed", "Only the message author or a profile maintainer can delete this message.");
        nextMessages = messages.filter((message) => message.id !== deleteId);
      }
      const file = { namespace: "content", path, content: jsonText({ messages: nextMessages }), contentType: "application/json; charset=utf-8" };
      try {
        result = await store.apply(env, {
          site,
          actor: editor.user,
          files: [file],
          expectedVersions: { [`content:${path}`]: expectedVersion(talkDocument) },
          idempotencyKey: key,
          idempotencyRequest,
          action: action === "post" ? "talk.post" : "talk.delete",
          summary: action === "post" ? `Talk: new message on profile ${personId} from @${login}` : `Talk: remove message ${deleteId} on profile ${personId} (by @${login})`,
        });
        savedMessages = nextMessages;
        break;
      } catch (error) {
        if (!isConflict(error) || attempt === 3) throw error;
      }
    }
    if (!savedMessages) throw apiError(409, "storage_conflict", "The discussion changed repeatedly. Refresh and try again.");
    const commit = result ? { sha: String(result.change_id || ""), message: String(result.summary || "") } : null;
    if (action === "post") return json(request, env, {
      ok: true,
      repo: "Genepedia/Genepedia",
      person: personId,
      action: "post",
      message: newMessage,
      messages: savedMessages,
      commit,
      change_id: result?.change_id || null,
      branch: "",
      posted_at: now,
    }, 201);
    return json(request, env, {
      ok: true,
      repo: "Genepedia/Genepedia",
      person: personId,
      action: "delete",
      deleted_id: deleteId,
      messages: savedMessages,
      commit,
      change_id: result?.change_id || null,
      branch: "",
      deleted_at: result?.committed_at || now,
    });
  }

  function normalizeMemorial(value) {
    return typeof h.normalizeMemorial === "function" ? h.normalizeMemorial(value) : {
      id: String(value?.id || ""), name: String(value?.name || "").trim().slice(0, 300),
      cemetery: String(value?.cemetery || "").trim().slice(0, 500), birth_date: String(value?.birth_date || "").trim().slice(0, 100),
      death_date: String(value?.death_date || "").trim().slice(0, 100), inscription: String(value?.inscription || "").trim().slice(0, 12000),
      notes: String(value?.notes || "").trim().slice(0, 12000), source: String(value?.source || "").trim().slice(0, 2000),
    };
  }

  function memorialRecords(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.memorials)) return value.memorials;
    if (Array.isArray(value?.records)) return value.records;
    if (Array.isArray(value?.results)) return value.results;
    return [];
  }

  async function searchMemorialsPage(env, site, query, limit, offset) {
    if (typeof store.searchMemorials === "function") {
      const result = await store.searchMemorials(env, site, query, { limit, offset });
      const rows = Array.isArray(result?.results) ? result.results : [];
      const records = [];
      for (const row of rows) {
        const path = String(row.sourcePath || row.source_path || "");
        if (!path) throw apiError(502, "storage_index_invalid", "The memorial search index returned a record without a storage path.");
        const document = await getDocument(env, site, "data", path);
        if (!document) throw apiError(503, "storage_index_inconsistent", "A memorial search result is missing its stored record.");
        records.push(normalizeMemorial(parseJsonDocument(document, "Memorial record")));
      }
      return { results: records, total: Math.max(0, Number(result?.total) || 0) };
    }
    const index = await getJson(env, site, "data", "memorials/index.json", "Memorial index");
    const records = new Map();
    for (const raw of memorialRecords(index)) {
      const item = normalizeMemorial(raw);
      const key = item.id || `${item.name}\u0000${item.cemetery}\u0000${item.birth_date}\u0000${item.death_date}`;
      records.set(key, item);
    }
    // Native review submissions are not visible through list() until approval;
    // all records in the live memorials prefix are therefore public/approved.
    if (typeof store.list === "function") {
      let cursor;
      let pages = 0;
      do {
        const listed = await store.list(env, site, "data", { prefix: "memorials/", limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        const documents = Array.isArray(listed?.documents) ? listed.documents : [];
        for (const document of documents) {
          const path = String(document.path || "");
          if (!path.endsWith(".json") || path === "memorials/index.json") continue;
          const fullDocument = await getDocument(env, site, "data", path);
          if (!fullDocument) continue;
          const raw = parseJsonDocument(fullDocument, "Memorial record");
          const item = normalizeMemorial(raw);
          if (!item.name) continue;
          const key = item.id || path;
          records.set(key, item);
        }
        cursor = listed?.next_cursor || null;
        pages += 1;
        if (pages >= 100) throw apiError(503, "memorial_search_too_large", "The memorial index is too large to search through the compatibility reader.");
      } while (cursor);
    }
    const needle = String(query || "").toLocaleLowerCase();
    const matching = [...records.values()].filter((item) => !needle || Object.values(item).join(" ").toLocaleLowerCase().includes(needle));
    return { results: matching.slice(offset, offset + limit), total: matching.length };
  }

  async function handleMemorials(request, env, site) {
    if (site !== "gravepedia") notFound("This API endpoint is only available for Gravepedia.");
    if (request.method === "GET") {
      const url = new URL(request.url);
      const query = String(url.searchParams.get("q") || "").trim().replace(/\s+/g, " ").slice(0, 200);
      const rawLimit = Number(url.searchParams.get("limit") || 50);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 50;
      const rawOffset = Number(url.searchParams.get("offset") || 0);
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.min(1_000_000, Math.trunc(rawOffset))) : 0;
      const page = await searchMemorialsPage(env, site, query, limit, offset);
      const total = page.total;
      return json(request, env, { success: true, query, results: page.results, total, offset, limit, next_offset: offset + page.results.length < total ? offset + page.results.length : null });
    }
    const user = await requireEditor(request, env);
    const payload = await h.readJson(request, 64_000);
    const memorial = normalizeMemorial(payload);
    if (!memorial.name) throw apiError(400, "missing_name", "A memorial name is required.");
    const key = idempotencyKey(request, "memorial");
    const submissionId = await stableResourceId("mem", site, loginOf(user.user), key);
    const idempotencyRequest = { action: "memorial.submit", memorial: { ...memorial, id: "" } };
    memorial.id = submissionId;
    const record = { ...memorial, submitted_at: nowIso(), submitted_by: user.user.login, status: "pending" };
    const path = `memorials/pending/${submissionId}.json`;
    const file = { namespace: "data", path, content: jsonText(record), contentType: "application/json; charset=utf-8" };
    const change = await store.submit(env, {
      site,
      actor: user.user,
      files: [file],
      expectedVersions: { [`data:${path}`]: 0 },
      idempotencyKey: key,
      idempotencyRequest,
      title: `Memorial submission: ${memorial.name}`.slice(0, 240),
      body: `A new memorial record was submitted for review.\n\n- Submission ID: \`${submissionId}\`\n- Submitted by: @${user.user.login}\n- Pending data path: \`${path}\`\n\nThis record is not included in public search until a maintainer approves this change.`,
    });
    return json(request, env, {
      success: true,
      status: "pending",
      submission_id: submissionId,
      message: "Your memorial has been submitted for review.",
      pull_request: nativeChangeSummary(change)?.url || "",
      change_id: change.change_id,
    }, 201);
  }

  function normalizeWindow(value) {
    const name = String(value || "all").trim().toLowerCase();
    const normalized = !name || name === "all_time" ? "all" : name;
    if (normalized !== "all" && !Object.hasOwn(STATISTICS_WINDOWS, normalized)) throw apiError(400, "invalid_window", "Use one of the supported statistics windows.");
    return normalized;
  }

  function statsObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function statsMap(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function baselineProfileCounts(value) {
    const source = statsObject(value);
    const entries = source.profiles && typeof source.profiles === "object" ? source.profiles : source.views;
    const result = Object.create(null);
    for (const [key, item] of Object.entries(statsMap(entries))) {
      const count = item && typeof item === "object" ? item.views : item;
      result[key] = Math.max(0, Number(count) || 0);
    }
    return result;
  }

  function baselineQueryCounts(value) {
    const source = statsObject(value);
    const result = Object.create(null);
    for (const [key, item] of Object.entries(statsMap(source.queries))) result[key] = Math.max(0, Number(item?.count) || 0);
    return result;
  }

  function eventShape(value) {
    const item = statsObject(value);
    const payload = statsObject(item.payload);
    const type = String(item.event_type || item.event || payload.event_type || payload.event || "");
    return {
      event: type,
      person_id: String(item.person_id || payload.person_id || ""),
      kind: String(item.kind || payload.kind || "person") === "pet" ? "pet" : "person",
      query: String(item.query || payload.query || "").trim().replace(/\s+/gu, " ").toLowerCase().slice(0, 80),
      result_count: Math.max(0, Number(item.result_count ?? payload.result_count) || 0),
      created_at: String(item.created_at || payload.created_at || ""),
    };
  }

  async function readNativeEvents(env, site, since = null, limit = 1000) {
    if (typeof store.queryStatistics !== "function") return { events: [], total: 0 };
    const events = [];
    let total = 0;
    let offset = 0;
    const batchLimit = Math.max(1, Math.min(1000, limit));
    const maxEvents = 100_000;
    do {
      const page = await store.queryStatistics(env, { site, since: since || undefined, limit: batchLimit, offset });
      const items = Array.isArray(page?.events) ? page.events : [];
      total = Math.max(total, Number(page?.total) || 0);
      events.push(...items.map(eventShape));
      offset += items.length;
      if (!items.length || items.length < batchLimit || offset >= maxEvents) break;
    } while (offset < total);
    if (total > maxEvents) throw apiError(503, "statistics_query_too_large", "Statistics event detail exceeds the reporting limit.");
    return { events, total };
  }

  function addCount(map, key, amount = 1) {
    map[key] = Math.max(0, Number(map[key]) || 0) + Math.max(0, Number(amount) || 0);
  }

  function addCountMap(target, source) {
    for (const [key, count] of Object.entries(source || {})) addCount(target, key, count);
    return target;
  }

  function eventProfileKey(event) {
    return `${event.kind === "pet" ? "pet" : "person"}:${event.person_id}`;
  }

  function validProfileKey(key) {
    const match = String(key).match(/^(person|pet):([A-Za-z0-9_-]{1,64})$/);
    return match ? { kind: match[1], person_id: match[2] } : null;
  }

  function makeLeaderboard(counts, kind, limit = 24, profiles = {}, queries = {}) {
    const sorted = Object.entries(counts).sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      (Number(rightValue) - Number(leftValue)) || leftKey.localeCompare(rightKey));
    const result = [];
    for (const [key, rawCount] of sorted) {
      const count = Math.max(0, Number(rawCount) || 0);
      if (kind === "profiles") {
        const parsed = validProfileKey(key);
        if (!parsed) continue;
        const item = { ...parsed, views: count };
        const meta = statsObject(profiles[key]);
        if (meta.lastViewedAt) item.last_viewed_at = String(meta.lastViewedAt);
        result.push(item);
      } else {
        const query = String(key).trim();
        if (!query) continue;
        const item = { query, count };
        const meta = statsObject(queries[query]);
        if (meta.lastResultCount !== undefined) item.last_result_count = Math.max(0, Number(meta.lastResultCount) || 0);
        if (meta.lastSearchedAt) item.last_searched_at = String(meta.lastSearchedAt);
        result.push(item);
      }
      if (result.length >= limit) break;
    }
    return result;
  }

  function legacyWindowCounts(hourlyRaw, dailyRaw, window, nowMs, field) {
    if (window === "all") return Object.create(null);
    const cutoff = nowMs - STATISTICS_WINDOWS[window] * 3_600_000;
    const hourlyZoneStart = nowMs - 192 * 3_600_000;
    const hourly = statsMap(statsObject(hourlyRaw).hours);
    const daily = statsMap(statsObject(dailyRaw).days);
    const result = Object.create(null);
    for (const [key, bucketValue] of Object.entries(hourly)) {
      const timestamp = Date.parse(`${key}:00:00Z`);
      if (!Number.isFinite(timestamp) || timestamp < Math.max(cutoff, hourlyZoneStart) || timestamp > nowMs) continue;
      for (const [label, count] of Object.entries(statsMap(statsObject(bucketValue)[field]))) addCount(result, label, count);
    }
    if (cutoff >= hourlyZoneStart) return result;
    const firstWholeDay = Math.floor(cutoff / 86_400_000) * 86_400_000;
    const dailyOnlyEnd = Math.floor(hourlyZoneStart / 86_400_000) * 86_400_000 - 86_400_000;
    for (const [key, bucketValue] of Object.entries(daily)) {
      const timestamp = Date.parse(`${key}T00:00:00Z`);
      if (!Number.isFinite(timestamp) || timestamp < firstWholeDay || timestamp > dailyOnlyEnd) continue;
      for (const [label, count] of Object.entries(statsMap(statsObject(bucketValue)[field]))) addCount(result, label, count);
    }
    return result;
  }

  function addNativeEventsToCounts(events, profileCounts, queryCounts, fromMs = -Infinity, toMs = Infinity) {
    for (const event of events) {
      const timestamp = Date.parse(event.created_at);
      if (!Number.isFinite(timestamp) || timestamp < fromMs || timestamp > toMs) continue;
      if (["search", "search_query"].includes(event.event)) {
        if (event.query) addCount(queryCounts, event.query, 1);
      } else if (["profile_view", "profile-view"].includes(event.event) && /^[A-Za-z0-9_-]{1,64}$/.test(event.person_id)) {
        addCount(profileCounts, eventProfileKey(event), 1);
      }
    }
  }

  async function readStatisticsBaseline(env, site) {
    const names = ["profile-views", "search-queries", "hourly-rollups", "daily-rollups", "leaderboards", "summary", "manifest"];
    const pairs = await Promise.all(names.map(async (name) => {
      const value = await getJson(env, site, "data", `statistics/${name}.json`, `Stored statistics ${name}`);
      if (value === null) return [name, null];
      const record = objectOrInvalid(value, `Stored statistics ${name}`);
      const nestedKey = {
        "profile-views": ["profiles", "views"],
        "search-queries": ["queries"],
        "hourly-rollups": ["hours"],
        "daily-rollups": ["days"],
      }[name] || [];
      for (const key of nestedKey) {
        if (record[key] !== undefined && (!record[key] || typeof record[key] !== "object" || Array.isArray(record[key]))) {
          throw apiError(502, "storage_file_invalid", `Stored statistics ${name} has an invalid ${key} index.`);
        }
      }
      return [name, record];
    }));
    return Object.fromEntries(pairs);
  }

  async function aggregateNativeStatistics(env, site, since = null, until = null) {
    if (typeof store.aggregateStatistics === "function") {
      return store.aggregateStatistics(env, { site, ...(since ? { since } : {}), ...(until ? { until } : {}) });
    }
    const start = since ? Date.parse(since) : -Infinity;
    const end = until ? Date.parse(until) : Infinity;
    const { events } = await readNativeEvents(env, site);
    const byPerson = new Map();
    const byQuery = new Map();
    const byType = new Map();
    let total = 0;
    for (const event of events) {
      const timestamp = Date.parse(event.created_at);
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;
      total += 1;
      addCount(byType, event.event, 1);
      if (["search", "search_query"].includes(event.event) && event.query) addCount(byQuery, event.query, 1);
      else if (["profile_view", "profile-view"].includes(event.event) && /^[A-Za-z0-9_-]{1,64}$/.test(event.person_id)) addCount(byPerson, `${event.kind}:${event.person_id}`, 1);
    }
    return {
      total,
      by_event_type: [...byType.entries()].map(([event_type, count]) => ({ event_type, count })),
      by_person: [...byPerson.entries()].map(([key, count]) => {
        const parsed = validProfileKey(key);
        return { ...(parsed || {}), count };
      }),
      by_query: [...byQuery.entries()].map(([query, count]) => ({ query, count })),
    };
  }

  function countsFromAggregate(aggregate) {
    const profiles = Object.create(null);
    const queries = Object.create(null);
    const profileMeta = Object.create(null);
    const queryMeta = Object.create(null);
    for (const row of Array.isArray(aggregate?.by_person) ? aggregate.by_person : []) {
      const kind = String(row.kind || "person") === "pet" ? "pet" : "person";
      const personId = String(row.person_id || "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(personId)) continue;
      const key = `${kind}:${personId}`;
      profiles[key] = Math.max(0, Number(row.count) || 0);
      profileMeta[key] = { views: profiles[key], lastViewedAt: String(row.last_at || row.lastViewedAt || "") };
    }
    for (const row of Array.isArray(aggregate?.by_query) ? aggregate.by_query : []) {
      const query = String(row.query || "").trim().replace(/\s+/gu, " ").toLowerCase().slice(0, 80);
      if (!query) continue;
      queries[query] = Math.max(0, Number(row.count) || 0);
      queryMeta[query] = {
        count: queries[query],
        lastSearchedAt: String(row.last_at || row.lastSearchedAt || ""),
        lastResultCount: Math.max(0, Number(row.last_result_count ?? row.lastResultCount) || 0),
      };
    }
    const byType = Object.create(null);
    for (const row of Array.isArray(aggregate?.by_event_type) ? aggregate.by_event_type : []) byType[String(row.event_type || "")] = Math.max(0, Number(row.count) || 0);
    return { profiles, queries, profileMeta, queryMeta, byType };
  }

  async function buildStatistics(env, site) {
    const stored = await readStatisticsBaseline(env, site);
    const profileMeta = { ...statsMap(statsObject(stored["profile-views"]).profiles) };
    const queryMeta = { ...statsMap(statsObject(stored["search-queries"]).queries) };
    const profileCountsAll = baselineProfileCounts(stored["profile-views"]);
    const queryCountsAll = baselineQueryCounts(stored["search-queries"]);
    const now = nowIso();
    const nowMs = Date.now();
    const hourly = statsObject(stored["hourly-rollups"]);
    const daily = statsObject(stored["daily-rollups"]);
    const dailyToday = statsObject(statsMap(daily.days)[now.slice(0, 10)]);
    const [allNativeRaw, todayNativeRaw, ...windowNativeRaw] = await Promise.all([
      aggregateNativeStatistics(env, site),
      aggregateNativeStatistics(env, site, `${now.slice(0, 10)}T00:00:00.000Z`, now),
      ...Object.entries(STATISTICS_WINDOWS).map(([window, hours]) => aggregateNativeStatistics(env, site, new Date(nowMs - hours * 3_600_000).toISOString(), now)),
    ]);
    const allNative = countsFromAggregate(allNativeRaw);
    const todayNative = countsFromAggregate(todayNativeRaw);
    addCountMap(profileCountsAll, allNative.profiles);
    addCountMap(queryCountsAll, allNative.queries);
    for (const [key, meta] of Object.entries(allNative.profileMeta)) profileMeta[key] = { ...statsObject(profileMeta[key]), ...meta };
    for (const [key, meta] of Object.entries(allNative.queryMeta)) queryMeta[key] = { ...statsObject(queryMeta[key]), ...meta };
    const aggregatesByWindow = Object.create(null);
    Object.keys(STATISTICS_WINDOWS).forEach((window, index) => { aggregatesByWindow[window] = countsFromAggregate(windowNativeRaw[index]); });
    const todayProfileViews = Math.max(0, Number(todayNative.byType.profile_view || todayNative.byType["profile-view"]) || 0);
    const todaySearches = Math.max(0, Number(todayNative.byType.search || 0) + Number(todayNative.byType.search_query || 0));
    const eventTotal = Math.max(0, Number(allNativeRaw?.total) || 0);
    const profileBoards = Object.create(null);
    const searchBoards = Object.create(null);
    for (const window of STATISTICS_WINDOW_NAMES) {
      let profileCounts;
      let queryCounts;
      if (window === "all") {
        profileCounts = { ...profileCountsAll };
        queryCounts = { ...queryCountsAll };
      } else {
        profileCounts = legacyWindowCounts(hourly, daily, window, nowMs, "profiles");
        queryCounts = legacyWindowCounts(hourly, daily, window, nowMs, "queries");
        addCountMap(profileCounts, aggregatesByWindow[window]?.profiles || {});
        addCountMap(queryCounts, aggregatesByWindow[window]?.queries || {});
      }
      profileBoards[window] = makeLeaderboard(profileCounts, "profiles", 24, profileMeta, queryMeta);
      searchBoards[window] = makeLeaderboard(queryCounts, "searches", 24, profileMeta, queryMeta);
    }
    // Native aggregate group rows are intentionally capped by the storage
    // layer. Use exact event-type rollups for totals so sites with more than
    // 5,000 distinct profiles or searches do not silently undercount.
    const baselineProfileViews = Object.values(baselineProfileCounts(stored["profile-views"]))
      .reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    const baselineSearches = Object.values(baselineQueryCounts(stored["search-queries"]))
      .reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    const totalProfileViews = baselineProfileViews
      + Math.max(0, Number(allNative.byType.profile_view || allNative.byType["profile-view"]) || 0);
    const totalSearches = baselineSearches
      + Math.max(0, Number(allNative.byType.search || 0) + Number(allNative.byType.search_query || 0));
    const peopleGroupsTotal = Math.max(0, Number(allNativeRaw?.people_groups_total ?? allNativeRaw?.by_person?.length) || 0);
    const queryGroupsTotal = Math.max(0, Number(allNativeRaw?.query_groups_total ?? allNativeRaw?.by_query?.length) || 0);
    const profilesTrackedCapped = peopleGroupsTotal > (Array.isArray(allNativeRaw?.by_person) ? allNativeRaw.by_person.length : 0);
    const queriesTrackedCapped = queryGroupsTotal > (Array.isArray(allNativeRaw?.by_query) ? allNativeRaw.by_query.length : 0);
    const summary = {
      schema: "genepedia/statistics/summary@2",
      generatedAt: now,
      windows: STATISTICS_WINDOW_NAMES,
      totals: {
        profileViews: totalProfileViews,
        searches: totalSearches,
        profilesTracked: Object.keys(profileCountsAll).length,
        queriesTracked: Object.keys(queryCountsAll).length,
        profilesTrackedCapped,
        queriesTrackedCapped,
      },
      today: {
        date: now.slice(0, 10),
        profileViews: Math.max(0, Number(dailyToday.profileViews) || 0) + todayProfileViews,
        searches: Math.max(0, Number(dailyToday.searches) || 0) + todaySearches,
      },
      popularProfiles: profileBoards.all.slice(0, 8),
      popularSearches: searchBoards.all.slice(0, 8),
      leaderboards: { profiles: profileBoards, searches: searchBoards },
      nativeEvents: eventTotal,
    };
    const leaderboards = {
      schema: "genepedia/statistics/leaderboards@1",
      generatedAt: now,
      windows: STATISTICS_WINDOW_NAMES,
      profiles: profileBoards,
      searches: searchBoards,
    };
    return { stored, summary, leaderboards, profileCountsAll, queryCountsAll, profileMeta, queryMeta, eventTotal };
  }

  function invalidateStatistics(env, site) {
    const db = env?.DB;
    if (!db || (typeof db !== "object" && typeof db !== "function")) return;
    statisticsCache.get(db)?.delete(String(site));
  }

  function cachedBuildStatistics(env, site) {
    const db = env?.DB;
    if (!db || (typeof db !== "object" && typeof db !== "function")) return buildStatistics(env, site);
    let bySite = statisticsCache.get(db);
    if (!bySite) {
      bySite = new Map();
      statisticsCache.set(db, bySite);
    }
    const current = bySite.get(site);
    if (current && current.expiresAt > Date.now()) return current.promise;
    const entry = {
      expiresAt: Date.now() + STATISTICS_CACHE_TTL_MS,
      promise: Promise.resolve().then(() => buildStatistics(env, site)),
    };
    bySite.set(site, entry);
    entry.promise.catch(() => {
      if (bySite.get(site) === entry) bySite.delete(site);
    });
    return entry.promise;
  }

  async function handleStatistics(request, env, site, legacyProfileViews = false) {
    if (site !== "genepedia") notFound("This API endpoint is only available for Genepedia.");
    if (request.method === "POST") {
      const payload = await h.readJson(request, 64_000);
      const event = h.normalizeStatisticsEvent(payload, legacyProfileViews);
      const suppliedKey = String(request.headers.get("Idempotency-Key") || "").trim();
      const key = suppliedKey ? idempotencyKey(request, "statistics") : "";
      const id = key ? `stats-${await h.sha256(`${site}\u0000${key}`)}` : h.randomHex(24);
      const recorded = await store.recordStatistic(env, {
        id,
        site,
        event_type: event.event,
        person_id: event.person_id || "",
        kind: event.kind || "",
        path: event.person_id ? `pages/${event.kind === "pet" ? "pets" : "people"}/${event.person_id}/` : "",
        query: event.query || "",
        result_count: Number(event.result_count || 0),
        created_at: event.created_at,
      });
      invalidateStatistics(env, site);
      const publish = { synced: false, buffered: false, pending: false, storage: "D1", event_id: recorded?.event_id || id };
      if (legacyProfileViews) return json(request, env, {
        ok: true,
        profile: event.event === "profile_view" ? { key: `${event.kind}:${event.person_id}`, kind: event.kind, person_id: event.person_id, views: null, last_viewed_at: event.created_at } : null,
        publish,
        storage_path: "native-statistics",
      }, 202);
      if (event.event === "search") return json(request, env, { ok: true, event: "search", search: { query: event.query, count: null, last_result_count: event.result_count, last_searched_at: event.created_at }, publish, storage_root: "native-statistics" }, 202);
      return json(request, env, { ok: true, event: "profile_view", profile: { key: `${event.kind}:${event.person_id}`, kind: event.kind, person_id: event.person_id, views: null, last_viewed_at: event.created_at }, publish, storage_root: "native-statistics" }, 202);
    }
    if (request.method !== "GET") return checkMethod(request, env, ["GET", "POST"]);
    const url = new URL(request.url);
    const metric = String(url.searchParams.get("metric") || "popular_profiles").trim().toLowerCase();
    const rawLimit = Number(url.searchParams.get("limit") || 4);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(24, Math.trunc(rawLimit))) : 4;
    const windowName = normalizeWindow(url.searchParams.get("window") || "all");
    const fetchedAt = nowIso();
    const stats = await cachedBuildStatistics(env, site);
    if (!legacyProfileViews && ["summary", "all"].includes(metric)) {
      return json(request, env, { ok: true, metric, summary: stats.summary, windows: STATISTICS_WINDOW_NAMES, storage_root: "native-statistics", fetched_at: fetchedAt });
    }
    if (!legacyProfileViews && ["leaderboards", "windows"].includes(metric)) {
      return json(request, env, { ok: true, metric: "leaderboards", windows: STATISTICS_WINDOW_NAMES, leaderboards: stats.leaderboards, storage_root: "native-statistics", fetched_at: fetchedAt });
    }
    if (!legacyProfileViews && ["popular_searches", "searches"].includes(metric)) {
      return json(request, env, { ok: true, metric: "popular_searches", window: windowName, searches: stats.leaderboards.searches[windowName].slice(0, limit), storage_root: "native-statistics", fetched_at: fetchedAt });
    }
    if (!legacyProfileViews && metric === "manifest") {
      return json(request, env, { ok: true, metric, manifest: stats.stored.manifest || { schema: "genepedia/statistics/manifest@2", windows: STATISTICS_WINDOW_NAMES }, fetched_at: fetchedAt });
    }
    if (legacyProfileViews) return json(request, env, { ok: true, window: windowName, profiles: stats.leaderboards.profiles[windowName].slice(0, limit), storage_path: "native-statistics", fetched_at: fetchedAt });
    return json(request, env, { ok: true, metric: "popular_profiles", window: windowName, profiles: stats.leaderboards.profiles[windowName].slice(0, limit), storage_path: "native-statistics", fetched_at: fetchedAt });
  }

  function constantTimeEqual(left, right) {
    return typeof h.constantTimeEqual === "function" ? h.constantTimeEqual(left, right) : String(left) === String(right);
  }

  async function flushToken(request, env) {
    const configured = [
      env.STATISTICS_FLUSH_TOKEN,
      env.GITHUB_STATISTICS_FLUSH_TOKEN,
      env.STORAGE_MIGRATION_TOKEN,
      env.GITHUB_MIGRATION_TOKEN,
      env.MIGRATION_TOKEN,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    if (!configured.length) throw apiError(403, "flush_token_not_configured", "Statistics flush is not configured.");
    const url = new URL(request.url);
    let bodyToken = "";
    if (request.method === "POST") {
      const type = String(request.headers.get("Content-Type") || "").toLowerCase();
      if (type.includes("application/json")) {
        const payload = await h.readJson(request, 16_384);
        bodyToken = String(payload.token || "").trim();
      } else if (type.includes("application/x-www-form-urlencoded")) {
        bodyToken = String(new URLSearchParams(await request.text()).get("token") || "").trim();
      }
    }
    const provided = String(request.headers.get("X-Statistics-Flush-Token") || url.searchParams.get("token") || bodyToken).trim();
    if (!provided || !configured.some((token) => constantTimeEqual(token, provided))) throw apiError(403, "unauthorized", "A valid flush token is required.");
  }

  async function handleStatisticsFlush(request, env, site) {
    if (site !== "genepedia") notFound("This API endpoint is only available for Genepedia.");
    await flushToken(request, env);
    if (typeof store.drainLegacyStatistics !== "function") throw apiError(503, "statistics_drain_unavailable", "Native statistics queue draining is not available.");
    const flush = await store.drainLegacyStatistics(env, site);
    invalidateStatistics(env, site);
    const totals = typeof store.statisticsTotals === "function" ? await store.statisticsTotals(env, { site }) : null;
    return json(request, env, { ok: true, flush: { ...statsObject(flush), storage: "D1", synced: false }, totals, storage_root: "native-statistics", fetched_at: nowIso() });
  }

  async function handleContact(request, env, site) {
    const user = await requireEditor(request, env);
    const payload = await h.readJson(request, 64_000);
    const subject = String(payload.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
    const message = String(payload.message || "").trim().slice(0, 8_000);
    const details = String(payload.details || "").trim().slice(0, 4_000);
    if (!subject || !message) throw apiError(400, "invalid_contact", "A subject and message are required.");
    const reason = ["question", "bug", "enhancement"].includes(String(payload.reason || "").toLowerCase()) ? String(payload.reason).toLowerCase() : "question";
    const key = idempotencyKey(request, "contact");
    const id = await stableResourceId("contact", site, loginOf(user.user), key);
    const createdAt = nowIso();
    const ticket = {
      id,
      site,
      reason,
      subject,
      message,
      details,
      author: loginOf(user.user),
      created_at: createdAt,
      status: "open",
    };
    const path = `support/contacts/${id}.json`;
    const result = await store.apply(env, {
      site,
      actor: user.user,
      files: [{ namespace: "data", path, content: jsonText(ticket), contentType: "application/json; charset=utf-8" }],
      expectedVersions: { [`data:${path}`]: 0 },
      idempotencyKey: key,
      idempotencyRequest: { action: "contact.submit", site, reason, subject, message, details },
      action: "contact.submit",
      summary: `Contact submission: ${subject}`.slice(0, 240),
    });
    const savedTicket = await getJson(env, site, "data", path, "Submitted contact record");
    const savedCreatedAt = String(savedTicket?.created_at || createdAt);
    return json(request, env, { ok: true, site, reason, ticket_id: id, number: null, url: "", author: loginOf(user.user), created_at: savedCreatedAt, change_id: result.change_id }, 201);
  }

  return {
    async handle(request, env, site, endpoint) {
      switch (endpoint) {
        case "profiles/self": {
          const rejected = checkMethod(request, env, ["POST"]);
          return rejected || handleSelfProfile(request, env, site);
        }
        case "maintainers": {
          const rejected = checkMethod(request, env, ["GET", "POST"]);
          return rejected || handleMaintainers(request, env, site);
        }
        case "talk": {
          const rejected = checkMethod(request, env, ["GET", "POST"]);
          return rejected || handleTalk(request, env, site);
        }
        case "memorials": {
          const rejected = checkMethod(request, env, ["GET", "POST"]);
          return rejected || handleMemorials(request, env, site);
        }
        case "statistics":
          return handleStatistics(request, env, site, false);
        case "statistics/profile-views":
          return handleStatistics(request, env, site, true);
        case "statistics/flush": {
          const rejected = checkMethod(request, env, ["GET", "POST"]);
          return rejected || handleStatisticsFlush(request, env, site);
        }
        case "contact": {
          const rejected = checkMethod(request, env, ["POST"]);
          return rejected || handleContact(request, env, site);
        }
        default:
          return null;
      }
    },
  };
}
