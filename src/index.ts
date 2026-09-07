import { Env, type PlatformDomain } from "./types";
import { handleApiRequest } from "./routes/api";
import { handleSite } from "./routes/site";
import { handlePages } from "./pages";
import { getTasteSkillMarkdown } from "./skills/taste-skill";
import { getAgentPrompt } from "./agent-prompt";
import { handleMcpRequest } from "./mcp";

// Service worker bytes. Canonical source of truth: ./sw.js at the repo root.
// Embedded here because Cloudflare Workers have no runtime filesystem access;
// keep the two in sync if you edit the worker.
//
// This is a CLEANUP worker, not a feature. 27c.site once registered a worker
// that imported remote logic from a third-party ad host and took control of
// this whole origin. A registered service worker persists until it is
// explicitly unregistered, so /sw.js now uninstalls itself: browsers that
// still hold the old installation pick this up on their next update check and
// deregister. The homepage no longer registers anything, so nothing new is
// installed. Keep serving this as long as legacy installs may still exist.
const SW_JS_SOURCE = `self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(self.registration.unregister().then(function () { return self.clients.claim(); }));
});
`;

function requestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PLATFORM_HOSTS = new Set([
  "27c.site",
  "www.27c.site",
  "27ai.cloud",
  "www.27ai.cloud",
  "127.0.0.1",
  "localhost",
  "27c-site.violet27chen.workers.dev",
]);

// Alias hosts → canonical platform domain. An alias serves EXACTLY the same
// content as its canonical domain: platform pages, the API, and the MCP server
// all respond identically, and <sub>.<alias> resolves the subdomain claim made
// on the canonical domain (see platformDomainOf in routes/site.ts). Aliases
// exist for reachability — ccwu.cc mirrors work where the primary domains may
// be blocked, and the api.* hosts are dedicated machine entrypoints.
const DOMAIN_ALIASES: Record<string, PlatformDomain> = {
  "27c-site.ccwu.cc": "27c.site",
  "api.27c-site.ccwu.cc": "27c.site",
  "prourl.ccwu.cc": "27c.site",
  "api.prourl.ccwu.cc": "27c.site",
  "api.27c.site": "27c.site",
  "idea-27c.ccwu.cc": "27ai.cloud",
  "api.idea-27c.ccwu.cc": "27ai.cloud",
  "api.27ai.cloud": "27ai.cloud",
};

for (const alias of Object.keys(DOMAIN_ALIASES)) PLATFORM_HOSTS.add(alias);

/** Canonical platform domain for any host (aliases fold into their target). */
function canonicalDomainOf(hostname: string): PlatformDomain {
  const alias = DOMAIN_ALIASES[hostname];
  if (alias) return alias;
  return hostname.endsWith("27ai.cloud") ? "27ai.cloud" : "27c.site";
}

async function route(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.hostname.replace(/:\d+$/, "");
  const pathname = url.pathname;

  // Publicly served design skill (verbatim — see src/skills/taste-skill.md).
  // Exposed on every host so an AI agent can read it straight from the
  // platform domain (https://27c.site/skill) without any auth. Placed before
  // the platform/subdomain branches so it works on 27c.site, 27ai.cloud, and
  // any *.27c.site / *.27ai.cloud host.
  if (pathname === "/skill" || pathname === "/skill.md") {
    return new Response(getTasteSkillMarkdown(), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // Publicly served deployment prompt. It is a PURE HTTP-API instruction set
  // that any external AI agent can read with a plain GET (no WebMCP runtime or
  // browser required). Served on every host, unauthenticated.
  if (pathname === "/agent-prompt" || pathname === "/agent-prompt.txt") {
    const domain = canonicalDomainOf(hostname);
    const language = url.searchParams.get("language") === "zh" ? "zh" : "en";
    return new Response(getAgentPrompt(undefined, domain, language), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (PLATFORM_HOSTS.has(hostname)) {
    // Standard MCP (Model Context Protocol) server — Streamable HTTP transport.
    // Any MCP-compatible client installs it with one line of config and then
    // drives 27c.site through normal MCP tool calls.
    if (pathname === "/mcp") {
      return handleMcpRequest(env, request);
    }
    // Machine-readable MCP client config (domain-aware url) for easy copy/paste.
    if (pathname === "/mcp-config" || pathname === "/mcp-config.json") {
      const domain = canonicalDomainOf(hostname);
      const cfg = { mcpServers: { "27c-site": { url: "https://" + domain + "/mcp" } } };
      return new Response(JSON.stringify(cfg, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    // Publicly served service worker. Self-unregistering cleanup worker for
    // browsers that still hold the legacy ad service worker installation.
    if (pathname === "/sw.js") {
      return new Response(SW_JS_SOURCE, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=600",
          "Service-Worker-Allowed": "/",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (pathname.startsWith("/api/")) {
      return handleApiRequest(env, request);
    }
    return handlePages(request);
  }

  // User-site subdomains: <sub> on a canonical domain, or on any alias of it.
  const SUBDOMAIN_SUFFIXES = [
    ".27c.site",
    ".27ai.cloud",
    ".27c-site.ccwu.cc",
    ".prourl.ccwu.cc",
    ".idea-27c.ccwu.cc",
  ];
  const isSubdomainHost = SUBDOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  const subdomain = hostname.split(".")[0];
  if (subdomain && isSubdomainHost) {
    return handleSite(env, request);
  }

  return new Response("Not Found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const id = requestId();
    const started = Date.now();
    try {
      const response = await route(request, env, ctx);
      response.headers.set("X-Request-Id", id);
      console.log(JSON.stringify({
        msg: "request",
        requestId: id,
        method: request.method,
        url: request.url,
        status: response.status,
        durationMs: Date.now() - started,
      }));
      return response;
    } catch (err) {
      console.error(JSON.stringify({
        msg: "unhandled error",
        requestId: id,
        method: request.method,
        url: request.url,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }));
      return new Response(JSON.stringify({ success: false, error: "Internal Server Error", requestId: id }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Request-Id": id,
        },
      });
    }
  },
};
