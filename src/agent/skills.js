import fs from 'fs/promises';
import path from 'path';

export async function listSkills(skillDir = path.resolve('skills')) {
  try {
    const entries = await fs.readdir(skillDir);
    const files = entries.filter(e => e.endsWith('.md') || e === 'SKILL.md');
    const skills = [];
    for (const f of files) {
      const p = path.join(skillDir, f);
      const text = await fs.readFile(p, 'utf8');
      skills.push({ name: f.replace(/\.md$/, ''), path: p, content: text });
    }
    return skills;
  } catch { return []; }
}

export async function loadSkill(name, skillDir = path.resolve('skills')) {
  const skills = await listSkills(skillDir);
  return skills.find(s => s.name === name || s.name === `${name}.md`) ?? null;
}