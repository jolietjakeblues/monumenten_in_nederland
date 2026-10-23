// Controleert de echte service monumenten-in-nederland. Gebruik: npm run test:live
import { ENDPOINT, buildQuery, tocQuery, buildToc, passagesQuery, leesUris, hoofdstukUri, fields, delenQuery } from '../web/search.js';

let fouten = 0;
const ok = (gelukt, tekst) => { console.log(`${gelukt ? 'ok  ' : 'FOUT'}  ${tekst}`); if (!gelukt) fouten++; };
async function es(body, headers = {}) {
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { res, json: await res.json() };
}

const cors = await es({ size: 0 }, { Origin: 'https://voorbeeld.workers.dev' });
ok(cors.res.headers.get('access-control-allow-origin') === '*', 'CORS staat open');

const soorten = await es({ size: 0, aggs: { s: { terms: { field: '@id.soort', size: 20 } } } });
const telling = Object.fromEntries(soorten.json.aggregations.s.buckets.map(b => [b.key, b.doc_count]));
ok(telling.passage > 0 && telling.hoofdstuk > 0 && telling.afbeelding > 0 && telling.term > 0, `soorten via @id.soort: ${JSON.stringify(telling)}`);

const delen = (await es(delenQuery())).json.hits.hits.map(h => h._source['@id'].split('/').pop());
ok(delen.includes('sten009monu10_01'), `delen in de index: ${delen.join(', ')}`);

const molen = (await es(buildQuery({ query: 'molens' }))).json;
ok(molen.hits.total.value > 100, `"molens" vindt ${molen.hits.total.value} (meervoud en samenstellingen)`);
const kapel = (await es(buildQuery({ query: 'kapel', field: 'Tekst' }))).json;
ok(!JSON.stringify(kapel.hits.hits.map(h => h.highlight)).toLowerCase().includes('<mark>dakkapel'), '"kapel" markeert geen dakkapel');

const nummer = (await es(buildQuery({ query: '11985', field: 'Rijksmonumentnummer' }))).json;
ok(nummer.hits.total.value >= 1, `rijksmonumentnummer 11985 vindt ${nummer.hits.total.value} passage(s)`);

const toc = buildToc((await es(tocQuery('sten009monu10_01'))).json.hits.hits);
const steden = toc.top.find(n => n.naam === 'Steden, dorpen, monumenten');
ok(steden && steden.kinderen.filter(k => k.isKern).length === 187, `187 plaatsen onder Steden, dorpen, monumenten (${steden?.kinderen.length})`);
const delft = toc.nodes.get(hoofdstukUri('sten009monu10_01', '0030'));
const tekst = (await es(passagesQuery(leesUris(delft)))).json.hits.hits.map(h => Number(h._source[fields.volgnummer][0]));
ok(tekst.length > 30 && tekst.every((n, i) => i === 0 || n > tekst[i - 1]), `Delft: ${tekst.length} tekstdelen op volgorde`);

console.log(fouten ? `\n${fouten} fout(en)` : '\nAlles gelukt.');
process.exit(fouten ? 1 : 0);
