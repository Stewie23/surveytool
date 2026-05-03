# PLZ Source Data

Place a source Germany postal-code polygon file at `data/source-plz.geojson`, or pass a GeoJSON or TopoJSON source path to:

```bash
npm run prepare:plz -- data/source-plz.geojson
```

The generated app artifacts are written to:

- `public/data/germany-plz.topojson`
- `public/data/germany-plz.topojson.br`
- `public/data/postal-codes.json`

The script quantizes the topology before writing output. If `data/source-plz.geojson` is absent, it can bootstrap from the precompressed asset at `public/data/germany-plz.topojson.br`. The dev and production servers expose that asset at `/data/germany-plz.topojson` with Brotli content encoding when the plain TopoJSON file is absent.
