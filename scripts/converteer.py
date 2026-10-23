#!/usr/bin/env python3
"""Zet één deel van *Monumenten in Nederland* (DBNL-TEI XML) om naar TriG
voor de dataset rce/monumenten-in-nederland in de linked-datavoorziening.

Per deel (= provincie) komt er één named graph. Het model:

  serie (schema:BookSeries)
    └ deel (schema:Book)
        └ hoofdstuk / sectie / kern (schema:Chapter, geneste schema:isPartOf)
            ├ passage (schema:CreativeWork, min:Passage) – zoekeenheid voor Elastic
            ├ afbeelding (schema:ImageObject)
            └ term (schema:DefinedTerm, alleen in 'Verklaring van enige termen')

Woonplaats, huidige gemeente en rijksmonumenten worden opgezocht in de
Elastic-service van rce/erfgoed. Antwoorden worden gecachet in data/cache/.

Gebruik (een pad, een DBNL-code of alleen het deelnummer):
  python scripts/converteer.py data/bron/sten009monu10_01.xml
  python scripts/converteer.py sten009monu10_01
  python scripts/converteer.py 10
"""
import argparse
import csv
import json
import re
import sys
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from lxml import etree
from rdflib import Dataset, Literal, Namespace, URIRef
from rdflib.namespace import RDF, RDFS, XSD

PROJECT = Path(__file__).resolve().parent.parent
BRON = PROJECT / 'data' / 'bron'
CACHE = PROJECT / 'data' / 'cache'

DATASET = 'https://linkeddata.cultureelerfgoed.nl/rce/monumenten-in-nederland'
SDO = Namespace('https://schema.org/')
MIN = Namespace('https://linkeddata.cultureelerfgoed.nl/def/monumenten-in-nederland#')

ES_URL = 'https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/erfgoed/services/Erfgoed-ceo/_search'
CEO = 'https://linkeddata cultureelerfgoed nl/def/ceo-elastic#'
RIJKSMONUMENT = 'https://linkeddata.cultureelerfgoed.nl/def/ceo#Rijksmonument'
OWMS = 'http://standaarden.overheid.nl/owms/terms/'

PROVINCIES = {
    'Groningen': 'Groningen_(provincie)', 'Fryslân': 'Fryslan', 'Drenthe': 'Drenthe',
    'Overijssel': 'Overijssel', 'Flevoland': 'Flevoland', 'Gelderland': 'Gelderland',
    'Utrecht': 'Utrecht_(provincie)', 'Noord-Holland': 'Noord-Holland',
    'Zuid-Holland': 'Zuid-Holland', 'Zeeland': 'Zeeland_(provincie)',
    'Noord-Brabant': 'Noord-Brabant', 'Limburg': 'Limburg',
}

# Kernnamen uit het boek die als BAG-woonplaats anders heten.
WOONPLAATS_ALIAS = {
    'Den Haag': "'s-Gravenhage",
    'Ouderkerk aan den Ijssel': 'Ouderkerk aan den IJssel',  # kop in de bron heeft 'Ijssel'
    'Reeuwijk-Dorp': 'Reeuwijk',
    'Amsterdam buiten de singelgracht': 'Amsterdam',
    'Baarle-Nassau/Baarle-Hertog': 'Baarle-Nassau',
    'Staphorst en Rouveen': 'Staphorst',
    'Winsum en Obergum': 'Winsum',
    'Alphen aan de maas': 'Alphen',
    'Sint Jacobiparochie': 'St.-Jacobiparochie',
}

# Plaatsen die sinds het verschijnen van een deel naar een andere provincie gingen: daar ook zoeken.
# Vijfheerenlanden (Vianen, Ameide, Lexmond e.a.) ging in 2019 van Zuid-Holland naar Utrecht.
PROVINCIE_OOK = {
    OWMS + 'Zuid-Holland': [OWMS + 'Utrecht_(provincie)'],
}

# Hoofdstukken waarvan de tekst geen zoekbare passages oplevert.
REGISTERS = ('Topografisch register', 'Register van personen',
             # registers van de hele serie, achter in deel 12 (Flevoland)
             'Registers serie', 'Serieregister topografie', 'Serieregister van architecten en kunstenaars',
             'Serieregister categorieën', 'Register op de categorieën')
TERMEN = 'Verklaring van enige termen'
KERNEN = 'Steden, dorpen, monumenten'


# --------------------------------------------------------------------------- tekst

def stroom(el):
    """Loop door de inhoud van el in documentvolgorde.

    Levert ('t', tekst), ('pb', paginanummer) en ('fig', figure-element).
    Afbeeldingen staan in de bron midden in zinnen; hun tekst hoort niet bij
    de lopende tekst en wordt dus niet als 't' geleverd.
    """
    if el.text:
        yield 't', el.text
    for kind in el:
        if not isinstance(kind.tag, str):
            pass  # commentaar
        elif kind.tag == 'pb':
            yield 'pb', kind.get('n')
        elif kind.tag == 'figure':
            yield 'fig', kind
        elif kind.tag == 'lb':
            yield 't', ' '
        elif kind.tag not in ('interpGrp', 'interp'):
            yield from stroom(kind)
        if kind.tail:
            yield 't', kind.tail


def schoon(tekst):
    return re.sub(r'\s+', ' ', tekst.replace('\xa0', ' ')).strip()


def platte_tekst(el):
    return schoon(''.join(s for soort, s in stroom(el) if soort == 't'))


def slug(tekst):
    tekst = unicodedata.normalize('NFKD', tekst).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', tekst.lower()).strip('-') or 'x'


def vergelijkbaar(tekst):
    tekst = unicodedata.normalize('NFKD', tekst).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]', '', tekst.lower())


def vette_kop(p):
    """Naam van het lemma als de alinea opent met vette tekst, anders None."""
    if p.text and p.text.strip():
        return None
    eerste = next((k for k in p if isinstance(k.tag, str) and k.tag not in ('pb', 'interpGrp')), None)
    if eerste is None or eerste.tag != 'hi' or eerste.get('rend') != 'b':
        return None
    naam = schoon(''.join(eerste.itertext())).rstrip(',.:;')
    return naam or None


ADRES_IN_HAAKJES = re.compile(r'\(([^()]{3,90})\)')
STRAAT_NUMMER = re.compile(r"^([A-Z'‘’][^\d(),;:]*?)\s+(\d+)(?:\s?[a-zA-Z]\b)?(?:\s*-\s*(\d+))?")
GEEN_STRAAT = {'circa', 'ca', 'omstreeks', 'sinds', 'tot', 'na', 'voor', 'vanaf', 'nr', 'nrs', 'gebouwd', 'herv', 'geref'}
ADRES_IN_REGISTER = re.compile(r'^(.*?)\s+(\d+)')


def adressen(tekst):
    """Adressen tussen haakjes, zoals '(Oude Delft 39-41)' → ('Oude Delft', ('39', '41'), 'Oude Delft 39-41').

    Bij een reeks worden het eerste en het laatste nummer gezocht.
    """
    gevonden = []
    for m in ADRES_IN_HAAKJES.finditer(tekst):
        deel = re.split(r'[;,]| en ', m.group(1))[0].strip()
        deel = re.sub(r'^(?:[a-z]+\.?\s+)+', '', deel)  # 'bij Noordeinde 125', 'hoek ...'
        s = STRAAT_NUMMER.match(deel)
        if not s:
            continue
        straat = s.group(1).strip()
        if vergelijkbaar(straat.split()[0]) in GEEN_STRAAT:
            continue
        nummers = tuple(dict.fromkeys(n for n in s.group(2, 3) if n))
        gevonden.append((straat, nummers, deel))
    return gevonden


# --------------------------------------------------------------------------- Elastic

def es_zoek(query):
    req = urllib.request.Request(ES_URL, json.dumps(query).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


class Cache:
    def __init__(self, naam):
        self.pad = CACHE / naam
        self.data = json.loads(self.pad.read_text(encoding='utf-8')) if self.pad.exists() else {}

    def bewaar(self):
        self.pad.parent.mkdir(parents=True, exist_ok=True)
        self.pad.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding='utf-8')


def gemeente_van(woonplaats, provincie_uri=None):
    """Aantal objecten en de meest voorkomende gemeente van een woonplaats (binnen de provincie, als die er is)."""
    r = es_zoek({
        'size': 0,
        'query': {'bool': {'filter': [
            {'term': {CEO + 'woonplaatsnaam.keyword': woonplaats}},
            *([{'term': {CEO + 'heeftProvincie': provincie_uri}}] if provincie_uri else []),
        ]}},
        'aggs': {
            'g': {'terms': {'field': CEO + 'heeftGemeente', 'size': 3}},
            'gl': {'terms': {'field': CEO + 'gemeente.keyword', 'size': 3}},
        },
    })
    agg = r['aggregations']
    return {
        'woonplaats': woonplaats,
        'objecten': r['hits']['total']['value'],
        'gemeenten': len(agg['g']['buckets']),
        'gemeenteUri': agg['g']['buckets'][0]['key'] if agg['g']['buckets'] else None,
        'gemeente': agg['gl']['buckets'][0]['key'] if agg['gl']['buckets'] else None,
    }


def woonplaatsvorm(naam):
    """Naam om woonplaatsen te vergelijken: zonder provincie-achtervoegsel ('Bergen (NH)', 'Well L') en
    met 'St.' als 'Sint' ('St.-Jacobiparochie')."""
    naam = re.sub(r'^St\.?[- ]', 'Sint ', naam.strip())
    naam = re.sub(r'\s*\(?\b(NH|ZH|NB|L|Gld|Gr|Fr|Dr|Ov|U|Z)\b\)?$', '', naam)
    return vergelijkbaar(naam)


def gespelde_woonplaats(naam, provincie_uri):
    """De woonplaatsnaam zoals rce/erfgoed die spelt ('Etten-leur' → 'Etten-Leur', 'Bergen' → 'Bergen (NH)'),
    of None."""
    r = es_zoek({
        'size': 0,
        'query': {'bool': {'must': [{'match_phrase': {CEO + 'woonplaatsnaam': naam}}],
                           'filter': [{'term': {CEO + 'heeftProvincie': provincie_uri}}]}},
        'aggs': {'w': {'terms': {'field': CEO + 'woonplaatsnaam.keyword', 'size': 20}}},
    })
    return next((b['key'] for b in r['aggregations']['w']['buckets'] if woonplaatsvorm(b['key']) == woonplaatsvorm(naam)), None)


def gemeente_met_naam(gemeente, provincies):
    """De OWMS-URI van een gemeente die nu nog zo heet, in een van de provincies, of None."""
    r = es_zoek({
        'size': 0,
        'query': {'bool': {'filter': [
            {'term': {CEO + 'gemeente.keyword': gemeente}},
            {'terms': {CEO + 'heeftProvincie': provincies}},
        ]}},
        'aggs': {'g': {'terms': {'field': CEO + 'heeftGemeente', 'size': 1}}},
    })
    b = r['aggregations']['g']['buckets']
    return b[0]['key'] if b else None


_gemeenten_per_provincie = {}


def gemeenten_in(provincies):
    """De gemeenten (OWMS-URI's) die objecten hebben in een van de provincies."""
    sleutel = tuple(provincies)
    if sleutel not in _gemeenten_per_provincie:
        r = es_zoek({'size': 0, 'query': {'terms': {CEO + 'heeftProvincie': list(provincies)}},
                     'aggs': {'g': {'terms': {'field': CEO + 'heeftGemeente', 'size': 500}}}})
        _gemeenten_per_provincie[sleutel] = {b['key'] for b in r['aggregations']['g']['buckets']}
    return _gemeenten_per_provincie[sleutel]


def landelijk(vraag, provincies, woonplaats=None, bron=None):
    """Landelijk zoeken, maar de gemeente met de meeste objecten nemen die in een van de provincies ligt.

    Veel archeologische objecten in rce/erfgoed hebben geen provincie (Bakhuizen: 13 objecten, geen provincie);
    die vallen buiten een zoekactie binnen de provincie, maar hun gemeente ligt er wel.
    """
    r = es_zoek({'size': 0, 'query': vraag, 'aggs': {'g': {'terms': {'field': CEO + 'heeftGemeente', 'size': 20},
                                                           'aggs': {'n': {'terms': {'field': CEO + 'gemeente.keyword', 'size': 1}}}}}})
    binnen = gemeenten_in(provincies)
    for b in r['aggregations']['g']['buckets']:
        if b['key'] in binnen:
            naam = b['n']['buckets'][0]['key'] if b['n']['buckets'] else None
            return {'woonplaats': woonplaats, 'objecten': b['doc_count'] if woonplaats else 0, 'gemeenten': 1,
                    'gemeenteUri': b['key'], 'gemeente': naam, **({'bron': bron} if bron else {})}
    return None


def woonplaats_info(namen, provincie_uri, cache, gemeente_in_boek=None):
    """Huidige gemeente van een kern, afgeleid uit de objecten in rce/erfgoed binnen dezelfde provincie.

    namen: de kernnaam (of alias) en eventueel de alternatieve naam uit het boek, bijv. 'Akmarijp' en
    'Eagmaryp'. Binnen de provincie, omdat plaatsnamen als Hengelo of Bergen vaker voorkomen.
    """
    sleutel = f'{provincie_uri}|{namen[0]}'
    if sleutel in cache.data:
        return cache.data[sleutel]
    # Samengestelde namen: daarna de losse delen ('Eelde-Paterswolde', 'Termunten en Termunterzijl',
    # 'Amsterdam-Sloten', 'Nederhemert-Noord').
    delen = [d for d in re.split(r'\s+en\s+|\s*-\s*|/', namen[0]) if len(d) > 2]
    namen = [*namen, *(delen if len(delen) > 1 else [])]
    # Per provincie de eerste naam die objecten heeft; daarna de provincie met de meeste objecten. Zo wint
    # Leerdam in Utrecht (honderden objecten) van een paar verouderde objecten met gemeente Zederik in
    # Zuid-Holland.
    info = None
    for provincie in [provincie_uri, *PROVINCIE_OOK.get(provincie_uri, [])]:
        for naam in [n for n in namen if n]:
            kandidaat = gemeente_van(naam, provincie)
            if not kandidaat['objecten'] and (gespeld := gespelde_woonplaats(naam, provincie)):
                kandidaat = gemeente_van(gespeld, provincie)
            if kandidaat['objecten']:
                break
        if info is None or kandidaat['objecten'] > info['objecten']:
            info = kandidaat
    provincies = [provincie_uri, *PROVINCIE_OOK.get(provincie_uri, [])]
    # Anders landelijk: als de naam in één gemeente voorkomt, of de gemeente met de meeste objecten die in de
    # provincie ligt (Bakhuizen → De Fryske Marren; de objecten daar hebben geen provincie).
    if not info['objecten']:
        for naam in [n for n in namen if n]:
            alles = gemeente_van(naam)
            if alles['objecten'] and alles['gemeenten'] == 1:
                info = alles
                break
            if alles['objecten'] and (gevonden := landelijk({'term': {CEO + 'woonplaatsnaam.keyword': naam}}, provincies, woonplaats=naam)):
                info = gevonden
                break
    # Gehuchten die geen woonplaats in de BAG zijn: de gemeente uit de kop van het boek, als er nu nog een
    # gemeente met die naam is (Teckop, gemeente Woerden), of als er een woonplaats zo heet (Deldeneresch,
    # gemeente Ambt Delden → woonplaats Ambt Delden → Hof van Twente). 'Almelo/Tubbergen': beide proberen.
    if not info['gemeenteUri'] and gemeente_in_boek:
        for gemeente in [g.strip() for g in gemeente_in_boek.split('/') if g.strip()]:
            if uri := gemeente_met_naam(gemeente, provincies):
                info = {'woonplaats': None, 'objecten': 0, 'gemeenten': 1, 'gemeenteUri': uri, 'gemeente': gemeente,
                        'bron': 'gemeente in het boek'}
                break
            if gevonden := landelijk({'term': {CEO + 'woonplaatsnaam.keyword': gemeente}}, provincies, bron='woonplaats met de naam van de gemeente in het boek'):
                info = gevonden
                break
    # Als laatste: objecten in rce/erfgoed waarin de plaatsnaam voorkomt (Paaslo → Steenwijkerland).
    if not info['gemeenteUri']:
        velden = [CEO + v for v in ('locatienaam', 'naam', 'omschrijving', 'volledigAdres')]
        if gevonden := landelijk({'multi_match': {'query': namen[0], 'type': 'phrase', 'fields': velden}}, provincies, bron='plaatsnaam in rce/erfgoed'):
            info = gevonden
    cache.data[sleutel] = info
    return info


def zoek_rijksmonumenten(gemeente_uri, straat, nummers):
    """Rijksmonumenten in de huidige gemeente met dit adres.

    Er wordt op gemeente gezocht en niet op woonplaats, omdat kernen als
    Overschie of Scheveningen in de BAG onder een andere woonplaats vallen.
    'exact' betekent: straatnaam (zonder spaties en leestekens) en huisnummer
    zijn gelijk; huisletters en toevoegingen tellen niet mee.
    """
    r = es_zoek({
        'size': 50,
        '_source': [CEO + 'rijksmonumentnummer', CEO + 'volledigAdres'],
        'query': {'bool': {
            'filter': [
                {'term': {CEO + 'klasse': RIJKSMONUMENT}},
                {'term': {CEO + 'heeftGemeente': gemeente_uri}},
            ],
            'should': [{'match_phrase': {CEO + 'volledigAdres': f'{straat} {nr}'}} for nr in nummers],
            'minimum_should_match': 1,
        }},
    })
    gezocht = {(vergelijkbaar(straat), nr) for nr in nummers}
    treffers = []
    for h in r['hits']['hits']:
        bron = h['_source']
        gevonden = {(vergelijkbaar(m.group(1)), m.group(2))
                    for a in bron.get(CEO + 'volledigAdres', []) if (m := ADRES_IN_REGISTER.match(a))}
        treffers.append({
            'uri': h['_id'],
            'nummer': (bron.get(CEO + 'rijksmonumentnummer') or [None])[0],
            'exact': bool(gezocht & gevonden),
        })
    return treffers


# --------------------------------------------------------------------------- omzetting

class Deel:
    def __init__(self, xml_pad, dbnl_toc):
        parser = etree.XMLParser(load_dtd=False, no_network=True, resolve_entities=False, recover=True)
        self.boom = etree.parse(str(xml_pad), parser)
        h = self.boom.find('.//teiHeader')
        self.code = h.findtext('.//idno[@type="titelcode"]').strip()
        self.titel = schoon(h.findtext('.//titleStmt/title[@type="main"]'))
        self.provincie = self.titel.split('. ', 1)[1]
        self.nummer = int(re.search(r'monu(\d+)', self.code).group(1))
        self.auteurs = [schoon(a.text) for a in h.findall('.//titleStmt/author')]
        bron = platte_tekst(h.find('.//sourceDesc/p'))
        self.jaar = re.findall(r'(19\d\d|20\d\d)', bron)[-1]
        self.uitgever =schoon(re.sub(r'\s*\d{4}$', '', bron.split(self.provincie, 1)[-1].lstrip('.,  ')))
        self.dbnl = f'https://www.dbnl.org/tekst/{self.code}/'
        self.toc = dbnl_toc

        self.base = f'{DATASET}/id/{self.code}'
        self.graph_uri = URIRef(f'{DATASET}/graphs/{slug(self.provincie)}')
        self.provincie_uri = URIRef(OWMS + PROVINCIES[self.provincie])

        self.ds = Dataset()
        self.g = self.ds.graph(self.graph_uri)
        self.g.bind('schema', SDO)
        self.g.bind('min', MIN)

        self.pagina = None
        self.volgnummer = 0
        self.passages = []      # dicts, voor koppelen en rapport
        self.term_slugs = set()
        self.in_kernen = False
        self.laatste_kern = None
        self.kernen_ctx = None
        self.kernen_zonder = []
        self.voorwerk_gehad = False

    # -- hulp
    def add(self, s, p, o):
        self.g.add((s, p, o))

    def lit(self, s, p, waarde, **kw):
        if waarde not in (None, ''):
            self.g.add((s, p, Literal(waarde, **kw)))

    # -- serie en boek
    def boek(self):
        serie = URIRef(f'{DATASET}/id/serie')
        self.add(serie, RDF.type, SDO.BookSeries)
        self.lit(serie, SDO.name, 'Monumenten in Nederland', lang='nl')
        self.deel_uri = URIRef(self.base)
        b = self.deel_uri
        self.add(b, RDF.type, SDO.Book)
        self.lit(b, SDO.name, self.titel, lang='nl')
        self.lit(b, RDFS.label, self.titel, lang='nl')
        self.add(b, SDO.isPartOf, serie)
        self.lit(b, SDO.position, self.nummer, datatype=XSD.integer)
        for a in self.auteurs:
            self.lit(b, SDO.author, a)
        self.lit(b, SDO.datePublished, self.jaar, datatype=XSD.gYear)
        self.lit(b, SDO.publisher, self.uitgever)
        self.lit(b, SDO.identifier, self.code)
        self.add(b, SDO.url, URIRef(self.dbnl))
        self.lit(b, MIN.provincie, self.provincie)
        self.add(b, MIN.heeftProvincie, self.provincie_uri)

    # -- hoofdstukken
    def hoofdstukken(self):
        body = self.boom.find('.//text/body')
        hoofd = [d for d in body if d.tag == 'div']
        for i, div in enumerate(hoofd, start=1):
            url = f'{self.dbnl}{self.code}_{i:04d}.php'
            self.div(div, self.deel_uri, f'{i:04d}', i, [], url)

    def kop(self, div):
        h = div.find('head')
        # DBNL-markeringen als '{problem}Willemstad' horen niet bij de kop
        return (re.sub(r'\{[a-z]+\}', '', platte_tekst(h)).strip(), h.get('rend')) if h is not None else (None, None)

    def div(self, div, ouder, sleutel, positie, pad, url, register=False, ouder_ctx=None):
        titel, rend = self.kop(div)
        # Een div zonder kop binnen een hoofdstuk hoort gewoon bij dat hoofdstuk.
        if titel is None and ouder_ctx is not None:
            self.inhoud(div, ouder_ctx, sleutel, vervolg=True)
            return
        # Een div zonder kop tussen de kernen is een vervolg: een alinea van de vorige plaats (soms een
        # afbeelding), gevolgd door de volgende plaats. Geen eigen hoofdstuk.
        if titel is None and self.in_kernen and (self.laatste_kern or self.kernen_ctx):
            self.inhoud(div, self.laatste_kern or self.kernen_ctx, sleutel, vervolg=True)
            return
        register = register or titel in REGISTERS
        if titel == KERNEN:
            self.in_kernen = True
        elif rend == 'h3' and titel and titel.startswith('Beknopte literatuur'):
            self.in_kernen = False
        is_kern = self.in_kernen and rend == 'h3' and titel != KERNEN

        uri = URIRef(f'{self.base}/hoofdstuk/{sleutel}')
        # Zonder kop: vooraan titelpagina en inhoud, achteraan (Gelderland) het colofon.
        naam = titel or ('Colofon' if self.voorwerk_gehad else 'Voorwerk')
        self.voorwerk_gehad = True
        self.add(uri, RDF.type, SDO.Chapter)
        self.lit(uri, SDO.name, naam, lang='nl')
        self.lit(uri, RDFS.label, naam, lang='nl')
        # De eerste kern staat in de bron binnen het hoofdstuk 'Steden, dorpen,
        # monumenten'; de rest staat erachter. Alle kernen horen eronder.
        if is_kern and self.kernen_uri is not None:
            ouder = self.kernen_uri
            pad = [KERNEN]
        self.add(uri, SDO.isPartOf, ouder)
        self.add(uri, MIN.inDeel, self.deel_uri)
        self.lit(uri, SDO.position, positie, datatype=XSD.integer)
        self.lit(uri, MIN.hoofdstuk, ' › '.join(pad + [naam]))
        self.lit(uri, MIN.provincie, self.provincie)
        self.add(uri, MIN.heeftProvincie, self.provincie_uri)
        if titel == KERNEN:
            self.kernen_uri = uri

        kern = None
        if is_kern:
            kern = self.kern_context(titel)
            url = self.toc.get(titel) or self.toc.get(kern['kern'], url)
            self.add(uri, RDF.type, MIN.Kern)
            for p, w in (('kern', 'kern'), ('alternatieveNaam', 'alternatief'), ('gemeenteInBoek', 'gemeenteInBoek'),
                         ('woonplaats', 'woonplaats'), ('gemeente', 'gemeente')):
                self.lit(uri, MIN[p], kern.get(w))
            if kern.get('gemeenteUri'):
                self.add(uri, MIN.heeftGemeente, URIRef(kern['gemeenteUri']))
        self.add(uri, SDO.url, URIRef(url))

        ctx = {'uri': uri, 'pad': pad + [naam], 'url': url, 'kern': kern, 'titel': naam, 'register': register}
        if is_kern:
            self.laatste_kern = ctx
        elif titel == KERNEN:
            self.kernen_ctx = ctx
        self.inhoud(div, ctx, sleutel)

    def kern_context(self, titel):
        # 'Akmarijp (Eagmaryp) (gemeente Skarsterlân)', '… (Gemeente Ravenstein)', 'Delden (stad)'
        m = re.match(r'^(.*?)\s*(?:\(([^()]*)\))?\s*(?:\([Gg]emeente ([^()]*)\))?$', titel)
        kern, alternatief, gemeente = m.group(1), m.group(2), m.group(3)
        if alternatief and alternatief.lower().startswith('gemeente '):
            alternatief, gemeente = None, alternatief[len('gemeente '):]
        if alternatief and not alternatief[0].isupper():
            alternatief = None  # een toevoeging als '(stad)', geen andere naam
        info = woonplaats_info([WOONPLAATS_ALIAS.get(kern, kern), alternatief], str(self.provincie_uri), self.wp_cache,
                               gemeente or None)
        if not info['gemeenteUri']:
            self.kernen_zonder.append(kern)
        return {'kern': kern, 'alternatief': alternatief, 'gemeenteInBoek': gemeente or kern,
                'woonplaats': info['woonplaats'] if info['objecten'] else None,
                'gemeente': info['gemeente'], 'gemeenteUri': info['gemeenteUri']}

    # -- inhoud van een div
    def inhoud(self, div, ctx, sleutel, vervolg=False):
        huidig = None
        # Loopt een lemma door in een vervolgdiv, dan horen de eerste alinea's nog bij dat lemma.
        vorige = self.passages[-1] if self.passages else None
        if vervolg and vorige and vorige['ctx'] is ctx and vorige['soort'] == 'lemma':
            huidig = self.nieuwe_passage(ctx, 'lemma', vorige['naam'])
        sub = 0
        for kind in div:
            if not isinstance(kind.tag, str) or kind.tag in ('head', 'interpGrp'):
                continue
            if kind.tag == 'pb':
                self.pagina = kind.get('n')
            elif kind.tag == 'div':
                sub += 1
                self.sluit(huidig)
                huidig = None
                self.div(kind, ctx['uri'], f'{sleutel}-{sub:02d}', sub, ctx['pad'], ctx['url'], ctx['register'], ctx)
            elif kind.tag == 'list' and ctx['titel'].lower() == TERMEN.lower():  # Noord-Holland: '… Termen'
                self.termen(kind, ctx)
            elif ctx['register'] or kind.tag == 'table':
                self.blok(kind, ctx, None)  # alleen pagina's en afbeeldingen bijhouden
            elif kind.tag == 'list':
                self.sluit(huidig)
                huidig = self.nieuwe_passage(ctx, 'literatuur', ctx['titel'])
                self.blok(kind, ctx, huidig, scheiding='\n')
            else:
                lemma = vette_kop(kind) if ctx['kern'] else None
                if lemma:
                    self.sluit(huidig)
                    huidig = self.nieuwe_passage(ctx, 'lemma', lemma)
                    self.blok(kind, ctx, huidig)
                elif huidig is not None and huidig['soort'] == 'lemma':
                    self.blok(kind, ctx, huidig)
                else:
                    self.sluit(huidig)
                    huidig = self.nieuwe_passage(ctx, 'inleiding' if ctx['kern'] else 'alinea', ctx['titel'])
                    self.blok(kind, ctx, huidig)
                    if not huidig['delen']:  # alinea met alleen een afbeelding
                        huidig = None
                        continue
                    self.sluit(huidig)
                    huidig = None
        self.sluit(huidig)

    def nieuwe_passage(self, ctx, soort, naam):
        return {'ctx': ctx, 'soort': soort, 'naam': naam, 'delen': [], 'start': None,
                'eind': None, 'figuren': []}

    def blok(self, el, ctx, passage, scheiding='\n\n'):
        stukken = []
        for soort, waarde in stroom(el):
            if soort == 'pb':
                self.pagina = waarde
            elif soort == 'fig':
                fig = self.afbeelding(waarde, ctx)
                if passage is not None:
                    passage['figuren'].append(fig)
            else:
                stukken.append(waarde)
                if passage is not None and waarde.strip():
                    passage['start'] = passage['start'] or self.pagina
                    passage['eind'] = self.pagina
        if passage is None:
            return
        if el.tag == 'list':
            tekst = scheiding.join(platte_tekst(i) for i in el.findall('item'))
        else:
            tekst = schoon(''.join(stukken))
        if tekst:
            passage['delen'].append(tekst)

    def sluit(self, passage):
        if passage is None or not passage['delen']:
            return
        self.volgnummer += 1
        ctx = passage['ctx']
        uri = URIRef(f'{self.base}/passage/{self.volgnummer:05d}')
        tekst = '\n\n'.join(passage['delen'])
        passage.update(uri=uri, tekst=tekst, volgnummer=self.volgnummer)
        self.passages.append(passage)

        self.add(uri, RDF.type, SDO.CreativeWork)
        self.add(uri, RDF.type, MIN.Passage)
        self.lit(uri, SDO.name, passage['naam'], lang='nl')
        self.lit(uri, RDFS.label, f"{ctx['titel']} – {passage['naam']}" if passage['naam'] != ctx['titel'] else passage['naam'], lang='nl')
        self.lit(uri, SDO.text, tekst, lang='nl')
        self.add(uri, SDO.isPartOf, ctx['uri'])
        self.add(uri, MIN.inDeel, self.deel_uri)
        self.lit(uri, MIN.soort, passage['soort'])
        self.lit(uri, MIN.volgnummer, self.volgnummer, datatype=XSD.integer)
        self.plaats(uri, ctx)
        self.lit(uri, SDO.pageStart, passage['start'])
        self.lit(uri, SDO.pageEnd, passage['eind'])
        self.lit(uri, SDO.pagination, passage['start'] if passage['start'] == passage['eind']
                 else f"{passage['start']}-{passage['eind']}")
        self.add(uri, SDO.url, URIRef(ctx['url']))
        kern = ctx['kern']
        if passage['soort'] == 'lemma':
            self.lit(uri, MIN.lemma, passage['naam'])
        for fig in passage['figuren']:
            self.add(uri, SDO.image, fig)
        passage['adressen'] = adressen(tekst) if kern else []
        for _, _, adres in passage['adressen']:
            self.lit(uri, MIN.adres, adres)

    def plaats(self, uri, ctx):
        """Deel, hoofdstukpad, provincie en (in een kern) kern en gemeente: velden om op te filteren."""
        self.lit(uri, MIN.hoofdstuk, ' › '.join(ctx['pad']))
        self.lit(uri, MIN.deel, self.titel)
        self.lit(uri, MIN.provincie, self.provincie)
        self.add(uri, MIN.heeftProvincie, self.provincie_uri)
        kern = ctx['kern']
        if kern:
            for p, w in (('kern', 'kern'), ('gemeenteInBoek', 'gemeenteInBoek'), ('gemeente', 'gemeente')):
                self.lit(uri, MIN[p], kern.get(w))
            if kern.get('gemeenteUri'):
                self.add(uri, MIN.heeftGemeente, URIRef(kern['gemeenteUri']))

    def afbeelding(self, fig, ctx):
        bestand = fig.find('.//xptr').get('to')
        uri = URIRef(f'{self.base}/afbeelding/{Path(bestand).stem}')
        self.add(uri, RDF.type, SDO.ImageObject)
        self.add(uri, SDO.contentUrl, URIRef(self.dbnl + bestand))
        bijschrift = schoon(' '.join(platte_tekst(p) for p in fig.findall('p') if p.find('xptr') is None))
        self.lit(uri, SDO.caption, bijschrift, lang='nl')
        self.lit(uri, RDFS.label, bijschrift or bestand, lang='nl')
        self.add(uri, SDO.isPartOf, ctx['uri'])
        self.add(uri, MIN.inDeel, self.deel_uri)
        self.plaats(uri, ctx)
        self.lit(uri, SDO.pageStart, self.pagina)
        for code in fig.xpath('.//interp[@type="beeld"]/@value'):
            self.lit(uri, MIN.beeldcode, code)
        return uri

    def termen(self, lijst, ctx):
        self.add(ctx['uri'], RDF.type, SDO.DefinedTermSet)
        for item in lijst.findall('item'):
            b = item.find('hi[@rend="b"]')
            if b is None:
                continue
            term = schoon(''.join(b.itertext()))
            uitleg = platte_tekst(item)[len(platte_tekst(b)):].strip()
            s = slug(term)
            while s in self.term_slugs:
                s += '-2'
            self.term_slugs.add(s)
            uri = URIRef(f'{self.base}/term/{s}')
            self.add(uri, RDF.type, SDO.DefinedTerm)
            self.lit(uri, SDO.name, term, lang='nl')
            self.lit(uri, RDFS.label, term, lang='nl')
            self.lit(uri, SDO.description, uitleg, lang='nl')
            self.add(uri, SDO.inDefinedTermSet, ctx['uri'])
            self.add(uri, MIN.inDeel, self.deel_uri)
            self.plaats(uri, ctx)

    # -- rijksmonumenten
    def koppel(self, rapport_pad):
        cache = Cache('es_adressen.json')
        vragen = {}
        for p in self.passages:
            gem = (p['ctx']['kern'] or {}).get('gemeenteUri')
            for straat, nrs, _ in p.get('adressen', []):
                if gem:
                    vragen[f"{gem}|{straat}|{'-'.join(nrs)}"] = (gem, straat, nrs)
        open_vragen = [k for k in vragen if k not in cache.data]
        print(f'adressen: {len(vragen)} uniek, {len(open_vragen)} nog op te vragen', file=sys.stderr)

        def vraag(k):
            try:
                return k, zoek_rijksmonumenten(*vragen[k])
            except Exception as e:  # netwerkfout: volgende keer opnieuw
                print(f'  fout bij {k}: {e}', file=sys.stderr)
                return k, None

        with ThreadPoolExecutor(6) as pool:
            for i, (k, res) in enumerate(pool.map(vraag, open_vragen), start=1):
                if res is not None:
                    cache.data[k] = res
                if i % 500 == 0:
                    cache.bewaar()
                    print(f'  {i}/{len(open_vragen)}', file=sys.stderr)
        cache.bewaar()

        with open(rapport_pad, 'w', newline='', encoding='utf-8-sig') as f:
            w = csv.writer(f, delimiter=';')
            w.writerow(['passage', 'kern', 'lemma', 'adres', 'gemeente', 'status', 'rijksmonumentnummers'])
            for p in self.passages:
                kern = p['ctx']['kern'] or {}
                for straat, nrs, adres in p.get('adressen', []):
                    res = cache.data.get(f"{kern.get('gemeenteUri')}|{straat}|{'-'.join(nrs)}")
                    exact = [t for t in res or [] if t['exact']]
                    if res is None:
                        status = 'geen gemeente' if not kern.get('gemeenteUri') else 'niet opgevraagd'
                    elif exact:
                        status = 'gekoppeld'
                    elif res:
                        status = 'te controleren'  # wel een treffer, maar straat of nummer wijkt af
                    else:
                        status = 'geen rijksmonument gevonden'
                    for t in exact:
                        self.add(p['uri'], MIN.noemtRijksmonument, URIRef(t['uri']))
                        self.lit(p['uri'], MIN.rijksmonumentnummer, t['nummer'])
                    w.writerow([str(p['uri']), kern.get('kern'), p['naam'] if p['soort'] == 'lemma' else '',
                                adres, kern.get('gemeente'), status,
                                ' '.join(t['nummer'] or '' for t in (exact or res or []))])


def dbnl_inhoud(code):
    """Titel → URL uit de DBNL-inhoudsopgave (voor kernen die in de bron genest staan)."""
    pad = CACHE / 'dbnl' / f'{code}.html'
    if not pad.exists():
        pad.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(f'https://www.dbnl.org/tekst/{code}/', timeout=60) as r:
            pad.write_bytes(r.read())
    html = pad.read_text(encoding='utf-8', errors='replace')
    toc = {}
    for href, titel in re.findall(r'href="[^"]*?(' + re.escape(code) + r'_\d{4}\.php(?:#\d+)?)"[^>]*>([^<]+)<', html):
        toc.setdefault(schoon(titel), f'https://www.dbnl.org/tekst/{code}/{href}')
    return toc


def bronbestand(arg):
    """Pad, DBNL-code of deelnummer → XML-bestand in data/bron/."""
    if Path(arg).is_file():
        return Path(arg)
    code = f'sten009monu{int(arg):02d}_01' if arg.isdigit() else Path(arg).stem
    pad = BRON / f'{code}.xml'
    if not pad.is_file():
        raise argparse.ArgumentTypeError(f'geen bronbestand voor {arg!r} in {BRON}')
    return pad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('xml', type=bronbestand, help='pad, DBNL-code of deelnummer (1-12)')
    ap.add_argument('--uit', type=Path, default=PROJECT / 'output')
    ap.add_argument('--zonder-koppeling', action='store_true', help='rijksmonumenten niet opzoeken')
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')

    code = args.xml.stem
    deel = Deel(args.xml, dbnl_inhoud(code))
    deel.wp_cache = Cache('es_woonplaatsen.json')
    deel.kernen_uri = None
    deel.boek()
    deel.hoofdstukken()
    deel.wp_cache.bewaar()

    args.uit.mkdir(parents=True, exist_ok=True)
    naam = slug(deel.provincie)
    if not args.zonder_koppeling:
        deel.koppel(args.uit / f'{naam}-koppelingen.csv')

    trig = args.uit / f'{naam}.trig'
    deel.ds.serialize(destination=str(trig), format='trig', encoding='utf-8')

    zonder = sorted(set(deel.kernen_zonder))
    soorten = {}
    for p in deel.passages:
        soorten[p['soort']] = soorten.get(p['soort'], 0) + 1
    print(f'{deel.titel}: {len(deel.g)} triples in <{deel.graph_uri}>')
    print(f'  passages: {len(deel.passages)} {soorten}')
    print(f'  kernen zonder woonplaats in rce/erfgoed: {", ".join(zonder) or "geen"}')
    print(f'  → {trig}')


if __name__ == '__main__':
    main()
