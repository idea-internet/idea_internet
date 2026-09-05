import { describe, it, expect, beforeEach } from "vitest";
import { MockKV, MockR2 } from "./test/mocks";
import worker from "./index";
import { __resetStatsCacheForTests } from "./routes/api";
import { Env } from "./types";

// The worker's fetch handler only touches Env bindings, so we exercise the
// full pipeline against in-memory KV/R2 mocks (workerd cannot run on this
// machine — see vitest.config.ts note).

let kv: MockKV;
let r2: MockR2;
let env: Env;

function makeEnv(): Env {
  return {
    SITE_STORAGE: kv as unknown as KVNamespace,
    SITE_ASSETS: r2 as unknown as R2Bucket,
  };
}

function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`http://27c.site${path}`, init), env, {} as ExecutionContext);
}

function postJson(path: string, body: unknown, key?: string): Promise<Response> {
  return fetchApi(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getJson(path: string, key?: string): Promise<Response> {
  return fetchApi(path, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
}

// The brand-new-site skill gate blocks deploy/upload for accounts with zero
// deployments until the design skill has been read. Production agents read it
// via MCP get_skill or GET /api/skill; tests unlock through the same REST
// endpoint so the gate itself stays under test.
async function readSkill(key: string): Promise<void> {
  const res = await getJson("/api/skill", key);
  expect(res.status).toBe(200);
}

async function registerUser(username: string, subdomain: string): Promise<string> {
  const res = await postJson("/api/register", {
    username,
    password: "testpass123",
    subdomain,
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { data: { apiKey: string } };
  const key = json.data.apiKey;
  await readSkill(key);
  return key;
}

beforeEach(() => {
  kv = new MockKV();
  r2 = new MockR2();
  env = makeEnv();
});

describe("full lifecycle", () => {
  it("registers, deploys, serves, and rolls back", async () => {
    const subdomain = "mytestsite";
    const key = await registerUser("lifecycleuser", subdomain);

    const me = await getJson("/api/me", key);
    const meJson = (await me.json()) as { data: { subdomain: string } };
    expect(meJson.data.subdomain).toBe(subdomain);

    const deployRes = await postJson("/api/deploy", {
      files: [
        { path: "index.html", content: "<h1>v1</h1>" },
        { path: "style.css", content: "body{color:red}" },
      ],
    }, key);
    expect(deployRes.status).toBe(200);
    const deployJson = (await deployRes.json()) as { data: { deploymentId: string } };
    const deploymentId = deployJson.data.deploymentId;

    const page = await worker.fetch(new Request(`http://${subdomain}.27c.site/index.html`), env, {} as ExecutionContext);
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).toContain("<h1>v1</h1>");
    // 27c.site is ad-free: pages are served byte-for-byte as uploaded —
    // no ad tags, analytics, or third-party scripts of any kind.
    expect(pageText).not.toContain("nap5k.com/tag.min.js");
    expect(pageText).not.toContain("11685798");
    expect(pageText).not.toContain("11685828");
    expect(pageText).not.toContain("n6wxm.com");
    expect(pageText).not.toContain("hilltopads");
    expect(page.headers.get("Content-Type")).toContain("text/html");

    // Redeploy index.html only — deploy is additive, style.css survives
    await postJson("/api/deploy", {
      files: [{ path: "index.html", content: "<h1>v2</h1>" }],
    }, key);

    const page2 = await worker.fetch(new Request(`http://${subdomain}.27c.site/`), env, {} as ExecutionContext);
    const page2Text = await page2.text();
    expect(page2Text).toContain("<h1>v2</h1>");
    expect(page2Text).not.toContain("nap5k.com/tag.min.js");
    const css = await worker.fetch(new Request(`http://${subdomain}.27c.site/style.css`), env, {} as ExecutionContext);
    expect(css.status).toBe(200);

    // Rollback to the first deployment
    const rollbackRes = await postJson(`/api/rollback/${deploymentId}`, {}, key);
    expect(rollbackRes.status).toBe(200);
    const page3 = await worker.fetch(new Request(`http://${subdomain}.27c.site/index.html`), env, {} as ExecutionContext);
    const page3Text = await page3.text();
    expect(page3Text).toContain("<h1>v1</h1>");
    expect(page3Text).not.toContain("nap5k.com/tag.min.js");

    const deps = await getJson("/api/deployments", key);
    const depsJson = (await deps.json()) as { data: unknown[]; total: number };
    expect(depsJson.total).toBeGreaterThanOrEqual(2);
  });

  it("deploys binary files via base64", async () => {
    const key = await registerUser("binaryuser", "binarysite");
    // 1x1 transparent PNG
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const res = await postJson("/api/deploy", {
      files: [{ path: "img.png", base64: png }],
    }, key);
    expect(res.status).toBe(200);

    const img = await worker.fetch(new Request("http://binarysite.27c.site/img.png"), env, {} as ExecutionContext);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/png");
  });

  it("serves HTML sites byte-for-byte with nothing injected", async () => {
    const key = await registerUser("aduser", "adsite");
    const html = "<!DOCTYPE html><html><head></head><body><h1>hi</h1></body></html>";
    await postJson("/api/deploy", {
      files: [
        { path: "index.html", content: html },
        { path: "style.css", content: "body{color:red}" },
      ],
    }, key);

    // The served page must be exactly what was deployed — no ad tag, no
    // third-party script, nothing appended before </body>.
    const page = await worker.fetch(new Request("http://adsite.27c.site/"), env, {} as ExecutionContext);
    expect((await page.text())).toBe(html);

    // Non-HTML assets also pass through untouched.
    const css = await worker.fetch(new Request("http://adsite.27c.site/style.css"), env, {} as ExecutionContext);
    expect((await css.text())).toBe("body{color:red}");
  });

  it("ad-free platform: /api/adfree is a compatibility no-op", async () => {
    const key = await registerUser("adfreeuser", "adfreesite");
    await postJson("/api/deploy", {
      files: [{ path: "index.html", content: "<!DOCTYPE html><html><head></head><body><h1>clean</h1></body></html>" }],
    }, key);

    // GET always reports ad-free; POST accepts legacy calls and changes nothing.
    const getRes = await getJson("/api/adfree", key);
    expect(((await getRes.json()) as { data: { adFree: boolean } }).data.adFree).toBe(true);
    const setRes = await postJson("/api/adfree", { enabled: false }, key);
    expect(setRes.status).toBe(200);
    expect(((await setRes.json()) as { data: { adFree: boolean } }).data.adFree).toBe(true);

    // And the site itself never carries an ad tag, whatever a legacy call says.
    const page = await worker.fetch(new Request("http://adfreesite.27c.site/"), env, {} as ExecutionContext);
    const pageText = await page.text();
    expect(pageText).toContain("<h1>clean</h1>");
    expect(pageText).not.toContain("nap5k.com/tag.min.js");
    expect(pageText).not.toContain("11685798");
  });

  // ---------------------------------------------------------------------------
  // Free built-in database (shared Neon Postgres behind a table-scoped API).
  // The Neon driver speaks plain HTTP (POST {query, params}), so stubbing
  // global fetch captures exactly what the Worker would execute.
  // ---------------------------------------------------------------------------
  function stubNeonFetch() {
    const queries: { query: string; params: unknown[]; cs: string }[] = [];
    const realFetch = globalThis.fetch;
    // The Neon HTTP protocol: POST {query, params} -> a single result object
    // { fields: [{name, dataTypeID}], rows: [[...]] } with rows as raw-text
    // arrays (the driver sends Neon-Array-Mode / Neon-Raw-Text-Output and
    // parses the values itself via the fields' type OIDs). The driver also
    // sends a "Neon-Connection-String" header on every request — that string
    // is how we tell WHICH pool member a query hit, since the driver rewrites
    // the fetch endpoint host (real Neon hosts map to Neon's HTTP proxy, and
    // fake test hosts all collapse to api.invalid, which is useless for
    // distinguishing members). Keying off the header tests real behaviour.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      new URL(String(input));
      const body = JSON.parse(String(init?.body || "{}")) as { query?: string; params?: unknown[] };
      const headers = (init?.headers as Record<string, string>) || {};
      queries.push({ query: String(body.query ?? ""), params: body.params ?? [], cs: headers["Neon-Connection-String"] || "" });
      const isSelect = /^SELECT/i.test(String(body.query));
      const fields = isSelect
        ? [{ name: "id", dataTypeID: 25 }, { name: "message", dataTypeID: 25 }]
        : [];
      const rows = isSelect ? [["row-1", "hello"]] : [];
      return new Response(JSON.stringify({ fields, rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return { queries, restore: () => { globalThis.fetch = realFetch; } };
  }

  it("database: provisioning needs a pool member configured", async () => {
    // No NEON_DATABASE_URL* on env at all -> setup cannot assign a pool member.
    const key = await registerUser("dbnocfg", "dbnocfg");
    const res = await postJson("/api/db/setup", { name: "x", columns: [{ name: "m" }] }, key);
    expect(res.status).toBe(503);
  });

  it("database: one table per account, collision auto-suffix, idempotent setup", async () => {
    env.NEON_DATABASE_URL = "postgresql://fake:fake@db1.invalid/db?sslmode=require";
    const keyA = await registerUser("dbusera", "dbasite");
    const keyB = await registerUser("dbuserb", "dbsiteb");

    const setupA = await postJson("/api/db/setup", {
      name: "guestbook",
      columns: [{ name: "message" }, { name: "name" }],
    }, keyA);
    expect(setupA.status).toBe(200);
    const a1 = (await setupA.json()) as { data: { table: string; token: string; columns: { name: string }[] } };
    expect(a1.data.table).toBe("site_guestbook");
    expect(a1.data.token).toMatch(/^dbk_/);
    expect(a1.data.columns.map((c) => c.name)).toEqual(["message", "name"]);

    // Idempotent: same table + token, new columns merged — never a 2nd table.
    const setupA2 = await postJson("/api/db/setup", {
      name: "guestbook",
      columns: [{ name: "rating", type: "number" }],
    }, keyA);
    const a2 = (await setupA2.json()) as { data: { table: string; token: string; columns: { name: string }[] } };
    expect(a2.data.table).toBe("site_guestbook");
    expect(a2.data.token).toBe(a1.data.token);
    expect(a2.data.columns.map((c) => c.name)).toEqual(["message", "name", "rating"]);

    // Another site wanting the same friendly name gets an automatic suffix.
    const setupB = await postJson("/api/db/setup", { name: "guestbook", columns: [{ name: "message" }] }, keyB);
    const b = (await setupB.json()) as { data: { table: string; token: string } };
    expect(b.data.table).toBe("site_guestbook_2");
    expect(b.data.token).not.toBe(a1.data.token);
  });

  it("database: assigns each site to a random pool member and pins it forever", async () => {
    const neon = stubNeonFetch();
    env.NEON_DATABASE_URL = "postgresql://fake:fake@db1.invalid/db?sslmode=require";
    env.NEON_DATABASE_URL_2 = "postgresql://fake:fake@db2.invalid/db?sslmode=require";
    env.NEON_DATABASE_URL_3 = "postgresql://fake:fake@db3.invalid/db?sslmode=require";
    const hostToIndex: Record<string, number> = { "db1.invalid": 0, "db2.invalid": 1, "db3.invalid": 2 };
    const indexOfCs = (cs: string): number => {
      for (const h of Object.keys(hostToIndex)) if (cs.includes(h)) return hostToIndex[h];
      return -1;
    };
    try {
      // Provision a bunch of sites and record each one's assigned pool member.
      // Each register uses a distinct source IP so the per-IP register limiter
      // (5/hour) never trips inside this single test.
      const assignments: { token: string; member: number }[] = [];
      for (let i = 0; i < 14; i++) {
        const ip = `203.0.113.${i + 1}`;
        const regRes = await fetchApi("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
          body: JSON.stringify({ username: `dbpool${i}`, password: "testpass123", subdomain: `dbpool${i}` }),
        });
        const key = ((await regRes.json()) as { data: { apiKey: string } }).data.apiKey;
        await readSkill(key);
        const setup = (await (await postJson("/api/db/setup", { name: `t${i}`, columns: [{ name: "m" }] }, key)).json()) as { data: { token: string } };
        neon.queries.length = 0;
        await postJson("/api/db", { token: setup.data.token, action: "list", limit: 1 });
        const q = neon.queries.find((x) => /^SELECT/i.test(x.query));
        assignments.push({ token: setup.data.token, member: q ? indexOfCs(q.cs) : -1 });
      }
      // Every site got a valid pool member (one of the three).
      for (const a of assignments) {
        expect(a.member).toBeGreaterThanOrEqual(0);
      }
      // Random distribution is genuinely spread: 14 draws over 3 members must
      // hit at least 2 distinct ones (prob of ≤1 distinct ≈ 2·(1/3)^14 ≈ 1e-6).
      const distinctMembers = new Set(assignments.map((a) => a.member)).size;
      expect(distinctMembers).toBeGreaterThanOrEqual(2);

      // PINNING: a second op on the same token hits the SAME member it did the
      // first time — the assignment is persisted, never re-randomized.
      const pinned = assignments[0];
      neon.queries.length = 0;
      await postJson("/api/db", { token: pinned.token, action: "add", data: { m: "x" } });
      await postJson("/api/db", { token: pinned.token, action: "list", limit: 1 });
      for (const q of neon.queries) {
        expect(indexOfCs(q.cs)).toBe(pinned.member);
      }

      // Re-running setup does NOT re-roll the pool member.
      // (We can't easily fetch the account's key again here, but idempotency
      // returns the same token, whose pinning is already proven above.)
    } finally {
      neon.restore();
      delete env.NEON_DATABASE_URL;
      delete env.NEON_DATABASE_URL_2;
      delete env.NEON_DATABASE_URL_3;
    }
  });

  it("database: public API is table-scoped and column-validated", async () => {
    const neon = stubNeonFetch();
    env.NEON_DATABASE_URL = "postgresql://fake:fake@example.invalid/db?sslmode=require";
    try {
      const keyA = await registerUser("dbapia", "dbapia");
      const keyB = await registerUser("dbapib", "dbapib");
      const tokA = ((await (await postJson("/api/db/setup", { name: "votes", columns: [{ name: "choice", type: "number" }] }, keyA)).json()) as { data: { token: string } }).data.token;
      const tokB = ((await (await postJson("/api/db/setup", { name: "votes", columns: [{ name: "message" }] }, keyB)).json()) as { data: { token: string } }).data.token;

      // Valid add goes to the caller's OWN table with parameterized values.
      const add = await postJson("/api/db", { token: tokA, action: "add", data: { choice: 42 } });
      expect(add.status).toBe(200);
      const insert = neon.queries.find((q) => /^INSERT/i.test(q.query));
      expect(insert).toBeDefined();
      expect(insert!.query).toContain('"site_votes"');
      expect(insert!.query).not.toContain('"site_votes_2"');
      // The Neon HTTP driver serializes params as text on the wire; Postgres
      // casts them back by column type server-side.
      expect(insert!.params).toEqual([expect.any(String), "42"]);

      // List returns rows.
      const list = await postJson("/api/db", { token: tokA, action: "list", limit: 10 });
      expect(list.status).toBe(200);
      expect(((await list.json()) as { data: { rows: unknown[] } }).data.rows).toHaveLength(1);

      // Unknown column rejected; system columns are never writable.
      const badCol = await postJson("/api/db", { token: tokA, action: "add", data: { hacker: "x" } });
      expect(badCol.status).toBe(400);
      const sysCol = await postJson("/api/db", { token: tokA, action: "add", data: { id: "forged" } });
      expect(sysCol.status).toBe(400);

      // Table name never comes from the caller: B's token operates only on
      // B's table even though both are named "votes".
      neon.queries.length = 0;
      await postJson("/api/db", { token: tokB, action: "add", data: { message: "hi" } });
      const bInsert = neon.queries.find((q) => /^INSERT/i.test(q.query));
      expect(bInsert!.query).toContain('"site_votes_2"');
      expect(bInsert!.query).not.toContain('"site_votes"');

      // Unknown token -> 403. Bad action -> 400.
      expect((await postJson("/api/db", { token: "dbk_nope", action: "list" })).status).toBe(403);
      expect((await postJson("/api/db", { token: tokA, action: "drop" })).status).toBe(400);
    } finally {
      neon.restore();
      delete env.NEON_DATABASE_URL;
    }
  });

  it("platform pages are completely ad-free", async () => {
    // No ad network scripts, no push-subscription tags, no referral banners —
    // on any platform page, in either language.
    for (const path of ["/", "/zh", "/docs", "/terms", "/privacy"]) {
      const res = await fetchApi(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("nap5k.com");
      expect(text).not.toContain("11685828");
      expect(text).not.toContain("n6wxm.com");
      expect(text).not.toContain("quge5.com");
      expect(text).not.toContain("profitableratecpm");
      expect(text).not.toContain("highrevenueformat");
      expect(text).not.toContain("adsterra");
      expect(text).not.toContain("adsterratech");
      expect(text).not.toContain("atOptions");
      expect(text).not.toContain("invoke.js");
      expect(text).not.toContain("hilltopads");
      expect(text).not.toContain("5gvci.com");
    }
  });

  it("homepage ships SEO surfaces: canonical, hreflang, OG image, JSON-LD", async () => {
    const res = await fetchApi("/");
    const text = await res.text();
    expect(text).toContain('<link rel="canonical" href="https://27c.site/">');
    expect(text).toContain('hreflang="zh" href="https://27c.site/zh"');
    expect(text).toContain('hreflang="x-default" href="https://27c.site/"');
    expect(text).toContain('property="og:image" content="https://27c.site/og-image.png"');
    expect(text).toContain('name="twitter:card" content="summary_large_image"');
    expect(text).toContain('type="application/ld+json"');
    expect(text).toContain('"@type":"WebApplication"');
    expect(text).toContain('"@type":"Organization"');
  });

  it("serves robots.txt and sitemap.xml with hreflang alternates", async () => {
    const robots = await fetchApi("/robots.txt");
    expect(robots.status).toBe(200);
    const robotsText = await robots.text();
    expect(robotsText).toContain("User-agent: *");
    expect(robotsText).toContain("Allow: /");
    expect(robotsText).toContain("Sitemap: https://27c.site/sitemap.xml");
    expect(robotsText).toContain("Disallow: /api/");

    const sitemap = await fetchApi("/sitemap.xml");
    expect(sitemap.status).toBe(200);
    const sitemapText = await sitemap.text();
    expect(sitemapText).toContain("<loc>https://27c.site/</loc>");
    expect(sitemapText).toContain("<loc>https://27c.site/docs</loc>");
    expect(sitemapText).toContain("<loc>https://27c.site/privacy</loc>");
    expect(sitemapText).toContain('hreflang="zh" href="https://27c.site/zh/docs"');
    expect(sitemapText).toContain('hreflang="x-default"');
  });

  it("privacy policy discloses cookies, logs, and the no-ads guarantee", async () => {
    const res = await fetchApi("/privacy");
    const text = await res.text();
    expect(text).toContain("27c_lang");
    expect(text).toContain("no advertising, no tracking, and no analytics");
    expect(text).toContain("Neon");
    expect(text).toContain("September 5, 2026");
  });

  it("serves 404 for unknown subdomain and unknown file", async () => {
    const res = await worker.fetch(new Request("http://nonexistent-xyz.27c.site/"), env, {} as ExecutionContext);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("This site doesn't exist (yet)");
    expect(body).toContain("nonexistent-xyz.27c.site");
    expect(res.headers.get("Content-Type")).toContain("text/html");

    // Existing subdomain but missing file → different 404 copy
    const key = await registerUser("file404user", "file404site");
    await postJson("/api/deploy", { files: [{ path: "index.html", content: "hi" }] }, key);
    const missing = await worker.fetch(new Request("http://file404site.27c.site/nope.html"), env, {} as ExecutionContext);
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    expect(missingBody).toContain("Page not found");
    expect(missingBody).not.toContain("doesn't exist (yet)");
  });

  it("rejects path traversal and empty deploys", async () => {
    const key = await registerUser("invaliduser", "invalidsite");

    const traversal = await postJson("/api/deploy", {
      files: [{ path: "../etc/passwd", content: "x" }],
    }, key);
    expect(traversal.status).toBe(400);

    const empty = await postJson("/api/deploy", { files: [] }, key);
    expect(empty.status).toBe(400);
  });

  it("rejects unauthorized requests and bad keys", async () => {
    const noAuth = await fetchApi("/api/me");
    expect(noAuth.status).toBe(401);

    const badKey = await getJson("/api/me", "0".repeat(64));
    expect(badKey.status).toBe(401);
  });

  it("rejects duplicate username and taken subdomain", async () => {
    await registerUser("dupuser", "dupsub");

    const dupUser = await postJson("/api/register", {
      username: "dupuser",
      password: "testpass123",
      subdomain: "other-name",
    });
    expect(dupUser.status).toBe(409);

    const dupSub = await postJson("/api/register", {
      username: "otheruser",
      password: "testpass123",
      subdomain: "dupsub",
    });
    expect(dupSub.status).toBe(409);
  });

  it("blocks reserved subdomains", async () => {
    const res = await postJson("/api/register", {
      username: "resuser",
      password: "testpass123",
      subdomain: "admin",
    });
    expect(res.status).toBe(400);
  });

  it("health endpoint responds", async () => {
    const res = await fetchApi("/api/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });

  it("login returns a working API key; wrong password rejected", async () => {
    await registerUser("loginuser", "loginsite");

    const bad = await postJson("/api/login", { username: "loginuser", password: "wrong" });
    expect(bad.status).toBe(401);

    const good = await postJson("/api/login", { username: "loginuser", password: "testpass123" });
    expect(good.status).toBe(200);
    const json = (await good.json()) as { data: { apiKey: string } };
    const me = await getJson("/api/me", json.data.apiKey);
    expect(me.status).toBe(200);
  });

  it("changes subdomain and releases the old one", async () => {
    const key = await registerUser("renameuser", "oldname");
    const res = await postJson("/api/subdomain", { subdomain: "newname" }, key);
    expect(res.status).toBe(200);

    const oldSite = await worker.fetch(new Request("http://oldname.27c.site/"), env, {} as ExecutionContext);
    expect(oldSite.status).toBe(404);

    const owner = await kv.get("sub:27c.site:newname");
    expect(owner).toBeTruthy();
  });

  it("serves a site only on the domain it was registered for", async () => {
    const key = await registerUser("onlyone", "exclusive");
    await postJson("/api/deploy", { files: [{ path: "index.html", content: "<h1>hi</h1>" }] }, key);

    const onDefault = await worker.fetch(new Request("http://exclusive.27c.site/"), env, {} as ExecutionContext);
    expect(onDefault.status).toBe(200);

    // Domain exclusivity: the other platform domain must NOT serve this site.
    const onOther = await worker.fetch(new Request("http://exclusive.27ai.cloud/"), env, {} as ExecutionContext);
    expect(onOther.status).toBe(404);
  });

  it("moves the site with /api/domain and the old domain stops resolving", async () => {
    const key = await registerUser("moveruser", "moversite");
    await postJson("/api/deploy", { files: [{ path: "index.html", content: "<h1>hi</h1>" }] }, key);

    const changed = await postJson("/api/domain", { domain: "27ai.cloud" }, key);
    expect(changed.status).toBe(200);

    const onNew = await worker.fetch(new Request("http://moversite.27ai.cloud/"), env, {} as ExecutionContext);
    expect(onNew.status).toBe(200);

    const onOld = await worker.fetch(new Request("http://moversite.27c.site/"), env, {} as ExecutionContext);
    expect(onOld.status).toBe(404);
  });

  it("keeps subdomain namespaces independent across the two domains", async () => {
    await registerUser("firstowner", "sharedname");

    // The same subdomain name is still free on the other platform domain.
    const res = await postJson("/api/register", {
      username: "secondowner",
      password: "testpass123",
      subdomain: "sharedname",
      domain: "27ai.cloud",
    });
    expect(res.status).toBe(201);
  });

  it("changes the password only with the correct current one", async () => {
    const key = await registerUser("passuser", "passsite");

    const wrong = await postJson("/api/password", { current_password: "wrongpass", new_password: "newpass456" }, key);
    expect(wrong.status).toBe(403);

    const changed = await postJson("/api/password", { current_password: "testpass123", new_password: "newpass456" }, key);
    expect(changed.status).toBe(200);

    // The new password must log in; the old one must stop working.
    const newLogin = await postJson("/api/login", { username: "passuser", password: "newpass456" });
    expect(newLogin.status).toBe(200);
    const oldLogin = await postJson("/api/login", { username: "passuser", password: "testpass123" });
    expect(oldLogin.status).toBe(401);
  });

  it("sets X-Request-Id on responses", async () => {
    const res = await fetchApi("/api/health");
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("deletes an account only with explicit confirmation", async () => {
    const key = await registerUser("deleteuser", "deletesite");
    await postJson("/api/deploy", { files: [{ path: "index.html", content: "bye" }] }, key);

    // Capture everything this user owns before deleting (test env is isolated)
    const beforeUser = (await r2.list({ prefix: "user/" })).objects.map((o) => o.key);
    const beforeSnap = (await r2.list({ prefix: "snapshot/" })).objects.map((o) => o.key);
    expect(beforeUser.length).toBeGreaterThanOrEqual(1);
    expect(beforeSnap.length).toBeGreaterThanOrEqual(1);

    // Without confirm:true the deletion is refused
    const unconfirmed = await fetchApi("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({}),
    });
    expect(unconfirmed.status).toBe(400);

    // Account still works
    const me = await getJson("/api/me", key);
    expect(me.status).toBe(200);

    // With confirm:true the account, files, and subdomain are all removed
    const confirmed = await fetchApi("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ confirm: true }),
    });
    expect(confirmed.status).toBe(200);

    const deadKey = await getJson("/api/me", key);
    expect(deadKey.status).toBe(401);
    const deadSite = await worker.fetch(new Request("http://deletesite.27c.site/"), env, {} as ExecutionContext);
    expect(deadSite.status).toBe(404);
    expect(await kv.get("user:deleteuser")).toBeNull();
    expect(await kv.get("subdomain:deletesite")).toBeNull();

    // No R2 files or snapshots survive
    for (const k of [...beforeUser, ...beforeSnap]) {
      expect(await r2.get(k)).toBeNull();
    }
    // No deployment records remain
    const depLeftovers = await kv.list({ prefix: "deployment:" });
    expect(depLeftovers.keys).toHaveLength(0);
  });

  it("serves the /docs page with API reference", async () => {
    const res = await fetchApi("/docs");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Quick Start");
    expect(body).toContain("/api/deploy");
    expect(body).toContain("delete_account");
    // The docs page now describes the 27c-site MCP server.
    expect(body).toContain("MCP");
    expect(body).not.toContain("multipart, no base64 limits");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("CSP is locked to 'self' now that the ad loader chain is gone", async () => {
    const res = await fetchApi("/");
    const csp = res.headers.get("Content-Security-Policy") || "";
    const dir = (name: string) => csp.split(";").find((d) => d.trim().startsWith(name)) || "";

    // With the ad tags removed there is nothing left to allow-list-around:
    // previously every fetch directive had to allow `https:` because the ad
    // chain loaded from rotating obfuscated hosts. Now each directive is
    // locked to 'self' — the CSP is a real boundary again, not a formality.
    for (const d of ["script-src", "style-src", "img-src", "connect-src", "font-src"]) {
      expect(csp).toContain(d);
      expect(dir(d)).not.toContain("https:");
    }

    // The locks that were never relaxed — these must NEVER be relaxed.
    expect(dir("frame-ancestors")).toContain("'none'");
    expect(dir("base-uri")).toContain("'self'");
    expect(dir("object-src")).toContain("'none'");
    expect(dir("form-action")).toContain("'self'");
  });

  it("serves Chinese versions under /zh with correct lang attributes", async () => {
    const home = await fetchApi("/zh");
    expect(home.status).toBe(200);
    const homeBody = await home.text();
    expect(homeBody).toContain('<html lang="zh-CN">');
    expect(homeBody).toContain("把你的想法");
    expect(homeBody).toContain("开始使用");
    // The homepage MCP section must be present and localized
    expect(homeBody).toContain("和能运行命令的 AI 聊几句，网站就上线");

    const docs = await fetchApi("/zh/docs");
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain("文档与快速上手");

    const terms = await fetchApi("/zh/terms");
    expect(terms.status).toBe(200);
    expect(await terms.text()).toContain("服务条款");

    const privacy = await fetchApi("/zh/privacy");
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain("隐私政策");

    // Unknown page under /zh still returns the localized 404
    const missing = await fetchApi("/zh/nope");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("页面不存在");
  });

  it("auto-redirects to /zh when Accept-Language prefers Chinese", async () => {
    const res = await worker.fetch(
      new Request("http://27c.site/", { headers: { "Accept-Language": "zh-CN,zh;q=0.9" }, redirect: "manual" }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/zh");

    const docs = await worker.fetch(
      new Request("http://27c.site/docs", { headers: { "Accept-Language": "zh-TW" }, redirect: "manual" }),
      env,
      {} as ExecutionContext
    );
    expect(docs.status).toBe(302);
    expect(docs.headers.get("Location")).toBe("/zh/docs");

    // English browser is not redirected
    const en = await worker.fetch(
      new Request("http://27c.site/", { headers: { "Accept-Language": "en-US" }, redirect: "manual" }),
      env,
      {} as ExecutionContext
    );
    expect(en.status).toBe(200);
  });

  it("respects the 27c_lang cookie over Accept-Language", async () => {
    // Cookie says English even though browser prefers Chinese → no redirect
    const res = await worker.fetch(
      new Request("http://27c.site/", {
        headers: { "Accept-Language": "zh-CN", Cookie: "27c_lang=en" },
        redirect: "manual",
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Put your idea");

    // Cookie says Chinese even though browser prefers English → redirect
    const res2 = await worker.fetch(
      new Request("http://27c.site/", {
        headers: { "Accept-Language": "en-US", Cookie: "27c_lang=zh" },
        redirect: "manual",
      }),
      env,
      {} as ExecutionContext
    );
    expect(res2.status).toBe(302);
    expect(res2.headers.get("Location")).toBe("/zh");
  });

  it("subdomain 404s respect Accept-Language", async () => {
    const zh = await worker.fetch(
      new Request("http://nonexistent-zh.27c.site/", {
        headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      }),
      env,
      {} as ExecutionContext
    );
    expect(zh.status).toBe(404);
    expect(await zh.text()).toContain("这个站点（还）不存在");

    const en = await worker.fetch(
      new Request("http://nonexistent-en.27c.site/", {
        headers: { "Accept-Language": "en-US,en;q=0.9" },
      }),
      env,
      {} as ExecutionContext
    );
    expect(await en.text()).toContain("This site doesn't exist (yet)");
  });

  it("serves a branded 404 page with security headers", async () => {
    const res = await fetchApi("/nonexistent-page");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toContain("Page not found");
    expect(body).toContain("Back to 27c.site");
  });

  it("serves homepage with SEO metadata and security headers", async () => {
    const res = await fetchApi("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
    const body = await res.text();
    expect(body).toContain('property="og:title"');
    expect(body).toContain('name="description"');
    // The homepage must not expose raw REST/API usage. It intentionally carries
    // the self-install prompt and the live /api/stats counter, but no other
    // /api/ paths and no hand-written curl examples.
    expect(body).not.toContain("/api/deploy");
    expect(body).not.toContain("/api/register");
    expect(body).not.toContain("/api/login");
    expect(body).not.toContain("curl ");
    expect(body).toContain("Send the prompt to Cursor, Trae, WorkBuddy");
    expect(body).toContain("Your site goes live");
    // Live "users served" counter plumbing is present.
    expect(body).toContain('id="liveStat"');
    expect(body).toContain('fetch("/api/stats"');
    // Trust anchors: both the seed prompt and every example-brief prompt carry
    // the public repository link so cautious agents verify instead of refusing.
    expect(body).toContain("https://github.com/idea-internet/idea_internet");
    expect((body.match(/idea-internet\/idea_internet/g) || []).length).toBeGreaterThanOrEqual(7);
    expect(body).not.toContain("Manual file upload");
  });

  it("reports real cumulative user stats on the public /api/stats endpoint", async () => {
    __resetStatsCacheForTests();
    const res = await fetchApi("/api/stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("max-age=30");
    let json = (await res.json()) as { success: boolean; data: { users: number } };
    expect(json.success).toBe(true);
    // Fresh per-test KV: no accounts exist yet, and the count is a live
    // enumeration of the account index, so it starts at exactly zero.
    expect(json.data.users).toBe(0);

    // Two registrations → exactly two users. No drift, no estimating.
    const key1 = await registerUser("statsuser1", "statssite1");
    await registerUser("statsuser2", "statssite2");
    __resetStatsCacheForTests();
    json = (await (await fetchApi("/api/stats")).json()) as typeof json;
    expect(json.data.users).toBe(2);

    // Deleting an account lowers the count too — it is the real index.
    await fetchApi("/api/account", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key1}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    __resetStatsCacheForTests();
    json = (await (await fetchApi("/api/stats")).json()) as typeof json;
    expect(json.data.users).toBe(1);
  });

  it("serves the public design skill at /skill", async () => {
    const res = await fetchApi("/skill");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await res.text();
    expect(body).toContain("tasteskill");
    expect(body).toContain("Anti-Slop");

    // /skill.md alias resolves to the same content.
    const alias = await fetchApi("/skill.md");
    expect(alias.status).toBe(200);
    expect(await alias.text()).toContain("tasteskill");

    // Reachable from a subdomain host too.
    const sub = await worker.fetch(new Request("http://mysite.27c.site/skill"), env, {} as ExecutionContext);
    expect(sub.status).toBe(200);
    expect(await sub.text()).toContain("tasteskill");
  });
});

describe("skill gate", () => {
  it("blocks deploy for a brand-new site that has not read the skill", async () => {
    // Register WITHOUT reading the skill (bypass the registerUser helper)
    const res = await postJson("/api/register", {
      username: "gateuser1",
      password: "testpass123",
      subdomain: "gatesite1",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { apiKey: string } };
    const key = json.data.apiKey;

    const deployRes = await postJson("/api/deploy", {
      files: [{ path: "index.html", content: "<h1>hi</h1>" }],
    }, key);
    expect(deployRes.status).toBe(403);
    const body = (await deployRes.json()) as { error: string };
    expect(body.error).toContain("design skill not read");
  });

  it("blocks upload for a brand-new site that has not read the skill", async () => {
    const res = await postJson("/api/register", {
      username: "gateuser2",
      password: "testpass123",
      subdomain: "gatesite2",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { apiKey: string } };
    const key = json.data.apiKey;

    const form = new FormData();
    form.append("logo.png", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "logo.png");
    const uploadRes = await fetchApi("/api/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    expect(uploadRes.status).toBe(403);
    const body = (await uploadRes.json()) as { error: string };
    expect(body.error).toContain("design skill not read");
  });

  it("unlocks deploy and upload after reading the skill via GET /api/skill", async () => {
    const res = await postJson("/api/register", {
      username: "gateuser3",
      password: "testpass123",
      subdomain: "gatesite3",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { apiKey: string } };
    const key = json.data.apiKey;

    // Read the skill — this unlocks the gate
    const skillRes = await getJson("/api/skill", key);
    expect(skillRes.status).toBe(200);

    // Deploy should now work
    const deployRes = await postJson("/api/deploy", {
      files: [{ path: "index.html", content: "<h1>unlocked</h1>" }],
    }, key);
    expect(deployRes.status).toBe(200);

    // Upload should also work
    const form = new FormData();
    form.append("style.css", new Blob([new Uint8Array([1, 2, 3])], { type: "text/css" }), "style.css");
    const uploadRes = await fetchApi("/api/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    expect(uploadRes.status).toBe(200);
  });

  it("does not re-block after a deployment exists", async () => {
    // registerUser reads the skill and allows the first deploy
    const key = await registerUser("gateuser4", "gatesite4");
    const first = await postJson("/api/deploy", {
      files: [{ path: "index.html", content: "<h1>v1</h1>" }],
    }, key);
    expect(first.status).toBe(200);
    // A second deploy should never be gated (deployments.length > 0)
    const second = await postJson("/api/deploy", {
      files: [{ path: "index.html", content: "<h1>v2</h1>" }],
    }, key);
    expect(second.status).toBe(200);
  });

  it("versions uploads so rollback preserves uploaded files", async () => {
    const key = await registerUser("uploadrollback", "uploadrollback");
    const first = await postJson("/api/deploy", {
      files: [{ path: "index.html", content: "<h1>v1</h1>" }],
    }, key);
    expect(first.status).toBe(200);

    const form = new FormData();
    form.append("style.css", new Blob(["body{color:red}"], { type: "text/css" }), "style.css");
    const upload = await fetchApi("/api/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    expect(upload.status).toBe(200);
    const uploadData = (await upload.json()) as { data: { deploymentId: string } };

    await postJson("/api/deploy", {
      files: [{ path: "index.html", content: "<h1>v2</h1>" }],
    }, key);
    const rollback = await postJson(`/api/rollback/${uploadData.data.deploymentId}`, {}, key);
    expect(rollback.status).toBe(200);
    // The test helper routes by URL hostname, so verify through the explicit URL.
    const site = await worker.fetch(new Request("http://uploadrollback.27c.site/"), env, {} as ExecutionContext);
    expect(await site.text()).toContain("v1");
    const css = await worker.fetch(new Request("http://uploadrollback.27c.site/style.css"), env, {} as ExecutionContext);
    expect(await css.text()).toContain("color:red");
  });
});

describe("rate limiting", () => {
  it("throttles excessive registrations from one IP", async () => {
    // register limit is 5/hour; the 6th call should be rejected
    let saw429 = false;
    for (let i = 0; i < 6; i++) {
      const res = await postJson("/api/register", {
        username: `rluser${i}`,
        password: "testpass123",
      });
      if (res.status === 429) {
        saw429 = true;
        expect(res.headers.get("Retry-After")).toBeTruthy();
        break;
      }
    }
    expect(saw429).toBe(true);

    const after = await postJson("/api/register", {
      username: "rluser-late",
      password: "testpass123",
    });
    expect(after.status).toBe(429);
  });

  it("throttles excessive logins from one IP", async () => {
    await registerUser("bruteforce", "bruteforcesite");
    let saw429 = false;
    for (let i = 0; i < 25; i++) {
      const res = await postJson("/api/login", { username: "bruteforce", password: "wrong" });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(saw429).toBe(true);
  });
});
