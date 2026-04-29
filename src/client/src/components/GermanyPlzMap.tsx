import maplibregl, { type MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Aggregate, Survey } from "../../../shared/types";
import { colorForAverage } from "../lib/colorScale";
import { joinAggregates } from "../lib/plzJoin";

type Props = {
  plzData: GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;
  aggregates: Aggregate[];
  survey: Survey;
};

type HoverInfo = {
  x: number;
  y: number;
  postalCode: string;
  count: number;
  average: number | null;
  hidden: boolean;
};

export function GermanyPlzMap({ plzData, aggregates, survey }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const joined = useMemo(() => joinAggregates(plzData, aggregates), [plzData, aggregates]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

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
      center: [10.45, 51.16],
      zoom: 5,
      attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({
      customAttribution: "PLZ polygons derived from OpenStreetMap contributors"
    }));

    map.on("load", () => {
      map.addSource("plz", { type: "geojson", data: joined });
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
    const data = {
      ...joined,
      features: joined.features.map((item) => ({
        ...item,
        properties: {
          ...(item.properties ?? {}),
          fill: colorForAverage(
            typeof item.properties?.average === "number" ? item.properties.average : null,
            survey.min_rating,
            survey.max_rating,
            Boolean(item.properties?.hidden)
          )
        }
      }))
    };
    const source = mapRef.current?.getSource("plz") as maplibregl.GeoJSONSource | undefined;
    source?.setData(data);
  }, [joined, survey.min_rating, survey.max_rating]);

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
