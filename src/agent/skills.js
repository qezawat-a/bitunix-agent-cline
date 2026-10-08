// skills.js — loads skills from the `skills/` directory.
//
// Two layouts are supported:
//   - a flat `*.md` file with YAML front-matter
//   - a folder containing SKILL.md (same front-matter format)
//
// Only name + description are injected into the system prompt (see prompt.js)
// to keep it small; the full body is loaded on demand.
//
// Ported from CRAG's skills loader: adds front-matter parsing, folder/SKILL.md
// support, and — importantly — skips README.md, which would otherwise be
// registered as a skill literally named "README".
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function parseFrontMatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, body: raw.trim() };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of raw.slice(3, end).trim().split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(end + 4).trim() };
}

// listSkills(dir, { exclude }) -> [{ id, name, description, body, content, path, file }]
export function listSkills(dir = 'skills', { exclude = [] } = {}) {
  const abs = path.resolve(dir);
  let entries = [];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return []; // no skills directory
  }

  const out = [];
  for (const entry of entries) {
    let file = null;
    const id = entry.name.replace(/\.md$/i, '');

    if (entry.isDirectory()) {
      const candidate = path.join(abs, entry.name, 'SKILL.md');
      if (!existsSync(candidate)) continue; // folder without SKILL.md is not a skill
      file = candidate;
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      if (/^readme(\.md)?$/i.test(entry.name)) continue; // README is docs, not a skill
      file = path.join(abs, entry.name);
    } else {
      continue;
    }

    let raw = '';
    try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontMatter(raw);
    const name = meta.name || id;
    if (exclude.includes(name) || exclude.includes(id)) continue;

    out.push({
      id,
      name,
      description: meta.description || '',
      body,
      content: body, // backwards-compatible alias for the previous loader
      path: file,
      file,
    });
  }
  return out;
}

export function loadSkill(name, dir = 'skills') {
  if (!name) return null;
  const wanted = String(name).replace(/\.md$/i, '');
  return listSkills(dir).find(s => s.id === wanted || s.name === wanted) ?? null;
}

export function skillCatalog(skills = []) {
  return skills
    .map(s => `- ${s.name}${s.description ? `: ${s.description}` : ''}`)
    .join('\n');
}

export default listSkills;