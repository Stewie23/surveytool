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

The checked-in `public/data/germany-plz.topojson` is a tiny development fixture, not a complete Germany dataset. For real use, replace it with a simplified Germany PLZ polygon dataset.

Recommended MVP source: [`yetzt/postleitzahlen`](https://github.com/yetzt/postleitzahlen), which publishes German postcode areas in compressed GeoJSON/TopoJSON formats derived from OpenStreetMap.

To normalize a GeoJSON source file:

```bash
npm run prepare:plz -- data/source-plz.geojson
```

The script detects `postal_code`, `plz`, `postcode`, or `name`, extracts a 5-digit PLZ, rewrites each feature to `properties.postal_code`, and generates:

- `public/data/germany-plz.topojson`
- `public/data/postal-codes.json`

## Privacy And Map Notes

- The public workflow stores only `survey_id`, `postal_code`, `rating`, and timestamp.
- No street address, GPS coordinate, exact user location, Nominatim request, or runtime geocoding API is used.
- Public aggregate display can be guarded with `MIN_PUBLIC_RESPONSES_PER_PLZ`.
- The core MVP map uses local PLZ polygons and does not require public OpenStreetMap raster tile servers.

## Attribution

If using OSM-derived PLZ boundaries, include attribution to OpenStreetMap contributors and comply with the Open Database License. The yetzt dataset documents its OpenStreetMap source and import process. Geofabrik postcode polygons are another production option: https://www.geofabrik.de/data/postalcodes.html.
