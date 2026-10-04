import assert from "node:assert/strict";
import worker from "../dist/server/index.js";

const records = [
  {
    id: "memorial-1",
    name: "Amina Ndlovu",
    cemetery: "Harare Memorial Park",
    birth_date: "1940-03-12",
    death_date: "2018-11-04",
    inscription: "Beloved mother",
    notes: "",
    source: "https://example.org/record/1",
  },
  {
    id: "memorial-2",
    name: "Peter Moyo",
    cemetery: "Bulawayo Cemetery",
    birth_date: "1938",
    death_date: "2001",
    inscription: "Rest in peace",
    notes: "",
    source: "",
  },
];
const approvedMemorial = {
  id: "approved-memorial",
  name: "Tariro Ncube",
  cemetery: "Harare Memorial Park",
  status: "pending",
};
const originalFetch = globalThis.fetch;
let deniedUserWrites = 0;
let fallbackWrites = 0;
let failDatabasePullRequestCreation = false;
let rolledBackPullRequests = 0;
let rolledBackSiteBranches = 0;
let welcomeStarPuts = 0;
let welcomeUserFollowPuts = 0;
let welcomeOrganizationFollowMutations = 0;
let welcomeUserIsFollowed = false;
let welcomeOrganizationIsFollowed = false;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = init.method || input?.method || "GET";
  const authorization = init.headers?.Authorization || input?.headers?.get?.("Authorization") || "";
  if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
    return new Response(JSON.stringify({ access_token: "test-user-token" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  assert.equal(url.hostname, "api.github.com", "route test should only fetch the mocked GitHub API");
  if (url.pathname === "/user/starred/Genepedia/Genepedia" && method === "PUT") {
    welcomeStarPuts += 1;
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/users/followed-user" && method === "GET") {
    return new Response(JSON.stringify({ login: "followed-user", type: "User" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/user/following/followed-user") {
    if (method === "PUT") {
      welcomeUserFollowPuts += 1;
      welcomeUserIsFollowed = true;
      return new Response(null, { status: 204 });
    }
    return welcomeUserIsFollowed ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
  }
  if (url.pathname === "/users/Genepedia" && method === "GET") {
    return new Response(JSON.stringify({ login: "Genepedia", type: "Organization" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/user/following/Genepedia") {
    return new Response(null, { status: 404 });
  }
  if (url.pathname === "/graphql" && method === "POST") {
    const query = String(JSON.parse(init.body || "{}").query || "");
    if (query.includes("OrganizationFollowState")) {
      return new Response(JSON.stringify({ data: { organization: { id: "org-id", login: "Genepedia", viewerIsFollowing: welcomeOrganizationIsFollowed } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (query.includes("FollowOrganization")) {
      welcomeOrganizationFollowMutations += 1;
      welcomeOrganizationIsFollowed = true;
      return new Response(JSON.stringify({ data: { followOrganization: { organization: { login: "Genepedia", viewerIsFollowing: true } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }
  if (url.pathname === "/user") {
    return new Response(JSON.stringify({ id: 41, login: "test-user", name: "Test User", avatar_url: "https://avatars.example/test", html_url: "https://github.com/test-user" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia" && method === "GET") {
    return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia/contents/pages/people/person-14/data/talk.json") {
    if (method === "PUT") return new Response(JSON.stringify({ commit: { sha: "talk-commit" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia/commits" && url.searchParams.get("path") === "pages/people/person-14/index.html") {
    return new Response(JSON.stringify([{ author: { login: "current-owner" } }, { author: { login: "test-user" } }]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia/commits" && ["pages/people/29/index.html", "pages/people/29/profile.html", "pages/people/29/data/profile.html", "pages/people/29/data/talk.json"].includes(url.searchParams.get("path"))) {
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia/commits" && url.searchParams.get("path") === "pages/login.html") {
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Gravepedia/commits" && url.searchParams.get("path") === "pages/login.html") {
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia/commits" && url.searchParams.get("path") === "pages/about.html") {
    if (url.searchParams.get("page") === "4") {
      return new Response(JSON.stringify([{ author: { login: "older-author" } }, { author: { login: "test-user" } }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const recentCommits = Array.from({ length: 100 }, (_, index) => ({ author: { login: index === 99 ? "recent-page-oldest" : "recent-author" } }));
    const links = '<https://api.github.com/repos/Genepedia/Genepedia/commits?path=pages%2Fabout.html&per_page=100&page=4>; rel="last"';
    return new Response(JSON.stringify(recentCommits), { status: 200, headers: { "Content-Type": "application/json", Link: links } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia/contents/data/maintainer-invitations.json") {
    const ledger = { version: 1, items: [{ id: "maint-pending-1", target: { key: "profile:person-14" }, kind: "request", status: "pending", person: { githubLogin: "candidate-user" } }] };
    const content = Buffer.from(JSON.stringify(ledger)).toString("base64");
    return new Response(JSON.stringify({ type: "file", content }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia/git/ref/heads/main" && method === "GET") {
    return new Response(JSON.stringify({ object: { sha: "base-commit" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia/git/commits/base-commit" && method === "GET") {
    return new Response(JSON.stringify({ tree: { sha: "base-tree" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia/git/blobs" && method === "POST") {
    return new Response(JSON.stringify({ sha: "site-blob" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia/git/trees" && method === "POST") {
    return new Response(JSON.stringify({ sha: "site-tree" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia/git/commits" && method === "POST") {
    return new Response(JSON.stringify({ sha: "site-commit", html_url: "https://github.com/Genepedia/Genepedia/commit/site-commit" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia/git/refs" && method === "POST") {
    return new Response(JSON.stringify({ ref: "refs/heads/maintainer-test" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia-Database/git/refs" && method === "POST") {
    return new Response(JSON.stringify({ ref: "refs/heads/maintainer-test-db" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia/pulls" && method === "POST") {
    return new Response(JSON.stringify({ number: 51, html_url: "https://github.com/Genepedia/Genepedia/pull/51", title: "Approve maintainer", state: "open" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia-Database/pulls" && method === "POST") {
    return new Response(JSON.stringify({ message: "Validation failed" }), { status: 422, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname.startsWith("/repos/Genepedia/Genepedia-Database/git/refs/heads/") && method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  if (failDatabasePullRequestCreation && url.pathname === "/repos/Genepedia/Genepedia/pulls/51" && method === "PATCH") {
    rolledBackPullRequests += 1;
    return new Response(JSON.stringify({ number: 51, state: "closed" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (failDatabasePullRequestCreation && url.pathname.startsWith("/repos/Genepedia/Genepedia/git/refs/heads/") && method === "DELETE") {
    rolledBackSiteBranches += 1;
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database" && method === "GET") {
    return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database/contents/people/ownership/0/person-14.json") {
    const ownership = { creator: { githubLogin: "test-user" }, owner: { githubLogin: "current-owner" }, maintainers: [{ githubLogin: "current-maintainer" }] };
    const content = Buffer.from(JSON.stringify(ownership)).toString("base64");
    return new Response(JSON.stringify({ type: "file", content }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database/contents/people/ownership/0/person-77.json") {
    const ownership = { creator: { githubLogin: "another-user" }, owner: { githubLogin: "test-user" }, maintainers: [] };
    const content = Buffer.from(JSON.stringify(ownership)).toString("base64");
    return new Response(JSON.stringify({ type: "file", content }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Media/pulls/9" && method === "GET") {
    return new Response(JSON.stringify({ number: 9, head: { ref: "media-upload-person-77" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Media/pulls/9/files" && method === "GET") {
    return new Response(JSON.stringify([{ filename: "pages/people/person-77/avatar.png" }]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if ((url.pathname === "/repos/Genepedia/Genepedia/pulls/17/merge" && method === "PUT")
    || (url.pathname === "/repos/Genepedia/Genepedia/pulls/17" && method === "PATCH")
    || (url.pathname === "/repos/Genepedia/Genepedia-Media/pulls/9/merge" && method === "PUT")
    || (url.pathname === "/repos/Genepedia/Genepedia-Media/pulls/9" && method === "PATCH")) {
    if (authorization === "Bearer test-user-token") {
      deniedUserWrites += 1;
      return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    if (authorization === "Bearer validation-only-token") {
      fallbackWrites += 1;
      const data = method === "PUT" ? { merged: true, sha: "fallback-merge" } : { number: 9, state: "closed" };
      return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database/git/ref/heads/main" && method === "GET") {
    return new Response(JSON.stringify({ object: { sha: "base-commit" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database/git/commits/base-commit" && method === "GET") {
    return new Response(JSON.stringify({ tree: { sha: "base-tree" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database/git/blobs" && method === "POST") {
    return new Response(JSON.stringify({ sha: "new-blob" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database/git/trees" && method === "POST") {
    return new Response(JSON.stringify({ sha: "new-tree" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database/git/commits" && method === "POST") {
    return new Response(JSON.stringify({ sha: "statistics-commit", html_url: "https://github.com/Genepedia/Genepedia-Database/commit/statistics-commit" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database/git/refs/heads/main" && method === "PATCH") {
    return new Response(JSON.stringify({ ref: "refs/heads/main" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Gravepedia/contents/data/memorials/index.json") {
    const content = Buffer.from(JSON.stringify(records)).toString("base64");
    return new Response(JSON.stringify({ type: "file", content }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/repos/Genepedia/Gravepedia/contents/data/memorials/pending") {
    return new Response(JSON.stringify([{
      type: "file",
      name: "approved-memorial.json",
      path: "data/memorials/pending/approved-memorial.json",
    }]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Gravepedia/contents/data/memorials/pending/approved-memorial.json") {
    const content = Buffer.from(JSON.stringify(approvedMemorial)).toString("base64");
    return new Response(JSON.stringify({ type: "file", content }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ message: "Not Found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
};

class MemoryD1 {
  events = [];
  meta = new Map();
  locks = new Map();
  sessions = new Map();
  oneTime = new Map([["oauth_states", new Map()], ["oauth_handoffs", new Map()]]);

  prepare(sql) {
    const statement = {
      sql,
      values: [],
      bind: (...values) => { statement.values = values; return statement; },
      first: async () => {
        if (sql.startsWith("SELECT payload, expires_at FROM worker_sessions WHERE session_id_hash = ?1")) {
          return this.sessions.get(statement.values[0]) || null;
        }
        const consumeMatch = sql.match(/^DELETE FROM (oauth_states|oauth_handoffs) WHERE (state_hash|handoff_hash) = \?1 AND expires_at > \?2 RETURNING payload$/);
        if (consumeMatch) {
          const [table, keyName] = consumeMatch.slice(1);
          const [key, now] = statement.values;
          const rows = this.oneTime.get(table);
          const row = rows.get(key);
          if (!row || row.expires_at <= now) return null;
          rows.delete(key);
          return { payload: row.payload };
        }
        if (sql.startsWith("INSERT INTO statistics_events") && sql.includes("SELECT ?1")) {
          const [event_id, payload, created_at, cap] = statement.values;
          if (this.events.length >= Number(cap)) return null;
          this.events.push({ event_id, payload, created_at });
          return { event_id };
        }
        if (sql.includes("COUNT(*) AS count FROM statistics_events")) return { count: this.events.length };
        if (sql.includes("SELECT meta_value FROM statistics_meta")) return { meta_value: this.meta.get(statement.values[0]) };
        if (sql.startsWith("INSERT INTO statistics_flush_locks")) {
          const [name, lockToken, expiresAt, now] = statement.values;
          const current = this.locks.get(name);
          if (current && current.expires_at > now) return null;
          this.locks.set(name, { lock_token: lockToken, expires_at: expiresAt });
          return { lock_token: lockToken };
        }
        return null;
      },
      all: async () => ({ results: this.events.slice(0, Number(statement.values[0]) || 500) }),
      run: async () => {
        if (sql.startsWith("INSERT INTO worker_sessions")) {
          const [session_id_hash, payload, expires_at] = statement.values;
          this.sessions.set(session_id_hash, { payload, expires_at });
        } else if (sql.startsWith("DELETE FROM worker_sessions WHERE session_id_hash = ?1")) {
          this.sessions.delete(statement.values[0]);
        } else if (sql.startsWith("DELETE FROM worker_sessions WHERE expires_at <= ?1")) {
          const now = statement.values[0];
          for (const [key, row] of this.sessions) if (row.expires_at <= now) this.sessions.delete(key);
        } else if (sql.startsWith("INSERT INTO oauth_states") || sql.startsWith("INSERT INTO oauth_handoffs")) {
          const table = sql.startsWith("INSERT INTO oauth_states") ? "oauth_states" : "oauth_handoffs";
          const [key, payload, expires_at] = statement.values;
          this.oneTime.get(table).set(key, { payload, expires_at });
        } else if (sql.startsWith("DELETE FROM oauth_states WHERE expires_at <= ?1") || sql.startsWith("DELETE FROM oauth_handoffs WHERE expires_at <= ?1")) {
          const table = sql.startsWith("DELETE FROM oauth_states") ? "oauth_states" : "oauth_handoffs";
          const now = statement.values[0];
          for (const [key, row] of this.oneTime.get(table)) if (row.expires_at <= now) this.oneTime.get(table).delete(key);
        } else if (sql.startsWith("INSERT INTO statistics_events")) {
          const [event_id, payload, created_at] = statement.values;
          this.events.push({ event_id, payload, created_at });
        } else if (sql.startsWith("DELETE FROM statistics_events WHERE event_id IN")) {
          const ids = new Set(statement.values);
          this.events = this.events.filter((event) => !ids.has(event.event_id));
        } else if (sql.startsWith("INSERT INTO statistics_meta")) {
          this.meta.set("last_flushed_at", statement.values[0]);
        } else if (sql.startsWith("DELETE FROM statistics_flush_locks")) {
          const [name, token] = statement.values;
          if (this.locks.get(name)?.lock_token === token) this.locks.delete(name);
        }
        return { success: true };
      },
    };
    return statement;
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

try {
  const env = { DB: new MemoryD1() };
  const discovery = await worker.fetch(new Request("https://api.genepedia.org/v1"), env);
  assert.equal(discovery.status, 200);
  const discoveryBody = await discovery.json();
  assert.equal(discoveryBody.api_version, 1);
  assert.equal(discoveryBody.sites.genepedia, "/v1/genepedia");
  assert.equal(discoveryBody.sites.gravepedia, "/v1/gravepedia");
  assert.equal(discoveryBody.openapi, "https://api.genepedia.org/v1/openapi.json");
  const openApiResponse = await worker.fetch(new Request(discoveryBody.openapi), env);
  assert.equal(openApiResponse.status, 200);
  assert.equal((await openApiResponse.json()).openapi, "3.1.0");

  const wrongSessionMethod = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/session", { method: "POST" }), env);
  assert.equal(wrongSessionMethod.status, 405);
  assert.equal(wrongSessionMethod.headers.get("Allow"), "GET");
  assert.equal((await wrongSessionMethod.json()).error, "method_not_allowed");

  const wrongPullRequestMethod = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/pull-requests", { method: "POST" }), env);
  assert.equal(wrongPullRequestMethod.status, 405);
  assert.equal(wrongPullRequestMethod.headers.get("Allow"), "GET");

  const wrongSelfProfileMethod = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/profiles/self"), env);
  assert.equal(wrongSelfProfileMethod.status, 405);
  assert.equal(wrongSelfProfileMethod.headers.get("Allow"), "POST");

  const config = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/github/config"), env);
  assert.equal(config.status, 200);
  const configBody = await config.json();
  assert.equal(configBody.repo, "Genepedia/Genepedia");
  assert.equal(configBody.oauth_configured, false);
  assert.equal(configBody.local_login_configured, false, "local login is disabled unless both username and a password are configured");
  assert.equal(JSON.stringify(configBody).includes("client_secret"), false, "public config must not expose secret material");

  const legacyConfig = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-config.php"), env);
  assert.equal(legacyConfig.status, 200, "legacy clients should continue to work during the extensionless API migration");
  assert.equal((await legacyConfig.json()).repo, configBody.repo);

  const localLoginEnv = {
    DB: new MemoryD1(),
    GITHUB_SESSION_SECRET: "test-session-secret-that-is-not-a-real-secret",
    GITHUB_PUBLISH_TOKEN: "validation-only-token",
    GITHUB_REVIEW_LOGIN: "local-reviewer",
    LOCAL_LOGIN_USERNAME: "local-reviewer",
    LOCAL_LOGIN_PASSWORD: "correct local password",
    LOCAL_LOGIN_DISPLAY_NAME: "Local Reviewer",
  };
  const localConfigResponse = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/github/config"), localLoginEnv);
  assert.equal((await localConfigResponse.json()).local_login_configured, true);

  const invalidLocalLogin = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/local/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "local-reviewer", password: "wrong password" }),
  }), localLoginEnv);
  assert.equal(invalidLocalLogin.status, 401);
  assert.equal((await invalidLocalLogin.json()).error, "invalid_credentials");

  const localLoginResponse = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/local/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "local-reviewer", password: "correct local password" }),
  }), localLoginEnv);
  assert.equal(localLoginResponse.status, 200);
  const localLoginBody = await localLoginResponse.json();
  assert.equal(localLoginBody.auth_type, "local");
  assert.match(localLoginBody.handoff, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(localLoginBody, "access_token"), false, "local login must not issue a bearer token");

  const localHandoffResponse = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: localLoginBody.handoff }),
  }), localLoginEnv);
  assert.equal(localHandoffResponse.status, 200);
  const localHandoffBody = await localHandoffResponse.json();
  assert.equal(localHandoffBody.auth_type, "local");
  assert.equal(localHandoffBody.user.id, "local:local-reviewer");
  assert.equal(Object.hasOwn(localHandoffBody, "access_token"), false, "local handoff must not return a GitHub bearer");
  const localCookie = String(localHandoffResponse.headers.get("Set-Cookie") || "").split(";")[0];
  assert.match(localCookie, /^__Host-genepedia_session=/);

  const localSessionResponse = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/session", {
    headers: { Cookie: localCookie },
  }), localLoginEnv);
  const localSessionBody = await localSessionResponse.json();
  assert.equal(localSessionBody.authenticated, true);
  assert.equal(localSessionBody.auth_type, "local");
  assert.equal(localSessionBody.can_review_pull_requests, false, "a local username must not inherit a matching GitHub reviewer login");

  const localEditResponse = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/page-edits", {
    method: "POST",
    headers: { Cookie: localCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ path: "pages/about.html", content: "<main>Local edit</main>" }),
  }), localLoginEnv);
  assert.equal(localEditResponse.status, 401, "local sessions must not publish through server GitHub credentials");

  const localReviewResponse = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/pull-requests/review", {
    method: "POST",
    headers: { Cookie: localCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "merge", number: 17, repo: "Genepedia/Genepedia" }),
  }), localLoginEnv);
  assert.equal(localReviewResponse.status, 401, "local sessions must not review or merge pull requests");
  assert.equal(fallbackWrites, 0, "blocked local write and review actions must never use the server publish token");
  const replayedLocalHandoff = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: localLoginBody.handoff }),
  }), localLoginEnv);
  assert.equal(replayedLocalHandoff.status, 401, "local handoff codes must remain single-use");

  const hashSalt = new TextEncoder().encode("worker-test-salt");
  const hashKey = await crypto.subtle.importKey("raw", new TextEncoder().encode("hashed local password"), "PBKDF2", false, ["deriveBits"]);
  const hashDigest = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hashSalt, iterations: 100_000 }, hashKey, 256);
  const hashEnv = {
    DB: new MemoryD1(),
    GITHUB_SESSION_SECRET: localLoginEnv.GITHUB_SESSION_SECRET,
    LOCAL_LOGIN_USERNAME: "hash-user",
    LOCAL_LOGIN_PASSWORD_HASH: `pbkdf2-sha256$100000$${Buffer.from(hashSalt).toString("base64url")}$${Buffer.from(hashDigest).toString("base64url")}`,
  };
  const hashedLoginResponse = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/local/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "hash-user", password: "hashed local password" }),
  }), hashEnv);
  assert.equal(hashedLoginResponse.status, 200, "the documented PBKDF2 password hash format should authenticate");

  async function runWelcomeOAuth(env) {
    const start = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/github/login?return_to=https%3A%2F%2Fwww.genepedia.org%2Fpages%2Flogin.html"), env);
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get("Location"));
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://api.genepedia.org/v1/auth/github/callback");
    const state = authorize.searchParams.get("state");
    const csrfCookie = String(start.headers.get("Set-Cookie") || "").split(";")[0];
    const callback = await worker.fetch(new Request(`https://api.genepedia.org/v1/auth/github/callback?state=${encodeURIComponent(state)}&code=validation-code`, {
      headers: { Cookie: csrfCookie },
    }), env);
    assert.equal(callback.status, 302);
    const handoff = new URL(callback.headers.get("Location")).searchParams.get("github_handoff");
    assert.ok(handoff);
    return handoff;
  }

  const welcomeEnv = {
    DB: new MemoryD1(),
    GITHUB_SESSION_SECRET: localLoginEnv.GITHUB_SESSION_SECRET,
    GITHUB_CLIENT_ID: "Iv23ValidationClientId",
    GITHUB_CLIENT_SECRET: "validation-only-client-secret",
    GITHUB_WELCOME_STAR_REPOS: "Genepedia/Genepedia,malformed,Genepedia/Genepedia/extra",
    GITHUB_WELCOME_FOLLOW_USERS: "followed-user,Genepedia",
  };
  const githubHandoffCode = await runWelcomeOAuth(welcomeEnv);
  assert.equal(welcomeStarPuts, 1);
  assert.equal(welcomeUserFollowPuts, 1);
  assert.equal(welcomeOrganizationFollowMutations, 1, "organization follows should use GraphQL after REST fallback is unavailable");
  const githubHandoffResponse = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: githubHandoffCode }),
  }), welcomeEnv);
  const githubHandoffBody = await githubHandoffResponse.json();
  assert.equal(githubHandoffBody.auth_type, "github");
  assert.equal(githubHandoffBody.access_token, "test-user-token", "the GitHub OAuth handoff should keep its bearer-token contract");
  await runWelcomeOAuth(welcomeEnv);
  assert.equal(welcomeUserFollowPuts, 1, "already-followed user accounts should not be followed a second time");
  assert.equal(welcomeOrganizationFollowMutations, 1, "already-followed organizations should not be followed a second time");
  const welcomeCountsBeforeDisable = [welcomeStarPuts, welcomeUserFollowPuts, welcomeOrganizationFollowMutations];
  await runWelcomeOAuth({ ...welcomeEnv, GITHUB_WELCOME_ACTIONS: "off" });
  assert.deepEqual([welcomeStarPuts, welcomeUserFollowPuts, welcomeOrganizationFollowMutations], welcomeCountsBeforeDisable, "the welcome action flag should disable all GitHub mutations");
  const originalWarn = console.warn;
  const welcomeWarnings = [];
  console.warn = (...args) => welcomeWarnings.push(args.join(" "));
  try {
    await runWelcomeOAuth({
      ...welcomeEnv,
      DB: new MemoryD1(),
      GITHUB_WELCOME_STAR_REPOS: "Genepedia/missing-repo,Genepedia/Genepedia",
      GITHUB_WELCOME_FOLLOW_USERS: "missing-user,followed-user",
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(welcomeWarnings.length, 2, "a failure for one welcome target should be logged without stopping other targets or OAuth");
  assert.equal(welcomeStarPuts, welcomeCountsBeforeDisable[0] + 1, "a later star target should still run after a failed target");

  const modernAppConfig = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/auth/github/config"), {
    GITHUB_CLIENT_ID: "Iv23ExampleClientId",
    GITHUB_CLIENT_SECRET: "validation-only-secret",
  });
  const modernAppBody = await modernAppConfig.json();
  assert.equal(modernAppBody.oauth_configured, true);
  assert.equal(modernAppBody.oauth.uses_github_app_flow, true, "GitHub's current Iv23 client ID format must be recognized");
  assert.equal(modernAppBody.oauth.client_id_is_github_app_format, true);

  const preflight = await worker.fetch(new Request("https://api.genepedia.org/v1/gravepedia/memorials", {
    method: "OPTIONS",
    headers: { Origin: "https://www.gravepedia.org", "Access-Control-Request-Method": "POST" },
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://www.gravepedia.org");
  assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), "true");

  const search = await worker.fetch(new Request("https://api.genepedia.org/v1/gravepedia/memorials?q=amina"), env);
  assert.equal(search.status, 200);
  const searchBody = await search.json();
  assert.equal(searchBody.success, true);
  assert.equal(searchBody.query, "amina");
  assert.equal(searchBody.total, 1);
  assert.equal(searchBody.results[0].name, "Amina Ndlovu");

  const extensionlessHistory = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/files/commits?path=pages%2Flogin&limit=1"), env);
  assert.equal(extensionlessHistory.status, 200);
  const extensionlessHistoryBody = await extensionlessHistory.json();
  assert.deepEqual(extensionlessHistoryBody.repo_paths, ["pages/login.html"], "extensionless Site routes should map to their source HTML file for history lookups");

  const profileDirectoryHistory = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/files/commits?path=pages%2Fpeople%2F29%2F&limit=1"), env);
  assert.equal(profileDirectoryHistory.status, 200);
  const profileDirectoryHistoryBody = await profileDirectoryHistory.json();
  assert.deepEqual(profileDirectoryHistoryBody.repo_paths, ["pages/people/29/index.html"], "profile directory routes should map to their index page for history lookups");

  const profileHistorySources = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/files/commits?paths=pages%2Fpeople%2F29%2Findex.html%2Cpages%2Fpeople%2F29%2Fprofile.html%2Cpages%2Fpeople%2F29%2Fdata%2Fprofile.html%2Cpages%2Fpeople%2F29%2Fdata%2Ftalk.json&limit=1"), env);
  assert.equal(profileHistorySources.status, 200);
  const profileHistorySourcesBody = await profileHistorySources.json();
  assert.deepEqual(profileHistorySourcesBody.repo_paths, ["pages/people/29/index.html", "pages/people/29/profile.html", "pages/people/29/data/profile.html", "pages/people/29/data/talk.json"], "profile history may include the profile page, prose, and talk file");

  const graveExtensionlessHistory = await worker.fetch(new Request("https://api.genepedia.org/v1/gravepedia/files/commits?path=pages%2Flogin&limit=1"), env);
  assert.equal(graveExtensionlessHistory.status, 200);
  const graveExtensionlessHistoryBody = await graveExtensionlessHistory.json();
  assert.equal(graveExtensionlessHistoryBody.repo, "Genepedia/Gravepedia");
  assert.deepEqual(graveExtensionlessHistoryBody.repo_paths, ["pages/login.html"]);

  const approvedSearch = await worker.fetch(new Request("https://api.genepedia.org/v1/gravepedia/memorials?q=tariro"), env);
  assert.equal(approvedSearch.status, 200);
  const approvedSearchBody = await approvedSearch.json();
  assert.equal(approvedSearchBody.total, 1, "a memorial file on the default branch should appear after its review pull request is merged");
  assert.equal(approvedSearchBody.results[0].name, "Tariro Ncube");

  const unauthenticatedSubmission = await worker.fetch(new Request("https://api.genepedia.org/v1/gravepedia/memorials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test memorial" }),
  }), env);
  assert.equal(unauthenticatedSubmission.status, 401);
  assert.equal((await unauthenticatedSubmission.json()).error, "authentication_required");

  const arbitraryRepo = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/data?path=arbitrary/secret.json"), env);
  assert.equal(arbitraryRepo.status, 400);
  assert.equal((await arbitraryRepo.json()).error, "invalid_path");

  const talkRead = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/talk?person=person-14"), env);
  assert.equal(talkRead.status, 200);
  assert.deepEqual((await talkRead.json()).messages, []);

  const invalidTalkPerson = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/talk?person=../secret"), env);
  assert.equal(invalidTalkPerson.status, 400);
  assert.equal((await invalidTalkPerson.json()).error, "invalid_person");

  const selfProfileAuth = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/profiles/self", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", person_id: "new-person", files: [] }),
  }), env);
  assert.equal(selfProfileAuth.status, 401);
  assert.equal((await selfProfileAuth.json()).error, "authentication_required");

  const invalidMaintainerTarget = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/maintainers?path=../private.json"), env);
  assert.equal(invalidMaintainerTarget.status, 400);
  assert.equal((await invalidMaintainerTarget.json()).error, "invalid_target");

  const maintainersRead = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/maintainers?path=people/person-14/profile.html"), env);
  assert.equal(maintainersRead.status, 200);
  const maintainersBody = await maintainersRead.json();
  assert.equal(maintainersBody.target.key, "profile:person-14");
  assert.deepEqual(maintainersBody.items, []);

  const formerCreatorMaintainerRead = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/maintainers?path=people/person-14/profile.html", {
    headers: { Authorization: "Bearer test-user-token" },
  }), env);
  assert.equal(formerCreatorMaintainerRead.status, 200);
  assert.equal((await formerCreatorMaintainerRead.json()).can_manage, false, "a former creator excluded by existing owner/maintainer metadata must not regain manager access through file authorship");

  const oldestCommitMaintainerRead = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/maintainers?path=pages/about.html", {
    headers: { Authorization: "Bearer test-user-token" },
  }), env);
  assert.equal(oldestCommitMaintainerRead.status, 200);
  assert.equal((await oldestCommitMaintainerRead.json()).can_manage, true, "creator fallback must inspect the oldest paginated commit, beyond the first 100 history entries");

  failDatabasePullRequestCreation = true;
  const partialMaintainerWrite = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/maintainers?path=people/person-14/profile.html", {
    method: "POST",
    headers: { Authorization: "Bearer test-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve", id: "maint-pending-1", path: "people/person-14/profile.html" }),
  }), { GITHUB_REVIEW_LOGIN: "test-user", GITHUB_PUBLISH_TOKEN: "validation-only-token" });
  failDatabasePullRequestCreation = false;
  const partialMaintainerBody = await partialMaintainerWrite.json();
  assert.equal(partialMaintainerWrite.status, 502, JSON.stringify(partialMaintainerBody));
  assert.equal(partialMaintainerBody.error, "partial_publish_failed");
  assert.equal(partialMaintainerBody.details.failed_repo, "Genepedia/Genepedia-Database");
  assert.equal(partialMaintainerBody.details.created_pull_requests.length, 1);
  assert.equal(partialMaintainerBody.details.cleanup[0].closed, true);
  assert.equal(partialMaintainerBody.details.cleanup[0].branch_deleted, true);
  assert.deepEqual(partialMaintainerBody.details.open_pull_requests, []);
  assert.equal(rolledBackPullRequests, 1, "a site pull request must be closed if the second repository submission fails");
  assert.equal(rolledBackSiteBranches, 1, "the closed partial site pull request branch must be deleted");

  const talkWriteAuth = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/talk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "post", person_id: "person-14", body: "A note" }),
  }), env);
  assert.equal(talkWriteAuth.status, 401);

  const talkWrite = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/talk", {
    method: "POST",
    headers: { "Authorization": "Bearer test-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "post", person_id: "person-14", body: "A test discussion note" }),
  }), env);
  assert.equal(talkWrite.status, 201);
  const talkWriteBody = await talkWrite.json();
  assert.equal(talkWriteBody.message.author_login, "test-user");
  assert.equal(talkWriteBody.commit.sha, "talk-commit");

  const reviewEnv = { GITHUB_REVIEW_LOGIN: "test-user", GITHUB_PUBLISH_TOKEN: "validation-only-token" };
  const reviewMerge = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/pull-requests/review", {
    method: "POST",
    headers: { Authorization: "Bearer test-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "merge", number: 17, repo: "Genepedia/Genepedia" }),
  }), reviewEnv);
  assert.equal(reviewMerge.status, 200);
  assert.equal((await reviewMerge.json()).result.merged, true);

  const reviewDecline = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/pull-requests/review", {
    method: "POST",
    headers: { Authorization: "Bearer test-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "decline", number: 17, repo: "Genepedia/Genepedia" }),
  }), reviewEnv);
  assert.equal(reviewDecline.status, 200);
  assert.equal((await reviewDecline.json()).result.state, "closed");

  const mediaReviewEnv = { GITHUB_PUBLISH_TOKEN: "validation-only-token" };
  const mediaApprove = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/profiles/media", {
    method: "POST",
    headers: { Authorization: "Bearer test-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve", person_id: "person-77", number: 9 }),
  }), mediaReviewEnv);
  assert.equal(mediaApprove.status, 200);
  assert.equal((await mediaApprove.json()).result.merged, true);

  const mediaDecline = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/profiles/media", {
    method: "POST",
    headers: { Authorization: "Bearer test-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "decline", person_id: "person-77", number: 9 }),
  }), mediaReviewEnv);
  assert.equal(mediaDecline.status, 200);
  assert.equal((await mediaDecline.json()).result.state, "closed");
  assert.equal(deniedUserWrites, 4, "each gated review write should try the signed-in user token first");
  assert.equal(fallbackWrites, 4, "each review write should retry with the configured server token after user-token denial");

  const invalidStatistics = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/statistics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "search", query: "   " }),
  }), env);
  assert.equal(invalidStatistics.status, 400);
  assert.equal((await invalidStatistics.json()).error, "invalid_request");

  const statisticsPost = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/statistics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "profile_view", kind: "person", person_id: "person-14" }),
  }), env);
  assert.equal(statisticsPost.status, 202);
  const statisticsBody = await statisticsPost.json();
  assert.equal(statisticsBody.ok, true);
  assert.equal(statisticsBody.publish.buffered, true);
  assert.equal(env.DB.events.length, 1, "statistics events should be durable in D1 before GitHub publishing");

  const saturatedDb = new MemoryD1();
  saturatedDb.events = Array.from({ length: 10_000 }, (_, index) => ({ event_id: `queued-${index}`, payload: "{}", created_at: "2026-10-04T00:00:00.000Z" }));
  const saturatedStats = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/statistics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "profile_view", kind: "person", person_id: "person-14" }),
  }), { DB: saturatedDb });
  assert.equal(saturatedStats.status, 429);
  assert.equal((await saturatedStats.json()).error, "statistics_queue_full");
  assert.equal(saturatedDb.events.length, 10_000, "a saturated queue must reject inserts without exceeding the hard D1 cap");

  const publishingEnv = { DB: new MemoryD1(), GITHUB_PUBLISH_TOKEN: "validation-only-token" };
  const publishedStats = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/statistics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "search", query: "  Family   history ", result_count: 12 }),
  }), publishingEnv);
  assert.equal(publishedStats.status, 202);
  const publishedStatsBody = await publishedStats.json();
  assert.equal(publishedStatsBody.search.query, "family history");
  assert.equal(publishedStatsBody.publish.synced, true);
  assert.equal(publishingEnv.DB.events.length, 0, "successfully published statistics events should be removed from the D1 queue");

  const noFlushSecret = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/statistics/flush", { method: "POST" }), env);
  assert.equal(noFlushSecret.status, 403);
  const noFlushSecretGet = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/statistics/flush"), env);
  assert.equal(noFlushSecretGet.status, 403, "the scheduled GET flush route is supported but remains secret-gated");

  const flushEnv = { DB: new MemoryD1(), GITHUB_STATISTICS_FLUSH_TOKEN: "flush-secret" };
  const authorizedFlush = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/statistics/flush", {
    method: "POST",
    headers: { "X-Statistics-Flush-Token": "flush-secret" },
  }), flushEnv);
  assert.equal(authorizedFlush.status, 200);
  assert.equal((await authorizedFlush.json()).flush.pending, false);

  const capabilities = await worker.fetch(new Request("https://api.genepedia.org/v1/genepedia/meta/capabilities"), env);
  const capabilitiesBody = await capabilities.json();
  assert.ok(capabilitiesBody.implemented.includes("GitHub and local login/session/handoff"));
  assert.ok(capabilitiesBody.implemented.includes("best-effort GitHub OAuth welcome stars/follows"));
  assert.deepEqual(capabilitiesBody.unimplemented, ["temporary-storage-check"]);

  const graveCapabilities = await worker.fetch(new Request("https://api.genepedia.org/v1/gravepedia/meta/capabilities"), env);
  const graveCapabilitiesBody = await graveCapabilities.json();
  assert.ok(graveCapabilitiesBody.implemented.includes("Gravepedia memorial search/submission"));
  assert.equal(graveCapabilitiesBody.implemented.includes("profile talk posts/deletes"), false, "capabilities must reflect the selected site API");

  console.log("Focused route validation passed");
} finally {
  globalThis.fetch = originalFetch;
}
