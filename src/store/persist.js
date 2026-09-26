import { Pool } from 'pg';
import { CONFIG } from '../config.js';
import { readLocal, writeLocal } from './memory.js';

let pool = null;
// True when the last loadStore() hit the database and failed. Boot must not
// write back after a failed read: doing so would overwrite good stored
// settings with the defaults merely because the DB was briefly unreachable.
let lastLoadFailed = false;
let lastError = null;

export function didLoadFail() {
  return lastLoadFailed;
}

function getPool() {
  if (!CONFIG.DATABASE_URL) return null;
  if (!pool) {
    // Do NOT force ssl options here. `pg` only applies its own SSL defaults when
    // the caller does not pass `ssl`, and the sslmode in the connection string
    // is parsed by pg's connection-string parser. Hardcoding
    // { rejectUnauthorized: true } overrode sslmode=require and made every
    // connection to a provider with its own CA (Neon, RDS, Supabase, ...) fail
    // with DEPTH_ZERO_SELF_SIGNED_CERT, so loadStore() silently fell back to
    // the local file and settings appeared to reset on every deploy.
    pool = new Pool({ connectionString: CONFIG.DATABASE_URL });
  }
  return pool;
}

export async function ensureSchema() {
  const p = getPool();
  if (!p) return false;
  const client = await p.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS trader_store (id TEXT NOT NULL, key TEXT NOT NULL, value JSONB, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (id, key))');
    await client.query('CREATE TABLE IF NOT EXISTS kv (store TEXT NOT NULL, key TEXT NOT NULL, value JSONB, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (store, key))');
    return true;
  } finally {
    client.release();
  }
}

export async function loadStore() {
  const p = getPool();
  if (!p) { lastLoadFailed = false; return readLocal(); }
  lastLoadFailed = false;
  try {
    await ensureSchema();
    const client = await p.connect();
    try {
      const res = await client.query('SELECT key, value FROM trader_store WHERE id = $1', [CONFIG.store_id]);
      const out = Object.create(null);
      for (const row of res.rows) out[row.key] = row.value;
      if (Object.keys(out).length === 0) return readLocal();
      return out;
    } finally {
      client.release();
    }
  } catch (error) {
    // Loud on purpose. Falling back to the local file without a clear warning is
    // what made this look like "settings reset on deploy": the file is wiped on
    // every release, so a silent fallback looks exactly like lost settings.
    console.error(`[persistence] DATABASE_URL is set but the store could not be read (${error.code || error.message}). Falling back to the local file — settings will NOT survive a redeploy until this is fixed.`);
    lastLoadFailed = true;
    lastError = error.code || error.message;
    return readLocal();
  }
}

/** Human-readable store status for /diag and boot logging. */
export function storeStatus() {
  return {
    backend: CONFIG.DATABASE_URL ? 'postgres' : 'file',
    lastLoadFailed,
    lastError,
  };
}

export async function saveStore(data) {
  const local = await writeLocal(data);
  const p = getPool();
  if (!p) return local;
  await ensureSchema();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    try {
      for (const [key, value] of Object.entries(data)) {
        await client.query(
          'INSERT INTO trader_store (id, key, value) VALUES ($1, $2, $3) ON CONFLICT (id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
          [CONFIG.store_id, key, JSON.stringify(value)]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
  return local;
}

export async function closePersist() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

export const FileBackend = { load: readLocal, save: writeLocal };
export const PostgresBackend = { load: loadStore, save: saveStore, ensureSchema, close: closePersist };
