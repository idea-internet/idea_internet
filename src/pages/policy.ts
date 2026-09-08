import type { Dict } from "../locales";
import { A11Y_CSS, NAV_CSS, navHtml, footerHtml } from "./layout";

export interface PolicyContent {
  path: string;
  title: string;
  updated: string;
  metaDescription: string;
  intro: string;
  sections: { heading: string; body: string; list?: string[] }[];
}

export function renderPolicy(d: Dict, c: PolicyContent): string {
  const sectionHtml = c.sections
    .map((s) => {
      const listHtml = s.list ? `<ul>${s.list.map((i) => `<li>${i}</li>`).join("")}</ul>` : "";
      return `<div class="policy-card">
      <h2>${s.heading}</h2>
      <p>${s.body}</p>
      ${listHtml}
    </div>`;
    })
    .join("\n");

  const other = c.path === "/terms" ? { href: d.pathPrefix + "/privacy", label: d.policy.otherLinks.privacy } : { href: d.pathPrefix + "/terms", label: d.policy.otherLinks.terms };
  const selfPath = d.pathPrefix + c.path;
  const selfUrl = "https://27c.site" + selfPath;

  // SEO: WebPage + BreadcrumbList. isPartOf links this page into the WebSite
  // entity declared on the homepage's JSON-LD graph.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${c.title} - 27c.site`,
    url: selfUrl,
    description: c.metaDescription,
    isPartOf: { "@id": "https://27c.site/#website" },
    inLanguage: d.lang === "zh" ? "zh-CN" : "en",
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://27c.site/" },
        { "@type": "ListItem", position: 2, name: c.title, item: selfUrl },
      ],
    },
  });

  return `<!DOCTYPE html>
<html lang="${d.htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>${c.title} - 27c.site</title>
  <meta name="description" content="${c.metaDescription}">
  <meta name="theme-color" content="#0a0a0b">
  <link rel="canonical" href="${selfUrl}">
  <link rel="alternate" hreflang="en" href="https://27c.site${c.path}">
  <link rel="alternate" hreflang="zh" href="https://27c.site/zh${c.path}">
  <link rel="alternate" hreflang="x-default" href="https://27c.site${c.path}">
  <meta property="og:site_name" content="27c.site">
  <meta property="og:title" content="${c.title} - 27c.site">
  <meta property="og:description" content="${c.metaDescription}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${selfUrl}">
  <meta property="og:image" content="https://27c.site/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="${d.lang === "zh" ? "zh_CN" : "en_US"}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${c.title} - 27c.site">
  <meta name="twitter:description" content="${c.metaDescription}">
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
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
    }
    ${NAV_CSS}
    nav { max-width: 900px; }
    nav .logo { font-size: 1.125rem; color: var(--text); }
    nav .logo span { color: var(--accent); }
    main { max-width: 820px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
    h1 { font-size: clamp(1.75rem, 4vw, 2.25rem); font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.5rem; }
    .updated { color: var(--text-muted); font-size: 0.875rem; margin-bottom: 1.5rem; }
    .intro { color: var(--text-muted); margin-bottom: 2rem; max-width: 72ch; }
    .policy-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem 1.75rem;
      margin-bottom: 1.25rem;
    }
    .policy-card h2 { font-size: 1.125rem; font-weight: 600; margin-bottom: 0.75rem; }
    .policy-card p { color: var(--text-muted); font-size: 0.9375rem; }
    .policy-card a { color: var(--accent); text-decoration: none; }
    .policy-card a:hover { color: var(--accent-hover); text-decoration: underline; }
    .policy-card ul { margin: 0.5rem 0 0 1.25rem; color: var(--text-muted); font-size: 0.9375rem; }
    .policy-card li { margin-bottom: 0.375rem; }
    footer {
      border-top: 1px solid var(--border);
      padding: 2rem;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.8125rem;
    }
    footer .footer-links { margin-top: 0.75rem; display: flex; justify-content: center; gap: 1.25rem; }
    footer .footer-links a { color: var(--text-muted); text-decoration: none; }
    footer .footer-links a:hover { color: var(--accent); }
    ${A11Y_CSS}
  </style>
</head>
<body>
  ${navHtml({
    homeHref: d.pathPrefix + "/",
    logoHref: d.pathPrefix + "/",
    links: [
      { href: d.pathPrefix + "/", label: d.nav.home },
      { href: d.pathPrefix + "/docs", label: d.nav.docs },
      { href: other.href, label: other.label },
    ],
    toggle: { href: (d.pathPrefix === "/zh" ? "" : "/zh") + c.path, label: d.langToggle.label },
  })}
  <main>
    <h1>${c.title}</h1>
    <p class="updated">${d.policy.updatedPrefix} ${c.updated}</p>
    <p class="intro">${c.intro}</p>
    ${sectionHtml}
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
