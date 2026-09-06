// Shared page shell: security/cache headers, a11y CSS, nav + footer chrome.

// Security posture: 27c.site serves no ads and loads no third-party scripts,
// so this CSP is a real boundary rather than a formality. Previously every
// fetch directive was forced open to `https:` because the ad tags chain-load
// from rotating, obfuscated hosts that cannot be allowlisted. With the ad tags
// gone, each directive is locked down to 'self'.
//
// The pages ship <style> blocks and small inline scripts (language toggle,
// copy-to-clipboard), so 'unsafe-inline' remains required for style-src and
// script-src. Images and fonts also allow data: — the favicon is served from
// /favicon.svg and there is no external font or CDN dependency.
//
// Note: this only governs PLATFORM pages. Deployed user sites set their own
// headers in routes/site.ts and are deliberately left unrestricted, so site
// owners can load whatever their own pages need.

export function pageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  };
}

export const A11Y_CSS = `
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; animation: none !important; }
      .btn:hover { transform: none; }
    }
`;

export const THEME_CSS = `
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
`;

export interface NavConfig {
  homeHref: string;
  links: { href: string; label: string }[];
  toggle: { href: string; label: string };
  logoHref: string;
}

export function navHtml(nav: NavConfig): string {
  const links = nav.links
    .map((l) => `<a class="nav-link" href="${l.href}">${l.label}</a>`)
    .join("\n      ");
  const targetLang = nav.toggle.href.startsWith("/zh") ? "zh" : "en";
  return `<nav>
    <a class="logo" href="${nav.logoHref}">27<span>c</span>.site</a>
    <div>
      ${links}
      <a class="nav-link lang-toggle" href="${nav.toggle.href}" hreflang="${targetLang}" onclick="document.cookie='27c_lang=${targetLang};path=/;max-age=31536000;samesite=lax'">${nav.toggle.label}</a>
    </div>
  </nav>`;
}

export function footerHtml(
  tagline: string,
  links: { href: string; label: string }[],
  wide = false
): string {
  const linkHtml = links.map((l) => `<a href="${l.href}">${l.label}</a>`).join("\n      ");
  return `<footer${wide ? ' style="max-width: 1200px; margin: 0 auto;"' : ""}>
    <p>${tagline}</p>
    <div class="footer-links">
      ${linkHtml}
    </div>
  </footer>`;
}
