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

/**
 * Shared nav styling, included by every platform page.
 *
 * Wide screens lay the links out in a row. Narrow screens (<=768px) collapse
 * them behind a hamburger: previously the links stayed inline and simply got a
 * smaller font, which made the labels overlap on a phone. The toggle is a
 * hidden checkbox plus a <label>, so the menu needs no JavaScript at all —
 * which keeps it working under the locked-down CSP and when JS is blocked.
 */
export const NAV_CSS = `
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
      padding: 1.25rem 2rem;
      border-bottom: 1px solid var(--border);
      max-width: 1200px;
      margin: 0 auto;
    }
    nav .logo { font-weight: 700; font-size: 1.5rem; letter-spacing: -0.02em; color: var(--accent); text-decoration: none; }
    nav .logo span { color: var(--text); }
    .nav-links { display: flex; gap: 1.5rem; align-items: center; }
    nav a.nav-link { color: var(--text-muted); text-decoration: none; font-size: 0.875rem; font-weight: 500; transition: color 0.2s; }
    nav a.nav-link:hover { color: var(--text); }
    nav a.lang-toggle { color: var(--accent); }

    /* Hamburger — desktop keeps it hidden, <=768px swaps the row for a panel. */
    .nav-toggle { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
    .nav-burger { display: none; width: 44px; height: 44px; margin-right: -0.5rem; align-items: center; justify-content: center; cursor: pointer; border-radius: 8px; -webkit-tap-highlight-color: transparent; }
    .nav-burger span { position: relative; display: block; width: 22px; height: 2px; background: var(--text); border-radius: 2px; }
    .nav-burger span::before, .nav-burger span::after { content: ""; position: absolute; left: 0; width: 22px; height: 2px; background: var(--text); border-radius: 2px; transition: transform 0.2s; }
    .nav-burger span::before { transform: translateY(-7px); }
    .nav-burger span::after { transform: translateY(7px); }
    .nav-toggle:checked ~ .nav-burger span { background: transparent; }
    .nav-toggle:checked ~ .nav-burger span::before { transform: rotate(45deg); }
    .nav-toggle:checked ~ .nav-burger span::after { transform: rotate(-45deg); }
    .nav-toggle:focus-visible ~ .nav-burger { outline: 2px solid var(--accent); outline-offset: 2px; }

    @media (max-width: 768px) {
      nav { padding: 1rem 1.25rem; gap: 0; }
      .nav-burger { display: flex; }
      .nav-links {
        display: none;
        width: 100%;
        flex-direction: column;
        align-items: stretch;
        gap: 0;
        margin-top: 0.75rem;
        padding-top: 0.5rem;
        border-top: 1px solid var(--border);
      }
      .nav-toggle:checked ~ .nav-links { display: flex; }
      nav a.nav-link { padding: 0.875rem 0.25rem; font-size: 1rem; }
      nav a.nav-link:hover { color: var(--accent); }
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
    .join("\n        ");
  const targetLang = nav.toggle.href.startsWith("/zh") ? "zh" : "en";
  // The checkbox MUST stay a sibling of .nav-links (and precede it) for the
  // `.nav-toggle:checked ~ .nav-links` rule to open the panel.
  return `<nav>
    <a class="logo" href="${nav.logoHref}">27<span>c</span>.site</a>
    <input class="nav-toggle" type="checkbox" id="27c-nav-toggle" aria-label="Menu">
    <label class="nav-burger" for="27c-nav-toggle"><span></span></label>
    <div class="nav-links">
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
