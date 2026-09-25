export const levels = {
  off: { budget: 0, label: 'off' },
  low: { budget: 1024, label: 'low' },
  mid: { budget: 4096, label: 'mid' },
  high: { budget: 8192, label: 'high' },
  max: { budget: 16384, label: 'max' },
};

export function getThinkingLevel(level) {
  return levels[level] || levels.mid;
}

export function parseThinkingLevel(raw) {
  const l = String(raw).toLowerCase().trim();
  if (l in levels) return l;
  const n = Number(l);
  if (!isNaN(n)) {
    if (n <= 1024) return 'low';
    if (n <= 4096) return 'mid';
    if (n <= 8192) return 'high';
    return 'max';
  }
  return 'mid';
}