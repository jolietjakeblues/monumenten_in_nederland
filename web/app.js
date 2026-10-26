// Interface: zoeken met facetten, en lezen per hoofdstuk of plaats. De browser praat rechtstreeks met de
// Elasticsearch-service (CORS staat open). Zoekvragen en hulpfuncties staan in search.js.
import * as S from './search.js';

const { fields, values, first } = S;
const $ = id => document.getElementById(id);

// Alle twaalf delen, ook als ze nog niet in de dataset staan.
const DELEN = [
  ['01', 'Utrecht', 1996], ['02', 'Noord-Brabant', 1997], ['03', 'Overijssel', 1998], ['04', 'Groningen', 1998],
  ['05', 'Gelderland', 2000], ['06', 'Fryslân', 2000], ['07', 'Drenthe', 2001], ['08', 'Limburg', 2003],
  ['09', 'Zeeland', 2003], ['10', 'Zuid-Holland', 2004], ['11', 'Noord-Holland', 2006], ['12', 'Flevoland', 2006],
].map(([nr, provincie, jaar]) => ({ code: `sten009monu${nr}_01`, nr, provincie, jaar }));
// Titel en auteurs per deel uit de dataset, voor de bronregel op de leespagina; gevuld door laadDelen.
const boeken = new Map();
const TERMEN = 'Verklaring van enige termen';
const REGISTERS = ['Topografisch register', 'Register van personen', 'Registers serie', 'Serieregister topografie',
  'Serieregister van architecten en kunstenaars', 'Serieregister categorieën', 'Register op de categorieën'];

// Element maken zonder innerHTML; 'html' alleen voor highlights uit Elasticsearch (zie veiligeHighlight).
function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
  return node;
}
// Highlights zijn door Elasticsearch geëscapet (encoder html); alleen <mark> mag blijven staan.
const veiligeHighlight = fragment => String(fragment).replace(/<(?!\/?mark>)/g, '&lt;');
const deelNaam = uri => DELEN.find(d => S.deelUri(d.code) === uri)?.provincie ?? S.delen(uri)?.deel ?? uri;
const paginas = value => (value ? `p. ${String(value).replace('-', '–')}` : null);
const leesHref = (code, sleutel, anker = '') => `?lees=${code}/${sleutel}${anker ? `#${anker}` : ''}`;
const anker = uri => { const d = S.delen(uri); return d ? ({ passage: `p${d.sleutel}`, afbeelding: `f-${d.sleutel}`, term: `t-${d.sleutel}`, hoofdstuk: `h-${d.sleutel}` }[d.soort] ?? '') : ''; };

// --- toestand -------------------------------------------------------------------------------------------------
let state = { query: '', field: S.DEFAULT_FIELD, filters: {}, page: 0, sort: 'relevantie' };
let aanwezig = new Set();   // deelcodes die in de index staan
let controller = null;
const tocs = new Map();     // deelcode → inhoudsopgave
let getoond = null;         // 'code/sleutel' van de leespagina die nu in beeld is

function toon(modus) {
  $('landing').hidden = modus !== 'start';
  $('workspace').hidden = modus !== 'zoek';
  $('lezen').hidden = modus !== 'lezen';
  $('ingang').hidden = modus !== 'ingang';
  $('explain').hidden = modus !== 'zoek';
  if (modus !== 'lezen') getoond = null;
}
function kruimels(...items) {
  $('crumbs').replaceChildren(h('li', {}, h('a', { href: './', 'data-intern': true, text: 'Demo' })),
    ...items.map((item, i) => h('li', i === items.length - 1 ? { 'aria-current': 'page' } : {}, item.href ? h('a', { href: item.href, 'data-intern': true, text: item.text }) : item.text)));
}
function fout(bericht) { $('error').hidden = !bericht; $('error').textContent = bericht ?? ''; }
function toonQuery(body, uitleg) {
  $('query-json').textContent = JSON.stringify(body, null, 2);
  $('query-explain').replaceChildren(...uitleg.map(regel => h('li', { text: regel })));
}
async function vraag(body) {
  controller?.abort();
  controller = new AbortController();
  return S.search(body, controller.signal);
}

// --- navigatie ------------------------------------------------------------------------------------------------
function navigeer(href, { vervang = false } = {}) {
  const url = new URL(href, location.href);
  history[vervang ? 'replaceState' : 'pushState'](null, '', `${location.pathname}${url.search}${url.hash}`);
  route();
}
document.addEventListener('click', event => {
  const link = event.target.closest('a[data-intern]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigeer(link.getAttribute('href'));
});
window.addEventListener('popstate', route);

async function route() {
  fout(null);
  const p = S.fromParams(location.search);
  if (p.lees) return lezen(p.lees.deel, p.lees.sleutel, decodeURIComponent(location.hash.slice(1)));
  if (p.ingang) return toonIngang(p.ingang);
  if (p.active) { state = p.state; vulFormulier(); return zoek(); }
  toon('start');
  kruimels({ text: 'Zoeken en lezen' });
  $('status').textContent = 'Vul een zoekvraag in, kies een voorbeeld of begin met lezen.';
  vulFormulier();
}

// --- startpagina: de delen ------------------------------------------------------------------------------------
async function laadDelen() {
  // Per deel ook het hoofdstuk 'Steden, dorpen, monumenten': dat nummer verschilt per deel.
  const plaatsen = new Map();
  try {
    const [result, steden] = await Promise.all([S.search(S.delenQuery()), S.search(S.kernenHoofdstukQuery())]);
    aanwezig = new Set(result.hits.hits.map(hit => S.delen(hit._source['@id'])?.deel).filter(Boolean));
    for (const { _source: s } of result.hits.hits) {
      const d = S.delen(s['@id']);
      if (d) boeken.set(d.deel, { naam: first(s[fields.naam]), auteurs: [...values(s[fields.author])] });
    }
    for (const hit of steden.hits.hits) { const d = S.delen(hit._source['@id']); if (d) plaatsen.set(d.deel, d.sleutel); }
  } catch (error) { fout(error.message); }
  // Beschikbare delen als kaart; de rest in één regel.
  const nog = DELEN.filter(d => !aanwezig.has(d.code));
  $('delen').replaceChildren(...DELEN.filter(d => aanwezig.has(d.code)).map(d =>
    h('div', { class: 'deel' }, h('h3', { text: d.provincie }), h('p', { text: `Deel ${Number(d.nr)} · ${d.jaar}` }),
      h('div', { class: 'links' },
        h('a', { href: leesHref(d.code, '0002'), 'data-intern': true, text: 'Lees het boek' }),
        plaatsen.has(d.code) && h('a', { href: leesHref(d.code, plaatsen.get(d.code)), 'data-intern': true, text: 'Plaatsen' }),
        h('a', { href: `?deel=${d.code}&soort=hoofdstuk&sorteer=boek`, 'data-intern': true, text: 'Zoek in dit deel' })))),
  nog.length ? h('p', { class: 'muted nog' }, `Nog niet in de dataset: ${nog.map(d => `${d.provincie} (${d.jaar})`).join(', ')}.`) : null);
}

// --- zoeken ---------------------------------------------------------------------------------------------------
function vulFormulier() {
  $('query').value = state.query;
  $('field').value = state.field;
  $('sort').value = state.sort;
}
function zoekNaar(nieuw) {
  state = { query: '', field: S.DEFAULT_FIELD, filters: {}, page: 0, sort: 'relevantie', ...nieuw };
  navigeer(`?${S.toParams(state)}`);
}
async function zoek() {
  toon('zoek');
  kruimels({ text: 'Zoeken' });
  let body;
  try { body = S.buildQuery(state); } catch (error) { fout(error.message); return; }
  const labels = Object.fromEntries(DELEN.map(d => [S.deelUri(d.code), d.provincie]));
  const uitleg = S.describe(state, labels);
  toonQuery(body, uitleg);
  $('explain').textContent = uitleg.join(' ');
  $('status').textContent = 'Zoeken…';
  $('results').setAttribute('aria-busy', 'true');
  try {
    const result = await vraag(body);
    const hits = result.hits.hits;
    const totaal = result.hits.total?.value ?? hits.length;
    $('status').textContent = totaal === 0 ? 'Niets gevonden.' : `${totaal.toLocaleString('nl-NL')} ${totaal === 1 ? 'resultaat' : 'resultaten'}`;
    $('page-info').textContent = totaal ? `${state.page * S.PAGE_SIZE + 1}–${Math.min(totaal, (state.page + 1) * S.PAGE_SIZE)} van ${totaal.toLocaleString('nl-NL')}` : '';
    // Namen van de hoofdstukken waar afbeeldingen en termen in staan, in één request.
    const ouders = [...new Set(hits.flatMap(hit => [...values(hit._source[fields.isPartOf]), ...values(hit._source[fields.inDefinedTermSet])]).filter(uri => S.soortVan(uri) === 'hoofdstuk'))];
    const namen = new Map();
    if (ouders.length) (await vraag(S.byIdQuery(ouders))).hits.hits.forEach(hit => namen.set(hit._source['@id'], first(hit._source[fields.naam])));
    // Vermeldingen van de registeringangen op deze pagina, in één request.
    const ingangen = hits.map(hit => hit._source['@id']).filter(uri => S.INGANGEN.includes(S.soortVan(uri)));
    const vermeldingen = new Map();
    if (ingangen.length) (await vraag(S.vermeldingenQuery(ingangen))).hits.hits.forEach(hit => {
      const ingang = first(hit._source[fields.vanIngang]);
      if (!vermeldingen.has(ingang)) vermeldingen.set(ingang, []);
      vermeldingen.get(ingang).push(hit._source);
    });
    $('results').replaceChildren(...(hits.length ? hits.map(hit => (S.INGANGEN.includes(S.soortVan(hit._source['@id'])) ? ingangKaart(hit, vermeldingen.get(hit._source['@id']) ?? []) : resultaat(hit, namen))) : [h('p', { class: 'empty', text: 'Geen resultaten. Probeer een ander woord, minder filters of Zoek in: Alles.' })]));
    facetten(result.aggregations ?? {}, labels);
    actieveFilters(labels);
    $('pagination').hidden = totaal <= S.PAGE_SIZE;
    $('previous').disabled = state.page === 0;
    $('next').disabled = (state.page + 1) * S.PAGE_SIZE >= Math.min(totaal, S.MAX_WINDOW);
    $('page-number').textContent = `Pagina ${state.page + 1} van ${Math.ceil(Math.min(totaal, S.MAX_WINDOW) / S.PAGE_SIZE)}`;
  } catch (error) {
    if (error.name === 'AbortError') return;
    fout(error.message);
    $('status').textContent = 'Zoeken mislukt.';
  } finally { $('results').removeAttribute('aria-busy'); }
}

function metadata(rijen) {
  const gevuld = rijen.filter(([, waarde]) => waarde);
  return gevuld.length ? h('dl', { class: 'metadata' }, gevuld.map(([label, waarde]) => h('div', {}, h('dt', { text: label }), h('dd', {}, waarde)))) : null;
}
function monumenten(source) {
  const nummers = [...new Set(values(source[fields.rijksmonumentnummer]))].sort((a, b) => a - b);
  if (!nummers.length) return null;
  return h('div', { class: 'monumenten' }, h('strong', { text: nummers.length === 1 ? 'Rijksmonument' : 'Rijksmonumenten' }),
    nummers.map(nr => h('a', { href: S.registerUrl(nr), target: '_blank', rel: 'noopener noreferrer', title: `Rijksmonument ${nr} in het Monumentenregister`, text: nr })));
}
function plaatsTekst(source) {
  const kern = first(source[fields.kern]);
  if (!kern) return null;
  const toen = first(source[fields.gemeenteInBoek]);
  return toen && toen !== kern ? `${kern} (gemeente ${toen})` : kern;
}
function resultaat(hit, namen) {
  const s = hit._source;
  const uri = s['@id'];
  const soort = S.soortVan(uri);
  const d = S.delen(uri);
  const hl = hit.highlight ?? {};
  // Fragmenten uit de lopende tekst eerst; een treffer in de naam staat al in de titel.
  const fragmenten = [fields.tekst, fields.bijschrift, fields.uitleg, fields.adres].flatMap(key => hl[key] ?? []).slice(0, 3);
  const ouder = first(s[fields.isPartOf]) ?? first(s[fields.inDefinedTermSet]);
  const ouderSleutel = S.delen(ouder)?.sleutel;
  let titel, tekst = null, beeld = null, lees = null, extra = [];

  if (soort === 'passage') {
    titel = first(s[fields.naam]);
    tekst = first(s[fields.tekst]);
    lees = ouderSleutel && leesHref(d.deel, ouderSleutel, anker(uri));
    const eerste = first(s[fields.image]);
    if (eerste) beeld = S.afbeeldingUrl({ '@id': eerste });
    extra = [['Plaats', plaatsTekst(s)], ['Gemeente nu', first(s[fields.gemeente])], ['Hoofdstuk', first(s[fields.hoofdstuk])], ['Pagina', paginas(first(s[fields.pagination]))]];
  } else if (soort === 'hoofdstuk') {
    titel = first(s[fields.naam]);
    lees = leesHref(d.deel, d.sleutel);
    extra = [['Hoofdstuk', first(s[fields.hoofdstuk])], ['Gemeente nu', first(s[fields.gemeente])]];
  } else if (soort === 'afbeelding') {
    titel = first(s[fields.bijschrift]) ?? 'Afbeelding zonder bijschrift';
    beeld = S.afbeeldingUrl(s);
    lees = ouderSleutel && leesHref(d.deel, ouderSleutel, anker(uri));
    extra = [['Hoofdstuk', namen.get(ouder) ?? first(s[fields.hoofdstuk])], ['Pagina', paginas(first(s[fields.pageStart]))]];
  } else if (soort === 'term') {
    titel = first(s[fields.naam]);
    tekst = first(s[fields.uitleg]);
    lees = ouderSleutel && leesHref(d.deel, ouderSleutel, anker(uri));
  }
  const tekstsoort = first(s[fields.soort]);
  return h('article', { class: 'resultaat', 'data-soort': soort },
    beeld && h('img', { class: 'thumb', src: beeld, alt: soort === 'afbeelding' ? titel : '', loading: 'lazy' }),
    h('span', { class: 'badge', text: S.soorten[soort] ?? soort }), tekstsoort && h('span', { class: 'badge', text: S.tekstsoorten[tekstsoort] ?? tekstsoort }),
    h('h3', {}, lees ? h('a', { href: lees, 'data-intern': true, text: titel }) : titel),
    metadata([...extra, ['Deel', d && deelNaam(S.deelUri(d.deel))]]),
    soort === 'afbeelding' ? null // het bijschrift is de titel al
      : fragmenten.length ? h('div', { class: 'match' }, fragmenten.map(f => h('p', { html: `…${veiligeHighlight(f)}…` })))
      : tekst && h('div', { class: 'match' }, h('p', { text: tekst.length > 300 ? `${tekst.slice(0, 300)}…` : tekst })),
    monumenten(s),
    h('div', { class: 'links' },
      lees && h('a', { href: lees, 'data-intern': true, text: soort === 'term' ? 'In de woordenlijst' : 'Lees in het boek' }),
      S.dbnlUrl(first(s[fields.url])) && h('a', { href: S.dbnlUrl(first(s[fields.url])), target: '_blank', rel: 'noopener noreferrer', text: 'Op DBNL' }),
      S.ldUrl(uri) && h('a', { href: S.ldUrl(uri), target: '_blank', rel: 'noopener noreferrer', text: 'Linked data' })));
}

// --- serieregisters ---------------------------------------------------------------------------------------------
const ingangHref = uri => `?ingang=${S.ingangPad(uri)}`;
// Eén vermelding als link: 'ZH 233 Delft'; vet in het register = vet hier, 'pagina' = de naam staat niet letterlijk in de tekst.
function vermeldingLink(v) {
  const href = S.leesLinkVermelding(v);
  const tekst = `${first(v[fields.verwijzing])}${first(v[fields.kern]) ? ` ${first(v[fields.kern])}` : ''}`;
  const zekerheid = first(v[fields.zekerheid]);
  const titel = zekerheid === 'pagina' ? 'De naam staat niet letterlijk in de tekst; link naar de passages op die pagina.' : null;
  const inhoud = first(v[fields.opmaak]) === 'vet' ? h('strong', { text: tekst }) : tekst;
  return href ? h('a', { href, 'data-intern': true, title: titel, class: zekerheid === 'pagina' ? 'pagina' : null }, inhoud) : h('span', { class: 'muted' }, inhoud);
}
function ingangMeta(s) {
  return metadata([
    ['Levensdata', first(s[fields.levensdata])],
    ['Rol', values(s[fields.rol]).join(', ')],
    ['Gemeente (register)', first(s[fields.gemeenteInRegister])],
    ['Provincie', first(s[fields.provincie])],
    ['Categorie', S.soortVan(s['@id']) === 'categorie' ? first(s[fields.categoriepad]) : null],
    ['Register', first(s[fields.register])],
    ['In de delen', values(s[fields.deel]).join(', ')],
  ]);
}
function ingangKaart(hit, vermeldingen) {
  const s = hit._source;
  const uri = s['@id'];
  const soort = S.soortVan(uri);
  const MAX = 8;
  return h('article', { class: 'resultaat', 'data-soort': soort },
    h('span', { class: 'badge', text: S.soorten[soort] }),
    h('h3', {}, h('a', { href: ingangHref(uri), 'data-intern': true, text: first(s[fields.naam]) })),
    ingangMeta(s),
    vermeldingen.length ? h('div', { class: 'vermeldingen' }, h('strong', { text: `${vermeldingen.length} ${vermeldingen.length === 1 ? 'vermelding' : 'vermeldingen'}: ` }),
      vermeldingen.slice(0, MAX).flatMap((v, i) => [i ? ', ' : '', vermeldingLink(v)]),
      vermeldingen.length > MAX ? [' … ', h('a', { href: ingangHref(uri), 'data-intern': true, text: 'alle vermeldingen' })] : null) : null,
    h('div', { class: 'links' },
      h('a', { href: ingangHref(uri), 'data-intern': true, text: 'Alle vermeldingen' }),
      h('a', { href: `https://linkeddata.cultureelerfgoed.nl/rce/monumenten-in-nederland/browser?resource=${encodeURIComponent(uri)}`, target: '_blank', rel: 'noopener noreferrer', text: 'Linked data' })));
}
async function toonIngang(pad) {
  toon('ingang');
  const uri = S.ingangUri(pad);
  $('status').textContent = 'Laden…';
  try {
    const [ingang, verm] = await Promise.all([S.search(S.ingangQuery(uri)), S.search(S.vermeldingenQuery([uri]))]);
    const s = ingang.hits.hits[0]?._source;
    if (!s) { fout('Deze ingang bestaat niet (meer) in de dataset.'); $('status').textContent = ''; return; }
    const soort = S.soortVan(uri);
    const vermeldingen = verm.hits.hits.map(hit => hit._source);
    kruimels({ text: 'Registers' }, { text: S.soorten[soort] }, { text: first(s[fields.naam]) });
    // Categorie: bovenliggende en onderliggende categorieën.
    let boom = [];
    if (soort === 'categorie') {
      const broader = first(s[fields.broader]);
      const [boven, onder] = await Promise.all([broader ? S.search(S.ingangQuery(broader)) : null, S.search(S.smallerQuery(uri))]);
      const b = boven?.hits.hits[0]?._source;
      boom = [
        b && h('p', {}, 'Valt onder: ', h('a', { href: ingangHref(b['@id']), 'data-intern': true, text: first(b[fields.naam]) })),
        onder.hits.hits.length ? h('div', {}, h('h3', { class: 'sectie', text: `Onderverdeling (${onder.hits.hits.length})` }),
          h('ul', { class: 'kernen-lijst' }, onder.hits.hits.map(hit => h('li', {}, h('a', { href: ingangHref(hit._source['@id']), 'data-intern': true, text: first(hit._source[fields.naam]) }),
            h('span', { class: 'toc-gemeente', text: ` (${first(hit._source[fields.aantalVermeldingen]) ?? 0})` }))))) : null,
      ];
    }
    const zie = values(s[fields.zie]);
    $('ingang').replaceChildren(h('article', { class: 'hoofdstuk' },
      h('p', { class: 'pad', text: first(s[fields.register]) }),
      h('h2', { text: first(s[fields.naam]) }),
      first(s[fields.registertekst]) && h('p', { class: 'kop-meta', text: `In het register: ${first(s[fields.registertekst])}` }),
      ingangMeta(s), ...boom,
      zie.length ? h('p', {}, 'Zie ook: ', zie.join(', ')) : null,
      h('h3', { class: 'sectie', text: `Vermeldingen (${vermeldingen.length})` }),
      vermeldingen.length ? h('p', { class: 'hint', text: 'Vet: in het register vet gedrukt (de plaats waar het uitgebreid aan bod komt, of een lemma). Gestippeld: de naam staat niet letterlijk in de tekst van die pagina.' }) : h('p', { class: 'empty', text: 'Geen vermeldingen.' }),
      ...S.perDeel(vermeldingen).map(([deel, lijst]) => h('div', { class: 'vermeldingen-deel' },
        h('h4', { text: `${deelNaam(deel)} (${lijst.length})` }),
        h('p', { class: 'vermeldingen' }, lijst.flatMap((v, i) => [i ? ', ' : '', vermeldingLink(v)])))),
      h('div', { class: 'links' }, h('a', { href: `https://linkeddata.cultureelerfgoed.nl/rce/monumenten-in-nederland/browser?resource=${encodeURIComponent(uri)}`, target: '_blank', rel: 'noopener noreferrer', text: 'Linked data' }))));
    toonQuery(S.vermeldingenQuery([uri]), [`Alle vermeldingen van “${first(s[fields.naam])}”, per deel en op pagina.`]);
    $('status').textContent = `${S.soorten[soort]}: ${vermeldingen.length} ${vermeldingen.length === 1 ? 'vermelding' : 'vermeldingen'}`;
    $('ingang').scrollIntoView({ block: 'start' });
  } catch (error) { if (error.name !== 'AbortError') fout(error.message); }
}

function facetten(aggs, labels) {
  const label = (key, value) => (key === 'soort' ? S.soorten[value] : key === 'tekstsoort' ? S.tekstsoorten[value] : key === 'deel' ? labels[value] ?? deelNaam(value) : value) ?? value;
  const blokken = Object.entries(S.facets).map(([key, titel]) => {
    const buckets = S.bucketsOf(aggs[key]);
    const gekozen = state.filters[key] ?? [];
    // Gekozen waarden blijven zichtbaar, ook als ze nu 0 treffers hebben.
    const lijst = [...buckets, ...gekozen.filter(v => !buckets.some(b => b.key === v)).map(v => ({ key: v, doc_count: 0 }))];
    if (!lijst.length) return null;
    return h('details', { open: gekozen.length || ['deel', 'soort', 'tekstsoort'].includes(key) },
      h('summary', { text: titel }),
      h('ul', { class: 'facet-list' }, lijst.map(b => h('li', {}, h('label', { class: 'facet-option' },
        h('input', { type: 'checkbox', checked: gekozen.includes(b.key), onchange: event => {
          const nu = new Set(state.filters[key] ?? []);
          event.target.checked ? nu.add(b.key) : nu.delete(b.key);
          zoekNaar({ ...state, filters: { ...state.filters, [key]: [...nu] }, page: 0 });
        } }),
        h('span', { class: 'facet-name', 'data-soort': key === 'soort' ? b.key : null, text: label(key, b.key) }),
        h('span', { class: 'facet-count', text: b.doc_count.toLocaleString('nl-NL') }))))));
  }).filter(Boolean);
  $('facets').replaceChildren(...(blokken.length ? blokken : [h('p', { class: 'muted', text: 'Geen filters voor deze resultaten.' })]));
}
function actieveFilters(labels) {
  const chips = Object.entries(state.filters).flatMap(([key, list]) => list.map(value => h('button', { type: 'button', title: 'Verwijder dit filter', onclick: () => {
    zoekNaar({ ...state, filters: { ...state.filters, [key]: list.filter(v => v !== value) }, page: 0 });
  }, text: `${S.facets[key]}: ${key === 'deel' ? labels[value] ?? value : key === 'soort' ? S.soorten[value] : key === 'tekstsoort' ? S.tekstsoorten[value] : value} ×` })));
  if (chips.length) chips.push(h('button', { type: 'button', onclick: () => zoekNaar({ ...state, filters: {}, page: 0 }), text: 'Alle filters wissen' }));
  $('active-filters').replaceChildren(...chips);
}

// --- lezen ----------------------------------------------------------------------------------------------------
async function inhoud(code) {
  if (!tocs.has(code)) tocs.set(code, S.buildToc((await S.search(S.tocQuery(code))).hits.hits));
  return tocs.get(code);
}
function tocLink(code, node, huidig) {
  return h('a', { href: leesHref(code, node.sleutel), 'data-intern': true, 'aria-current': node === huidig ? 'page' : null, 'data-zoek': `${node.naam} ${node.gemeente ?? ''}`.toLowerCase() },
    node.kern ?? node.naam, node.isKern && node.gemeenteInBoek && node.gemeenteInBoek !== node.kern ? h('span', { class: 'toc-gemeente', text: ` (${node.gemeenteInBoek})` }) : null);
}
function tekenToc(code, toc, huidig) {
  const lijst = nodes => h('ul', {}, nodes.map(node => {
    const kernen = node.kinderen.filter(k => k.isKern);
    if (kernen.length) {
      return h('li', {}, h('details', { open: true }, h('summary', {}, tocLink(code, node, huidig), h('span', { class: 'toc-gemeente', text: ` · ${kernen.length} plaatsen` })), lijst(node.kinderen)));
    }
    return h('li', {}, tocLink(code, node, huidig), node.kinderen.length && !node.isKern ? lijst(node.kinderen) : null);
  }));
  const deel = DELEN.find(d => d.code === code);
  $('toc').replaceChildren(h('div', { class: 'toc-deel', text: deel ? `${deel.provincie} (${deel.jaar})` : code }), lijst(toc.top));
  filterToc();
}
function filterToc() {
  const term = $('toc-filter').value.trim().toLowerCase();
  for (const a of $('toc').querySelectorAll('a[data-zoek]')) a.closest('li').hidden = Boolean(term) && !a.dataset.zoek.includes(term) && !a.closest('li').querySelector(`a[data-zoek*="${CSS.escape(term)}"]`);
}
$('toc-filter').addEventListener('input', filterToc);

function figuur(a) {
  const bijschrift = first(a[fields.bijschrift]);
  const src = S.afbeeldingUrl(a);
  return h('figure', { class: 'figuur', id: anker(a['@id']) },
    src && h('img', { src, alt: bijschrift ?? '', loading: 'lazy' }),
    h('figcaption', {}, bijschrift ?? '', first(a[fields.pageStart]) && h('span', { text: `${bijschrift ? ' · ' : ''}p. ${first(a[fields.pageStart])}` })));
}
// Registeringangen die naar een passage verwijzen: 'In de registers: P.J.H. Cuypers, Kasteel Doorwerth'.
function inRegisters(ingangen) {
  if (!ingangen?.length) return null;
  const MAX = 12;
  return h('p', { class: 'in-registers' }, h('span', { text: 'In de registers: ' }),
    ingangen.slice(0, MAX).flatMap(([uri, naam], i) => [i ? ', ' : '', h('a', { href: ingangHref(uri), 'data-intern': true, 'data-soort': S.soortVan(uri), text: naam })]),
    ingangen.length > MAX ? ` en ${ingangen.length - MAX} meer` : null);
}
function passageBlok(p, registers) {
  const tekst = first(p[fields.tekst]) ?? '';
  const soort = first(p[fields.soort]);
  const delenTekst = soort === 'literatuur'
    ? [h('ul', { class: 'literatuur' }, tekst.split('\n').map(regel => h('li', { text: regel })))]
    : tekst.split('\n\n').map((alinea, i) => {
      const [vet, rest] = i === 0 && soort === 'lemma' ? S.lemmaBegin(alinea, first(p[fields.lemma])) : [null, alinea];
      return h('p', {}, vet && h('strong', { text: vet }), rest);
    });
  return h('div', { class: 'passage', id: anker(p['@id']) },
    first(p[fields.pagination]) && h('span', { class: 'paginas', text: paginas(first(p[fields.pagination])) }),
    delenTekst, monumenten(p), inRegisters(registers?.get(p['@id'])));
}
async function lezen(code, sleutel, hash) {
  toon('lezen');
  $('status').textContent = 'Laden…';
  let toc;
  try { toc = await inhoud(code); } catch (error) { fout(error.message); return; }
  const node = toc.nodes.get(S.hoofdstukUri(code, sleutel));
  const deel = DELEN.find(d => d.code === code);
  if (!node) { fout('Dit hoofdstuk bestaat niet (meer) in de dataset.'); $('status').textContent = ''; return; }
  const pagina = S.leespaginaVan(node);
  // Een sectie staat op de pagina van zijn hoofdstuk: daar naartoe, met de sectie als anker.
  if (pagina !== node) return navigeer(leesHref(code, pagina.sleutel, hash || `h-${node.sleutel}`), { vervang: true });
  kruimels({ text: 'Lezen', href: leesHref(code, toc.top.find(n => n.naam !== 'Voorwerk')?.sleutel ?? sleutel) }, { text: deel?.provincie ?? code, href: leesHref(code, '0002') }, { text: node.kern ?? node.naam });
  const sleutelNu = `${code}/${pagina.sleutel}`;
  if (getoond !== sleutelNu) {
    tekenToc(code, toc, pagina);
    try { await tekenHoofdstuk(code, toc, pagina); } catch (error) { if (error.name !== 'AbortError') fout(error.message); return; }
    getoond = sleutelNu;
  }
  // Naar het anker, of naar het begin van het hoofdstuk.
  // De inhoudsopgave scrolt alleen binnen haar eigen kader, anders trekt ze de pagina mee.
  const huidig = $('toc').querySelector('[aria-current=page]');
  if (huidig) $('toc').scrollTop = Math.max(0, huidig.offsetTop - $('toc').offsetTop - 80);
  document.querySelectorAll('.passage.gekozen').forEach(el => el.classList.remove('gekozen'));
  const doel = hash && document.getElementById(hash);
  if (doel) { doel.classList.add('gekozen'); doel.scrollIntoView({ block: 'start' }); } else $('lezen').scrollIntoView({ block: 'start' });
}
// Bronvermelding zoals DBNL die vraagt, met de gebruiksvoorwaarden van het deel.
function bronregel(code) {
  const deel = DELEN.find(d => d.code === code);
  const boek = boeken.get(code);
  const url = S.gebruiksvoorwaardenUrl(code);
  return h('p', { class: 'bron' }, 'Bron: ', h('em', { text: boek?.naam ?? `Monumenten in Nederland. ${deel?.provincie ?? code}` }),
    deel ? ` (${deel.jaar})` : '', boek?.auteurs.length ? `, ${S.namenLijst(boek.auteurs)}` : '',
    ', geraadpleegd via DBNL (KB, nationale bibliotheek).',
    url && ' ', url && h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Auteursrecht en gebruiksvoorwaarden' }));
}
async function tekenHoofdstuk(code, toc, pagina) {
  await delenGeladen;
  const kop = [
    pagina.ouderNode && h('p', { class: 'pad', text: [...(function* pad(n) { if (n.ouderNode) yield* pad(n.ouderNode); yield n.naam; })(pagina.ouderNode)].join(' › ') }),
    h('h2', { text: pagina.kern ?? pagina.naam }),
    h('p', { class: 'kop-meta' },
      pagina.isKern ? `Gemeente in het boek: ${pagina.gemeenteInBoek ?? pagina.kern}${pagina.gemeente ? ` · nu: ${pagina.gemeente}` : ''} · ` : '',
      S.dbnlUrl(pagina.url) && h('a', { href: S.dbnlUrl(pagina.url), target: '_blank', rel: 'noopener noreferrer', text: 'Deze pagina op DBNL' })),
    bronregel(code),
  ];
  const { vorige, volgende } = S.buren(toc, pagina);
  const navigatie = h('nav', { class: 'navigatie', 'aria-label': 'Vorige en volgende' },
    vorige ? h('a', { href: leesHref(code, vorige.sleutel), 'data-intern': true, text: `← ${vorige.kern ?? vorige.naam}` }) : h('span'),
    volgende ? h('a', { href: leesHref(code, volgende.sleutel), 'data-intern': true, text: `${volgende.kern ?? volgende.naam} →` }) : h('span'));

  let inhoudBlokken = [];
  let telling = '';
  if (pagina.naam.toLowerCase() === TERMEN.toLowerCase()) { // Noord-Holland: '… Termen'
    const body = S.termenQuery(pagina.uri);
    toonQuery(body, ['Alle termen uit de verklarende woordenlijst van dit deel, op alfabet.']);
    const hits = (await vraag(body)).hits.hits;
    inhoudBlokken = [h('dl', { class: 'termen' }, hits.map(hit => h('div', { id: anker(hit._source['@id']) }, h('dt', { text: first(hit._source[fields.naam]) }), h('dd', { text: first(hit._source[fields.uitleg]) }))))];
    telling = `${hits.length} termen`;
  } else if (REGISTERS.includes(pagina.naam) && pagina.deel === 'sten009monu12_01' && pagina.naam !== 'Topografisch register' && pagina.naam !== 'Register van personen') {
    // De serieregisters staan als gestructureerde data in de dataset (graph registers).
    const zoek = soort => `?soort=${soort}&sorteer=relevantie`;
    inhoudBlokken = [h('p', {}, 'De registers van de hele serie staan als gestructureerde data in de dataset: elke naam, plaats, kasteel of categorie is een eigen ingang, met links naar de passages in alle twaalf delen.'),
      h('ul', {}, [['persoon', 'Architecten en kunstenaars'], ['plaats', 'Plaatsen'], ['object', 'Kastelen, buitenplaatsen en (land)huizen'], ['categorie', 'Categorieën']]
        .map(([soort, tekst]) => h('li', {}, h('a', { href: zoek(soort), 'data-intern': true, text: tekst })))),
      h('p', {}, 'Zoek op een naam met ', h('strong', { text: 'Zoek in: Register' }), ', of bekijk ', S.dbnlUrl(pagina.url) ? h('a', { href: S.dbnlUrl(pagina.url), target: '_blank', rel: 'noopener noreferrer', text: 'het register op DBNL' }) : 'het register op DBNL', '.')];
  } else if (REGISTERS.includes(pagina.naam)) {
    inhoudBlokken = [h('p', {},'De registers staan niet als tekst in de dataset: het zijn lijsten met paginanummers. Zoek hierboven op een plaats of naam, of bekijk ', S.dbnlUrl(pagina.url) ? h('a', { href: S.dbnlUrl(pagina.url), target: '_blank', rel: 'noopener noreferrer', text: 'het register op DBNL' }) : 'het register op DBNL', '.')];
  } else {
    const uris = S.leesUris(pagina);
    const body = S.passagesQuery(uris);
    toonQuery(body, [`Alle tekst van “${pagina.naam}”${uris.length > 1 ? ` en de ${uris.length - 1} secties erin` : ''}, in de volgorde van het boek (min:volgnummer).`]);
    const [tekst, beelden] = await Promise.all([vraag(body), S.search(S.afbeeldingenQuery(uris))]);
    const passages = tekst.hits.hits.map(hit => hit._source);
    // Welke registeringangen naar deze passages verwijzen; per passage op naam, zonder dubbele.
    const registers = new Map();
    if (passages.length) {
      const verm = await S.search(S.vermeldingenOpPassagesQuery(passages.map(p => p['@id'])));
      for (const { _source: v } of verm.hits.hits) {
        for (const p of values(v[fields.passage])) {
          if (!registers.has(p)) registers.set(p, new Map());
          registers.get(p).set(first(v[fields.vanIngang]), first(v[fields.ingangNaam]));
        }
      }
      for (const [p, m] of registers) registers.set(p, [...m].sort((a, b) => a[1].localeCompare(b[1], 'nl')));
    }
    const { blokken, achteraan } = S.plaatsAfbeeldingen(passages, beelden.hits.hits.map(hit => hit._source));
    // Kop per sectie, op het moment dat de eerste tekst van die sectie langskomt.
    const gehad = new Set([pagina.uri]);
    const koppen = uri => {
      const node = toc.nodes.get(uri);
      if (!node || gehad.has(uri)) return [];
      gehad.add(uri);
      let diepte = 0;
      for (let n = node; n && n !== pagina; n = n.ouderNode) diepte++;
      return [...koppen(node.ouder), h(diepte > 1 ? 'h4' : 'h3', { class: 'sectie', id: anker(uri), text: node.naam })];
    };
    for (const b of blokken) inhoudBlokken.push(...koppen(first(b.passage[fields.isPartOf])), ...b.ervoor.map(figuur), passageBlok(b.passage, registers), ...b.afbeeldingen.map(figuur));
    inhoudBlokken.push(...achteraan.map(figuur));
    const kernen = pagina.kinderen.filter(k => k.isKern);
    if (kernen.length) inhoudBlokken.push(h('h3', { class: 'sectie', text: `Plaatsen (${kernen.length})` }), h('ul', { class: 'kernen-lijst' }, kernen.map(k => h('li', {}, tocLink(code, k, null)))));
    telling = `${passages.length} ${passages.length === 1 ? 'tekstdeel' : 'tekstdelen'}, ${beelden.hits.hits.length} ${beelden.hits.hits.length === 1 ? 'afbeelding' : 'afbeeldingen'}`;
    if (!passages.length && !kernen.length) inhoudBlokken.push(h('p', { class: 'empty', text: 'Bij dit hoofdstuk staat geen tekst in de dataset.' }));
  }
  $('hoofdstuk').replaceChildren(...kop.filter(Boolean), ...inhoudBlokken, navigatie);
  $('status').textContent = `${pagina.kern ?? pagina.naam}${telling ? `: ${telling}` : ''}`;
}

// --- formulier en knoppen -------------------------------------------------------------------------------------
$('field').replaceChildren(...Object.keys(S.searchFields).map(key => h('option', { value: key, text: key })));
$('sort').replaceChildren(...Object.entries(S.sorts).map(([key, { label }]) => h('option', { value: key, text: label })));
$('search-form').addEventListener('submit', event => {
  event.preventDefault();
  zoekNaar({ ...state, query: $('query').value, field: $('field').value, page: 0 });
});
$('sort').addEventListener('change', () => zoekNaar({ ...state, sort: $('sort').value, page: 0 }));
$('previous').addEventListener('click', () => zoekNaar({ ...state, page: state.page - 1 }));
$('next').addEventListener('click', () => zoekNaar({ ...state, page: state.page + 1 }));
$('reset').addEventListener('click', () => { state = { query: '', field: S.DEFAULT_FIELD, filters: {}, page: 0, sort: 'relevantie' }; navigeer('./'); });
$('share').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); $('share').textContent = 'Link gekopieerd'; } catch { $('share').textContent = 'Kopiëren lukte niet'; }
  setTimeout(() => { $('share').textContent = 'Kopieer link'; }, 2000);
});
document.addEventListener('click', event => {
  const knop = event.target.closest('button[data-example], button[data-lees]');
  if (!knop) return;
  if ($('help').open) $('help').close();
  if (knop.dataset.lees) return navigeer(`?lees=${knop.dataset.lees}`);
  const filters = knop.dataset.tekstsoort ? { tekstsoort: [knop.dataset.tekstsoort] } : {};
  zoekNaar({ query: knop.dataset.example, field: knop.dataset.veld ?? S.DEFAULT_FIELD, filters });
});
$('help-open').addEventListener('click', () => $('help').showModal());
$('help-close').addEventListener('click', () => $('help').close());
document.querySelectorAll('[data-help]').forEach(knop => knop.addEventListener('click', () => {
  $('help').showModal();
  document.getElementById(`help-${knop.dataset.help}`)?.scrollIntoView({ block: 'start' });
}));

const delenGeladen = laadDelen();
route();
