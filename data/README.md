# PLZ Source Data

Place a source Germany postal-code polygon file at `data/source-plz.geojson`, or pass a source path to:

```bash
npm run prepare:plz -- data/source-plz.geojson
```

The generated app artifacts are written to:

- `public/data/germany-plz.topojson`
- `public/data/postal-codes.json`

The checked-in dataset is a tiny development fixture only. Replace it with a real simplified Germany PLZ dataset before using the app beyond local testing.
