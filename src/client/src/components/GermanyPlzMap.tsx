import maplibregl, { type LngLatBoundsLike, type MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Aggregate, Survey } from "../../../shared/types";
import { colorForAverage, type PaletteColor } from "../lib/colorScale";
import { joinAggregates, plzLevelForZoom, toFeatureCollection, type PlzLevel } from "../lib/plzJoin";

type Props = {
  plzData: GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;
  aggregates: Aggregate[];
  survey: Survey;
  palette?: PaletteColor[];
};

type HoverInfo = {
  x: number;
  y: number;
  postalCode: string;
  count: number;
  average: number | null;
  hidden: boolean;
};

const sourcePathByLevel: Record<PlzLevel, string> = {
  1: "/data/germany-plz-1.topojson.geojson",
  2: "/data/germany-plz-2.topojson.geojson",
  3: "/data/germany-plz-3.topojson",
  4: "/data/germany-plz-4.topojson",
  5: "/data/germany-plz.topojson"
};

function visitCoordinates(value: unknown, extend: (position: GeoJSON.Position) => void) {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    extend(value as GeoJSON.Position);
    return;
  }
  value.forEach((item) => visitCoordinates(item, extend));
}

function calculateBounds(
  data: GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>
): maplibregl.LngLatBounds | undefined {
  const bounds = new maplibregl.LngLatBounds();
  let hasCoordinates = false;

  function extendGeometry(geometry: GeoJSON.Geometry | null) {
    if (!geometry) return;
    if (geometry.type === "GeometryCollection") {
      geometry.geometries.forEach(extendGeometry);
      return;
    }

    visitCoordinates(geometry.coordinates, ([lng, lat]) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      bounds.extend([lng, lat]);
      hasCoordinates = true;
    });
  }

  data.features.forEach((feature) => extendGeometry(feature.geometry));
  return hasCoordinates ? bounds : undefined;
}

function expandBounds(bounds: maplibregl.LngLatBounds, paddingRatio = 0.18): LngLatBoundsLike {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const lngPadding = Math.max((east - west) * paddingRatio, 0.25);
  const latPadding = Math.max((north - south) * paddingRatio, 0.25);

  return [
    [west - lngPadding, south - latPadding],
    [east + lngPadding, north + latPadding]
  ];
}

export function GermanyPlzMap({ plzData, aggregates, survey, palette }: Props) {
  const useAggregatedShapes = survey.use_aggregated_shapes ?? false;
  const initialLevel: PlzLevel = useAggregatedShapes ? 1 : 5;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const shapeCacheRef = useRef(new Map<PlzLevel, GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>>([[initialLevel, plzData]]));
  const loadRequestRef = useRef(0);
  const [activeLevel, setActiveLevel] = useState<PlzLevel>(initialLevel);
  const [activePlzData, setActivePlzData] = useState(plzData);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const joined = useMemo(() => joinAggregates(activePlzData, aggregates, activeLevel), [activePlzData, activeLevel, aggregates]);
  const mapData = useMemo(() => ({
    ...joined,
    features: joined.features.map((item) => ({
      ...item,
      properties: {
        ...(item.properties ?? {}),
        fill: colorForAverage(
          typeof item.properties?.average === "number" ? item.properties.average : null,
          survey.min_rating,
          survey.max_rating,
          Boolean(item.properties?.hidden),
          palette
        )
      }
    }))
  }), [joined, palette, survey.min_rating, survey.max_rating]);
  const initialMapDataRef = useRef(mapData);
  const boundsRef = useRef(calculateBounds(plzData));

  async function loadPlzLevel(level: PlzLevel): Promise<void> {
    const requestId = ++loadRequestRef.current;
    const cached = shapeCacheRef.current.get(level);
    if (cached) {
      if (requestId === loadRequestRef.current) {
        setActiveLevel(level);
        setActivePlzData(cached);
      }
      return;
    }

    const response = await fetch(sourcePathByLevel[level]);
    if (!response.ok) {
      throw new Error(`Could not load PLZ${level} shapes`);
    }

    const collection = toFeatureCollection(await response.json());
    shapeCacheRef.current.set(level, collection);
    if (requestId === loadRequestRef.current) {
      setActiveLevel(level);
      setActivePlzData(collection);
    }
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const bounds = boundsRef.current;
    const maxBounds = bounds ? expandBounds(bounds) : undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#f8fafc" }
          }
        ]
      },
      bounds,
      center: bounds ? undefined : [10.45, 51.16],
      zoom: bounds ? undefined : 5,
      fitBoundsOptions: { padding: 36, duration: 0 },
      maxBounds,
      bearing: 0,
      pitch: 0,
      minPitch: 0,
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false
    });

    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({
      customAttribution: "PLZ polygons derived from OpenStreetMap contributors"
    }));

    map.on("load", () => {
      if (bounds) {
        map.zoomTo(map.getZoom() - 20, { duration: 0 });
      }

      map.addSource("plz", { type: "geojson", data: initialMapDataRef.current });
      map.addLayer({
        id: "plz-fill",
        type: "fill",
        source: "plz",
        paint: {
          "fill-color": ["get", "fill"],
          "fill-opacity": 0.82
        }
      });
      map.addLayer({
        id: "plz-line",
        type: "line",
        source: "plz",
        paint: {
          "line-color": "#ffffff",
          "line-width": 0.8
        }
      });
      map.on("mousemove", "plz-fill", handleMove);
      map.on("mouseleave", "plz-fill", () => setHover(null));
    });
    map.on("zoomend", () => {
      if (!useAggregatedShapes) return;
      const nextLevel = plzLevelForZoom(map.getZoom());
      void loadPlzLevel(nextLevel).catch((error) => console.error(error));
    });

    function handleMove(event: MapMouseEvent) {
      const item = event.features?.[0];
      if (!item) return;
      const props = item.properties as Record<string, unknown>;
      setHover({
        x: event.point.x,
        y: event.point.y,
        postalCode: String(props.postal_code ?? ""),
        count: Number(props.count ?? 0),
        average: props.average === null || props.average === undefined ? null : Number(props.average),
        hidden: props.hidden === true || props.hidden === "true"
      });
    }

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const source = mapRef.current?.getSource("plz") as maplibregl.GeoJSONSource | undefined;
    source?.setData(mapData);
    setHover(null);
  }, [mapData]);

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" />
      {hover ? (
        <div className="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <strong>{hover.postalCode}</strong>
          <span>{hover.count} responses</span>
          <span>{hover.hidden ? "Hidden: low sample" : hover.average === null ? "No average" : `Average ${hover.average.toFixed(2)}`}</span>
        </div>
      ) : null}
    </div>
  );
}
