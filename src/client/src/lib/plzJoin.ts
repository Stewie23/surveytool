import { feature } from "topojson-client";
import type { Aggregate } from "../../../shared/types";

type FeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;

const propertyCandidates = ["postal_code", "plz", "postcode", "name"];

export function normalizePostalCode(properties: Record<string, unknown> = {}): string | null {
  for (const key of propertyCandidates) {
    const raw = properties[key];
    if (raw === undefined || raw === null) continue;
    const match = String(raw).match(/\b\d{5}\b/);
    if (match) return match[0];
  }
  return null;
}

export function toFeatureCollection(input: unknown): FeatureCollection {
  const candidate = input as { type?: string; objects?: Record<string, unknown> };
  if (candidate.type === "FeatureCollection") {
    return normalizeFeatures(candidate as FeatureCollection);
  }

  if (candidate.type === "Topology" && candidate.objects) {
    const objectName = Object.keys(candidate.objects)[0];
    const converted = feature(candidate as never, candidate.objects[objectName] as never) as FeatureCollection;
    return normalizeFeatures(converted);
  }

  throw new Error("Unsupported PLZ data format");
}

export function joinAggregates(
  collection: FeatureCollection,
  aggregates: Aggregate[]
): FeatureCollection {
  const byPostalCode = new Map(aggregates.map((aggregate) => [aggregate.postal_code, aggregate]));
  return {
    ...collection,
    features: collection.features.map((item) => {
      const postalCode = normalizePostalCode(item.properties ?? {}) ?? "";
      const aggregate = byPostalCode.get(postalCode);
      return {
        ...item,
        properties: {
          ...(item.properties ?? {}),
          postal_code: postalCode,
          count: aggregate?.count ?? 0,
          average: aggregate?.average ?? null,
          sum: aggregate?.sum ?? 0,
          hidden: aggregate?.hidden ?? false
        }
      };
    })
  };
}

function normalizeFeatures(collection: FeatureCollection): FeatureCollection {
  return {
    ...collection,
    features: collection.features.map((item) => ({
      ...item,
      properties: {
        ...(item.properties ?? {}),
        postal_code: normalizePostalCode(item.properties ?? {}) ?? ""
      }
    }))
  };
}
