export function parseText(raw) {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('//'))
    .map(l => l.replace(/^(\d+x?\s+)/, '').trim())
    .filter(Boolean);
}

export function parseCsv(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const rows = lines.map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
  const first = rows[0].map(h => h.toLowerCase());
  const colIdx = first.indexOf('card_name') !== -1 ? first.indexOf('card_name') : 0;
  const startRow = (first.includes('card_name') || first[0] === 'card' || first[0] === 'name') ? 1 : 0;
  return rows.slice(startRow)
    .map(r => r[colIdx])
    .filter(n => n && !n.startsWith('#'));
}

export function parseInput(raw, isCSV = false) {
  return isCSV ? parseCsv(raw) : parseText(raw);
}
