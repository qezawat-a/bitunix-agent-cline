import { CONFIG } from '../config.js';

export function detectProviders() {
  const provider = String(CONFIG.AI_PROVIDER || 'auto').trim().toLowerCase();
  if (['anthropic', 'google', 'openai'].includes(provider)) return provider;
  if (provider !== 'auto') throw new Error(`unsupported AI_PROVIDER: ${provider}`);
  if (CONFIG.AI_API_KEY) return 'openai';
  if (CONFIG.ANTHROPIC_API_KEY) return 'anthropic';
  if (CONFIG.GEMINI_API_KEY) return 'google';
  return 'openai';
}

export async function listProviderModels(provider) {
  // basic model list lookup
  const lists = {
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-3.5-turbo'],
    anthropic: ['claude-3-5-sonnet-20240620', 'claude-3-haiku-20240307'],
    google: ['gemini-1.5-pro', 'gemini-1.5-flash'],
  };
  return lists[provider] || [];
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