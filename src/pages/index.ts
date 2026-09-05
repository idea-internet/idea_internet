import { dictFor, localeFromPath, preferredLocale, type Dict } from "../locales";
import { pageHeaders } from "./layout";
import { renderHome } from "./home";
import { renderDocs } from "./docs";
import { renderPolicy } from "./policy";
import { renderPlatformNotFound } from "./notFound";
import { OG_IMAGE_BYTES } from "./og-image";

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#c4512d"/>
  <text x="32" y="43" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="700" letter-spacing="-2" fill="#fffdf8">27c</text>
</svg>`;

export function serveFavicon(): Response {
  return new Response(FAVICON_SVG, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
  });
}

// Canonical origin for SEO surfaces. Even though the Worker also answers on
// www.27c.site / 27ai.cloud, canonicals, hreflang and the sitemap all point
// here so search engines consolidate ranking onto a single host.
const SITE_ORIGIN = "https://27c.site";
const PAGE_PATHS = ["/", "/docs", "/terms", "/privacy"] as const;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: pageHeaders() });
}

function pageFor(d: Dict, pagePath: string): string {
  switch (pagePath) {
    case "/":
      return renderHome(d);
    case "/docs":
      return renderDocs(d);
    case "/terms":
      return renderPolicy(d, d.policy.terms);
    case "/privacy":
      return renderPolicy(d, d.policy.privacy);
    default:
      return renderPlatformNotFound(d);
  }
}

function robotsTxt(): string {
  // Machine endpoints carry no indexable content; keep them out of crawl
  // budgets and out of search results.
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /mcp",
    "Disallow: /mcp-config",
    "Disallow: /agent-prompt",
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

function sitemapXml(): string {
  const entry = (p: string): string => {
    const zhPath = p === "/" ? "/zh" : "/zh" + p;
    return [
      "  <url>",
      `    <loc>${SITE_ORIGIN}${p}</loc>`,
      `    <xhtml:link rel="alternate" hreflang="en" href="${SITE_ORIGIN}${p}"/>`,
      `    <xhtml:link rel="alternate" hreflang="zh" href="${SITE_ORIGIN}${zhPath}"/>`,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${p}"/>`,
      "  </url>",
    ].join("\n");
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${PAGE_PATHS.map(entry).join("\n")}
</urlset>
`;
}

// Platform pages: English at /, /docs, /terms, /privacy; Chinese under /zh/*.
export async function handlePages(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/favicon.svg" || path === "/favicon.ico") {
    return serveFavicon();
  }
  if (path === "/og-image.png") {
    return new Response(OG_IMAGE_BYTES, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" },
    });
  }
  if (path === "/robots.txt") {
    return new Response(robotsTxt(), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  }
  if (path === "/sitemap.xml") {
    return new Response(sitemapXml(), {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
  }

  // Auto-select language on first visit: if the user has no explicit locale in
  // the URL and their cookie/browser prefers Chinese, redirect to /zh.
  const { locale, pagePath } = localeFromPath(path);
  if (locale === "en" && preferredLocale(request) === "zh") {
    const target = "/zh" + (pagePath === "/" ? "" : pagePath);
    return new Response(null, { status: 302, headers: { Location: target } });
  }

  const html = pageFor(dictFor(locale), pagePath);
  const status = pagePath === "/" || pagePath === "/docs" || pagePath === "/terms" || pagePath === "/privacy" ? 200 : 404;
  return htmlResponse(html, status);
}
