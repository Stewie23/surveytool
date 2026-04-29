import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topology } from "topojson-server";

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
const sourcePath = path.resolve(process.argv[2] ?? defaultInput);
const outTopoJson = path.join(rootDir, "public", "data", "germany-plz.topojson");
const outPostalCodes = path.join(rootDir, "public", "data", "postal-codes.json");
const mirrorTopoJson = path.join(rootDir, "data", "germany-plz.topojson");
const mirrorPostalCodes = path.join(rootDir, "data", "postal-codes.json");

const candidates = ["postal_code", "plz", "postcode", "name"];

function readSource(filePath: string): FeatureCollection {
  if (!fs.existsSync(filePath)) {
    throw new Error(`PLZ source file not found: ${filePath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || (parsed as { type?: string }).type !== "FeatureCollection") {
    throw new Error("Expected a GeoJSON FeatureCollection input.");
  }

  return parsed as FeatureCollection;
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

  const topo = topology({ postal_codes: normalized });
  const sortedCodes = [...postalCodes].sort();

  fs.writeFileSync(outTopoJson, `${JSON.stringify(topo)}\n`);
  fs.writeFileSync(outPostalCodes, `${JSON.stringify(sortedCodes, null, 2)}\n`);
  fs.writeFileSync(mirrorTopoJson, `${JSON.stringify(topo)}\n`);
  fs.writeFileSync(mirrorPostalCodes, `${JSON.stringify(sortedCodes, null, 2)}\n`);

  console.log(`Generated ${features.length} PLZ polygons and ${sortedCodes.length} postal codes.`);
}

normalize(readSource(sourcePath));
