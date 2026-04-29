# PLZ Source Data

Place a source Germany postal-code polygon file at `data/source-plz.geojson`, or pass a source path to:

```bash
npm run prepare:plz -- data/source-plz.geojson
```

The generated app artifacts are written to:

- `public/data/germany-plz.topojson`
- `public/data/postal-codes.json`

The app can also use a precompressed TopoJSON release asset at `public/data/germany-plz.topojson.br`. The dev and production servers expose it at `/data/germany-plz.topojson` with Brotli content encoding when the plain TopoJSON file is absent.
