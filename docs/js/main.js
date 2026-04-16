import { STORES } from './constants.js';
import { fetchPrice, setUseCorsProxy, getUseCorsProxy } from './api.js';
import { parseInput, parseText } from './parser.js';
import { initTheme, loadRandomCardArt, applyTheme } from './theme.js';
import { setProgress, buildTableHeader, upsertRow, updateSummary, exportCsv, escHtml } from './ui.js';

let abortController = null;
let currentResults = [];
let sortCol = null;
let sortDir = 1;

let dropZone, fileInput, pasteArea, condSelect, runBtn, stopBtn, clearBtn, exportBtn;
let progressSection, corsNotice, corsToggle, resultsSection, resultsTbody;

function getElements() {
  dropZone        = document.getElementById('drop-zone');
  fileInput       = document.getElementById('file-input');
  pasteArea       = document.getElementById('paste-area');
  condSelect      = document.getElementById('condition-select');
  runBtn          = document.getElementById('run-btn');
  stopBtn         = document.getElementById('stop-btn');
  clearBtn        = document.getElementById('clear-btn');
  exportBtn       = document.getElementById('export-btn');
  progressSection = document.getElementById('progress-section');
  corsNotice      = document.getElementById('cors-notice');
  corsToggle      = document.getElementById('cors-toggle');
  resultsSection  = document.getElementById('results-section');
  resultsTbody    = document.getElementById('results-tbody');
}

function enabledStores() {
  return STORES.filter(s =>
    document.getElementById(`toggle-${s.id}`)?.classList.contains('active')
  );
}

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sortTable(col) {
  const stores = enabledStores();
  if (sortCol === col) {
    sortDir *= -1;
  } else {
    sortCol = col;
    sortDir = 1;
  }

  const resultsTable = document.getElementById('results-table');
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
    upsertRow(i, r.card, stores, r);
  });
}

async function run() {
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

  abortController = new AbortController();
  currentResults = cards.map(card => ({ card, stores: {} }));
  resultsTbody.innerHTML = '';
  corsNotice.classList.remove('visible');

  progressSection.classList.add('visible');
  resultsSection.classList.add('visible');
  runBtn.disabled = true;
  stopBtn.style.display = '';
  exportBtn.disabled = true;

  buildTableHeader(stores, sortTable);
  currentResults.forEach((r, i) => upsertRow(i, r.card, stores, r));

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

      if (result.corsError && !corsErrorSeen && !getUseCorsProxy()) {
        corsErrorSeen = true;
        corsNotice.classList.add('visible');
      }

      currentResults[i].stores[store.id] = result.price != null ? result : null;
      upsertRow(i, card, stores, currentResults[i]);
      done++;
      setProgress(done, total, `${store.name} → ${card}`);

      await sleep(500);
    }
  }

  setProgress(total, total, 'Done!');
  runBtn.disabled = false;
  stopBtn.style.display = 'none';
  exportBtn.disabled = false;
  updateSummary(cards.length, stores, currentResults);
}

document.addEventListener('DOMContentLoaded', () => {
  getElements();
  loadRandomCardArt();

  initTheme();
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pref = btn.dataset.themeVal;
      localStorage.setItem('deckbldr-theme', pref);
      applyTheme(pref);
    });
  });

  STORES.forEach(store => {
    const el = document.getElementById(`toggle-${store.id}`);
    if (!el) return;
    el.classList.add('active');
    el.addEventListener('click', () => el.classList.toggle('active'));
  });

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

  runBtn.addEventListener('click', run);
  stopBtn.addEventListener('click', () => { abortController?.abort(); });
  clearBtn.addEventListener('click', clearAll);
  exportBtn.addEventListener('click', () => exportCsv(enabledStores(), currentResults));

  corsToggle.addEventListener('change', e => {
    setUseCorsProxy(e.target.checked);
    if (!getUseCorsProxy()) corsNotice.querySelector('.cors-notice-text').innerHTML =
      '<strong>CORS proxy disabled.</strong> Direct requests may be blocked by some stores. Re-run to retry.';
    else corsNotice.querySelector('.cors-notice-text').innerHTML =
      '<strong>CORS proxy enabled.</strong> Requests are routed through corsproxy.io.';
  });
});
