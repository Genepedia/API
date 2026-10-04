import assert from "node:assert/strict";
import worker from "../worker/index.js";

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
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  assert.equal(url.hostname, "api.github.com", "route test should only fetch the mocked GitHub API");
  const method = init.method || input?.method || "GET";
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
  if (url.pathname === "/repos/Genepedia/Genepedia-Database" && method === "GET") {
    return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/repos/Genepedia/Genepedia-Database/contents/people/ownership/0/person-14.json") {
    const ownership = { creator: { githubLogin: "test-user" }, owner: { githubLogin: "current-owner" }, maintainers: [{ githubLogin: "current-maintainer" }] };
    const content = Buffer.from(JSON.stringify(ownership)).toString("base64");
    return new Response(JSON.stringify({ type: "file", content }), { status: 200, headers: { "Content-Type": "application/json" } });
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
  return new Response(JSON.stringify({ message: "Not Found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
};

class MemoryD1 {
  events = [];
  meta = new Map();
  locks = new Map();

  prepare(sql) {
    const statement = {
      sql,
      values: [],
      bind: (...values) => { statement.values = values; return statement; },
      first: async () => {
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
        if (sql.startsWith("INSERT INTO statistics_events")) {
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
  const config = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-config.php"), env);
  assert.equal(config.status, 200);
  const configBody = await config.json();
  assert.equal(configBody.repo, "Genepedia/Genepedia");
  assert.equal(configBody.oauth_configured, false);
  assert.equal(JSON.stringify(configBody).includes("client_secret"), false, "public config must not expose secret material");

  const preflight = await worker.fetch(new Request("https://api.genepedia.org/gravepedia/memorials.php", {
    method: "OPTIONS",
    headers: { Origin: "https://www.gravepedia.org", "Access-Control-Request-Method": "POST" },
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://www.gravepedia.org");
  assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), "true");

  const search = await worker.fetch(new Request("https://api.genepedia.org/gravepedia/memorials.php?q=amina"), env);
  assert.equal(search.status, 200);
  const searchBody = await search.json();
  assert.equal(searchBody.success, true);
  assert.equal(searchBody.query, "amina");
  assert.equal(searchBody.total, 1);
  assert.equal(searchBody.results[0].name, "Amina Ndlovu");

  const unauthenticatedSubmission = await worker.fetch(new Request("https://api.genepedia.org/gravepedia/memorials.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test memorial" }),
  }), env);
  assert.equal(unauthenticatedSubmission.status, 401);
  assert.equal((await unauthenticatedSubmission.json()).error, "authentication_required");

  const arbitraryRepo = await worker.fetch(new Request("https://api.genepedia.org/genepedia/data.php?path=arbitrary/secret.json"), env);
  assert.equal(arbitraryRepo.status, 400);
  assert.equal((await arbitraryRepo.json()).error, "invalid_path");

  const talkRead = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-talk.php?person=person-14"), env);
  assert.equal(talkRead.status, 200);
  assert.deepEqual((await talkRead.json()).messages, []);

  const invalidTalkPerson = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-talk.php?person=../secret"), env);
  assert.equal(invalidTalkPerson.status, 400);
  assert.equal((await invalidTalkPerson.json()).error, "invalid_person");

  const selfProfileAuth = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-self-profile.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", person_id: "new-person", files: [] }),
  }), env);
  assert.equal(selfProfileAuth.status, 401);
  assert.equal((await selfProfileAuth.json()).error, "authentication_required");

  const invalidMaintainerTarget = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-maintainers.php?path=../private.json"), env);
  assert.equal(invalidMaintainerTarget.status, 400);
  assert.equal((await invalidMaintainerTarget.json()).error, "invalid_target");

  const maintainersRead = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-maintainers.php?path=people/person-14/profile.html"), env);
  assert.equal(maintainersRead.status, 200);
  const maintainersBody = await maintainersRead.json();
  assert.equal(maintainersBody.target.key, "profile:person-14");
  assert.deepEqual(maintainersBody.items, []);

  const formerCreatorMaintainerRead = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-maintainers.php?path=people/person-14/profile.html", {
    headers: { Authorization: "Bearer test-user-token" },
  }), env);
  assert.equal(formerCreatorMaintainerRead.status, 200);
  assert.equal((await formerCreatorMaintainerRead.json()).can_manage, false, "a former creator excluded by existing owner/maintainer metadata must not regain manager access through file authorship");

  const talkWriteAuth = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-talk.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "post", person_id: "person-14", body: "A note" }),
  }), env);
  assert.equal(talkWriteAuth.status, 401);

  const talkWrite = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-talk.php", {
    method: "POST",
    headers: { "Authorization": "Bearer test-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "post", person_id: "person-14", body: "A test discussion note" }),
  }), env);
  assert.equal(talkWrite.status, 201);
  const talkWriteBody = await talkWrite.json();
  assert.equal(talkWriteBody.message.author_login, "test-user");
  assert.equal(talkWriteBody.commit.sha, "talk-commit");

  const invalidStatistics = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-statistics.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "search", query: "   " }),
  }), env);
  assert.equal(invalidStatistics.status, 400);
  assert.equal((await invalidStatistics.json()).error, "invalid_request");

  const statisticsPost = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-statistics.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "profile_view", kind: "person", person_id: "person-14" }),
  }), env);
  assert.equal(statisticsPost.status, 202);
  const statisticsBody = await statisticsPost.json();
  assert.equal(statisticsBody.ok, true);
  assert.equal(statisticsBody.publish.buffered, true);
  assert.equal(env.DB.events.length, 1, "statistics events should be durable in D1 before GitHub publishing");

  const publishingEnv = { DB: new MemoryD1(), GITHUB_PUBLISH_TOKEN: "validation-only-token" };
  const publishedStats = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-statistics.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "search", query: "  Family   history ", result_count: 12 }),
  }), publishingEnv);
  assert.equal(publishedStats.status, 202);
  const publishedStatsBody = await publishedStats.json();
  assert.equal(publishedStatsBody.search.query, "family history");
  assert.equal(publishedStatsBody.publish.synced, true);
  assert.equal(publishingEnv.DB.events.length, 0, "successfully published statistics events should be removed from the D1 queue");

  const noFlushSecret = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-statistics-flush.php", { method: "POST" }), env);
  assert.equal(noFlushSecret.status, 403);

  const flushEnv = { DB: new MemoryD1(), GITHUB_STATISTICS_FLUSH_TOKEN: "flush-secret" };
  const authorizedFlush = await worker.fetch(new Request("https://api.genepedia.org/genepedia/github-statistics-flush.php", {
    method: "POST",
    headers: { "X-Statistics-Flush-Token": "flush-secret" },
  }), flushEnv);
  assert.equal(authorizedFlush.status, 200);
  assert.equal((await authorizedFlush.json()).flush.pending, false);

  const capabilities = await worker.fetch(new Request("https://api.genepedia.org/genepedia/__capabilities"), env);
  const capabilitiesBody = await capabilities.json();
  assert.deepEqual(capabilitiesBody.unimplemented.map((item) => item.split(" ")[0]), ["local-login.php", "check_writable_tmp.php"]);

  console.log("Focused route validation passed");
} finally {
  globalThis.fetch = originalFetch;
}
