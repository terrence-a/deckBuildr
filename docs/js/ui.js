export function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtPrice(priceNum) {
  return priceNum != null ? `$${priceNum.toFixed(2)}` : null;
}

export function setProgress(done, total, statusText) {
  const progressBar     = document.getElementById('progress-bar');
  const progressPct     = document.getElementById('progress-pct');
  const progressLabel   = document.getElementById('progress-label');
  const progressStatus  = document.getElementById('progress-status');

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;
  progressLabel.textContent = `${done} / ${total}`;
  if (statusText) progressStatus.textContent = statusText;
}

export function buildTableHeader(stores, onSort) {
  const resultsTable = document.getElementById('results-table');
  const thead = resultsTable.querySelector('thead tr');
  while (thead.children.length > 1) thead.removeChild(thead.lastChild);
  
  for (const s of stores) {
    const th = document.createElement('th');
    th.textContent = `${s.name} (${s.currency})`;
    th.dataset.col = s.id;
    th.addEventListener('click', () => onSort(s.id));
    thead.appendChild(th);
  }
  
  const thCheap = document.createElement('th');
  thCheap.textContent = 'Cheapest (CAD)';
  thCheap.dataset.col = 'cheapest';
  thCheap.addEventListener('click', () => onSort('cheapest'));
  thead.appendChild(thCheap);
}

export function upsertRow(cardIndex, card, stores, result) {
  const resultsTbody = document.getElementById('results-tbody');
  const existing = document.getElementById(`row-${cardIndex}`);
  const row = existing || document.createElement('tr');
  row.id = `row-${cardIndex}`;

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

export function updateSummary(totalCards, stores, currentResults) {
  const resultsSummary = document.getElementById('results-summary');
  const found = currentResults.filter(r =>
    r && stores.some(s => r.stores?.[s.id]?.price != null)
  ).length;
  resultsSummary.innerHTML = `<strong>${found}</strong> of ${totalCards} card(s) found across ${stores.length} store(s)`;
}

export function exportCsv(stores, currentResults) {
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
