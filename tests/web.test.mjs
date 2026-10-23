// Unit-tests voor web/search.js, zonder netwerk. Gebruik: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuery, fields, soorten, soortVan, delen, deelUri, hoofdstukUri, queryFields, WEIGHT, toParams, fromParams, describe,
  buildToc, leesUris, buren, leespaginaVan, plaatsAfbeeldingen, lemmaBegin, afbeeldingUrl, registerUrl, dbnlUrl, veiligeZoekvraag,
  tocQuery, passagesQuery, KERN_TYPE, ID,
  INGANGEN, ingangUri, ingangPad, leesLinkVermelding, perDeel, vermeldingenQuery, vermeldingenOpPassagesQuery, smallerQuery,
} from '../web/search.js';

const D = 'sten009monu10_01';
test('Zoeken (query) en filteren (post_filter) blijven gescheiden; alleen doorzoekbare soorten', () => {
  const body = buildQuery({ query: 'kasteel AND gracht', filters: { kern: ['Delft', 'Leiden'], soort: ['passage'] }, page: 1 });
  assert.equal(body.query.bool.must[0].query_string.query, 'kasteel AND gracht');
  assert.deepEqual(body.query.bool.filter, [{ terms: { '@id.soort': Object.keys(soorten) } }]);
  assert.deepEqual(body.post_filter.bool.filter, [{ terms: { [`${fields.kern}.keyword`]: ['Delft', 'Leiden'] } }, { terms: { '@id.soort': ['passage'] } }]);
  assert.deepEqual(body.aggs.kern.filter.bool.filter, [{ terms: { '@id.soort': ['passage'] } }]);
  assert.deepEqual(body.aggs.deel.aggs.values.terms.field, fields.inDeel);
  assert.equal(body.from, 20);
  assert.deepEqual(buildQuery().query.bool.must[0], { match_all: {} });
  assert.throws(() => buildQuery({ filters: { soort: ['deel'] } }), /filter/);
  assert.throws(() => buildQuery({ filters: { tekstsoort: ['x'] } }), /filter/);
  assert.throws(() => buildQuery({ field: 'x' }), /zoekveld/);
});
test('Weging en highlights', () => {
  assert.ok(queryFields('Alles').includes(`${fields.lemma}^${WEIGHT}`));
  assert.ok(queryFields('Exact').includes(`${fields.naam}.exact^${WEIGHT}`));
  assert.deepEqual(queryFields('Adres'), [fields.adres]);
  assert.ok(fields.tekst in buildQuery({ query: 'x' }).highlight.fields);
  assert.deepEqual(Object.keys(buildQuery({ query: 'x', field: 'Adres' }).highlight.fields), [fields.adres]);
  assert.equal(veiligeZoekvraag('greppel/sloot'), 'greppel\\/sloot');
});
test('Soort en delen uit de URI', () => {
  assert.equal(soortVan(`${ID}${D}/passage/00451`), 'passage');
  assert.equal(soortVan(`${ID}${D}/hoofdstuk/0004-02`), 'hoofdstuk');
  assert.equal(soortVan(`${ID}${D}`), 'deel');
  assert.equal(soortVan(`${ID}serie`), null);
  assert.deepEqual(delen(`${ID}${D}/afbeelding/sten009monu10ill138`), { deel: D, soort: 'afbeelding', sleutel: 'sten009monu10ill138' });
  assert.equal(hoofdstukUri(D, '0030'), `${ID}${D}/hoofdstuk/0030`);
});
test('URL heen en terug; lezen apart', () => {
  const state = { query: 'molen', field: 'Tekst', filters: { deel: [deelUri(D)], kern: ['Delft'] }, page: 2, sort: 'boek' };
  const params = toParams(state);
  assert.equal(params.toString(), 'q=molen&veld=Tekst&deel=sten009monu10_01&kern=Delft&sorteer=boek&pagina=3');
  assert.deepEqual(fromParams(params).state, state);
  assert.deepEqual(fromParams('?lees=sten009monu10_01/0004-02').lees, { deel: D, sleutel: '0004-02' });
  assert.equal(fromParams('?lees=../x').lees, undefined);
  assert.equal(fromParams('?soort=deel&veld=x').state.filters.soort, undefined);
  assert.equal(fromParams('?veld=x').state.field, 'Alles');
  assert.ok(describe(state, { [deelUri(D)]: 'Zuid-Holland' }).some(r => r.includes('“Zuid-Holland”')));
});

// Kleine inhoudsopgave: Historie met twee secties, Steden met twee kernen (de eerste genest, zoals in de bron).
const H = (sleutel, naam, ouder, kern = false) => ({ _source: { '@id': hoofdstukUri(D, sleutel), [fields.naam]: [naam], [fields.isPartOf]: [ouder], [fields.type]: kern ? [KERN_TYPE] : [] } });
const toc = buildToc([
  H('0009', 'Abbenbroek', hoofdstukUri(D, '0008'), true), H('0004', 'Historie', deelUri(D)), H('0004-02', 'Veel volkeren', hoofdstukUri(D, '0004')),
  H('0004-01', 'Romeinen', hoofdstukUri(D, '0004')), H('0008', 'Steden, dorpen, monumenten', deelUri(D)), H('0008-01', 'Aarlanderveen', hoofdstukUri(D, '0008'), true),
]);
test('Inhoudsopgave in boekvolgorde; kernen onder Steden', () => {
  assert.deepEqual(toc.lijst.map(n => n.sleutel), ['0004', '0004-01', '0004-02', '0008', '0008-01', '0009']);
  const steden = toc.nodes.get(hoofdstukUri(D, '0008'));
  assert.deepEqual(steden.kinderen.map(n => n.naam), ['Aarlanderveen', 'Abbenbroek']);
  assert.deepEqual(leesUris(steden), [steden.uri]);
  assert.equal(leesUris(toc.nodes.get(hoofdstukUri(D, '0004'))).length, 3);
  assert.equal(leespaginaVan(toc.nodes.get(hoofdstukUri(D, '0004-02'))).sleutel, '0004');
  const aarl = toc.nodes.get(hoofdstukUri(D, '0008-01'));
  assert.equal(leespaginaVan(aarl), aarl);
  assert.deepEqual([buren(toc, aarl).vorige.sleutel, buren(toc, aarl).volgende.sleutel], ['0008', '0009']);
  assert.ok(tocQuery(D).query.bool.should.length === 2);
  assert.deepEqual(passagesQuery(['a']).sort, [{ [fields.volgnummer]: { order: 'asc' } }]);
});
test('Afbeeldingen bij passages; losse afbeeldingen vóór de eerste latere pagina', () => {
  const P = (n, pagina, beelden = []) => ({ '@id': `${ID}${D}/passage/${n}`, [fields.pageStart]: [pagina], [fields.image]: beelden });
  const A = (ill, pagina) => ({ '@id': `${ID}${D}/afbeelding/sten009monu10ill${ill}`, [fields.pageStart]: [pagina] });
  const a = [A(9, '10'), A(10, '11'), A(12, '13'), A(13, 'schutblad')];
  const { blokken, achteraan } = plaatsAfbeeldingen([P('1', '10', [a[1]['@id']]), P('2', '12'), P('3', '14')], a);
  assert.deepEqual(blokken[0].afbeeldingen, [a[1]]);
  assert.deepEqual(blokken[1].ervoor, [a[0]]);
  assert.deepEqual(blokken[2].ervoor, [a[2]]);
  assert.deepEqual(achteraan, [a[3]]);
});
test('Lemmanaam vet, links alleen naar bekende plekken', () => {
  assert.deepEqual(lemmaBegin('Herv. kerk (Hof 16), oorspronkelijk', 'Herv. kerk'), ['Herv. kerk', ' (Hof 16), oorspronkelijk']);
  assert.deepEqual(lemmaBegin('Tekst', 'Anders'), [null, 'Tekst']);
  assert.equal(afbeeldingUrl({ '@id': `${ID}${D}/afbeelding/sten009monu10ill138` }), 'https://www.dbnl.org/tekst/sten009monu10_01/sten009monu10ill138.gif');
  assert.equal(afbeeldingUrl({ [fields.contentUrl]: ['https://evil.example/x.gif'] }), null);
  assert.equal(registerUrl('13481'), 'https://monumentenregister.cultureelerfgoed.nl/monumenten/13481');
  assert.equal(registerUrl('1; x'), null);
  assert.equal(dbnlUrl('javascript:alert(1)'), null);
});

test('Serieregisters: ingangen zijn doorzoekbaar, vermeldingen en lijsten niet', () => {
  for (const soort of INGANGEN) assert.ok(Object.hasOwn(soorten, soort), soort);
  const zoekbaar = buildQuery({ query: 'Cuypers', field: 'Register' }).query.bool.filter[0].terms['@id.soort'];
  assert.ok(zoekbaar.includes('persoon') && !zoekbaar.includes('vermelding') && !zoekbaar.includes('lijst'));
  assert.deepEqual(buildQuery({ query: 'x', field: 'Register' }).query.bool.must[0].query_string.fields, [fields.registernaam, fields.naam, fields.rol, fields.categoriepad]);
  assert.ok('rol' in buildQuery().aggs);
  const uri = ingangUri('persoon/cuypers-p-j-h-1827-1921');
  assert.equal(soortVan(uri), 'persoon');
  assert.equal(soortVan(ingangUri('vermelding/000001')), 'vermelding');
  assert.equal(ingangPad(uri), 'persoon/cuypers-p-j-h-1827-1921');
  assert.equal(ingangPad(`${ID}${D}/passage/00001`), null);
});
test('Serieregisters: URL, leeslink en groepering per deel', () => {
  assert.deepEqual(fromParams('?ingang=persoon/cuypers-p-j-h-1827-1921'), { ingang: 'persoon/cuypers-p-j-h-1827-1921' });
  assert.equal(fromParams('?ingang=vermelding/1').ingang, undefined);
  assert.equal(fromParams('?ingang=persoon/../x').ingang, undefined);
  const v = { [fields.inHoofdstuk]: [hoofdstukUri(D, '0030')], [fields.passage]: [`${ID}${D}/passage/00451`, `${ID}${D}/passage/00452`] };
  assert.equal(leesLinkVermelding(v), `?lees=${D}/0030#p00451`);
  assert.equal(leesLinkVermelding({}), null);
  const groepen = perDeel([{ [fields.inDeel]: [deelUri('sten009monu10_01')] }, { [fields.inDeel]: [deelUri('sten009monu01_01')] }, { [fields.inDeel]: [deelUri('sten009monu10_01')] }]);
  assert.deepEqual(groepen.map(([deel, lijst]) => [deel.slice(-16), lijst.length]), [['sten009monu01_01', 1], ['sten009monu10_01', 2]]);
  assert.deepEqual(vermeldingenQuery(['a']).query.bool.filter[1], { terms: { [fields.vanIngang]: ['a'] } });
  assert.deepEqual(vermeldingenOpPassagesQuery(['p']).query.bool.filter[1], { terms: { [fields.passage]: ['p'] } });
  assert.deepEqual(smallerQuery('c').query, { term: { [fields.broader]: 'c' } });
});
test('Geen ontbrekende velden in de queries (undefined wordt null in JSON)', () => {
  const zonderNull = body => !JSON.stringify(body).includes('null') && !JSON.stringify(body).includes('undefined');
  for (const body of [buildQuery({ query: 'x' }), vermeldingenQuery(['a']), vermeldingenOpPassagesQuery(['p']), smallerQuery('c'), tocQuery(D), passagesQuery(['a'])]) assert.ok(zonderNull(body), JSON.stringify(body).slice(0, 200));
});
