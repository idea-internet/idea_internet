import { Env, platformDomainOf } from "../types";
import { getSiteFile, getSubdomainOwner } from "../db";
import { isValidPath } from "../auth";
import { dictFor, localeFromAcceptLanguage } from "../locales";
import { renderSiteNotFound, renderFileNotFound } from "../pages/notFound";

// 27c.site is ad-free by design. Deployed user sites are served EXACTLY as
// they were uploaded — no ad tags, no analytics, no third-party scripts, and
// no other markup is ever injected into someone else's page.
// Do not reintroduce injection here: it violates the Privacy Policy, which
// states that hosted pages carry no third-party scripts.

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Which platform domain does this subdomain hostname belong to? */
// Every platform domain keeps its OWN subdomain claim namespace (see
// platformDomainOf in ../types) — <sub>.prourl.ccwu.cc is unrelated to
// <sub>.27c.site; they are independent platforms.
async function handleSiteRequest(env: Env, hostname: string, pathname: string, acceptLanguage: string | null, forcedOwnerId?: string): Promise<Response> {
  const dict = dictFor(localeFromAcceptLanguage(acceptLanguage));

  const requestedDomain = platformDomainOf(hostname);
  let ownerId: string | null = forcedOwnerId || null;
  if (!ownerId) {
    if (!requestedDomain) {
      return htmlResponse(renderSiteNotFound(dict, hostname));
    }
    const subdomain = hostname.split(".")[0];
    // Domain exclusivity comes from the scoped claim key: a site claimed on
    // 27c.site has no claim under sub:27ai.cloud:<sub>, so the other platform
    // domain resolves to "not found" instead of serving the same content.
    ownerId = await getSubdomainOwner(env, subdomain, requestedDomain);
  }
  if (!ownerId) {
    return htmlResponse(renderSiteNotFound(dict, hostname));
  }

  let filePath = pathname;
  if (filePath === "/") {
    filePath = "/index.html";
  }

  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    return new Response("Invalid Path", { status: 400 });
  }

  if (!isValidPath(filePath)) {
    return new Response("Invalid Path", { status: 400 });
  }

  const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  const file = await getSiteFile(env, ownerId, normalizedPath);
  if (!file) {
    return htmlResponse(renderFileNotFound(dict));
  }

  const headers = new Headers();
  headers.set("Content-Type", file.contentType);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");

  // Served byte-for-byte as uploaded. Nothing is decoded, rewritten or
  // injected, which also means HTML no longer pays a re-encode on every hit
  // and no per-request KV lookup is needed.
  return new Response(file.content, { headers });
}

export async function handleSite(env: Env, request: Request, forcedOwnerId?: string): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.hostname.replace(/:\d+$/, "");
  return handleSiteRequest(env, hostname, url.pathname, request.headers.get("Accept-Language"), forcedOwnerId);
}
