# PLZ Survey Map

A lightweight single-question survey app with real-time German postal-code map visualization. Survey answers are joined to local PLZ polygons by `postal_code`; the app does not geocode or reverse-geocode responses at runtime.

## Stack

- Node.js, TypeScript, Fastify
- SQLite via `better-sqlite3`
- Zod request validation
- Server-Sent Events for live aggregate updates
- Vite, React, MapLibre GL JS

## Development

```bash
npm install
npm run dev
```

The Vite app runs on `http://localhost:5173` and proxies `/api` to the Fastify server on `http://localhost:3000`.

Useful scripts:

```bash
npm test
npm run build
npm start
npm run prepare:plz -- data/source-plz.geojson
```

## Configuration

Environment variables:

- `PORT`, default `3000`
- `SQLITE_PATH`, default `survey.sqlite`
- `ADMIN_TOKEN`, default `dev-admin-token`
- `PUBLIC_BASE_URL`, optional
- `RESPONSE_RATE_LIMIT_WINDOW`, default `60000`
- `RESPONSE_RATE_LIMIT_MAX`, default `20`
- `MIN_PUBLIC_RESPONSES_PER_PLZ`, default `1`

Use `ADMIN_TOKEN` in either an `Authorization: Bearer <token>` header or an `x-admin-token` header for admin endpoints.

## PLZ Data

The app loads PLZ polygons from `public/data/germany-plz.topojson`. If that plain file is not present, both the Vite dev server and the production Fastify server serve `public/data/germany-plz.topojson.br` at the same URL with Brotli content encoding.

Recommended MVP source: [`yetzt/postleitzahlen`](https://github.com/yetzt/postleitzahlen), which publishes German postcode areas in compressed GeoJSON/TopoJSON formats derived from OpenStreetMap.

To normalize and quantize a GeoJSON or TopoJSON source file:

```bash
npm run prepare:plz -- data/source-plz.geojson
```

The script detects `postal_code`, `plz`, `postcode`, or `name`, extracts a 5-digit PLZ, rewrites each feature to `properties.postal_code`, quantizes the topology, and generates:

- `public/data/germany-plz.topojson`
- `public/data/germany-plz.topojson.br`
- `public/data/postal-codes.json`

When `data/source-plz.geojson` is absent, the script can bootstrap from `public/data/germany-plz.topojson.br`.

## Privacy And Map Notes

- The public workflow stores only `survey_id`, `postal_code`, `rating`, and timestamp.
- No street address, GPS coordinate, exact user location, Nominatim request, or runtime geocoding API is used.
- Public aggregate display can be guarded with `MIN_PUBLIC_RESPONSES_PER_PLZ`.
- The core MVP map uses local PLZ polygons and does not require public OpenStreetMap raster tile servers.

## Attribution

If using OSM-derived PLZ boundaries, include attribution to OpenStreetMap contributors and comply with the Open Database License. The yetzt dataset documents its OpenStreetMap source and import process. Geofabrik postcode polygons are another production option: https://www.geofabrik.de/data/postalcodes.html.
