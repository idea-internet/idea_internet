import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, generateApiKey, isReservedSubdomain, sanitizeSubdomain, isValidSubdomain, isValidPath, getContentType, generateId } from "../src/auth";
import { checkRateLimit } from "../src/ratelimit";

describe("auth", () => {
  it("hashes and verifies password", async () => {
    const { hash, salt } = await hashPassword("testpass123");
    expect(hash).toBeTruthy();
    expect(salt).toBeTruthy();
    expect(await verifyPassword("testpass123", salt, hash)).toBe(true);
    expect(await verifyPassword("wrongpass", salt, hash)).toBe(false);
  });

  it("generates API key", () => {
    const key = generateApiKey();
    expect(key).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(key)).toBe(true);
  });

  it("detects reserved subdomains", () => {
    expect(isReservedSubdomain("www")).toBe(true);
    expect(isReservedSubdomain("admin")).toBe(true);
    expect(isReservedSubdomain("api")).toBe(true);
    expect(isReservedSubdomain("myblog")).toBe(false);
  });

  it("sanitizes subdomains", () => {
    expect(sanitizeSubdomain("My_Blog!")).toBe("myblog");
    expect(sanitizeSubdomain("---test---")).toBe("test");
  });

  it("validates subdomains", () => {
    expect(isValidSubdomain("myblog")).toBe(true);
    expect(isValidSubdomain("a")).toBe(true);
    expect(isValidSubdomain("ab")).toBe(true);
    expect(isValidSubdomain("")).toBe(false);
  });

  it("validates paths", () => {
    expect(isValidPath("index.html")).toBe(true);
    expect(isValidPath("css/style.css")).toBe(true);
    expect(isValidPath("../secret")).toBe(false);
    expect(isValidPath("path\\with\\backslash")).toBe(false);
    expect(isValidPath("//double-slash")).toBe(false);
  });

  it("returns correct content types", () => {
    expect(getContentType("index.html")).toBe("text/html");
    expect(getContentType("style.css")).toBe("text/css");
    expect(getContentType("app.js")).toBe("application/javascript");
    expect(getContentType("image.png")).toBe("image/png");
    expect(getContentType("unknown.xyz")).toBe("application/octet-stream");
  });

  it("generates unique IDs", () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).toHaveLength(32);
    expect(id1).not.toBe(id2);
  });
});

describe("rate limit (regression: KV expirationTtl >= 60s)", () => {
  it("never writes an expirationTtl below 60s, even late in a short window", async () => {
    let minTtl = Infinity;
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string, type?: string) => {
        const v = store.get(k);
        return v == null ? null : type === "json" ? JSON.parse(v) : v;
      },
      put: async (_k: string, v: string, opts?: { expirationTtl?: number }) => {
        if (opts?.expirationTtl !== undefined) minTtl = Math.min(minTtl, opts.expirationTtl);
        store.set(_k, v);
      },
    } as unknown as KVNamespace;

    // Seed a counter whose window resets ~10s from now — the exact case that
    // used to compute a 59s TTL and throw "Invalid expiration_ttl of 59".
    store.set("rl:db:tok", JSON.stringify({ count: 1, reset: Date.now() + 10_000 }));

    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(kv, "db", "tok", 120, 60_000);
      expect(r.allowed).toBe(true);
    }
    expect(minTtl).toBeGreaterThanOrEqual(60);
  });

  it("fails open: a KV put error does not throw or 500 the request", async () => {
    const kv = {
      get: async () => null,
      put: async () => {
        throw new Error("KV down");
      },
    } as unknown as KVNamespace;
    const r = await checkRateLimit(kv, "db", "tok2", 120, 60_000);
    expect(r.allowed).toBe(true);
  });
});
