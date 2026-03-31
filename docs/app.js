// ── DeckBldr app.js ──────────────────────────────────────────────────────────
// Ports deckbldr.py logic to browser JavaScript.
// Calls Shopify suggest.json + products/{handle}.json for each card/store.
// Falls back to a CORS proxy if direct requests are blocked.

'use strict';

// ── Store Configurations ─────────────────────────────────────────────────────
const STORES = [
  {
    id: 'four01',
    name: '401 Games',
    currency: 'CAD',
    suggestEndpoint: 'https://store.401games.ca/search/suggest.json',
    variantEndpoint: 'https://store.401games.ca/products/{handle}.json',
    urlPrefix: 'https://store.401games.ca',
    filterField: 'type',
    filterValue: 'magic',
    filterMode: 'contains',
  },
  {
    id: 'f2f',
    name: 'Face to Face',
    currency: 'CAD',
    suggestEndpoint: 'https://www.facetofacegames.com/search/suggest.json',
    variantEndpoint: 'https://www.facetofacegames.com/products/{handle}.json',
    urlPrefix: 'https://www.facetofacegames.com',
    filterField: 'vendor',
    filterValue: 'magic',
    filterMode: 'equals',
  },
  {
    id: 'wt',
    name: 'Wizards Tower',
    currency: 'CAD',
    suggestEndpoint: 'https://www.kanatacg.com/search/suggest.json',
    variantEndpoint: 'https://www.kanatacg.com/products/{handle}.json',
    urlPrefix: 'https://www.kanatacg.com',
    filterField: 'type',
    filterValue: 'magic',
    filterMode: 'contains',
  },
];

const CONDITION_MAP = {
  NM:  ['NM', 'NEAR MINT', 'MINT'],
  LP:  ['LP', 'LIGHTLY PLAYED', 'SP', 'SLIGHTLY PLAYED'],
  MP:  ['MP', 'MODERATELY PLAYED', 'PL', 'PLAYED'],
  HP:  ['HP', 'HEAVILY PLAYED'],
  DMG: ['DMG', 'DAMAGED', 'POOR'],
};

// ── State ────────────────────────────────────────────────────────────────────
let useCorsProxy = false;
let abortController = null;
let currentResults = [];  // [{ card, stores: { storeName: { price, url } } }]

// CORS proxy options — tried in order until one works
const CORS_PROXIES = [
  // corsproxy.io: simple prefix, returns raw response
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  // allorigins.win: returns { contents: "...", status: { http_code: 200 } }
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  // thingproxy: simple prefix
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
];

// ── DOM Refs ─────────────────────────────────────────────────────────────────
const dropZone    = document.getElementById('drop-zone');
const fileInput   = document.getElementById('file-input');
const pasteArea   = document.getElementById('paste-area');
const condSelect  = document.getElementById('condition-select');
const runBtn      = document.getElementById('run-btn');
const stopBtn     = document.getElementById('stop-btn');
const clearBtn    = document.getElementById('clear-btn');
const exportBtn   = document.getElementById('export-btn');

const progressSection = document.getElementById('progress-section');
const progressBar     = document.getElementById('progress-bar');
const progressPct     = document.getElementById('progress-pct');
const progressLabel   = document.getElementById('progress-label');
const progressStatus  = document.getElementById('progress-status');

const corsNotice  = document.getElementById('cors-notice');
const corsToggle  = document.getElementById('cors-toggle');

const resultsSection = document.getElementById('results-section');
const resultsTbody   = document.getElementById('results-tbody');
const resultsSummary = document.getElementById('results-summary');
const resultsTable   = document.getElementById('results-table');

// ── Parsing ───────────────────────────────────────────────────────────────────
function parseText(raw) {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('//'))
    .map(l => l.replace(/^(\d+x?\s+)/, '').trim())
    .filter(Boolean);
}

function parseCsv(raw) {
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

function parseInput(raw, isCSV = false) {
  return isCSV ? parseCsv(raw) : parseText(raw);
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function getJSON(url, signal) {
  if (!useCorsProxy) {
    // Direct fetch — works when server sends CORS headers (expected on GitHub Pages)
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Try each proxy in order, return first successful response
  let lastErr;
  for (const makeUrl of CORS_PROXIES) {
    const proxyUrl = makeUrl(url);
    try {
      const res = await fetch(proxyUrl, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // allorigins.win wraps the response in { contents: "...", status: {...} }
      if (data && typeof data.contents === 'string') {
        try { return JSON.parse(data.contents); } catch { throw new Error('Bad JSON from proxy'); }
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      // Try next proxy
    }
  }
  throw lastErr || new Error('All proxies failed');
}

function navigate(obj, path) {
  return path.reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : []), obj) || [];
}

function matchesFilter(product, store) {
  if (!store.filterField) return true;
  const val = String(product[store.filterField] || '').toLowerCase();
  const tgt = store.filterValue.toLowerCase();
  return store.filterMode === 'equals' ? val === tgt : val.includes(tgt);
}

async function fetchPrice(store, cardName, condition, signal) {
  const keywords = CONDITION_MAP[condition] || [condition];

  // 1. Suggest endpoint
  const params = new URLSearchParams({
    q: cardName,
    'resources[type]': 'product',
    'resources[limit]': '10',
  });
  const suggestUrl = `${store.suggestEndpoint}?${params}`;

  let data;
  try {
    data = await getJSON(suggestUrl, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { price: null, url: null, corsError: !useCorsProxy };
  }

  const products = navigate(data, ['resources', 'results', 'products']);
  const candidates = products.filter(p =>
    matchesFilter(p, store) &&
    p.available &&
    parseFloat(p.price_min || 0) > 0.001
  );

  if (!candidates.length) return { price: null, url: null };

  // 2. Try variant endpoint on top-3 candidates
  let bestPrice = Infinity;
  let bestUrl = '';
  let foundCondition = false;

  for (const prod of candidates.slice(0, 3)) {
    const handle = prod.handle;
    if (!handle) continue;

    let vData;
    try {
      vData = await getJSON(
        store.variantEndpoint.replace('{handle}', handle),
        signal
      );
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      continue;
    }

    const variants = vData?.product?.variants || [];
    for (const v of variants) {
      if ('inventory_quantity' in v && parseInt(v.inventory_quantity, 10) <= 0) continue;

      const opt1  = String(v.option1 || '').toUpperCase();
      const opt2  = String(v.option2 || '').toUpperCase();
      const title = String(v.title  || '').toUpperCase();
      const matched = keywords.some(kw => opt1.includes(kw) || opt2.includes(kw) || title.includes(kw));

      if (matched) {
        const vp = parseFloat(v.price || 0);
        if (vp > 0.001 && vp < bestPrice) {
          bestPrice = vp;
          bestUrl = `${store.urlPrefix}${prod.url || ''}`;
          foundCondition = true;
        }
      }
    }
  }

  if (foundCondition) return { price: bestPrice, url: bestUrl };

  // 3. Cheapest fallback from suggest
  candidates.sort((a, b) => parseFloat(a.price_min) - parseFloat(b.price_min));
  const best = candidates[0];
  return {
    price: parseFloat(best.price_min),
    url: `${store.urlPrefix}${best.url || ''}`,
  };
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function enabledStores() {
  return STORES.filter(s =>
    document.getElementById(`toggle-${s.id}`)?.classList.contains('active')
  );
}

function setProgress(done, total, statusText) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;
  progressLabel.textContent = `${done} / ${total}`;
  if (statusText) progressStatus.textContent = statusText;
}

function fmtPrice(priceNum) {
  return priceNum != null ? `$${priceNum.toFixed(2)}` : null;
}

function buildTableHeader(stores) {
  const thead = resultsTable.querySelector('thead tr');
  // Clear dynamic cols (beyond Card Name)
  while (thead.children.length > 1) thead.removeChild(thead.lastChild);
  for (const s of stores) {
    const th = document.createElement('th');
    th.textContent = `${s.name} (${s.currency})`;
    th.dataset.col = s.id;
    th.addEventListener('click', () => sortTable(s.id));
    thead.appendChild(th);
  }
  const thCheap = document.createElement('th');
  thCheap.textContent = 'Cheapest (CAD)';
  thCheap.dataset.col = 'cheapest';
  thCheap.addEventListener('click', () => sortTable('cheapest'));
  thead.appendChild(thCheap);
}

function upsertRow(cardIndex, cards, stores) {
  const card = cards[cardIndex];
  const existing = document.getElementById(`row-${cardIndex}`);
  const row = existing || document.createElement('tr');
  row.id = `row-${cardIndex}`;

  const result = currentResults[cardIndex] || {};
  const storeData = result.stores || {};

  let cells = `<td class="cell-card">${escHtml(card)}</td>`;

  let cheapestPrice = Infinity;
  let cheapestStore = null;
  let cheapestUrl = null;

  for (const s of stores) {
    const d = storeData[s.id];
    if (d === undefined) {
      cells += `<td><span class="loading-cell">checking…</span></td>`;
    } else if (d === null || d.price == null) {
      cells += `<td><span class="price-badge na">N/A</span></td>`;
    } else {
      if (d.price < cheapestPrice) {
        cheapestPrice = d.price;
        cheapestStore = s.name;
        cheapestUrl = d.url;
      }
      const link = d.url ? `<a class="store-link" href="${escHtml(d.url)}" target="_blank" rel="noopener">↗</a>` : '';
      cells += `<td><span class="price-badge">${escHtml(fmtPrice(d.price))} ${link}</span></td>`;
    }
  }

  if (Object.keys(storeData).length < stores.length) {
    cells += `<td><span class="loading-cell">—</span></td>`;
  } else if (cheapestPrice === Infinity) {
    cells += `<td><span class="price-badge na">N/A</span></td>`;
  } else {
    const link = cheapestUrl ? ` <a href="${escHtml(cheapestUrl)}" target="_blank" rel="noopener" style="color:var(--accent2);font-size:0.75rem;">↗</a>` : '';
    cells += `<td class="cheapest-cell">${escHtml(fmtPrice(cheapestPrice))}${link}<br><small style="color:var(--text-muted);font-weight:400;font-size:0.72rem;font-family:inherit;">${escHtml(cheapestStore)}</small></td>`;
  }

  row.innerHTML = cells;
  if (!existing) resultsTbody.appendChild(row);
}

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateSummary(cards, stores) {
  const found = currentResults.filter(r =>
    r && stores.some(s => r.stores?.[s.id]?.price != null)
  ).length;
  resultsSummary.innerHTML = `<strong>${found}</strong> of ${cards.length} card(s) found across ${stores.length} store(s)`;
}

// ── Sort ──────────────────────────────────────────────────────────────────────
let sortCol = null;
let sortDir = 1;

function sortTable(col) {
  const stores = enabledStores();
  if (sortCol === col) {
    sortDir *= -1;
  } else {
    sortCol = col;
    sortDir = 1;
  }

  // Update header indicators
  resultsTable.querySelectorAll('th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === col) {
      th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });

  currentResults.sort((a, b) => {
    let va, vb;
    if (col === 'cheapest') {
      va = Math.min(...stores.map(s => a.stores?.[s.id]?.price ?? Infinity));
      vb = Math.min(...stores.map(s => b.stores?.[s.id]?.price ?? Infinity));
    } else {
      const s = stores.find(st => st.id === col);
      va = s ? (a.stores?.[s.id]?.price ?? Infinity) : Infinity;
      vb = s ? (b.stores?.[s.id]?.price ?? Infinity) : Infinity;
    }
    return (va - vb) * sortDir;
  });

  resultsTbody.innerHTML = '';
  currentResults.forEach((r, i) => {
    upsertRow(i, currentResults.map(x => x.card), stores);
  });
}

// ── Export ────────────────────────────────────────────────────────────────────
function exportCsv() {
  const stores = enabledStores();
  const headers = ['card_name', ...stores.map(s => `${s.name} (${s.currency})`), 'Cheapest Store', 'Cheapest Price (CAD)'];

  const rows = currentResults.map(r => {
    const row = [r.card];
    let cheapestPrice = Infinity;
    let cheapestStore = 'N/A';

    for (const s of stores) {
      const price = r.stores?.[s.id]?.price;
      row.push(price != null ? price.toFixed(2) : 'N/A');
      if (price != null && price < cheapestPrice) {
        cheapestPrice = price;
        cheapestStore = s.name;
      }
    }

    row.push(cheapestStore);
    row.push(cheapestPrice !== Infinity ? cheapestPrice.toFixed(2) : 'N/A');
    return row;
  });

  const csv = [headers, ...rows]
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const ts  = new Date().toISOString().replace(/[:\-T]/g,'').slice(0,15);
  const a   = document.createElement('a');
  a.href    = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `deckbldr_prices_${ts}.csv`;
  a.click();
}

// ── Main Run ──────────────────────────────────────────────────────────────────
async function run() {
  // Parse cards
  const raw = pasteArea.value.trim();
  const fileText = dropZone.dataset.fileText || '';
  const fileIsCSV = dropZone.dataset.fileIsCSV === 'true';

  let cards;
  if (fileText) {
    cards = parseInput(fileText, fileIsCSV);
  } else if (raw) {
    cards = parseText(raw);
  } else {
    pasteArea.style.borderColor = 'var(--red)';
    setTimeout(() => (pasteArea.style.borderColor = ''), 1500);
    return;
  }

  if (!cards.length) return;

  const stores = enabledStores();
  if (!stores.length) return;

  const condition = condSelect.value;

  // Reset
  abortController = new AbortController();
  currentResults = cards.map(card => ({ card, stores: {} }));
  resultsTbody.innerHTML = '';
  corsNotice.classList.remove('visible');

  // Show sections
  progressSection.classList.add('visible');
  resultsSection.classList.add('visible');
  runBtn.disabled = true;
  stopBtn.style.display = '';
  exportBtn.disabled = true;

  buildTableHeader(stores);
  cards.forEach((_, i) => upsertRow(i, cards, stores));

  const total = cards.length * stores.length;
  let done = 0;
  let corsErrorSeen = false;

  setProgress(0, total, 'Starting…');

  outer:
  for (const store of stores) {
    for (let i = 0; i < cards.length; i++) {
      if (abortController.signal.aborted) break outer;

      const card = cards[i];
      setProgress(done, total, `${store.name} → ${card}`);

      let result;
      try {
        result = await fetchPrice(store, card, condition, abortController.signal);
      } catch (e) {
        if (e.name === 'AbortError') break outer;
        result = { price: null, url: null };
      }

      if (result.corsError && !corsErrorSeen && !useCorsProxy) {
        corsErrorSeen = true;
        corsNotice.classList.add('visible');
      }

      currentResults[i].stores[store.id] = result.price != null ? result : null;
      upsertRow(i, cards, stores);
      done++;
      setProgress(done, total, `${store.name} → ${card}`);

      // Polite delay
      await sleep(500);
    }
  }

  setProgress(total, total, 'Done!');
  runBtn.disabled = false;
  stopBtn.style.display = 'none';
  exportBtn.disabled = false;
  updateSummary(cards, stores);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Event Wiring ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Store toggles
  STORES.forEach(store => {
    const el = document.getElementById(`toggle-${store.id}`);
    if (!el) return;
    el.classList.add('active');
    el.addEventListener('click', () => el.classList.toggle('active'));
  });

  // Drop zone
  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  // Buttons
  runBtn.addEventListener('click', run);
  stopBtn.addEventListener('click', () => { abortController?.abort(); });
  clearBtn.addEventListener('click', clearAll);
  exportBtn.addEventListener('click', exportCsv);

  // CORS toggle
  corsToggle.addEventListener('change', e => {
    useCorsProxy = e.target.checked;
    if (useCorsProxy) corsNotice.querySelector('.cors-notice-text').innerHTML =
      '<strong>CORS proxy enabled.</strong> Requests are routed through corsproxy.io. Re-run to retry failed cards.';
  });
});

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    dropZone.dataset.fileText = e.target.result;
    dropZone.dataset.fileIsCSV = file.name.toLowerCase().endsWith('.csv') ? 'true' : 'false';
    dropZone.classList.add('has-file');
    dropZone.querySelector('.drop-label').innerHTML =
      `<strong>${escHtml(file.name)}</strong> loaded`;
    dropZone.querySelector('.drop-hint').textContent =
      `Click to change file`;
    pasteArea.value = '';
    pasteArea.placeholder = `File loaded — or type/paste a decklist here to override`;
  };
  reader.readAsText(file);
}

function clearAll() {
  pasteArea.value = '';
  delete dropZone.dataset.fileText;
  delete dropZone.dataset.fileIsCSV;
  dropZone.classList.remove('has-file');
  dropZone.querySelector('.drop-label').innerHTML =
    `<strong>Drop a decklist</strong> or click to browse`;
  dropZone.querySelector('.drop-hint').textContent =
    `.txt or .csv · One card per line`;
  resultsTbody.innerHTML = '';
  currentResults = [];
  progressSection.classList.remove('visible');
  resultsSection.classList.remove('visible');
  corsNotice.classList.remove('visible');
  exportBtn.disabled = true;
  fileInput.value = '';
}
