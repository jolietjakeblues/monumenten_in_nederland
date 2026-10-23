# Monumenten in Nederland → linked data

Omzetting van de twaalfdelige serie *Monumenten in Nederland* (RDMZ/Waanders,
1996–2006, digitale editie DBNL) naar TriG voor de dataset
`rce/monumenten-in-nederland` in de linked-datavoorziening van de RCE.
Elk deel is één provincie en komt in een eigen named graph:

    https://linkeddata.cultureelerfgoed.nl/rce/monumenten-in-nederland/graphs/<provincie>

## Indeling

```
data/
  bron/       de twaalf DBNL-TEI-bestanden (sten009monuNN_01.xml), ongewijzigd
  cache/      antwoorden van Elastic en de DBNL-inhoudsopgaven (mag weg)
elastic/      configuratie voor de Elasticsearch-service
output/       gegenereerde TriG en koppelings-CSV per provincie
scripts/      converteer.py
web/          de voorkant (zoeken en lezen), zie "Website"
tests/        tests van de voorkant (npm test, npm run test:live)
server.mjs    lokale server voor web/
```

## Delen

| Nr | Bronbestand | Provincie |
|---|---|---|
| 01 | `sten009monu01_01.xml` | Utrecht |
| 02 | `sten009monu02_01.xml` | Noord-Brabant |
| 03 | `sten009monu03_01.xml` | Overijssel |
| 04 | `sten009monu04_01.xml` | Groningen |
| 05 | `sten009monu05_01.xml` | Gelderland |
| 06 | `sten009monu06_01.xml` | Fryslân |
| 07 | `sten009monu07_01.xml` | Drenthe |
| 08 | `sten009monu08_01.xml` | Limburg |
| 09 | `sten009monu09_01.xml` | Zeeland |
| 10 | `sten009monu10_01.xml` | Zuid-Holland |
| 11 | `sten009monu11_01.xml` | Noord-Holland |
| 12 | `sten009monu12_01.xml` | Flevoland |

De bronbestanden zijn de XML-downloads van DBNL. Ze staan niet in git
(`.gitignore`). Zet ze met deze namen in `data/bron/`.

Alle twaalf delen zijn omgezet (23 oktober 2026). Controleren:

```bash
python scripts/controleer.py
```

Dat geeft per deel het aantal triples, plaatsen, plaatsen zonder huidige
gemeente, passages, lemma's, afbeeldingen, termen, adressen en gekoppelde
rijksmonumenten. Het meldt ook wat mis kan gaan: meer dan één 'Voorwerk',
lege of zeer grote passages en passages zonder hoofdstuk.

## Draaien

```bash
pip install -r requirements.txt
python scripts/converteer.py 10
```

Het deel mag ook als DBNL-code (`sten009monu10_01`) of als pad naar het
XML-bestand worden opgegeven.

Uitvoer in `output/`:

- `<provincie>.trig`: de graph, klaar om te uploaden.
- `<provincie>-koppelingen.csv`: elk adres uit de tekst met de uitkomst van
  de koppeling naar rijksmonumenten, bedoeld voor controle.

Benodigd: Python 3 met `lxml` en `rdflib`. Tijdens de omzetting doet het
script alleen leesvragen aan de Elastic-service van `rce/erfgoed`, om
woonplaatsen, huidige gemeenten en rijksmonumenten op te zoeken. De
antwoorden staan in `data/cache/`, zodat een tweede run geen vragen meer
stelt. Gooi `data/cache/` weg om opnieuw op te vragen.

## Serieregisters (graph `registers`)

Achter in deel 12 (Flevoland) staan de registers van de hele serie. Die
worden niet als tekst opgenomen, maar als gestructureerde data in een eigen
graph, `…/graphs/registers`, met links naar de passages in alle twaalf delen:

```bash
python scripts/registers.py
```

Het script heeft de TriG van alle delen in `output/` nodig, want het zoekt per
verwijzing de passages op die pagina op. Uitvoer: `output/registers.trig`
(ongeveer 72 MB; zip hem eventueel voor de upload) en
`output/registers-zonder-passage.csv`.

| Register | Ingangen | Soort (URI) | Klasse |
|---|---|---|---|
| Architecten en kunstenaars | 7.739 | `…/id/register/persoon/<slug>` | `schema:Person` |
| Topografie | 3.564 | `…/id/register/plaats/<slug>` | `schema:Place` |
| Kastelen, buitenplaatsen en (land)huizen | 1.260 | `…/id/register/object/<slug>` | `schema:Place` |
| Categorie-indeling | 1.801 | `…/id/register/categorie/<slug>` | `schema:DefinedTerm`, `skos:Concept`, met `skos:broader` |

- **Elke ingang** heeft:
  - `schema:name` (de leesbare naam, bijvoorbeeld 'Dirk van der Aa');
  - `min:registernaam` (de vorm in het register, 'Aa, Dirk van der');
  - `min:registertekst` (de hele regel uit het register);
  - waar van toepassing `min:levensdata`, `min:rol`, `min:gemeenteInRegister`,
    `min:provincie`, `min:zie` en `min:categoriepad`;
  - `min:aantalVermeldingen` en `min:deel` (de delen waarin de ingang
    voorkomt).
- **Elke verwijzing** ('ZH 233', 'U 146-148') is een `min:Vermelding`
  (`…/id/register/vermelding/<n>`) met:
  - `min:vanIngang`, `min:verwijzing`, `min:inDeel`, `schema:pageStart` en
    `schema:pageEnd`;
  - `min:opmaak`: `vet` of `cursief`, zoals in het register. Vet is de plaats
    waar iets uitgebreid aan bod komt, of een lemma;
  - `min:passage` en `min:inHoofdstuk`: de passage(s) op die pagina en hun
    hoofdstuk;
  - `min:zekerheid`:
    - `naam`: de naam komt in de tekst van de passage voor (83%);
    - `pagina`: de naam staat niet letterlijk in de tekst, dus alle passages
      op die pagina (17%);
    - `geen`: geen passage op die pagina (7 gevallen, zie de CSV).
- De hoofdgroepen van de categorie-indeling ('Verdedigen (verdediging)',
  'Geloven (religie)' …) zijn de bovenste laag van de boom.
- Het 'Register op de categorieën' verwijst alleen naar pagina's van het
  register zelf en is niet opgenomen.

In de voorkant zijn ingangen te vinden met **Zoek in: Register** of het filter
**Soort**.
- Bij *Register* wegen ingangen met veel vermeldingen zwaarder: score ×
  log10(2 + aantal). Zo staat P.J.H. Cuypers (183) boven een Cuyper met 1
  vermelding. Bij de andere zoekvelden niet, anders verdringen
  registercategorieën als 'korenmolens' de tekst bij 'molen'.
- Elke ingang heeft een eigen pagina (`?ingang=persoon/…`) met alle
  vermeldingen per deel.
- In de leesweergave staat onder een passage welke registeringangen ernaar
  verwijzen. Alleen ingangen met zekerheid `naam` worden daar getoond, omdat
  `pagina` ook een andere passage op dezelfde pagina kan zijn.

## Model

| Ding | Klasse | URI |
|---|---|---|
| serie | `schema:BookSeries` | `…/id/serie` |
| deel | `schema:Book` | `…/id/sten009monu10_01` |
| hoofdstuk, sectie, kern | `schema:Chapter` (kern ook `min:Kern`) | `…/id/<deel>/hoofdstuk/0030`, sectie `0004-02` |
| passage | `schema:CreativeWork`, `min:Passage` | `…/id/<deel>/passage/00451` |
| afbeelding | `schema:ImageObject` | `…/id/<deel>/afbeelding/sten009monu10ill138` |
| term (verklarende woordenlijst) | `schema:DefinedTerm` | `…/id/<deel>/term/aanzetsteen` |

`min:` = `https://linkeddata.cultureelerfgoed.nl/def/monumenten-in-nederland#`

- **Hiërarchie** via `schema:isPartOf`, volgorde via `schema:position`.
  Hoofdstuknummers volgen de DBNL-nummering (`_0030.php` = hoofdstuk `0030`).
- **Passage** is de zoekeenheid, dus ook het Elastic-document:
  - In een kern begint een *lemma* bij een alinea die vet opent
    (bijvoorbeeld **Herv. kerk** (Hof 16)). De volgende alinea's horen erbij,
    tot het volgende vette begin.
  - Alinea's vóór het eerste lemma zijn passages van soort `inleiding`.
  - Buiten de kernen is elke alinea een passage (`alinea`).
  - De literatuuropgave levert per rubriek één passage (`literatuur`).
  - Registers leveren geen passages op.
- **Velden per passage**:
  - `schema:text`, `schema:name`, `min:lemma`, `min:soort`
  - `min:hoofdstuk` (het pad als tekst), `schema:pageStart`, `schema:pageEnd`,
    `schema:url` (de DBNL-pagina), `min:volgnummer` (volgorde binnen het deel)
  - plaats: `min:kern`, `min:gemeenteInBoek` (gemeente in het jaar van
    uitgave), `min:gemeente` en `min:heeftGemeente` (huidige gemeente, OWMS),
    `min:provincie` en `min:heeftProvincie`
  - `min:adres`: elk adres tussen haakjes
  - `min:noemtRijksmonument` en `min:rijksmonumentnummer`: zie hieronder
  - `schema:image`: de afbeeldingen die in de passage staan
- **Koppeling naar rijksmonumenten** gaat op huidige gemeente + straat +
  huisnummer. Er wordt op gemeente gezocht omdat kernen als Overschie en
  Scheveningen in de BAG onder Rotterdam en 's-Gravenhage vallen.
  - Bij een reeks (`2-4`) worden het eerste en het laatste nummer gezocht.
  - Huisletters tellen niet mee.
  - Alleen als straatnaam en nummer gelijk zijn (spaties en leestekens
    tellen niet mee), komt er een `min:noemtRijksmonument` in de TriG.
  - Andere treffers staan in de CSV als `te controleren`.
  - Veel adressen in het boek zijn geen rijksmonument. "Geen rijksmonument
    gevonden" is dus meestal correct.
- **Afbeeldingen** verwijzen met `schema:contentUrl` naar het gif-bestand op
  DBNL. Het bijschrift staat in `schema:caption`. `min:beeldcode` is de
  DBNL-code uit de bron (betekenis onbekend).

## Elastic

Zelfde opzet als `C:\AI\elastic-ceo\triply`:

| Bestand | Wat |
|---|---|
| `elastic/nl-analyse.json` | Nederlandse taalanalyse, kopie van `elastic-ceo/triply/nl-analyse.json` (uitleg in `elastic-ceo/docs/taalanalyse.md`) |
| `elastic/maak-service.py` | Maakt `elastic-service.json`: velden per type, plus een normalizer `min_soort` |
| `elastic/elastic-service.json` | Het POST-bestand voor de service `monumenten-in-nederland` |

Velden per type:

- **Tekst** met Nederlandse analyse, plus `.keyword` en `.exact`: tekst,
  naam, bijschrift, lemma, hoofdstukpad. Velden die niet genoemd zijn,
  krijgen deze mapping ook.
- **Kort**, zonder taalverwerking: kern, gemeente, provincie, adres en deel.
  Anders vindt "kerk" ook Lekkerkerk en de Kerkstraat.
- **Nummer** (`.getal` om te sorteren): rijksmonumentnummer en pagina's.
- **URI's en soort**: alleen exact filteren.
- **`@id.soort`** geeft `passage`, `hoofdstuk`, `afbeelding`, `term`, `deel`
  of `serie`.

Na een wijziging in `nl-analyse.json` of in de velden:

```bash
python elastic/maak-service.py
```

### Service aanmaken

In PowerShell, vanuit deze map. Je hebt een TriplyDB-token met *Management
access* nodig. Zet het token niet in een bestand of in een gesprek. Upload
eerst de TriG naar `rce/monumenten-in-nederland`.

Token zetten (geldt alleen voor dit terminalvenster):

```bash
$env:TRIPLY_TOKEN = "plak-hier-je-token"
```

Service aanmaken:

```bash
curl.exe -H "Authorization: Bearer $env:TRIPLY_TOKEN" -H "Content-Type: application/json" -X POST "https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/monumenten-in-nederland/services" -d "@C:\AI\monumenten_in_nederland\elastic\elastic-service.json"
```

Status. Wacht tot bij `monumenten-in-nederland` `running` staat:

```bash
curl.exe -s "https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/monumenten-in-nederland/services" | Select-String -Pattern '"name":"[^"]*","id"|"status":"[a-z]*"' -AllMatches | ForEach-Object { $_.Matches.Value }
```

Aantal documenten per soort:

```bash
(Invoke-RestMethod -Method Post -Uri "https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/monumenten-in-nederland/services/monumenten-in-nederland/_search" -ContentType "application/json" -Body '{"size":0,"aggs":{"soort":{"terms":{"field":"@id.soort","size":20}}}}').aggregations.soort.buckets | Format-Table key, doc_count
```

Voor Zuid-Holland moet je 2.077 passages zien.

Token weer weghalen:

```bash
Remove-Item Env:TRIPLY_TOKEN
```

De template wordt alleen bij het aanmaken gelezen. Na een wijziging verwijder
je daarom de service in TriplyDB en maak je hem opnieuw aan. Upload je een
nieuwe provincie, dan moet de service bijgewerkt worden voordat die graph
doorzoekbaar is.

## Website

Een zoek- en leesdemo op de service `monumenten-in-nederland`, in `web/`.
Opzet en huisstijl zijn dezelfde als in `C:\AI\elastic-ceo\web`: statische
bestanden, en de browser praat rechtstreeks met de Elasticsearch-service
(CORS staat open). Online serveert een Cloudflare Worker alleen de bestanden
(`wrangler.jsonc`); CSP en noindex staan in `web/_headers`.

| Bestand | Wat |
|---|---|
| `web/search.js` | Zoekvragen, inhoudsopgave, plaatsing van afbeeldingen, URL. Geen DOM, dus te testen. |
| `web/app.js` | De interface |
| `web/index.html`, `web/style.css` | Pagina en rijkshuisstijl |

**Zoeken** gaat over tekst (lemma's, inleidingen, alinea's en literatuur),
hoofdstukken, bijschriften van afbeeldingen en termen.
- Facetten: deel, soort, soort tekst, huidige gemeente en plaats in het boek.
- Zoek in: Alles, Tekst, Naam of lemma, Plaats, Adres, Rijksmonumentnummer of
  Exact. Naam en lemma tellen 3× zo zwaar.
- Sorteren: relevantie, volgorde in het boek of plaats.
- Bij elk resultaat staan de gekoppelde rijksmonumenten (met een link naar
  het Monumentenregister), de DBNL-pagina en de linked data.

**Lezen** (`?lees=sten009monu10_01/0030`) toont de inhoudsopgave van een deel
en één hoofdstuk of plaats tegelijk.
- De tekst staat op volgorde (`min:volgnummer`), met secties als tussenkop.
- Lemmanamen staan vet en paginanummers in de kantlijn.
- Afbeeldingen staan bij hun passage. Een afbeelding zonder passage komt vóór
  de eerste tekst van een latere pagina.
- Plaatsen hebben elk een eigen pagina. "Steden, dorpen, monumenten" geeft de
  lijst van plaatsen.
- De verklarende woordenlijst staat als lijst van termen. De registers
  verwijzen naar DBNL.
- Een passage, afbeelding, term of sectie heeft een anker (`#p00451`,
  `#f-sten009monu10ill138`, `#t-aanzetsteen`, `#h-0004-02`).

Lokaal starten (Node.js 18 of nieuwer, zonder npm-dependencies), daarna
`http://127.0.0.1:4176` openen:

```bash
npm start
```

```bash
npm test
```

```bash
npm run test:live
```

`npm test` test `web/search.js` zonder netwerk. `npm run test:live`
controleert de echte service:
- CORS en de soorten;
- "molens" vindt meervoud en samenstellingen;
- "kapel" markeert geen dakkapel;
- zoeken op rijksmonumentnummer;
- 187 plaatsen in Zuid-Holland, en Delft op volgorde.

### Online zetten

Net als `elastic-ceo`: een Cloudflare Worker die alleen de bestanden uit
`web/` serveert (`wrangler.jsonc`, naam `monumenten-in-nederland`). Een
onbekende URL geeft `web/404.html`.

**Online:** <https://monumenten-in-nederland.jolietjakeblues64.workers.dev/>
(sinds 23 oktober 2026, met de hand gepubliceerd).

**Met de hand**, vanuit deze map (de eerste keer vraagt Wrangler om in te
loggen bij Cloudflare):

```bash
npx wrangler deploy
```

**Automatisch via Workers Builds**, zodra dit project een GitHub-repository
heeft:

1. **Workers & Pages** → **monumenten-in-nederland** → **Settings** →
   **Builds** → **Connect**.
2. Kies de repository, branch `main`.
3. Laat *Build command* leeg. *Deploy command*: `npx wrangler deploy`.
   *Root directory*: `/`.

Elke push naar `main` wordt dan gepubliceerd. `.gitignore` houdt
`.claude/`, de DBNL-bronbestanden, `data/cache/`, `.wrangler/` en
geheimen (`.dev.vars*`, `.env*`) buiten de repository. Wrangler publiceert
alleen `web/`.

Een upload van vóór 23 oktober 2026 mist `min:inDeel` bij de bovenste
hoofdstukken, en kern en gemeente bij afbeeldingen en termen. De website kan
daar tegen, maar de filters werken pas volledig na een nieuwe upload van de
TriG.

## Aandachtspunten in de bron

- Kernen staan onder de gemeente uit het jaar van uitgave (1996–2006). De
  huidige gemeente wordt afgeleid uit de objecten in `rce/erfgoed` met dezelfde
  woonplaatsnaam. Het script probeert achtereenvolgens:
  1. de kernnaam binnen de provincie van het deel. Plaatsnamen als Hengelo en
     Bergen komen vaker voor, dus niet landelijk;
  2. de schrijfwijze in `rce/erfgoed`: 'Etten-leur' → 'Etten-Leur',
     'Bergen' → 'Bergen (NH)', 'St.' = 'Sint';
  3. de alternatieve naam uit de kop (Fries: 'Akmarijp (Eagmaryp)');
  4. de losse delen van een samengestelde naam ('Eelde-Paterswolde',
     'Amsterdam-Sloten');
  5. provincies uit `PROVINCIE_OOK` (Vijfheerenlanden: sinds 2019 Utrecht).
     Bij twijfel wint de provincie met de meeste objecten, zodat een paar
     verouderde objecten met gemeente Zederik niet winnen;
  6. landelijk, maar alleen als de naam in één gemeente voorkomt;
  7. de gemeente uit de kop, als er nog een gemeente met die naam is
     (gehuchten als Teckop, gemeente Woerden).

  Afwijkende namen staan in `WOONPLAATS_ALIAS`. Zonder huidige gemeente
  blijven Bakhuizen (Fryslân) en vier gehuchten in Overijssel waarvan de
  gemeente uit het boek niet meer bestaat (Deldeneresch, Mariaparochie,
  Noord Deurningen, Paaslo).
- Tussen de kernen staan soms divs zonder kop: een alinea van de vorige plaats
  plus de volgende plaats. Die alinea hoort bij de vorige plaats; loopt een
  lemma door, dan hoort ze bij dat lemma. Achter in Gelderland staat zo'n div
  met het colofon.
- Koppen kunnen DBNL-markeringen bevatten ('{problem}Willemstad'); die worden
  weggehaald.
- De woordenlijst heet in Noord-Holland 'Verklaring van enige Termen'.
- Deel 12 (Flevoland) bevat na de provincie een **terugblik op de serie** en
  de **registers van de hele serie**. De terugblik staat als hoofdstukken in
  deel 12. De serieregisters leveren, net als de gewone registers, geen
  passages op.
- Afbeeldingen staan in de XML midden in zinnen. Ze worden uit de lopende
  tekst gehaald.
- Getallen tussen vierkante haken, zoals `[11]`, lijken te verwijzen naar
  genummerde objecten op de stadsplattegronden in het boek. In Zuid-Holland
  komen de nummers 1 tot en met 15 elk 14 keer voor. Ze staan zo in de bron
  en blijven in de tekst staan.
