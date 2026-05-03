import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { feature, merge } from "topojson-client";
import { topology } from "topojson-server";
import type { Polygon, MultiPolygon, Topology } from "topojson-specification";

type Feature = {
  type: "Feature";
  properties?: Record<string, unknown>;
  geometry: unknown;
};

type FeatureCollection = {
  type: "FeatureCollection";
  features: Feature[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const defaultInput = path.join(rootDir, "data", "source-plz.geojson");
const fallbackInput = path.join(rootDir, "public", "data", "germany-plz.topojson.br");
const sourcePath = path.resolve(process.argv[2] ?? (fs.existsSync(defaultInput) ? defaultInput : fallbackInput));
const outTopoJson = path.join(rootDir, "public", "data", "germany-plz.topojson");
const outPostalCodes = path.join(rootDir, "public", "data", "postal-codes.json");
const mirrorTopoJson = path.join(rootDir, "data", "germany-plz.topojson");
const mirrorPostalCodes = path.join(rootDir, "data", "postal-codes.json");
const prefixLevels = [1, 2, 3, 4] as const;

const candidates = ["postal_code", "plz", "postcode", "name"];
const quantization = 10_000;

function readSource(filePath: string): FeatureCollection {
  if (!fs.existsSync(filePath)) {
    throw new Error(`PLZ source file not found: ${filePath}`);
  }

  const raw = filePath.endsWith(".br")
    ? zlib.brotliDecompressSync(fs.readFileSync(filePath)).toString("utf8")
    : fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (isFeatureCollection(parsed)) {
    return parsed;
  }

  if (isTopology(parsed)) {
    const objectName = Object.keys(parsed.objects)[0];
    const collection = feature(parsed as never, parsed.objects[objectName] as never);
    if (isFeatureCollection(collection)) {
      return collection;
    }
  }

  throw new Error("Expected a GeoJSON FeatureCollection or TopoJSON Topology input.");
}

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { type?: string }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

function isTopology(value: unknown): value is { type: "Topology"; objects: Record<string, unknown> } {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { type?: string }).type === "Topology" &&
    (value as { objects?: unknown }).objects &&
    typeof (value as { objects?: unknown }).objects === "object"
  );
}

function detectPostalCode(properties: Record<string, unknown> | undefined): string | null {
  if (!properties) {
    return null;
  }

  for (const key of candidates) {
    const raw = properties[key];
    if (raw === undefined || raw === null) {
      continue;
    }

    const match = String(raw).match(/\b\d{5}\b/);
    if (match) {
      return match[0];
    }
  }

  return null;
}

function compressJson(json: string): Buffer {
  return zlib.brotliCompressSync(Buffer.from(json), {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11
    }
  });
}

function writeTopoJsonPair(publicPath: string, mirrorPath: string, json: string): void {
  const compressed = compressJson(json);
  fs.writeFileSync(publicPath, json);
  fs.writeFileSync(`${publicPath}.br`, compressed);
  fs.writeFileSync(mirrorPath, json);
  fs.writeFileSync(`${mirrorPath}.br`, compressed);
}

function prefixTopoJsonPath(level: number, baseDir: string): string {
  return path.join(baseDir, `germany-plz-${level}.topojson`);
}

function buildPrefixCollection(topo: Topology, sortedCodes: string[]): FeatureCollection[] {
  const postalCodesObject = topo.objects.postal_codes;
  if (!postalCodesObject || postalCodesObject.type !== "GeometryCollection") {
    throw new Error("Expected normalized postal_codes TopoJSON object to be a GeometryCollection.");
  }

  const geometriesByPostalCode = new Map<string, Array<Polygon | MultiPolygon>>();
  for (const geometry of postalCodesObject.geometries) {
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
      continue;
    }

    const postalCode = typeof geometry.properties?.postal_code === "string" ? geometry.properties.postal_code : null;
    if (postalCode) {
      const geometries = geometriesByPostalCode.get(postalCode) ?? [];
      geometries.push(geometry as Polygon | MultiPolygon);
      geometriesByPostalCode.set(postalCode, geometries);
    }
  }

  return prefixLevels.map((level) => {
    const codesByPrefix = new Map<string, { geometries: Array<Polygon | MultiPolygon>; postalCodeCount: number }>();
    for (const postalCode of sortedCodes) {
      const postalCodeGeometries = geometriesByPostalCode.get(postalCode);
      if (!postalCodeGeometries) {
        continue;
      }

      const prefix = postalCode.slice(0, level);
      const prefixEntry = codesByPrefix.get(prefix) ?? { geometries: [], postalCodeCount: 0 };
      prefixEntry.geometries.push(...postalCodeGeometries);
      prefixEntry.postalCodeCount += 1;
      codesByPrefix.set(prefix, prefixEntry);
    }

    const features = [...codesByPrefix.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([prefix, entry]) => ({
      type: "Feature" as const,
      properties: {
        postal_code: prefix,
        plz_level: level,
        postal_code_count: entry.postalCodeCount
      },
      geometry: merge(topo, entry.geometries)
    }));

    return {
      type: "FeatureCollection",
      features
    };
  });
}

function normalize(collection: FeatureCollection): void {
  const postalCodes = new Set<string>();
  const features = collection.features.flatMap((feature) => {
    const postalCode = detectPostalCode(feature.properties);
    if (!postalCode) {
      return [];
    }

    postalCodes.add(postalCode);
    return [{
      ...feature,
      properties: {
        postal_code: postalCode
      }
    }];
  });

  if (features.length === 0) {
    throw new Error("No features with a detectable 5-digit postal code were found.");
  }

  fs.mkdirSync(path.dirname(outTopoJson), { recursive: true });
  fs.mkdirSync(path.dirname(mirrorTopoJson), { recursive: true });

  const normalized = {
    type: "FeatureCollection",
    features
  } satisfies FeatureCollection;

  const topo = topology({ postal_codes: normalized }, quantization);
  const sortedCodes = [...postalCodes].sort();
  const topoJson = `${JSON.stringify(topo)}\n`;

  writeTopoJsonPair(outTopoJson, mirrorTopoJson, topoJson);
  fs.writeFileSync(outPostalCodes, `${JSON.stringify(sortedCodes, null, 2)}\n`);
  fs.writeFileSync(mirrorPostalCodes, `${JSON.stringify(sortedCodes, null, 2)}\n`);

  const prefixCollections = buildPrefixCollection(topo, sortedCodes);
  for (const [index, prefixCollection] of prefixCollections.entries()) {
    const level = prefixLevels[index];
    const prefixTopo = topology({ postal_code_prefixes: prefixCollection }, quantization);
    const prefixTopoJson = `${JSON.stringify(prefixTopo)}\n`;
    writeTopoJsonPair(
      prefixTopoJsonPath(level, path.join(rootDir, "public", "data")),
      prefixTopoJsonPath(level, path.join(rootDir, "data")),
      prefixTopoJson
    );
  }

  console.log(`Generated ${features.length} PLZ polygons and ${sortedCodes.length} postal codes with ${quantization} quantization.`);
  console.log(`Generated PLZ prefix TopoJSON levels ${prefixLevels.join(", ")} in public/data and data mirrors.`);
}

normalize(readSource(sourcePath));
