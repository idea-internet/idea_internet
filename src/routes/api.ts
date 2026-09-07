import { Env, ApiResponse, User, ApiKey, Deployment, normalizeDomain, type PlatformDomain } from "../types";
import { getUser, createUser, updateUser, getApiKeys, createApiKey, deleteApiKey, getDeployments, createDeployment, putSiteFile, subdomainExists, getUserById, createDeploymentSnapshot, pruneOldDeployments, getDeploymentSnapshot, listSiteFiles, listSiteFilesMeta, deleteSiteFiles, getSubdomainOwner, deleteUserData, releaseSubdomain, type SnapshotItemToStore } from "../db";
import { hashPassword, verifyPassword, generateApiKey, generateId, generateDeploymentId, isReservedSubdomain, sanitizeSubdomain, isValidSubdomain, isValidPath, getContentType } from "../auth";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "../ratelimit";
import { provisionDatabase, getDatabaseConfig, getDatabaseByToken, runDbOp, dbErrorMessage, deleteDatabase, type DbOp } from "../database";
import { getTasteSkillMarkdown } from "../skills/taste-skill";

// Request/file caps
const MAX_DEPLOY_FILES = 200;
const MAX_DEPLOY_BODY_BYTES = 50 * 1024 * 1024; // 50MB JSON body
const MAX_UPLOAD_FILES = 200;
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024; // 25MB per file
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB per upload request

async function parseJsonBody(request: Request, maxBytes?: number): Promise<unknown> {
  try {
    const raw = await request.arrayBuffer();
    if (maxBytes !== undefined && raw.byteLength > maxBytes) return null;
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

function jsonResponse(data: ApiResponse, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...extraHeaders,
    },
  });
}

function contentLengthWithin(request: Request, max: number): boolean {
  const len = parseInt(request.headers.get("Content-Length") || "0", 10);
  return isNaN(len) || len <= max;
}

function retryAfterHeaders(resetAt: number): Record<string, string> {
  const seconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return { "Retry-After": String(seconds) };
}

// --- Live platform statistics ------------------------------------------------
// The "users served" figure is a REAL count over the KV account index
// (`user:id:<id>` keys), not a stored counter — so it self-heals: both
// registrations and account deletions are reflected, and there is no drift
// even if the counter approach had been interrupted at some point. KV list is
// paged and slightly expensive, so a short per-isolate cache (30s) keeps
// homepage bursts from re-counting on every hit; the number is therefore
// live within ~30 seconds, which is well inside KV's eventual consistency.
let statsCache: { at: number; users: number } | null = null;

// Tests run several requests against one module instance, which outlives the
// per-test KV mock; the 30s cache would otherwise leak counts between tests.
export function __resetStatsCacheForTests(): void {
  statsCache = null;
}

async function countKvKeys(env: Env, prefix: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await env.SITE_STORAGE.list({ prefix, cursor, limit: 1000 });
    count += page.keys.length;
    // Real KVNamespace reports list_complete; the test mock just omits the
    // cursor when a page is the last one. Both signals end the loop.
    const next = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
    if (!next) break;
    cursor = next;
  }
  return count;
}

async function handleRegister(env: Env, body: Record<string, unknown>): Promise<Response> {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const subdomain = typeof body.subdomain === "string" ? body.subdomain.trim() : "";
  const domain = normalizeDomain(typeof body.domain === "string" ? body.domain : undefined);

  if (!username || username.length < 3 || username.length > 32 || !/^[a-z0-9_]+$/.test(username)) {
    return jsonResponse({ success: false, error: "Username must be 3-32 characters, lowercase letters, numbers, and underscores only" }, 400);
  }
  if (!password || password.length < 6) {
    return jsonResponse({ success: false, error: "Password must be at least 6 characters" }, 400);
  }

  const existing = await getUser(env, username);
  if (existing) {
    return jsonResponse({ success: false, error: "Username already taken" }, 409);
  }

  let finalSubdomain = sanitizeSubdomain(subdomain || username);
  if (!isValidSubdomain(finalSubdomain)) {
    finalSubdomain = username;
  }
  if (isReservedSubdomain(finalSubdomain)) {
    return jsonResponse({ success: false, error: "This subdomain is reserved" }, 400);
  }
  if (await subdomainExists(env, finalSubdomain, domain)) {
    return jsonResponse({ success: false, error: "Subdomain already taken on " + domain }, 409);
  }

  const { hash, salt } = await hashPassword(password);
  const user: User = {
    id: generateId(),
    username,
    passwordHash: hash,
    salt,
    subdomain: finalSubdomain,
    domain,
    createdAt: Date.now(),
  };

  await createUser(env, user);

  // KV is eventually consistent: re-read the claim to narrow the race where
  // two concurrent registrations took the same subdomain. If we lost, undo.
  const claimOwner = await getSubdomainOwner(env, finalSubdomain, domain);
  if (claimOwner && claimOwner !== user.id) {
    await env.SITE_STORAGE.delete(`user:${user.username}`);
    await env.SITE_STORAGE.delete(`user:id:${user.id}`);
    await releaseSubdomain(env, finalSubdomain, user.id);
    return jsonResponse({ success: false, error: "Subdomain already taken on " + domain }, 409);
  }

  const newKey = generateApiKey();
  const apiKeyRecord: ApiKey = {
    id: generateId(),
    userId: user.id,
    name: "Default Key",
    key: newKey,
    createdAt: Date.now(),
  };
  await createApiKey(env, apiKeyRecord);

  return jsonResponse({ success: true, data: { username: user.username, subdomain: user.subdomain, domain, apiKey: newKey } }, 201);
}

async function handleLogin(env: Env, body: Record<string, unknown>): Promise<Response> {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    return jsonResponse({ success: false, error: "Username and password are required" }, 400);
  }

  const user = await getUser(env, username);
  if (!user) {
    return jsonResponse({ success: false, error: "Invalid credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.salt, user.passwordHash);
  if (!valid) {
    return jsonResponse({ success: false, error: "Invalid credentials" }, 401);
  }

  let apiKey = (await getApiKeys(env, user.id)).find(k => k.name === "Default Key");
  if (!apiKey) {
    const allKeys = await getApiKeys(env, user.id);
    if (allKeys.length > 0) {
      apiKey = allKeys[0];
    }
  }
  if (!apiKey) {
    const newKey = generateApiKey();
    const apiKeyRecord: ApiKey = {
      id: generateId(),
      userId: user.id,
      name: "Default Key",
      key: newKey,
      createdAt: Date.now(),
    };
    await createApiKey(env, apiKeyRecord);
    apiKey = apiKeyRecord;
  }

  return jsonResponse({ success: true, data: { username: user.username, subdomain: user.subdomain, domain: normalizeDomain(user.domain), apiKey: apiKey.key } }, 200);
}

async function handleListApiKeys(env: Env, userId: string): Promise<Response> {
  const keys = await getApiKeys(env, userId);
  const plain = keys.map((k) => ({
    id: k.id,
    name: k.name,
    key: k.key,
    createdAt: k.createdAt,
    lastUsed: k.lastUsed,
  }));
  return jsonResponse({ success: true, data: plain });
}

async function handleCreateApiKey(env: Env, userId: string, body: Record<string, unknown>): Promise<Response> {
  const existing = await getApiKeys(env, userId);
  for (const k of existing) {
    await deleteApiKey(env, k);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "Default Key";
  const key = generateApiKey();
  const apiKey: ApiKey = {
    id: generateId(),
    userId,
    name: name || "Default Key",
    key,
    createdAt: Date.now(),
  };
  await createApiKey(env, apiKey);
  return jsonResponse({ success: true, data: { id: apiKey.id, name: apiKey.name, key, createdAt: apiKey.createdAt } }, 201);
}

async function handleDeleteApiKey(_env: Env, _userId: string, _keyId: string): Promise<Response> {
  return jsonResponse({ success: false, error: "Only one API key is allowed. Use refresh to regenerate it instead of deleting." }, 400);
}

async function handleListDeployments(env: Env, userId: string, url: URL): Promise<Response> {
  const deployments = await getDeployments(env, userId);
  const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = isNaN(limitParam) || limitParam < 1 ? 50 : Math.min(limitParam, 100);
  return jsonResponse({ success: true, data: deployments.slice(0, limit), total: deployments.length });
}

/**
 * NEW-SITE SKILL GATE. A brand-new site (zero deployments) must read the
 * 27c.site design skill before its first deploy. This is the single
 * enforcement point — the MCP deploy tool routes through this same REST
 * handler, so the gate cannot be bypassed by falling back to plain HTTP.
 * Existing sites (>= 1 deployment) are never gated.
 */
async function enforceSkillGate(env: Env, userId: string): Promise<Response | null> {
  const deployments = await getDeployments(env, userId);
  if (deployments.length > 0) return null;
  const read = await env.SITE_STORAGE.get(`skillread:${userId}`, "text");
  if (read === "1") return null;
  return jsonResponse({
    success: false,
    error:
      "BLOCKED — brand-new site, design skill not read. " +
      "Call the MCP tool 'get_skill', or GET /api/skill with your API key, read the full 27c.site design skill, then retry this deploy. " +
      "Do not deploy your own default aesthetic (the skill bans AI-purple gradients, three equal feature cards, Inter, pure #000000, eyebrows above every section).",
  }, 403);
}

async function handleDeploy(env: Env, userId: string, body: Record<string, unknown>): Promise<Response> {
  const files = body.files;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
  if (!Array.isArray(files) || files.length === 0) {
    return jsonResponse({ success: false, error: "No files provided" }, 400);
  }
  if (files.length > MAX_DEPLOY_FILES) {
    return jsonResponse({ success: false, error: `Too many files in one deploy (max ${MAX_DEPLOY_FILES}). Split into multiple deploys or use POST /api/upload.` }, 413);
  }

  const MAX_BASE64_SIZE = 120 * 1024; // ~120KB raw, ~160KB base64 - safe limit for Workers
  const invalidPaths: string[] = [];
  const tooLarge: string[] = [];
  const fileMap = new Map<string, { path: string; content: ArrayBuffer; contentType: string }>();

  for (const file of files as Array<{ path: string; content?: string; base64?: string; contentType?: string }>) {
    if (!file.path || typeof file.path !== "string") {
      invalidPaths.push("(unnamed)");
      continue;
    }
    if (!isValidPath(file.path) || file.path.startsWith("/") || file.path.includes("//")) {
      invalidPaths.push(file.path);
      continue;
    }

    let content: ArrayBuffer;
    if (typeof file.base64 === "string") {
      if (file.base64.length > MAX_BASE64_SIZE * 1.4) {
        tooLarge.push(file.path);
        continue;
      }
      try {
        const binaryString = atob(file.base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        content = bytes.buffer.slice(0) as ArrayBuffer;
      } catch {
        invalidPaths.push(`${file.path} (invalid base64)`);
        continue;
      }
    } else if (typeof file.content === "string") {
      content = new TextEncoder().encode(file.content).buffer.slice(0) as ArrayBuffer;
    } else {
      invalidPaths.push(`${file.path} (no content)`);
      continue;
    }

    // Last one wins for duplicate paths
    fileMap.set(file.path, {
      path: file.path,
      content,
      contentType: file.contentType || getContentType(file.path),
    });
  }

  if (invalidPaths.length > 0) {
    return jsonResponse({ success: false, error: `Invalid file paths: ${invalidPaths.join(", ")}` }, 400);
  }
  if (tooLarge.length > 0) {
    return jsonResponse({
      success: false,
      error: `Files too large for base64 deploy (max ~120KB each). Use POST /api/upload for: ${tooLarge.join(", ")}`,
    }, 413);
  }
  if (fileMap.size === 0) {
    return jsonResponse({ success: false, error: "No valid files to deploy" }, 400);
  }

  const validFiles = Array.from(fileMap.values());

  // Write new/updated files only — do NOT delete existing files.
  // This preserves files uploaded via /api/upload across deploys.
  for (const file of validFiles) {
    await putSiteFile(env, userId, file.path, file.content, file.contentType);
  }

  // Build a complete rollback snapshot. Every file carries its bytes so a
  // later update cannot make an older deployment unrecoverable.
  const existingFiles = await listSiteFiles(env, userId);
  const deployedPaths = new Set(validFiles.map((f) => f.path));
  const snapshotItems: SnapshotItemToStore[] = [];
  for (const f of validFiles) {
    snapshotItems.push({ path: f.path, contentType: f.contentType, size: f.content.byteLength, content: f.content });
  }
  for (const file of existingFiles) {
    if (!deployedPaths.has(file.path)) {
      snapshotItems.push({ path: file.path, contentType: file.contentType, size: file.size, content: file.content });
    }
  }

  const deployment: Deployment = {
    id: generateDeploymentId(),
    userId,
    files: snapshotItems.map((f) => ({ path: f.path, size: f.size })),
    deployedAt: Date.now(),
    note,
  };
  await createDeployment(env, deployment);
  await createDeploymentSnapshot(env, userId, deployment.id, snapshotItems);
  await pruneOldDeployments(env, userId, 50);

  return jsonResponse({
    success: true,
    data: {
      deploymentId: deployment.id,
      filesDeployed: validFiles.length,
      filesTotal: snapshotItems.length,
      files: validFiles.map((f) => ({ path: f.path, size: f.content.byteLength })),
      deployedAt: deployment.deployedAt,
      note,
    },
  });
}

async function handleRollback(env: Env, userId: string, deploymentId: string): Promise<Response> {
  const deployments = await getDeployments(env, userId);
  const deployment = deployments.find((d) => d.id === deploymentId);
  if (!deployment) {
    return jsonResponse({ success: false, error: "Deployment not found." }, 404);
  }

  const snapshot = await getDeploymentSnapshot(env, userId, deploymentId);
  if (!snapshot) {
    return jsonResponse({
      success: false,
      error: "This deployment predates rollback snapshots and cannot be restored. Only deployments after the snapshot feature was enabled support rollback.",
    }, 409);
  }

  const snapshotPaths = new Set(snapshot.map((f) => f.path));
  const restorable = snapshot.filter((f) => !f.truncated && f.content && f.content.byteLength > 0);
  const skipped = snapshot.filter((f) => f.truncated || !f.content || f.content.byteLength === 0);

  // Delete files currently on disk that are NOT part of this snapshot's file
  // set, so rollback returns the site to exactly this deploy's files.
  const existingFiles = await listSiteFilesMeta(env, userId);
  const pathsToDelete = existingFiles.filter((f) => !snapshotPaths.has(f.path)).map((f) => f.path);
  if (pathsToDelete.length > 0) {
    await deleteSiteFiles(env, userId, pathsToDelete);
  }

  // Re-write the files we have full content for. Carried-over files (metadata
  // only in the snapshot) are left untouched — their bytes still live in R2.
  for (const file of restorable) {
    await putSiteFile(env, userId, file.path, file.content!, file.contentType);
  }

  return jsonResponse({
    success: true,
    data: {
      deploymentId,
      filesDeployed: restorable.length,
      filesSkipped: skipped.map((f) => ({ path: f.path, size: f.size, reason: "file too large for snapshot, re-upload required" })),
      files: restorable.map((f) => ({ path: f.path, size: f.size })),
      deployedAt: deployment.deployedAt,
    },
  });
}

async function handleGetMe(env: Env, userId: string): Promise<Response> {
  const user = await getUserById(env, userId);
  if (!user) {
    return jsonResponse({ success: false, error: "User not found" }, 404);
  }
  return jsonResponse({ success: true, data: { username: user.username, subdomain: user.subdomain, domain: normalizeDomain(user.domain) } }, 200);
}

async function handleChangeSubdomain(env: Env, userId: string, body: Record<string, unknown>): Promise<Response> {
  const newSubdomain = typeof body.subdomain === "string" ? body.subdomain.trim() : "";
  const user = await getUserById(env, userId);
  if (!user) {
    return jsonResponse({ success: false, error: "User not found" }, 404);
  }

  const finalSubdomain = sanitizeSubdomain(newSubdomain || user.username);
  if (!isValidSubdomain(finalSubdomain)) {
    return jsonResponse({ success: false, error: "Invalid subdomain. Use 1-63 lowercase letters, numbers, and hyphens." }, 400);
  }
  if (isReservedSubdomain(finalSubdomain)) {
    return jsonResponse({ success: false, error: "This subdomain is reserved." }, 400);
  }
  if (finalSubdomain === user.subdomain) {
    return jsonResponse({ success: false, error: "This is already your current subdomain." }, 400);
  }
  const domain = normalizeDomain(user.domain);
  if (await subdomainExists(env, finalSubdomain, domain)) {
    return jsonResponse({ success: false, error: "Subdomain already taken on " + domain + "." }, 409);
  }

  if (user.subdomain) {
    await releaseSubdomain(env, user.subdomain, user.id);
  }
  user.subdomain = finalSubdomain;
  await updateUser(env, user);

  // Re-read the claim to narrow the KV race (see handleRegister).
  const claimOwner = await getSubdomainOwner(env, finalSubdomain, domain);
  if (claimOwner && claimOwner !== user.id) {
    user.subdomain = "";
    await updateUser(env, user);
    await releaseSubdomain(env, finalSubdomain, user.id);
    return jsonResponse({ success: false, error: "Subdomain already taken on " + domain + "." }, 409);
  }

  return jsonResponse({ success: true, data: { subdomain: user.subdomain } }, 200);
}

/**
 * Move the site to the other platform domain. The chosen domain is EXCLUSIVE:
 * after this, the previous <subdomain>.<domain> no longer resolves.
 */
async function handleChangeDomain(env: Env, userId: string, body: Record<string, unknown>): Promise<Response> {
  const user = await getUserById(env, userId);
  if (!user) {
    return jsonResponse({ success: false, error: "User not found" }, 404);
  }
  const currentDomain = normalizeDomain(user.domain);
  if (currentDomain !== "27c.site" && currentDomain !== "27ai.cloud") {
    return jsonResponse({ success: false, error: "This platform domain is standalone and cannot be switched." }, 400);
  }
  const requested = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
  if (requested !== "27c.site" && requested !== "27ai.cloud") {
    return jsonResponse({ success: false, error: "Invalid domain. Use 27c.site or 27ai.cloud." }, 400);
  }
  if (requested === currentDomain) {
    return jsonResponse({ success: false, error: "This is already your current domain." }, 400);
  }
  const target = requested as PlatformDomain;

  // Subdomain claims are namespaced per domain, so the same name may be free on
  // the other platform domain — or it may belong to someone else there.
  if (await subdomainExists(env, user.subdomain, target)) {
    return jsonResponse({ success: false, error: "This subdomain is already taken on " + target + "." }, 409);
  }

  await releaseSubdomain(env, user.subdomain, user.id);
  user.domain = target;
  await updateUser(env, user);

  // Re-read the claim to narrow the KV race (see handleRegister).
  const claimOwner = await getSubdomainOwner(env, user.subdomain, target);
  if (claimOwner && claimOwner !== user.id) {
    user.domain = currentDomain;
    await updateUser(env, user);
    return jsonResponse({ success: false, error: "This subdomain is already taken on " + target + "." }, 409);
  }

  return jsonResponse({ success: true, data: { domain: target, subdomain: user.subdomain } }, 200);
}

/** Change the account password. Requires the current one — there is no email,
 *  so a reset-without-password flow cannot be made secure on this platform. */
async function handleChangePassword(env: Env, userId: string, body: Record<string, unknown>): Promise<Response> {
  const user = await getUserById(env, userId);
  if (!user) {
    return jsonResponse({ success: false, error: "User not found" }, 404);
  }
  const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
  const newPassword = typeof body.new_password === "string" ? body.new_password : "";
  if (!currentPassword) {
    return jsonResponse({ success: false, error: "Current password is required" }, 400);
  }
  if (!newPassword || newPassword.length < 6) {
    return jsonResponse({ success: false, error: "New password must be at least 6 characters" }, 400);
  }
  const valid = await verifyPassword(currentPassword, user.salt, user.passwordHash);
  if (!valid) {
    return jsonResponse({ success: false, error: "Current password is incorrect" }, 403);
  }
  const { hash, salt } = await hashPassword(newPassword);
  user.passwordHash = hash;
  user.salt = salt;
  await updateUser(env, user);
  return jsonResponse({ success: true, data: { username: user.username } }, 200);
}

async function handleUpload(env: Env, userId: string, request: Request): Promise<Response> {
  try {
    if (!contentLengthWithin(request, MAX_UPLOAD_TOTAL_BYTES)) {
      return jsonResponse({ success: false, error: `Upload too large (max ${MAX_UPLOAD_TOTAL_BYTES / 1024 / 1024}MB per request)` }, 413);
    }
    const form = await request.formData();
    const files: { path: string; contentType: string; content: ArrayBuffer }[] = [];
    let totalBytes = 0;
    for (const [, value] of form.entries()) {
      if (!(value instanceof File)) continue;
      const path = value.name.trim();
      if (!path || !isValidPath(path) || path.startsWith("/") || path.includes("//")) continue;
      if (files.length >= MAX_UPLOAD_FILES) {
        return jsonResponse({ success: false, error: `Too many files in one upload (max ${MAX_UPLOAD_FILES})` }, 413);
      }
      if (value.size > MAX_UPLOAD_FILE_BYTES) {
        return jsonResponse({ success: false, error: `File too large: ${path} (max ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024}MB per file)` }, 413);
      }
      totalBytes += value.size;
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
        return jsonResponse({ success: false, error: `Upload too large (max ${MAX_UPLOAD_TOTAL_BYTES / 1024 / 1024}MB per request)` }, 413);
      }
      const contentType = value.type || getContentType(path);
      const buffer = await value.arrayBuffer();
      files.push({ path, contentType, content: buffer });
    }
    if (files.length === 0) return jsonResponse({ success: false, error: "No files uploaded" }, 400);
    for (const file of files) {
      await putSiteFile(env, userId, file.path, file.content, file.contentType);
    }
    // Uploads are deploy events too. Without a snapshot here, a later
    // rollback would delete files uploaded after the previous deployment.
    const uploadedPaths = new Set(files.map((f) => f.path));
    const snapshotItems: SnapshotItemToStore[] = files.map((f) => ({
      path: f.path,
      contentType: f.contentType,
      size: f.content.byteLength,
      content: f.content,
    }));
    const existingFiles = await listSiteFiles(env, userId);
    for (const file of existingFiles) {
      if (!uploadedPaths.has(file.path)) {
        snapshotItems.push({ path: file.path, contentType: file.contentType, size: file.size, content: file.content });
      }
    }
    const deployment: Deployment = {
      id: generateDeploymentId(),
      userId,
      files: snapshotItems.map((f) => ({ path: f.path, size: f.size })),
      deployedAt: Date.now(),
      note: "File upload",
    };
    await createDeployment(env, deployment);
    await createDeploymentSnapshot(env, userId, deployment.id, snapshotItems);
    await pruneOldDeployments(env, userId, 50);
    return jsonResponse({ success: true, data: {
      deploymentId: deployment.id,
      files: files.map((f) => ({ path: f.path, size: f.content.byteLength, contentType: f.contentType })),
    } });
  } catch {
    return jsonResponse({ success: false, error: "Upload failed" }, 400);
  }
}

async function handleDeleteAccount(env: Env, userId: string, username: string, body: Record<string, unknown>): Promise<Response> {
  // Two-step confirmation: the client (usually an AI agent) must explicitly
  // send confirm:true after asking the user. A bare DELETE never deletes.
  if (body.confirm !== true) {
    return jsonResponse({
      success: false,
      error: "Confirmation required. This permanently deletes the account, the site, and all deployment history. Ask the user to confirm explicitly, then call again with { \"confirm\": true }.",
    }, 400);
  }

  // Remove the external table and its token/indexes before deleting the
  // account. Database teardown is best-effort; deleteUserData still removes
  // all local metadata even if Neon is temporarily unavailable.
  await deleteDatabase(env, userId);
  await deleteUserData(env, userId, username);
  return jsonResponse({ success: true, data: { deleted: true, username } });
}


/**
 * Authenticated: assign the account its ONE database table (idempotent).
 * The agent calls this when the user's described features need data storage;
 * it never needs database jargon — just the columns the features imply.
 */
async function handleDbSetup(env: Env, user: User, body: Record<string, unknown>): Promise<Response> {
  const desired = typeof body.name === "string" ? body.name.trim() : undefined;
  try {
    const config = await provisionDatabase(env, user.id, user.subdomain, desired, body.columns);
    return jsonResponse({
      success: true,
      data: {
        table: config.table,
        token: config.token,
        columns: config.columns,
        endpoint: "POST /api/db",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "NAME_EXHAUSTED") {
      return jsonResponse({ success: false, error: "Could not find a free table name." }, 500);
    }
    if (msg === "DB_NOT_CONFIGURED") {
      return jsonResponse({ success: false, error: "Database is not configured on the server yet." }, 503);
    }
    return jsonResponse({ success: false, error: "Database setup failed." }, 500);
  }
}

/**
 * PUBLIC data API for deployed sites. The site's pages call this from the
 * visitor's browser with the site's public token. The token maps to exactly
 * one table on one member of the shared-database pool, and the SQL is built
 * from THAT record — the table name never comes from the request, so no
 * caller can reach another site's data. The pool credentials live only in the
 * NEON_DATABASE_URL* secrets.
 */
async function handleDbPublic(env: Env, request: Request): Promise<Response> {
  const body = await parseJsonBody(request, 1024 * 1024);
  if (!body || typeof body !== "object") {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }
  const { token, action } = body as Record<string, unknown>;
  if (typeof token !== "string" || !token) {
    return jsonResponse({ success: false, error: "Missing 'token'." }, 401);
  }
  const record = await getDatabaseByToken(env, token);
  if (!record) {
    return jsonResponse({ success: false, error: "Unknown token." }, 403);
  }
  const rl = await checkRateLimit(env.SITE_STORAGE, "db", token, RATE_LIMITS.db.limit, RATE_LIMITS.db.windowMs);
  if (!rl.allowed) {
    return jsonResponse({ success: false, error: "Rate limit exceeded. Try again later." }, 429, retryAfterHeaders(rl.resetAt));
  }
  // Re-read the live config so column merges take effect immediately, and to
  // make sure the token's table still matches what the account owns.
  const config = await getDatabaseConfig(env, record.userId);
  if (!config || config.table !== record.table) {
    return jsonResponse({ success: false, error: "Unknown token." }, 403);
  }
  try {
    const op: DbOp = {
      action: action as DbOp["action"],
      id: (body as Record<string, unknown>).id,
      data: (body as Record<string, unknown>).data as Record<string, unknown> | undefined,
      where: (body as Record<string, unknown>).where as Record<string, unknown> | undefined,
      limit: (body as Record<string, unknown>).limit as number | undefined,
    };
    const result = await runDbOp(env, config, op);
    return jsonResponse({ success: true, data: result });
  } catch (err) {
    const { status, error } = dbErrorMessage(err);
    return jsonResponse({ success: false, error }, status);
  }
}


export async function handleApiRequest(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization");

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const path = url.pathname;
  if (path === "/api/health" && request.method === "GET") {
    return jsonResponse({ success: true, data: { status: "ok", time: new Date().toISOString() } });
  }
  // Public live platform stats for the homepage counter — no auth, same
  // bracket as /api/health. See the statsCache note above for why it is real.
  if (path === "/api/stats" && request.method === "GET") {
    const now = Date.now();
    if (!statsCache || now - statsCache.at > 30_000) {
      const users = await countKvKeys(env, "user:id:");
      statsCache = { at: now, users };
    }
    return jsonResponse({ success: true, data: { users: statsCache.users } }, 200, {
      "Cache-Control": "public, max-age=30",
    });
  }
  // Public data API for deployed sites — MUST stay before the Bearer-auth
  // check below: visitors' browsers have no API key by design.
  if (path === "/api/db" && request.method === "POST") {
    return handleDbPublic(env, request);
  }
  if (path === "/api/register" && request.method === "POST") {
    const rl = await checkRateLimit(env.SITE_STORAGE, "register", getClientIp(request), RATE_LIMITS.register.limit, RATE_LIMITS.register.windowMs);
    if (!rl.allowed) {
      return jsonResponse({ success: false, error: "Too many registrations from this IP. Try again later." }, 429, retryAfterHeaders(rl.resetAt));
    }
    if (!contentLengthWithin(request, MAX_DEPLOY_BODY_BYTES)) {
      return jsonResponse({ success: false, error: "Request body too large" }, 413);
    }
    const body = await parseJsonBody(request, MAX_DEPLOY_BODY_BYTES);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    return handleRegister(env, body as Record<string, unknown>);
  }
  if (path === "/api/login" && request.method === "POST") {
    const rl = await checkRateLimit(env.SITE_STORAGE, "login", getClientIp(request), RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMs);
    if (!rl.allowed) {
      return jsonResponse({ success: false, error: "Too many login attempts from this IP. Try again later." }, 429, retryAfterHeaders(rl.resetAt));
    }
    if (!contentLengthWithin(request, MAX_DEPLOY_BODY_BYTES)) {
      return jsonResponse({ success: false, error: "Request body too large" }, 413);
    }
    const body = await parseJsonBody(request, MAX_DEPLOY_BODY_BYTES);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    return handleLogin(env, body as Record<string, unknown>);
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ success: false, error: "Missing or invalid Authorization header" }, 401);
  }

  const apiKey = authHeader.slice(7);
  const keyData = await env.SITE_STORAGE.get(`apikey:global:${apiKey}`, "json") as ApiKey | null;
  if (!keyData) {
    return jsonResponse({ success: false, error: "Invalid API key" }, 401);
  }

  const user = await getUserById(env, keyData.userId);
  if (!user) {
    return jsonResponse({ success: false, error: "User not found" }, 404);
  }

  // Track key usage, throttled to 1 write/hour to avoid a KV put on every request.
  if (!keyData.lastUsed || Date.now() - keyData.lastUsed > 3600_000) {
    keyData.lastUsed = Date.now();
    await env.SITE_STORAGE.put(`apikey:global:${apiKey}`, JSON.stringify(keyData));
    await env.SITE_STORAGE.put(`apikey:${keyData.userId}:${keyData.id}`, JSON.stringify(keyData));
  }

  if (path === "/api/me" && request.method === "GET") {
    return handleGetMe(env, user.id);
  }
  if (path === "/api/skill" && request.method === "GET") {
    // Returns the design skill AND unlocks the brand-new-site deploy gate for
    // this account (see enforceSkillGate).
    await env.SITE_STORAGE.put(`skillread:${user.id}`, "1");
    return new Response(getTasteSkillMarkdown(), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (path === "/api/subdomain" && request.method === "POST") {
    const body = await parseJsonBody(request, 1024 * 1024);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    return handleChangeSubdomain(env, user.id, body as Record<string, unknown>);
  }
  if (path === "/api/domain" && request.method === "POST") {
    const body = await parseJsonBody(request, 1024 * 1024);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    return handleChangeDomain(env, user.id, body as Record<string, unknown>);
  }
  if (path === "/api/password" && request.method === "POST") {
    const rl = await checkRateLimit(env.SITE_STORAGE, "login", getClientIp(request), RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMs);
    if (!rl.allowed) {
      return jsonResponse({ success: false, error: "Too many attempts. Try again later." }, 429, retryAfterHeaders(rl.resetAt));
    }
    const body = await parseJsonBody(request, 1024 * 1024);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    return handleChangePassword(env, user.id, body as Record<string, unknown>);
  }
  if (path === "/api/apikeys" && request.method === "GET") {
    return handleListApiKeys(env, user.id);
  }
  if (path === "/api/apikeys" && request.method === "POST") {
    const body = await parseJsonBody(request, MAX_DEPLOY_BODY_BYTES);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    return handleCreateApiKey(env, user.id, body as Record<string, unknown>);
  }
  if (path.startsWith("/api/apikeys/") && request.method === "DELETE") {
    const keyId = path.split("/")[3];
    if (!keyId) return jsonResponse({ success: false, error: "API key ID required" }, 400);
    return handleDeleteApiKey(env, user.id, keyId);
  }

  if (path === "/api/deployments" && request.method === "GET") {
    return handleListDeployments(env, user.id, url);
  }
  if (path === "/api/deploy" && request.method === "POST") {
    // Skill gate BEFORE rate limit and body parsing: a blocked brand-new site
    // should not consume deploy quota or upload a body at all.
    const gate = await enforceSkillGate(env, user.id);
    if (gate) return gate;
    const rl = await checkRateLimit(env.SITE_STORAGE, "deploy", user.id, RATE_LIMITS.deploy.limit, RATE_LIMITS.deploy.windowMs);
    if (!rl.allowed) {
      return jsonResponse({ success: false, error: "Deploy rate limit exceeded. Try again later." }, 429, retryAfterHeaders(rl.resetAt));
    }
    if (!contentLengthWithin(request, MAX_DEPLOY_BODY_BYTES)) {
      return jsonResponse({ success: false, error: `Deploy body too large (max ${MAX_DEPLOY_BODY_BYTES / 1024 / 1024}MB). Use POST /api/upload for large files.` }, 413);
    }
    const body = await parseJsonBody(request, MAX_DEPLOY_BODY_BYTES);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    return handleDeploy(env, user.id, body as Record<string, unknown>);
  }
  if (path === "/api/upload" && request.method === "POST") {
    // Same brand-new-site skill gate as /api/deploy: without this, a brand-new
    // site could bypass the design skill entirely by pushing files straight to
    // user/ storage via /api/upload (files serve immediately, no deploy record).
    const gate = await enforceSkillGate(env, user.id);
    if (gate) return gate;
    const rl = await checkRateLimit(env.SITE_STORAGE, "upload", user.id, RATE_LIMITS.upload.limit, RATE_LIMITS.upload.windowMs);
    if (!rl.allowed) {
      return jsonResponse({ success: false, error: "Upload rate limit exceeded. Try again later." }, 429, retryAfterHeaders(rl.resetAt));
    }
    return handleUpload(env, user.id, request);
  }
  if (path.startsWith("/api/rollback/") && request.method === "POST") {
    const deploymentId = path.split("/")[3];
    if (!deploymentId) return jsonResponse({ success: false, error: "Deployment ID required" }, 400);
    return handleRollback(env, user.id, deploymentId);
  }
  if (path === "/api/account" && request.method === "DELETE") {
    if (!contentLengthWithin(request, 1024 * 1024)) {
      return jsonResponse({ success: false, error: "Request body too large" }, 413);
    }
    const body = await parseJsonBody(request, 1024 * 1024);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    return handleDeleteAccount(env, user.id, user.username, body as Record<string, unknown>);
  }

  // Legacy compatibility no-op. Ads were removed platform-wide (nothing is
  // injected into deployed sites any more), so this endpoint always reports
  // adFree: true and accepts writes without storing anything. Kept so older
  // agents and scripts keep working; the `adfree:<userId>` KV flag is dead.
  if (path === "/api/adfree" && request.method === "GET") {
    return jsonResponse({ success: true, data: { adFree: true } });
  }
  if (path === "/api/adfree" && request.method === "POST") {
    await parseJsonBody(request).catch(() => {});
    return jsonResponse({ success: true, data: { adFree: true } });
  }

  // Assign the account's single database table (idempotent, one table ever).
  if (path === "/api/db/setup" && request.method === "POST") {
    const body = await parseJsonBody(request);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    return handleDbSetup(env, user, body as Record<string, unknown>);
  }

  return jsonResponse({ success: false, error: "Not found" }, 404);
}
