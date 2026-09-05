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

export const PLATFORM_DOMAINS = ["27c.site", "27ai.cloud"] as const;
export type PlatformDomain = (typeof PLATFORM_DOMAINS)[number];

/** Accounts created before domains became exclusive have no stored value. */
export function normalizeDomain(domain?: string | null): PlatformDomain {
  return domain === "27ai.cloud" ? "27ai.cloud" : "27c.site";
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
