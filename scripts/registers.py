#!/usr/bin/env python3
"""Zet de registers van de hele serie (achter in deel 12, Flevoland) om naar gestructureerde data in de graph
…/graphs/registers, met links naar de passages waar elke verwijzing naartoe wijst.

Vier registers:

  topografie     plaatsen en gemeenten          'Aagtekerke (gemeente Veere) (Z) Z 30, Z 54, **Z 65**'
  architecten    architecten en kunstenaars     'Aa, Dirk van der (1731-1809) (schilder) **O 93**, **ZH 233**'
  objecten       kastelen, buitenplaatsen, huizen   'Aalshorst, De **O 77-78**'
  categorieen    categorie-indeling (een boom)  'Militaire gebouwen › commandogebouwen › admiraliteitsgebouw F 108'

Model:

  register   (schema:DefinedTermSet)            …/id/register/lijst/<naam>
  ingang     persoon (schema:Person), plaats (schema:Place), object (schema:Place), categorie (schema:DefinedTerm,
             skos:broader naar de bovenliggende categorie)   …/id/register/<soort>/<slug>
  vermelding één verwijzing ('ZH 233') met deel, pagina, opmaak (vet/cursief), de passage(s) op die pagina
             (min:passage) en hun hoofdstuk (min:inHoofdstuk)   …/id/register/vermelding/<n>

Welke passage? Van de passages op die pagina in dat deel de passages waarin de naam voorkomt (min:zekerheid
'naam'); komt de naam in geen enkele voor, dan alle passages op die pagina (min:zekerheid 'pagina').

Vereist de TriG van alle delen in output/ (scripts/converteer.py).

Gebruik:
  python scripts/registers.py
"""
import collections
import csv
import re
import sys
import unicodedata
from pathlib import Path

from lxml import etree
from rdflib import Dataset, Literal, Namespace, URIRef
from rdflib.namespace import RDF, RDFS, SKOS, XSD

sys.path.insert(0, str(Path(__file__).resolve().parent))
from converteer import BRON, DATASET, MIN, OWMS, PROJECT, PROVINCIES, SDO, schoon, slug  # noqa: E402

DEEL12 = BRON / 'sten009monu12_01.xml'
ID = f'{DATASET}/id/register'
GRAPH = URIRef(f'{DATASET}/graphs/registers')

# Afkortingen in de registers → deel
DELEN = {
    'U': ('sten009monu01_01', 'Utrecht'), 'NB': ('sten009monu02_01', 'Noord-Brabant'),
    'O': ('sten009monu03_01', 'Overijssel'), 'Gr': ('sten009monu04_01', 'Groningen'),
    'Gld': ('sten009monu05_01', 'Gelderland'), 'F': ('sten009monu06_01', 'Fryslân'),
    'D': ('sten009monu07_01', 'Drenthe'), 'L': ('sten009monu08_01', 'Limburg'),
    'Z': ('sten009monu09_01', 'Zeeland'), 'ZH': ('sten009monu10_01', 'Zuid-Holland'),
    'NH': ('sten009monu11_01', 'Noord-Holland'), 'Fl': ('sten009monu12_01', 'Flevoland'),
}
# Een paar keer anders gespeld in de bron
AFK_VARIANT = {'GR': 'Gr', 'FL': 'Fl', 'Fr': 'F'}
VERWIJZING = re.compile(r'\b(NH|ZH|NB|Gld|GR|Gr|FL|Fl|Fr|U|O|F|D|L|Z)\s(\d{1,3})(?:\s*-\s*(\d{1,3}))?\b')

REGISTERS = {
    'topografie': ('Serieregister topografie', 'Topografie', 'plaats'),
    'architecten': ('Serieregister van architecten en kunstenaars', 'Architecten en kunstenaars', 'persoon'),
    'objecten': ('Kastelen, buitenplaatsen en (land)huizen', 'Kastelen, buitenplaatsen en (land)huizen', 'object'),
    'categorieen': ('Categorie-indeling', 'Categorieën', 'categorie'),
}


def vouw(tekst):
    """Kleine letters, zonder accenten: om namen in tekst terug te vinden."""
    return unicodedata.normalize('NFKD', tekst).encode('ascii', 'ignore').decode().lower()


# --------------------------------------------------------------------------- pagina's van de delen

class Paginas:
    """Per deel en pagina de passages die erop staan, uit de TriG in output/."""

    def __init__(self):
        self.per_pagina = collections.defaultdict(list)   # (deelcode, pagina) → [passage]
        self.hoofdstukken = {}                            # hoofdstuk-URI → naam
        for trig in sorted((PROJECT / 'output').glob('*.trig')):
            if trig.stem == 'registers':
                continue
            ds = Dataset()
            ds.parse(trig, format='trig')
            g = next(c for c in ds.graphs() if len(c))
            for h in g.subjects(RDF.type, SDO.Chapter):
                self.hoofdstukken[h] = str(g.value(h, MIN.kern) or g.value(h, SDO.name))
            for p in g.subjects(RDF.type, MIN.Passage):
                deel = str(g.value(p, MIN.inDeel)).rsplit('/', 1)[-1]
                van, tot = g.value(p, SDO.pageStart), g.value(p, SDO.pageEnd)
                if not (van and tot and str(van).isdigit() and str(tot).isdigit()):
                    continue
                passage = {'uri': p, 'hoofdstuk': g.value(p, SDO.isPartOf), 'kern': g.value(p, MIN.kern),
                           'tekst': vouw(str(g.value(p, SDO.text) or '')), 'volgnummer': int(g.value(p, MIN.volgnummer))}
                for pagina in range(int(van), min(int(tot), int(van) + 30) + 1):
                    self.per_pagina[(deel, pagina)].append(passage)
            print(f'  {trig.stem}: ingelezen', file=sys.stderr)

    def zoek(self, deel, van, tot, namen):
        """Passages op pagina van..tot van een deel, bij voorkeur die waarin een van de namen voorkomt."""
        alle = {p['uri']: p for pagina in range(van, tot + 1) for p in self.per_pagina.get((deel, pagina), [])}
        patronen = [re.compile(rf'\b{re.escape(vouw(n))}\b') for n in namen if n and len(n) >= 2]
        met_naam = [p for p in alle.values() if any(pat.search(p['tekst']) for pat in patronen)]
        gekozen, zekerheid = (met_naam, 'naam') if met_naam else (list(alle.values()), 'pagina')
        return sorted(gekozen, key=lambda p: p['volgnummer']), zekerheid if gekozen else 'geen'


# --------------------------------------------------------------------------- ingangen lezen

def verwijzingen(item):
    """Verwijzingen in een item, met vet of cursief: [(afk, van, tot, 'vet'|'cursief'|'')]."""
    opmaak = {}
    for hi in item.iter('hi'):
        for m in VERWIJZING.finditer(''.join(hi.itertext())):
            opmaak[(m.group(1), m.group(2))] = {'b': 'vet', 'i': 'cursief'}.get(hi.get('rend'), '')
    gevonden = []
    for m in VERWIJZING.finditer(eigen_tekst(item)):
        afk = AFK_VARIANT.get(m.group(1), m.group(1))
        van = int(m.group(2))
        tot = int(m.group(3)) if m.group(3) and int(m.group(3)) >= van else van
        gevonden.append((afk, van, tot, opmaak.get((m.group(1), m.group(2)), '')))
    return gevonden


def eigen_tekst(item):
    """Tekst van een item zonder geneste lijsten."""
    delen = [item.text or '']
    for kind in item:
        if kind.tag != 'list':
            delen.append(''.join(kind.itertext()))
        delen.append(kind.tail or '')
    return schoon(''.join(delen))


def naamdeel(tekst):
    """Alles vóór de eerste verwijzing of 'zie'."""
    m = VERWIJZING.search(tekst)
    naam = tekst[:m.start()] if m else tekst
    return re.split(r'\s+zie\s+', naam)[0].strip(' ,;')


def persoon(tekst):
    """'Laan, L. [Leonardus (Leo)] van der (1864-1942) (beeldhouwer)' → naam, weergavenaam, achternaam, data, rollen."""
    naam = naamdeel(tekst)
    # Haakjes achteraan zijn levensdata of rol; haakjes binnen [volledige naam] horen bij de naam.
    kern, data, rollen = naam, None, []
    while (m := re.search(r'\s*\(([^()\[\]]*)\)\s*$', kern)):
        inhoud, kern = m.group(1), kern[:m.start()].strip()
        if re.search(r'\d', inhoud):
            data = inhoud
        else:
            rollen = [r.strip() for r in re.split(r'[,;]| en ', inhoud) if r.strip()] + rollen
    achternaam, _, rest = kern.partition(', ')
    rest_zonder = schoon(re.sub(r'\[[^\]]*\]', '', rest))
    tussen = ' '.join(w for w in rest_zonder.split() if w.islower() or w in ("'t", "'s"))
    voor = ' '.join(w for w in rest_zonder.split() if not (w.islower() or w in ("'t", "'s")))
    weergave = schoon(f'{voor} {tussen} {achternaam}') if rest else achternaam
    return {'naam': kern, 'weergave': weergave, 'achternaam': achternaam, 'data': data, 'rollen': rollen}


def plaats(tekst):
    """'Aagtekerke (gemeente Veere) (Z)' of 'Aa en Hunze, gemeente (D) zie …'."""
    naam = naamdeel(tekst)
    afk = re.search(r'\((U|NB|O|Gr|Gld|F|D|L|Z|ZH|NH|Fl)\)', naam)
    gemeente = re.search(r'\(gemeente ([^()]*)\)', naam)
    is_gemeente = bool(re.search(r',\s*gemeente\b', naam))
    kern = schoon(re.sub(r'\([^()]*\)|,\s*gemeente\b.*', '', naam))
    zie = re.search(r'\bzie(?: ook)?\s+(.+?)(?=\s+(?:NH|ZH|NB|Gld|Gr|Fl|U|O|F|D|L|Z)\s\d|$)', tekst)
    return {'naam': kern, 'weergave': kern, 'gemeente': gemeente.group(1) if gemeente else None,
            'afk': afk.group(1) if afk else None, 'is_gemeente': is_gemeente,
            'zie': [schoon(z) for z in zie.group(1).split(',')] if zie else []}


def object_(tekst):
    """'Aalshorst, De' → 'De Aalshorst'; 'Aalbeek, landhuis' → 'Aalbeek, landhuis' (zoeknaam 'Aalbeek')."""
    naam = naamdeel(tekst)
    kern, _, rest = naam.partition(', ')
    weergave = f'{rest} {kern}' if rest in ('De', 'Den', 'Het', "'t", 'Ter', 'Te') else naam
    return {'naam': naam, 'weergave': weergave, 'zoeknaam': re.sub(r'\s*\(.*', '', kern)}


# --------------------------------------------------------------------------- omzetten

class Registers:
    def __init__(self, paginas):
        self.paginas = paginas
        self.ds = Dataset()
        self.g = self.ds.graph(GRAPH)
        self.g.bind('schema', SDO)
        self.g.bind('min', MIN)
        self.g.bind('skos', SKOS)
        self.slugs = set()
        self.vermeldingen = 0
        self.rapport = []
        self.telling = collections.Counter()

    def lit(self, s, p, waarde, **kw):
        if waarde not in (None, ''):
            self.g.add((s, p, Literal(waarde, **kw)))

    def uri(self, soort, tekst):
        s = slug(tekst)[:90] or 'x'
        basis, n = s, 2
        while (soort, s) in self.slugs:
            s, n = f'{basis}-{n}', n + 1
        self.slugs.add((soort, s))
        return URIRef(f'{ID}/{soort}/{s}')

    def lijst(self, sleutel):
        titel = REGISTERS[sleutel][1]
        uri = URIRef(f'{ID}/lijst/{sleutel}')
        self.g.add((uri, RDF.type, SDO.DefinedTermSet))
        self.lit(uri, SDO.name, f'Serieregister {titel.lower()}', lang='nl')
        self.lit(uri, RDFS.label, f'Serieregister {titel.lower()}', lang='nl')
        self.g.add((uri, SDO.isPartOf, URIRef(f'{DATASET}/id/serie')))
        self.g.add((uri, MIN.inDeel, URIRef(f'{DATASET}/id/sten009monu12_01')))
        return uri

    def ingang(self, soort, lijst, register, naam, weergave, tekst, verwijs, zoeknamen, typen):
        uri = self.uri(soort, naam)
        for t in typen:
            self.g.add((uri, RDF.type, t))
        self.g.add((uri, RDF.type, MIN.Registeringang))
        self.lit(uri, SDO.name, weergave, lang='nl')
        self.lit(uri, RDFS.label, weergave, lang='nl')
        self.lit(uri, MIN.registernaam, naam)
        self.lit(uri, MIN.registertekst, tekst)
        self.lit(uri, MIN.register, register)
        self.g.add((uri, SDO.inDefinedTermSet, lijst))
        delen_gezien = set()
        for afk, van, tot, opmaak in verwijs:
            if afk not in DELEN:
                continue
            self.vermelding(uri, weergave, afk, van, tot, opmaak, zoeknamen)
            delen_gezien.add(DELEN[afk][1])
        for deel in sorted(delen_gezien):
            self.lit(uri, MIN.deel, deel)
        self.lit(uri, MIN.aantalVermeldingen, len(verwijs), datatype=XSD.integer)
        self.telling[soort] += 1
        return uri

    def vermelding(self, ingang, naam, afk, van, tot, opmaak, zoeknamen):
        code, provincie = DELEN[afk]
        self.vermeldingen += 1
        uri = URIRef(f'{ID}/vermelding/{self.vermeldingen:06d}')
        passages, zekerheid = self.paginas.zoek(code, van, tot, zoeknamen)
        verwijzing = f'{afk} {van}' + (f'-{tot}' if tot != van else '')
        plek = passages[0]['kern'] or self.paginas.hoofdstukken.get(passages[0]['hoofdstuk']) if passages else None
        self.g.add((uri, RDF.type, MIN.Vermelding))
        self.g.add((uri, MIN.vanIngang, ingang))
        self.lit(uri, MIN.ingangNaam, naam)
        self.lit(uri, SDO.name, f'{naam}: {provincie} p. {van if tot == van else f"{van}–{tot}"}' + (f' ({plek})' if plek else ''), lang='nl')
        self.lit(uri, MIN.verwijzing, verwijzing)
        self.g.add((uri, MIN.inDeel, URIRef(f'{DATASET}/id/{code}')))
        self.lit(uri, MIN.deel, provincie)
        self.lit(uri, SDO.pageStart, str(van))
        self.lit(uri, SDO.pageEnd, str(tot))
        self.lit(uri, MIN.opmaak, opmaak)
        self.lit(uri, MIN.zekerheid, zekerheid)
        self.lit(uri, MIN.kern, plek)
        for p in passages:
            self.g.add((uri, MIN.passage, p['uri']))
        for h in dict.fromkeys(p['hoofdstuk'] for p in passages):
            self.g.add((uri, MIN.inHoofdstuk, h))
        self.telling[f'vermelding {zekerheid}'] += 1
        if zekerheid == 'geen':
            self.rapport.append((str(ingang), naam, verwijzing))

    # -- de vier registers
    def topografie(self, lijst_el):
        lijst = self.lijst('topografie')
        for item in lijst_el.findall('item'):
            tekst = eigen_tekst(item)
            if not tekst:
                continue
            p = plaats(tekst)
            uri = self.ingang('plaats', lijst, REGISTERS['topografie'][1], naamdeel(tekst), p['weergave'], tekst,
                              verwijzingen(item), [p['naam']], [SDO.Place])
            self.lit(uri, MIN.kern, p['naam'])
            self.lit(uri, MIN.gemeenteInRegister, p['gemeente'])
            self.lit(uri, MIN.soortPlaats, 'gemeente' if p['is_gemeente'] else 'plaats')
            if p['afk'] in DELEN:
                provincie = DELEN[p['afk']][1]
                self.lit(uri, MIN.provincie, provincie)
                self.g.add((uri, MIN.heeftProvincie, URIRef(OWMS + PROVINCIES[provincie])))
            for z in p['zie']:
                self.lit(uri, MIN.zie, z)

    def architecten(self, lijst_el):
        lijst = self.lijst('architecten')
        for item in lijst_el.findall('item'):
            tekst = eigen_tekst(item)
            if not tekst:
                continue
            p = persoon(tekst)
            uri = self.ingang('persoon', lijst, REGISTERS['architecten'][1], naamdeel(tekst), p['weergave'], tekst,
                              verwijzingen(item), [p['achternaam']], [SDO.Person])
            self.lit(uri, MIN.levensdata, p['data'])
            for rol in p['rollen']:
                self.lit(uri, MIN.rol, rol)

    def objecten(self, lijst_el):
        lijst = self.lijst('objecten')
        for item in lijst_el.findall('item'):
            tekst = eigen_tekst(item)
            if not tekst:
                continue
            o = object_(tekst)
            self.ingang('object', lijst, REGISTERS['objecten'][1], o['naam'], o['weergave'], tekst,
                        verwijzingen(item), [o['zoeknaam']], [SDO.Place])

    def categorieen(self, lijst_el):
        lijst = self.lijst('categorieen')

        def loop(lijst_el, ouder, pad):
            for item in lijst_el.findall('item'):
                tekst = eigen_tekst(item)
                naam = naamdeel(tekst).lstrip('-').strip()
                if not naam:
                    continue
                zoek = [re.sub(r'\s*\(.*|;.*', '', naam)]
                uri = self.ingang('categorie', lijst, REGISTERS['categorieen'][1], ' › '.join(pad + [naam]), naam, tekst,
                                  verwijzingen(item), zoek, [SDO.DefinedTerm, SKOS.Concept])
                self.lit(uri, MIN.categoriepad, ' › '.join(pad + [naam]))
                if ouder is not None:
                    self.g.add((uri, SKOS.broader, ouder))
                for sub in item.findall('list'):
                    loop(sub, uri, pad + [naam])

        # Dertien hoofdgroepen ('1. Verdedigen (verdediging)', '2. Geloven (religie)', …): de eerste staat als
        # tweede kop in de div zelf, de rest als sectie met een eigen kop. Elke hoofdgroep heeft een lijst.
        groepen = [(lijst_el.findall('head')[-1], lijst_el.find('list'))]
        groepen += [(sub.find('head'), sub.find('list')) for sub in lijst_el.findall('div') if sub.find('head') is not None]
        for kop, lijst_groep in groepen:
            if kop is None or lijst_groep is None:
                continue
            naam = re.sub(r'^\d+\.\s*', '', schoon(''.join(kop.itertext())))
            groep = self.ingang('categorie', lijst, REGISTERS['categorieen'][1], naam, naam, naam, [], [], [SDO.DefinedTerm, SKOS.Concept])
            self.lit(groep, MIN.categoriepad, naam)
            loop(lijst_groep, groep, [naam])


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = etree.XMLParser(load_dtd=False, no_network=True, resolve_entities=False, recover=True)
    boom = etree.parse(str(DEEL12), parser)
    divs = {schoon(''.join(d.find('head').itertext())): d for d in boom.iter('div') if d.find('head') is not None}

    print('pagina\'s van de delen inlezen…', file=sys.stderr)
    r = Registers(Paginas())
    r.topografie(divs[REGISTERS['topografie'][0]].find('list'))
    r.architecten(divs[REGISTERS['architecten'][0]].find('list'))
    r.objecten(divs[REGISTERS['objecten'][0]].find('list'))
    r.categorieen(divs[REGISTERS['categorieen'][0]])

    uit = PROJECT / 'output'
    r.ds.serialize(destination=str(uit / 'registers.trig'), format='trig', encoding='utf-8')
    with open(uit / 'registers-zonder-passage.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f, delimiter=';')
        w.writerow(['ingang', 'naam', 'verwijzing'])
        w.writerows(r.rapport)
    print(f'registers: {len(r.g)} triples in <{GRAPH}>')
    print('  ' + ', '.join(f'{k}: {v}' for k, v in sorted(r.telling.items())))
    print(f'  → {uit / "registers.trig"}')


if __name__ == '__main__':
    main()
