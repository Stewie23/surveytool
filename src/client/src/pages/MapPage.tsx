import { useEffect, useMemo, useState } from "react";
import type { Aggregate, Survey } from "../../../shared/types";
import { GermanyPlzMap } from "../components/GermanyPlzMap";
import { MapLegend } from "../components/MapLegend";
import { getActiveSurvey, getAggregates } from "../lib/api";
import { toFeatureCollection } from "../lib/plzJoin";

type StreamPayload = {
  type: "aggregate-update" | "aggregate-snapshot";
  survey_id: string;
  aggregates?: Aggregate[];
} & Partial<Aggregate>;

export function MapPage() {
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [plzData, setPlzData] = useState<GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>> | null>(null);
  const [aggregates, setAggregates] = useState<Aggregate[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    async function load() {
      const activeSurvey = await getActiveSurvey();
      setSurvey(activeSurvey);
      const [plz, rows] = await Promise.all([
        fetch("/data/germany-plz.topojson").then((response) => response.json()).then(toFeatureCollection),
        getAggregates(activeSurvey.id)
      ]);
      setPlzData(plz);
      setAggregates(rows);
    }
    load().catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    if (!survey) return;
    const source = new EventSource(`/api/results/${encodeURIComponent(survey.id)}/stream`);
    function handle(event: MessageEvent<string>) {
      const payload = JSON.parse(event.data) as StreamPayload;
      if (payload.type === "aggregate-snapshot" && payload.aggregates) {
        setAggregates(payload.aggregates);
      }
      if (payload.type === "aggregate-update" && payload.postal_code) {
        setAggregates((current) => {
          const next = current.filter((item) => item.postal_code !== payload.postal_code);
          next.push({
            postal_code: payload.postal_code!,
            count: payload.count ?? 0,
            average: payload.average ?? null,
            sum: payload.sum ?? 0,
            hidden: payload.hidden
          });
          return next;
        });
      }
    }
    source.addEventListener("aggregate-snapshot", handle);
    source.addEventListener("aggregate-update", handle);
    source.onerror = () => setStatus("Live stream disconnected. Retrying...");
    return () => source.close();
  }, [survey]);

  const total = useMemo(() => aggregates.reduce((sum, item) => sum + item.count, 0), [aggregates]);

  if (!survey || !plzData) {
    return <section className="panel">Loading map...</section>;
  }

  return (
    <section className="map-page">
      <div className="map-header">
        <div>
          <p className="eyebrow">Live results</p>
          <h1>{survey.question_text}</h1>
        </div>
        <div className="stats">
          <span>{total} responses</span>
          <span>{aggregates.length} PLZ areas</span>
        </div>
      </div>
      <div className="map-content">
        <GermanyPlzMap plzData={plzData} aggregates={aggregates} survey={survey} />
        <MapLegend />
      </div>
      {status ? <p role="status" className="notice">{status}</p> : null}
    </section>
  );
}
