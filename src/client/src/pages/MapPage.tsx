import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_MAP_PALETTE } from "../../../shared/mapPalettes";
import type { QuestionAggregates, Survey } from "../../../shared/types";
import { GermanyPlzMap } from "../components/GermanyPlzMap";
import { MapLegend } from "../components/MapLegend";
import { parsePaletteText, type PaletteColor } from "../lib/colorScale";
import {
  getActiveSurvey,
  getAggregates,
  type AggregateResponse,
  type GroupedAggregate,
  type PagedSurvey,
  type QuestionAggregate,
  type SurveyQuestion
} from "../lib/api";
import { toFeatureCollection } from "../lib/plzJoin";

const RESULTS_REFRESH_INTERVAL_MS = 5000;

type StreamPayload = {
  type: "aggregate-update" | "aggregate-snapshot";
  survey_id: string;
};

function surveyQuestions(survey: PagedSurvey): SurveyQuestion[] {
  if (survey.pages?.length) {
    return survey.pages.flatMap((page) => page.questions);
  }
  return [{
    id: "question-default",
    text: survey.question_text,
    min_rating: survey.min_rating,
    max_rating: survey.max_rating,
    rating_labels: survey.rating_labels ?? {}
  }];
}

function groupAggregates(
  payload: AggregateResponse,
  questions: SurveyQuestion[]
): GroupedAggregate[] {
  if (!Array.isArray(payload)) {
    return payload.questions;
  }

  if (payload.every(isQuestionAggregateGroup)) {
    return payload.map((group) => {
      const question = questions.find((item) => item.id === group.question_id);
      return {
        question_id: group.question_id,
        question_text: question?.text ?? group.question_id,
        min_rating: question?.min_rating,
        max_rating: question?.max_rating,
        aggregates: group.aggregates
      };
    });
  }

  const fallbackQuestion = questions[0];
  return questions.map((question, index) => ({
    question_id: question.id,
    question_text: question.text,
    min_rating: question.min_rating,
    max_rating: question.max_rating,
    aggregates: payload.filter((row) => {
      if (row.question_id) return row.question_id === question.id;
      return index === 0 || question.id === fallbackQuestion?.id;
    })
  }));
}

function isQuestionAggregateGroup(value: QuestionAggregate | QuestionAggregates): value is QuestionAggregates {
  return Array.isArray((value as QuestionAggregates).aggregates);
}

export function MapPage() {
  const [survey, setSurvey] = useState<PagedSurvey | null>(null);
  const [plzData, setPlzData] = useState<GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>> | null>(null);
  const [groups, setGroups] = useState<GroupedAggregate[]>([]);
  const [palette, setPalette] = useState<PaletteColor[] | undefined>();
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [status, setStatus] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshRequestRef = useRef(0);

  const questions = useMemo(() => survey ? surveyQuestions(survey) : [], [survey]);
  const selectedQuestion = questions.find((question) => question.id === selectedQuestionId) ?? questions[0];
  const selectedGroup = groups.find((group) => group.question_id === selectedQuestion?.id) ?? groups[0];
  const aggregates = selectedGroup?.aggregates ?? [];

  const loadResults = useCallback(async (
    surveyId: string,
    surveyQuestions: SurveyQuestion[],
    announce = false
  ) => {
    const requestId = ++refreshRequestRef.current;
    setIsRefreshing(true);
    try {
      const rows = await getAggregates(surveyId);
      if (requestId !== refreshRequestRef.current) return;
      setGroups(groupAggregates(rows, surveyQuestions));
      setStatus(announce ? "Results updated." : "");
    } catch (error) {
      if (requestId !== refreshRequestRef.current) return;
      setStatus(error instanceof Error ? error.message : "Could not refresh results");
    } finally {
      if (requestId === refreshRequestRef.current) {
        setIsRefreshing(false);
      }
    }
  }, []);

  const refreshResults = useCallback((announce = true) => {
    if (!survey || questions.length === 0) return Promise.resolve();
    return loadResults(survey.id, questions, announce);
  }, [loadResults, questions, survey]);

  useEffect(() => {
    async function load() {
      const activeSurvey = await getActiveSurvey() as PagedSurvey;
      const activeQuestions = surveyQuestions(activeSurvey);
      setSurvey(activeSurvey);
      setSelectedQuestionId(activeQuestions[0]?.id ?? "");
      const initialPlzPath = activeSurvey.use_aggregated_shapes
        ? "/data/germany-plz-1.topojson"
        : "/data/germany-plz.topojson";
      const [plz] = await Promise.all([
        fetch(initialPlzPath).then((response) => response.json()).then(toFeatureCollection),
        loadResults(activeSurvey.id, activeQuestions)
      ]);
      setPlzData(plz);
    }
    load().catch((error) => setStatus(error.message));
  }, [loadResults]);

  useEffect(() => {
    if (!survey) return;
    const paletteId = survey.map_palette ?? DEFAULT_MAP_PALETTE;
    setPalette(undefined);
    fetch(`/data/gradients/${encodeURIComponent(paletteId)}.txt`)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load ${paletteId} palette`);
        return response.text();
      })
      .then((text) => setPalette(parsePaletteText(text)))
      .catch((error) => console.error(error));
  }, [survey]);

  useEffect(() => {
    if (!survey) return;
    const source = new EventSource(`/api/results/${encodeURIComponent(survey.id)}/stream`);
    function handle(event: MessageEvent<string>) {
      const payload = JSON.parse(event.data) as StreamPayload;
      if (payload.type === "aggregate-snapshot" || payload.type === "aggregate-update") {
        void refreshResults(false);
      }
    }
    source.addEventListener("aggregate-snapshot", handle);
    source.addEventListener("aggregate-update", handle);
    source.onerror = () => setStatus("Live stream disconnected. Retrying...");
    return () => source.close();
  }, [refreshResults, survey]);

  useEffect(() => {
    if (!survey) return;

    function refreshIfVisible() {
      if (document.hidden) return;
      void refreshResults(false);
    }

    const intervalId = window.setInterval(refreshIfVisible, RESULTS_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refreshResults, survey]);

  const total = useMemo(() => aggregates.reduce((sum, item) => sum + item.count, 0), [aggregates]);

  if (!survey || !plzData || !selectedQuestion) {
    return <section className="panel">Loading map...</section>;
  }

  const mapSurvey: Survey = {
    ...survey,
    question_text: selectedQuestion.text,
    min_rating: selectedQuestion.min_rating,
    max_rating: selectedQuestion.max_rating,
    rating_labels: selectedQuestion.rating_labels,
    map_palette: survey.map_palette ?? DEFAULT_MAP_PALETTE
  };

  return (
    <section className="map-page">
      <div className="map-header">
        <div>
          <p className="eyebrow">Live results</p>
          <h1>{selectedQuestion.text}</h1>
        </div>
        <div className="map-controls">
          <label className="field">
            <span>Question</span>
            <select value={selectedQuestion.id} onChange={(event) => setSelectedQuestionId(event.target.value)}>
              {questions.map((question) => (
                <option value={question.id} key={question.id}>{question.text}</option>
              ))}
            </select>
          </label>
          <div className="stats">
            <span>{total} responses</span>
            <span>{aggregates.length} PLZ areas</span>
          </div>
          <button type="button" onClick={() => void refreshResults(true)} disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh results"}
          </button>
        </div>
      </div>
      <div className="map-content">
        <GermanyPlzMap plzData={plzData} aggregates={aggregates} survey={mapSurvey} palette={palette} />
        <MapLegend palette={palette} />
      </div>
      {status ? <p role="status" className="notice">{status}</p> : null}
    </section>
  );
}
