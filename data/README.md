# PLZ Source Data

Place a source Germany postal-code polygon file at `data/source-plz.geojson`, or pass a GeoJSON or TopoJSON source path to:

```bash
npm run prepare:plz -- data/source-plz.geojson
```

The generated app artifacts are written to:

- `public/data/germany-plz.topojson.json`
- `public/data/germany-plz-1.topojson.json` through `public/data/germany-plz-4.topojson.json`
- `public/data/postal-codes.json`

The script quantizes the topology before writing output. If `data/source-plz.geojson` is absent, it can bootstrap from `public/data/germany-plz.topojson.json`.
