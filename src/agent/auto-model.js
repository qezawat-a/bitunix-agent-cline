import { CONFIG } from '../config.js';

const cache = new Map();
let lastRefresh = 0;

export async function listProviderModels(provider) {
  const lists = {
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-3.5-turbo'],
    anthropic: ['claude-3-5-sonnet-20240620', 'claude-3-haiku-20240307'],
    google: ['gemini-1.5-pro', 'gemini-1.5-flash'],
  };
  if (cache.has(provider)) return cache.get(provider);
  const models = lists[provider] || [];
  cache.set(provider, models);
  return models;
}

export async function rankModels(provider, freePrefer = true) {
  const models = await listProviderModels(provider);
  if (!freePrefer) return [...models];
  const order = {
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4', 'gpt-3.5-turbo'],
    anthropic: ['claude-3-haiku-20240307', 'claude-3-5-sonnet-20240620'],
    google: ['gemini-1.5-flash', 'gemini-1.5-pro'],
  };
  return (order[provider] || []).filter(model => models.includes(model));
}

export function fallbackCandidates(provider) {
  const order = {
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4'],
    anthropic: ['claude-3-haiku-20240307', 'claude-3-5-sonnet-20240620'],
    google: ['gemini-1.5-flash', 'gemini-1.5-pro'],
  };
  return order[provider] || [];
}

export function isBalanceError(err) {
  const s = String(err?.message || err);
  return /402|quota|insufficient|balance|payment/i.test(s);
}

export function shouldAdvanceModel(err) {
  const s = String(err?.message || err);
  if (/429/.test(s)) return false;
  return /402|404|quota|not.?found|model/i.test(s);
}

export async function loadModelCache() {
  try {
    const fs = await import('fs/promises');
    const raw = await fs.readFile('data/model-cache.json', 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

export async function saveModelCache(data) {
  try {
    const fs = await import('fs/promises');
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile('data/model-cache.json', JSON.stringify(data, null, 2));
  } catch {}
}

export function needsRefresh() {
  if (!CONFIG.AI_AUTO_REFRESH) return false;
  return Date.now() - lastRefresh > (CONFIG.AI_MODEL_TTL || 600000);
}
