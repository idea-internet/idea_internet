import { en } from "./en";
import type { Dict } from "./en";

export type { Dict };
import { zh } from "./zh";

export type Locale = "en" | "zh";

export const DICTS: Record<Locale, Dict> = { en, zh };

export function dictFor(locale: Locale): Dict {
  return DICTS[locale] || en;
}

export function localeFromPath(pathname: string): { locale: Locale; pagePath: string } {
  if (pathname === "/zh" || pathname.startsWith("/zh/")) {
    return { locale: "zh", pagePath: pathname.slice(3) || "/" };
  }
  return { locale: "en", pagePath: pathname };
}

export function localeFromAcceptLanguage(header: string | null): Locale {
  if (!header) return "en";
  return header.toLowerCase().split(",")[0].trim().startsWith("zh") ? "zh" : "en";
}

export function localeFromCookie(cookieHeader: string | null): Locale | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)27c_lang=([a-z]+)/);
  if (!match) return null;
  return match[1] === "zh" ? "zh" : match[1] === "en" ? "en" : null;
}

// Preferred language for a first visit: explicit cookie choice wins, then the
// browser's Accept-Language, defaulting to English.
export function preferredLocale(request: Request): Locale {
  const cookie = localeFromCookie(request.headers.get("Cookie"));
  if (cookie) return cookie;
  return localeFromAcceptLanguage(request.headers.get("Accept-Language"));
}

