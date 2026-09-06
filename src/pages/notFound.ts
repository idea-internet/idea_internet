import type { Dict } from "../locales";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 404 shell shared by the platform 404 and the *.27c.site subdomain 404s.
function shell(lang: string, title: string, messageHtml: string, cta: { label: string; href: string } | null, footerLinks: { href: string; label: string }[], tagline: string, logoHref: string, homeLabel: string): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="https://27c.site/favicon.svg">
  <title>${title} | 27c.site</title>
  <meta name="robots" content="noindex">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0b;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --accent: #10b981;
      --accent-hover: #34d399;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 2rem 1.5rem;
    }
    .code { font-size: clamp(4rem, 12vw, 7rem); font-weight: 700; letter-spacing: -0.04em; line-height: 1; }
    .code span { color: var(--accent); }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 1rem 0 0.5rem; }
    p { color: var(--text-muted); max-width: 46ch; margin-bottom: 2rem; }
    p code {
      font-family: "SF Mono", Monaco, monospace;
      font-size: 0.875em;
      color: var(--text);
      background: rgba(255, 255, 255, 0.06);
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      word-break: break-all;
    }
    a.btn {
      display: inline-flex;
      align-items: center;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 600;
      text-decoration: none;
      background: var(--accent);
      color: #000;
    }
    a.btn:hover { background: var(--accent-hover); }
    nav {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.25rem 2rem;
      max-width: 1200px;
      margin: 0 auto;
    }
    nav .logo { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; color: var(--accent); text-decoration: none; }
    nav .logo span { color: var(--text); }
    nav a.nav-link { color: var(--text-muted); text-decoration: none; font-size: 0.875rem; }
    footer {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 1.5rem;
      color: var(--text-muted);
      font-size: 0.8125rem;
    }
    footer a { color: var(--text-muted); text-decoration: none; margin: 0 0.625rem; }
    footer a:hover { color: var(--accent); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
  </style>
</head>
<body>
  <nav>
    <a class="logo" href="${logoHref}">27<span>c</span>.site</a>
    <a class="nav-link" href="${logoHref}">${homeLabel}</a>
  </nav>
  <div class="code">4<span>0</span>4</div>
  <h1>${title}</h1>
  <p>${messageHtml}</p>
  ${cta ? `<a class="btn" href="${cta.href}">${cta.label}</a>` : ""}
  <footer>
    <p>${tagline}</p>
    <div>${footerLinks.map((l) => `<a href="${l.href}">${l.label}</a>`).join("")}</div>
  </footer>
</body>
</html>`;
}

export function renderPlatformNotFound(d: Dict): string {
  return shell(
    d.htmlLang,
    d.notFound.title,
    d.notFound.message,
    { label: d.notFound.cta, href: d.pathPrefix + "/" },
    [
      { href: d.pathPrefix + "/", label: d.footer.home },
      { href: d.pathPrefix + "/docs", label: d.footer.docs },
      { href: d.pathPrefix + "/terms", label: d.footer.terms },
      { href: d.pathPrefix + "/privacy", label: d.footer.privacy },
    ],
    d.footer.tagline,
    d.pathPrefix + "/",
    d.nav.home
  );
}

export function renderSiteNotFound(d: Dict, subdomain: string): string {
  const sub = escapeHtml(`${subdomain}.27c.site`);
  return shell(
    d.htmlLang,
    d.siteNotFound.title,
    `${escapeHtml(d.siteNotFound.message)} <code>${sub}</code>. ${escapeHtml(d.siteNotFound.messageSuffix)}`,
    { label: d.siteNotFound.cta, href: "https://27c.site" + (d.pathPrefix || "/") },
    [],
    d.footer.poweredBy,
    "https://27c.site" + (d.pathPrefix || "/"),
    d.nav.home
  );
}

export function renderFileNotFound(d: Dict): string {
  return shell(
    d.htmlLang,
    d.fileNotFound.title,
    d.fileNotFound.message,
    null,
    [],
    d.footer.poweredBy,
    "https://27c.site" + (d.pathPrefix || "/"),
    d.nav.home
  );
}
