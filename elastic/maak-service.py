#!/usr/bin/env python3
"""Maakt elastic/elastic-service.json: de configuratie van de Elasticsearch-service op
rce/monumenten-in-nederland, als volledig POST-bestand (type, naam, config).

Opzet en taalanalyse zijn overgenomen van C:\\AI\\elastic-ceo\\triply\\maak-service.mjs.
nl-analyse.json is een kopie van C:\\AI\\elastic-ceo\\triply\\nl-analyse.json (zie daar
docs/taalanalyse.md). Hier komt alleen een eigen normalizer bij voor de soort uit de URI.

Gebruik: python elastic/maak-service.py
"""
import json
from pathlib import Path

MAP = Path(__file__).resolve().parent
NAAM = 'monumenten-in-nederland'

analysis = json.loads((MAP / 'nl-analyse.json').read_text(encoding='utf-8'))
# Soort uit onze URI's: …/id/<deel>/passage/00451 → passage, …/id/<deel> → deel, …/id/serie → serie
analysis['char_filter'] |= {
    'min_soort_uit_uri': {'type': 'pattern_replace', 'pattern': '^.*/id/[^/]+/([a-z]+)/[^/]*$', 'replacement': '$1'},
    'min_soort_deel': {'type': 'pattern_replace', 'pattern': '^.*/id/sten[^/]*$', 'replacement': 'deel'},
    'min_soort_serie': {'type': 'pattern_replace', 'pattern': '^.*/id/serie$', 'replacement': 'serie'},
}
analysis['normalizer']['min_soort'] = {
    'type': 'custom',
    'char_filter': ['min_soort_uit_uri', 'min_soort_deel', 'min_soort_serie'],
    'filter': ['lowercase'],
}

# Veldnaam in Elastic: property-IRI met een spatie in plaats van elke punt
SDO = 'https://schema org/'
MIN = 'https://linkeddata cultureelerfgoed nl/def/monumenten-in-nederland#'
RDF_TYPE = 'http://www w3 org/1999/02/22-rdf-syntax-ns#type'
LABEL = 'http://www w3 org/2000/01/rdf-schema#label'

# Tekst met Nederlandse analyse, plus .keyword en .exact. Ook de dynamic template.
TEKST = [SDO + 'text', SDO + 'name', SDO + 'caption', SDO + 'description', LABEL,
         MIN + 'lemma', MIN + 'hoofdstuk']

# Korte tekst zonder taalverwerking, plus .keyword: plaats, adres, deel.
# Anders vindt "kerk" ook Lekkerkerk en de Kerkstraat.
KORT = [MIN + n for n in ('kern', 'alternatieveNaam', 'gemeenteInBoek', 'gemeente', 'woonplaats',
                          'provincie', 'deel', 'adres', 'beeldcode')] + \
       [SDO + n for n in ('identifier', 'pagination', 'author', 'publisher', 'datePublished')]

# Nummers: korte tekst + .keyword + .getal (long), om op nummer te sorteren
NUMMER = [MIN + 'rijksmonumentnummer', SDO + 'pageStart', SDO + 'pageEnd']

# URI's en vaste waarden: alleen exact filteren (term, terms)
URI = [RDF_TYPE, MIN + 'soort'] + \
      [SDO + n for n in ('isPartOf', 'image', 'url', 'contentUrl', 'inDefinedTermSet')] + \
      [MIN + n for n in ('inDeel', 'heeftGemeente', 'heeftProvincie', 'noemtRijksmonument')]

GETAL = [MIN + 'volgnummer', SDO + 'position']

alle = TEKST + KORT + NUMMER + URI + GETAL
dubbel = sorted({v for v in alle if alle.count(v) > 1})
if dubbel:
    raise SystemExit(f'dubbel: {dubbel}')

keyword = {'type': 'keyword', 'ignore_above': 256}
tekst = {'type': 'text', 'analyzer': 'nl_index', 'search_analyzer': 'nl_zoeken',
         'fields': {'keyword': keyword, 'exact': {'type': 'text', 'analyzer': 'nl_exact'}}}
kort = {'type': 'text', 'analyzer': 'nl_exact', 'fields': {'keyword': keyword}}
nummer = {'type': 'text', 'analyzer': 'nl_exact',
          'fields': {'keyword': keyword, 'getal': {'type': 'long', 'ignore_malformed': True}}}
uri = {'type': 'keyword', 'ignore_above': 1024}
getal = {'type': 'integer', 'ignore_malformed': True}


def velden(namen, mapping):
    return {n: mapping for n in namen}


config = {
    'type': 'elasticSearch',
    'name': NAAM,
    'config': {
        'indexTemplates': [
            {'name': NAAM, 'index_patterns': 'index', 'composed_of': ['min-tekst', 'min-typen']},
        ],
        'componentTemplates': [
            {
                # alles wat een analyzer of normalizer gebruikt, staat bij de settings die ze definiëren
                # (een component template wordt los gevalideerd)
                'name': 'min-tekst',
                'template': {
                    'settings': {'analysis': analysis},
                    'mappings': {
                        'dynamic_templates': [{'tekst_nl': {'match_mapping_type': 'string', 'mapping': tekst}}],
                        'properties': {
                            '@id': {'type': 'text', 'fields': {'keyword': keyword,
                                                               'soort': {'type': 'keyword', 'normalizer': 'min_soort'}}},
                            **velden(TEKST, tekst),
                            **velden(KORT, kort),
                            **velden(NUMMER, nummer),
                        },
                    },
                },
            },
            {
                'name': 'min-typen',
                'template': {'mappings': {'properties': {**velden(URI, uri), **velden(GETAL, getal)}}},
            },
        ],
    },
}

uit = MAP / 'elastic-service.json'
uit.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'elastic/elastic-service.json: {len(alle) + 1} velden (tekst {len(TEKST)}, kort {len(KORT)}, '
      f'nummer {len(NUMMER)}, uri {len(URI)}, getal {len(GETAL)}, @id)')
