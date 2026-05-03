import { useEffect, useMemo, useState } from "react";
import type { QuestionAggregates, Survey } from "../../../shared/types";
import { GermanyPlzMap } from "../components/GermanyPlzMap";
import { MapLegend } from "../components/MapLegend";
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

type StreamPayload = {
  type: "aggregate-update" | "aggregate-snapshot";
  survey_id: string;
  question_id?: string;
  aggregates?: AggregateResponse;
} & Partial<QuestionAggregate>;

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
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [status, setStatus] = useState("");

  const questions = useMemo(() => survey ? surveyQuestions(survey) : [], [survey]);
  const selectedQuestion = questions.find((question) => question.id === selectedQuestionId) ?? questions[0];
  const selectedGroup = groups.find((group) => group.question_id === selectedQuestion?.id) ?? groups[0];
  const aggregates = selectedGroup?.aggregates ?? [];

  useEffect(() => {
    async function load() {
      const activeSurvey = await getActiveSurvey() as PagedSurvey;
      const activeQuestions = surveyQuestions(activeSurvey);
      setSurvey(activeSurvey);
      setSelectedQuestionId(activeQuestions[0]?.id ?? "");
      const [plz, rows] = await Promise.all([
        fetch("/data/germany-plz-1.topojson").then((response) => response.json()).then(toFeatureCollection),
        getAggregates(activeSurvey.id)
      ]);
      setPlzData(plz);
      setGroups(groupAggregates(rows, activeQuestions));
    }
    load().catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    if (!survey) return;
    const source = new EventSource(`/api/results/${encodeURIComponent(survey.id)}/stream`);
    function handle(event: MessageEvent<string>) {
      const payload = JSON.parse(event.data) as StreamPayload;
      if (payload.type === "aggregate-snapshot" && payload.aggregates) {
        setGroups(groupAggregates(payload.aggregates, questions));
      }
      if (payload.type === "aggregate-update") {
        const updates = Array.isArray(payload.aggregates) && !payload.aggregates.every(isQuestionAggregateGroup)
          ? payload.aggregates
          : payload.postal_code
            ? [{
              question_id: payload.question_id ?? questions[0]?.id ?? "",
              postal_code: payload.postal_code,
              count: payload.count ?? 0,
              average: payload.average ?? null,
              sum: payload.sum ?? 0,
              hidden: payload.hidden
            }]
            : [];

        setGroups((current) => current.map((group) => {
          const groupUpdates = updates.filter((item) => item.question_id === group.question_id);
          if (groupUpdates.length === 0) return group;
          const next = group.aggregates.filter((item) => !groupUpdates.some((update) => update.postal_code === item.postal_code));
          next.push(...groupUpdates);
          return { ...group, aggregates: next };
        }));
      }
    }
    source.addEventListener("aggregate-snapshot", handle);
    source.addEventListener("aggregate-update", handle);
    source.onerror = () => setStatus("Live stream disconnected. Retrying...");
    return () => source.close();
  }, [questions, survey]);

  const total = useMemo(() => aggregates.reduce((sum, item) => sum + item.count, 0), [aggregates]);

  if (!survey || !plzData || !selectedQuestion) {
    return <section className="panel">Loading map...</section>;
  }

  const mapSurvey: Survey = {
    ...survey,
    question_text: selectedQuestion.text,
    min_rating: selectedQuestion.min_rating,
    max_rating: selectedQuestion.max_rating,
    rating_labels: selectedQuestion.rating_labels
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
        </div>
      </div>
      <div className="map-content">
        <GermanyPlzMap plzData={plzData} aggregates={aggregates} survey={mapSurvey} />
        <MapLegend />
      </div>
      {status ? <p role="status" className="notice">{status}</p> : null}
    </section>
  );
}
