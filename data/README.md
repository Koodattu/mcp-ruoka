# Finnish postal lookup

`postal-areas.json` contains 3,785 postal records with Finnish/Swedish locality and municipality names, plus coordinates where the supplied area data has a matching postal code. Runtime lookup needs only this derived file; it does not read Clevoy or require proj4.

The user-supplied `FI.json` and `FI_PNO.json` were copied unchanged from Clevoy into this project's ignored `.cache/postal-source/` directory on 2026-10-31. No Clevoy files were edited. Their original download dates were not independently verified. The copies' SHA-256 hashes are embedded in the generated file:

- FI.json: `6bae4ec690b935d50c0f9745280590f522dfde6306944f55cd849b715ebc02da`
- FI_PNO.json: `1cb62011e90dcc5a51ca1f54407ff161d6950b24eb7ac149a15c8dc31fc78585`

FI's record date is 2026-03-18. FI_PNO's response timestamp is 2026-03-24T14:52:06.998Z and its area year is 2026. These are snapshots, not an automatically refreshed postal service.

## Sources and attribution

Postal names and municipality associations follow the Posti postal-file structure. See [Posti's source service](https://www.posti.fi/yrityksille/asiakastuki/postinumerotiedostot) and the accompanying [service description and terms](licenses/posti-postal-service-description-and-terms.pdf), downloaded from that page on 2026-10-31. The supplied JSON is a conversion, not Posti's original fixed-width file; its conversion history was not verified.

Area reference points: **Lähde: Tilastokeskus**, [Paavo postal-area spatial data](https://stat.fi/fi/palvelut/tilastodatapalvelut/paikkatietoaineistot/postinumeroalueittainen-paikkatieto-paavo), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) as described in [Statistics Finland's terms](https://stat.fi/fi/tietoa-meista/tutustu-tilastokeskukseen/lainsaadanto/kayttoehdot).

Changes made here: retain only postal/locality/municipality fields and representative land points; transform ETRS-TM35FIN (EPSG:3067) points to WGS84 (EPSG:4326); join by postal code. Polygons and demographic attributes are omitted. The points are within postal areas, not necessarily their centroids. Missing coordinates remain null. A postal code's principal municipality is not a precise municipal-boundary test.

## Rebuild

```powershell
node scripts/build-postal-data.ts
# Or pass a directory containing copies of FI.json and FI_PNO.json:
node scripts/build-postal-data.ts PATH_TO_COPIES
```

The script reads its inputs and writes `data/postal-areas.json` relative to the current project directory. Install dev dependencies to regenerate (proj4 is used only by this script). Keep the provenance, source dates and accompanying terms with any redistributed lookup.
