import { loadStore, saveStore } from '../store/persist.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class Memory {
  store = {};

  constructor(initial = {}) {
    this.store = isPlainObject(initial) ? { ...initial } : {};
  }

  async remember(key, value) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('memory key must be non-empty');
    this.store[key] = value;
    await this.save();
    return value;
  }

  async recall(key) {
    return this.store[key] ?? null;
  }

  async save() {
    await saveStore({ agent_memory: { ...this.store } });
  }

  async load() {
    const stored = await loadStore();
    if (isPlainObject(stored.agent_memory)) this.store = { ...stored.agent_memory };
    return this.store;
  }

  all() {
    return { ...this.store };
  }
}
