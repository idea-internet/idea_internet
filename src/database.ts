// Free shared-database feature for deployed sites.
//
// 27c.site hosts STATIC sites, so a user site that needs to remember data
// (form submissions, comments, counters...) talks to a tiny JSON API on the
// platform instead of holding its own backend. The platform owns ONE shared
// Postgres (Neon) connection, stored as the NEON_DATABASE_URL Worker secret —
// it is NEVER embedded in user pages (it carries owner rights to the whole
// database; shipping it to every visitor would hand them the keys).
//
// Guarantees, enforced HERE rather than promised to the agent:
// - ONE table per account, forever. The table name is assigned at provision
//   time and recorded; subsequent setup calls return the same table (merging
//   any new columns) instead of creating another one.
// - No name collisions. Every table name is registered globally
//   (`dbname:<name>`); a taken name gets an automatic _2, _3... suffix.
// - The public data API never accepts a table name from the caller. The
//   caller presents a per-site token that maps to exactly one table, and the
//   SQL is built from THAT record — a visitor cannot reach another site's
//   table because the name never comes from the request.
// - Column names/values are validated against the provisioned column list,
//   and all values go in as parameters (no string-built SQL from user input).

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Env } from "./types";
import { generateApiKey } from "./auth";

const COLUMN_TYPES = ["text", "number", "boolean", "json", "time"] as const;
export type DbColumnType = (typeof COLUMN_TYPES)[number];

const PG_TYPES: Record<DbColumnType, string> = {
  text: "text",
  number: "double precision",
  boolean: "boolean",
  json: "jsonb",
  time: "timestamptz",
};

export interface DbColumn {
  name: string;
  type: DbColumnType;
}

export interface DatabaseConfig {
  table: string;
  token: string;
  columns: DbColumn[];
  /** Columns the schema was last ensured with — drives lazy DDL re-runs. */
  ddlSignature: string;
  /**
   * Which member of the shared-database pool this table lives on (0-based).
   * Assigned at random during provisioning and persisted forever — every later
   * query MUST go to the same member. Absent on sites provisioned before the
   * pool existed; those count as 0.
   */
  db?: number;
  createdAt: number;
}

// KV has no compare-and-swap primitive. This lock prevents duplicate
// provisioning requests within one Worker isolate; the final config re-read
// below also makes a losing request harmless when isolates race.
const provisioningLocks = new Map<string, Promise<DatabaseConfig>>();

// System columns every table gets; the public API never accepts them as input.
const SYSTEM_COLUMNS = ["id", "created_at"];

function isValidIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

function quoteIdent(name: string): string {
  if (!isValidIdentifier(name)) throw new Error(`BAD_IDENTIFIER:${name}`);
  return `"${name}"`;
}

function normalizeColumn(raw: unknown): DbColumn | null {
  if (!raw || typeof raw !== "object") return null;
  const name = String((raw as Record<string, unknown>).name || "").trim().toLowerCase();
  const type = String((raw as Record<string, unknown>).type || "text").trim().toLowerCase();
  if (!isValidIdentifier(name) || SYSTEM_COLUMNS.includes(name)) return null;
  if (!(COLUMN_TYPES as readonly string[]).includes(type)) return null;
  return { name, type: type as DbColumnType };
}

function sanitizeTableNamePart(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
}

function signatureOf(columns: DbColumn[]): string {
  return columns.map((c) => `${c.name}:${c.type}`).join(",");
}

// ---------------------------------------------------------------------------
// Provisioning (authenticated side)
// ---------------------------------------------------------------------------

/**
 * Assign this account its single database table. Idempotent: calling again
 * returns the SAME table + token (never a second table) and merges any new
 * columns into the schema. Name collisions get an automatic numeric suffix —
 * the caller never has to fight over names.
 */
async function provisionDatabaseUnlocked(
  env: Env,
  userId: string,
  subdomain: string,
  desiredName?: string,
  rawColumns?: unknown
): Promise<DatabaseConfig> {
  const columns: DbColumn[] = [];
  if (Array.isArray(rawColumns)) {
    for (const raw of rawColumns) {
      const col = normalizeColumn(raw);
      if (col && !columns.some((c) => c.name === col.name)) columns.push(col);
    }
  }

  const existing = await getDatabaseConfig(env, userId);
  if (existing) {
    // Idempotent: same table forever, new columns merged into the schema.
    let changed = false;
    for (const col of columns) {
      if (!existing.columns.some((c) => c.name === col.name)) {
        existing.columns.push(col);
        changed = true;
      }
    }
    if (changed) {
      existing.ddlSignature = signatureOf(existing.columns);
      await env.SITE_STORAGE.put(`dbtable:${userId}`, JSON.stringify(existing));
    }
    return existing;
  }

  const base = `site_${sanitizeTableNamePart(desiredName || sanitizeTableNamePart(subdomain) || "data") || "data"}`;
  let table = base;
  let n = 2;
  while (await env.SITE_STORAGE.get(`dbname:${table}`, "text")) {
    table = `${base}_${n++}`;
    if (n > 100) throw new Error("NAME_EXHAUSTED");
  }
  await env.SITE_STORAGE.put(`dbname:${table}`, userId);

  const config: DatabaseConfig = {
    table,
    token: "dbk_" + generateApiKey(),
    columns,
    ddlSignature: signatureOf(columns),
    db: randomPoolIndex(env),
    createdAt: Date.now(),
  };
  await env.SITE_STORAGE.put(`dbtable:${userId}`, JSON.stringify(config));
  await env.SITE_STORAGE.put(`dbtoken:${config.token}`, JSON.stringify({ userId, table }));
  return config;
}

export async function provisionDatabase(
  env: Env,
  userId: string,
  subdomain: string,
  desiredName?: string,
  rawColumns?: unknown
): Promise<DatabaseConfig> {
  const active = provisioningLocks.get(userId);
  if (active) return active;
  const promise = provisionDatabaseUnlocked(env, userId, subdomain, desiredName, rawColumns);
  provisioningLocks.set(userId, promise);
  try {
    return await promise;
  } finally {
    if (provisioningLocks.get(userId) === promise) provisioningLocks.delete(userId);
  }
}

export async function getDatabaseConfig(env: Env, userId: string): Promise<DatabaseConfig | null> {
  return (await env.SITE_STORAGE.get(`dbtable:${userId}`, "json")) as DatabaseConfig | null;
}

export async function getDatabaseByToken(env: Env, token: string): Promise<{ userId: string; table: string } | null> {
  if (!token || token.length > 128) return null;
  return (await env.SITE_STORAGE.get(`dbtoken:${token}`, "json")) as { userId: string; table: string } | null;
}

/** Delete a site's database table and all KV references. */
export async function deleteDatabase(env: Env, userId: string): Promise<void> {
  const config = await getDatabaseConfig(env, userId);
  if (!config) return;
  try {
    const sql = client(env, config);
    if (sql) await sql.query(`DROP TABLE IF EXISTS ${quoteIdent(config.table)}`, []);
  } catch {
    // Account deletion must continue even if the external database is down.
  }
  await env.SITE_STORAGE.delete(`dbtable:${userId}`);
  await env.SITE_STORAGE.delete(`dbtoken:${config.token}`);
  await env.SITE_STORAGE.delete(`dbname:${config.table}`);
  await env.SITE_STORAGE.delete(`dbddl:${config.db ?? 0}:${config.table}`);
}

// ---------------------------------------------------------------------------
// SQL execution (lazy schema, parameterized values)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared-database pool: several Neon Postgres databases, one assigned to each
// site at random. The assignment is persisted with the table, so the pool can
// grow or the URLs can rotate without moving existing data.
// ---------------------------------------------------------------------------

function dbPool(env: Env): string[] {
  return [
    (env as { NEON_DATABASE_URL?: string }).NEON_DATABASE_URL,
    (env as { NEON_DATABASE_URL_2?: string }).NEON_DATABASE_URL_2,
    (env as { NEON_DATABASE_URL_3?: string }).NEON_DATABASE_URL_3,
  ].filter((u): u is string => typeof u === "string" && u.length > 0);
}

/** Random member of the pool for a NEW table. Throws if the pool is empty. */
function randomPoolIndex(env: Env): number {
  const pool = dbPool(env);
  if (pool.length === 0) throw new Error("DB_NOT_CONFIGURED");
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % pool.length;
}

/** Resolve a table's persisted pool index to a URL. No silent remapping. */
function poolUrl(env: Env, config: DatabaseConfig): string | null {
  const idx = typeof config.db === "number" ? config.db : 0;
  return dbPool(env)[idx] || null;
}

function client(env: Env, config: DatabaseConfig): NeonQueryFunction<false, false> | null {
  const url = poolUrl(env, config);
  if (!url) return null;
  return neon(url) as NeonQueryFunction<false, false>;
}

async function sqlExec(env: Env, config: DatabaseConfig, query: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const sql = client(env, config);
  if (!sql) throw new Error("DB_NOT_CONFIGURED");
  return (await sql.query(query, params)) as Record<string, unknown>[];
}

/**
 * Create the table + any missing columns on first use — on the pool member the
 * site was assigned to. KV flags remember what was already applied (per table
 * AND pool member, since a name could theoretically exist on several members)
 * so normal requests skip the DDL round-trips; a changed column list (new
 * columns merged at provision time) re-runs it.
 */
async function ensureSchema(env: Env, config: DatabaseConfig): Promise<void> {
  const flagKey = `dbddl:${config.db ?? 0}:${config.table}`;
  const applied = (await env.SITE_STORAGE.get(flagKey, "text")) || "";
  if (applied === config.ddlSignature) return;

  await sqlExec(
    env,
    config,
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(config.table)} (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`,
    []
  );
  for (const col of config.columns) {
    await sqlExec(
      env,
      config,
      `ALTER TABLE ${quoteIdent(config.table)} ADD COLUMN IF NOT EXISTS ${quoteIdent(col.name)} ${PG_TYPES[col.type]}`,
      []
    );
  }
  await env.SITE_STORAGE.put(flagKey, config.ddlSignature);
}

export interface DbOp {
  action: "add" | "list" | "get" | "patch" | "remove";
  id?: unknown;
  data?: Record<string, unknown>;
  where?: Record<string, unknown>;
  limit?: number;
}

function validateValue(type: DbColumnType, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "text": {
      const s = String(value);
      if (s.length > 10_000) throw new Error("VALUE_TOO_LARGE");
      return s;
    }
    case "number": {
      const n = Number(value);
      if (!isFinite(n)) throw new Error("BAD_VALUE");
      return n;
    }
    case "boolean":
      return Boolean(value);
    case "json":
      return JSON.stringify(value);
    case "time": {
      const s = String(value);
      if (Number.isNaN(Date.parse(s))) throw new Error("BAD_VALUE");
      return s;
    }
  }
}

/** Run one validated, parameterized operation against the account's table. */
export async function runDbOp(env: Env, config: DatabaseConfig, op: DbOp): Promise<Record<string, unknown>> {
  await ensureSchema(env, config);
  const t = quoteIdent(config.table);
  const cols = new Map(config.columns.map((c) => [c.name, c]));

  const pickData = (): [string, unknown][] => {
    if (!op.data || typeof op.data !== "object") throw new Error("NO_DATA");
    const entries: [string, unknown][] = [];
    for (const [key, value] of Object.entries(op.data)) {
      const col = cols.get(key);
      if (!col) throw new Error(`UNKNOWN_COLUMN:${key}`);
      entries.push([key, validateValue(col.type, value)]);
    }
    if (entries.length === 0) throw new Error("NO_DATA");
    return entries;
  };

  const pickWhere = (): [string, unknown][] => {
    const out: [string, unknown][] = [];
    if (op.where && typeof op.where === "object") {
      for (const [key, value] of Object.entries(op.where)) {
        const col = cols.get(key);
        if (!col) throw new Error(`UNKNOWN_COLUMN:${key}`);
        out.push([key, validateValue(col.type, value)]);
      }
    }
    return out;
  };

  switch (op.action) {
    case "add": {
      const entries = pickData();
      const id = crypto.randomUUID();
      const names = ["id", ...entries.map(([k]) => k)];
      const params = [id, ...entries.map(([, v]) => v)];
      const placeholders = params.map((_, i) => `$${i + 1}`);
      await sqlExec(
        env,
        config,
        `INSERT INTO ${t} (${names.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id, created_at`,
        params
      );
      return { id };
    }
    case "list": {
      const where = pickWhere();
      const limit = Math.min(Math.max(Number(op.limit) || 50, 1), 200);
      const params: unknown[] = [];
      let sqlText = `SELECT * FROM ${t}`;
      if (where.length > 0) {
        params.push(...where.map(([, v]) => v));
        sqlText += ` WHERE ${where.map(([k], i) => `${quoteIdent(k)} = $${i + 1}`).join(" AND ")}`;
      }
      sqlText += ` ORDER BY created_at DESC LIMIT ${limit}`;
      const rows = await sqlExec(env, config, sqlText, params);
      return { rows };
    }
    case "get": {
      if (typeof op.id !== "string" || !op.id) throw new Error("NO_ID");
      const rows = await sqlExec(env, config, `SELECT * FROM ${t} WHERE id = $1`, [op.id]);
      return { row: rows[0] || null };
    }
    case "patch": {
      if (typeof op.id !== "string" || !op.id) throw new Error("NO_ID");
      const entries = pickData();
      const params = [...entries.map(([, v]) => v), op.id];
      const sets = entries.map(([k], i) => `${quoteIdent(k)} = $${i + 1}`).join(", ");
      const rows = await sqlExec(
        env,
        config,
        `UPDATE ${t} SET ${sets} WHERE id = $${params.length} RETURNING id`,
        params
      );
      return { updated: rows.length > 0 };
    }
    case "remove": {
      if (typeof op.id !== "string" || !op.id) throw new Error("NO_ID");
      const rows = await sqlExec(env, config, `DELETE FROM ${t} WHERE id = $1 RETURNING id`, [op.id]);
      return { removed: rows.length > 0 };
    }
    default:
      throw new Error("BAD_ACTION");
  }
}

export function dbErrorMessage(err: unknown): { status: number; error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "DB_NOT_CONFIGURED") return { status: 503, error: "Database is not configured on the server yet." };
  if (msg === "BAD_ACTION") return { status: 400, error: "Unknown action. Use add, list, get, patch, or remove." };
  if (msg === "NO_DATA") return { status: 400, error: "Missing or empty 'data' object." };
  if (msg === "NO_ID") return { status: 400, error: "Missing row 'id'." };
  if (msg === "BAD_VALUE" || msg === "VALUE_TOO_LARGE") return { status: 400, error: "Invalid value for a column." };
  if (msg.startsWith("UNKNOWN_COLUMN:")) return { status: 400, error: `Unknown column: ${msg.slice("UNKNOWN_COLUMN:".length)}. Only columns requested at setup are available.` };
  if (msg.startsWith("BAD_IDENTIFIER:")) return { status: 400, error: "Invalid column name." };
  return { status: 500, error: "Database operation failed." };
}
