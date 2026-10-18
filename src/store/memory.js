import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const STORE_DIR = path.resolve(process.env.DATA_DIR || 'data');
const STORE_FILE = path.join(STORE_DIR, 'trader-store.json');
let writeQueue = Promise.resolve();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function readLocal() {
  let raw;
  try {
    raw = await fs.readFile(STORE_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('trader store must contain a JSON object');
  return parsed;
}

async function writeLocalNow(data) {
  if (!isPlainObject(data)) throw new Error('trader store data must be an object');
  const current = await readLocal();
  const next = { ...current, ...data };
  await fs.mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(STORE_DIR, 0o700);
  const temporary = `${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temporary, STORE_FILE);
    await fs.chmod(STORE_FILE, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return next;
}

export function writeLocal(data) {
  const task = writeQueue.then(() => writeLocalNow(data));
  writeQueue = task.catch(() => {});
  return task;
}

export class StoreMemory {
  data = {};
  async load() { this.data = await readLocal(); return this.data; }
  async save() { return writeLocal(this.data); }
  get(k, fb = null) { return this.data[k] ?? fb; }
  set(k, v) { this.data[k] = v; return v; }
  all() { return this.data; }
}
