export const toolTimeout = 20000;

export async function withTimeout(operation, ms = toolTimeout) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let promise;
  if (typeof operation === 'function') {
    promise = Promise.resolve().then(() => operation(controller?.signal));
  } else {
    promise = Promise.resolve(operation);
  }
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller?.abort();
      reject(new Error(`Tool timeout after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some(candidate => {
    if (candidate === 'null') return value === null;
    if (candidate === 'array') return Array.isArray(value);
    if (candidate === 'integer') return Number.isInteger(value);
    if (candidate === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return typeof value === candidate;
  });
}

export function validateToolArguments(schema, args) {
  if (schema?.type && !matchesType(args, schema.type)) throw new Error('tool arguments have an invalid type');
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  for (const key of schema.required || []) {
    if (!Object.hasOwn(args, key)) throw new Error(`missing required argument: ${key}`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!schema.properties?.[key]) throw new Error(`unknown argument: ${key}`);
    }
  }
  for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
    if (!Object.hasOwn(args, key) || args[key] === undefined) continue;
    const value = args[key];
    if (propertySchema.enum && !propertySchema.enum.includes(value)) throw new Error(`invalid value for ${key}`);
    if (propertySchema.type && !matchesType(value, propertySchema.type)) throw new Error(`invalid type for ${key}`);
    if (propertySchema.type === 'object' || (Array.isArray(propertySchema.type) && propertySchema.type.includes('object'))) {
      validateToolArguments(propertySchema, value);
    }
  }
}

export function stringifyToolResult(result) {
  let value = result === undefined ? { ok: true } : result;
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'function') return '[Function]';
      return item;
    }).slice(0, 4000);
  } catch {
    return JSON.stringify({ error: 'tool returned a non-serializable result' });
  }
}

export function registerTool(tool) {
  return tool;
}
