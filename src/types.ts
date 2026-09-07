export interface Env {
  SITE_STORAGE: KVNamespace;
  SITE_ASSETS: R2Bucket;
  /**
   * Shared Neon Postgres pool (Worker secrets). Each site's table is assigned
   * to one member of the pool at random when the site is provisioned, and the
   * assignment is persisted with the table. Deliberately secrets, never plain
   * vars or page constants: they carry owner rights to whole databases and
   * must not be readable from client code. All optional so tests can build an
   * Env with any subset.
   */
  NEON_DATABASE_URL?: string;
  NEON_DATABASE_URL_2?: string;
  NEON_DATABASE_URL_3?: string;
}

export const PLATFORM_DOMAINS = [
  "27c.site",
  "27ai.cloud",
  "27c-site.ccwu.cc",
  "idea-27c.ccwu.cc",
  "prourl.ccwu.cc",
] as const;
export type PlatformDomain = (typeof PLATFORM_DOMAINS)[number];

/**
 * Resolve a request hostname to the platform domain it belongs to.
 *
 * All FIVE platform domains are INDEPENDENT: each keeps its own subdomain
 * namespace, its own accounts, and its own prompt identity. 27c.site and
 * 27ai.cloud form a switchable pair; the three ccwu.cc domains are standalone
 * and can never switch to or from anything else.
 *
 * Handles exact hostnames (root, www.*, api.*) and any deeper subdomain by
 * suffix. Returns null for hosts that are not part of any platform.
 */
const HOST_SUFFIX_TO_DOMAIN: Array<[string, PlatformDomain]> = [
  [".27c.site", "27c.site"],
  [".27ai.cloud", "27ai.cloud"],
  [".27c-site.ccwu.cc", "27c-site.ccwu.cc"],
  [".idea-27c.ccwu.cc", "idea-27c.ccwu.cc"],
  [".prourl.ccwu.cc", "prourl.ccwu.cc"],
];

export function platformDomainOf(hostname: string): PlatformDomain | null {
  const h = hostname.toLowerCase().replace(/:\d+$/, "");
  for (const d of PLATFORM_DOMAINS) {
    if (h === d || h === `www.${d}` || h === `api.${d}`) return d;
  }
  for (const [suffix, d] of HOST_SUFFIX_TO_DOMAIN) {
    if (h.endsWith(suffix)) return d;
  }
  return null;
}

/** Accounts created before domains became exclusive have no stored value. */
export function normalizeDomain(domain?: string | null): PlatformDomain {
  switch (domain) {
    case "27ai.cloud":
      return "27ai.cloud";
    case "27c-site.ccwu.cc":
      return "27c-site.ccwu.cc";
    case "idea-27c.ccwu.cc":
      return "idea-27c.ccwu.cc";
    case "prourl.ccwu.cc":
      return "prourl.ccwu.cc";
    default:
      return "27c.site";
  }
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  subdomain: string;
  /**
   * The single platform domain this site is served on. It is EXCLUSIVE: the
   * other platform domain must not resolve for this subdomain. Absent on legacy
   * accounts, which count as "27c.site".
   */
  domain?: PlatformDomain;
  createdAt: number;
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  key: string;
  createdAt: number;
  lastUsed?: number;
}

export interface Deployment {
  id: string;
  userId: string;
  files: { path: string; size: number }[];
  deployedAt: number;
  note?: string;
}

export interface SiteFile {
  path: string;
  contentType: string;
  content: ArrayBuffer;
  size: number;
  uploadedAt: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  total?: number;
  [key: string]: unknown;
}
