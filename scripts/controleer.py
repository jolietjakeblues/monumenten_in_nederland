#!/usr/bin/env python3
"""Controleert de TriG-bestanden in output/: per deel de aantallen en een paar dingen die mis kunnen gaan.

Gebruik: python scripts/controleer.py
"""
import collections
import csv
import sys
from pathlib import Path

from rdflib import Dataset, Namespace
from rdflib.namespace import RDF

PROJECT = Path(__file__).resolve().parent.parent
SDO = Namespace('https://schema.org/')
MIN = Namespace('https://linkeddata.cultureelerfgoed.nl/def/monumenten-in-nederland#')


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    print(f"{'deel':<14}{'triples':>8}{'kernen':>7}{'zonder gem.':>12}{'passages':>9}{'lemma':>7}{'afb.':>6}{'termen':>7}"
          f"{'adressen':>9}{'gekoppeld':>10}  opmerkingen")
    for trig in sorted((PROJECT / 'output').glob('*.trig')):
        if trig.stem == 'registers':
            continue  # serieregisters: zie scripts/registers.py
        ds = Dataset()
        ds.parse(trig, format='trig')
        g = next(c for c in ds.graphs() if len(c))
        kernen = set(g.subjects(RDF.type, MIN.Kern))
        zonder = sorted(str(g.value(k, MIN.kern)) for k in kernen if g.value(k, MIN.heeftGemeente) is None)
        passages = set(g.subjects(RDF.type, MIN.Passage))
        soorten = collections.Counter(str(g.value(p, MIN.soort)) for p in passages)
        opmerkingen = []
        voorwerk = [h for h in g.subjects(RDF.type, SDO.Chapter) if str(g.value(h, SDO.name)) == 'Voorwerk']
        if len(voorwerk) != 1:
            opmerkingen.append(f'{len(voorwerk)}× Voorwerk')
        leeg = [p for p in passages if not str(g.value(p, SDO.text) or '').strip()]
        if leeg:
            opmerkingen.append(f'{len(leeg)} lege passages')
        groot = [p for p in passages if len(str(g.value(p, SDO.text) or '')) > 60000]
        if groot:
            opmerkingen.append(f'{len(groot)} passages > 60.000 tekens')
        zonder_ouder = [p for p in passages if g.value(p, SDO.isPartOf) is None]
        if zonder_ouder:
            opmerkingen.append(f'{len(zonder_ouder)} passages zonder hoofdstuk')
        rapport = trig.with_name(f'{trig.stem}-koppelingen.csv')
        status = collections.Counter()
        if rapport.exists():
            with open(rapport, encoding='utf-8-sig') as f:
                status = collections.Counter(r['status'] for r in csv.DictReader(f, delimiter=';'))
        print(f"{trig.stem:<14}{len(g):>8}{len(kernen):>7}{len(zonder):>12}{len(passages):>9}{soorten['lemma']:>7}"
              f"{len(set(g.subjects(RDF.type, SDO.ImageObject))):>6}{len(set(g.subjects(RDF.type, SDO.DefinedTerm))):>7}"
              f"{sum(status.values()):>9}{status['gekoppeld']:>10}  {'; '.join(opmerkingen)}")
        if zonder:
            print(f"{'':<14}zonder huidige gemeente: {', '.join(zonder)}")


if __name__ == '__main__':
    main()
