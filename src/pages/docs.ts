import type { Dict } from "../locales";
import { navHtml, footerHtml } from "./layout";

export function renderDocs(d: Dict): string {
  const toolList = d.docs.opt1.tools.map((t) => `<li>${t}</li>`).join("\n      ");

  const apiRows = d.docs.opt2.rows
    .map((r) => {
      const [method, path, auth, note] = r;
      const methodClass = method === "GET" ? "method-get" : method === "DELETE" ? "method-delete" : "method-post";
      return `<tr><td><code><span class="method ${methodClass}">${method}</span>${path}</code></td><td>${auth}</td><td>${note}</td></tr>`;
    })
    .join("\n        ");

  const limitRows = d.docs.limits.rows
    .map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`)
    .join("\n        ");

  const fileRules = d.docs.opt2.fileRules.map((r) => `<li>${r}</li>`).join("\n      ");

  // SEO: canonical self URL + TechArticle JSON-LD, tied into the homepage's
  // Organization/WebSite graph via @id refs.
  const selfUrl = d.pathPrefix === "/zh" ? "https://27c.site/zh/docs" : "https://27c.site/docs";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: d.docs.meta.title,
    url: selfUrl,
    description: d.docs.meta.description,
    isPartOf: { "@id": "https://27c.site/#website" },
    inLanguage: d.lang === "zh" ? "zh-CN" : "en",
    publisher: { "@id": "https://27c.site/#org" },
  });

  return `<!DOCTYPE html>
<html lang="${d.htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>${d.docs.meta.title}</title>
  <meta name="description" content="${d.docs.meta.description}">
  <meta name="theme-color" content="#0a0a0b">
  <link rel="canonical" href="${selfUrl}">
  <link rel="alternate" hreflang="en" href="https://27c.site/docs">
  <link rel="alternate" hreflang="zh" href="https://27c.site/zh/docs">
  <link rel="alternate" hreflang="x-default" href="https://27c.site/docs">
  <meta property="og:site_name" content="27c.site">
  <meta property="og:title" content="${d.docs.meta.ogTitle}">
  <meta property="og:description" content="${d.docs.meta.ogDescription}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${selfUrl}">
  <meta property="og:image" content="https://27c.site/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="${d.lang === "zh" ? "zh_CN" : "en_US"}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${d.docs.meta.ogTitle}">
  <meta name="twitter:description" content="${d.docs.meta.ogDescription}">
  <meta name="twitter:image" content="https://27c.site/og-image.png">
  <script type="application/ld+json">${jsonLd}</script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0b;
      --surface: #141416;
      --surface-hover: #1c1c1f;
      --border: #2a2a2d;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --accent: #10b981;
      --accent-hover: #34d399;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
    }
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.25rem 2rem;
      border-bottom: 1px solid var(--border);
      max-width: 900px;
      margin: 0 auto;
    }
    nav .logo { font-weight: 700; font-size: 1.125rem; color: var(--text); text-decoration: none; }
    nav .logo span { color: var(--accent); }
    nav a.nav-link { color: var(--text-muted); text-decoration: none; font-size: 0.875rem; margin-left: 1.25rem; }
    nav a.nav-link:hover { color: var(--accent); }
    nav a.lang-toggle { color: var(--accent); }
    main { max-width: 820px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
    h1 { font-size: clamp(1.75rem, 4vw, 2.25rem); font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.5rem; }
    h2 { font-size: 1.375rem; font-weight: 700; margin: 2.75rem 0 0.75rem; }
    h3 { font-size: 1rem; font-weight: 600; margin: 1.5rem 0 0.5rem; }
    .lead { color: var(--text-muted); margin-bottom: 1.5rem; max-width: 72ch; }
    p { color: var(--text-muted); margin-bottom: 1rem; max-width: 78ch; }
    ul { margin: 0.5rem 0 1rem 1.25rem; color: var(--text-muted); }
    li { margin-bottom: 0.375rem; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem 1.75rem;
      margin-bottom: 1.25rem;
    }
    .card h3 { margin-top: 0; }
    .card p { margin-bottom: 0; }
    code {
      font-family: "SF Mono", Monaco, Consolas, monospace;
      font-size: 0.875em;
      color: var(--text);
      background: rgba(255, 255, 255, 0.06);
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
    }
    .method { font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 0.75rem; font-weight: 700; padding: 0.2rem 0.5rem; border-radius: 4px; margin-right: 0.5rem; }
    .method-post { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .method-get { background: rgba(96, 165, 250, 0.15); color: #93c5fd; }
    .method-delete { background: rgba(248, 113, 113, 0.15); color: #fca5a5; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; margin: 1rem 0 1.5rem; }
    th, td { padding: 0.75rem 1rem; border: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { background: var(--surface-hover); color: var(--text); font-weight: 600; }
    td { background: var(--surface); color: var(--text-muted); }
    td code { background: transparent; padding: 0; color: var(--text); }
    footer {
      border-top: 1px solid var(--border);
      padding: 2rem;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.8125rem;
    }
    footer .footer-links { margin-top: 0.75rem; display: flex; justify-content: center; gap: 1.25rem; flex-wrap: wrap; }
    footer .footer-links a { color: var(--text-muted); text-decoration: none; }
    footer .footer-links a:hover { color: var(--accent); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
    @media (max-width: 768px) {
      nav { padding: 1rem 1.5rem; }
      main { padding: 2rem 1.25rem 3rem; }
      th, td { padding: 0.625rem 0.75rem; font-size: 0.875rem; }
    }
  </style>
</head>
<body>
  ${navHtml({
    homeHref: d.pathPrefix + "/",
    logoHref: d.pathPrefix + "/",
    links: [
      { href: d.pathPrefix + "/", label: d.nav.home },
      { href: d.pathPrefix + "/terms", label: d.nav.terms },
      { href: d.pathPrefix + "/privacy", label: d.nav.privacy },
    ],
    toggle: { href: d.pathPrefix === "/zh" ? "/docs" : "/zh/docs", label: d.langToggle.label },
  })}
  <main>
    <h1>${d.docs.h1}</h1>
    <p class="lead">${d.docs.lead}</p>

    <h2 id="agent">${d.docs.opt1.title}</h2>
    <p>${d.docs.opt1.desc1} <a href="${d.pathPrefix === "/zh" ? "/zh" : "/"}" style="color: var(--accent);">27c.site</a> ${d.docs.opt1.desc2}</p>
    <div class="card">
      <h3>${d.docs.opt1.promptTitle}</h3>
      <p>${d.docs.opt1.promptIntro}</p>
      <p style="margin-top: 0.75rem;"><code style="display: block; padding: 0.75rem 1rem; white-space: pre-wrap;">${d.docs.opt1.prompt}</code></p>
    </div>
    <h3>${d.docs.opt1.toolsTitle}</h3>
    <ul>
      ${toolList}
    </ul>

    <h2 id="api">${d.docs.opt2.title}</h2>
    <p>${d.docs.opt2.desc1} <code>https://27c.site</code>${d.docs.opt2.desc2}</p>
    <table>
      <thead><tr><th>${d.docs.opt2.cols[0]}</th><th>${d.docs.opt2.cols[1]}</th><th>${d.docs.opt2.cols[2]}</th></tr></thead>
      <tbody>
        ${apiRows}
      </tbody>
    </table>
    <h3>${d.docs.opt2.fileRulesTitle}</h3>
    <ul>
      ${fileRules}
    </ul>

    <h2 id="data">${d.docs.dataApi.title}</h2>
    <p>${d.docs.dataApi.p1}</p>
    <p>${d.docs.dataApi.p2}</p>
    <h3>${d.docs.dataApi.exampleTitle}</h3>
    <code style="display: block; padding: 0.75rem 1rem; white-space: pre-wrap;">// Save a form submission (runs inside your site's page)
await fetch("https://27c.site/api/db", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: TABLE_TOKEN, action: "add", data: { name, message } })
});

// List the saved rows
await fetch("https://27c.site/api/db", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: TABLE_TOKEN, action: "list" })
});</code>

    <h2 id="limits">${d.docs.limits.title}</h2>
    <table>
      <thead><tr><th>${d.docs.limits.cols[0]}</th><th>${d.docs.limits.cols[1]}</th></tr></thead>
      <tbody>
        ${limitRows}
      </tbody>
    </table>
  </main>
  ${footerHtml(d.footer.tagline, [
    { href: d.pathPrefix + "/", label: d.footer.home },
    { href: d.pathPrefix + "/docs", label: d.footer.docs },
    { href: d.pathPrefix + "/terms", label: d.footer.terms },
    { href: d.pathPrefix + "/privacy", label: d.footer.privacy },
  ])}
</body>
</html>`;
}
