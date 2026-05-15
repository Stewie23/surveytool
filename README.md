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
- `ADMIN_PASSWORD`, falls back to `ADMIN_TOKEN` if unset
- `ADMIN_TOKEN`, default `dev-admin-token`
- `PUBLIC_BASE_URL`, optional
- `RESPONSE_RATE_LIMIT_WINDOW`, default `60000`
- `RESPONSE_RATE_LIMIT_MAX`, default `20`
- `MIN_PUBLIC_RESPONSES_PER_PLZ`, default `1`

Set `ADMIN_PASSWORD` in a local `.env` file or server environment to protect the admin page with a browser-session login. `.env` is ignored by git. `ADMIN_TOKEN` is retained as a legacy compatibility token for admin endpoints via either an `Authorization: Bearer <token>` header or an `x-admin-token` header.

## PLZ Data

The app loads PLZ polygons from `public/data/germany-plz.topojson.json` and lower-detail LOD files named `public/data/germany-plz-1.topojson.json` through `public/data/germany-plz-4.topojson.json`.
Admins can choose which map LODs are available to the public map. LOD `5` is the full-detail file, and LODs `1` through `4` use the matching lower-detail files. Selections can be non-contiguous, and the map falls back to the nearest enabled LOD when zooming.

Recommended MVP source: [`yetzt/postleitzahlen`](https://github.com/yetzt/postleitzahlen), which publishes German postcode areas in compressed GeoJSON/TopoJSON formats derived from OpenStreetMap.

To normalize and quantize a GeoJSON or TopoJSON source file:

```bash
npm run prepare:plz -- data/source-plz.geojson
```

The script detects `postal_code`, `plz`, `postcode`, or `name`, extracts a 5-digit PLZ, rewrites each feature to `properties.postal_code`, quantizes the topology, and generates:

- `public/data/germany-plz.topojson.json`
- `public/data/germany-plz-1.topojson.json` through `public/data/germany-plz-4.topojson.json`
- `public/data/postal-codes.json`

When `data/source-plz.geojson` is absent, the script can bootstrap from `public/data/germany-plz.topojson.json`.

## Privacy And Map Notes

- The public workflow stores only `survey_id`, `postal_code`, `rating`, and timestamp.
- No street address, GPS coordinate, exact user location, Nominatim request, or runtime geocoding API is used.
- Public aggregate display can be guarded with `MIN_PUBLIC_RESPONSES_PER_PLZ`.
- The core MVP map uses local PLZ polygons and does not require public OpenStreetMap raster tile servers.

## Attribution

If using OSM-derived PLZ boundaries, include attribution to OpenStreetMap contributors and comply with the Open Database License. The yetzt dataset documents its OpenStreetMap source and import process. Geofabrik postcode polygons are another production option: https://www.geofabrik.de/data/postalcodes.html.
