import { CORS_PROXIES, CONDITION_MAP } from './constants.js';

let useCorsProxy = true;

export function setUseCorsProxy(val) {
  useCorsProxy = val;
}

export function getUseCorsProxy() {
  return useCorsProxy;
}

export async function getJSON(url, signal) {
  if (!useCorsProxy) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  let lastErr;
  for (const makeUrl of CORS_PROXIES) {
    const proxyUrl = makeUrl(url);
    try {
      const res = await fetch(proxyUrl, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data && typeof data.contents === 'string') {
        try { return JSON.parse(data.contents); } catch { throw new Error('Bad JSON from proxy'); }
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('All proxies failed');
}

export function navigate(obj, path) {
  return path.reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : []), obj) || [];
}

export function matchesFilter(product, store) {
  if (!store.filterField) return true;
  const val = String(product[store.filterField] || '').toLowerCase();
  const tgt = store.filterValue.toLowerCase();
  return store.filterMode === 'equals' ? val === tgt : val.includes(tgt);
}

export async function fetchPrice(store, cardName, condition, signal) {
  const keywords = CONDITION_MAP[condition] || [condition];

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

  candidates.sort((a, b) => parseFloat(a.price_min) - parseFloat(b.price_min));
  const best = candidates[0];
  return {
    price: parseFloat(best.price_min),
    url: `${store.urlPrefix}${best.url || ''}`,
  };
}
