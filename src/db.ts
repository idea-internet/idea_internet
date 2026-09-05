import type { User, ApiKey, Deployment, SiteFile, PlatformDomain } from "./types";
import { normalizeDomain } from "./types";
import { getContentType } from "./auth";

export interface SiteKvEnv {
  SITE_STORAGE: KVNamespace;
}
export interface SiteEnv {
  SITE_STORAGE: KVNamespace;
  SITE_ASSETS: R2Bucket;
}

export async function getUser(env: SiteKvEnv, username: string): Promise<User | null> {
  const key = `user:${username}`;
  const data = await env.SITE_STORAGE.get(key, "json");
  return data as User | null;
}

export async function getUserById(env: SiteKvEnv, userId: string): Promise<User | null> {
  const data = await env.SITE_STORAGE.get(`user:id:${userId}`, "json");
  return data as User | null;
}

export async function createUser(env: SiteKvEnv, user: User): Promise<void> {
  await env.SITE_STORAGE.put(`user:${user.username}`, JSON.stringify(user));
  await env.SITE_STORAGE.put(`user:id:${user.id}`, JSON.stringify(user));
  if (user.subdomain) {
    await claimSubdomain(env, user.subdomain, normalizeDomain(user.domain), user.id);
  }
}

export async function updateUser(env: SiteKvEnv, user: User): Promise<void> {
  await env.SITE_STORAGE.put(`user:${user.username}`, JSON.stringify(user));
  await env.SITE_STORAGE.put(`user:id:${user.id}`, JSON.stringify(user));
  if (user.subdomain) {
    await claimSubdomain(env, user.subdomain, normalizeDomain(user.domain), user.id);
  }
}

function scopedSubKey(domain: PlatformDomain, subdomain: string): string {
  return `sub:${domain}:${subdomain}`;
}

/** Claims written before the two platform domains were separated. Global. */
function legacySubKey(subdomain: string): string {
  return `subdomain:${subdomain}`;
}

/**
 * Resolve the owner of a subdomain within ONE platform domain.
 *
 * Subdomains are namespaced per platform domain, so "foo" on 27c.site and "foo"
 * on 27ai.cloud are independent claims. Pre-split claims live under the legacy
 * global key and are honoured for 27c.site only, so existing accounts keep
 * working without a bulk migration.
 */
export async function getSubdomainOwner(
  env: SiteKvEnv,
  subdomain: string,
  domain: PlatformDomain = "27c.site"
): Promise<string | null> {
  const scoped = await env.SITE_STORAGE.get(scopedSubKey(domain, subdomain), "text");
  if (scoped) return scoped;
  if (domain === "27c.site") {
    const legacy = await env.SITE_STORAGE.get(legacySubKey(subdomain), "text");
    if (legacy) return legacy;
  }
  return null;
}

export async function subdomainExists(
  env: SiteKvEnv,
  subdomain: string,
  domain: PlatformDomain = "27c.site"
): Promise<boolean> {
  return (await getSubdomainOwner(env, subdomain, domain)) !== null;
}

export async function claimSubdomain(
  env: SiteKvEnv,
  subdomain: string,
  domain: PlatformDomain,
  userId: string
): Promise<void> {
  await env.SITE_STORAGE.put(scopedSubKey(domain, subdomain), userId);
}

/** Drop every claim this user holds on a subdomain, across both namespaces. */
export async function releaseSubdomain(env: SiteKvEnv, subdomain: string, userId: string): Promise<void> {
  const keys = [
    scopedSubKey("27c.site", subdomain),
    scopedSubKey("27ai.cloud", subdomain),
    legacySubKey(subdomain),
  ];
  for (const key of keys) {
    const owner = await env.SITE_STORAGE.get(key, "text");
    if (owner === userId) await env.SITE_STORAGE.delete(key);
  }
}

export async function getApiKeys(env: SiteKvEnv, userId: string): Promise<ApiKey[]> {
  const keys: ApiKey[] = [];
  let cursor: string | undefined;
  do {
    const result = await env.SITE_STORAGE.list({ prefix: `apikey:${userId}:`, cursor });
    for (const entry of result.keys) {
      const data = await env.SITE_STORAGE.get(entry.name, "json");
      if (data) keys.push(data as ApiKey);
    }
    cursor = (result as { cursor?: string }).cursor || undefined;
  } while (cursor);
  return keys;
}

export async function getApiKey(env: SiteKvEnv, key: string): Promise<ApiKey | null> {
  const data = await env.SITE_STORAGE.get(`apikey:global:${key}`, "json");
  return data as ApiKey | null;
}

export async function createApiKey(env: SiteKvEnv, apiKey: ApiKey): Promise<void> {
  await env.SITE_STORAGE.put(`apikey:${apiKey.userId}:${apiKey.id}`, JSON.stringify(apiKey));
  await env.SITE_STORAGE.put(`apikey:global:${apiKey.key}`, JSON.stringify(apiKey));
}

export async function deleteApiKey(env: SiteKvEnv, apiKey: ApiKey): Promise<void> {
  await env.SITE_STORAGE.delete(`apikey:${apiKey.userId}:${apiKey.id}`);
  await env.SITE_STORAGE.delete(`apikey:global:${apiKey.key}`);
}

export async function getDeployments(env: SiteKvEnv, userId: string): Promise<Deployment[]> {
  const deployments: Deployment[] = [];
  let cursor: string | undefined;
  do {
    const result = await env.SITE_STORAGE.list({ prefix: `deployment:${userId}:`, cursor });
    for (const entry of result.keys) {
      if (entry.name.endsWith(":snapshot")) continue;
      const data = await env.SITE_STORAGE.get(entry.name, "json");
      if (data) deployments.push(data as Deployment);
    }
    cursor = (result as { cursor?: string }).cursor || undefined;
  } while (cursor);
  deployments.sort((a, b) => b.deployedAt - a.deployedAt);
  return deployments;
}

export async function createDeployment(env: SiteKvEnv, deployment: Deployment): Promise<void> {
  await env.SITE_STORAGE.put(`deployment:${deployment.userId}:${deployment.id}`, JSON.stringify(deployment));
}

export async function getSiteFile(env: SiteEnv, userId: string, path: string): Promise<SiteFile | null> {
  const object = await env.SITE_ASSETS.get(`user/${userId}/${path}`);
  if (!object || !object.body) return null;
  const data = await object.arrayBuffer();
  const contentType = object.httpMetadata?.contentType || getContentType(path);
  return {
    path,
    contentType,
    content: data,
    size: object.size || data.byteLength,
    uploadedAt: Date.now(),
  };
}

export async function listSiteFiles(env: SiteEnv, userId: string, prefix?: string): Promise<SiteFile[]> {
  const files: SiteFile[] = [];
  let cursor: string | undefined;
  const searchPrefix = `user/${userId}/${prefix || ""}`;
  do {
    const result = await env.SITE_ASSETS.list({ prefix: searchPrefix, cursor });
    for (const entry of result.objects) {
      const path = entry.key.slice(`user/${userId}/`.length);
      const object = await env.SITE_ASSETS.get(entry.key);
      if (object && object.body) {
        const data = await object.arrayBuffer();
        const contentType = object.httpMetadata?.contentType || getContentType(path);
        files.push({
          path,
          contentType,
          content: data,
          size: object.size || data.byteLength,
          uploadedAt: Date.now(),
        });
      }
    }
    cursor = (result as { cursor?: string }).cursor;
  } while (cursor);
  return files;
}

// Like listSiteFiles but returns metadata only (no content fetch). Use this
// when you only need the file manifest — e.g. building a deploy snapshot — so
// a deploy no longer does an O(N) read of every existing file's bytes from R2.
export async function listSiteFilesMeta(env: SiteEnv, userId: string, prefix?: string): Promise<{ path: string; contentType: string; size: number }[]> {
  const files: { path: string; contentType: string; size: number }[] = [];
  let cursor: string | undefined;
  const searchPrefix = `user/${userId}/${prefix || ""}`;
  do {
    const result = await env.SITE_ASSETS.list({ prefix: searchPrefix, cursor });
    for (const entry of result.objects) {
      const path = entry.key.slice(`user/${userId}/`.length);
      const contentType = entry.httpMetadata?.contentType || getContentType(path);
      files.push({ path, contentType, size: entry.size });
    }
    cursor = (result as { cursor?: string }).cursor;
  } while (cursor);
  return files;
}

export async function putSiteFile(env: SiteEnv, userId: string, path: string, content: ArrayBuffer, contentType: string): Promise<void> {
  await env.SITE_ASSETS.put(`user/${userId}/${path}`, content, {
    httpMetadata: { contentType },
  });
}

export async function deleteSiteFile(env: SiteEnv, userId: string, path: string): Promise<void> {
  await env.SITE_ASSETS.delete(`user/${userId}/${path}`);
}

export async function deleteSiteFiles(env: SiteEnv, userId: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    await env.SITE_ASSETS.delete(`user/${userId}/${p}`);
  }
}

export type SnapshotItemToStore = {
  path: string;
  contentType: string;
  size: number;
  content?: ArrayBuffer;
};

export async function createDeploymentSnapshot(env: SiteEnv, userId: string, deploymentId: string, items: SnapshotItemToStore[]): Promise<void> {
  const snapshot: { path: string; contentType: string; size: number; objectKey?: string }[] = [];
  for (const f of items) {
    if (f.content) {
      const objectKey = `snapshot/${userId}/${deploymentId}/files/${encodeURIComponent(f.path)}`;
      await env.SITE_ASSETS.put(objectKey, f.content, { httpMetadata: { contentType: f.contentType } });
      snapshot.push({ path: f.path, contentType: f.contentType, size: f.size, objectKey });
    } else {
      snapshot.push({ path: f.path, contentType: f.contentType, size: f.size });
    }
  }
  await env.SITE_ASSETS.put(`snapshot/${userId}/${deploymentId}`, JSON.stringify(snapshot), {
    httpMetadata: { contentType: "application/json" },
  });
}

export type DeploymentSnapshotItem = {
  path: string;
  contentType: string;
  size: number;
  content?: ArrayBuffer; // present for restorable files
  truncated?: boolean;   // retained for backwards compatibility
};
export type DeploymentSnapshot = DeploymentSnapshotItem[] | null;

export async function getDeploymentSnapshot(env: SiteEnv, userId: string, deploymentId: string): Promise<DeploymentSnapshot> {
  // New snapshots live in R2; fall back to KV for deployments created before the migration.
  let raw: string | null = null;
  const object = await env.SITE_ASSETS.get(`snapshot/${userId}/${deploymentId}`);
  if (object && object.body) {
    raw = await object.text();
  } else {
    raw = await env.SITE_STORAGE.get(`deployment:${userId}:${deploymentId}:snapshot`, "text");
  }
  if (!raw) return null;
  const snapshot = JSON.parse(raw) as { path: string; contentType: string; base64?: string; objectKey?: string; size: number; truncated?: boolean }[];
  const result: DeploymentSnapshotItem[] = [];
  for (const f of snapshot) {
    if (f.truncated) {
      result.push({ path: f.path, contentType: f.contentType, size: f.size, truncated: true });
      continue;
    }
    if (f.objectKey) {
      const fileObject = await env.SITE_ASSETS.get(f.objectKey);
      if (!fileObject || !fileObject.body) {
        result.push({ path: f.path, contentType: f.contentType, size: f.size, truncated: true });
      } else {
        result.push({ path: f.path, contentType: f.contentType, size: f.size, content: await fileObject.arrayBuffer() });
      }
      continue;
    }
    if (f.base64 !== undefined) {
      const binaryString = atob(f.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      result.push({ path: f.path, contentType: f.contentType, content: bytes.buffer.slice(0) as ArrayBuffer, size: f.size });
    } else {
      // Old metadata-only snapshots remain readable, but cannot restore bytes
      // that changed after the snapshot was created.
      result.push({ path: f.path, contentType: f.contentType, size: f.size });
    }
  }
  return result;
}

export async function pruneOldDeployments(env: SiteEnv, userId: string, keep: number = 50): Promise<void> {
  const deployments = await getDeployments(env, userId);
  if (deployments.length <= keep) return;
  const toDelete = deployments.slice(keep);
  for (const dep of toDelete) {
    await env.SITE_STORAGE.delete(`deployment:${userId}:${dep.id}`);
    await env.SITE_STORAGE.delete(`deployment:${userId}:${dep.id}:snapshot`);
    await env.SITE_ASSETS.delete(`snapshot/${userId}/${dep.id}`);
    let cursor: string | undefined;
    do {
      const result = await env.SITE_ASSETS.list({ prefix: `snapshot/${userId}/${dep.id}/files/`, cursor });
      const keys = result.objects.map((o) => o.key);
      if (keys.length > 0) await env.SITE_ASSETS.delete(keys);
      cursor = (result as { cursor?: string }).cursor || undefined;
    } while (cursor);
  }
}

export async function deleteUserData(env: SiteEnv, userId: string, username: string): Promise<void> {
  const user = await getUser(env, username);
  if (user && user.subdomain) {
    await releaseSubdomain(env, user.subdomain, user.id);
  }
  await env.SITE_STORAGE.delete(`user:${username}`);
  await env.SITE_STORAGE.delete(`user:id:${userId}`);

  // Database teardown is normally performed by the API layer (which can also
  // issue DROP TABLE to Neon), but remove all local references here too so
  // this low-level cleanup cannot leave credentials or table claims behind.
  const dbConfig = await env.SITE_STORAGE.get(`dbtable:${userId}`, "json") as { table?: string; token?: string; db?: number } | null;
  await env.SITE_STORAGE.delete(`dbtable:${userId}`);
  if (dbConfig?.token) await env.SITE_STORAGE.delete(`dbtoken:${dbConfig.token}`);
  if (dbConfig?.table) {
    await env.SITE_STORAGE.delete(`dbname:${dbConfig.table}`);
    await env.SITE_STORAGE.delete(`dbddl:${dbConfig.db ?? 0}:${dbConfig.table}`);
  }

  // Delete API key records (per-user + global index).
  const apiKeys = await getApiKeys(env, userId);
  for (const k of apiKeys) {
    await deleteApiKey(env, k);
  }

  // Delete deployment metadata, snapshots, and legacy KV site-file records.
  const kvKeysToDelete: string[] = [];
  for (const prefix of [`${userId}:`, `site:${userId}:`, `deployment:${userId}:`]) {
    let cursor: string | undefined;
    do {
      const result = await env.SITE_STORAGE.list({ prefix, cursor });
      for (const entry of result.keys) kvKeysToDelete.push(entry.name);
      cursor = (result as { cursor?: string }).cursor || undefined;
    } while (cursor);
  }
  for (const key of new Set(kvKeysToDelete)) {
    await env.SITE_STORAGE.delete(key);
  }

  // Delete R2 site files and snapshots.
  for (const prefix of [`user/${userId}/`, `snapshot/${userId}/`]) {
    let r2Cursor: string | undefined;
    do {
      const result = await env.SITE_ASSETS.list({ prefix, cursor: r2Cursor });
      const keys = result.objects.map((o) => o.key);
      if (keys.length > 0) await env.SITE_ASSETS.delete(keys);
      r2Cursor = (result as { cursor?: string }).cursor || undefined;
    } while (r2Cursor);
  }
}
