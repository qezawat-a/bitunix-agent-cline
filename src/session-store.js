import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
let writeQueue = Promise.resolve();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readAll() {
  let raw;
  try {
    raw = await fs.readFile(SESSION_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('session store must contain a JSON object');
  return parsed;
}

async function writeAllNow(all) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(DATA_DIR, 0o700);
  const temporary = `${SESSION_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
    await fs.rename(temporary, SESSION_FILE);
    await fs.chmod(SESSION_FILE, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function enqueue(operation) {
  const task = writeQueue.then(operation);
  writeQueue = task.catch(() => {});
  return task;
}

function writeAll(all) {
  return enqueue(() => writeAllNow(all));
}

function validateId(id) {
  const value = String(id ?? '').trim();
  if (!value || RESERVED_IDS.has(value)) throw new Error('invalid session id');
  return value;
}

export async function saveSession(id, session) {
  if (!isPlainObject(session)) throw new Error('session must be an object');
  const key = validateId(id);
  return enqueue(async () => {
    const all = await readAll();
    all[key] = { ...session, updatedAt: new Date().toISOString() };
    await writeAllNow(all);
    return all[key];
  });
}

export async function loadSession(id) {
  const key = validateId(id);
  const all = await readAll();
  return isPlainObject(all[key]) ? all[key] : null;
}

export async function listSessions() {
  const all = await readAll();
  return Object.entries(all)
    .filter(([, session]) => isPlainObject(session))
    .map(([id, session]) => ({ id, ...session }));
}

export async function deleteSession(id) {
  const key = validateId(id);
  return enqueue(async () => {
    const all = await readAll();
    if (!Object.hasOwn(all, key)) return false;
    delete all[key];
    await writeAllNow(all);
    return true;
  });
}
