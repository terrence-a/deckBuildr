export const STORES = [
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

export const CONDITION_MAP = {
  NM:  ['NM', 'NEAR MINT', 'MINT'],
  LP:  ['LP', 'LIGHTLY PLAYED', 'SP', 'SLIGHTLY PLAYED'],
  MP:  ['MP', 'MODERATELY PLAYED', 'PL', 'PLAYED'],
  HP:  ['HP', 'HEAVILY PLAYED'],
  DMG: ['DMG', 'DAMAGED', 'POOR'],
};

export const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
];
