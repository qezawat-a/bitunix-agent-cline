// check.js — preflight: syntax, env, and settings validation.
// Run: npm run check
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let failures = 0;

// 1. Syntax check every source file.
const files = [...walk('src'), ...walk('scripts')];
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failures++;
    console.error(`SYNTAX FAIL ${file}\n${(res.stderr || '').trim()}`);
  }
}
console.log(`syntax: ${files.length - failures}/${files.length} files OK`);

// 2. Validate trading settings.
try {
  const { CONFIG, readSettingsFile, applySettingsFile, validate } = await import('../src/config.js');
  const { getTraderSettings, validateSettings } = await import('../src/trader/settings.js');
  try { applySettingsFile(CONFIG, await readSettingsFile()); } catch {}
  const missing = validate();
  if (missing.length) console.log(`env: missing (optional) ${missing.join(', ')}`);
  else console.log('env: OK');
  const errors = validateSettings(getTraderSettings(CONFIG));
  if (errors.length) { failures++; console.error(`settings INVALID: ${errors.join('; ')}`); }
  else console.log('settings: OK');
} catch (error) {
  failures++;
  console.error(`settings check crashed: ${error.message}`);
}

// 3. Skills load.
try {
  const { listSkills } = await import('../src/agent/skills.js');
  const skills = listSkills('skills');
  console.log(`skills: ${skills.length} loaded (${skills.map(s => s.id).join(', ') || 'none'})`);
} catch (error) {
  failures++;
  console.error(`skills check crashed: ${error.message}`);
}

if (failures) { console.error(`\ncheck FAILED (${failures} problem(s))`); process.exitCode = 1; }
else console.log('\ncheck OK');
