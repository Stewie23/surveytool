import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { feature } from "topojson-client";
import { topology } from "topojson-server";
import type { MultiPolygon, Polygon, Topology } from "topojson-specification";

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
const fallbackInput = path.join(rootDir, "public", "data", "germany-plz.topojson.json");
const sourcePath = path.resolve(process.argv[2] ?? (fs.existsSync(defaultInput) ? defaultInput : fallbackInput));
const outTopoJson = path.join(rootDir, "public", "data", "germany-plz.topojson.json");
const outPostalCodes = path.join(rootDir, "public", "data", "postal-codes.json");
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

function levelTopoJsonPath(level: number): string {
  return path.join(rootDir, "public", "data", `germany-plz-${level}.topojson.json`);
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

    const prefixFeatures = [...codesByPrefix.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([prefix, entry]) => ({
      type: "Feature" as const,
      properties: {
        postal_code: prefix,
        plz_level: level,
        postal_code_count: entry.postalCodeCount
      },
      geometry: dissolveGeometries(topo, entry.geometries)
    }));

    return {
      type: "FeatureCollection",
      features: prefixFeatures
    };
  });
}

function dissolveGeometries(topo: Topology, geometries: Array<Polygon | MultiPolygon>): { type: "MultiPolygon"; coordinates: number[][][][] } {
  const arcCounts = new Map<number, number>();
  const rings: number[][] = [];

  function addRing(ring: number[]): void {
    rings.push(ring);
    for (const arc of ring) {
      const arcIndex = arc < 0 ? ~arc : arc;
      arcCounts.set(arcIndex, (arcCounts.get(arcIndex) ?? 0) + 1);
    }
  }

  for (const geometry of geometries) {
    if (geometry.type === "Polygon") {
      geometry.arcs.forEach(addRing);
    } else {
      geometry.arcs.forEach((polygon) => polygon.forEach(addRing));
    }
  }

  const boundaryArcs = rings.flatMap((ring) => ring.filter((arc) => (arcCounts.get(arc < 0 ? ~arc : arc) ?? 0) < 2));
  return {
    type: "MultiPolygon",
    coordinates: classifyBoundaryRings(topo, stitchArcs(topo, boundaryArcs))
  };
}

type RingInfo = {
  coordinates: number[][];
  area: number;
  parent: number | null;
  depth: number | null;
};

function classifyBoundaryRings(topo: Topology, rings: number[][]): number[][][][] {
  const ringInfos: RingInfo[] = rings.map((ring): RingInfo => {
    const coordinates = coordinatesForRing(topo, ring);
    return {
      coordinates,
      area: Math.abs(planarRingArea(coordinates)),
      parent: null,
      depth: null
    };
  }).filter((ring) => ring.coordinates.length >= 4 && ring.area > 0);

  for (const [index, ring] of ringInfos.entries()) {
    const point = ring.coordinates[0];
    let parent: number | null = null;
    let parentArea = Infinity;
    for (const [candidateIndex, candidate] of ringInfos.entries()) {
      if (candidateIndex === index || candidate.area <= ring.area || candidate.area >= parentArea) {
        continue;
      }

      if (pointInRing(point, candidate.coordinates)) {
        parent = candidateIndex;
        parentArea = candidate.area;
      }
    }
    ring.parent = parent;
  }

  function depth(index: number): number {
    const ring = ringInfos[index];
    if (ring.depth !== null) {
      return ring.depth;
    }

    ring.depth = ring.parent === null ? 0 : depth(ring.parent) + 1;
    return ring.depth;
  }

  ringInfos.forEach((_, index) => depth(index));

  return ringInfos.flatMap((ring, index) => {
    if ((ring.depth ?? 0) % 2 !== 0) {
      return [];
    }

    const holes = ringInfos.filter((candidate) => candidate.parent === index && (candidate.depth ?? 0) % 2 === 1).map((candidate) => orientRing(candidate.coordinates, true));
    return [[orientRing(ring.coordinates, false), ...holes]];
  });
}

function coordinatesForRing(topo: Topology, ring: number[]): number[][] {
  const polygon = feature(topo as never, { type: "Polygon", arcs: [ring] } as never) as unknown as { geometry: { coordinates: number[][][] } };
  return polygon.geometry.coordinates[0] ?? [];
}

function planarRingArea(ring: number[][]): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    area += current[0] * next[1] - current[1] * next[0];
  }
  return area / 2;
}

function orientRing(ring: number[][], clockwise: boolean): number[][] {
  const shouldReverse = clockwise ? planarRingArea(ring) > 0 : planarRingArea(ring) < 0;
  return shouldReverse ? [...ring].reverse() : ring;
}

function pointInRing(point: number[], ring: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let currentIndex = 0, previousIndex = ring.length - 1; currentIndex < ring.length; previousIndex = currentIndex, currentIndex += 1) {
    const [currentX, currentY] = ring[currentIndex];
    const [previousX, previousY] = ring[previousIndex];
    if ((currentY > y) !== (previousY > y) && x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX) {
      inside = !inside;
    }
  }
  return inside;
}

function stitchArcs(topo: Topology, arcs: number[]): number[][] {
  const stitchedArcs = new Set<number>();
  const fragmentByStart = new Map<string, number[] & { start?: string; end?: string }>();
  const fragmentByEnd = new Map<string, number[] & { start?: string; end?: string }>();
  const fragments: number[][] = [];
  let emptyIndex = -1;

  arcs.forEach((arc, index) => {
    const points = topo.arcs[arc < 0 ? ~arc : arc];
    if (points.length < 3 && !points[1][0] && !points[1][1]) {
      const current = arcs[++emptyIndex];
      arcs[emptyIndex] = arc;
      arcs[index] = current;
    }
  });

  arcs.forEach((arc) => {
    const [start, end] = arcEnds(topo, arc);
    const appendFragment = fragmentByEnd.get(start);
    const prependFragment = fragmentByStart.get(end);

    if (appendFragment) {
      fragmentByEnd.delete(appendFragment.end ?? "");
      appendFragment.push(arc);
      appendFragment.end = end;
      if (prependFragment) {
        fragmentByStart.delete(prependFragment.start ?? "");
        const combined = prependFragment === appendFragment ? appendFragment : appendFragment.concat(prependFragment) as number[] & { start?: string; end?: string };
        combined.start = appendFragment.start;
        combined.end = prependFragment.end;
        fragmentByStart.set(combined.start ?? "", combined);
        fragmentByEnd.set(combined.end ?? "", combined);
      } else {
        fragmentByStart.set(appendFragment.start ?? "", appendFragment);
        fragmentByEnd.set(appendFragment.end ?? "", appendFragment);
      }
    } else if (prependFragment) {
      fragmentByStart.delete(prependFragment.start ?? "");
      prependFragment.unshift(arc);
      prependFragment.start = start;
      const endFragment = fragmentByEnd.get(start);
      if (endFragment) {
        fragmentByEnd.delete(endFragment.end ?? "");
        const combined = endFragment === prependFragment ? prependFragment : endFragment.concat(prependFragment) as number[] & { start?: string; end?: string };
        combined.start = endFragment.start;
        combined.end = prependFragment.end;
        fragmentByStart.set(combined.start ?? "", combined);
        fragmentByEnd.set(combined.end ?? "", combined);
      } else {
        fragmentByStart.set(prependFragment.start ?? "", prependFragment);
        fragmentByEnd.set(prependFragment.end ?? "", prependFragment);
      }
    } else {
      const fragment = [arc] as number[] & { start?: string; end?: string };
      fragment.start = start;
      fragment.end = end;
      fragmentByStart.set(start, fragment);
      fragmentByEnd.set(end, fragment);
    }
  });

  function flush(source: Map<string, number[]>, target: Map<string, number[]>): void {
    for (const [key, fragment] of source) {
      target.delete((fragment as { start?: string }).start ?? "");
      source.delete(key);
      fragment.forEach((arc) => stitchedArcs.add(arc < 0 ? ~arc : arc));
      fragments.push(fragment);
    }
  }

  flush(fragmentByEnd, fragmentByStart);
  flush(fragmentByStart, fragmentByEnd);
  arcs.forEach((arc) => {
    const arcIndex = arc < 0 ? ~arc : arc;
    if (!stitchedArcs.has(arcIndex)) {
      fragments.push([arc]);
    }
  });

  return fragments;
}

function arcEnds(topo: Topology, arc: number): [string, string] {
  const points = topo.arcs[arc < 0 ? ~arc : arc];
  const start = points[0];
  let end = points[points.length - 1];
  if (topo.transform) {
    end = [0, 0];
    points.forEach((point) => {
      end[0] += point[0];
      end[1] += point[1];
    });
  }

  return arc < 0 ? [String(end), String(start)] : [String(start), String(end)];
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
  fs.mkdirSync(path.dirname(mirrorPostalCodes), { recursive: true });

  const normalized = {
    type: "FeatureCollection",
    features
  } satisfies FeatureCollection;

  const topo = topology({ postal_codes: normalized }, quantization);
  const sortedCodes = [...postalCodes].sort();
  const topoJson = `${JSON.stringify(topo)}\n`;

  fs.writeFileSync(outTopoJson, topoJson);
  fs.writeFileSync(outPostalCodes, `${JSON.stringify(sortedCodes, null, 2)}\n`);
  fs.writeFileSync(mirrorPostalCodes, `${JSON.stringify(sortedCodes, null, 2)}\n`);

  const prefixCollections = buildPrefixCollection(topo, sortedCodes);
  for (const [index, prefixCollection] of prefixCollections.entries()) {
    const level = prefixLevels[index];
    const prefixTopo = topology({ postal_code_prefixes: prefixCollection }, quantization);
    const prefixTopoJson = `${JSON.stringify(prefixTopo)}\n`;
    fs.writeFileSync(levelTopoJsonPath(level), prefixTopoJson);
  }

  console.log(`Generated ${features.length} PLZ polygons and ${sortedCodes.length} postal codes with ${quantization} quantization.`);
  console.log(`Generated PLZ TopoJSON LOD levels ${prefixLevels.join(", ")} in public/data.`);
}

normalize(readSource(sourcePath));
