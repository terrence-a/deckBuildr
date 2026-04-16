const THEME_KEY = 'deckbldr-theme';

export function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(pref) {
  const resolved = pref === 'system' ? getSystemTheme() : pref;
  document.documentElement.dataset.theme = resolved === 'light' ? 'light' : '';

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeVal === pref);
  });
}

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'system';
  applyTheme(saved);

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme('system');
  });
}

export async function loadRandomCardArt() {
  const img = document.getElementById('logo-art');
  const fallback = document.getElementById('logo-fallback');
  if (!img) return;

  try {
    const res = await fetch('https://api.scryfall.com/cards/random', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error('no card');
    const card = await res.json();

    const artUrl = card?.image_uris?.small;
    if (!artUrl) throw new Error('no art');

    img.onload = () => {
      img.style.display = 'block';
      if (fallback) fallback.style.display = 'none';
    };
    img.onerror = () => { /* keep fallback */ };
    img.src = artUrl;

    const icon = document.getElementById('logo-icon');
    if (icon) {
      icon.title = 'your card of the day';
      icon.addEventListener('click', () => window.open(card.scryfall_uri, '_blank', 'noopener'), { once: true });
    }
  } catch {
  }
}
