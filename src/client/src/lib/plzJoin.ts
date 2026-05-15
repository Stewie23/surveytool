import { feature } from "topojson-client";
import type { Aggregate, MapLodLevel } from "../../../shared/types";

type FeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;
export type PlzLevel = MapLodLevel;
export const ALL_PLZ_LEVELS: PlzLevel[] = [1, 2, 3, 4, 5];

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

export function normalizePlzPrefix(properties: Record<string, unknown> = {}, level: PlzLevel): string | null {
  const postalCode = normalizePostalCode(properties);
  if (postalCode) return postalCode.slice(0, level);

  for (const key of propertyCandidates) {
    const raw = properties[key];
    if (raw === undefined || raw === null) continue;
    const match = String(raw).match(new RegExp(`\\b\\d{${level}}\\b`));
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
  aggregates: Aggregate[],
  level: PlzLevel = 5
): FeatureCollection {
  const levelAggregates = aggregateToPlzLevel(aggregates, level);
  const byPostalCode = new Map(levelAggregates.map((aggregate) => [aggregate.postal_code, aggregate]));
  return {
    ...collection,
    features: collection.features.map((item) => {
      const postalCode = normalizePlzPrefix(item.properties ?? {}, level) ?? "";
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

export function aggregateToPlzLevel(aggregates: Aggregate[], level: PlzLevel): Aggregate[] {
  if (level === 5) {
    return aggregates.map((aggregate) => ({ ...aggregate }));
  }

  const groups = new Map<string, { question_id: string; postal_code: string; count: number; sum: number }>();
  for (const aggregate of aggregates) {
    const postalCode = aggregate.postal_code.match(/^\d{5}$/) ? aggregate.postal_code : null;
    if (!postalCode) continue;

    const prefix = postalCode.slice(0, level);
    const key = `${aggregate.question_id}:${prefix}`;
    const group = groups.get(key) ?? { question_id: aggregate.question_id, postal_code: prefix, count: 0, sum: 0 };
    group.count += aggregate.count;
    group.sum += aggregate.sum;
    groups.set(key, group);
  }

  return Array.from(groups.values(), (group) => ({
    question_id: group.question_id,
    postal_code: group.postal_code,
    count: group.count,
    average: group.count > 0 ? group.sum / group.count : null,
    sum: group.sum,
    hidden: false
  })).sort((left, right) => left.question_id.localeCompare(right.question_id) || left.postal_code.localeCompare(right.postal_code));
}

export function plzLevelForZoom(zoom: number): PlzLevel {
  if (zoom < 5) return 1;
  if (zoom < 6.5) return 2;
  if (zoom < 8) return 3;
  if (zoom < 9.5) return 4;
  return 5;
}

export function normalizePlzLevels(levels: readonly number[] | null | undefined, useAggregatedShapes = false): PlzLevel[] {
  const fallback: PlzLevel[] = useAggregatedShapes ? [...ALL_PLZ_LEVELS] : [5];
  const selected = (levels ?? []).filter((level): level is PlzLevel =>
    level === 1 || level === 2 || level === 3 || level === 4 || level === 5
  );
  const unique = Array.from(new Set(selected));
  return unique.length > 0 ? unique.sort((left, right) => left - right) : fallback;
}

export function coarsestPlzLevel(levels: readonly PlzLevel[]): PlzLevel {
  return levels.reduce((coarsest, level) => Math.min(coarsest, level) as PlzLevel, 5);
}

export function nearestEnabledPlzLevel(desired: PlzLevel, enabledLevels: readonly PlzLevel[]): PlzLevel {
  const levels = normalizePlzLevels(enabledLevels);
  const firstLevel = levels[0] ?? 5;
  return levels.reduce((best, level) => {
    const bestDistance = Math.abs(best - desired);
    const distance = Math.abs(level - desired);
    if (distance < bestDistance) return level;
    if (distance === bestDistance && level > best) return level;
    return best;
  }, firstLevel);
}

export function plzSourcePath(level: PlzLevel): string {
  return level === 5 ? "/data/germany-plz.topojson.json" : `/data/germany-plz-${level}.topojson.json`;
}

function normalizeFeatures(collection: FeatureCollection): FeatureCollection {
  return {
    ...collection,
    features: collection.features.map((item) => {
      const properties = item.properties ?? {};
      const level = readPlzLevel(properties);
      return {
        ...item,
        properties: {
          ...properties,
          postal_code: level ? normalizePlzPrefix(properties, level) ?? "" : normalizePostalCode(properties) ?? ""
        }
      };
    })
  };
}

function readPlzLevel(properties: Record<string, unknown>): PlzLevel | null {
  const raw = properties.plz_level;
  const level = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return level === 1 || level === 2 || level === 3 || level === 4 || level === 5 ? level : null;
}
