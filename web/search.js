// Zoekvragen en hulpfuncties voor de Elasticsearch-service monumenten-in-nederland op rce/monumenten-in-nederland.
// Geen DOM: alles hier is te testen met npm test. Opzet als C:\AI\elastic-ceo\web\search.js.
export const ENDPOINT = 'https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/monumenten-in-nederland/services/monumenten-in-nederland/_search';
export const PAGE_SIZE = 20;
export const MAX_WINDOW = 10000;
const MAX_VALUES = 20;
export const ID = 'https://linkeddata.cultureelerfgoed.nl/rce/monumenten-in-nederland/id/';

// Veldnaam in Elastic = property-IRI met een spatie in plaats van elke punt.
const SDO = 'https://schema org/';
const MIN = 'https://linkeddata cultureelerfgoed nl/def/monumenten-in-nederland#';
export const fields = {
  tekst: SDO + 'text', naam: SDO + 'name', bijschrift: SDO + 'caption', uitleg: SDO + 'description',
  label: 'http://www w3 org/2000/01/rdf-schema#label', type: 'http://www w3 org/1999/02/22-rdf-syntax-ns#type',
  isPartOf: SDO + 'isPartOf', image: SDO + 'image', url: SDO + 'url', contentUrl: SDO + 'contentUrl',
  inDefinedTermSet: SDO + 'inDefinedTermSet', position: SDO + 'position', pageStart: SDO + 'pageStart',
  pagination: SDO + 'pagination', identifier: SDO + 'identifier', datePublished: SDO + 'datePublished',
  author: SDO + 'author', publisher: SDO + 'publisher',
  ...Object.fromEntries(['lemma', 'hoofdstuk', 'kern', 'alternatieveNaam', 'gemeente', 'gemeenteInBoek', 'provincie', 'deel',
    'adres', 'rijksmonumentnummer', 'noemtRijksmonument', 'inDeel', 'soort', 'volgnummer'].map(naam => [naam, MIN + naam])),
};
export const KERN_TYPE = 'https://linkeddata.cultureelerfgoed.nl/def/monumenten-in-nederland#Kern';

// Soort uit de URI (= @id.soort in de index): …/id/<deel>/passage/00451 → passage, …/id/<deel> → deel.
export const soorten = { passage: 'Tekst', hoofdstuk: 'Hoofdstuk', afbeelding: 'Afbeelding', term: 'Term' };
export const tekstsoorten = { lemma: 'Monument (lemma)', inleiding: 'Inleiding van een kern', alinea: 'Alinea', literatuur: 'Literatuur' };
export const soortVan = uri => /\/id\/[^/]+\/([a-z]+)\/[^/]+$/.exec(String(uri ?? ''))?.[1] ?? (/\/id\/sten[^/]+$/.test(String(uri ?? '')) ? 'deel' : null);
const SOORT_FIELD = '@id.soort';
// Delen van een URI: deelcode en sleutel, bijv. sten009monu10_01 en 0030 of 00451.
export function delen(uri) {
  const m = /\/id\/(sten[0-9a-z_]+)(?:\/([a-z]+)\/([^/]+))?$/.exec(String(uri ?? ''));
  return m ? { deel: m[1], soort: m[2] ?? 'deel', sleutel: m[3] ?? null } : null;
}
export const deelUri = code => `${ID}${code}`;
export const hoofdstukUri = (code, sleutel) => `${ID}${code}/hoofdstuk/${sleutel}`;

// Zoekvelden. TEKST heeft Nederlandse taalverwerking (en .exact), KORT alleen kleine letters en accenten.
const TEKST = ['tekst', 'naam', 'lemma', 'bijschrift', 'uitleg', 'hoofdstuk', 'label'];
const KORT = ['kern', 'alternatieveNaam', 'gemeente', 'gemeenteInBoek', 'provincie', 'adres'];
const NUMMER = ['rijksmonumentnummer'];
const veld = list => list.map(naam => fields[naam]);
export const searchFields = {
  Alles: veld([...TEKST, ...KORT, ...NUMMER]),
  Tekst: veld(['tekst', 'bijschrift', 'uitleg']),
  'Naam of lemma': veld(['naam', 'lemma', 'label']),
  Plaats: veld(['kern', 'alternatieveNaam', 'gemeente', 'gemeenteInBoek', 'provincie']),
  Adres: veld(['adres']),
  Rijksmonumentnummer: veld(NUMMER),
  // Zonder stemming, samenstellingen en synoniemen (subveld .exact; de korte velden zijn al exact).
  Exact: [...veld(TEKST).map(key => `${key}.exact`), ...veld([...KORT, ...NUMMER])],
};
export const DEFAULT_FIELD = 'Alles';
// Weging voor de volgorde: een treffer in naam of lemma telt WEIGHT keer zo zwaar. Alleen bij Alles en Exact.
export const WEIGHT = 3;
const WEIGHTED = veld(['naam', 'lemma']);
const weighted = key => WEIGHTED.some(base => key === base || key === `${base}.exact`);
export function queryFields(field) {
  return field === 'Alles' || field === 'Exact' ? searchFields[field].map(key => (weighted(key) ? `${key}^${WEIGHT}` : key)) : searchFields[field];
}
// Highlights alleen op tekstvelden (niet op .exact, dat geeft dubbele fragmenten).
const HIGHLIGHT = veld(['tekst', 'bijschrift', 'uitleg', 'naam', 'lemma', 'adres']);

export const facets = { deel: 'Deel', soort: 'Soort', tekstsoort: 'Soort tekst', gemeente: 'Gemeente (nu)', kern: 'Plaats in het boek' };
const facetField = key => ({ soort: SOORT_FIELD, deel: fields.inDeel, tekstsoort: fields.soort }[key] ?? `${fields[key]}.keyword`);
// Wat doorzocht wordt: geen deel- en seriedocumenten.
const ZOEKBAAR = { terms: { [SOORT_FIELD]: Object.keys(soorten) } };

export const sorts = {
  relevantie: { label: 'Relevantie', sort: null },
  boek: { label: 'Volgorde in het boek', sort: [{ [fields.inDeel]: { order: 'asc' } }, { [fields.volgnummer]: { order: 'asc', missing: '_last' } }, { '@id.keyword': { order: 'asc' } }] },
  plaats: { label: 'Plaats (A–Z)', sort: [{ [`${fields.kern}.keyword`]: { order: 'asc', missing: '_last' } }, { [fields.volgnummer]: { order: 'asc', missing: '_last' } }] },
};

// Een schuine streep start in query_string een reguliere expressie; maak er een gewoon teken van.
export const veiligeZoekvraag = query => query.replace(/(?<!\\)\//g, '\\/');

const clauseFor = (key, list) => ({ terms: { [facetField(key)]: list } });
const filterClauses = (filters, skip) => Object.entries(filters).filter(([key, list]) => key !== skip && list.length).map(([key, list]) => clauseFor(key, list));
function validate({ query = '', field = DEFAULT_FIELD, filters = {}, page = 0, sort = 'relevantie' }) {
  if (!Object.hasOwn(searchFields, field)) throw new Error('Onbekend zoekveld.');
  if (!Object.hasOwn(sorts, sort)) throw new Error('Onbekende sortering.');
  if (!Number.isInteger(page) || page < 0 || (page + 1) * PAGE_SIZE > MAX_WINDOW) throw new Error('Verfijn je zoekvraag om meer resultaten te bekijken.');
  if (typeof query !== 'string' || query.length > 500) throw new Error('Gebruik maximaal 500 tekens in je zoekvraag.');
  const clean = {};
  for (const [key, value] of Object.entries(filters)) {
    const list = Array.isArray(value) ? value : [value];
    if (!Object.hasOwn(facets, key) || list.length > MAX_VALUES || !list.every(item => typeof item === 'string' && item.length <= 300)) throw new Error('Ongeldig filter.');
    if (key === 'soort' && !list.every(item => Object.hasOwn(soorten, item))) throw new Error('Ongeldig filter.');
    if (key === 'tekstsoort' && !list.every(item => Object.hasOwn(tekstsoorten, item))) throw new Error('Ongeldig filter.');
    if (list.length) clean[key] = [...new Set(list)];
  }
  const text = query.trim() ? { query_string: { query: veiligeZoekvraag(query.trim()), fields: queryFields(field) } } : { match_all: {} };
  return { search: { bool: { must: [text], filter: [ZOEKBAAR] } }, filters: clean, field, page, sort };
}
const facetAggs = filters => Object.fromEntries(Object.keys(facets).map(key => [key, {
  filter: { bool: { filter: filterClauses(filters, key) } },
  aggs: { values: { terms: { field: facetField(key), size: key === 'kern' || key === 'gemeente' ? 300 : 20 } } },
}]));
// Zoeken (query) en filteren (post_filter) blijven gescheiden. Elke facet telt met de filters van de andere facetten.
export function buildQuery(state = {}) {
  const { search, filters, field, page, sort } = validate(state);
  return {
    from: page * PAGE_SIZE, size: PAGE_SIZE, track_total_hits: true, timeout: '15s',
    query: search,
    post_filter: { bool: { filter: filterClauses(filters) } },
    ...(sorts[sort].sort ? { sort: sorts[sort].sort } : {}),
    highlight: {
      fields: Object.fromEntries(HIGHLIGHT.filter(key => searchFields[field].some(f => f === key || f === `${key}.exact`)).map(key => [key, { fragment_size: 220, number_of_fragments: 3 }])),
      pre_tags: ['<mark>'], post_tags: ['</mark>'], encoder: 'html',
    },
    aggs: facetAggs(filters),
  };
}
export function bucketsOf(aggregation) {
  const v = aggregation?.values;
  return v && Array.isArray(v.buckets) ? v.buckets : [];
}

// --- Lezen: delen, inhoudsopgave, tekst van een hoofdstuk -------------------------------------------------------
export const delenQuery = () => ({
  size: 20, query: { term: { [SOORT_FIELD]: 'deel' } },
  _source: ['@id', fields.naam, fields.provincie, fields.datePublished, fields.position, fields.url, fields.author, fields.publisher],
  sort: [{ [fields.position]: { order: 'asc', missing: '_last' } }],
});
// Het hoofdstuk 'Steden, dorpen, monumenten' van elk deel (de lijst van plaatsen).
export const kernenHoofdstukQuery = () => ({
  size: 20, _source: ['@id'],
  query: { bool: { filter: [{ term: { [SOORT_FIELD]: 'hoofdstuk' } }, { term: { [`${fields.naam}.keyword`]: 'Steden, dorpen, monumenten' } }] } },
});
// Hoofdstukken, secties en kernen van een deel. Oudere uploads hebben bij de bovenste hoofdstukken geen min:inDeel,
// daarom ook isPartOf = het deel.
export const tocQuery = code => ({
  size: 2000,
  query: { bool: { filter: [{ term: { [SOORT_FIELD]: 'hoofdstuk' } }], should: [{ term: { [fields.inDeel]: deelUri(code) } }, { term: { [fields.isPartOf]: deelUri(code) } }], minimum_should_match: 1 } },
  _source: ['@id', fields.naam, fields.isPartOf, fields.type, fields.kern, fields.gemeente, fields.gemeenteInBoek, fields.url],
  sort: [{ '@id.keyword': { order: 'asc' } }],
});
export const passagesQuery = uris => ({
  size: 2000, query: { bool: { filter: [{ term: { [SOORT_FIELD]: 'passage' } }, { terms: { [fields.isPartOf]: uris } }] } },
  sort: [{ [fields.volgnummer]: { order: 'asc' } }],
});
export const afbeeldingenQuery = uris => ({
  size: 2000, query: { bool: { filter: [{ term: { [SOORT_FIELD]: 'afbeelding' } }, { terms: { [fields.isPartOf]: uris } }] } },
});
export const termenQuery = uri => ({
  size: 2000, query: { bool: { filter: [{ term: { [SOORT_FIELD]: 'term' } }, { term: { [fields.inDefinedTermSet]: uri } }] } },
  sort: [{ [`${fields.naam}.keyword`]: { order: 'asc' } }],
});
// Namen van objecten waarnaar resultaten verwijzen (hoofdstuk van een afbeelding of term), in één request.
export const byIdQuery = uris => ({
  size: Math.max(1, uris.length), query: { terms: { '@id.keyword': uris.length ? uris : ['-'] } },
  _source: ['@id', fields.naam, fields.kern, fields.url],
});

export const values = value => (Array.isArray(value) ? value : value == null ? [] : [value]).filter(item => typeof item === 'string' || typeof item === 'number').map(String);
export const first = value => values(value)[0] ?? null;

// Inhoudsopgave als boom. Volgorde = de sleutel in de URI (0004, 0004-01, … 0008, 0008-01, 0009): dat is de
// volgorde van het boek. Alle kernen hangen onder 'Steden, dorpen, monumenten'.
export function buildToc(hits) {
  const nodes = new Map();
  for (const hit of hits) {
    const s = hit._source ?? {};
    const d = delen(s['@id']);
    if (!d || d.soort !== 'hoofdstuk') continue;
    nodes.set(s['@id'], {
      uri: s['@id'], sleutel: d.sleutel, deel: d.deel, naam: first(s[fields.naam]) ?? d.sleutel,
      kern: first(s[fields.kern]), gemeente: first(s[fields.gemeente]), gemeenteInBoek: first(s[fields.gemeenteInBoek]),
      isKern: values(s[fields.type]).includes(KERN_TYPE), ouder: first(s[fields.isPartOf]), url: first(s[fields.url]), kinderen: [],
    });
  }
  const top = [];
  for (const node of [...nodes.values()].sort((a, b) => a.sleutel.localeCompare(b.sleutel))) {
    const ouder = nodes.get(node.ouder);
    if (ouder) ouder.kinderen.push(node); else top.push(node);
  }
  const lijst = [];
  const walk = (list, ouder) => list.forEach(node => { node.ouderNode = ouder; lijst.push(node); walk(node.kinderen, node); });
  walk(top, null);
  return { top, nodes, lijst };
}
// Wat er bij het lezen van een hoofdstuk getoond wordt: het hoofdstuk zelf en zijn secties, maar niet de kernen
// eronder (die hebben een eigen pagina).
export function leesUris(node) {
  const uris = [];
  const walk = n => { uris.push(n.uri); n.kinderen.filter(k => !k.isKern).forEach(walk); };
  walk(node);
  return uris;
}
// Vorige en volgende pagina om te lezen: hoofdstukken en kernen in boekvolgorde, secties zitten in hun hoofdstuk.
export const leespaginas = toc => toc.lijst.filter(n => !n.ouderNode || n.isKern);
export function buren(toc, node) {
  const pagina = leespaginas(toc);
  const i = pagina.indexOf(node);
  return { vorige: i > 0 ? pagina[i - 1] : null, volgende: i >= 0 && i < pagina.length - 1 ? pagina[i + 1] : null };
}
// De pagina waarop een sectie staat: het dichtstbijzijnde hoofdstuk of de kern erboven.
export function leespaginaVan(node) {
  let n = node;
  while (n && n.ouderNode && !n.isKern) n = n.ouderNode;
  return n;
}
// Afbeeldingen bij de passages: eerst via schema:image; losse afbeeldingen (zonder passage) komen vóór de eerste
// passage die op een latere pagina begint.
const illNummer = uri => Number(/ill(\d+)$/.exec(String(uri))?.[1] ?? 0);
const paginaNummer = value => (/^\d+$/.test(String(value ?? '')) ? Number(value) : null);
export function plaatsAfbeeldingen(passages, afbeeldingen) {
  const perUri = new Map(afbeeldingen.map(a => [a['@id'], a]));
  const gebruikt = new Set();
  const blokken = passages.map(p => {
    const figs = values(p[fields.image]).map(uri => perUri.get(uri)).filter(Boolean).sort((a, b) => illNummer(a['@id']) - illNummer(b['@id']));
    figs.forEach(f => gebruikt.add(f['@id']));
    return { passage: p, afbeeldingen: figs, ervoor: [] };
  });
  const los = afbeeldingen.filter(a => !gebruikt.has(a['@id'])).sort((a, b) => illNummer(a['@id']) - illNummer(b['@id']));
  const achteraan = [];
  for (const a of los) {
    const pagina = paginaNummer(first(a[fields.pageStart]));
    const doel = pagina == null ? null : blokken.find(b => (paginaNummer(first(b.passage[fields.pageStart])) ?? -1) > pagina);
    (doel ? doel.ervoor : achteraan).push(a);
  }
  return { blokken, achteraan };
}
// Lemmatekst begint met de naam van het lemma ("Herv. kerk (Hof 16), …"): die naam wordt vet gezet.
export function lemmaBegin(tekst, lemma) {
  if (!lemma || !tekst.startsWith(lemma)) return [null, tekst];
  return [lemma, tekst.slice(lemma.length)];
}

// Alleen links naar bekende hosts.
export function safeUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
export const dbnlUrl = value => { const url = safeUrl(value); return url && new URL(url).hostname === 'www.dbnl.org' ? url : null; };
export const registerUrl = nummer => (/^\d{1,7}$/.test(String(nummer)) ? `https://monumentenregister.cultureelerfgoed.nl/monumenten/${nummer}` : null);
export const afbeeldingUrl = source => dbnlUrl(first(source?.[fields.contentUrl])) ?? (() => {
  const d = delen(source?.['@id']);
  return d?.soort === 'afbeelding' && /^sten[0-9a-z]+$/.test(d.sleutel) ? `https://www.dbnl.org/tekst/${d.deel}/${d.sleutel}.gif` : null;
})();
export const ldUrl = uri => (String(uri ?? '').startsWith(ID) ? `https://linkeddata.cultureelerfgoed.nl/rce/monumenten-in-nederland/browser?resource=${encodeURIComponent(uri)}` : null);

// Deelbare URL. Zoeken: ?q=…&veld=…&deel=…&soort=…&tekstsoort=…&gemeente=…&kern=…&sorteer=…&pagina=…
// Lezen: ?lees=sten009monu10_01/0030 (en #p00451 voor een passage).
const params = { deel: 'deel', soort: 'soort', tekstsoort: 'tekstsoort', gemeente: 'gemeente', kern: 'kern' };
export const LEES = /^(sten[0-9a-z_]+)\/(\d{4}(?:-\d{2})*)$/;
export function toParams({ query = '', field = DEFAULT_FIELD, filters = {}, page = 0, sort = 'relevantie' }) {
  const result = new URLSearchParams();
  if (query.trim()) result.set('q', query.trim());
  if (field !== DEFAULT_FIELD) result.set('veld', field);
  for (const [key, list] of Object.entries(filters)) for (const value of list) result.append(params[key], key === 'deel' ? delen(value)?.deel ?? value : value);
  if (sort !== 'relevantie') result.set('sorteer', sort);
  if (page > 0) result.set('pagina', String(page + 1));
  return result;
}
export function fromParams(search) {
  const input = new URLSearchParams(search);
  const lees = input.get('lees');
  if (lees && LEES.test(lees)) { const [, deel, sleutel] = LEES.exec(lees); return { lees: { deel, sleutel } }; }
  const filters = {};
  for (const [key, name] of Object.entries(params)) {
    let list = input.getAll(name).filter(value => value && value.length <= 300).slice(0, MAX_VALUES);
    if (key === 'deel') list = list.filter(v => /^sten[0-9a-z_]+$/.test(v)).map(deelUri);
    if (key === 'soort') list = list.filter(v => Object.hasOwn(soorten, v));
    if (key === 'tekstsoort') list = list.filter(v => Object.hasOwn(tekstsoorten, v));
    if (list.length) filters[key] = list;
  }
  const page = Number.parseInt(input.get('pagina') ?? '1', 10);
  const state = {
    query: (input.get('q') ?? '').slice(0, 500),
    field: Object.hasOwn(searchFields, input.get('veld')) ? input.get('veld') : DEFAULT_FIELD,
    filters,
    sort: Object.hasOwn(sorts, input.get('sorteer')) ? input.get('sorteer') : 'relevantie',
    page: Number.isInteger(page) && page >= 1 && page * PAGE_SIZE <= MAX_WINDOW ? page - 1 : 0,
  };
  return { state, active: [...input.keys()].some(key => ['q', ...Object.values(params)].includes(key)) };
}
// Uitleg van de zoekactie in gewone taal.
const fieldText = { Alles: 'in alle tekst, namen, plaatsen en adressen', Tekst: 'in de lopende tekst, bijschriften en termen', 'Naam of lemma': 'in de namen van lemma’s en hoofdstukken', Plaats: 'in plaats en gemeente', Adres: 'in de adressen', Rijksmonumentnummer: 'in de gekoppelde rijksmonumentnummers', Exact: 'exact (zonder meervoud, samenstellingen en synoniemen)' };
export function describe({ query = '', field = DEFAULT_FIELD, filters = {}, sort = 'relevantie' }, labels = {}) {
  const lines = [];
  const trimmed = query.trim();
  if (!trimmed) lines.push('Toont alles (geen zoekvraag).');
  else {
    lines.push(`Zoekt ${fieldText[field]} naar: ${trimmed.replace(/\bAND\b/g, 'én').replace(/\bOR\b/g, 'of').replace(/\bNOT\b/g, 'niet')}.`);
    const words = trimmed.replace(/"[^"]*"/g, ' x ').replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length > 1 && !words.some(word => /^(AND|OR|NOT)$/.test(word))) lines.push('Zonder AND/OR/NOT is het genoeg als één van de woorden voorkomt.');
  }
  const label = (key, value) => (key === 'soort' ? soorten[value] : key === 'tekstsoort' ? tekstsoorten[value] : key === 'deel' ? labels[value] ?? value : value);
  const active = Object.entries(filters).filter(([, list]) => list.length);
  if (active.length) lines.push(`Alleen met ${active.map(([key, list]) => `${facets[key].toLowerCase()} ${list.map(v => `“${label(key, v)}”`).join(' of ')}`).join(', en ')}.`);
  lines.push(`Gesorteerd op ${sorts[sort].label.toLowerCase()}.`);
  return lines;
}

export async function search(body, signal, endpoint = ENDPOINT) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, credentials: 'omit' });
  if (!response.ok) {
    const detail = await response.text();
    console.error('Elasticsearch', response.status, detail);
    if (response.status === 503 || /not ready/i.test(detail)) throw new Error('De zoekservice wordt op dit moment bijgewerkt. Probeer het over een paar minuten opnieuw.');
    if (response.status === 400 && /parsing_exception|parse_exception|query_shard_exception/.test(detail)) throw new Error('Controleer je zoeksyntax: gebruik bijvoorbeeld molen AND kerk en sluit quotes en haakjes.');
    throw new Error('De zoekservice kan je vraag nu niet verwerken. Probeer het opnieuw.');
  }
  const result = await response.json();
  if (result.timed_out || result._shards?.failed) throw new Error('De zoekservice gaf een onvolledig antwoord. Probeer het opnieuw.');
  return result;
}
